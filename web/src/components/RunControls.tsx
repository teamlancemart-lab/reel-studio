"use client";

/**
 * Run controls and Generate. Everything a run will spend is decided here and priced
 * before the click, from the same cost-model.json the service bills the ledger with.
 *
 * The toggles travel with the job as per-job options. The service's env is only the
 * default, except that a server with GENERATIVE_ENABLED off refuses paid calls whatever
 * the page asks; the health line shows which server you are talking to.
 */
import { useEffect, useState } from "react";
import { getHealth, type HealthReport } from "@/lib/service";
import {
  BLOCK_USD,
  CONCEPTS,
  MAX_HERO_ROOMS,
  PAID_DEFAULTS,
  REEL_COUNT,
  WARN_USD,
  estimate,
  glidesUsd,
  hookUsd,
  inr,
  isPaidConcept,
  type RunOptions,
} from "@/lib/estimate";

interface Props {
  options: RunOptions;
  onChange: (o: RunOptions) => void;
  photoCount: number;
  onGenerate: () => void;
  generating: boolean;
  disabledReason: string | null;
}

export default function RunControls({ options, onChange, photoCount, onGenerate, generating, disabledReason }: Props) {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    getHealth(ac.signal)
      .then(setHealth)
      .catch((e) => {
        if (e?.name !== "AbortError") setHealthError(String(e.message ?? e));
      });
    return () => ac.abort();
  }, []);

  const est = estimate(options, Math.max(photoCount, 8));
  const set = (patch: Partial<RunOptions>) => onChange({ ...options, ...patch });
  const serverPaid = health?.vertex.generativeEnabled ?? false;
  const concepts = CONCEPTS.filter((c) => options.paidHook || !c.paid);
  const pct = Math.min(100, (est.high / BLOCK_USD) * 100);

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Run controls</h2>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${health ? "bg-emerald-950 text-emerald-300" : "bg-rose-950 text-rose-300"}`}
          title={health ? `${health.stage} · rules v${health.shared.rules}` : (healthError ?? "")}
        >
          {health ? `service ${health.stage}` : "service unreachable"}
        </span>
      </div>
      {health && (
        <p className="mb-3 text-[10px] text-neutral-500">
          server defaults: paid calls {serverPaid ? "allowed" : "OFF (kill switch)"} · interiors{" "}
          {health.interiorMotion ?? "2.5d"}. The toggles below win for this run.
        </p>
      )}

      {/* ---- paid hook */}
      <div className="rounded-lg border border-neutral-800 p-2.5">
        <label className="flex items-center justify-between text-[12px]">
          <span className="font-medium">Paid hook</span>
          <input
            type="checkbox"
            aria-label="Paid hook"
            checked={options.paidHook}
            disabled={!serverPaid}
            onChange={(e) => {
              const paidHook = e.target.checked;
              set({
                paidHook,
                hookConcepts: paidHook
                  ? [...PAID_DEFAULTS]
                  : options.hookConcepts.map((c, i) => (isPaidConcept(c) ? (i === 0 ? "blueprint_to_photo" : null) : c)),
              });
            }}
            className="h-4 w-4 accent-amber-400"
          />
        </label>
        <div className="mt-2 space-y-1.5">
          {Array.from({ length: REEL_COUNT }, (_, i) => {
            const value = options.hookConcepts[i] ?? "";
            const cost = value ? hookUsd(value) : null;
            return (
              <label key={i} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="w-12 text-neutral-400">Reel {i + 1}</span>
                <select
                  aria-label={`Reel ${i + 1} hook`}
                  value={value}
                  onChange={(e) => {
                    const next = [...options.hookConcepts];
                    next[i] = e.target.value || null;
                    set({ hookConcepts: next });
                  }}
                  className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-neutral-200"
                >
                  <option value="">auto (free)</option>
                  {concepts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.paid ? " · Veo" : ""}
                    </option>
                  ))}
                </select>
                <span className="w-24 text-right text-[10px] text-neutral-500">
                  {cost && cost.firstTryUsd ? `${inr(cost.firstTryUsd)} – ${inr(cost.withRerollUsd)}` : "free"}
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-1.5 text-[10px] text-neutral-500">
          Each Veo hook reveals the real hero photo and ends on it. A still that fails QA twice, or a clip that fails QA, falls back to a free hook.
        </p>
      </div>

      {/* ---- interior motion */}
      <div className="mt-2 rounded-lg border border-neutral-800 p-2.5">
        <div className="flex items-center justify-between text-[12px]">
          <span className="font-medium">Interior motion</span>
          <div className="flex overflow-hidden rounded-md border border-neutral-700 text-[11px]" role="group" aria-label="Interior motion">
            {(["2.5d", "veo"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={options.interiorMotion === m}
                disabled={m === "veo" && !serverPaid}
                onClick={() => set({ interiorMotion: m })}
                className={`px-2.5 py-1 disabled:opacity-40 ${options.interiorMotion === m ? "bg-amber-400 text-neutral-900" : "text-neutral-300"}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        {options.interiorMotion === "veo" && (
          <label className="mt-2 flex items-center justify-between text-[11px] text-neutral-400">
            <span>Hero rooms with a Veo glide</span>
            <span className="flex items-center gap-2">
              <input
                type="number"
                aria-label="Hero rooms"
                min={0}
                max={MAX_HERO_ROOMS}
                value={options.heroRooms}
                onChange={(e) => set({ heroRooms: Math.max(0, Math.min(MAX_HERO_ROOMS, Number(e.target.value) || 0)) })}
                className="w-14 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-right"
              />
              <span className="w-14 text-right text-neutral-500">{inr(glidesUsd(options.heroRooms))}</span>
            </span>
          </label>
        )}
        <p className="mt-1.5 text-[10px] text-neutral-500">
          {options.interiorMotion === "veo"
            ? "Kitchen, primary room, living space. A glide that changes any wall, door, window or fixture is rejected and that room stays 2.5d. Every glide carries an on-screen AI label."
            : "Real photos with parallax and Ken Burns. No generated interiors."}
        </p>
      </div>

      {/* ---- estimate */}
      <div className="mt-2 rounded-lg border border-neutral-800 p-2.5 text-[11px]">
        <div className="flex justify-between text-neutral-400">
          <span>brain ({Math.max(photoCount, 8)} photos)</span>
          <span>{inr(est.brain)}</span>
        </div>
        <div className="flex justify-between text-neutral-400">
          <span>hook</span>
          <span>{options.paidHook && est.hook.firstTryUsd ? `${inr(est.hook.firstTryUsd)} – ${inr(est.hook.withRerollUsd)}` : "₹0"}</span>
        </div>
        <div className="flex justify-between text-neutral-400">
          <span>interior glides</span>
          <span>{inr(est.glides)}</span>
        </div>
        <div className="mt-1 flex justify-between font-semibold">
          <span>estimate</span>
          <span className={est.warn ? "text-amber-300" : ""}>
            {inr(est.low)}
            {est.high > est.low ? ` – ${inr(est.high)}` : ""} · ${est.high.toFixed(2)}
          </span>
        </div>
        <div className="relative mt-1.5 h-1.5 rounded bg-neutral-950" aria-hidden>
          <div className={`h-full rounded ${est.warn ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
          <div className="absolute top-[-3px] h-3 w-px bg-amber-300" style={{ left: `${(WARN_USD / BLOCK_USD) * 100}%` }} />
        </div>
        <p className="mt-1 text-[10px] text-neutral-500">
          warn ${WARN_USD} · the service refuses any paid step past ${BLOCK_USD} per job
        </p>
      </div>

      <button
        onClick={onGenerate}
        disabled={generating || Boolean(disabledReason) || !health}
        className="mt-3 w-full rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-neutral-900 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {generating ? "Uploading…" : "Generate 3 reels"}
      </button>
      {disabledReason && <p className="mt-1.5 text-[10px] text-neutral-500">{disabledReason}</p>}
    </section>
  );
}
