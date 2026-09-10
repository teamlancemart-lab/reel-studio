/**
 * D1 pipeline. Saves the files, probes their dimensions, completes.
 *
 * No model calls. No brain. D2 inserts B0..B8 between "probe" and "complete", D3 adds
 * the hook and the render. The stage names emitted here are the ones the web client
 * already renders, so adding stages later does not change the client.
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
  photosDir,
} from "./store.js";
import { probeImage } from "./lib/media.js";
import { config } from "./config.js";
import { runBrain } from "./brain/index.js";

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

    /* D2: the brain. D1 stopped here with status=completed; the pipeline now runs
       B0..B8 and builds the recipes. runBrain owns the completed/failed transition
       because a preflight BLOCK is a failure with a rule id, not a success. */
    await runBrain(jobId);
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
