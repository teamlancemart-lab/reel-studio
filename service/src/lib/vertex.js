/**
 * Vertex client. Ported from docs/vertex-smoke-test.mjs and docs/hook-v4.mjs.
 *
 * Two rules this module exists to enforce:
 *   1. Every call writes a cost_ledger row BEFORE the caller can report success.
 *      That includes failures that burned tokens.
 *   2. submitVideo() throws unless GENERATIVE_ENABLED === "true". It is the only gate
 *      on paid video, and it stays shut until Stage 6.
 *
 * Nothing in D1 calls any of this. It is here, correct, so D2 and D3 do not have to
 * invent it under time pressure.
 */
import { GoogleAuth } from "google-auth-library";
import { config } from "../config.js";
import { addLedgerRow, readJob } from "../store.js";
import { jobFlags, budgetCheck } from "../jobOptions.js";
import { priceVideo as _priceVideo } from "../ledger.js";
import { makeRow, priceTokens, priceImage, priceVideo } from "../ledger.js";

/* ------------------------------------------------------------------ auth */

let cached = null; // { token, expiresAt }
let authClient = null;

async function getAuthClient() {
  if (authClient) return authClient;
  if (!config.gcpSaJsonB64) {
    throw new Error("GCP_SA_JSON_B64 is not set");
  }
  let credentials;
  try {
    credentials = JSON.parse(
      Buffer.from(config.gcpSaJsonB64, "base64").toString("utf8"),
    );
  } catch (err) {
    throw new Error(`GCP_SA_JSON_B64 is not valid base64 JSON: ${err.message}`);
  }
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  authClient = await auth.getClient();
  return authClient;
}

/** Cached until 5 minutes before expiry, as PHASE-PROMPTS specifies. */
export async function getToken() {
  const now = Date.now();
  if (cached && cached.expiresAt - 5 * 60_000 > now) return cached.token;
  const client = await getAuthClient();
  const res = await client.getAccessToken();
  const token = typeof res === "string" ? res : res.token;
  if (!token) throw new Error("Vertex returned no access token");
  // google-auth-library exposes the expiry on the client credentials.
  const expiry = client.credentials?.expiry_date;
  cached = { token, expiresAt: expiry || now + 55 * 60_000 };
  return token;
}

/** Drop the cached token. Called on a 401 so the next attempt re-mints. */
export function invalidateToken() {
  cached = null;
}

function baseUrl() {
  if (!config.gcpProjectId) throw new Error("GCP_PROJECT_ID is not set");
  return (
    `https://${config.gcpLocation}-aiplatform.googleapis.com/v1` +
    `/projects/${config.gcpProjectId}/locations/${config.gcpLocation}`
  );
}

/* A request with no timeout waited on a dead connection for undici's full 300s before
   "fetch failed" (B4:1, 2026-09-10). Two minutes is ~10x the slowest healthy call seen;
   an abort still lands in the caller's catch, so the ledger row and the node retry work
   exactly as they do for any other failure. */
const REQUEST_TIMEOUT_MS = Number(process.env.VERTEX_TIMEOUT_MS || 120_000);

async function post(url, body, { retryOn401 = true } = {}) {
  const token = await getToken();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await r.text();
  if (r.status === 401 && retryOn401) {
    invalidateToken();
    return post(url, body, { retryOn401: false });
  }
  if (!r.ok) {
    const err = new Error(`Vertex ${r.status} ${url}\n${text.slice(0, 900)}`);
    err.status = r.status;
    throw err;
  }
  return JSON.parse(text);
}

const modelUrl = (model, verb) =>
  `${baseUrl()}/publishers/google/models/${model}:${verb}`;

/* ------------------------------------------------------- ledger-wrapped calls */

/**
 * Writes the ledger row, then returns. Every exported call funnels through here so
 * there is exactly one place where "we spent money" is recorded.
 */
function record(jobId, row) {
  if (jobId) addLedgerRow(jobId, row);
  return row;
}

function usageOf(res) {
  const u = res?.usageMetadata || {};
  return {
    inTokens: u.promptTokenCount ?? 0,
    outTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    total: u.totalTokenCount ?? 0,
  };
}

/** Named on the ledger row, so a truncated reply is visible where its cost is. */
function truncated(res) {
  const reason = res?.candidates?.[0]?.finishReason;
  return reason && reason !== "STOP" ? `finishReason ${reason}` : null;
}

function firstText(res) {
  return res?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? "";
}

/**
 * Gemini text. `json: true` sets responseMimeType application/json, which every brain
 * node uses.
 */
