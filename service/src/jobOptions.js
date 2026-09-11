/**
 * Per-job run options, and the one function every paid code path asks.
 *
 * The dashboard sends these with the job, so a run is controlled from the page rather
 * than by redeploying with different env. Resolution:
 *
 *   interiorMotion   the job's value wins. INTERIOR_MOTION env is only the default.
 *   generative       the job's value wins, with one exception: when GENERATIVE_ENABLED is
 *                    not "true" on the server, no job can turn paid calls ON. The service
 *                    has no auth, and CLAUDE.md makes that env value the gate on every paid
 *                    video call; it stays a kill switch. Railway runs with it true, so the
 *                    toggle has its full range there.
 *   paidHook         whether any reel may use a paid hook. Separate from generative because
 *                    glides need generative too: "no paid hook, veo glides" is a real run.
 *   heroRooms        0..interior_motion.max_hero_interiors, default 3
 *   hookConcept      reel 1's concept. Paid concepts need generative; free ones always run.
 *   hookConcepts     one concept per reel, [reel1, reel2, reel3]; null lets B4 choose. A
 *                    paid concept named here gets its own paid hook, so a job can carry
 *                    more than one (the reference reels open every reel on a Veo reveal).
 *                    Without it the old rule stands: one paid hook per job, on reel 1.
 *
 * Both the requested and the effective values are stored on the job, so a run records
 * what was asked for and what actually happened, and why they differ.
 */
import { config, rules, costModel } from "./config.js";

export const PAID_CONCEPTS = rules.hook_bank.filter((h) => h.default_path === "reverse_conceal").map((h) => h.id);
export const FREE_CONCEPTS = rules.hook_bank.filter((h) => h.default_path === "free_2p5d").map((h) => h.id);
/** What the dashboard offers. build_itself is rules.json block_build. */
export const OFFERED_CONCEPTS = [
  "block_build",
  "helicopter_drape",
  "haze_reveal",
  "sky_drop",
  "blueprint_to_photo",
  "paper_popup_room",
];
const REELS = rules.job_defaults.reels_per_job;

const MAX_HERO = rules.interior_motion.max_hero_interiors;

/**
 * Validate what a client sent. Unknown or malformed values are errors, not silent
 * defaults: a typo in a toggle must not quietly become a paid run.
 */
export function parseOptions(raw = {}) {
  const errors = [];
  const out = {};
  if (raw.generative != null) {
    if (typeof raw.generative !== "boolean") errors.push("generative must be true or false");
    else out.generative = raw.generative;
  }
  if (raw.paidHook != null) {
    if (typeof raw.paidHook !== "boolean") errors.push("paidHook must be true or false");
    else out.paidHook = raw.paidHook;
  }
  if (raw.interiorMotion != null) {
    if (!["2.5d", "veo"].includes(raw.interiorMotion)) errors.push('interiorMotion must be "2.5d" or "veo"');
    else out.interiorMotion = raw.interiorMotion;
  }
  if (raw.heroRooms != null) {
    const n = Number(raw.heroRooms);
    if (!Number.isInteger(n) || n < 0 || n > MAX_HERO) errors.push(`heroRooms must be an integer 0..${MAX_HERO}`);
    else out.heroRooms = n;
  }
  if (raw.hookConcept != null) {
    if (!OFFERED_CONCEPTS.includes(raw.hookConcept)) errors.push(`hookConcept must be one of ${OFFERED_CONCEPTS.join(", ")}`);
    else out.hookConcept = raw.hookConcept;
  }
  if (raw.hookConcepts != null) {
    const list = raw.hookConcepts;
    if (!Array.isArray(list) || list.length > REELS) {
      errors.push(`hookConcepts must be an array of at most ${REELS} concept ids or null`);
    } else {
      const bad = list.filter((c) => c != null && !OFFERED_CONCEPTS.includes(c));
      if (bad.length) errors.push(`hookConcepts has unknown concepts ${bad.join(", ")}; offered: ${OFFERED_CONCEPTS.join(", ")}`);
      else out.hookConcepts = list.map((c) => c ?? null);
    }
  }
  if (errors.length) throw Object.assign(new Error(`invalid options: ${errors.join("; ")}`), { status: 400 });
  return out;
}

