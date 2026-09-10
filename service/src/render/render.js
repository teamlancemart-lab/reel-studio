/**
 * renderReel(recipe) -> 1080x1920 H.264 30fps mp4.
 *
 * The second interpreter of the ReelRecipe. The browser canvas in web/src/lib/draw.ts
 * is the first, and the two share their constants through rules.json: the same crop
 * maths, the same motion amplitudes, the same safe zone, the same two type systems.
 *
 * Overlays are Pillow PNGs composited with the overlay filter. Never drawtext:
 * rules.json render_constraints.no_drawtext, and this ffmpeg genuinely lacks freetype.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rules } from "../config.js";
import { emit, readJob, outDir } from "../store.js";
import { renderOverlays } from "./overlays.js";

const run = promisify(execFile);
const sh = (args) => run("ffmpeg", ["-y", "-v", "error", ...args], { maxBuffer: 1 << 24 });

const FPS = rules.job_defaults.fps;
const MASTER = rules.job_defaults.master_size_9x16.split("x").map(Number);
const [MW, MH] = MASTER;

/** A cut is rendered as a one-frame dissolve so the whole chain is one xfade graph. */
const MIN_XFADE = 1 / FPS;

const TRANSITION_S = {
  cut: MIN_XFADE,
  crossfade: 0.45,
  zoom_through: 0.4,
  whip_blur: 0.25,
  light_leak: 0.5,
};

/** rules.json transitions -> xfade transition names. */
const XFADE_NAME = {
  cut: "fade",
  crossfade: "fade",
  zoom_through: "zoomin",
  whip_blur: "hblur",
  light_leak: "fadewhite",
};

/* ------------------------------------------------------------------ crop */

/**
 * Source rectangle for a crop, identical semantics to web/src/lib/draw.ts sourceRect
 * at zoom 1: centre plus width as source fractions, height from the OUTPUT aspect.
 */
function cropRect(srcW, srcH, crop, outAspect) {
  let sw = srcW * (crop.widthFrac || 1);
  let sh = sw / outAspect;
  if (sh > srcH) {
    sh = srcH;
    sw = sh * outAspect;
  }
  let sx = crop.xCenter * srcW - sw / 2;
  let sy = crop.yCenter * srcH - sh / 2;
  sx = Math.max(0, Math.min(srcW - sw, sx));
  sy = Math.max(0, Math.min(srcH - sh, sy));
  const even = (n) => Math.max(2, Math.round(n) - (Math.round(n) % 2));
  return { x: Math.round(sx), y: Math.round(sy), w: even(sw), h: even(sh) };
}

async function probeSize(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    file,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  return { width: w, height: h };
}

/* --------------------------------------------------------------- segments */

/**
 * One segment -> one mp4 at MW x MH, `duration` long.
 * The motion amplitudes are the same numbers as motionAt() in draw.ts.
 */