export async function callText({
  jobId = null,
  reelN = null,
  stage = "text",
  model = config.textModel,
  prompt,
  systemInstruction = null,
  json = true,
  temperature = 0.2,
  thinkingBudget = 0,
  /* A B4 reply ran away to 70,618 tokens (Rs 13.89 for a node that costs Rs 0.25) and was
     unparseable anyway. Every schema-shaped reply fits in a fraction of this. */
  maxOutputTokens = 8192,
}) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(json ? { responseMimeType: "application/json" } : {}),
      /* Brain nodes are structured extraction against a fixed schema, not reasoning
         problems. Thinking tokens bill at the OUTPUT rate, so leaving them on roughly
         doubled the cost of a 29-photo job for no measurable accuracy gain. Pass a
         budget explicitly to turn it back on for a node that needs it. */
      ...(thinkingBudget != null ? { thinkingConfig: { thinkingBudget } } : {}),
    },
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
      : {}),
  };

  let res;
  try {
    res = await post(modelUrl(model, "generateContent"), body);
  } catch (err) {
    record(
      jobId,
      makeRow({
        jobId, reelN, stage, provider: "vertex", providerModel: model,
        units: 0, unitType: "tokens", usd: 0, status: "failed", note: err.message.slice(0, 300),
      }),
    );
    throw err;
  }

  const usage = usageOf(res);
  const { usd } = priceTokens(model, usage.inTokens, usage.outTokens);
  record(
    jobId,
    makeRow({
      jobId, reelN, stage, provider: "vertex", providerModel: model,
      units: usage.total, unitType: "tokens", usd,
      note: truncated(res),
    }),
  );

  const text = firstText(res);
  return { text, json: json ? safeParse(text) : null, usage, raw: res };
}

/** Gemini vision. Same as callText with images attached. `images` are {mimeType, data}. */
export async function callVision({
  jobId = null,
  reelN = null,
  stage = "vision",
  model = config.textModel,
  prompt,
  images = [],
  json = true,
  temperature = 0.2,
  thinkingBudget = 0,
  maxOutputTokens = 4096,
}) {
  const parts = [
    { text: prompt },
    ...images.map((img) => ({
      inlineData: { mimeType: img.mimeType, data: img.data },
    })),
  ];
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(json ? { responseMimeType: "application/json" } : {}),
      ...(thinkingBudget != null ? { thinkingConfig: { thinkingBudget } } : {}),
    },
  };

  let res;
  try {
    res = await post(modelUrl(model, "generateContent"), body);
  } catch (err) {
    record(
      jobId,
      makeRow({
        jobId, reelN, stage, provider: "vertex", providerModel: model,
        units: images.length, unitType: "images", usd: 0, status: "failed",
        note: err.message.slice(0, 300),
      }),
    );
    throw err;
  }

  const usage = usageOf(res);
  const { usd } = priceTokens(model, usage.inTokens, usage.outTokens);
  record(
    jobId,
    makeRow({
      jobId, reelN, stage, provider: "vertex", providerModel: model,
      units: usage.total, unitType: "tokens", usd,
      note: truncated(res),
    }),
  );

  const text = firstText(res);
  return { text, json: json ? safeParse(text) : null, usage, raw: res };
}

/**
 * Nano Banana. Returns a Buffer of PNG bytes.
 * `reference` is the real photo; every concealment prompt is conditioned on it.
 */
export async function callImage({
  jobId = null,
  reelN = null,
  stage = "still",
  model = config.imageModel,
  prompt,
  reference = null, // {mimeType, data}
}) {
  const parts = [{ text: prompt }];
  if (reference) {
    parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.data } });
  }
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };

  let res;
  try {
    res = await post(modelUrl(model, "generateContent"), body);
  } catch (err) {
    record(
      jobId,
      makeRow({
        jobId, reelN, stage, provider: "vertex", providerModel: model,
        units: 1, unitType: "images", usd: 0, status: "failed", note: err.message.slice(0, 300),
      }),
    );
    throw err;
  }

  const part = res?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  const { usd } = priceImage(model, 1);
  record(
    jobId,
    makeRow({
      jobId, reelN, stage, provider: "vertex", providerModel: model,
      units: 1, unitType: "images", usd,
      status: part ? "ok" : "failed",
      note: part ? null : "model returned no image",
    }),
  );
  if (!part) throw new Error("image model returned no image");

  return {
    buffer: Buffer.from(part.inlineData.data, "base64"),
    mimeType: part.inlineData.mimeType || "image/png",
  };
}

