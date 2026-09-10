/**
 * Drives overlays.py.
 *
 * Everything the Python side needs comes from rules.json, passed in rather than
 * duplicated: the safe zone, both type systems, the frame size. There is exactly one
 * definition of what a card looks like, and both renderers read it.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, rules } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "overlays.py");

/**
 * @param recipe   ReelRecipe
 * @param outDir   where the PNGs go
 * @param size     { width, height } of the master
 * @returns [{ id, path, tIn, tOut, fadeS }]
 */
export async function renderOverlays(recipe, outDir, size) {
  const overlays = [];
  recipe.segments.forEach((seg, si) => {
    seg.overlays.forEach((o, oi) => {
      overlays.push({
        id: `ov_${String(si).padStart(2, "0")}_${oi}`,
        kind: o.kind,
        system: o.system,
        voice: o.voice ?? recipe.typeVoice,
        lines: o.lines,
        tIn: o.tIn,
        tOut: o.tOut,
        ...(o.fadeS != null ? { fadeS: o.fadeS } : {}),
        // The floor plan draws on paper; white ink would vanish.
        onLight: seg.motion === "self_draw",
      });
    });
  });

  if (overlays.length === 0) return [];

  const spec = {
    width: size.width,
    height: size.height,
    fontsDir: config.fontsDir,
    outDir,
    safeZone: rules.safe_zone_9x16,
    typeSystems: rules.type_systems,
    overlays,
  };

  /* spawn, not execFile: execFile has no `input` option (that is execFileSync), so
     passing one leaves Python blocked on stdin forever. */
  const stdout = await pipeToPython(JSON.stringify(spec));
  return JSON.parse(stdout).overlays;
}

function pipeToPython(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonBin, [SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`overlays.py exited ${code}: ${err.slice(0, 600)}`));
        return;
      }
      resolve(out);
    });
    child.stdin.end(input);
  });
}
