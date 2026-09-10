/**
 * B0 to B8. Each one is a thin wrapper: build the prompt, make the call, hand the
 * payload to the runner, which validates and retries. No node handles its own retry
 * or its own ledger row; that is deliberate, so there is one place to audit.
 */
import fs from "node:fs";
import path from "node:path";
import { config, rules, costModel } from "../config.js";
import { callText, callVision } from "../lib/vertex.js";
import { photosDir, jobDir, readJob } from "../store.js";
import { runNode } from "./runner.js";
import { validate } from "./validate.js";
import { to512Base64, chunk } from "./images.js";
import { phash } from "./phash.js";
import { dedupe } from "./dedupe.js";
import { fitShotsToTier, buildCutMap } from "./fit.js";
import * as P from "./prompts.js";
import { reverseConcealPrompts as hookPrompts } from "../hook/prompts.js";
import { HOOK_WINDOW_S } from "../hook/paid.js";
import { quarantineDefects, bindCaptions, defectMatch, copyTexts } from "./captions.js";

const FLASH = config.textModel;
const LITE = config.textLiteModel;

/* ------------------------------------------------------------------ B0 */

/** phash every photo on upload, before any model sees it. */
export async function computeHashes(jobId, job) {
  for (const photo of job.photos) {
    if (photo.excluded_reason || photo.phash) continue;
    try {
      photo.phash = await phash(path.join(photosDir(jobId), photo.storedName));
    } catch (err) {
      photo.phash = null;
      photo.phash_error = err.message.slice(0, 120);
    }
  }
  return job;
}

/**
 * B0: 5 photos per call at 512px. Each batch is its own model call but the whole node
 * is one unit: if a batch fails validation twice, the node fails with a named reason
 * rather than returning a partial pool.
 */
export async function runB0(jobId) {
  const job = readJob(jobId);
  const usable = job.photos.filter((p) => !p.excluded_reason);
  const tmpDir = path.join(jobDir(jobId), "work");
  fs.mkdirSync(tmpDir, { recursive: true });

  /**
   * One batch of 5, with its own retry. Retrying at the batch level matters: a single
   * malformed photo used to force all six batches to run again, which doubled the cost
   * of the node for one bad row.
   */
  async function classifyBatch(batch) {
    const images = [];
    for (const p of batch) {
      images.push(await to512Base64(path.join(photosDir(jobId), p.storedName), tmpDir));
    }

    let errors = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const retryHint =
        attempt === 1
          ? null
          : "Your previous reply did not match the schema. Fix exactly these and return the corrected JSON only:\n" +
            errors.map((e) => `- ${e}`).join("\n");

      const { json } = await callVision({
        jobId,
        stage: "B0",
        model: FLASH,
        prompt: P.b0Prompt(batch, retryHint),
        images: images.map((i) => ({ mimeType: i.mimeType, data: i.data })),
        temperature: 0.1,
      });

      if (!json?.photos) {
        errors = ["reply had no `photos` array"];
        continue;
      }

      const assets = [];
      errors = [];
      json.photos.forEach((entry, i) => {
        const source = batch[i];
        if (!source) return;
        const asset = {
          ...entry,
          photo_id: source.id, // identity comes from us, never from the model's echo
          filename: source.filename,
          width: source.width,
          height: source.height,
        };
        const r = validate("PhotoAsset", asset);
        if (r.ok) assets.push(asset);
        else errors.push(`${source.filename}: ${r.errors.join(", ")}`);
      });

      if (json.photos.length !== batch.length) {
        errors.push(`returned ${json.photos.length} entries for ${batch.length} images`);
      }
      if (errors.length === 0) return assets;
    }

    throw new Error(
      `batch ${batch.map((b) => b.id).join(",")} failed twice: ${errors.slice(0, 4).join(" | ")}`,
    );
  }

  return runNode(
    jobId,
    "B0",
    async () => {
      const assets = [];
      for (const batch of chunk(usable, 5)) {
        assets.push(...(await classifyBatch(batch)));
      }
      return { assets };
    },
    // maxAttempts 1: the batches above already retried.
    { schema: null, model: FLASH, parents: [], maxAttempts: 1 },
  );
}