/**
 * Veo. Submits the long-running op and writes the ledger row IMMEDIATELY on a
 * successful submit — the charge is incurred at submit, not at poll, so waiting for
 * pollVideo() to record it would leave a window where money was spent and the ledger
 * said otherwise.
 *
 * `lastFrame` forces durationSeconds 8 on Vertex (cost-model.json
 * last_frame_requires_duration_s). rules.json v1.2 generation_paths.reverse_conceal
 * is the path that uses it.
 */
export async function submitVideo({
  jobId = null,
  reelN = null,
  stage = "clip",
  model = config.veoModel,
  prompt,
  image = null, // {mimeType, data} — the REAL cropped hero, never a still that hides it
  lastFrame = null, // {mimeType, data}
  aspectRatio = "9:16",
  durationSeconds = 8,
  resolution = "720p",
  generateAudio = false,
  personGeneration = "dont_allow",
  storageUri = null,
}) {
  if (!config.generativeEnabled) {
    throw new Error(
      "GENERATIVE_ENABLED is not 'true'. Paid video is gated until Stage 6.",
    );
  }
  /* The per-job toggle, checked here too: every Veo call in the service goes through this
     function, so no code path can spend on a job whose run controls said no. */
  if (jobId) {
    const job = readJob(jobId);
    if (job && !jobFlags(job).generative) {
      throw new Error(`job ${jobId} was run with generative off; paid video refused`);
    }
    const budget = job ? budgetCheck(job, _priceVideo(model, durationSeconds).usd) : { ok: true };
    if (!budget.ok) throw new Error(budget.reason);
  }
  if (lastFrame && durationSeconds !== 8) {
    throw new Error(
      `lastFrame requires durationSeconds 8 on Vertex, got ${durationSeconds}`,
    );
  }

  const body = {
    instances: [
      {
        prompt,
        ...(image ? { image: { bytesBase64Encoded: image.data, mimeType: image.mimeType } } : {}),
        ...(lastFrame
          ? { lastFrame: { bytesBase64Encoded: lastFrame.data, mimeType: lastFrame.mimeType } }
          : {}),
      },
    ],
    parameters: {
      aspectRatio,
      durationSeconds,
      resolution,
      generateAudio,
      sampleCount: 1,
      personGeneration,
      ...(storageUri ? { storageUri } : {}),
    },
  };

  let op;
  try {
    op = await post(modelUrl(model, "predictLongRunning"), body);
  } catch (err) {
    record(
      jobId,
      makeRow({
        jobId, reelN, stage, provider: "vertex", providerModel: model,
        units: durationSeconds, unitType: "seconds", usd: 0, status: "failed",
        note: err.message.slice(0, 300),
      }),
    );
    throw err;
  }

  // Charged at submit. Vertex bundles audio, so generateAudio:false does not reduce it.
  const { usd } = priceVideo(model, durationSeconds);
  record(
    jobId,
    makeRow({
      jobId, reelN, stage, provider: "vertex", providerModel: model,
      units: durationSeconds, unitType: "seconds", usd, status: "submitted",
      note: op.name,
    }),
  );

  return { operationName: op.name, durationSeconds };
}

/**
 * Polls a Veo operation. No ledger row: submitVideo already recorded the charge.
 * Returns { done, video: {buffer|gcsUri}, raw }.
 */
export async function pollVideo({
  operationName,
  model = config.veoModel,
  intervalMs = 10_000,
  maxPolls = 90,
  onPoll = null,
}) {
  let res;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    res = await post(modelUrl(model, "fetchPredictOperation"), { operationName });
    if (onPoll) onPoll(i + 1, !!res.done);
    if (res.done) break;
  }
  if (!res?.done) {
    throw new Error(
      `Veo did not finish after ${(maxPolls * intervalMs) / 60000} minutes`,
    );
  }
  const video = res.response?.videos?.[0];
  if (!video) {
    throw new Error(
      "Veo returned no video: " + JSON.stringify(res.response).slice(0, 600),
    );
  }
  return {
    done: true,
    video: video.bytesBase64Encoded
      ? { buffer: Buffer.from(video.bytesBase64Encoded, "base64") }
      : { gcsUri: video.gcsUri },
    raw: res,
  };
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Models occasionally fence JSON despite responseMimeType.
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/** Reported by /health so a misconfigured deploy is visible without a paid call. */
export function vertexStatus() {
  return {
    projectConfigured: Boolean(config.gcpProjectId),
    credentialsConfigured: Boolean(config.gcpSaJsonB64),
    location: config.gcpLocation,
    textModel: config.textModel,
    imageModel: config.imageModel,
    veoModel: config.veoModel,
    generativeEnabled: config.generativeEnabled,
    tokenCached: Boolean(cached),
  };
}
