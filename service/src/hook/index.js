/**
 * Hook orchestration.
 *
 *   crop -> H1 -> Q1 -> (one reroll) -> H2 -> reverse -> Q2 -> cut + truth lock
 *                  \-> fail twice -> free fallback
 *                                           \-> Q2 fail -> free fallback
 *
 * cost-model.json guards: max_rerolls_per_hook 1, on_second_failure "fall back to
 * free_2p5d hook". Q1 fails cheap: a still is ₹3.3 and a clip is ₹33.6, so a still that
 * already lost the parked car never becomes a video. A Q2 failure falls back rather than
 * rerolling, because a second Veo call would take one hook past the ₹52 ceiling.
 *
 * Every attempt is kept on the hook record — the rejected still, its QA reply and the
 * reason — because nothing is ever silently dropped.
 */
import fs from "node:fs";
import path from "node:path";
import { config, rules, costModel } from "../config.js";
import { emit, readJob, writeJob, jobDir, photosDir, outDir } from "../store.js";
import {
  prepareHero,
  generateStill,
  generateClip,
  cutAndLock,
  runQ2,
  HOOK_WINDOW_S,
} from "./paid.js";
import { rerollHint } from "./qa.js";
import { renderFreeHook } from "./free.js";
import { jobFlags, budgetCheck } from "../jobOptions.js";

export const conceptById = (id) => rules.hook_bank.find((h) => h.id === id);

export function hookDir(jobId, reelN) {
  return path.join(jobDir(jobId), "hooks", `reel-${reelN}`);
}

/** The crop the hook uses: the plan's own if a person set one on the B4 card, else B0's. */
export function hookCrop(job, plan) {
  if (plan.source_crop_9x16?.x_center != null) return plan.source_crop_9x16;
  const asset = job.nodes.B0?.payload?.assets?.find((a) => a.photo_id === plan.source_photo_id);
  return asset?.safe_crop_9x16 ?? { x_center: 0.5, y_center: 0.5, width_frac: 1 };
}

/**
 * Build the hook for one reel from its B4 plan. Writes job.hooks[reelN].
 */
