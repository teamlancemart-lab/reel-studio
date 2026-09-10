/**
 * Crop to 9:16 BEFORE any model call.
 *
 * Ported from docs/hook-v4.mjs crop916(). rules.json render_constraints.crop_before_generate:
 * a 16:9 still sent to a 9:16 endpoint gets letterboxed and ~40 percent of the paid
 * pixels are black bars. The hero is portrait before Vertex ever sees it.
 *
 * xCenter comes from B0's safe_crop_9x16, so the crop keeps whatever the classifier
 * decided was the important part of the frame.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const HOOK_W = 720;
export const HOOK_H = 1280;

async function probe(file, entry) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", `stream=${entry}`,
    "-of", "csv=p=0",
    file,
  ]);
  return parseFloat(stdout.trim());
}

/**
 * @param src      source photo path
 * @param out      destination png
 * @param xCenter  0..1 from B0 safe_crop_9x16.x_center
 */
export async function crop916(src, out, xCenter = 0.5) {
  const w = await probe(src, "width");
  const h = await probe(src, "height");

  let cw = Math.min(w, Math.round((h * 9) / 16));
  cw -= cw % 2;
  // xCenter is the CENTRE of the window; the crop origin is half a width to its left.
  let cx = Math.round(xCenter * w - cw / 2);
  cx = Math.max(0, Math.min(w - cw, cx));
  cx -= cx % 2;

  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", src,
    "-vf", `crop=${cw}:${h}:${cx}:0,scale=${HOOK_W}:${HOOK_H}`,
    out,
  ]);
  return { src: { width: w, height: h }, crop: { width: cw, x: cx }, out };
}

export async function videoDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ]);
  return parseFloat(stdout.trim());
}

export const sh = (bin, args) => run(bin, args, { maxBuffer: 1 << 24 });
