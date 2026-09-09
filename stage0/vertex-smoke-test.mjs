// Stage 0 smoke test. Node 20+. `npm i google-auth-library`
// Usage: node vertex-smoke-test.mjs ./exterior.jpg
import fs from "node:fs";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || "us-central1";
const SA_B64 = process.env.GCP_SA_JSON_B64;
const BUCKET = process.env.VEO_OUTPUT_BUCKET; // optional, gs://...
const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-2.5-flash";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-2.5-flash-image";
const VEO_MODEL = process.env.VEO_MODEL || "veo-3.1-lite-generate-001";
const USD_INR = 84;

if (!PROJECT || !SA_B64) {
  console.error("Set GCP_PROJECT_ID and GCP_SA_JSON_B64");
  process.exit(1);
}
const photoPath = process.argv[2];
if (!photoPath || !fs.existsSync(photoPath)) {
  console.error("Pass a jpg/png path as the first argument");
  process.exit(1);
}

const creds = JSON.parse(Buffer.from(SA_B64, "base64").toString("utf8"));
const auth = new GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const token = (await client.getAccessToken()).token;
const base = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}`;
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const photoB64 = fs.readFileSync(photoPath).toString("base64");
const mime = photoPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
const ledger = [];

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${url}\n${text.slice(0, 800)}`);
  return JSON.parse(text);
}

// 1. Gemini text+vision: classify the photo (B0 in miniature)
{
  const prompt = `Classify this real estate listing photo. Return JSON only with keys:
room_class (exterior_front|exterior_rear|aerial_34|aerial_topdown|living|kitchen|bedroom|bathroom|floor_plan|other),
features (array of short nouns), people_present (bool), vehicles_present (bool),
hook_candidate (bool: exterior with the whole building visible and no people),
safe_crop_9x16 {x_center, y_center, width_frac} as fractions 0..1.`;
  const res = await post(`${base}/publishers/google/models/${TEXT_MODEL}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: photoB64 } }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });
  const out = res.candidates?.[0]?.content?.parts?.[0]?.text;
  const usage = res.usageMetadata || {};
  console.log("gemini ok\n", out);
  ledger.push({ step: "B0 classify", inr: 0.2, tokens: usage.totalTokenCount });
}

// 2. Gemini image: mid-action still with the building unchanged (H1 in miniature)
{
  const prompt = `Using the reference photo, produce the same building, same camera angle, same lighting, unchanged in every detail.
Add one theatrical element only: a large deep-red fabric drape covering the whole building, its edges just starting to lift at the roof line.
No people, no vehicles, no text, no logos, no change of time of day, no extra windows or floors.`;
  const res = await post(`${base}/publishers/google/models/${IMAGE_MODEL}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: photoB64 } }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error("image model returned no image: " + JSON.stringify(res).slice(0, 500));
  fs.writeFileSync("still.png", Buffer.from(part.inlineData.data, "base64"));
  console.log("image ok -> still.png");
  ledger.push({ step: "H1 still", inr: 4 });
}

// 3. Veo 3.1 Lite image-to-video from the still (H2 in miniature)
{
  const stillB64 = fs.readFileSync("still.png").toString("base64");
  const durationSeconds = 6;
  const body = {
    instances: [
      {
        prompt:
          "A small helicopter, high in the top of the frame, lifts the red drape straight up and away by cables. The drape peels off and flows out of the frame. The building underneath is revealed exactly as it is, unchanged, same camera, same light. Ends on a clean view of the building. No people, no vehicles, no text, no logos.",
        image: { bytesBase64Encoded: stillB64, mimeType: "image/png" },
      },
    ],
    parameters: {
      aspectRatio: "9:16",
      durationSeconds,
      resolution: "720p",
      generateAudio: false,
      sampleCount: 1,
      personGeneration: "dont_allow",
      ...(BUCKET ? { storageUri: `${BUCKET}/smoke/` } : {}),
    },
  };
  const op = await post(`${base}/publishers/google/models/${VEO_MODEL}:predictLongRunning`, body);
  console.log("veo submitted", op.name);
  let done = false, result;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    result = await post(`${base}/publishers/google/models/${VEO_MODEL}:fetchPredictOperation`, { operationName: op.name });
    done = !!result.done;
    console.log(`poll ${i + 1}: ${done ? "done" : "running"}`);
  }
  if (!done) throw new Error("Veo did not finish in 10 minutes");
  const vids = result.response?.videos || [];
  if (!vids.length) throw new Error("Veo returned no video: " + JSON.stringify(result.response).slice(0, 500));
  const v = vids[0];
  if (v.bytesBase64Encoded) {
    fs.writeFileSync("hook.mp4", Buffer.from(v.bytesBase64Encoded, "base64"));
    console.log("veo ok -> hook.mp4");
  } else {
    console.log("veo ok ->", v.gcsUri);
  }
  ledger.push({ step: "H2 veo lite 6s", usd: 0.03 * durationSeconds });
}

// 4. Ledger
const inr = ledger.reduce((s, l) => s + (l.inr || 0) + (l.usd ? l.usd * USD_INR : 0), 0);
console.table(ledger);
console.log(`total ≈ ₹${inr.toFixed(2)} (≈ $${(inr / USD_INR).toFixed(3)})`);
