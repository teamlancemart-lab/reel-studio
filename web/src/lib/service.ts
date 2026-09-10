/**
 * Client for the Railway render service.
 *
 * NEXT_PUBLIC_SERVICE_URL is the only variable /web needs. No GCP credentials ever
 * reach Vercel; every model call happens on the other side of this boundary.
 */
import type { StudioPhoto } from "./photos";
import type { Facts } from "./stub-recipe";
import { toServiceFacts } from "./facts";

export const SERVICE_URL = (
  process.env.NEXT_PUBLIC_SERVICE_URL || "http://localhost:8080"
).replace(/\/$/, "");

export interface HealthReport {
  ok: boolean;
  service: string;
  stage: string;
  node: string;
  shared: { rules: string; costModel: string; schemas: string };
  ffmpeg: { ok: boolean; version?: string; hasDrawtext?: boolean; error?: string };
  python: { ok: boolean; python?: string; pillow?: string; error?: string };
  fonts: { ok: boolean; present: string[]; missing: string[] };
  vertex: { generativeEnabled: boolean; credentialsConfigured: boolean };
  interiorMotion?: "2.5d" | "veo";
}

export async function getHealth(signal?: AbortSignal): Promise<HealthReport> {
  const res = await fetch(`${SERVICE_URL}/health`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}

export interface JobEvent {
  seq: number;
  type: string;
  at: string;
  stage?: string;
  progress?: number;
  reason?: string;
  photoId?: string;
  note?: string;
  [k: string]: unknown;
}

export async function submitJob(photos: StudioPhoto[], facts: Facts, options?: Record<string, unknown>) {
  const form = new FormData();
  const buckets: Record<string, string> = {};
  for (const p of photos) {
    form.append("photos", p.blob, p.filename);
    buckets[p.filename] = p.bucket;
  }
  form.append("facts", JSON.stringify(toServiceFacts(facts)));
  form.append("buckets", JSON.stringify(buckets));
  if (options) form.append("options", JSON.stringify(options));

  const res = await fetch(`${SERVICE_URL}/jobs`, { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `jobs ${res.status}`);
  return body as { jobId: string; photoCount: number };
}

/**
 * Subscribes to the job SSE stream. The service replays the whole event log on
 * connect, so a late subscriber sees the complete job rather than joining halfway.
 */
export function streamJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  onDone: () => void,
): () => void {
  const source = new EventSource(`${SERVICE_URL}/jobs/${jobId}/events`);
  const handle = (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* a malformed frame is not worth killing the stream over */
    }
  };
  for (const type of [
    "stage",
    "ledger",
    "artefact",
    "excluded",
    "node",
    "dedupe",
    "recipes",
    "preflight",
    "hook",
    "interior",
    "render",
    "run_issue",
    "ledger_total",
    "completed",
    "failed",
  ]) {
    source.addEventListener(type, handle as EventListener);
  }
  source.addEventListener("eof", () => {
    source.close();
    onDone();
  });
  source.onerror = () => {
    source.close();
    onDone();
  };
  return () => source.close();
}
