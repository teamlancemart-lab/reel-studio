// Fix A: reverse-drape hook. Node 20+.
//   npm i google-auth-library
// Usage: node hook-fix-a.mjs ./exterior.jpg
//
// Why this works: the failed v1 gave Veo a still where the house was HIDDEN by the drape,
// so the model had no reference and invented a different house. Here the REAL PHOTO is the
// first frame, so the true building is the thing the model must preserve. We generate the
// drape FALLING onto it, then reverse the clip so it plays as a reveal.
//
// Also fixed: 9:16 crop before generation (no letterbox), 30fps output, truth-lock tail.

import fs from "node:fs";
import { execSync } from "node:child_process";
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || "us-central1";
const SA_B64 = process.env.GCP_SA_JSON_B64;
const VEO_MODEL = process.env.VEO_MODEL || "veo-3.1-lite-generate-001";
const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-2.5-flash";
const CONCEPT = process.env.CONCEPT || "drape";
const USD_INR = 84;

if (!PROJECT || !SA_B64) { console.error("Set GCP_PROJECT_ID and GCP_SA_JSON_B64"); process.exit(1); }
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error("Pass a photo path"); process.exit(1); }

const auth = new GoogleAuth({ credentials: JSON.parse(Buffer.from(SA_B64, "base64").toString()), scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const token = (await (await auth.getClient()).getAccessToken()).token;
const base = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}`;
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const ledger = [];

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status}\n${t.slice(0, 900)}`);
  return JSON.parse(t);
}
const b64 = (p) => fs.readFileSync(p).toString("base64");

// ---------------------------------------------------------------- 1. crop to 9:16
// The v1 failure letterboxed a 16:9 still into 720x1280 and paid for black bars.
// Crop the hero to portrait FIRST, centred on the building.
console.log("1. cropping to 9:16");
const probe = (f, e) => execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=${e} -of csv=p=0 "${f}"`).toString().trim();
const sw = parseInt(probe(src, "width")), sh = parseInt(probe(src, "height"));
// X_CENTER comes from B0's safe_crop_9x16 in the real pipeline; 0.37 is what B0 returned for this photo
const xc = parseFloat(process.env.X_CENTER || "0.37");
let cw = Math.min(sw, Math.round(sh * 9 / 16)); cw -= cw % 2;
let cx = Math.round((sw - cw) * xc); cx -= cx % 2;
execSync(`ffmpeg -y -v error -i "${src}" -vf "crop=${cw}:${sh}:${cx}:0,scale=720:1280" hero_916.png`);
console.log(`   src ${sw}x${sh} -> crop ${cw} at x=${cx} -> hero_916.png (720x1280)`);

// ---------------------------------------------------------------- 2. the FINAL still
// Note the direction: this is the state the animation ENDS in (drape fully covering),
// because we generate forwards and then reverse.
const CONCEPTS = {
  drape: {
    still: `Using the reference photo exactly as it is, add one theatrical element: a large deep-crimson fabric drape now completely covering the front of the building, hanging in heavy folds from the roof line to the ground.
Everything else in the photo is unchanged and still visible: the same neighbouring houses, the same parked vehicles, the same trees, the same power lines, the same sky, the same road, the same time of day and the same light direction.
Photographic, matching the exposure and colour of the reference. No people. No text. No logos. No new buildings.`,
    clip: `Static camera, locked off, identical framing throughout.
A large crimson fabric drape descends from above and settles down over the front of the building, unfurling and draping into heavy folds until the building front is covered. Two thin cables and a small distant helicopter high at the top of the frame lower it.
The street, the parked vehicles, the neighbouring houses, the trees and the power lines remain exactly as they are and never change. Nothing else in the scene moves except the fabric.
Real photographic footage, daylight, no camera movement.`,
  },
  reveal_dust: {
    still: `Using the reference photo exactly as it is, add a soft veil of pale construction dust and haze completely obscuring the front of the building, as if a cloud has settled over it.
Everything else is unchanged: same neighbours, same vehicles, same trees, same sky, same light.
Photographic. No people, no text, no logos.`,
    clip: `Static locked-off camera. A soft pale haze rolls in and gathers over the front of the building until it is obscured. Everything else in the scene stays exactly as it is. Real photographic footage, daylight, no camera movement.`,
  },
};
const C = CONCEPTS[CONCEPT] || CONCEPTS.drape;

console.log("2. generating the end-state still");
{
  const res = await post(`${base}/publishers/google/models/${process.env.IMAGE_MODEL || "gemini-2.5-flash-image"}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: C.still }, { inlineData: { mimeType: "image/png", data: b64("hero_916.png") } }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error("no image returned: " + JSON.stringify(res).slice(0, 400));
  fs.writeFileSync("still_end.png", Buffer.from(part.inlineData.data, "base64"));
  ledger.push({ step: "still (end state)", inr: 4 });
  console.log("   -> still_end.png");
}

