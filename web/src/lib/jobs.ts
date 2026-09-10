/**
 * Job summary, history and duplicate, from the service. The dashboard's live view is a
 * pure function of GET /jobs/:id/summary, re-fetched whenever an SSE event lands.
 */
import { SERVICE_URL } from "./service";

export interface LedgerRow {
  stage: string;
  provider_model: string;
  units: number;
  unit_type: string;
  cost_usd: number;
  cost_inr: number;
  status: string;
  note: string | null;
  created_at: string;
}

export interface QA {
  pass: boolean;
  rejects_found: string[];
  diff_notes: string;
  concealment_target?: string | null;
}

export interface HookAttempt {
  attempt: number;
  verdict: "approved" | "rejected";
  still_file?: string | null;
  q1: QA;
}

export interface HookRecord {
  concept_id: string;
  planned_concept_id?: string;
  generation_path: string;
  fell_back: boolean;
  fallback_reason: string | null;
  attempts: HookAttempt[];
  q2: QA | null;
  clip_file?: string | null;
  forward_file?: string | null;
  hero_file?: string | null;
  qa_frames?: (string | null)[];
  cost: { inr: number; usd: number };
  created_at: string;
}

export interface GlideRecord {
  photo_id: string;
  category: string;
  room_class: string;
  status: "approved" | "rejected" | "failed" | "skipped";
  reason: string | null;
  clip_file?: string | null;
  qa_files?: (string | null)[];
  cost?: { inr: number };
  created_at: string;
}

export interface Version {
  version: number;
  kind: "export" | "retune";
  status: "ok" | "blocked";
  blocked_by: string[];
  created_at: string;
  elapsed_ms: number;
  hook: { concept_id: string; generation_path: string; window_start_s: number | null; window_length_s: number | null; reversed_duration_s: number | null };
  truth_lock: { done_s: number; ssim_hook_last_frame_vs_hero: number | null };
  disclosure: { label: string | null; motion_label?: string | null; cta_line: string | null } | null;
  interior_motion?: string;
  glides?: { photo_id: string; used: boolean; status: string; reason?: string }[];
  files: { master: string; silent: string; sheet: string; lock_frame: string };
  video: { width: number; height: number; fps: string; duration_s: number; bytes: number };
  preflight: { rule_id: string; level: string; evidence?: string }[];
  ledger: { new_rows: number; cost_inr: number };
}

export interface NodeSummary {
  key: string;
  node: string;
  reelN: number | null;
  label: string;
  status: string;
  version: number;
  model: string;
  costInr: number;
  elapsedMs: number;
  attempts: number;
  locked: boolean;
  stale: boolean;
  failureReason: string | null;
  copiedFrom: string | null;
  concept?: string;
}

export interface EffectiveOptions {
  generative: boolean;
  paidHook: boolean;
  interiorMotion: "2.5d" | "veo";
  heroRooms: number;
  hookConcept: string | null;
  notes: string[];
  env: { GENERATIVE_ENABLED: boolean; INTERIOR_MOTION: string };
}

export interface JobSummary {
  jobId: string;
  status: string;
  stage: string;
  progress: number;
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
  duplicateOf: string | null;
  reusedBrain: string[];
  facts: Record<string, unknown>;
  photoCount: number;
  options: { requested: Record<string, unknown>; effective: EffectiveOptions } | null;
  flags: { generative: boolean; paidHook: boolean; interiorMotion: string; heroRooms: number; hookConcept: string | null };
  nodes: NodeSummary[];
  hooks: Record<string, HookRecord>;
  hookHistory: Record<string, HookRecord[]>;
  interiorClips: Record<string, GlideRecord>;
  reels: Record<string, Version[]>;
  recipes: { reelId: string; tier: string; durationS: number }[];
  runIssues: { step: string; reel_n: number | null; message: string }[];
  ledger: LedgerRow[];
  ledgerTotals: { rows: number; usd: number; inr: number };
  guards: { warnUsd: number; blockUsd: number; usdInr: number };
}

export interface JobListItem {
  jobId: string;
  status: string;
  stage: string;
  progress: number;
  photoCount: number;
  createdAt: string;
  address: string | null;
  options: EffectiveOptions | null;
  duplicateOf: string | null;
  reels: number;
  failureReason: string | null;
  ledger: { rows: number; usd: number; inr: number };
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string })?.error || `${res.status}`);
  return body as T;
}

export const fileUrl = (jobId: string, name: string, download = false) =>
  `${SERVICE_URL}/jobs/${jobId}/file/${encodeURIComponent(name)}${download ? "?download=1" : ""}`;

export const getSummary = async (jobId: string) =>
  json<JobSummary>(await fetch(`${SERVICE_URL}/jobs/${jobId}/summary`, { cache: "no-store" }));

export const listJobs = async () => json<JobListItem[]>(await fetch(`${SERVICE_URL}/jobs`, { cache: "no-store" }));

export async function duplicateJob(jobId: string, options: Record<string, unknown>, reuseBrain = true) {
  return json<{ jobId: string; reusedBrain: string[] }>(
    await fetch(`${SERVICE_URL}/jobs/${jobId}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ options, reuseBrain }),
    }),
  );
}

export async function retune(jobId: string, reelN: number, windowStart: number | null = null, windowLength?: number) {
  return json<{ free: boolean; version: Version }>(
    await fetch(`${SERVICE_URL}/jobs/${jobId}/retune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reelN, windowStart, windowLength }),
    }),
  );
}

export const fmtInr = (n: number) => `₹${n.toFixed(n < 1 ? 3 : 2)}`;
export const fmtS = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

export async function resumeJob(jobId: string) {
  return json<{ ok: boolean }>(await fetch(`${SERVICE_URL}/jobs/${jobId}/resume`, { method: "POST" }));
}