/* --------------------------------------------------------------- dedupe */

/** Pure function, no model call, so it is not a node: it is part of B0's aftermath. */
export function runDedupe(jobId) {
  const job = readJob(jobId);
  const b0 = job.nodes.B0?.payload;
  if (!b0) throw new Error("dedupe needs B0");

  const withHashes = b0.assets.map((a) => ({
    ...a,
    phash: job.photos.find((p) => p.id === a.photo_id)?.phash ?? null,
  }));
  return dedupe(withHashes);
}

/* ------------------------------------------------------------------ B1 */

export async function runB1(jobId, { facts, assets }) {
  const market = facts.market === "in" ? "in" : "us";
  const region = String(facts.region || "").toUpperCase();
  const reraPortal = rules.rera_portals[region] || null;

  return runNode(
    jobId,
    "B1",
    async ({ retryHint }) => {
      const { json } = await callText({
        jobId,
        stage: "B1",
        model: FLASH,
        prompt: P.b1Prompt({ facts, assets, market, reraPortal }, retryHint),
        temperature: 0.1,
      });
      if (!json) throw new Error("B1 returned unparseable JSON");
      /* Negative observations are recorded, never marketed. On 2572 Lexington B1 wrote
         "Water damage is visible in one of the bedrooms" as an ordinary observed item
         and B6 put it on screen in all three reels. The prompt now asks for a defects
         list; this makes it true whatever the model does. */
      const { moved } = quarantineDefects(json);
      if (moved.length) json.defect_quarantine = moved;
      return json;
    },
    { schema: "ListingTruth", model: FLASH, parents: ["B0"] },
  );
}

/* ------------------------------------------------------------------ B2 */

export async function runB2(jobId, { truth }) {
  const market = truth.market;
  const city = truth.facts.city;
  return runNode(
    jobId,
    "B2",
    async ({ retryHint }) => {
      const { json } = await callText({
        jobId,
        stage: "B2",
        model: LITE,
        prompt: P.b2Prompt({ truth, market, city }, retryHint),
        temperature: 0.2,
      });
      if (!json) throw new Error("B2 returned unparseable JSON");
      return json;
    },
    { schema: "TierPersona", model: LITE, parents: ["B1"] },
  );
}

/* ------------------------------------------------------------------ B3 */

export async function runB3(jobId, { truth, persona, assets }) {
  return runNode(
    jobId,
    "B3",
    async ({ retryHint }) => {
      const { json } = await callText({
        jobId,
        stage: "B3",
        model: LITE,
        prompt: P.b3Prompt({ truth, persona, assets, market: truth.market }, retryHint),
        temperature: 0.3,
      });
      if (!json) throw new Error("B3 returned unparseable JSON");

      // "three distinct formats AND three distinct tiers" is a hard requirement of the
      // stage, not a preference, so it is checked here rather than hoped for.
      const reels = json.reels || [];
      const formats = new Set(reels.map((r) => r.format_id));
      const tiers = new Set(reels.map((r) => r.tier));
      if (formats.size !== 3 || tiers.size !== 3) {
        throw new Error(
          `need 3 distinct format_id and 3 distinct tier, got formats ${[...formats].join(",")} and tiers ${[...tiers].join(",")}`,
        );
      }
      return json;
    },
    { schema: "FormatPlan", model: LITE, parents: ["B1", "B2"] },
  );
}

/* ------------------------------------------------------------------ B4 */

