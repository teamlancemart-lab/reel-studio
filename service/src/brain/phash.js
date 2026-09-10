/**
 * Perceptual hash, computed on upload.
 *
 * DCT pHash: 32x32 greyscale, 2D DCT-II, keep the top-left 8x8 low-frequency block
 * minus the DC term, threshold at the median. Two photos of the same room from almost
 * the same spot land within a few bits of each other; two different rooms do not.
 *
 * The dedupe pass uses hamming < 6 (D2 spec), then falls back to identical dedupe_key
 * from B0 for the cases a hash cannot catch — same room, different angle.
 *
 * ffmpeg does the decode so there is no second image library in the container.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const N = 32;
const KEEP = 8;

/** Precomputed DCT-II basis: cos((2x+1) u pi / 2N). */
const COS = (() => {
  const t = new Float64Array(N * N);
  for (let x = 0; x < N; x++) {
    for (let u = 0; u < N; u++) {
      t[x * N + u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
  }
  return t;
})();

function dct2(pixels) {
  // Rows, then columns. Only the first KEEP coefficients of each axis are needed.
  const rows = new Float64Array(N * KEEP);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < KEEP; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += pixels[y * N + x] * COS[x * N + u];
      rows[y * KEEP + u] = s;
    }
  }
  const out = new Float64Array(KEEP * KEEP);
  for (let u = 0; u < KEEP; u++) {
    for (let v = 0; v < KEEP; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[y * KEEP + u] * COS[y * N + v];
      out[v * KEEP + u] = s;
    }
  }
  return out;
}

/** 64-bit hash as 16 hex characters. */
export async function phash(filePath) {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v", "error",
      "-i", filePath,
      "-vf", `scale=${N}:${N}:flags=area,format=gray`,
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "-frames:v", "1",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 20 },
  );
  if (stdout.length < N * N) {
    throw new Error(`ffmpeg produced ${stdout.length} bytes, expected ${N * N}`);
  }

  const pixels = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) pixels[i] = stdout[i];

  const coeffs = dct2(pixels);
  // Drop the DC term before taking the median: it carries overall brightness, which
  // is exactly what we do not want the hash to be sensitive to.
  const ac = Array.from(coeffs).slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;

  let hex = "";
  for (let byte = 0; byte < 8; byte++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) {
      const i = byte * 8 + bit;
      const value = i === 0 ? median : coeffs[i]; // DC bit is always 0, harmless
      if (value > median) v |= 1 << (7 - bit);
    }
    hex += v.toString(16).padStart(2, "0");
  }
  return hex;
}

export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 8) {
    let x = BigInt("0x" + a.slice(i, i + 8)) ^ BigInt("0x" + b.slice(i, i + 8));
    while (x) {
      d += Number(x & 1n);
      x >>= 1n;
    }
  }
  return d;
}
