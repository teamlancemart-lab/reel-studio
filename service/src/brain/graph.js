/**
 * The node graph and staleness propagation.
 *
 * "Regenerating one node never re-runs its siblings; descendants go stale with a
 * visible rebuild cost." That sentence is this file.
 *
 * Node keys are "B1" for job-wide nodes and "B6:2" for per-reel nodes. Staleness
 * follows the edges below, which are copied from the "Regenerate:" line of each node
 * contract in docs/property-reel-brain-v1.md. B4 and the paid hook path arrive in D3;
 * their edges are declared here already so adding them does not reshape the graph.
 */
import { costModel } from "../config.js";

/** node -> the nodes that must be rebuilt when it changes. */
export const DEPENDENTS = {
  B0: ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"],
  B1: ["B2", "B3", "B4", "B5", "B6", "B7", "B8"],
  B2: ["B3", "B4", "B6", "B7", "B8"],
  B3: ["B4", "B5", "B6", "B7", "B8"],
  B4: ["B7", "B8"],
  B5: ["B6", "B7", "B8"],
  B6: ["B8"],
  B7: ["B8"],
  B8: [],
};

/** Nodes that run once per reel. Everything else is job-wide. */
export const PER_REEL = new Set(["B4", "B6", "B7"]);

export const NODE_LABEL = {
  B0: "photo classification",
  B1: "listing truth",
  B2: "tier and persona",
  B3: "format selection",
  B4: "hook selection",
  B5: "shot list",
  B6: "copy",
  B7: "music and pacing",
  B8: "preflight",
};

export const key = (node, reelN = null) =>
  PER_REEL.has(node) && reelN != null ? `${node}:${reelN}` : node;

export const parseKey = (k) => {
  const [node, reel] = k.split(":");
  return { node, reelN: reel ? Number(reel) : null };
};

/**
 * Which stored node keys go stale when `changedKey` is regenerated.
 *
 * A per-reel node only stales its own reel's descendants: editing B6 for reel 2 must
 * not touch reels 1 and 3. A job-wide node stales every reel.
 */
export function staleKeys(changedKey, existingKeys) {
  const { node, reelN } = parseKey(changedKey);
  const affected = DEPENDENTS[node] || [];
  return existingKeys.filter((k) => {
    if (k === changedKey) return false;
    const target = parseKey(k);
    if (!affected.includes(target.node)) return false;
    // A per-reel change only propagates within that reel.
    if (reelN != null && target.reelN != null && target.reelN !== reelN) return false;
    return true;
  });
}

/* ------------------------------------------------------------ rebuild cost */

const USD_INR = costModel.fx.usd_inr;
const byNode = Object.fromEntries(costModel.brain_nodes.map((n) => [n.node, n]));

/** Estimated INR to re-run one node, from cost-model.json token estimates. */
export function estimateNodeCostInr(node, { photoCount = 0 } = {}) {
  const spec = byNode[node];
  if (!spec) return 0;
  const rate = costModel.providers.vertex[spec.model];
  if (!rate) return 0;

  let calls = spec.calls ?? 1;
  if (spec.calls_formula === "ceil(photo_count/5)") {
    calls = Math.max(1, Math.ceil(photoCount / 5));
  } else if (spec.calls_formula === "reel_count") {
    // Per-reel nodes are estimated one reel at a time; the caller multiplies.
    calls = 1;
  }

  const usd =
    calls *
    ((spec.in_tokens_per_call / 1_000_000) * (rate.usd_per_m_input ?? 0) +
      (spec.out_tokens_per_call / 1_000_000) * (rate.usd_per_m_output ?? 0));
  return Number((usd * USD_INR).toFixed(4));
}

/** Total INR to rebuild a set of stale node keys. */
export function rebuildCostInr(keys, { photoCount = 0 } = {}) {
  const total = keys.reduce(
    (sum, k) => sum + estimateNodeCostInr(parseKey(k).node, { photoCount }),
    0,
  );
  return Number(total.toFixed(3));
}
