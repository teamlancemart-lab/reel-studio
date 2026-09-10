/**
 * Image prep for vision calls.
 *
 * B0 sends 5 photos per call at 512px. That is the cheap-first rule applied to the
 * cheapest layer there is: a 512px JPEG is ~258 image tokens on Gemini, so a 29-photo
 * job classifies for a few rupees instead of a few hundred.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Longest edge 512, JPEG q4, returned as base64. */
export async function to512Base64(filePath, tmpDir) {
  const out = path.join(tmpDir, `${path.basename(filePath, path.extname(filePath))}.512.jpg`);
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", filePath,
    "-vf", "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'",
    "-q:v", "4",
    out,
  ]);
  const data = fs.readFileSync(out).toString("base64");
  return { data, mimeType: "image/jpeg", path: out };
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
