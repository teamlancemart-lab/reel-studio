"use client";

/**
 * The three reels, playable, with downloads; the ledger line by line; the job total
 * against the $1.50 warning line; and a free Retune per reel.
 */
import { useState } from "react";
import { fileUrl, fmtInr, fmtS, retune, type JobSummary } from "@/lib/jobs";

export default function ResultsView({ summary: s, onChanged }: { summary: JobSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reels = Object.entries(s.reels).sort(([a], [b]) => Number(a) - Number(b));
  const usd = s.ledgerTotals.usd;
  const pct = Math.min(100, (usd / s.guards.blockUsd) * 100);

  const doRetune = async (reelN: number, windowStart: number | null) => {
    setBusy(reelN);
    setError(null);
    try {
      await retune(s.jobId, reelN, windowStart);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4" aria-label="Results">
      <h2 className="text-sm font-semibold">Reels</h2>
      {reels.length === 0 && <p className="mt-1 text-[11px] text-neutral-500">The finished reels appear here as each export lands.</p>}
      {error && <p className="mt-2 rounded border border-rose-900/60 bg-rose-950/30 p-2 text-[11px] text-rose-300">{error}</p>}

      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {reels.map(([n, versions]) => {
          const reelN = Number(n);
          const latest = [...versions].reverse().find((v) => v.status === "ok") ?? versions[versions.length - 1];
          const recipe = s.recipes.find((r) => r.reelId === `reel-${n}`);
          const paid = latest.hook.generation_path === "reverse_conceal";
          return (
            <ReelCard
              key={n}
              jobId={s.jobId}
              reelN={reelN}
              tier={recipe?.tier}
              latest={latest}
              versionCount={versions.length}
              paid={paid}
              busy={busy === reelN}
              onRetune={(start) => doRetune(reelN, start)}
            />
          );
        })}
      </div>

      <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Ledger</h3>
      <div className="mt-1 flex items-center gap-3 text-[12px]">
        <span className="font-semibold">
          {fmtInr(s.ledgerTotals.inr)} · ${usd.toFixed(3)}
        </span>
        <div className="relative h-2 flex-1 rounded bg-neutral-950" aria-label="job total against the warning line">
          <div className={`h-full rounded ${usd > s.guards.warnUsd ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
          <div className="absolute top-[-4px] h-4 w-px bg-amber-300" style={{ left: `${(s.guards.warnUsd / s.guards.blockUsd) * 100}%` }} />
        </div>
        <span className="text-[10px] text-neutral-500">
          warn ${s.guards.warnUsd} · block ${s.guards.blockUsd}
        </span>
      </div>
      {s.duplicateOf && (
        <p className="mt-1 text-[10px] text-neutral-500">
          Brain reused from job {s.duplicateOf.slice(0, 8)}; its cost is on that job&apos;s ledger, not this one.
        </p>
      )}
      <div className="mt-2 max-h-72 overflow-auto rounded border border-neutral-800">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-neutral-900 text-neutral-500">
            <tr>
              <th className="px-2 py-1">stage</th>
              <th className="px-2 py-1">model</th>
              <th className="px-2 py-1">status</th>
              <th className="px-2 py-1 text-right">units</th>
              <th className="px-2 py-1 text-right">₹</th>
            </tr>
          </thead>
          <tbody>
            {s.ledger.map((r, i) => (
              <tr key={i} className="border-t border-neutral-800">
                <td className="px-2 py-0.5 font-mono text-amber-400">{r.stage}</td>
                <td className="px-2 py-0.5 text-neutral-400">{r.provider_model}</td>
                <td className={`px-2 py-0.5 ${r.status === "failed" ? "text-rose-300" : "text-neutral-400"}`}>
                  {r.status}
                  {r.note && r.status !== "submitted" ? <span className="block text-[10px] text-neutral-500">{r.note.slice(0, 80)}</span> : null}
                </td>
                <td className="px-2 py-0.5 text-right font-mono text-neutral-500">
                  {r.units} {r.unit_type}
                </td>
                <td className="px-2 py-0.5 text-right font-mono">{r.cost_inr.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReelCard({
  jobId,
  reelN,
  tier,
  latest,
  versionCount,
  paid,
  busy,
  onRetune,
}: {
  jobId: string;
  reelN: number;
  tier?: string;
  latest: JobSummary["reels"][string][number];
  versionCount: number;
  paid: boolean;
  busy: boolean;
  onRetune: (windowStart: number | null) => void;
}) {
  const reversed = latest.hook.reversed_duration_s ?? 8;
  const len = latest.hook.window_length_s ?? 2.2;
  const [start, setStart] = useState(latest.hook.window_start_s ?? Math.max(0, reversed - len));
  return (
    <div className="rounded-lg border border-neutral-800 p-2">
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="font-mono text-amber-400">reel {reelN}</span>
        <span className="text-neutral-500">
          {tier} · v{latest.version} of {versionCount} · {latest.video.duration_s}s
        </span>
      </div>
      <video
        key={latest.files.master}
        src={`${fileUrl(jobId, latest.files.master)}#t=0.5`}
        controls
        playsInline
        preload="metadata"
        className="aspect-[9/16] w-full rounded bg-black"
        aria-label={`reel ${reelN}`}
      />
      <p className="mt-1 text-[10px] text-neutral-500">
        hook {latest.hook.concept_id} · interiors {latest.interior_motion ?? "2.5d"}
        {latest.glides?.filter((g) => g.used).length ? ` (${latest.glides.filter((g) => g.used).length} glides)` : ""} · rendered in{" "}
        {fmtS(latest.elapsed_ms)}
      </p>
      {latest.status !== "ok" && <p className="text-[10px] text-rose-300">{latest.blocked_by.join(" | ")}</p>}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <a
          href={fileUrl(jobId, latest.files.master, true)}
          className="rounded bg-amber-400 px-2 py-1 text-[11px] font-semibold text-neutral-900"
        >
          Download
        </a>
        <a href={fileUrl(jobId, latest.files.silent, true)} className="rounded border border-neutral-700 px-2 py-1 text-[11px]">
          Silent
        </a>
        <button
          onClick={() => onRetune(paid ? start : null)}
          disabled={busy}
          className="rounded border border-emerald-800 px-2 py-1 text-[11px] text-emerald-300 disabled:opacity-40"
        >
          {busy ? "Rendering…" : "Retune (free)"}
        </button>
      </div>
      {paid && (
        <label className="mt-1.5 flex items-center gap-2 text-[10px] text-neutral-400">
          hook window
          <input
            type="range"
            min={0}
            max={Math.max(0, reversed - len)}
            step={0.1}
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
            className="flex-1"
          />
          <span className="w-9 font-mono">{start.toFixed(1)}s</span>
        </label>
      )}
      <p className="mt-1 text-[10px] text-neutral-500">
        +{latest.ledger.new_rows} ledger rows · {fmtInr(latest.ledger.cost_inr)}
      </p>
    </div>
  );
}
