"use client";

/**
 * The Railway side, from the browser. In D1 the job only saves files and returns
 * dimensions, so this panel proves the boundary works: /health from the deployed web
 * app, a real multipart upload, and the SSE stream replaying every stage.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SERVICE_URL,
  getHealth,
  streamJob,
  submitJob,
  type HealthReport,
  type JobEvent,
} from "@/lib/service";
import type { StudioPhoto } from "@/lib/photos";
import type { Facts } from "@/lib/stub-recipe";

interface Props {
  photos: StudioPhoto[];
  facts: Facts;
  /** Fires when a job is accepted, and again when it finishes, so the page can
      swap the canvas from the stub recipe to the brain's. */
  onJob?: (jobId: string) => void;
}

export default function ServicePanel({ photos, facts, onJob }: Props) {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  const applyHealth = useCallback((report: HealthReport) => {
    setHealth(report);
    setHealthError(null);
  }, []);

  const applyHealthError = useCallback((err: unknown) => {
    if ((err as Error)?.name === "AbortError") return;
    setHealth(null);
    setHealthError(err instanceof Error ? err.message : "unreachable");
  }, []);

  const checkHealth = useCallback(
    (signal?: AbortSignal) =>
      getHealth(signal).then(applyHealth).catch(applyHealthError),
    [applyHealth, applyHealthError],
  );

  // Subscribing to an external system: the state lands in the promise callback, never
  // synchronously in the effect body.
  useEffect(() => {
    const ac = new AbortController();
    getHealth(ac.signal).then(applyHealth).catch(applyHealthError);
    return () => ac.abort();
  }, [applyHealth, applyHealthError]);

  useEffect(() => () => closeRef.current?.(), []);

  const send = async () => {
    setSending(true);
    setError(null);
    setEvents([]);
    try {
      const { jobId: id } = await submitJob(photos, facts);
      setJobId(id);
      closeRef.current?.();
      closeRef.current = streamJob(
        id,
        (e) => {
          setEvents((prev) => [...prev, e]);
          // The recipes exist the moment buildRecipes runs, before B8.
          if (e.type === "recipes" || e.type === "completed") onJob?.(id);
        },
        () => {
          setSending(false);
          onJob?.(id);
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
      setSending(false);
    }
  };

  const stages = events.filter((e) => e.type === "stage");
  const excluded = events.filter((e) => e.type === "excluded");
  const artefacts = events.filter((e) => e.type === "artefact");
  const last = stages[stages.length - 1];
  const done = events.some((e) => e.type === "completed");
  const failed = events.find((e) => e.type === "failed");

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Render service</h2>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            health
              ? "bg-emerald-950 text-emerald-300"
              : "bg-rose-950 text-rose-300"
          }`}
        >
          {health ? "healthy" : "unreachable"}
        </span>
      </div>
      <p className="mb-3 break-all text-[11px] text-neutral-500">{SERVICE_URL}</p>

      {health && (
        <dl className="mb-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-neutral-500">stage</dt>
          <dd>{health.stage}</dd>
          <dt className="text-neutral-500">rules / cost-model</dt>
          <dd>
            v{health.shared.rules} / v{health.shared.costModel}
          </dd>
          <dt className="text-neutral-500">ffmpeg</dt>
          <dd className={health.ffmpeg.ok ? "" : "text-rose-300"}>
            {health.ffmpeg.ok ? "ok" : "missing"}
            {health.ffmpeg.ok && !health.ffmpeg.hasDrawtext && (
              <span className="text-neutral-500"> · no drawtext (expected)</span>
            )}
          </dd>
          <dt className="text-neutral-500">python / Pillow</dt>
          <dd className={health.python.ok ? "" : "text-rose-300"}>
            {health.python.ok ? `${health.python.python} / ${health.python.pillow}` : "missing"}
          </dd>
          <dt className="text-neutral-500">fonts</dt>
          <dd className={health.fonts.ok ? "" : "text-rose-300"}>
            {health.fonts.ok ? "3 loaded" : `missing ${health.fonts.missing.length}`}
          </dd>
          <dt className="text-neutral-500">paid video</dt>
          <dd
            className={
              health.vertex.generativeEnabled ? "text-amber-300" : "text-neutral-400"
            }
          >
            {health.vertex.generativeEnabled ? "ENABLED" : "gated until Stage 6"}
          </dd>
        </dl>
      )}
      {healthError && (
        <p className="mb-3 rounded-md border border-rose-900/60 bg-rose-950/30 p-2 text-[11px] text-rose-300">
          {healthError}
        </p>
      )}

      <button
        onClick={send}
        disabled={sending || photos.length === 0 || !health}
        className="w-full rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-neutral-900 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {sending ? "Uploading…" : `Send ${photos.length} photos to the service`}
      </button>
      <button
        onClick={() => void checkHealth()}
        className="mt-2 w-full rounded-lg border border-neutral-700 px-4 py-1.5 text-xs text-neutral-400 hover:border-neutral-500"
      >
        Re-check /health
      </button>

      {error && (
        <p className="mt-2 rounded-md border border-rose-900/60 bg-rose-950/30 p-2 text-[11px] text-rose-300">
          {error}
        </p>
      )}

      {jobId && (
        <div className="mt-3 space-y-2 text-[11px]">
          <p className="break-all text-neutral-500">job {jobId}</p>
          <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-950">
            <div
              className={`h-full transition-all ${
                failed ? "bg-rose-500" : done ? "bg-emerald-500" : "bg-amber-400"
              }`}
              style={{ width: `${Math.round((last?.progress ?? 0) * 100)}%` }}
            />
          </div>
          <p className={failed ? "text-rose-300" : done ? "text-emerald-300" : ""}>
            {failed
              ? `failed: ${failed.reason}`
              : done
                ? `completed · ${artefacts.length} artefacts`
                : (last?.stage ?? "starting")}
          </p>
          {excluded.length > 0 && (
            <ul className="space-y-1 rounded-md border border-amber-900/50 bg-amber-950/20 p-2 text-amber-300">
              {excluded.map((e) => (
                <li key={e.seq}>
                  {String(e.photoId)}: {String(e.reason)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
