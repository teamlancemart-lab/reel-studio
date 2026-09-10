/**
 * B8 pre-flight gate.
 *
 * A pure function over rules.json preflight_rules, plus ONE text call that scans the
 * B6 strings for coded language the exact-match pass cannot catch.
 *
 * Two design choices worth stating:
 *
 * 1. rules.json owns the id, the stage, the level and the message. This file owns only
 *    the predicate. Change a rule's severity in rules.json and this file does not move.
 *
 * 2. A rule with no predicate implemented yet is NOT reported as PASS. It goes into
 *    `deferred` with the reason. The hook rules need B4, which is D3. Silently passing
 *    a compliance rule because its inputs do not exist yet is exactly the failure mode
 *    this gate exists to prevent.
 */
import { rules, config } from "../config.js";
import { callText } from "../lib/vertex.js";
import { runNode } from "./runner.js";
import * as P from "./prompts.js";
import { hookDisclosure } from "../hook/compliance.js";

const SCHOOL_ADJECTIVES =
  /\b(top[- ]?rated|best|excellent|great|good|award[- ]?winning|blue[- ]?ribbon|highly[- ]?rated|desirable|sought[- ]?after)\b/i;
const SCHOOL_NOUN = /\bschool|school district|isd\b/i;

/** Every string a viewer could read, with where it came from. */
function copyStrings(copySets) {
  const out = [];
  for (const copy of copySets) {
    const push = (where, text) => {
      if (text && String(text).trim()) out.push({ reel_n: copy.reel_n, where, text: String(text) });
    };
    for (const [name, card] of [
      ["hook_card", copy.hook_card],
      ["proof_card", copy.proof_card],
      ["floor_plan_card", copy.floor_plan_card],
      ["cta_card", copy.cta_card],
    ]) {
      if (!card) continue;
      push(`${name}.title`, card.title);
      push(`${name}.subtitle`, card.subtitle);
    }
    (copy.cta_card?.compliance_lines || []).forEach((l, i) =>
      push(`cta_card.compliance_lines[${i}]`, l),
    );
    push("cta_card.agent_line", copy.cta_card?.agent_line);
    (copy.fact_captions || []).forEach((c, i) => {
      push(`fact_captions[${i}].title`, c.title);
      push(`fact_captions[${i}].subtitle`, c.subtitle);
    });
    push("post_caption", copy.post_caption);
    push("disclosure_overlay", copy.disclosure_overlay?.text);
  }
  return out;
}

/**
 * Predicates. Each returns null (rule does not fire) or an evidence string.
 * `ctx` carries everything the rules can see.
 */