export async function buildHook(jobId, reelN, { supersedeReason = null, forceFreeReason = null } = {}) {
  const job = readJob(jobId);
  const plan = job.nodes[`B4:${reelN}`]?.payload;
  if (!plan) throw new Error(`reel ${reelN} has no B4 hook plan`);

  const photo = job.photos.find((p) => p.id === plan.source_photo_id);
  if (!photo) throw new Error(`hook source photo ${plan.source_photo_id} is not on the job`);
  const sourcePhotoPath = path.join(photosDir(jobId), photo.storedName);
  const crop = hookCrop(job, plan);
  const concept = conceptById(plan.concept_id);
  const workDir = hookDir(jobId, reelN);
  fs.mkdirSync(workDir, { recursive: true });
  const ledgerRowsBefore = job.ledger.length;

  /* A rebuilt hook never erases the one it replaces. The old record, its stills, its
     QA replies and its cost move to hook_history with the reason given. */
  if (job.hooks?.[reelN]) {
    const j2 = readJob(jobId);
    j2.hook_history = j2.hook_history || {};
    j2.hook_history[reelN] = j2.hook_history[reelN] || [];
    j2.hook_history[reelN].push({
      ...j2.hooks[reelN],
      superseded_at: new Date().toISOString(),
      superseded_reason: supersedeReason || "regenerated",
    });
    delete j2.hooks[reelN];
    writeJob(j2);
    emit(jobId, "hook", { reelN, step: "superseded", reason: supersedeReason || "regenerated" });
  }

  /* ------------------------------------------------------------ free path */
  if (plan.generation_path === "free_2p5d") {
    const free = await renderFreeHook({
      jobId, reelN, conceptId: plan.concept_id, sourcePhotoPath, workDir, xCenter: crop.x_center,
    });
    return saveHook(jobId, reelN, {
      concept_id: plan.concept_id,
      generation_path: "free_2p5d",
      source_photo_id: plan.source_photo_id,
      crop,
      hero_path: free.heroPath,
      clip_path: free.path,
      forward_path: null,
      duration_s: free.durationS,
      // A free hook moves the real pixels and dissolves to them; nothing to disclose.
      lock_done_s: free.durationS,
      attempts: [],
      q2: null,
      fell_back: false,
      fallback_reason: null,
      ledger_rows: [ledgerRowsBefore, ledgerRowsBefore],
    });
  }

  /* ------------------------------------------------------------ paid path */
  /* A paid plan that may not run still produces a hook: its free fallback, with the
     reason recorded. The pipeline passes forceFreeReason when pre_generation BLOCKs. */
  const flags = jobFlags(job);
  const budget = budgetCheck(job, plan.est_cost?.total_usd ?? 0);
  const refuse =
    forceFreeReason ||
    (!config.generativeEnabled && "GENERATIVE_ENABLED is off on this server") ||
    ((!flags.generative || !flags.paidHook) && "this job was run with the paid hook off") ||
    (!budget.ok && budget.reason);
  if (refuse) {
    return fallback(jobId, reelN, plan, {
      sourcePhotoPath, workDir, crop, attempts: [], q2: null, ledgerRowsBefore,
      because: `paid hook not run: ${refuse}`,
    });
  }
  if (plan.generation_path !== "reverse_conceal") {
    throw new Error(`generation_path "${plan.generation_path}" has no verified pipeline in D3; only reverse_conceal and free_2p5d run`);
  }

  // 1. crop before any model call
  const heroPath = await prepareHero({ jobId, reelN, sourcePhotoPath, workDir, crop });

  // 2 + 3. H1 and Q1, one reroll
  const maxRerolls = costModel.guards.max_rerolls_per_hook ?? 1;
  const attempts = [];
  let approved = null;
  let hint = null;
  for (let attempt = 1; attempt <= maxRerolls + 1; attempt++) {
    const still = await generateStill({ jobId, reelN, plan, concept, heroPath, workDir, attempt, hint });
    attempts.push({
      attempt,
      still_path: still.stillPath,
      prompt_hint: hint,
      q1: still.q1,
      verdict: still.q1.pass ? "approved" : "rejected",
    });
    if (still.q1.pass) {
      approved = still;
      break;
    }
    hint = rerollHint(still.q1, concept);
    emit(jobId, "hook", { reelN, step: "Q1 reroll", attempt, because: still.q1.rejects_found });
  }

  if (!approved) {
    return fallback(jobId, reelN, plan, {
      sourcePhotoPath, workDir, crop, attempts, q2: null, ledgerRowsBefore,
      because: `Q1 rejected ${attempts.length} stills: ${attempts.at(-1).q1.rejects_found.join("; ")}`,
    });
  }

  // 4. Veo: first frame = real hero, last frame = the approved still
  const forwardPath = await generateClip({ jobId, reelN, plan, heroPath, stillPath: approved.stillPath, workDir });

  // 5-7. reverse, cut the tail, truth lock
  const cut = await cutAndLock({
    forwardPath,
    heroPath,
    outDir: path.join(workDir, "v0"),
    windowStart: null,
    windowLength: HOOK_WINDOW_S,
    frames: plan.truth_lock?.frames ?? rules.job_defaults.truth_lock_frames,
  });
  emit(jobId, "hook", {
    reelN,
    step: "reverse+cut+lock",
    reversedDuration: +cut.reversedDuration.toFixed(2),
    windowStart: +cut.windowStart.toFixed(2),
    windowLength: cut.windowLength,
    lockAtS: +cut.lockAtS.toFixed(3),
  });

  // 8. Q2 on the reversed clip
  const { result: q2Result } = await runQ2({
    jobId, reelN, heroPath, reversedPath: cut.reversedPath, concept, workDir,
  });
  if (!q2Result.pass) {
    return fallback(jobId, reelN, plan, {
      sourcePhotoPath, workDir, crop, attempts, q2: q2Result, ledgerRowsBefore,
      because: `Q2 failed: ${q2Result.rejects_found.join("; ")}`,
      keep: { forward_path: forwardPath },
    });
  }

  return saveHook(jobId, reelN, {
    concept_id: plan.concept_id,
    generation_path: "reverse_conceal",
    source_photo_id: plan.source_photo_id,
    crop,
    hero_path: heroPath,
    still_path: approved.stillPath,
    forward_path: forwardPath,
    clip_path: cut.lockedPath,
    reversed_duration_s: cut.reversedDuration,
    window_start_s: cut.windowStart,
    window_length_s: cut.windowLength,
    lock_at_s: cut.lockAtS,
    lock_done_s: cut.lockDoneS,
    truth_lock_frames: cut.frames,
    duration_s: cut.durationS,
    attempts,
    q2: q2Result,
    fell_back: false,
    fallback_reason: null,
    ledger_rows: [ledgerRowsBefore, readJob(jobId).ledger.length],
  });
}

