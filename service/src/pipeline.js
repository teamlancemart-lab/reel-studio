/**
 * The whole job, end to end, from one POST: probe -> brain -> hooks -> interior glides ->
 * three exports -> completed. The dashboard's Generate button starts this and watches it
 * over SSE; nothing in the flow needs a terminal.
 *
 * What runs is decided by the job's own options (jobOptions.js), not by env alone.
 *
 * Nothing is silently dropped: a photo ffprobe cannot read is excluded with a named
 * reason and shows up in the job JSON and on the SSE stream.
 */
import path from "node:path";
import {
  readJob,
  writeJob,
  setStage,
  addExclusion,
  addArtefact,
  fail,
  complete,
  emit,
  photosDir,
} from "./store.js";
import { probeImage } from "./lib/media.js";
import { config } from "./config.js";
import { runBrain } from "./brain/index.js";
import { preGenerationCheck } from "./brain/preflight.js";
import { buildHook } from "./hook/index.js";
import { buildGlides } from "./interiors/glide.js";
import { exportReel } from "./render/export.js";
import { jobFlags } from "./jobOptions.js";

/** Read-modify-write one photo on the persisted job. */
function patchPhoto(jobId, photoId, patch) {
  const job = readJob(jobId);
  if (!job) return;
  const photo = job.photos.find((p) => p.id === photoId);
  if (!photo) return;
  Object.assign(photo, patch);
  writeJob(job);
}

export async function runJob(jobId) {
  try {
    setStage(jobId, "saving_photos", 0.1, { status: "processing" });

    const job = readJob(jobId);
    if (!job) throw new Error(`job ${jobId} vanished from the store`);

    if (job.photos.length < config.minPhotos) {
      // A note, not a failure: the canvas preview is useful with fewer, and D1 is a
      // skeleton. B8 is where counts become BLOCKing.
      setStage(jobId, "photo_count_low", 0.15, {
        note: `${job.photos.length} photos, the pipeline expects at least ${config.minPhotos}`,
      });
    }

    setStage(jobId, "probing", 0.3);

    const total = job.photos.length;
    let done = 0;
    for (const photo of job.photos) {
      const abs = path.join(photosDir(jobId), photo.storedName);
      try {
        const { width, height } = await probeImage(abs);
        patchPhoto(jobId, photo.id, {
          width,
          height,
          aspect: Number((width / height).toFixed(4)),
        });
      } catch (err) {
        const reason = `unreadable_image: ${err.message.slice(0, 120)}`;
        patchPhoto(jobId, photo.id, { excluded_reason: reason });
        addExclusion(jobId, photo.id, reason);
      }
      done += 1;
      setStage(jobId, "probing", 0.3 + 0.6 * (done / Math.max(1, total)), {
        probed: done,
        total,
      });
    }

    for (const photo of readJob(jobId).photos) {
      if (photo.excluded_reason) continue;
      addArtefact(jobId, {
        kind: "photo",
        id: photo.id,
        name: photo.storedName,
        bucket: photo.bucket,
        width: photo.width,
        height: photo.height,
        bytes: photo.bytes,
        url: `/jobs/${jobId}/file/${encodeURIComponent(photo.storedName)}`,
      });
    }

    /* The brain. A preflight BLOCK fails the job there, with its rule id. */
    const brain = await runBrain(jobId, { finish: false });
    if (brain.blocked) return;

    await runProduction(jobId);
    complete(jobId);
  } catch (err) {
    fail(jobId, err.message.slice(0, 500));
  }
}

/**
 * Resume a failed job from the dashboard: every node already stored as ok and not stale
 * is reused, then production runs. A transient failure costs the failed step, not the job.
 */
export async function resumeJob(jobId) {
  try {
    // A resumed job is not failed any more; the old reason and end time would lie.
    emit(jobId, "stage", { stage: "resuming", progress: 0.05 }, (job) => {
      job.status = "processing";
      job.stage = "resuming";
      job.failureReason = null;
      job.completedAt = null;
    });
    const brain = await runBrain(jobId, { resume: true, finish: false });
    if (brain.blocked) return;
    await runProduction(jobId);
    complete(jobId);
  } catch (err) {
    fail(jobId, err.message.slice(0, 500));
  }
}

/** Used by POST /jobs so a throw inside the async run never becomes silent. */
export function runJobDetached(jobId) {
  runJob(jobId).catch((err) => {
    try {
      fail(jobId, `unhandled: ${err.message.slice(0, 400)}`);
    } catch {
      console.error(`job ${jobId} failed and could not be recorded:`, err);
    }
  });
}

/**
 * After the brain: a hook for every reel, glides if the job asked for them, three
 * masters. A reel that fails a step is recorded on job.run_issues with its reason and the
 * job carries on; one bad clip must not throw away two good reels.
 */
export async function runProduction(jobId) {
  const issue = (step, reelN, err) => {
    const message = String(err?.message ?? err).slice(0, 400);
    emit(jobId, "run_issue", { step, reelN, message }, (job) => {
      job.run_issues = [...(job.run_issues || []), { step, reel_n: reelN, message, at: new Date().toISOString() }];
    });
  };

  const job = readJob(jobId);
  const flags = jobFlags(job);
  const reels = (job.nodes.B3?.payload?.reels || []).map((r) => r.reel_n);

  /* ---- hooks. The paid one first, so a budget stop lands before the free work. */
  setStage(jobId, "hooks", 0.9);
  const order = [...reels].sort((a, b) => {
    const paid = (n) => (readJob(jobId).nodes[`B4:${n}`]?.payload?.generation_path !== "free_2p5d" ? 0 : 1);
    return paid(a) - paid(b) || a - b;
  });
  for (const reelN of order) {
    setStage(jobId, `hook:${reelN}`, 0.9);
    const current = readJob(jobId);
    const plan = current.nodes[`B4:${reelN}`]?.payload;
    let forceFreeReason = null;
    if (plan && plan.generation_path !== "free_2p5d") {
      const gate = preGenerationCheck(current, reelN);
      emit(jobId, "preflight", { reelN, stage: "pre_generation", pass: gate.pass, results: gate.results });
      if (!gate.pass) {
        forceFreeReason = `pre_generation BLOCK: ${gate.results.filter((r) => r.level === "BLOCK").map((r) => r.rule_id).join(", ")}`;
      }
    }
    try {
      await buildHook(jobId, reelN, { forceFreeReason });
    } catch (err) {
      issue("hook", reelN, err);
    }
  }

  /* ---- interior glides: job assets, built once, before any export uses them. */
  if (flags.interiorMotion === "veo" && flags.heroRooms > 0) {
    setStage(jobId, "interiors", 0.93);
    try {
      await buildGlides(jobId);
    } catch (err) {
      issue("interiors", null, err);
    }
  }

  /* ---- exports */
  for (const reelN of reels) {
    setStage(jobId, `export:${reelN}`, 0.95 + 0.015 * reelN);
    try {
      await exportReel(jobId, reelN, { kind: "export" });
    } catch (err) {
      issue("export", reelN, err);
    }
  }
}