// ---------------------------------------------------------------- 3. video, FORWARD
// First frame = the REAL photo. The model must preserve the true building because it is
// the conditioning frame. This is the entire fix.
console.log("3. veo: real photo -> drape descending (forward)");
const durationSeconds = 6;
{
  const op = await post(`${base}/publishers/google/models/${VEO_MODEL}:predictLongRunning`, {
    instances: [{ prompt: C.clip, image: { bytesBase64Encoded: b64("hero_916.png"), mimeType: "image/png" } }],
    parameters: { aspectRatio: "9:16", durationSeconds, resolution: "720p", generateAudio: false, sampleCount: 1, personGeneration: "dont_allow" },
  });
  console.log("   submitted", op.name.split("/").pop());
  let done = false, result;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    result = await post(`${base}/publishers/google/models/${VEO_MODEL}:fetchPredictOperation`, { operationName: op.name });
    done = !!result.done;
    process.stdout.write(done ? "   done\n" : ".");
  }
  if (!done) throw new Error("timed out");
  const v = result.response?.videos?.[0];
  if (!v?.bytesBase64Encoded) throw new Error("no video: " + JSON.stringify(result.response).slice(0, 400));
  fs.writeFileSync("forward.mp4", Buffer.from(v.bytesBase64Encoded, "base64"));
  ledger.push({ step: `veo ${durationSeconds}s`, usd: 0.05 * durationSeconds });
  console.log("   -> forward.mp4");
}

// ---------------------------------------------------------------- 4. reverse + truth lock
console.log("4. reversing, 30fps, truth lock");
execSync(`ffmpeg -y -v error -i forward.mp4 -vf "reverse,fps=30" -an reversed.mp4`);
// hold the real photo for 0.5s, crossfade the reversed clip's tail into it
execSync(`ffmpeg -y -v error -loop 1 -t 1 -i hero_916.png -vf "fps=30,scale=720:1280,format=yuv420p" -an hero_hold.mp4`);
const revDur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 reversed.mp4`).toString().trim());
const xfadeAt = Math.max(0, revDur - 0.5);
execSync(`ffmpeg -y -v error -i reversed.mp4 -i hero_hold.mp4 -filter_complex "[0][1]xfade=transition=fade:duration=0.5:offset=${xfadeAt.toFixed(2)},format=yuv420p" -r 30 -an hook_fixed.mp4`);
console.log("   -> hook_fixed.mp4");

// ---------------------------------------------------------------- 5. QA (Q2)
console.log("5. QA: comparing the final frame to the real photo");
execSync(`ffmpeg -y -v error -sseof -0.1 -i hook_fixed.mp4 -frames:v 1 qa_last.png`);
execSync(`ffmpeg -y -v error -i hook_fixed.mp4 -vf "select='eq(n\\,45)'" -frames:v 1 qa_mid.png`);
{
  const prompt = `Image 1 is the true reference photo of a property. Image 2 is the MIDDLE frame of a generated clip. Image 3 is the FINAL frame of that clip.

The clip is a marketing reveal. A theatrical object (a fabric drape, cables, a distant helicopter, haze) is INTENDED to be present in the middle frame and may hide parts of the property. That is not a fault. Do not report it.

Score the FINAL frame only against the reference. The final frame must show the property exactly as photographed.
Also check the middle frame for one thing only: whether anything BELONGING TO THE SCENE (people, vehicles, neighbouring buildings, trees, road) was added or removed.

Return JSON only:
{"floors":{"ref":n,"last":n},
 "windows_front":{"ref":n,"last":n},
 "vehicles":{"ref":n,"mid":n,"last":n},
 "roof_shape_match_last":true|false,
 "same_building_last":true|false,
 "colour_and_materials_match_last":true|false,
 "camera_moved":true|false,
 "rejects":[only from: people_added, vehicles_removed, neighbours_changed, time_of_day_changed, lights_switched, text_added, structure_changed_in_final_frame],
 "last_frame_matches_reference":true|false,
 "verdict":"pass"|"fail",
 "notes":"one sentence"}

Fail ONLY if: the final frame is not the same building, or a final-frame count differs from the reference, or a reject fires. A covered or partly hidden building in the middle frame is a pass.`;
  const res = await post(`${base}/publishers/google/models/${TEXT_MODEL}:generateContent`, {
    contents: [{ role: "user", parts: [
      { text: prompt },
      { inlineData: { mimeType: "image/png", data: b64("hero_916.png") } },
      { inlineData: { mimeType: "image/png", data: b64("qa_mid.png") } },
      { inlineData: { mimeType: "image/png", data: b64("qa_last.png") } },
    ]}],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  });
  const out = res.candidates?.[0]?.content?.parts?.[0]?.text;
  console.log(out);
  ledger.push({ step: "Q2 vision QA", inr: 0.5 });
  fs.writeFileSync("qa.json", out);
}

// ---------------------------------------------------------------- 6. contact sheet + ledger
try {
  execSync(`ffmpeg -y -v error -i hook_fixed.mp4 -vf "fps=4,scale=200:-1,tile=6x5:padding=2:color=black" -frames:v 1 sheet.png`);
  console.log("   -> sheet.png (0.25s per tile, left to right, top to bottom)");
} catch (e) { console.log("   sheet failed, skipping:", e.message.split("\n")[0]); }
const inr = ledger.reduce((s, l) => s + (l.inr || 0) + (l.usd || 0) * USD_INR, 0);
console.table(ledger);
console.log(`total ≈ ₹${inr.toFixed(2)} (≈ $${(inr / USD_INR).toFixed(3)})`);
console.log("\nfiles: hook_fixed.mp4  sheet.png  qa.json  still_end.png  forward.mp4");