/** requested (parsed) -> effective, with the reason for every difference. */
export function resolveOptions(requested = {}) {
  const notes = [];
  let generative = requested.generative ?? config.generativeEnabled;
  if (generative && !config.generativeEnabled) {
    generative = false;
    notes.push("generative requested but GENERATIVE_ENABLED is off on this server (kill switch)");
  }
  const interiorMotion = requested.interiorMotion ?? config.interiorMotion;
  const heroRooms = interiorMotion === "veo" ? (requested.heroRooms ?? MAX_HERO) : 0;

  let paidHook = (requested.paidHook ?? generative) && generative;
  if (requested.paidHook && !generative) notes.push("paid hook requested but generative is off");
  /* hookConcepts wins over hookConcept for reel 1 when both are sent. A paid concept on a
     job with the paid hook off is dropped per reel, with the reason. */
  const perReel = Array.from({ length: REELS }, (_, i) =>
    requested.hookConcepts?.[i] ?? (i === 0 ? (requested.hookConcept ?? null) : null),
  );
  const hookConcepts = perReel.map((c, i) => {
    if (c && PAID_CONCEPTS.includes(c) && !paidHook) {
      notes.push(`${c} is a paid concept and the paid hook is off; reel ${i + 1} uses a free concept`);
      return null;
    }
    return c;
  });
  const hookConcept = hookConcepts[0];
  if (interiorMotion === "veo" && !generative && heroRooms > 0) {
    notes.push("interior motion veo needs generative; interiors stay 2.5d");
  }
  return {
    generative,
    paidHook,
    interiorMotion: interiorMotion === "veo" && generative ? "veo" : "2.5d",
    heroRooms: interiorMotion === "veo" && generative ? heroRooms : 0,
    hookConcept,
    hookConcepts,
    notes,
    env: { GENERATIVE_ENABLED: config.generativeEnabled, INTERIOR_MOTION: config.interiorMotion },
  };
}

/**
 * The flags for a stored job. Jobs created before per-job options fall back to env, so
 * every existing job keeps behaving exactly as it did.
 */
export function jobFlags(job) {
  if (job?.options?.effective) {
    const e = job.options.effective;
    return {
      generative: Boolean(e.generative) && config.generativeEnabled,
      paidHook: Boolean(e.paidHook ?? e.generative) && Boolean(e.generative) && config.generativeEnabled,
      interiorMotion: e.interiorMotion === "veo" && config.generativeEnabled ? "veo" : "2.5d",
      heroRooms: e.heroRooms ?? 0,
      hookConcept: e.hookConcept ?? null,
      hookConcepts: e.hookConcepts ?? [e.hookConcept ?? null],
    };
  }
  return {
    generative: config.generativeEnabled,
    paidHook: config.generativeEnabled,
    interiorMotion: config.interiorMotion,
    heroRooms: MAX_HERO,
    hookConcept: null,
    hookConcepts: [],
  };
}

/**
 * The concept the run controls fixed for a reel, or null. `paidAllowed` for B4: a reel
 * whose fixed concept is paid may use it; an unfixed reel may use a paid hook only if no
 * other reel already has one (cost-model presets.one_paid_hook).
 */
export function reelHookPlan(flags, reelN, otherPlans) {
  const forcedConcept = flags.hookConcepts?.[reelN - 1] ?? null;
  const forcedPaid = Boolean(forcedConcept && PAID_CONCEPTS.includes(forcedConcept));
  const paidAllowed = forcedPaid
    ? flags.paidHook
    : flags.paidHook && !otherPlans.some((h) => h && h.generation_path !== "free_2p5d");
  return { forcedConcept, paidAllowed };
}

/**
 * Hard spend stop. cost-model.json guards.block_above_usd_per_listing: a job whose ledger
 * plus the next paid step would cross it does not make the call.
 */
export function budgetCheck(job, nextUsd) {
  const spent = (job.ledger || []).reduce((s, r) => s + (r.cost_usd || 0), 0);
  const block = costModel.guards.block_above_usd_per_listing;
  const ok = spent + nextUsd <= block;
  return {
    ok,
    spentUsd: Number(spent.toFixed(4)),
    nextUsd: Number(nextUsd.toFixed(4)),
    blockUsd: block,
    reason: ok ? null : `BUDGET: job has spent $${spent.toFixed(2)}; the next step ($${nextUsd.toFixed(2)}) would cross the $${block} block line`,
  };
}