async function renderSegment({ seg, duration, sourcePath, out, hookPath, hookStartS = 0 }) {
  const frames = Math.max(1, Math.round(duration * FPS));

  // The hook segment is a video, not a photo.
  if (seg.kind === "hook" && hookPath) {
    await sh([
      ...(hookStartS > 0 ? ["-ss", hookStartS.toFixed(3)] : []),
      "-i", hookPath,
      "-vf",
      `scale=${MW}:${MH}:force_original_aspect_ratio=increase,crop=${MW}:${MH},fps=${FPS},format=yuv420p`,
      "-t", String(duration),
      "-an", "-r", String(FPS),
      out,
    ]);
    // A short hook still has to fill its slot; pad by holding the last frame.
    const have = await probeDuration(out);
    if (have < duration - 0.05) {
      const padded = out.replace(/\.mp4$/, "_pad.mp4");
      await sh([
        "-i", out,
        "-vf", `tpad=stop_mode=clone:stop_duration=${(duration - have).toFixed(3)},fps=${FPS},format=yuv420p`,
        "-t", String(duration),
        "-an", "-r", String(FPS),
        padded,
      ]);
      fs.renameSync(padded, out);
    }
    return out;
  }

  // The CTA is a card, not a photo.
  if (seg.kind === "cta" || !sourcePath) {
    await sh([
      "-f", "lavfi",
      "-i", `color=c=0x132038:s=${MW}x${MH}:r=${FPS}:d=${duration}`,
      "-vf",
      `drawbox=x=${Math.round(MW * 0.06)}:y=${Math.round(MH * 0.06)}:w=${Math.round(MW * 0.88)}:h=${Math.round(MH * 0.88)}:color=0xf5b301@0.75:t=3,format=yuv420p`,
      "-frames:v", String(frames),
      "-an", "-r", String(FPS),
      out,
    ]);
    return out;
  }

  const { width, height } = await probeSize(sourcePath);
  const r = cropRect(width, height, seg.crop, MW / MH);
  const base = `crop=${r.w}:${r.h}:${r.x}:${r.y}`;

  if (seg.motion === "self_draw") {
    await renderSelfDraw({ sourcePath, out, duration, frames });
    return out;
  }

  if (seg.motion === "parallax_lr") {
    /* Two-layer fake parallax, the same construction the canvas draws: a blurred,
       wider copy behind and the sharp plate in front, moving the other way. */
    const inset = Math.round(MW * 0.06);
    await sh([
      "-loop", "1", "-t", String(duration), "-i", sourcePath,
      "-filter_complex",
      [
        `[0:v]${base},scale=${Math.round(MW * 1.22)}:-2,crop=${MW}:${MH},gblur=sigma=18,fps=${FPS}[bg]`,
        `[0:v]${base},scale=${MW - inset * 2}:${MH - inset * 2},fps=${FPS}[fg]`,
        `[bg][fg]overlay=x='${inset}+(${Math.round(MW * 0.02)}*(t/${duration}-0.5))':y=${inset},format=yuv420p[v]`,
      ].join(";"),
      "-map", "[v]",
      "-frames:v", String(frames),
      "-an", "-r", String(FPS),
      out,
    ]);
    return out;
  }

  const zoom = {
    push: `min(1+(on/${frames})*0.12,1.12)`,
    pull: `max(1.12-(on/${frames})*0.12,1.0)`,
    pan_l: "1.08",
    pan_r: "1.08",
    static: "1.0",
  }[seg.motion] ?? "1.0";

  const x =
    seg.motion === "pan_l"
      ? `(iw-iw/zoom)*(1-on/${frames})`
      : seg.motion === "pan_r"
        ? `(iw-iw/zoom)*(on/${frames})`
        : "iw/2-(iw/zoom/2)";

  await sh([
    "-loop", "1", "-t", String(duration), "-i", sourcePath,
    "-vf",
    `${base},scale=${MW * 2}:-2,` +
      `zoompan=z='${zoom}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${MW}x${MH}:fps=${FPS},` +
      `format=yuv420p`,
    "-frames:v", String(frames),
    "-an", "-r", String(FPS),
    out,
  ]);
  return out;
}

/**
 * Floor plan self-draw: threshold the plan to a stroke plate, wipe it on, then
 * cross-dissolve to the filled plan. D1's canvas approximates the same timing.
 */
async function renderSelfDraw({ sourcePath, out, duration, frames }) {
  const strokeS = duration * 0.6;
  const fillS = Math.max(0.3, duration * 0.3);
  const planW = Math.round(MW * 0.86);
  const planH = Math.round(MH * 0.62);

  /* Two xfades, both fed from a SPLIT of the fitted plan. The first version reused the
     [plan] label in two places, which ffmpeg resolves by handing the second consumer
     the raw 4000x3000 input, and xfade refused the size mismatch. crop with eval=frame
     would have been simpler but this build has no such option. */
  await sh([
    "-loop", "1", "-t", String(duration), "-i", sourcePath,
    "-filter_complex",
    [
      `color=c=0xf4f1ea:s=${MW}x${MH}:r=${FPS}:d=${duration}[paper]`,
      `[0:v]scale=${planW}:${planH}:force_original_aspect_ratio=decrease,` +
        `pad=${MW}:${MH}:(ow-iw)/2:(oh-ih)/2:0xf4f1ea,fps=${FPS},format=yuv420p,split=2[plan_a][plan_b]`,
      /* ink plate: the plan thresholded to strokes, MULTIPLIED onto the paper so white
         stays paper and only the lines darken. The first version tinted the whole plate
         with colorchannelmixer, which turned the white background navy too, and the
         "stroke reveal" wiped a solid navy slab across the frame. */
      `[plan_a]format=gray,eq=contrast=2.4:brightness=-0.10,format=gbrp[ink_g]`,
      `color=c=0xf4f1ea:s=${MW}x${MH}:r=${FPS}:d=${duration},format=gbrp[paper_m]`,
      `[ink_g][paper_m]blend=all_mode=multiply:shortest=1,format=yuv420p[ink]`,
      // stroke on, left to right
      `[paper][ink]xfade=transition=wiperight:duration=${strokeS.toFixed(3)}:offset=0[drawn]`,
      // then fill: dissolve to the untouched plan, completing exactly at the end
      `[drawn][plan_b]xfade=transition=fade:duration=${fillS.toFixed(3)}:` +
        `offset=${(duration - fillS).toFixed(3)},format=yuv420p[v]`,
    ].join(";"),
    "-map", "[v]",
    "-frames:v", String(frames),
    "-an", "-r", String(FPS),
    out,
  ]);
}

