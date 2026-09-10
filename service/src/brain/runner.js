/**
 * Node runner.
 *
 * One place where "every brain node has a fixed JSON schema, a status, a cost, a lock
 * and a regenerate" is enforced:
 *
 *   - run the model call
 *   - validate against the node's schema in shared/schemas.json
 *   - on failure, retry ONCE with the validation errors appended to the prompt
 *   - on a second failure, fail the node with a named reason (never a silent default)
 *   - stamp NodeMeta (version, model, cost_inr, elapsed, parent_versions)
 *   - mark descendants stale with a rebuild cost
 *
 * A locked node is never re-run; the runner returns the stored payload untouched.
 */
import { readJob, writeJob, emit, setStage } from "../store.js";
import { ledgerTotals } from "../ledger.js";
import { validate } from "./validate.js";
import { key as nodeKey, staleKeys, rebuildCostInr, NODE_LABEL } from "./graph.js";

const RETRY_PREAMBLE =
  "Your previous reply did not match the required JSON schema. " +
  "Fix exactly these problems and return the corrected JSON only:\n";

export function getNode(job, node, reelN = null) {
  return job.nodes[nodeKey(node, reelN)] || null;
}

/** Ledger cost attributable to one node key, so each card shows what it actually cost. */
function costForNode(job, k, since) {
  const rows = job.ledger.filter((r) => r.stage === k && r.created_at >= since);
  return {
    inr: Number(rows.reduce((s, r) => s + (r.cost_inr || 0), 0).toFixed(4)),
    usd: Number(rows.reduce((s, r) => s + (r.cost_usd || 0), 0).toFixed(6)),
    calls: rows.length,
  };
}

/**
 * @param call  async ({ retryHint }) => payload   — makes the model call(s)
 * @param opts.schema      name in shared/schemas.json, or null to skip validation
 * @param opts.parents     ["B1","B2"] — recorded as parent_versions
 * @param opts.model       for the card
 */
export async function runNode(
  jobId,
  node,
  call,
  {
    schema = null,
    reelN = null,
    parents = [],
    model = "gemini-2.5-flash",
    force = false,
    /* B0 retries each 5-photo batch itself, so the node must not retry all six
       batches because one photo came back malformed. */
    maxAttempts = 2,
  } = {},
) {
  const k = nodeKey(node, reelN);
  let job = readJob(jobId);
  const existing = job.nodes[k];

  if (existing?.locked && !force) {
    emit(jobId, "node", { key: k, node, reelN, status: "locked", skipped: true });
    return existing.payload;
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  setStage(jobId, `brain:${k}`, job.progress, { note: NODE_LABEL[node] });

  let payload = null;
  let errors = [];
  let attempt = 0;

  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    const retryHint =
      attempt === 1 ? null : RETRY_PREAMBLE + errors.map((e) => `- ${e}`).join("\n");
    try {
      payload = await call({ retryHint, attempt });
    } catch (err) {
      errors = [`model call failed: ${err.message.slice(0, 300)}`];
      payload = null;
      if (attempt === maxAttempts) break;
      continue;
    }

    /* NodeMeta is stamped by this runner from what actually happened. B2 came back
       with a fabricated meta block — a made-up model name and a 2024 timestamp — which
       the schema happily accepted. Payloads do not get to describe their own
       provenance. */
    if (payload && typeof payload === "object" && "meta" in payload) delete payload.meta;

    if (!schema) {
      errors = [];
      break;
    }
    const result = validate(schema, payload);
    if (result.ok) {
      errors = [];
      break;
    }
    errors = result.errors;
    if (attempt === maxAttempts) payload = null;
  }

  const elapsedMs = Date.now() - t0;
  job = readJob(jobId);
  const cost = costForNode(job, k, startedAt);

  if (!payload) {
    const attemptsMade = Math.min(attempt, maxAttempts);
    const reason = `${k} failed after ${attemptsMade} attempt${attemptsMade === 1 ? "" : "s"}: ${errors.join("; ")}`;
    const record = {
      node,
      reelN,
      key: k,
      version: (existing?.version ?? 0) + 1,
      generated_at: new Date().toISOString(),
      model,
      cost_inr: cost.inr,
      cost_usd: cost.usd,
      calls: cost.calls,
      elapsed_ms: elapsedMs,
      locked: false,
      stale: false,
      status: "failed",
      failure_reason: reason,
      parent_versions: parentVersions(job, parents, reelN),
      payload: null,
    };
    job.nodes[k] = record;
    writeJob(job);
    emit(jobId, "node", { key: k, node, reelN, status: "failed", reason, elapsedMs });
    throw new Error(reason);
  }

  const record = {
    node,
    reelN,
    key: k,
    version: (existing?.version ?? 0) + 1,
    generated_at: new Date().toISOString(),
    model,
    cost_inr: cost.inr,
    cost_usd: cost.usd,
    calls: cost.calls,
    elapsed_ms: elapsedMs,
    attempts: attempt,
    locked: existing?.locked ?? false,
    stale: false,
    status: "ok",
    failure_reason: null,
    parent_versions: parentVersions(job, parents, reelN),
    payload,
  };
  job.nodes[k] = record;

  // Descendants of a re-run node go stale, with the cost of putting them right.
  const stale = staleKeys(k, Object.keys(job.nodes));
  for (const sk of stale) job.nodes[sk].stale = true;
  writeJob(job);

  emit(jobId, "node", {
    key: k,
    node,
    reelN,
    status: "ok",
    version: record.version,
    model,
    costInr: cost.inr,
    calls: cost.calls,
    elapsedMs,
    attempts: attempt,
    staleKeys: stale,
    rebuildCostInr: rebuildCostInr(stale, { photoCount: job.photos.length }),
    payload,
  });

  return payload;
}

function parentVersions(job, parents, reelN) {
  const out = {};
  for (const p of parents) {
    const direct = job.nodes[nodeKey(p, reelN)] || job.nodes[p];
    if (direct) out[direct.key] = direct.version;
  }
  return out;
}

/** Edit a node's payload by hand. Validates, bumps the version, stales descendants. */
export function saveNode(jobId, k, payload, { schema = null, editedBy = "user" } = {}) {
  const job = readJob(jobId);
  const existing = job.nodes[k];
  if (!existing) throw new Error(`no node ${k} on job ${jobId}`);

  if (schema) {
    const result = validate(schema, payload);
    if (!result.ok) {
      throw new Error(`edit rejected: ${result.errors.join("; ")}`);
    }
  }

  existing.payload = payload;
  existing.version += 1;
  existing.generated_at = new Date().toISOString();
  existing.stale = false;
  existing.status = "ok";
  existing.edited_by = editedBy;

  const stale = staleKeys(k, Object.keys(job.nodes));
  for (const sk of stale) job.nodes[sk].stale = true;
  writeJob(job);

  emit(jobId, "node", {
    key: k,
    node: existing.node,
    reelN: existing.reelN,
    status: "edited",
    version: existing.version,
    staleKeys: stale,
    rebuildCostInr: rebuildCostInr(stale, { photoCount: job.photos.length }),
    payload,
  });
  return existing;
}

export function setLock(jobId, k, locked) {
  const job = readJob(jobId);
  const existing = job.nodes[k];
  if (!existing) throw new Error(`no node ${k} on job ${jobId}`);
  existing.locked = Boolean(locked);
  writeJob(job);
  emit(jobId, "node", { key: k, node: existing.node, status: locked ? "locked" : "unlocked" });
  return existing;
}

export function jobLedger(jobId) {
  const job = readJob(jobId);
  return ledgerTotals(job.ledger);
}
