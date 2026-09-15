/**
 * The paid hook. Ported from docs/hook-v4.mjs, step for step.
 *
 * rules.json generation_paths.reverse_conceal documents why each step exists. The order
 * is the whole point, so it is spelled out here:
 *
 *   1. crop the hero to 9:16 BEFORE any model call              (v4 crop916)
 *   2. H1 still: the END state, the object fully covering the building, hero as the
 *      reference image                                           (v4 step 2)
 *   3. Q1: the still against the hero, in one call. One reroll.
 *   4. H2 clip: image = the REAL hero as FIRST frame, lastFrame = the still, 8s
 *      NEVER condition only on a still where the building is hidden. That produced a
 *      completely different house in testing, twice.            (v4 step 3)
 *   5. reverse, fps=30 — the clip now plays as a reveal and ENDS on the real photo
 *   6. cut the window from the END, because that is where the reveal completes
 *                                                                (v4 step 4 / retune.mjs)
 *   7. truth lock: crossfade the last 15 frames into a hold of the untouched hero
 *   8. Q2 on frames at 33/66/100 percent of the reversed clip
 *
 * Steps 5 to 7 are ffmpeg only and live in cutAndLock(), which POST /retune calls with
 * a different window. That function never touches a model.
 */
import fs from "node:fs";
import path from "node:path";
import { config, rules } from "../config.js";
import { callImage, submitVideo, pollVideo } from "../lib/vertex.js";
import { emit } from "../store.js";
import { crop916, videoDuration, sh, HOOK_W, HOOK_H } from "./crop.js";
import { q1, q2 } from "./qa.js";

export const b64 = (p) => fs.readFileSync(p).toString("base64");

/** hook-v4.mjs WINDOW_LEN. retune.mjs: "cut the tail, not the middle". */
export const HOOK_WINDOW_S = 2.2;
/** rules.json reverse_conceal step 5: "xfade 0.5s into a 1s hold of the untouched hero". */
export const TRUTH_LOCK_HOLD_S = 1.0;
const FPS = 30;

/* ------------------------------------------------------------------ step 1 */

export async function prepareHero({ jobId, reelN, sourcePhotoPath, workDir, crop }) {
  fs.mkdirSync(workDir, { recursive: true });
  const heroPath = path.join(workDir, "hero_916.png");
  const info = await crop916(sourcePhotoPath, heroPath, crop?.x_center ?? 0.5);
  emit(jobId, "hook", {
    reelN,
    step: "crop",
    note: `${info.src.width}x${info.src.height} -> ${info.crop.width}px wide at x=${info.crop.x} (x_center ${crop?.x_center ?? 0.5}) -> ${HOOK_W}x${HOOK_H}`,
  });
  return heroPath;
}

/* ------------------------------------------------------------ steps 2 and 3 */

/**
 * H1 then Q1. Returns { stillPath, stillRawPath, q1, prompt }.
 * `hint` is the previous Q1's diff, appended on a reroll.
 */
export async function generateStill({ jobId, reelN, plan, concept, heroPath, workDir, attempt, hint }) {
  const prompt = [plan.still_prompt, hint].filter(Boolean).join("\n\n");

  const stillRawPath = path.join(workDir, `still_a${attempt}.png`);
  const { buffer } = await callImage({
    jobId,
    reelN,
    stage: `H1:${reelN}`,
    prompt,
    reference: { mimeType: "image/png", data: b64(heroPath) },
  });
  fs.writeFileSync(stillRawPath, buffer);

  // v4: "Veo wants both frames the same size"
  const stillPath = path.join(workDir, `still_a${attempt}_720.png`);
  await sh("ffmpeg", ["-y", "-v", "error", "-i", stillRawPath, "-vf", `scale=${HOOK_W}:${HOOK_H}`, stillPath]);
  emit(jobId, "hook", { reelN, step: "H1", attempt, still: path.basename(stillPath) });

  const result = await q1({
    jobId,
    reelN,
    stage: `Q1:${reelN}`,
    referenceB64: b64(heroPath),
    stillB64: b64(stillPath),
    concept,
    model: config.textModel,
  });
  emit(jobId, "hook", {
    reelN,
    step: "Q1",
    attempt,
    pass: result.pass,
    rejects: result.rejects_found,
    counts: result.counts,
    notes: result.diff_notes,
  });

  return { stillPath, stillRawPath, q1: result, prompt };
}

/* ------------------------------------------------------------------ step 4 */

/** H2. Returns the forward clip path. The charge is ledgered at submit. */
export async function generateClip({ jobId, reelN, plan, heroPath, stillPath, workDir }) {
  const submit = await submitVideo({
    jobId,
    reelN,
    stage: `H2:${reelN}`,
    prompt: plan.clip_prompt,
    image: { mimeType: "image/png", data: b64(heroPath) }, // FIRST frame: the real hero
    lastFrame: { mimeType: "image/png", data: b64(stillPath) }, // LAST frame: the fitted cover
    aspectRatio: "9:16",
    durationSeconds: 8, // Vertex requires 8 with lastFrame
    resolution: "720p",
    generateAudio: false,
    personGeneration: "dont_allow",
  });
  emit(jobId, "hook", { reelN, step: "H2 submitted", op: submit.operationName.split("/").pop() });

  const { video } = await pollVideo({
    operationName: submit.operationName,
    jobId,
    reelN,
    stage: `H2:${reelN}`,
    durationSeconds: submit.durationSeconds,
    onPoll: (n, done) => emit(jobId, "hook", { reelN, step: "H2 poll", poll: n, done }),
  });
  if (!video.buffer) {
    throw new Error(`Veo returned a gcsUri (${video.gcsUri}); no bucket wiring in D3`);
  }

  const forwardPath = path.join(workDir, "forward.mp4");
  fs.writeFileSync(forwardPath, video.buffer);
  return forwardPath;
}