/** cost-model.json hook_path, priced deterministically. The model does not do arithmetic. */
export function hookEstimate(generationPath, conceptId) {
  const usdInr = costModel.fx.usd_inr;
  const spec = costModel.hook_path[generationPath];
  if (!spec || generationPath === "free_2p5d") {
    return { still_inr: 0, clip_usd: 0, retry_allowance_usd: 0, total_usd: 0, total_inr: 0 };
  }
  const v = costModel.providers.vertex;
  const tokens = (q) =>
    q ? (q.in_tokens / 1e6) * v[q.model].usd_per_m_input + (q.out_tokens / 1e6) * v[q.model].usd_per_m_output : 0;
  const stillUsd = spec.still ? v[spec.still.model].usd_per_image_1024 * (spec.still.images || 1) : 0;
  const seconds = spec.clip?.duration_s ?? costModel.hook_duration_by_concept_s[conceptId] ?? 8;
  const clipUsd = spec.clip ? v[spec.clip.model].usd_per_s * seconds : 0;
  const q1Usd = tokens(spec.q1);
  const q2Usd = tokens(spec.q2);
  // Reroll allowance: one more still + Q1. A second clip is never allowed (index.js).
  const retryUsd = stillUsd + q1Usd;
  const totalUsd = stillUsd + q1Usd + clipUsd + q2Usd + retryUsd;
  return {
    still_inr: Number((stillUsd * usdInr).toFixed(2)),
    clip_usd: Number(clipUsd.toFixed(3)),
    retry_allowance_usd: Number(retryUsd.toFixed(3)),
    total_usd: Number(totalUsd.toFixed(3)),
    total_inr: Number((totalUsd * usdInr).toFixed(2)),
  };
}

/** rules.json restrictions for the default paid concept, checked against this listing. */
export function defaultPaidEligible(concept, truth, assets) {
  const r = concept.restrictions || [];
  if (r.includes("not_for_towers") && ["apartment", "penthouse"].includes(truth.facts.property_type)) return false;
  const pool = new Set(assets.map((a) => a.room_class));
  return (concept.needs || []).every((need) => need.split("|").some((c) => pool.has(c)));
}

/**
 * Hook selection. The only node whose output leads to spend, so it carries the full
 * payload preview: prompts, engine, duration, cost and the truth-lock plan.
 *
 * B4 itself is a text call. The money is spent by src/hook, and only after the
 * pre_generation preflight has passed.
 *
 * What the model chooses: the concept, the source photo, the fallback, the reasoning.
 * What the code fills in: the prompts for reverse_conceal (verbatim from hook-v4.mjs),
 * the cost (cost-model.json), the disclosure label (rules.json), the truth lock and
 * the window. Those are either verified or arithmetic, and neither is a model's job.
 */
