"use client";

/**
 * Hook cards, retune sliders and the version list.
 *
 * Two kinds of button live here and the panel keeps them visibly apart: Generate can
 * spend money and is disabled while pre_generation preflight BLOCKs; Export and Retune
 * are ffmpeg only and say FREE, and every version shows the ledger rows it added so the
 * label is checkable.
 */
import { useCallback, useEffect, useState } from "react";
import { fmtInr } from "@/lib/nodes";
import {
  exportReel,
  fileUrl,
  generateHook,
  getHooks,
  retuneReel,
  type HookReel,
  type HooksResponse,
} from "@/lib/hooks";

export default function HookPanel({ jobId }: { jobId: string }) {
  const [data, setData] = useState<HooksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    getHooks(jobId).then(setData).catch((e) => setError(String(e.message)));
  }, [jobId]);

  useEffect(() => {
    getHooks(jobId).then(setData).catch((e) => setError(String(e.message)));
  }, [jobId]);

  // A paid hook takes a minute or two; poll while any reel is generating.
  const anyGenerating = data?.reels.some((r) => r.generating) ?? false;
  useEffect(() => {
    if (!anyGenerating) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyGenerating, load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      load();
    }
  };

  if (!data) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-[11px] text-neutral-500">
        {error ?? "loading hooks…"}
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Hooks & export</h2>
        <span className="text-[11px] text-neutral-500">job ledger {fmtInr(data.ledger.inr)}</span>
      </div>
      <p className="mb-3 text-[11px] text-neutral-500">
        Paid video is {data.generativeEnabled ? "enabled" : "gated (GENERATIVE_ENABLED is off)"}.
        Export and retune never call a model.
      </p>
      {error && (
        <p className="mb-2 rounded-md border border-rose-900/60 bg-rose-950/30 p-2 text-[11px] text-rose-300">
          {error}
        </p>
      )}
      <div className="space-y-3">
        {data.reels.map((reel) => (
          <ReelCard
            key={reel.reel_n}
            reel={reel}
            jobId={jobId}
            generativeEnabled={data.generativeEnabled}
            busy={busy}
            act={act}
          />
        ))}
      </div>
    </section>
  );
}

