/**
 * cost_ledger.
 *
 * CLAUDE.md: "Every model call writes a cost_ledger row BEFORE the caller reports
 * success." So the row is appended by lib/vertex.js the moment a response comes back,
 * before the value is handed to whoever asked for it. A failed call still writes a row
 * with status "failed" and whatever units were consumed, because a failure that burned
 * tokens still cost money.
 *
 * In D1 this is a JSON file per job on the /data volume. Stage 1 of PHASE-PROMPTS moves
 * it to a Postgres table with the same column names.
 */
import { costModel } from "./config.js";

const USD_INR = costModel.fx.usd_inr;

/** Price a Gemini text/vision call from cost-model.json rates. */
export function priceTokens(model, inTokens, outTokens) {
  const rate = costModel.providers.vertex[model];
  if (!rate) return { usd: 0, note: `no rate for ${model}` };
  const usd =
    (inTokens / 1_000_000) * (rate.usd_per_m_input ?? 0) +
    (outTokens / 1_000_000) * (rate.usd_per_m_output ?? 0);
  return { usd };
}

/** Price one generated image. */
export function priceImage(model, images = 1) {
  const rate = costModel.providers.vertex[model];
  if (!rate) return { usd: 0, note: `no rate for ${model}` };
  return { usd: (rate.usd_per_image_1024 ?? 0) * images };
}

/**
 * Price a video call. Vertex bundles audio, so generateAudio:false does NOT reduce the
 * rate — cost-model.json v1.1 carries that note and the verified $0.40/8s charge.
 */
export function priceVideo(model, seconds) {
  const key = model.replace(/-generate-\d+$/, "");
  const rate = costModel.providers.vertex[key] || costModel.providers.vertex[model];
  if (!rate) return { usd: 0, note: `no rate for ${model}` };
  return { usd: (rate.usd_per_s ?? 0) * seconds };
}

export function makeRow({
  jobId,
  reelN = null,
  stage,
  provider,
  providerModel,
  units,
  unitType,
  usd,
  status = "ok",
  note = null,
}) {
  return {
    job_id: jobId,
    reel_n: reelN,
    stage,
    provider,
    provider_model: providerModel,
    units,
    unit_type: unitType,
    cost_usd: Number(usd.toFixed(6)),
    cost_inr: Number((usd * USD_INR).toFixed(4)),
    status,
    note,
    created_at: new Date().toISOString(),
  };
}

export function ledgerTotals(rows) {
  const usd = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  return {
    rows: rows.length,
    usd: Number(usd.toFixed(4)),
    inr: Number((usd * USD_INR).toFixed(2)),
  };
}
