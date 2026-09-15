/**
 * Veo interior glides. Opt-in with INTERIOR_MOTION=veo; the default is 2.5d.
 *
 * CLAUDE.md used to say interiors are never AI-altered, no override. That rule now has
 * exactly one exception, and every condition of it is enforced here or at export:
 *   - opt-in per deployment (INTERIOR_MOTION=veo) and behind GENERATIVE_ENABLED
 *   - only the hero interiors: one kitchen, one primary room, one living space, max 3
 *   - the REAL photo is the first frame and the prompt locks the architecture; only the
 *     camera may move
 *   - interior Q2 against the source photo. Any wall, door, window or fixture change
 *     rejects the clip and that shot stays 2.5d. No reroll: a second clip is spend.
 *   - every glide segment carries the motion disclosure, and the CTA line says so
 *   - clips are job assets, generated once and reused by every reel. Export never
 *     generates; it only uses an approved clip or the still.
 */
import fs from "node:fs";
import path from "node:path";
import { config, rules } from "../config.js";
import { submitVideo, pollVideo } from "../lib/vertex.js";
import { emit, readJob, writeJob, jobDir, photosDir, outDir } from "../store.js";
import { crop916, videoDuration, sh } from "../hook/crop.js";
import { b64 } from "../hook/paid.js";
import { qaInterior } from "./qa.js";
import { jobFlags, budgetCheck } from "../jobOptions.js";
import { costModel } from "../config.js";

const SPEC = rules.interior_motion;

export const glideDir = (jobId, photoId) => path.join(jobDir(jobId), "interiors", photoId);

const scoreOf = (a) => (a.scores?.sharpness ?? 0) * (a.scores?.exposure ?? 0) * (a.scores?.composition ?? 0);

/**
 * The hero interiors: for each rules.json interior_motion.hero_categories entry, the
 * best-scoring photo of that class that the reels actually use. Pure.
 */
export function selectHeroInteriors(job, max = jobFlags(job).heroRooms ?? SPEC.max_hero_interiors) {
  const assets = job.nodes.B0?.payload?.assets || [];
  const excluded = new Set((job.dedupe?.dropped || []).map((d) => d.photo_id));
  const used = new Set(
    (job.recipes || []).flatMap((r) => r.segments.filter((s) => s.kind === "interior").map((s) => s.source?.photoId ?? s.source?.id)),
  );
  const picked = [];
  for (const cat of SPEC.hero_categories) {
    if (picked.length >= max) break;
    const candidates = assets
      .filter((a) => cat.room_classes.includes(a.room_class) && used.has(a.photo_id) && !excluded.has(a.photo_id))
      .filter((a) => !picked.some((p) => p.photo_id === a.photo_id))
      // primary_bedroom before bedroom, then score
      .sort((a, b) => cat.room_classes.indexOf(a.room_class) - cat.room_classes.indexOf(b.room_class) || scoreOf(b) - scoreOf(a));
    if (candidates[0]) {
      picked.push({ photo_id: candidates[0].photo_id, category: cat.name, room_class: candidates[0].room_class, score: Number(scoreOf(candidates[0]).toFixed(3)) });
    }
  }
  return picked;
}

/** cost-model.json interior_motion, priced per clip. */
export function glideEstimate(count, costModel) {
  const v = costModel.providers.vertex;
  const spec = costModel.interior_motion;
  const clipUsd = v[spec.clip.model].usd_per_s * spec.clip.duration_s;
  const q2Usd = (spec.q2.in_tokens / 1e6) * v[spec.q2.model].usd_per_m_input + (spec.q2.out_tokens / 1e6) * v[spec.q2.model].usd_per_m_output;
  const perUsd = clipUsd + q2Usd;
  return {
    per_clip_usd: Number(perUsd.toFixed(4)),
    per_clip_inr: Number((perUsd * costModel.fx.usd_inr).toFixed(2)),
    count,
    total_usd: Number((perUsd * count).toFixed(3)),
    total_inr: Number((perUsd * count * costModel.fx.usd_inr).toFixed(2)),
  };
}

/**
 * Generate glides for the hero interiors that do not have a verdict yet. An approved or
 * QA-rejected clip is final and never regenerated; a "failed" record is an infrastructure
 * failure with no clip and no spend (a Vertex 429), so it gets its one attempt.
 */
export async function buildGlides(jobId, { photoIds = null } = {}) {
  const job = readJob(jobId);
  const flags = jobFlags(job);
  if (flags.interiorMotion !== "veo") {
    throw Object.assign(new Error("this job runs interiors in 2.5d; no glides"), { status: 409 });
  }
  if (!config.generativeEnabled || !flags.generative) {
    throw Object.assign(new Error("generative is off for this job"), { status: 409 });
  }
  const heroes = selectHeroInteriors(job).filter((h) => !photoIds || photoIds.includes(h.photo_id));
  const final = (rec) => rec && !["failed", "skipped"].includes(rec.status);
  const todo = heroes.filter((h) => !final(job.interior_clips?.[h.photo_id]));
  for (const h of heroes.filter((x) => final(job.interior_clips?.[x.photo_id]))) {
    emit(jobId, "interior", { photoId: h.photo_id, step: "reused", status: job.interior_clips[h.photo_id].status });
  }
  /* One at a time. Three concurrent submits hit Vertex's per-base-model quota for
     long-running requests (429) on 2026-09-10; the third clip never ran. */
  const out = [];
  const perClipUsd = glideEstimate(1, costModel).total_usd;
  for (const h of todo) {
    const budget = budgetCheck(readJob(jobId), perClipUsd);
    if (!budget.ok) {
      out.push(saveGlide(jobId, h.photo_id, { ...h, status: "skipped", reason: budget.reason, fallback: "2.5d" }));
      continue;
    }
    out.push(
      await buildOne(jobId, h).catch((err) =>
        saveGlide(jobId, h.photo_id, { ...h, status: "failed", reason: err.message.slice(0, 400), fallback: "2.5d" }),
      ),
    );
  }
  return out;
}