export async function runB4(jobId, reelN, { truth, persona, assets, alreadyPicked, paidAllowed, forcedConcept = null }) {
  return runNode(
    jobId,
    "B4",
    async ({ retryHint }) => {
      const { json } = await callText({
        jobId,
        reelN,
        stage: `B4:${reelN}`,
        model: FLASH,
        prompt: P.b4Prompt(
          { reelN, truth, persona, assets, alreadyPicked, paidAllowed, forcedConcept, market: truth.market, costModel },
          retryHint,
        ),
        temperature: 0.3,
        /* A healthy B4 reply is ~900 tokens. Two of three B4 calls in one run degenerated
           into an endless comma list in negative_prompt and billed the 8192 cap each. */
        maxOutputTokens: 2048,
      });
      if (!json) throw new Error(`B4:${reelN} returned unparseable JSON`);
      json.reel_n = reelN;

      /* The run controls chose this reel's concept. The model still picks the source photo
         and the fallback; the concept itself is not its call. */
      if (forcedConcept && json.concept_id !== forcedConcept) {
        json.why = `set in the run controls (model had proposed ${json.concept_id})`;
        json.concept_id = forcedConcept;
      } else if (forcedConcept) {
        json.why = `set in the run controls. ${json.why ?? ""}`.trim();
      }

      const concept = rules.hook_bank.find((h) => h.id === json.concept_id);
      if (!concept) throw new Error(`unknown concept_id "${json.concept_id}"`);
      if (!forcedConcept && alreadyPicked.includes(json.concept_id)) {
        throw new Error(`concept "${json.concept_id}" was already picked for this job`);
      }
      if (concept.restrictions?.includes("never_default")) {
        throw new Error(`concept "${json.concept_id}" is never_default in rules.json`);
      }

      /* The path is the concept's, not the model's. rules.json v1.2 deprecated
         still_then_clip for concealment: generating from a still where the building is
         hidden made the model invent a different house, twice. */
      /* A job that may not use a paid hook never fails because the model reached for
         one. A free run failed B4 twice on dollhouse_plan_to_house; the choice is swapped
         for the best eligible free concept instead, and the swap is recorded. */
      if (!paidAllowed && concept.default_path !== "free_2p5d") {
        const pool = new Set(assets.map((a) => a.room_class));
        const fits = (h) => (h.needs || []).every((n) => n.split("|").some((c) => pool.has(c)));
        const free = rules.hook_bank
          .filter((h) => h.default_path === "free_2p5d" && !alreadyPicked.includes(h.id))
          .sort((a, b) => Number(fits(b)) - Number(fits(a)) || b.scroll_stop - a.scroll_stop);
        const preferred = free.find((h) => h.id === json.fallback_concept) ?? free[0];
        if (!preferred) throw new Error("no free concept left for this reel");
        json.why = `paid hook is off for this job; model proposed ${json.concept_id}, using free ${preferred.id}`;
        json.concept_id = preferred.id;
        return finishB4(json, preferred);
      }
      return finishB4(json, concept);
    },
    { schema: "HookPlan", reelN, model: FLASH, parents: ["B0", "B1", "B2", "B3"] },
  );

  /* Everything after the concept is settled: path, engine, prompts, cost, disclosure. */
  function finishB4(json, concept) {
    json.generation_path = concept.default_path;
    /* rules.json reverse_conceal.verified_on is veo-3.1-lite on Vertex, whatever the
       concept's default_engine says: the fal engines are not wired, and the lastFrame
       behaviour the path depends on was verified on Veo only. */
    json.engine = json.generation_path === "free_2p5d" ? "none" : "veo_3_1_lite";
    if (json.generation_path !== "free_2p5d" && !paidAllowed) {
      throw new Error(`"${json.concept_id}" is paid and this reel may not use a paid hook`);
    }
    /* The default paid hook is the rules.json concept marked default_paid (build
       itself). It needs no aerial and no clear foreground; the drape put its cover on
       a parked SUV every time on Lexington. Another paid concept is only accepted
       when the default's restrictions exclude this property. */
    const defaultPaid = rules.hook_bank.find((h) => h.default_paid);
    if (
      !forcedConcept &&
      json.generation_path !== "free_2p5d" &&
      defaultPaid &&
      json.concept_id !== defaultPaid.id &&
      defaultPaidEligible(defaultPaid, truth, assets) &&
      !alreadyPicked.includes(defaultPaid.id)
    ) {
      throw new Error(
        `the default paid hook is ${defaultPaid.id} and this property qualifies for it; "${json.concept_id}" is only allowed when ${defaultPaid.id} is excluded`,
      );
    }
    if (!["free_2p5d", "reverse_conceal"].includes(json.generation_path)) {
      throw new Error(`"${json.concept_id}" uses ${json.generation_path}, which has no verified pipeline in D3`);
    }

    const source = assets.find((a) => a.photo_id === json.source_photo_id);
    if (!source) throw new Error(`source_photo_id "${json.source_photo_id}" is not in the pool`);
    json.source_crop_9x16 = json.source_crop_9x16?.x_center != null ? json.source_crop_9x16 : source.safe_crop_9x16;

    if (json.generation_path === "reverse_conceal") {
      const prompts = hookPrompts(json.concept_id, {
        roomClass: source.room_class,
        vehiclesPresent: Boolean(source.flags?.vehicles_present),
      });
      json.still_prompt = prompts.still_prompt;
      json.clip_prompt = prompts.clip_prompt;
      json.prompt_template = prompts.template;
      json.prompt_verified = prompts.verified;
      json.last_frame_still = true;
      json.reverse_after_generate = true;
    } else {
      json.still_prompt = "";
      json.last_frame_still = null;
      json.reverse_after_generate = false;
    }
    json.negative_prompt = "";

    json.duration_s = costModel.hook_duration_by_concept_s[json.concept_id] ?? 0;
    json.usable_window_s =
      json.generation_path === "free_2p5d"
        ? { start: 0, end: rules.job_defaults.hook_usable_s }
        : { start: Number((json.duration_s - HOOK_WINDOW_S).toFixed(2)), end: json.duration_s };
    json.truth_lock = { mode: "crossfade_to_source", frames: rules.job_defaults.truth_lock_frames };
    json.est_cost = hookEstimate(json.generation_path, json.concept_id);
    json.disclosure_label =
      json.generation_path === "free_2p5d"
        ? ""
        : rules.required_overlays[truth.market]?.hook_label || "";
    json.qa_checks = rules.qa_reject_list;
    json.aspect = "9x16";
    json.emit_16x9_derivative = true;

    const fallback = rules.hook_bank.find((h) => h.id === json.fallback_concept);
    if (!fallback || fallback.default_path !== "free_2p5d" || fallback.id === json.concept_id) {
      // A paid fallback for a paid failure is how a job spends twice for nothing.
      json.fallback_concept = ["blueprint_to_photo", "sky_drop", "paper_popup_room"].find((id) => id !== json.concept_id);
    }
    return json;
  }
}

