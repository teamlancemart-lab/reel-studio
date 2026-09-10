/**
 * B0 to B8. Each one is a thin wrapper: build the prompt, make the call, hand the
 * payload to the runner, which validates and retries. No node handles its own retry
 * or its own ledger row; that is deliberate, so there is one place to audit.
 */
import fs from "node:fs";
import path from "node:path";
import { config, rules } from "../config.js";
import { callText, callVision } from "../lib/vertex.js";
import { photosDir, jobDir, readJob } from "../store.js";
import { runNode } from "./runner.js";
import { validate } from "./validate.js";
import { to512Base64, chunk } from "./images.js";
import { phash } from "./phash.js";
import { dedupe } from "./dedupe.js";
import { fitShotsToTier, buildCutMap } from "./fit.js";
import * as P from "./prompts.js";

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
  { truth, persona, format, shots, hookIsGenerated = false },
) {
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
          { reelN, truth, persona, format, shots, market: truth.market, hookIsGenerated },
          retryHint,
        ),
        temperature: 0.4,
      });
      if (!json) throw new Error(`B6:${reelN} returned unparseable JSON`);
      json.reel_n = reelN;

      const problems = auditClaims(json, validIds, truth.market);
      if (problems.length) throw new Error(problems.join(" | "));
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