async function buildOne(jobId, hero) {
  const job = readJob(jobId);
  const photo = job.photos.find((p) => p.id === hero.photo_id);
  const shot = job.nodes.B5?.payload?.shots?.find((s) => s.photo_id === hero.photo_id);
  const dir = glideDir(jobId, hero.photo_id);
  fs.mkdirSync(dir, { recursive: true });
  const ledgerFrom = job.ledger.length;

  // crop 9:16 before any model call (rules.json render_constraints.crop_before_generate)
  const src = path.join(dir, "source_916.png");
  const xCenter = shot?.crop_9x16?.x_center ?? 0.5;
  await crop916(path.join(photosDir(jobId), photo.storedName), src, xCenter);

  const submit = await submitVideo({
    jobId,
    stage: `IM:${hero.photo_id}`,
    prompt: SPEC.prompt,
    image: { mimeType: "image/png", data: b64(src) }, // FIRST frame: the real room
    aspectRatio: "9:16",
    durationSeconds: SPEC.clip_seconds,
    resolution: "720p",
    generateAudio: false,
    personGeneration: "dont_allow",
  });
  emit(jobId, "interior", { photoId: hero.photo_id, step: "submitted", op: submit.operationName.split("/").pop() });
  const { video } = await pollVideo({
    operationName: submit.operationName,
    jobId,
    stage: `IM:${hero.photo_id}`,
    durationSeconds: submit.durationSeconds,
  });
  if (!video.buffer) throw new Error(`Veo returned a gcsUri (${video.gcsUri}); no bucket wiring`);
  const clip = path.join(dir, "glide.mp4");
  fs.writeFileSync(clip, video.buffer);

  // Q2 on 33/66/100 against the source crop
  const duration = await videoDuration(clip);
  const frames = [];
  for (const [label, frac] of [["33", 0.33], ["66", 0.66]]) {
    const f = path.join(dir, `qa_${label}.png`);
    await sh("ffmpeg", ["-y", "-v", "error", "-ss", (duration * frac).toFixed(3), "-i", clip, "-frames:v", "1", f]);
    frames.push(f);
  }
  const last = path.join(dir, "qa_100.png");
  await sh("ffmpeg", ["-y", "-v", "error", "-sseof", "-0.3", "-i", clip, "-update", "1", last]);
  frames.push(last);

  const q2 = await qaInterior({
    jobId,
    stage: `IQ2:${hero.photo_id}`,
    roomClass: hero.room_class,
    referenceB64: b64(src),
    frames: frames.map(b64),
  });

  /* By stage, not by position: a hook generating at the same time writes rows into the
     same window, and a slice billed this clip for another reel's Veo call. */
  const after = readJob(jobId);
  const rows = after.ledger.slice(ledgerFrom).filter((r) => r.stage === `IM:${hero.photo_id}` || r.stage === `IQ2:${hero.photo_id}`);
  return saveGlide(jobId, hero.photo_id, {
    ...hero,
    status: q2.pass ? "approved" : "rejected",
    reason: q2.pass ? null : `interior Q2: ${q2.rejects_found.join("; ")}`,
    fallback: q2.pass ? null : "2.5d",
    source_path: src,
    clip_path: clip,
    clip_duration_s: duration,
    x_center: xCenter,
    qa_frames: frames,
    q2,
    prompt: SPEC.prompt,
    cost: {
      inr: Number(rows.reduce((s, r) => s + (r.cost_inr || 0), 0).toFixed(3)),
      rows: rows.map((r) => ({ stage: r.stage, model: r.provider_model, cost_inr: r.cost_inr })),
    },
  });
}

function saveGlide(jobId, photoId, record) {
  const dest = outDir(jobId);
  fs.mkdirSync(dest, { recursive: true });
  const publish = (p) => {
    if (!p || !fs.existsSync(p)) return null;
    const name = `glide-${photoId}_${path.basename(p)}`;
    fs.copyFileSync(p, path.join(dest, name));
    return name;
  };
  const full = {
    ...record,
    photo_id: photoId,
    clip_file: publish(record.clip_path),
    qa_files: (record.qa_frames || []).map(publish),
    created_at: new Date().toISOString(),
  };
  const job = readJob(jobId);
  job.interior_clips = job.interior_clips || {};
  job.interior_clips[photoId] = full;
  writeJob(job);
  emit(jobId, "interior", { photoId, step: "saved", status: full.status, reason: full.reason, costInr: full.cost?.inr ?? 0 });
  return full;
}
