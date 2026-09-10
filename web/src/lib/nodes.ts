/**
 * Brain node cards, from the service.
 *
 * A card is the visible form of the architecture rule: every node has a fixed schema,
 * a status, a cost, a lock and a regenerate, and editing one marks its descendants
 * stale with a rebuild cost you can see before you click.
 */
import { SERVICE_URL } from "./service";
import type { ReelRecipe } from "@/shared/recipe";

export interface NodeCard {
  key: string;
  node: string;
  reelN: number | null;
  label: string;
  status: "ok" | "failed" | "edited";
  version: number;
  model: string;
  costInr: number;
  calls: number;
  elapsedMs: number;
  attempts: number;
  locked: boolean;
  stale: boolean;
  failureReason: string | null;
  generatedAt: string;
  parentVersions: Record<string, number>;
  editedBy: string | null;
  /** Keys that would go stale if this node were re-run. */
  wouldStale: string[];
  rebuildCostInr: number;
}

export interface NodesResponse {
  jobId: string;
  cards: NodeCard[];
  ledger: { rows: number; usd: number; inr: number };
  dedupe: {
    groups: { method: string; key?: string; winner: string; members: string[] }[];
    dropped: { photo_id: string; reason: string; duplicate_of: string }[];
  } | null;
  recipeNotes: string[];
  recipeProblems: string[];
}

export async function getNodes(jobId: string): Promise<NodesResponse> {
  const res = await fetch(`${SERVICE_URL}/jobs/${jobId}/nodes`, { cache: "no-store" });
  if (!res.ok) throw new Error(`nodes ${res.status}`);
  return res.json();
}

export async function getNodePayload(jobId: string, key: string) {
  const res = await fetch(`${SERVICE_URL}/jobs/${jobId}/nodes/${key}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`node ${res.status}`);
  return res.json();
}

export async function saveNodePayload(jobId: string, key: string, payload: unknown) {
  const res = await fetch(`${SERVICE_URL}/jobs/${jobId}/nodes/${key}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `save ${res.status}`);
  return body;
}

export async function regenerateNode(jobId: string, key: string) {
  const res = await fetch(`${SERVICE_URL}/jobs/${jobId}/nodes/${key}/regenerate`, {
    method: "POST",
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `regenerate ${res.status}`);
  return body;
}

export async function setNodeLock(jobId: string, key: string, locked: boolean) {
  const res = await fetch(`${SERVICE_URL}/jobs/${jobId}/nodes/${key}/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locked }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `lock ${res.status}`);
  return body;
}

export async function getRecipes(
  jobId: string,
): Promise<{ recipes: ReelRecipe[]; notes: string[]; problems: string[] }> {
  const res = await fetch(`${SERVICE_URL}/jobs/${jobId}/recipes`, { cache: "no-store" });
  if (!res.ok) throw new Error(`recipes ${res.status}`);
  return res.json();
}

export async function rebuildRecipes(jobId: string) {
  const res = await fetch(`${SERVICE_URL}/jobs/${jobId}/recipes/rebuild`, {
    method: "POST",
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `rebuild ${res.status}`);
  return body;
}

/** Photo urls in a recipe are service-relative; the browser needs them absolute. */
export function absolutiseRecipe(recipe: ReelRecipe): ReelRecipe {
  return {
    ...recipe,
    segments: recipe.segments.map((s) =>
      s.source.url?.startsWith("/")
        ? { ...s, source: { ...s.source, url: `${SERVICE_URL}${s.source.url}` } }
        : s,
    ),
  };
}

export const fmtMs = (ms: number) =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
export const fmtInr = (n: number) => `₹${n.toFixed(n < 1 ? 3 : 2)}`;