/* ------------------------------------------------------- steps 5, 6 and 7 */

/**
 * Reverse, cut, truth lock. ffmpeg only. Called by the first build AND by every retune.
 *
 * @param windowStart  null = retune.mjs default, duration - windowLength
 * @param speed        playback rate of the window (rules.json hook_bank playback). 2.5
 *                     plays an 8s build in 3.2s; the truth lock is applied after, at 1x.
 * @returns { reversedPath, cutPath, lockedPath, reversedDuration, windowStart,
 *            windowLength, speed, lockAtS, lockDoneS, frames, durationS }
 */
export async function cutAndLock({
  forwardPath,
  heroPath,
  outDir,
  windowStart = null,
  windowLength = HOOK_WINDOW_S,
  speed = 1,
  frames = rules.job_defaults.truth_lock_frames,
}) {
  const rate = Math.max(0.25, Math.min(4, Number(speed) || 1));
  fs.mkdirSync(outDir, { recursive: true });

  // 5. reverse, fps 30  (v4: -vf "reverse,fps=30" -an)
  const reversedPath = path.join(outDir, "reversed.mp4");
  await sh("ffmpeg", ["-y", "-v", "error", "-i", forwardPath, "-vf", "reverse,fps=30", "-an", reversedPath]);
  const reversedDuration = await videoDuration(reversedPath);

  // 6. the window. The reversed clip ENDS on the real photo, so the default is the tail.
  const len = Math.min(windowLength, reversedDuration);
  let start = windowStart == null ? reversedDuration - len : Number(windowStart);
  start = Math.max(0, Math.min(reversedDuration - len, start));
  const cutPath = path.join(outDir, "hook_cut.mp4");
  await sh("ffmpeg", [
    "-y", "-v", "error",
    "-ss", start.toFixed(3), "-t", len.toFixed(3),
    "-i", reversedPath,
    ...(rate !== 1 ? ["-vf", `setpts=(PTS-STARTPTS)/${rate.toFixed(4)},fps=${FPS}`] : []),
    "-an", "-r", String(FPS),
    cutPath,
  ]);
  const cutDuration = await videoDuration(cutPath);

  // 7. truth lock. CLAUDE.md: "Every hook ends with a crossfade to the untouched hero
  //    photo." No flag, no toggle. NO_TRUTH_LOCK BLOCKs anything under 8 frames.
  const fadeS = frames / FPS;
  const heroHold = path.join(outDir, "hero_hold.mp4");
  await sh("ffmpeg", [
    "-y", "-v", "error",
    "-loop", "1", "-t", (fadeS + TRUTH_LOCK_HOLD_S).toFixed(3), "-i", heroPath,
    "-vf", `scale=${HOOK_W}:${HOOK_H},setsar=1,fps=${FPS},format=yuv420p`,
    "-an", heroHold,
  ]);

  const lockAtS = Math.max(0, cutDuration - fadeS);
  const lockedPath = path.join(outDir, "hook_locked.mp4");
  await sh("ffmpeg", [
    "-y", "-v", "error",
    "-i", cutPath,
    "-i", heroHold,
    "-filter_complex",
    `[0:v]scale=${HOOK_W}:${HOOK_H},setsar=1,fps=${FPS},format=yuv420p[a];` +
      `[1:v]setsar=1,fps=${FPS},format=yuv420p[b];` +
      `[a][b]xfade=transition=fade:duration=${fadeS.toFixed(3)}:offset=${lockAtS.toFixed(3)},format=yuv420p[v]`,
    "-map", "[v]", "-r", String(FPS), "-an",
    lockedPath,
  ]);

  return {
    reversedPath,
    cutPath,
    lockedPath,
    reversedDuration,
    windowStart: start,
    windowLength: len,
    speed: rate,
    lockAtS,
    lockDoneS: lockAtS + fadeS,
    frames,
    durationS: await videoDuration(lockedPath),
  };
}

/* ------------------------------------------------------------------ step 8 */

/** Frames at 33 / 66 / 100 percent. The 100% frame is the true last frame, not a seek. */
export async function extractQaFrames(clipPath, outDir) {
  const duration = await videoDuration(clipPath);
  const files = [];
  for (const [label, frac] of [["33", 0.33], ["66", 0.66]]) {
    const file = path.join(outDir, `qa_${label}.png`);
    await sh("ffmpeg", ["-y", "-v", "error", "-ss", (duration * frac).toFixed(3), "-i", clipPath, "-frames:v", "1", file]);
    files.push(file);
  }
  const last = path.join(outDir, "qa_100.png");
  await sh("ffmpeg", ["-y", "-v", "error", "-sseof", "-0.3", "-i", clipPath, "-update", "1", last]);
  files.push(last);
  return files;
}

export async function runQ2({ jobId, reelN, heroPath, reversedPath, concept, workDir }) {
  const frames = await extractQaFrames(reversedPath, workDir);
  const result = await q2({
    jobId,
    reelN,
    stage: `Q2:${reelN}`,
    referenceB64: b64(heroPath),
    frames: frames.map((f) => b64(f)),
    concept,
    model: config.textModel,
  });
  emit(jobId, "hook", {
    reelN,
    step: "Q2",
    pass: result.pass,
    rejects: result.rejects_found,
    counts: result.counts,
    notes: result.diff_notes,
  });
  return { result, frames };
}
