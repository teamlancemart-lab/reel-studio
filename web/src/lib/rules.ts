/**
 * Typed access to shared/rules.json. The web side reads the same file the service
 * reads; src/shared is a build-time copy kept in step by scripts/sync-shared.mjs.
 *
 * Nothing in this file re-states a value from rules.json. It only types it.
 */
import rulesJson from "@/shared/rules.json";
import costModelJson from "@/shared/cost-model.json";

export const rules = rulesJson;
export const costModel = costModelJson;

export interface TypeSystem {
  title_font: string;
  title_weight: number;
  title_case?: string;
  sub_font: string;
  sub_weight: number;
  sub_case?: string;
  pill: boolean;
  pill_alpha?: number;
  shadow?: boolean;
}

export const TYPE_SYSTEMS = rules.type_systems as unknown as Record<
  "sans_pill" | "serif_smallcaps",
  TypeSystem
>;

export const SAFE_ZONE_9X16 = rules.safe_zone_9x16 as {
  top_frac: number;
  bottom_frac: number;
  side_frac: number;
};

export const TIERS = rules.tiers as unknown as Record<
  "fast" | "medium" | "slow",
  { target_length_s: [number, number]; cut_every_beats: number }
>;

export const JOB_DEFAULTS = rules.job_defaults as {
  reels_per_job: number;
  master_aspect: string;
  fps: number;
  master_size_9x16: string;
  master_size_16x9: string;
  truth_lock_frames: number;
};

export const MAX_INTERIORS = rules.max_interiors as number;

export const RULES_VERSION = rules.version as string;
export const COST_MODEL_VERSION = costModel.version as string;
