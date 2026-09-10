"use client";

/**
 * One job, live. SSE drives it: every event schedules a re-fetch of the compact summary,
 * so what the page shows is always the service's own record of the job, not a client
 * reconstruction of it. The slim event list is kept only for what the summary cannot
 * know yet: the step that is running right now.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { streamJob, type JobEvent } from "@/lib/service";
import { getSummary, resumeJob, type JobSummary } from "@/lib/jobs";
import PipelineView from "./PipelineView";
import ResultsView from "./ResultsView";

export interface SlimEvent {
  seq: number;
  type: string;
  at: string;
  [k: string]: unknown;
}

/** Node events carry whole payloads and recipe events whole recipes; the summary has those. */
const HEAVY = new Set(["payload", "row", "recipes", "results"]);
function slimEvent(e: JobEvent): SlimEvent {
  return Object.fromEntries(Object.entries(e).filter(([k]) => !HEAVY.has(k))) as SlimEvent;
}

export default function JobView({ jobId, onFinished }: { jobId: string; onFinished?: () => void }) {
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [events, setEvents] = useState<SlimEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  /* A finished or failed job's stream closes. Resume bumps this to open a fresh one. */
  const [epoch, setEpoch] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(onFinished);
  useEffect(() => {
    finishedRef.current = onFinished;
  }, [onFinished]);

  const refresh = useCallback(() => {
    getSummary(jobId)
      .then((s) => {
        setSummary(s);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [jobId]);

  // Coalesce bursts (a render emits ten segment events in a second) into one fetch.
  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      refresh();
    }, 700);
  }, [refresh]);

  useEffect(() => {
    let live = true;
    getSummary(jobId)
      .then((s) => live && setSummary(s))
      .catch((e) => live && setError(String(e.message ?? e)));
    const close = streamJob(
      jobId,
      (e: JobEvent) => {
        if (!live) return;
        const slim = slimEvent(e);
        setEvents((prev) => (prev.length > 1500 ? [...prev.slice(-1000), slim] : [...prev, slim]));
        schedule();
      },
      () => {
        if (!live) return;
        refresh();
        finishedRef.current?.();
      },
    );
    return () => {
      live = false;
      close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId, refresh, schedule, epoch]);

  if (!summary) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-[12px] text-neutral-500">
        {error ?? `opening job ${jobId}…`}
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <PipelineView
        summary={summary}
        events={events}
        onResume={() => {
          resumeJob(jobId)
            .then(() => {
              // The new stream replays the whole event log from the start.
              setEvents([]);
              setEpoch((e) => e + 1);
            })
            .catch((e) => setError(String(e.message ?? e)));
        }}
      />
      <ResultsView summary={summary} onChanged={refresh} />
    </div>
  );
}