const PREDICATES = {
  IN_NO_RERA_NEW: (c) => {
    if (c.market !== "in") return null;
    const status = c.truth.facts.status;
    if (!["new_launch", "under_construction", "coming_soon"].includes(status)) return null;
    if (c.truth.compliance_context.rera_project) return null;
    return `status=${status} and compliance_context.rera_project is empty`;
  },

  IN_NO_AGENT_RERA: (c) => {
    if (c.market !== "in") return null;
    if (!c.truth.compliance_context.is_brokered) return null;
    if (c.truth.compliance_context.rera_agent) return null;
    return "is_brokered with no rera_agent";
  },

  IN_AREA_BASIS: (c) => {
    if (c.market !== "in") return null;
    const basis = c.truth.facts.area_basis;
    const areaStrings = c.strings.filter((s) =>
      /\b(sq\.?\s?ft|sqft|sq\.?\s?m|sqm|sq\.?\s?yd|sqyd)\b/i.test(s.text),
    );
    const unlabelled = areaStrings.filter((s) => !/carpet area/i.test(s.text));
    if (basis !== "carpet") {
      return `facts.area_basis is "${basis}", not carpet`;
    }
    for (const f of c.phraseScan) {
      if (f.category === "area_basis") {
        return `phrase_scan reel ${f.reel_n ?? "?"}: "${f.text}" — ${f.reason}`;
      }
    }
    if (unlabelled.length) {
      return `area figure without the "Carpet area" label: ${unlabelled
        .map((s) => `${s.where} "${s.text}"`)
        .slice(0, 3)
        .join("; ")}`;
    }
    return null;
  },

  IN_LUXURY_NO_CRITERIA: (c) => {
    if (c.market !== "in") return null;
    const hit = c.strings.find((s) => /\bluxury\b/i.test(s.text));
    if (!hit) return null;
    if (c.truth.facts.luxury_criteria) return null;
    return `"${hit.text}" (${hit.where}) and facts.luxury_criteria is empty`;
  },

  IN_RERA_BAND_MISSING: (c) => {
    if (c.market !== "in") return null;
    const project = c.truth.compliance_context.rera_project;
    if (!project) return null;
    const misses = [];
    for (const copy of c.copySets) {
      const lines = (copy.cta_card?.compliance_lines || []).join(" ");
      if (!lines.includes(project)) misses.push(`reel ${copy.reel_n}: no RERA number`);
      else if (!/https?:\/\//.test(lines)) misses.push(`reel ${copy.reel_n}: no portal URL`);
    }
    return misses.length ? misses.join("; ") : null;
  },

  US_FH_PHRASE: (c) => {
    if (c.market !== "us") return null;
    const banned = rules.banned_phrases.us;
    const hits = [];
    for (const s of c.strings) {
      const lower = s.text.toLowerCase();
      for (const phrase of banned) {
        if (lower.includes(phrase.toLowerCase())) {
          hits.push(`reel ${s.reel_n} ${s.where}: "${phrase}" in "${s.text}"`);
        }
      }
    }
    /* Only the categories this rule is actually about. Folding every scan finding in
       here made a US job BLOCK on an Indian carpet-area rule. */
    for (const f of c.phraseScan) {
      if (!["protected_class", "occupant_targeting"].includes(f.category)) continue;
      hits.push(`phrase_scan reel ${f.reel_n ?? "?"} [${f.category}]: "${f.text}" — ${f.reason}`);
    }
    return hits.length ? hits.slice(0, 6).join(" | ") : null;
  },

  US_SCHOOL_SUPERLATIVE: (c) => {
    if (c.market !== "us") return null;
    const hits = c.strings
      .filter((s) => SCHOOL_NOUN.test(s.text) && SCHOOL_ADJECTIVES.test(s.text))
      .map((s) => `reel ${s.reel_n} ${s.where}: "${s.text}"`);
    for (const f of c.phraseScan) {
      if (f.category === "school_rating") {
        hits.push(`phrase_scan reel ${f.reel_n ?? "?"}: "${f.text}" — ${f.reason}`);
      }
    }
    return hits.length ? hits.join("; ") : null;
  },

  US_ORIGINALS_URL: (c) => {
    if (c.market !== "us") return null;
    return c.truth.compliance_context.originals_url ? null : "originals_url is empty";
  },

  US_EHO_LINE: (c) => {
    if (c.market !== "us") return null;
    const misses = c.copySets
      .filter(
        (copy) =>
          !(copy.cta_card?.compliance_lines || []).some((l) =>
            /equal housing opportunity/i.test(l),
          ),
      )
      .map((copy) => `reel ${copy.reel_n}`);
    return misses.length ? `missing on ${misses.join(", ")}` : null;
  },

  US_BROKERAGE: (c) => {
    if (c.market !== "us") return null;
    return c.truth.facts.brokerage ? null : "facts.brokerage is empty";
  },

  INTERIOR_ALTERED: (c) => {
    const bad = c.recipes.flatMap((r) =>
      r.segments
        .filter((s) => s.kind === "interior" && s.source.type !== "photo")
        .map((s) => `${r.reelId} ${s.kind} source.type=${s.source.type}`),
    );
    return bad.length ? bad.join("; ") : null;
  },

  STAGING_UNLABELLED: (c) => {
    if (!c.truth.flags?.staging_suspected_any) return null;
    const labelled = c.strings.some((s) => /virtually staged/i.test(s.text));
    return labelled ? null : "staging_suspected_any with no 'Virtually staged' label";
  },

  CLAIM_UNPROVABLE: (c) => {
    const problems = [];
    for (const copy of c.copySets) {
      const validIds = new Set([
        ...c.truth.observed.map((o) => o.id),
        ...c.truth.specials.map((s) => s.id),
        ...c.truth.provable_numbers.map((p) => p.id),
        ...Object.keys(c.truth.facts),
        ...Object.keys(c.truth.compliance_context || {}),
      ]);
      for (const t of copy.claims_trace || []) {
        if (!t.source?.id || !validIds.has(t.source.id)) {
          problems.push(`reel ${copy.reel_n}: "${t.text}" -> unknown id "${t.source?.id}"`);
        }
      }
      const format = c.formats.reels.find((r) => r.reel_n === copy.reel_n);
      if (format?.format_id === "price_improved" && !c.truth.facts.prior_price) {
        problems.push(`reel ${copy.reel_n}: price_improved with no prior_price`);
      }
      if (format?.format_id === "sold_social_proof" && !c.truth.facts.sale_date) {
        problems.push(`reel ${copy.reel_n}: sold_social_proof with no sale_date`);
      }
    }
    return problems.length ? problems.slice(0, 6).join("; ") : null;
  },

  PEOPLE_IN_WALKTHROUGH: (c) => {
    const used = new Set(c.shots.map((s) => s.photo_id).filter(Boolean));
    const hits = c.assets.filter((a) => used.has(a.photo_id) && a.flags?.people_present);
    return hits.length ? hits.map((a) => a.photo_id).join(", ") : null;
  },

  ASPECT_MASTER: (c) => {
    const bad = c.recipes.filter((r) => r.aspect !== "9x16");
    return bad.length ? bad.map((r) => `${r.reelId}=${r.aspect}`).join(", ") : null;
  },

  LENGTH: (c) => {
    const bad = c.recipes.filter((r) => r.durationS < 12 || r.durationS > 40);
    return bad.length
      ? bad.map((r) => `${r.reelId}=${r.durationS.toFixed(1)}s`).join(", ")
      : null;
  },

  MUSIC_UNLICENSED: (c) => {
    const licensed = new Set(
      c.tracks.filter((t) => t.licensed).map((t) => t.track_id),
    );
    const bad = c.pacings
      .filter((p) => !licensed.has(p.track_id))
      .map((p) => `reel ${p.reel_n}: ${p.track_id}`);
    return bad.length ? bad.join("; ") : null;
  },

  VARIANT_COLLISION: (c) => {
    // The rule names concept_id, which is B4 (D3). Until then the observable collision
    // is format_id + tier; the evidence says which half was checked.
    const seen = new Map();
    const hits = [];
    for (const r of c.formats.reels) {
      const k = `${r.format_id}|${r.tier}`;
      if (seen.has(k)) hits.push(`reels ${seen.get(k)} and ${r.reel_n} share ${k}`);
      seen.set(k, r.reel_n);
    }
    return hits.length ? `${hits.join("; ")} (format_id+tier; concept_id needs B4)` : null;
  },

  /* ---- hook rules. ctx.hooks is the job's B4 plans; ctx.reelN narrows to one reel. */

  US_ALTERED_NO_DISCLOSURE: (c) => {
    if (c.market !== "us") return null;
    const problems = [];
    for (const h of scopedHooks(c)) {
      if (h.generation_path === "free_2p5d") continue;
      const d = hookDisclosure({ market: c.market, truth: c.truth, truthLockS: 2.2 });
      if (!h.disclosure_label) problems.push(`reel ${h.reel_n}: plan has no disclosure_label`);
      problems.push(...d.problems.map((m) => `reel ${h.reel_n}: ${m}`));
    }
    return problems.length ? problems.join("; ") : null;
  },

  HOOK_SOURCE_HAS_PEOPLE: (c) => {
    const hits = scopedHooks(c).filter((h) => {
      const a = c.allAssets.find((x) => x.photo_id === h.source_photo_id);
      return a?.flags?.people_present;
    });
    return hits.length ? hits.map((h) => `reel ${h.reel_n}: ${h.source_photo_id}`).join(", ") : null;
  },

  HOOK_CONCEPT_ASSET_FIT: (c) => {
    const hits = scopedHooks(c).filter((h) => h.scores?.asset_fit === 0);
    return hits.length ? hits.map((h) => `reel ${h.reel_n}: ${h.concept_id} asset_fit 0`).join(", ") : null;
  },

  HOOK_BLOCK_BUILD_TOWER: (c) => {
    const hits = scopedHooks(c).filter(
      (h) => h.concept_id === "block_build" && ["apartment", "penthouse"].includes(c.truth.facts.property_type),
    );
    return hits.length ? hits.map((h) => `reel ${h.reel_n}: block_build on ${c.truth.facts.property_type}`).join(", ") : null;
  },

  HOOK_FLYOVER_DEFAULT: (c) => {
    const hits = scopedHooks(c).filter((h) => h.concept_id === "unveiling_flyover");
    return hits.length ? hits.map((h) => `reel ${h.reel_n}`).join(", ") : null;
  },

  NO_TRUTH_LOCK: (c) => {
    const hits = scopedHooks(c).filter(
      (h) => h.generation_path !== "free_2p5d" && !((h.truth_lock?.frames ?? 0) >= 8),
    );
    return hits.length ? hits.map((h) => `reel ${h.reel_n}: frames ${h.truth_lock?.frames ?? "missing"}`).join(", ") : null;
  },

  BUDGET: (c) => {
    const total = (c.hooks || []).reduce((s, h) => s + (h.est_cost?.total_usd || 0), 0);
    return total > 3.0 ? `sum of hook est_cost.total_usd = $${total.toFixed(2)}` : null;
  },

  /* ---- export-time rules: need the built hook and the rendered overlays. */

  Q_FAIL_TWICE: (c) => {
    const rec = c.hookRecord;
    if (!rec) return "no hook record for this reel";
    const q1Fails = (rec.attempts || []).filter((a) => !a.q1?.pass).length;
    const failedOut = q1Fails >= 2 || rec.q2?.pass === false;
    if (failedOut && !rec.fell_back) return `QA failed (${q1Fails} Q1 rejections, Q2 ${rec.q2?.pass}) and no fallback ran`;
    return null;
  },

  SAFE_ZONE: (c) => {
    const bad = (c.overlayBoxes || []).filter((b) => b.outside_safe_zone);
    return bad.length
      ? bad.map((b) => `${b.id} "${b.text}" box ${b.box.map((n) => Math.round(n)).join(",")}`).join("; ")
      : null;
  },
};

function scopedHooks(c) {
  return (c.hooks || []).filter((h) => c.reelN == null || h.reel_n === c.reelN);
}

/**
 * Rules whose inputs do not exist at the stage they are evaluated. Never silently PASS.
 *
 * The brain's B8 runs before any hook is built or any overlay is rendered, so these two
 * are deferred THERE and evaluated for real by render/export.js, which has the inputs.
 */
const DEFERRED_IN_BRAIN = {
  Q_FAIL_TWICE: "evaluated at export by render/export.js, once the hook record exists",
  SAFE_ZONE: "evaluated at export by render/export.js from the Pillow bounding boxes",
};

/**
 * @param stage "pre_generation" | "pre_export"
 * @param only  evaluate just these rule ids (export-time rules); nothing is deferred
 */
export function evaluateRules(ctx, stage, { only = null } = {}) {
  const results = [];
  const deferred = [];

  for (const rule of rules.preflight_rules) {
    if (rule.stage !== stage) continue;

    if (only && !only.includes(rule.id)) continue;
    if (!only && DEFERRED_IN_BRAIN[rule.id]) {
      deferred.push({ rule_id: rule.id, level: rule.level, reason: DEFERRED_IN_BRAIN[rule.id] });
      continue;
    }

    const predicate = PREDICATES[rule.id];
    if (!predicate) {
      deferred.push({
        rule_id: rule.id,
        level: rule.level,
        reason: "no predicate implemented",
      });
      continue;
    }

    let evidence = null;
    try {
      evidence = predicate(ctx);
    } catch (err) {
      evidence = `predicate threw: ${err.message.slice(0, 160)}`;
    }

    if (!evidence) {
      results.push({ rule_id: rule.id, level: "PASS", reel_n: null, message: rule.message });
      continue;
    }

    /* BLOCK_PAID_WARN_ORGANIC downgrades while no paid distribution is configured. */
    const level =
      rule.level === "BLOCK_PAID_WARN_ORGANIC" ? "WARN" : rule.level;

    results.push({
      rule_id: rule.id,
      level,
      reel_n: null,
      message: rule.message,
      evidence: String(evidence).slice(0, 600),
      overridden_by: null,
      overridden_at: null,
    });
  }

  return { results, deferred };
}

/**
 * B8. One phrase-scan model call, then the deterministic pass.
 */
export async function runB8(
  jobId,
  { stage = "pre_export", truth, formats, shots, assets, copySets, pacings, recipes, tracks, hooks = [] },
) {
  const strings = copyStrings(copySets);

  return runNode(
    jobId,
    "B8",
    async ({ retryHint }) => {
      let phraseScan = [];
      const { json } = await callText({
        jobId,
        stage: "B8",
        model: config.textModel,
        prompt: P.b8PhraseScanPrompt(
          { strings: strings.map((s) => ({ reel_n: s.reel_n, text: s.text })), market: truth.market },
          retryHint,
        ),
        temperature: 0,
      });
      phraseScan = json?.phrase_scan || [];

      const ctx = {
        market: truth.market,
        truth,
        formats,
        shots,
        assets,
        copySets,
        pacings,
        recipes,
        tracks,
        strings,
        phraseScan,
        hooks,
        allAssets: assets,
      };

      const { results, deferred } = evaluateRules(ctx, stage);
      const blocks = results.filter((r) => r.level === "BLOCK");

      return {
        stage,
        pass: blocks.length === 0,
        results,
        deferred,
        phrase_scan: phraseScan,
        est_total_usd: Number(hooks.reduce((s, h) => s + (h.est_cost?.total_usd || 0), 0).toFixed(3)),
      };
    },
    { schema: "PreflightResult", model: config.textModel, parents: ["B1", "B5", "B6", "B7"] },
  );
}

/**
 * The pre_generation gate for one reel's hook. Pure, zero model calls, zero cost, so
 * the Generate button can ask it on every render.
 */
export function preGenerationCheck(job, reelN) {
  const truth = job.nodes.B1?.payload;
  if (!truth) return { pass: false, results: [{ rule_id: "NO_B1", level: "BLOCK", message: "B1 listing truth missing" }] };
  const hooks = Object.keys(job.nodes)
    .filter((k) => k.startsWith("B4:"))
    .map((k) => job.nodes[k].payload)
    .filter(Boolean);
  if (!hooks.find((h) => h.reel_n === reelN)) {
    return { pass: false, results: [{ rule_id: "NO_B4", level: "BLOCK", message: `reel ${reelN} has no B4 hook plan` }] };
  }
  const ctx = {
    market: truth.market,
    truth,
    hooks,
    reelN,
    allAssets: job.nodes.B0?.payload?.assets || [],
    strings: [],
    phraseScan: [],
    copySets: [],
  };
  const { results, deferred } = evaluateRules(ctx, "pre_generation");
  return { stage: "pre_generation", reel_n: reelN, pass: !results.some((r) => r.level === "BLOCK"), results, deferred };
}
