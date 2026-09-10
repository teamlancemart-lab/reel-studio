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
};

/** Rules whose inputs do not exist until a later stage. Never silently PASS. */
const DEFERRED = {
  US_ALTERED_NO_DISCLOSURE: "needs B4 hook.generation_path (D3)",
  HOOK_SOURCE_HAS_PEOPLE: "needs B4 hook.source_photo_id (D3)",
  HOOK_CONCEPT_ASSET_FIT: "needs B4 hook.scores.asset_fit (D3)",
  HOOK_BLOCK_BUILD_TOWER: "needs B4 hook.concept_id (D3)",
  HOOK_FLYOVER_DEFAULT: "needs B4 hook.concept_id (D3)",
  NO_TRUTH_LOCK: "needs B4 hook.truth_lock (D3)",
  Q_FAIL_TWICE: "needs Q1/Q2 (D3)",
  BUDGET: "needs B4 hook.est_cost (D3)",
  SAFE_ZONE: "needs the Pillow overlay renderer to measure bounding boxes (D3)",
};

/**
 * @param stage "pre_generation" | "pre_export"
 */
export function evaluateRules(ctx, stage) {
  const results = [];
  const deferred = [];

  for (const rule of rules.preflight_rules) {
    if (rule.stage !== stage) continue;

    if (DEFERRED[rule.id]) {
      deferred.push({ rule_id: rule.id, level: rule.level, reason: DEFERRED[rule.id] });
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
  { stage = "pre_export", truth, formats, shots, assets, copySets, pacings, recipes, tracks },
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
      };

      const { results, deferred } = evaluateRules(ctx, stage);
      const blocks = results.filter((r) => r.level === "BLOCK");

      return {
        stage,
        pass: blocks.length === 0,
        results,
        deferred,
        phrase_scan: phraseScan,
        est_total_usd: 0, // no paid generation in D2; B4 fills this in D3
      };
    },
    { schema: "PreflightResult", model: config.textModel, parents: ["B1", "B5", "B6", "B7"] },
  );
}
