/**
 * ffprobe / ffmpeg helpers. D1 uses dimensions only; D3 grows this into the renderer.
 *
 * Everything shells out rather than pulling in a native image library: the container
 * already has ffmpeg for the render path, and one dependency is better than two.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const run = promisify(execFile);

export async function probeImage(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    filePath,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`ffprobe returned no usable dimensions: "${stdout.trim()}"`);
  }
  return { width: w, height: h };
}

export async function ffmpegVersion() {
  try {
    const { stdout } = await run("ffmpeg", ["-version"]);
    const line = stdout.split("\n")[0];
    return {
      ok: true,
      version: line,
      /* Homebrew ffmpeg 9.0.1 ships without freetype; the container build may not.
         Either way overlays are Pillow PNG sequences, never drawtext. This is
         reported so the assumption is visible rather than assumed. */
      hasDrawtext: /--enable-libfreetype/.test(stdout),
    };
  } catch (err) {
    return { ok: false, error: err.message.slice(0, 200) };
  }
}

export async function pythonStatus() {
  try {
    const { stdout } = await run(config.pythonBin, [
      "-c",
      "import PIL, sys; print(sys.version.split()[0], PIL.__version__)",
    ]);
    const [python, pillow] = stdout.trim().split(" ");
    return { ok: true, bin: config.pythonBin, python, pillow };
  } catch (err) {
    return { ok: false, bin: config.pythonBin, error: err.message.slice(0, 200) };
  }
}

export function fontStatus() {
  const want = [
    "Inter-Variable.ttf",
    "PlayfairDisplay-Variable.ttf",
    "GreatVibes-Regular.ttf",
  ];
  const present = want.filter((f) =>
    fs.existsSync(path.join(config.fontsDir, f)),
  );
  return {
    ok: present.length === want.length,
    dir: config.fontsDir,
    present,
    missing: want.filter((f) => !present.includes(f)),
  };
}