/* ------------------------------------------------------------------ B5 */

export async function runB5(jobId, { truth, persona, assets, formats, excluded }) {
  return runNode(
    jobId,
    "B5",
    async ({ retryHint }) => {
      const { json } = await callText({
        jobId,
        stage: "B5",
        model: FLASH,
        prompt: P.b5Prompt({ truth, persona, assets, formats }, retryHint),
        temperature: 0.2,
      });
      if (!json) throw new Error("B5 returned unparseable JSON");

      if ((json.interior_count ?? 0) > rules.max_interiors) {
        throw new Error(
          `interior_count ${json.interior_count} exceeds rules.json max_interiors ${rules.max_interiors}`,
        );
      }

      /* Nothing is ever silently dropped. The dedupe losers were excluded before B5
         ever saw them, so their reasons are merged in here rather than lost. */
      const seen = new Set((json.exclusions || []).map((e) => e.photo_id));
      json.exclusions = [
        ...(json.exclusions || []),
        ...excluded.filter((e) => !seen.has(e.photo_id)).map((e) => ({
          photo_id: e.photo_id,
          reason: e.reason,
        })),
      ];
      return json;
    },
    { schema: "ShotList", model: FLASH, parents: ["B1", "B2", "B3"] },
  );
}

/* ------------------------------------------------------------------ B6 */

/**
 * Copy for one reel. The claims_trace check is the point of this node: a card carrying
 * a number that does not resolve to a B1 id is rejected and regenerated, because
 * "every claim must trace to a listing fact" is a BLOCK rule at export.
 */
