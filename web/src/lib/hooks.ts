/**
 * Hook cards, exports and retunes, from the service.
 *
 * Generate is the only button in the studio that can spend real money, so the card
 * carries everything needed to decide before clicking: the concept, why it won, the
 * exact prompts that will be sent, the engine, the duration, the estimate, and the
 * pre_generation preflight that disables the button while anything BLOCKs.
 */
import { SERVICE_URL } from "./service";

export interface PreflightRow {
  rule_id: string;
  level: "PASS" | "WARN" | "BLOCK";
  message: string;
  evidence?: string;
}

export interface HookPlan {
  reel_n: number;
  concept_id: string;
  why?: string;
  scores: Record<string, number>;
  ranked_alternatives?: { concept_id: string; total: number }[];
  source_photo_id: string;
  source_crop_9x16?: { x_center: number; y_center: number; width_frac: number };
  generation_path: string;
  engine: string;
  still_prompt?: string;
  clip_prompt: string;
  prompt_template?: string;
  prompt_verified?: boolean;
  duration_s: number;
  usable_window_s: { start: number; end: number };
  truth_lock: { mode: string; frames: number };
  disclosure_label: string;
  est_cost: { total_usd: number; total_inr?: number; still_inr?: number; clip_usd?: number };
  fallback_concept: string;
}

export interface QAResult {
  pass: boolean;
  rejects_found: string[];
  diff_notes: string;
  concealment_target?: string | null;
  counts?: Record<string, { ref: number; gen: number }>;
}

export interface HookRecord {
  concept_id: string;
  planned_concept_id?: string;
  generation_path: string;
  fell_back: boolean;
  fallback_reason: string | null;
  attempts: { attempt: number; verdict: string; still_file?: string | null; q1: QAResult }[];
  q2: QAResult | null;
  reversed_duration_s?: number;
  window_start_s?: number;
  window_length_s?: number;
  clip_file?: string | null;
  cost: { inr: number; usd: number; rows: { stage: string; cost_inr: number }[] };
}

export interface ReelVersion {
  version: number;
  kind: "export" | "retune";
  status: "ok" | "blocked";
  blocked_by: string[];
  created_at: string;
  elapsed_ms: number;
  hook: {
    concept_id: string;
    generation_path: string;
    window_start_s: number | null;
    window_length_s: number | null;
    reversed_duration_s: number | null;
  };
  truth_lock: { at_s: number; done_s: number; ssim_hook_last_frame_vs_hero: number | null };
  disclosure: { label: string; cta_line: string | null } | null;
  files: { master: string; silent: string; sheet: string; lock_frame: string };
  video: { width: number; height: number; fps: string; duration_s: number; codec: string };
  segment_cache_hits: number;
  segments: number;
  ledger: { new_rows: number; cost_inr: number };
}

export interface HookReel {
  reel_n: number;
  format_id: string;
  tier: string;
  plan: HookPlan | null;
  preflight: { pass: boolean; results: PreflightRow[] } | null;
  generating: boolean;
  hook: HookRecord | null;
  versions: ReelVersion[];
}

export interface HooksResponse {
  jobId: string;
  reels: HookReel[];
  ledger: { rows: number; usd: number; inr: number };
  generativeEnabled: boolean;
}

export const fileUrl = (jobId: string, name: string) =>
  `${SERVICE_URL}/jobs/${jobId}/file/${encodeURIComponent(name)}`;

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `${res.status}`);
  return body as T;
}

export async function getHooks(jobId: string): Promise<HooksResponse> {
  return json(await fetch(`${SERVICE_URL}/jobs/${jobId}/hooks`, { cache: "no-store" }));
}

export async function generateHook(jobId: string, reelN: number) {
  return json(await fetch(`${SERVICE_URL}/jobs/${jobId}/hooks/${reelN}/generate`, { method: "POST" }));
}

export async function exportReel(jobId: string, reelN: number) {
  return json<{ version: ReelVersion }>(
    await fetch(`${SERVICE_URL}/jobs/${jobId}/reels/${reelN}/export`, { method: "POST" }),
  );
}

export async function retuneReel(jobId: string, reelN: number, windowStart: number, windowLength: number) {
  return json<{ free: boolean; version: ReelVersion }>(
    await fetch(`${SERVICE_URL}/jobs/${jobId}/retune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reelN, windowStart, windowLength }),
    }),
  );
}