/** rules.json Q_FAIL_TWICE: switch to the fallback concept, which is always free. */
async function fallback(jobId, reelN, plan, ctx) {
  const conceptId = plan.fallback_concept || "blueprint_to_photo";
  emit(jobId, "hook", { reelN, step: "fallback", to: conceptId, because: ctx.because });

  const free = await renderFreeHook({
    jobId, reelN, conceptId, sourcePhotoPath: ctx.sourcePhotoPath, workDir: ctx.workDir, xCenter: ctx.crop.x_center,
  });
  return saveHook(jobId, reelN, {
    concept_id: conceptId,
    planned_concept_id: plan.concept_id,
    generation_path: "free_2p5d",
    source_photo_id: plan.source_photo_id,
    crop: ctx.crop,
    hero_path: free.heroPath,
    clip_path: free.path,
    forward_path: ctx.keep?.forward_path ?? null,
    duration_s: free.durationS,
    lock_done_s: free.durationS,
    attempts: ctx.attempts,
    q2: ctx.q2,
    fell_back: true,
    fallback_reason: ctx.because,
    ledger_rows: [ctx.ledgerRowsBefore, readJob(jobId).ledger.length],
  });
}

/** Ledger rows this hook's own stages wrote while it was built, and what they cost.
 *  Filtered by stage: interior glides running concurrently write into the same window. */
export function hookLedger(job, [from, to], reelN) {
  const stages = new Set([`H1:${reelN}`, `Q1:${reelN}`, `H2:${reelN}`, `Q2:${reelN}`]);
  const rows = job.ledger.slice(from, to).filter((r) => reelN == null || stages.has(r.stage));
  return {
    rows: rows.map((r) => ({ stage: r.stage, model: r.provider_model, status: r.status, cost_inr: r.cost_inr, cost_usd: r.cost_usd })),
    inr: Number(rows.reduce((s, r) => s + (r.cost_inr || 0), 0).toFixed(3)),
    usd: Number(rows.reduce((s, r) => s + (r.cost_usd || 0), 0).toFixed(4)),
  };
}

/**
 * Copy what a person needs to judge the hook into out/, where the file route serves it:
 * every still (rejected ones included), the forward clip, the QA frames.
 */
function publishArtefacts(jobId, reelN, record) {
  const dest = outDir(jobId);
  fs.mkdirSync(dest, { recursive: true });
  const copy = (src) => {
    if (!src || !fs.existsSync(src)) return null;
    const name = `hook-${reelN}_${path.basename(src)}`;
    fs.copyFileSync(src, path.join(dest, name));
    return name;
  };
  for (const a of record.attempts || []) a.still_file = copy(a.still_path);
  record.hero_file = copy(record.hero_path);
  record.forward_file = copy(record.forward_path);
  record.clip_file = copy(record.clip_path);
  record.qa_frames = ["qa_33.png", "qa_66.png", "qa_100.png"]
    .map((f) => path.join(hookDir(jobId, reelN), f))
    .filter((f) => record.q2 && fs.existsSync(f))
    .map(copy);
}

function saveHook(jobId, reelN, record) {
  publishArtefacts(jobId, reelN, record);
  const job = readJob(jobId);
  job.hooks = job.hooks || {};
  const full = {
    reel_n: reelN,
    ...record,
    cost: hookLedger(job, record.ledger_rows, reelN),
    created_at: new Date().toISOString(),
  };
  job.hooks[reelN] = full;
  writeJob(job);
  emit(jobId, "hook", {
    reelN,
    step: "saved",
    concept: full.concept_id,
    path: full.generation_path,
    fellBack: full.fell_back,
    costInr: full.cost.inr,
  });
  return full;
}
