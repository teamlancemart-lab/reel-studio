"use client";

/**
 * Every job on the service: open it (the page's ?job=<id>), see its status and ledger,
 * and duplicate it — the same photos, no re-upload, different run controls — to compare
 * 2.5d against veo on one listing.
 */
import { useCallback, useEffect, useState } from "react";
import { duplicateJob, fmtInr, listJobs, type JobListItem } from "@/lib/jobs";
import { toRequestOptions, type RunOptions } from "@/lib/estimate";

interface Props {
  currentJobId: string | null;
  options: RunOptions;
  onOpen: (jobId: string) => void;
  refreshKey: number;
}

export default function JobHistory({ currentJobId, options, onOpen, refreshKey }: Props) {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState("");

  const load = useCallback(() => {
    listJobs()
      .then((j) => {
        setJobs(j);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    let live = true;
    listJobs()
      .then((j) => live && setJobs(j))
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const duplicate = async (jobId: string) => {
    setBusy(jobId);
    setError(null);
    try {
      const { jobId: id } = await duplicateJob(jobId, toRequestOptions(options));
      load();
      onOpen(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4" aria-label="Job history">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Jobs</h2>
        <button onClick={load} className="text-[11px] text-neutral-400 hover:text-neutral-200">
          refresh
        </button>
      </div>
      <form
        className="mb-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (openId.trim()) onOpen(openId.trim());
        }}
      >
        <input
          value={openId}
          onChange={(e) => setOpenId(e.target.value)}
          placeholder="open job by id"
          aria-label="Job id"
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-[11px]"
        />
        <button className="rounded border border-neutral-700 px-2 text-[11px]">Open</button>
      </form>
      {error && <p className="mb-2 text-[11px] text-rose-300">{error}</p>}
      <p className="mb-2 text-[10px] text-neutral-500">
        Duplicate re-runs a job&apos;s photos with the run controls above. The brain is reused, so only the hooks, glides and
        exports run again.
      </p>
      <ul className="max-h-96 space-y-1.5 overflow-auto">
        {jobs.map((j) => (
          <li
            key={j.jobId}
            className={`rounded border p-2 text-[11px] ${j.jobId === currentJobId ? "border-amber-400/60" : "border-neutral-800"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <button onClick={() => onOpen(j.jobId)} className="min-w-0 truncate text-left font-mono text-amber-400 hover:underline">
                {j.jobId.slice(0, 8)}
              </button>
              <span className={j.status === "failed" ? "text-rose-300" : j.status === "completed" ? "text-emerald-300" : "text-amber-300"}>
                {j.status}
              </span>
            </div>
            <p className="truncate text-neutral-400">{j.address ?? "—"}</p>
            <p className="text-[10px] text-neutral-500">
              {new Date(j.createdAt).toLocaleString()} · {j.photoCount} photos · {j.reels} reels · {fmtInr(j.ledger.inr)}
            </p>
            <p className="text-[10px] text-neutral-500">
              {j.options
                ? `paid hook ${j.options.paidHook ? `on (${j.options.hookConcept ?? "auto"})` : "off"} · interiors ${j.options.interiorMotion}${j.options.interiorMotion === "veo" ? ` × ${j.options.heroRooms}` : ""}`
                : "no run options (created before the dashboard)"}
              {j.duplicateOf ? ` · dup of ${j.duplicateOf.slice(0, 8)}` : ""}
            </p>
            <button
              onClick={() => duplicate(j.jobId)}
              disabled={busy !== null}
              className="mt-1 rounded border border-neutral-700 px-2 py-0.5 text-[10px] hover:border-neutral-500 disabled:opacity-40"
            >
              {busy === j.jobId ? "Duplicating…" : "Duplicate with current controls"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