export async function runB6(
  jobId,
  reelN,
  /* D2 has no B4 and no generated hook, so hookIsGenerated is false and the reels carry
     no altered-image disclosure. D3 flips it per reel from B4.generation_path. */
  { truth, persona, format, shots, assets, hookIsGenerated = false },
) {
  const assetsById = Object.fromEntries((assets || []).map((a) => [a.photo_id, a]));
  const defectIds = new Set((truth.defects || []).map((d) => d.id));
  /* Every id a claim may legitimately cite. compliance_context belongs here as much as
     facts does: the altered-image disclosure traces to originals_url, which lives
     there, and leaving it out rejected a correct trace. */
  const validIds = new Set([
    ...truth.observed.map((o) => o.id),
    ...truth.specials.map((s) => s.id),
    ...truth.provable_numbers.map((p) => p.id),
    ...Object.keys(truth.facts),
    ...Object.keys(truth.compliance_context || {}),
  ]);

  return runNode(
    jobId,
    "B6",
    async ({ retryHint }) => {
      const { json } = await callText({
        jobId,
        reelN,
        stage: `B6:${reelN}`,
        model: FLASH,
        prompt: P.b6Prompt(
          { reelN, truth, persona, format, shots, assetsById, market: truth.market, hookIsGenerated },
          retryHint,
        ),
        temperature: 0.4,
      });
      if (!json) throw new Error(`B6:${reelN} returned unparseable JSON`);
      json.reel_n = reelN;

      const problems = auditClaims(json, validIds, truth.market);
      /* Defects: not one word of them, and no citation of one. A failure here goes back
         to the model once with the offending string named, then fails the node. */
      for (const { where, text } of copyTexts(json)) {
        const term = defectMatch(text);
        if (term) problems.push(`${where} "${text}" mentions a property defect ("${term}"); defects are never copy`);
      }
      for (const t of json.claims_trace || []) {
        if (defectIds.has(t.source?.id)) problems.push(`claims_trace "${t.text}" cites defect ${t.source.id}`);
      }
      if (problems.length) throw new Error(problems.join(" | "));

      /* Room binding is arithmetic over B0, not a request to the model: the prompt
         already listed each shot's room_class and B6 still captioned a bedroom
         "Brick Facade". */
      bindCaptions(json, { truth, shots, assetsById });
      return json;
    },
    { schema: "CopySet", reelN, model: FLASH, parents: ["B1", "B2", "B3", "B5"] },
  );
}

const NUMBER = /\d/;

