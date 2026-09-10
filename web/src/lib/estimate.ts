/**
 * Live cost estimate for the run controls, from the same cost-model.json the service
 * prices the ledger with (web/src/shared is a checked copy of /shared).
 *
 * Mirrors service/src/brain/nodes.js hookEstimate and service/src/interiors/glide.js
 * glideEstimate: a paid hook is still + Q1 + Veo + Q2 plus one still-and-Q1 reroll
 * allowance; a glide is a 4s clip + interior Q2 with no reroll.
 */
import costModelJson from "@/shared/cost-model.json";
import rulesJson from "@/shared/rules.json";

type Rate = { usd_per_m_input?: number; usd_per_m_output?: number; usd_per_image_1024?: number; usd_per_s?: number };
type Q = { model: string; in_tokens: number; out_tokens: number };

const cm = costModelJson as unknown as {
  fx: { usd_inr: number };
  providers: { vertex: Record<string, Rate> };
  brain_nodes: { node: string; model: string; calls?: number; calls_formula?: string; in_tokens_per_call: number; out_tokens_per_call: number }[];
  hook_path: Record<string, { still?: { model: string; images?: number }; q1?: Q; clip?: { model: string; duration_s?: number }; q2?: Q }>;
  hook_duration_by_concept_s: Record<string, number>;
  interior_motion: { clip: { model: string; duration_s: number }; q2: Q };
  guards: { warn_above_usd_per_listing: number; block_above_usd_per_listing: number };
};
const rules = rulesJson as unknown as { hook_bank: { id: string; label: string; default_path: string }[]; interior_motion: { max_hero_interiors: number } };

const v = cm.providers.vertex;
const tokens = (q?: Q) => (q ? (q.in_tokens / 1e6) * (v[q.model].usd_per_m_input ?? 0) + (q.out_tokens / 1e6) * (v[q.model].usd_per_m_output ?? 0) : 0);

export const USD_INR = cm.fx.usd_inr;
export const WARN_USD = cm.guards.warn_above_usd_per_listing;
export const BLOCK_USD = cm.guards.block_above_usd_per_listing;
export const MAX_HERO_ROOMS = rules.interior_motion.max_hero_interiors;

export const CONCEPTS = [
  { id: "block_build", name: "Build itself" },
  { id: "helicopter_drape", name: "Helicopter drape" },
  { id: "sky_drop", name: "Sky drop" },
  { id: "blueprint_to_photo", name: "Blueprint" },
].map((c) => ({ ...c, paid: rules.hook_bank.find((h) => h.id === c.id)?.default_path !== "free_2p5d" }));

export function brainUsd(photoCount: number, reels = 3) {
  return cm.brain_nodes.reduce((sum, n) => {
    const rate = v[n.model];
    if (!rate) return sum;
    const calls = n.calls_formula === "ceil(photo_count/5)" ? Math.max(1, Math.ceil(photoCount / 5)) : n.calls_formula === "reel_count" ? reels : (n.calls ?? 1);
    return sum + calls * ((n.in_tokens_per_call / 1e6) * (rate.usd_per_m_input ?? 0) + (n.out_tokens_per_call / 1e6) * (rate.usd_per_m_output ?? 0));
  }, 0);
}

/** { firstTryUsd, withRerollUsd } for a paid concept; zeros for a free one. */
export function hookUsd(conceptId: string) {
  const paid = CONCEPTS.find((c) => c.id === conceptId)?.paid;
  if (!paid) return { firstTryUsd: 0, withRerollUsd: 0 };
  const spec = cm.hook_path.reverse_conceal;
  const still = spec.still ? (v[spec.still.model].usd_per_image_1024 ?? 0) * (spec.still.images ?? 1) : 0;
  const seconds = spec.clip?.duration_s ?? cm.hook_duration_by_concept_s[conceptId] ?? 8;
  const clip = spec.clip ? (v[spec.clip.model].usd_per_s ?? 0) * seconds : 0;
  const first = still + tokens(spec.q1) + clip + tokens(spec.q2);
  return { firstTryUsd: first, withRerollUsd: first + still + tokens(spec.q1) };
}

export function glidesUsd(count: number) {
  const s = cm.interior_motion;
  return count * ((v[s.clip.model].usd_per_s ?? 0) * s.clip.duration_s + tokens(s.q2));
}

export interface RunOptions {
  paidHook: boolean;
  hookConcept: string;
  interiorMotion: "2.5d" | "veo";
  heroRooms: number;
}

export const DEFAULT_OPTIONS: RunOptions = { paidHook: false, hookConcept: "blueprint_to_photo", interiorMotion: "2.5d", heroRooms: 3 };

/** What the service is sent. generative covers both paid steps; paidHook is its own gate. */
export function toRequestOptions(o: RunOptions) {
  const conceptPaid = CONCEPTS.find((c) => c.id === o.hookConcept)?.paid ?? false;
  return {
    generative: o.paidHook || o.interiorMotion === "veo",
    paidHook: o.paidHook,
    hookConcept: !o.paidHook && conceptPaid ? undefined : o.hookConcept,
    interiorMotion: o.interiorMotion,
    heroRooms: o.interiorMotion === "veo" ? o.heroRooms : 0,
  };
}

export function estimate(o: RunOptions, photoCount: number) {
  const brain = brainUsd(photoCount);
  const hook = o.paidHook ? hookUsd(o.hookConcept) : { firstTryUsd: 0, withRerollUsd: 0 };
  const glides = o.interiorMotion === "veo" ? glidesUsd(o.heroRooms) : 0;
  const low = brain + hook.firstTryUsd + glides;
  const high = brain + hook.withRerollUsd + glides;
  return { brain, hook, glides, low, high, warn: high > WARN_USD, block: high > BLOCK_USD };
}

export const inr = (usd: number) => `₹${(usd * USD_INR).toFixed(usd * USD_INR < 10 ? 2 : 1)}`;
