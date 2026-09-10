/**
 * Free hooks. ffmpeg only, zero model calls, zero cost.
 *
 * These are the fallback when a paid hook fails QA twice, and the default for two of
 * the three reels in a job. They still end on the untouched hero framing, because the
 * truth lock is not a property of the paid path — it is a property of every hook.
 * export.js measures it: SSIM of the hook's last frame against the hero.
 *
 *   blueprint_to_photo  Sobel edges revealed under an expanding mask, dissolving to
 *                       the photograph.
 *   sky_drop            the hero over a sky gradient, ease-zoom down into the lot.
 *   paper_popup_room    a white paper fold that opens onto the room.
 */
import fs from "node:fs";
import path from "node:path";
import { rules } from "../config.js";
import { emit } from "../store.js";
import { crop916, sh, HOOK_W, HOOK_H } from "./crop.js";

const FPS = 30;

/**
 * @returns { path, durationS, concept, cost: 0 }
 */
export async function renderFreeHook({
  jobId,
  reelN,
  conceptId,
  sourcePhotoPath,
  workDir,
  xCenter = 0.5,
  durationS = rules.job_defaults.hook_usable_s,
}) {
  fs.mkdirSync(workDir, { recursive: true });
  const hero = path.join(workDir, "hero_916.png");
  // Always re-crop: a crop edited on the B4 card must not reuse yesterday's hero.
  await crop916(sourcePhotoPath, hero, xCenter);

  const out = path.join(workDir, `free_${conceptId}.mp4`);
  const frames = Math.round(durationS * FPS);

  switch (conceptId) {
    case "sky_drop":
      await skyDrop(hero, out, frames, durationS);
      break;
    case "paper_popup_room":
      await paperPopup(hero, out, frames, durationS);
      break;
    case "blueprint_to_photo":
    default:
      await blueprintToPhoto(hero, out, frames, durationS);
      break;
  }

  emit(jobId, "hook", {
    reelN,
    step: "free_hook",
    concept: conceptId,
    durationS,
    costInr: 0,
  });

  return { path: out, heroPath: hero, durationS, conceptId, costInr: 0 };
}

/**
 * Sobel edges under an expanding mask.
 *
 * Two copies of the hero: an edge-detected "blueprint" plate and the photograph. A
 * horizontal wipe moves left to right, and the whole thing cross-dissolves to the
 * untouched photo in the last third — so the truth lock is built into the concept.
 */
async function blueprintToPhoto(hero, out, frames, durationS) {
  const wipe = durationS * 0.62;
  await sh("ffmpeg", [
    "-y", "-v", "error",
    "-loop", "1", "-t", String(durationS), "-i", hero,
    "-filter_complex",
    [
      // blueprint plate: edges, inverted, tinted to drafting ink on paper
      `[0:v]format=gray,sobel,negate,eq=contrast=1.8:brightness=0.06,` +
        `colorchannelmixer=rr=0.82:gg=0.86:bb=1.0,format=yuv420p,fps=${FPS}[blue]`,
      // Pull from 1.06 to exactly 1.0: the last frame is the untouched hero framing.
      `[0:v]format=yuv420p,fps=${FPS},zoompan=z='max(1.06-0.06*on/${frames - 1},1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${HOOK_W}x${HOOK_H}:fps=${FPS}[photo]`,
      // the wipe: photo revealed left to right over the blueprint
      `[blue][photo]xfade=transition=wiperight:duration=${wipe.toFixed(3)}:offset=0,format=yuv420p[v]`,
    ].join(";"),
    "-map", "[v]",
    "-frames:v", String(frames),
    "-r", String(FPS),
    "-an", out,
  ]);
}

/**
 * The hero over a sky gradient, easing down into the lot.
 *
 * A pale sky plate sits behind; the photograph starts small and high and settles into
 * frame. No model call, and nothing about the building is altered — it is the same
 * pixels, moved.
 */
async function skyDrop(hero, out, frames, durationS) {
  /* ffmpeg cannot animate `scale`, so the drop is a zoompan over a PADDED canvas:
     the hero sits small in the middle of a sky-coloured frame, and the camera pushes
     in until the photograph fills the frame. The first attempt overlaid a full-size
     photo on the sky, which simply hid the sky and rendered as a still. */
  const pad = 2.2; // canvas is 2.2x the hero, so the hero starts at ~45% of frame
  const canvasW = Math.round((HOOK_W * pad) / 2) * 2;
  const canvasH = Math.round((HOOK_H * pad) / 2) * 2;

  await sh("ffmpeg", [
    "-y", "-v", "error",
    "-loop", "1", "-t", String(durationS), "-i", hero,
    "-filter_complex",
    [
      // sky plate with a soft vertical gradient, the size of the padded canvas
      `color=c=0x9fc7e8:s=${canvasW}x${canvasH}:r=${FPS}:d=${durationS},` +
        `geq=r='150+46*(Y/H)':g='194+40*(Y/H)':b='230+22*(Y/H)'[sky]`,
      // the lot outline: a soft light rectangle where the building will land
      `[sky]drawbox=x=${Math.round((canvasW - HOOK_W) / 2) - 26}:y=${Math.round((canvasH - HOOK_H) / 2) - 26}:` +
        `w=${HOOK_W + 52}:h=${HOOK_H + 52}:color=white@0.35:t=6[lot]`,
      `[0:v]fps=${FPS},setsar=1[photo]`,
      // hero centred on the sky canvas
      `[lot][photo]overlay=(W-w)/2:(H-h)/2,format=yuv420p[padded]`,
      // push in from the whole canvas to just the hero, drifting down as it lands
      // Reaches exactly `pad` (hero fills the frame) on the LAST frame, not one after it.
      `[padded]zoompan=z='min(1+(on/${frames - 1})*${(pad - 1).toFixed(3)},${pad})':` +
        `x='iw/2-(iw/zoom/2)':` +
        `y='ih/2-(ih/zoom/2)-(max(0,1-on/${frames - 1})*90)':` +
        `d=${frames}:s=${HOOK_W}x${HOOK_H}:fps=${FPS},format=yuv420p[v]`,
    ].join(";"),
    "-map", "[v]",
    "-frames:v", String(frames),
    "-r", String(FPS),
    "-an", out,
  ]);
}

/**
 * Paper pop-up: a white fold opens onto the room.
 *
 * Implemented as a vertical open from the centre — the paper plate is the hero
 * flattened to white, and the photograph is revealed as the fold opens.
 */
async function paperPopup(hero, out, frames, durationS) {
  const open = durationS * 0.55;
  await sh("ffmpeg", [
    "-y", "-v", "error",
    "-loop", "1", "-t", String(durationS), "-i", hero,
    "-filter_complex",
    [
      // the paper: the hero crushed to a cream sheet with a soft fold line
      `[0:v]format=gray,eq=contrast=0.15:brightness=0.62,` +
        `colorchannelmixer=rr=1.0:gg=0.99:bb=0.95,format=yuv420p,fps=${FPS}[paper]`,
      `[0:v]format=yuv420p,fps=${FPS},zoompan=z='max(1.07-0.07*on/${frames - 1},1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${HOOK_W}x${HOOK_H}:fps=${FPS}[photo]`,
      `[paper][photo]xfade=transition=vertopen:duration=${open.toFixed(3)}:offset=0,format=yuv420p[v]`,
    ].join(";"),
    "-map", "[v]",
    "-frames:v", String(frames),
    "-r", String(FPS),
    "-an", out,
  ]);
}

export const FREE_CONCEPTS = ["blueprint_to_photo", "sky_drop", "paper_popup_room"];