async function probeDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  return parseFloat(stdout.trim()) || 0;
}

/* ----------------------------------------------------------------- assemble */

/**
 * @param recipe    ReelRecipe
 * @param opts.hookPath   the hook clip for this reel
 * @param opts.photoPath  (photoId) => absolute path
 * @param opts.workDir
 * @param opts.outPath
 * @param opts.audioPath  optional licensed track
 * @returns { path, silentPath, durationS, segments, overlays, ffmpegPlanHash }
 */
export async function renderReel(recipe, opts) {
  const {
    hookPath = null,
    hookStartS = 0,
    photoPath,
    workDir,
    outPath,
    audioPath = null,
    jobId = null,
    /* Photo segments depend only on their own inputs, so a retune that changes the hook
       window re-renders the hook segment and the assembly, not eleven Ken Burns moves. */
    segmentCacheDir = null,
  } = opts;
  fs.mkdirSync(workDir, { recursive: true });

  const segDir = path.join(workDir, "segments");
  fs.mkdirSync(segDir, { recursive: true });

  /* Each segment after the first is rendered LONGER by its transition duration, so
     the xfade chain consumes the overlap and the finished reel is exactly
     recipe.durationS.

     Plus TAIL_S on every segment. xfade gives up on a transition whose offset+duration
     reaches the end of its first input: it passes that input through and silently
     discards EVERY later segment. With offsets rounded to 4 decimals a one-frame cut
     landed exactly on the boundary (1.9667 + 0.0333 = 2.0000) and a 22.8s reel came out
     4.5s long. The tail never shows: the next xfade replaces it, and the last segment's
     tail is trimmed by -t. */
  const TAIL_S = 2 / FPS;
  const plan = recipe.segments.map((seg, i) => {
    const td = i === 0 ? 0 : (TRANSITION_S[seg.transitionIn] ?? MIN_XFADE);
    return { seg, i, base: seg.tOut - seg.tIn, td, duration: seg.tOut - seg.tIn + td + TAIL_S };
  });

  const files = [];
  let cacheHits = 0;
  for (const p of plan) {
    const out = path.join(segDir, `seg_${String(p.i).padStart(2, "0")}.mp4`);
    const sourcePath = p.seg.source.id ? photoPath(p.seg.source.id) : null;
    const isHook = p.seg.kind === "hook" && hookPath;

    let cached = null;
    if (segmentCacheDir && !isHook) {
      const { overlays: _o, ...segNoOverlays } = p.seg;
      const key = crypto
        .createHash("sha1")
        .update(JSON.stringify({ seg: segNoOverlays, d: p.duration.toFixed(4), src: sourcePath, MW, MH, FPS }))
        .digest("hex")
        .slice(0, 16);
      cached = path.join(segmentCacheDir, `${key}.mp4`);
    }

    const hit = Boolean(cached && fs.existsSync(cached));
    if (hit) {
      fs.copyFileSync(cached, out);
      cacheHits += 1;
    } else {
      await renderSegment({ seg: p.seg, duration: p.duration, sourcePath, out, hookPath, hookStartS });
      if (cached) {
        fs.mkdirSync(segmentCacheDir, { recursive: true });
        fs.copyFileSync(out, cached);
      }
    }
    files.push(out);
    if (jobId) {
      emit(jobId, "render", {
        reelId: recipe.reelId,
        step: "segment",
        index: p.i,
        kind: p.seg.kind,
        motion: p.seg.motion,
        cached: hit,
        durationS: Number(p.duration.toFixed(3)),
      });
    }
  }

  // ---- xfade chain
  const inputs = files.flatMap((f) => ["-i", f]);
  const chain = [];
  let last = "[0:v]";
  let offset = plan[0].base;
  for (let i = 1; i < plan.length; i++) {
    const p = plan[i];
    const label = i === plan.length - 1 ? "[vchain]" : `[x${i}]`;
    chain.push(
      `${last}[${i}:v]xfade=transition=${XFADE_NAME[p.seg.transitionIn] ?? "fade"}:` +
        `duration=${p.td.toFixed(6)}:offset=${(offset - p.td).toFixed(6)}${label}`,
    );
    last = label;
    offset += p.base;
  }
  if (plan.length === 1) chain.push(`[0:v]null[vchain]`);

  // ---- overlays
  const overlayDir = path.join(workDir, "overlays");
  const overlays = await renderOverlays(recipe, overlayDir, { width: MW, height: MH });
  const overlayInputs = overlays.flatMap((o) => ["-loop", "1", "-i", o.path]);

  let vlabel = "[vchain]";
  overlays.forEach((o, k) => {
    const idx = files.length + k;
    const inLabel = `[ov${k}]`;
    const outLabel = k === overlays.length - 1 ? "[vout]" : `[c${k}]`;
    const fade = Math.min(o.fadeS ?? 0.35, Math.max(0.05, (o.tOut - o.tIn) / 2));
    chain.push(
      `[${idx}:v]format=rgba,fade=t=in:st=${o.tIn.toFixed(3)}:d=${fade.toFixed(3)}:alpha=1,` +
        `fade=t=out:st=${(o.tOut - fade).toFixed(3)}:d=${fade.toFixed(3)}:alpha=1,` +
        `setpts=PTS-STARTPTS${inLabel}`,
      `${vlabel}${inLabel}overlay=0:0:enable='between(t,${o.tIn.toFixed(3)},${o.tOut.toFixed(3)})'${outLabel}`,
    );
    vlabel = outLabel;
  });
  if (overlays.length === 0) chain.push(`[vchain]null[vout]`);
  /* Photo segments decode as full-range yuvj420p and the master inherited it. Delivery
     is limited-range yuv420p, which is what every platform expects. */
  chain.push(`[vout]scale=in_range=auto:out_range=tv,format=yuv420p[vmaster]`);

  const silentPath = outPath.replace(/\.mp4$/, "_silent.mp4");
  const common = [
    ...inputs,
    ...overlayInputs,
    "-filter_complex", chain.join(";"),
    "-map", "[vmaster]",
    "-t", String(recipe.durationS),
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-color_range", "tv",
    "-movflags", "+faststart",
  ];

  await sh([...common, "-an", silentPath]);

  let finalPath = silentPath;
  let audioNote = null;
  if (audioPath && fs.existsSync(audioPath)) {
    await sh([
      "-i", silentPath,
      "-i", audioPath,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "160k",
      "-shortest",
      "-af", `afade=t=out:st=${Math.max(0, recipe.durationS - 1.2).toFixed(2)}:d=1.2`,
      outPath,
    ]);
    finalPath = outPath;
  } else {
    /* No audio file for this track. tracks.json is a placeholder library with beat
       grids but no licensed media, and rules.json MUSIC_UNLICENSED already WARNs on
       it. The master ships silent rather than with something unlicensed. */
    fs.copyFileSync(silentPath, outPath);
    finalPath = outPath;
    audioNote = `no audio file for track "${recipe.audio.trackId}"; master is silent`;
  }

  const durationS = await probeDuration(finalPath);
  return {
    path: finalPath,
    silentPath,
    durationS,
    segments: plan.length,
    segmentCacheHits: cacheHits,
    overlays: overlays.length,
    overlayBoxes: overlays.map(({ path: _p, ...o }) => o),
    audioNote,
    ffmpegPlanHash: hashPlan(chain),
  };
}

function hashPlan(chain) {
  let h = 0;
  const s = chain.join("|");
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export { cropRect, TRANSITION_S, probeDuration };