function ReelCard({
  reel,
  jobId,
  generativeEnabled,
  busy,
  act,
}: {
  reel: HookReel;
  jobId: string;
  generativeEnabled: boolean;
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { plan, preflight, hook } = reel;
  const paidPlan = plan && plan.generation_path !== "free_2p5d";
  const blocks = preflight?.results.filter((r) => r.level === "BLOCK") ?? [];
  const reversed = hook?.reversed_duration_s ?? 8;
  const [windowLength, setWindowLength] = useState(2.2);
  const [windowStart, setWindowStart] = useState(Math.max(0, reversed - 2.2));
  const k = (s: string) => `${reel.reel_n}:${s}`;

  const generateDisabled =
    !plan || reel.generating || blocks.length > 0 || (paidPlan && !generativeEnabled) || busy !== null;
  const paidHookReady = hook?.generation_path === "reverse_conceal";

  return (
    <div className="rounded-lg border border-neutral-800 p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] text-amber-400">reel {reel.reel_n}</span>
        <span className="text-[11px] text-neutral-400">
          {reel.format_id} · {reel.tier}
        </span>
      </div>

      {!plan ? (
        <p className="mt-1 text-[11px] text-neutral-500">no B4 plan yet</p>
      ) : (
        <>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] font-semibold">{plan.concept_id}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ${paidPlan ? "bg-amber-900/50 text-amber-300" : "bg-emerald-900/40 text-emerald-300"}`}
            >
              {paidPlan ? `paid · est ${fmtInr(plan.est_cost.total_inr ?? plan.est_cost.total_usd * 84)}` : "free"}
            </span>
            <span className="text-[10px] text-neutral-500">
              {plan.engine} · {plan.duration_s || "—"}s · score {plan.scores.total?.toFixed(2)}
            </span>
          </div>
          {plan.why && <p className="mt-1 text-[11px] text-neutral-400">{plan.why}</p>}

          <details className="mt-1.5">
            <summary className="cursor-pointer text-[10px] text-neutral-500">
              prompts sent{plan.prompt_template ? ` · ${plan.prompt_template}` : ""}
            </summary>
            {plan.still_prompt && (
              <pre className="mt-1 whitespace-pre-wrap rounded bg-neutral-950 p-1.5 text-[10px] text-neutral-300">
                {plan.still_prompt}
              </pre>
            )}
            <pre className="mt-1 whitespace-pre-wrap rounded bg-neutral-950 p-1.5 text-[10px] text-neutral-300">
              {plan.clip_prompt}
            </pre>
            <p className="mt-1 text-[10px] text-neutral-500">
              source {plan.source_photo_id} · crop x {plan.source_crop_9x16?.x_center ?? "—"} · truth lock{" "}
              {plan.truth_lock.frames} frames · fallback {plan.fallback_concept}
            </p>
          </details>

          {blocks.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 rounded border border-rose-900/60 bg-rose-950/30 p-1.5 text-[10px] text-rose-300">
              {blocks.map((b) => (
                <li key={b.rule_id}>
                  <span className="font-mono">{b.rule_id}</span> — {b.evidence ?? b.message}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => act(k("gen"), () => generateHook(jobId, reel.reel_n))}
              disabled={generateDisabled}
              title={blocks.length ? "pre_generation preflight BLOCKs" : undefined}
              className="rounded bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-neutral-900 disabled:opacity-40"
            >
              {reel.generating ? "Generating…" : hook ? "Regenerate hook" : "Generate hook"}
            </button>
            <button
              onClick={() => act(k("export"), () => exportReel(jobId, reel.reel_n))}
              disabled={!hook || busy !== null}
              className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] hover:border-neutral-500 disabled:opacity-40"
            >
              {busy === k("export") ? "Rendering…" : "Export"} <span className="text-emerald-300">free</span>
            </button>
          </div>
        </>
      )}

      {hook && (
        <div className="mt-2 rounded border border-neutral-800 p-1.5 text-[10px] text-neutral-400">
          <p>
            hook <span className="text-neutral-200">{hook.concept_id}</span> · {hook.generation_path} · cost{" "}
            {fmtInr(hook.cost.inr)}
            {hook.fell_back && <span className="text-amber-300"> · fell back: {hook.fallback_reason}</span>}
          </p>
          {hook.attempts.map((a) => (
            <p key={a.attempt} className={a.verdict === "approved" ? "text-emerald-300" : "text-rose-300"}>
              Q1 attempt {a.attempt}: {a.verdict}
              {a.q1.rejects_found.length > 0 && ` — ${a.q1.rejects_found.join("; ")}`}
              {a.still_file && (
                <a className="ml-1 underline" href={fileUrl(jobId, a.still_file)} target="_blank" rel="noreferrer">
                  still
                </a>
              )}
            </p>
          ))}
          {hook.q2 && (
            <p className={hook.q2.pass ? "text-emerald-300" : "text-rose-300"}>
              Q2: {hook.q2.pass ? "pass" : `fail — ${hook.q2.rejects_found.join("; ")}`}
            </p>
          )}
        </div>
      )}

      {paidHookReady && (
        <div className="mt-2 rounded border border-emerald-900/50 bg-emerald-950/10 p-1.5">
          <p className="text-[10px] text-emerald-300">Retune · free · re-cuts the reversed clip, no model call</p>
          <label className="mt-1 flex items-center gap-2 text-[10px] text-neutral-400">
            start
            <input
              type="range"
              min={0}
              max={Math.max(0, reversed - windowLength)}
              step={0.1}
              value={Math.min(windowStart, reversed - windowLength)}
              onChange={(e) => setWindowStart(Number(e.target.value))}
              className="flex-1 accent-emerald-400"
            />
            <span className="w-10 font-mono">{windowStart.toFixed(1)}s</span>
          </label>
          <label className="flex items-center gap-2 text-[10px] text-neutral-400">
            length
            <input
              type="range"
              min={2}
              max={3}
              step={0.1}
              value={windowLength}
              onChange={(e) => setWindowLength(Number(e.target.value))}
              className="flex-1 accent-emerald-400"
            />
            <span className="w-10 font-mono">{windowLength.toFixed(1)}s</span>
          </label>
          <button
            onClick={() => act(k("retune"), () => retuneReel(jobId, reel.reel_n, windowStart, windowLength))}
            disabled={busy !== null}
            className="mt-1 rounded border border-emerald-800 px-2.5 py-1 text-[11px] text-emerald-300 disabled:opacity-40"
          >
            {busy === k("retune") ? "Rendering…" : "Retune (free)"}
          </button>
        </div>
      )}

      {reel.versions.length > 0 && (
        <ol className="mt-2 space-y-1">
          {[...reel.versions].reverse().map((v) => (
            <li key={v.version} className="rounded border border-neutral-800 p-1.5 text-[10px] text-neutral-400">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-neutral-200">v{v.version}</span>
                <span>{v.kind}</span>
                <span className={v.status === "ok" ? "text-emerald-300" : "text-rose-300"}>{v.status}</span>
                {v.hook.window_start_s != null && (
                  <span>
                    window {v.hook.window_start_s.toFixed(2)}–{(v.hook.window_start_s + (v.hook.window_length_s ?? 0)).toFixed(2)}s
                  </span>
                )}
                <span>
                  {v.video.width}x{v.video.height} · {v.video.duration_s}s
                </span>
                <span className={v.ledger.new_rows === 0 ? "text-emerald-300" : "text-amber-300"}>
                  +{v.ledger.new_rows} ledger rows · {fmtInr(v.ledger.cost_inr)}
                </span>
              </div>
              {v.blocked_by.length > 0 && <p className="text-rose-300">{v.blocked_by.join(" | ")}</p>}
              <p className="mt-0.5">
                truth lock at {v.truth_lock.done_s}s · SSIM vs hero {v.truth_lock.ssim_hook_last_frame_vs_hero ?? "—"}
                {v.disclosure && ` · label "${v.disclosure.label}"`}
              </p>
              <p className="mt-0.5 space-x-2">
                <a className="underline" href={fileUrl(jobId, v.files.master)} target="_blank" rel="noreferrer">
                  mp4
                </a>
                <a className="underline" href={fileUrl(jobId, v.files.silent)} target="_blank" rel="noreferrer">
                  silent
                </a>
                <a className="underline" href={fileUrl(jobId, v.files.sheet)} target="_blank" rel="noreferrer">
                  sheet
                </a>
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