/** Every card string carrying a number must have a claims_trace entry resolving to B1. */
export function auditClaims(copy, validIds, market) {
  const problems = [];
  const trace = copy.claims_trace || [];
  const traced = trace.map((t) => String(t.text || "").toLowerCase());

  for (const t of trace) {
    if (!t.source?.id || !validIds.has(t.source.id)) {
      problems.push(
        `claims_trace entry "${t.text}" points at unknown listing_truth id "${t.source?.id}"`,
      );
    }
  }

  const cards = [
    ["hook_card", copy.hook_card],
    ["proof_card", copy.proof_card],
    ["floor_plan_card", copy.floor_plan_card],
    ["cta_card", copy.cta_card],
    ...(copy.fact_captions || []).map((c, i) => [`fact_captions[${i}]`, c]),
  ].filter(([, c]) => c);

  for (const [name, card] of cards) {
    for (const field of ["title", "subtitle"]) {
      const text = card[field];
      if (!text || !NUMBER.test(text)) continue;
      // The CTA compliance band is licence numbers and a phone number; those trace to
      // compliance_context, not to a claim about the property.
      if (name === "cta_card" && field === "subtitle") continue;
      const covered = traced.some(
        (t) => t.includes(text.toLowerCase()) || text.toLowerCase().includes(t),
      );
      if (!covered) {
        problems.push(
          `${name}.${field} "${text}" contains a number with no claims_trace entry`,
        );
      }
    }
  }

  const banned = rules.banned_phrases[market] || [];
  const haystack = JSON.stringify(copy).toLowerCase();
  for (const phrase of banned) {
    if (haystack.includes(phrase.toLowerCase())) {
      problems.push(`banned phrase for market=${market}: "${phrase}"`);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ B7 */

export async function runB7(jobId, reelN, { tier, persona, shots, tracks, hookLengthS }) {
  /* The length budget is arithmetic, so it is decided here rather than asked of the
     model: B7 picks the track and snaps cuts to the beat grid. */
  const fitted = fitShotsToTier(shots, tier);

  return runNode(
    jobId,
    "B7",
    async ({ retryHint }) => {
      const { json } = await callText({
        jobId,
        reelN,
        stage: `B7:${reelN}`,
        model: LITE,
        prompt: P.b7Prompt(
          { reelN, tier, persona, shots: fitted.shots, tracks, hookLengthS, budget: fitted },
          retryHint,
        ),
        temperature: 0.2,
      });
      if (!json) throw new Error(`B7:${reelN} returned unparseable JSON`);
      json.reel_n = reelN;
      json.tier = tier;

      // The deterministic drops are part of the record, never silently lost.
      const seen = new Set(json.dropped_shot_ids || []);
      json.dropped_shot_ids = [
        ...(json.dropped_shot_ids || []),
        ...fitted.dropped.map((d) => d.shot_id).filter((id) => !seen.has(id)),
      ];

      /* The model chose the track and the transitions. The clock is ours: rebuild the
         cut times from the fitted shot durations, snapped to that track's beat grid. */
      const track = tracks.find((tr) => tr.track_id === json.track_id);
      if (!track) {
        throw new Error(
          `track_id "${json.track_id}" is not in the library (${tracks.map((tr) => tr.track_id).join(", ")})`,
        );
      }
      const transitionOf = new Map(
        (json.cuts || []).map((c) => [String(c.shot_id), c.transition]),
      );
      const { cuts, total } = buildCutMap(fitted.shots, tier, track);
      json.cuts = cuts.map((c, i) => ({
        ...c,
        transition: pickTransition(transitionOf.get(String(c.shot_id)), i, cuts, json),
      }));
      json.total_length_s = total;
      json.bpm = track.bpm;
      json.hook_length_s = track.drop_ms ? track.drop_ms / 1000 : 2.0;
      json.drop_time_s = track.drop_ms ? track.drop_ms / 1000 : null;

      return json;
    },
    { schema: "PacingPlan", reelN, model: LITE, parents: ["B2", "B3", "B5"] },
  );
}

/**
 * rules.json transition_rules, enforced rather than requested: whip_blur only on the
 * drop, never the same transition twice in a row, hook to exterior defaults to a cut.
 */
function pickTransition(wanted, i, cuts, pacing) {
  const allowed = rules.transitions;
  const previous = i > 0 ? cuts[i - 1].transition : null;
  const isDrop =
    pacing.drop_time_s != null && Math.abs(cuts[i].t - pacing.drop_time_s) < 0.05;

  let choice = allowed.includes(wanted) ? wanted : "cut";
  if (i === 0) choice = "cut"; // nothing to transition from
  if (choice === "whip_blur" && !isDrop && rules.transition_rules.whip_blur_only_on_drop) {
    choice = "crossfade_short";
  }
  if (i === 1 && rules.transition_rules.hook_to_exterior_default) {
    choice = rules.transition_rules.hook_to_exterior_default;
    cuts[i].transition = choice;
    return choice; // the hook handoff is fixed by rules.json, nothing overrides it
  }
  /* no_repeat_consecutive is about EFFECTS. Two hard cuts in a row is ordinary
     editing, and treating "cut" as repeatable is what lets hook_to_exterior_default
     stay a cut instead of being bumped into a zoom_through. */
  if (
    rules.transition_rules.no_repeat_consecutive &&
    choice === previous &&
    choice !== "cut"
  ) {
    choice = allowed.find((tr) => tr !== previous && tr !== "whip_blur" && tr !== "cut") || "cut";
  }
  cuts[i].transition = choice;
  return choice;
}

/* ------------------------------------------------------------------ B8 */

export { runB8 } from "./preflight.js";
