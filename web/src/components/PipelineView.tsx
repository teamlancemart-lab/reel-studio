"use client";

/**
 * The live pipeline. Every brain node and every paid step is a row with its status,
 * elapsed time, cost and — as soon as it lands — its artefact: the still as an image,
 * every clip and reel as a <video>. A rejected still or glide shows its QA reason here,
 * on screen, not just in a log.
 */
import { useEffect, useState } from "react";
import { fileUrl, fmtInr, fmtS, type GlideRecord, type HookRecord, type JobSummary, type LedgerRow } from "@/lib/jobs";
import type { SlimEvent } from "./JobView";

const NODE_ORDER = ["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"];

function Badge({ tone, children }: { tone: "ok" | "run" | "bad" | "warn" | "muted"; children: React.ReactNode }) {
  const cls = {
    ok: "bg-emerald-950 text-emerald-300",
    run: "bg-amber-950 text-amber-300 animate-pulse",
    bad: "bg-rose-950 text-rose-300",
    warn: "bg-amber-950 text-amber-300",
    muted: "bg-neutral-800 text-neutral-400",
  }[tone];
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${cls}`}>{children}</span>;
}

const stageCost = (ledger: LedgerRow[], match: (stage: string) => boolean) =>
  ledger.filter((r) => match(r.stage)).reduce((s, r) => s + (r.cost_inr || 0), 0);

/** Elapsed between the first and last event matching `pick`. */
function span(events: SlimEvent[], pick: (e: SlimEvent) => boolean) {
  const hit = events.filter(pick);
  if (!hit.length) return null;
  return new Date(hit[hit.length - 1].at).getTime() - new Date(hit[0].at).getTime();
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export default function PipelineView({
  summary,
  events,
  onResume,
}: {
  summary: JobSummary;
  events: SlimEvent[];
  onResume: () => void;
}) {
  const s = summary;
  const running = s.status === "processing" || s.status === "queued";
  const now = useNow(running);
  const elapsed = (s.completedAt ? new Date(s.completedAt).getTime() : now) - new Date(s.createdAt).getTime();
  const reels = s.recipes.length ? s.recipes.map((r) => Number(r.reelId.split("-")[1])) : [1, 2, 3];
  const opts = s.options?.effective;

  const nodes = [...s.nodes].sort(
    (a, b) => NODE_ORDER.indexOf(a.node) - NODE_ORDER.indexOf(b.node) || (a.reelN ?? 0) - (b.reelN ?? 0),
  );
  const runningNode = s.stage.startsWith("brain:") ? s.stage.slice(6) : null;

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4" aria-label="Pipeline">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Pipeline <span className="font-mono text-[11px] text-neutral-500">{s.jobId}</span>
        </h2>
        <div className="flex items-center gap-2 text-[11px]">
          <Badge tone={s.status === "completed" ? "ok" : s.status === "failed" ? "bad" : "run"}>{s.status}</Badge>
          <span className="text-neutral-400">{s.stage}</span>
          <span className="font-mono text-neutral-400">{fmtS(elapsed)}</span>
          <span className="font-mono text-neutral-200">{fmtInr(s.ledgerTotals.inr)}</span>
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-neutral-950">
        <div
          className={`h-full transition-all ${s.status === "failed" ? "bg-rose-500" : s.status === "completed" ? "bg-emerald-500" : "bg-amber-400"}`}
          style={{ width: `${Math.round((s.progress ?? 0) * 100)}%` }}
        />
      </div>
      {opts && (
        <p className="mt-2 text-[10px] text-neutral-500">
          run: paid hook {opts.paidHook ? "on" : "off"}
          {opts.hookConcepts?.some(Boolean)
            ? ` (${opts.hookConcepts.map((c, i) => `reel ${i + 1} ${c ?? "auto"}`).join(", ")})`
            : opts.hookConcept
              ? ` (${opts.hookConcept})`
              : ""}{" "}
          · interiors {opts.interiorMotion}
          {opts.interiorMotion === "veo" ? ` × ${opts.heroRooms}` : ""} · server GENERATIVE_ENABLED=
          {String(opts.env.GENERATIVE_ENABLED)} INTERIOR_MOTION={opts.env.INTERIOR_MOTION}
          {s.duplicateOf ? ` · duplicate of ${s.duplicateOf.slice(0, 8)} (brain reused, ${s.reusedBrain.length} nodes)` : ""}
          {opts.notes.length ? ` · ${opts.notes.join("; ")}` : ""}
        </p>
      )}
      {s.failureReason && (
        <div className="mt-2 rounded border border-rose-900/60 bg-rose-950/30 p-2 text-[11px] text-rose-300">
          <p>{s.failureReason}</p>
          {s.status === "failed" && (
            <button
              onClick={onResume}
              className="mt-1.5 rounded border border-rose-800 px-2 py-0.5 text-[11px] text-rose-200 hover:border-rose-600"
            >
              Resume (reuses every node that already succeeded)
            </button>
          )}
        </div>
      )}

      {/* ---- brain */}
      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Brain</h3>
      <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {nodes.map((n) => (
          <div key={n.key} className="flex items-center gap-2 rounded border border-neutral-800 px-2 py-1 text-[11px]">
            <span className="w-10 font-mono text-amber-400">{n.key}</span>
            <span className="min-w-0 flex-1 truncate text-neutral-300">
              {n.label}
              {n.concept ? ` · ${n.concept}` : ""}
            </span>
            {n.status === "failed" ? (
              <Badge tone="bad">failed</Badge>
            ) : n.copiedFrom ? (
              <Badge tone="muted">reused</Badge>
            ) : (
              <Badge tone="ok">ok</Badge>
            )}
            <span className="w-10 text-right font-mono text-neutral-500">{n.copiedFrom ? "—" : fmtS(n.elapsedMs)}</span>
            <span className="w-14 text-right font-mono text-neutral-400">{n.copiedFrom ? "₹0" : fmtInr(n.costInr)}</span>
          </div>
        ))}
        {runningNode && !nodes.some((n) => n.key === runningNode && n.status === "ok" && !n.copiedFrom) && (
          <div className="flex items-center gap-2 rounded border border-amber-900/60 px-2 py-1 text-[11px]">
            <span className="w-10 font-mono text-amber-400">{runningNode}</span>
            <span className="flex-1 text-neutral-400">running</span>
            <Badge tone="run">running</Badge>
          </div>
        )}
      </div>

      {/* ---- hooks */}
      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Hooks</h3>
      <div className="mt-1 space-y-2">
        {reels.map((n) => (
          <HookRow key={n} reelN={n} summary={s} events={events} now={now} />
        ))}
      </div>

      {/* ---- glides */}
      {(opts?.interiorMotion === "veo" || Object.keys(s.interiorClips).length > 0) && (
        <>
          <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Interior glides</h3>
          <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {Object.values(s.interiorClips).map((g) => (
              <GlideCard key={g.photo_id} glide={g} summary={s} />
            ))}
            {s.stage === "interiors" && <InFlight events={events} type="interior" />}
          </div>
        </>
      )}

      {/* ---- exports */}
      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Exports</h3>
      <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-3">
        {reels.map((n) => {
          const versions = s.reels[String(n)] ?? [];
          const last = versions[versions.length - 1];
          const rendering = s.stage === `export:${n}`;
          const segs = events.filter((e) => e.type === "render" && e.reelId === `reel-${n}` && e.step === "segment");
          return (
            <div key={n} className="rounded border border-neutral-800 px-2 py-1.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-mono text-amber-400">reel {n}</span>
                {rendering ? (
                  <Badge tone="run">rendering {segs.length ? `seg ${Number(segs[segs.length - 1].index) + 1}` : ""}</Badge>
                ) : last ? (
                  <Badge tone={last.status === "ok" ? "ok" : "bad"}>v{last.version} {last.status}</Badge>
                ) : (
                  <Badge tone="muted">waiting</Badge>
                )}
              </div>
              {last && (
                <p className="mt-0.5 text-[10px] text-neutral-500">
                  {fmtS(last.elapsed_ms)} · {last.video.width}x{last.video.height} · {last.video.duration_s}s · +{last.ledger.new_rows} ledger rows
                </p>
              )}
              {last?.blocked_by.length ? <p className="text-[10px] text-rose-300">{last.blocked_by.join(" | ")}</p> : null}
            </div>
          );
        })}
      </div>

      {s.runIssues.length > 0 && (
        <ul className="mt-3 space-y-1 rounded border border-amber-900/50 bg-amber-950/20 p-2 text-[11px] text-amber-300">
          {s.runIssues.map((i, k) => (
            <li key={k}>
              {i.step}
              {i.reel_n ? ` reel ${i.reel_n}` : ""}: {i.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HookRow({ reelN, summary: s, events, now }: { reelN: number; summary: JobSummary; events: SlimEvent[]; now: number }) {
  const hook: HookRecord | undefined = s.hooks[String(reelN)];
  const plan = s.nodes.find((n) => n.key === `B4:${reelN}`);
  const mine = events.filter((e) => e.type === "hook" && e.reelN === reelN);
  const lastStep = mine[mine.length - 1];
  const building = s.stage === `hook:${reelN}`;
  const cost = stageCost(s.ledger, (st) => [`H1:${reelN}`, `Q1:${reelN}`, `H2:${reelN}`, `Q2:${reelN}`].includes(st));
  const veoRow = s.ledger.find((r) => r.stage === `H2:${reelN}`);
  // From the moment the pipeline reached this reel's hook to the hook being saved.
  const started = events.find((e) => e.type === "stage" && e.stage === `hook:${reelN}`);
  const saved = [...mine].reverse().find((e) => e.step === "saved");
  const took = started
    ? (saved ? new Date(saved.at).getTime() : now) - new Date(started.at).getTime()
    : span(events, (e) => e.type === "hook" && e.reelN === reelN);

  return (
    <div className="rounded-lg border border-neutral-800 p-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-amber-400">reel {reelN}</span>
        <span className="text-neutral-300">{hook?.concept_id ?? plan?.concept ?? "—"}</span>
        {hook ? (
          hook.fell_back ? (
            <Badge tone="warn">fell back to free</Badge>
          ) : (
            <Badge tone="ok">{hook.generation_path === "free_2p5d" ? "free hook" : "paid hook"}</Badge>
          )
        ) : building ? (
          <Badge tone="run">{String(lastStep?.step ?? "starting")}</Badge>
        ) : (
          <Badge tone="muted">waiting</Badge>
        )}
        <span className="ml-auto font-mono text-neutral-500">{took != null ? fmtS(took) : ""}</span>
        <span className="w-14 text-right font-mono text-neutral-300">{fmtInr(cost)}</span>
      </div>
      {hook?.fallback_reason && <p className="mt-1 text-[10px] text-amber-300">{hook.fallback_reason}</p>}

      <div className="mt-1.5 flex flex-wrap gap-2">
        {hook?.attempts.map((a) => (
          <figure key={a.attempt} className="w-28">
            {a.still_file && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(s.jobId, a.still_file)} alt={`still attempt ${a.attempt}`} className="aspect-[9/16] w-28 rounded object-cover" />
            )}
            <figcaption className={`mt-0.5 text-[10px] ${a.verdict === "approved" ? "text-emerald-300" : "text-rose-300"}`}>
              still {a.attempt}: Q1 {a.verdict}
              {a.q1 && a.q1.rejects_found.length > 0 && <span className="block text-rose-300/90">{a.q1.rejects_found.join("; ")}</span>}
              {a.reason && <span className="block text-rose-300/90">{a.reason}</span>}
            </figcaption>
          </figure>
        ))}
        {veoRow && (
          <div className="w-28 text-[10px] text-neutral-400">
            {hook?.forward_file ? (
              <video src={fileUrl(s.jobId, hook.forward_file)} controls muted playsInline className="aspect-[9/16] w-28 rounded bg-black" />
            ) : (
              <div className="grid aspect-[9/16] w-28 place-items-center rounded bg-neutral-950">Veo {building ? "rendering…" : ""}</div>
            )}
            <span>Veo 8s · {fmtInr(veoRow.cost_inr)}</span>
          </div>
        )}
        {hook?.q2 && (
          <p className={`self-end text-[10px] ${hook.q2.pass ? "text-emerald-300" : "text-rose-300"}`}>
            Q2 {hook.q2.pass ? "pass" : `fail: ${hook.q2.rejects_found.join("; ")}`}
          </p>
        )}
        {hook?.clip_file && (
          <figure className="w-28">
            <video src={fileUrl(s.jobId, hook.clip_file)} controls muted playsInline loop className="aspect-[9/16] w-28 rounded bg-black" />
            <figcaption className="text-[10px] text-neutral-400">hook clip</figcaption>
          </figure>
        )}
      </div>
    </div>
  );
}

function GlideCard({ glide: g, summary: s }: { glide: GlideRecord; summary: JobSummary }) {
  const tone = g.status === "approved" ? "ok" : g.status === "rejected" ? "bad" : "warn";
  return (
    <div className="rounded-lg border border-neutral-800 p-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="text-neutral-300">
          {g.category} <span className="font-mono text-neutral-500">{g.photo_id}</span>
        </span>
        <Badge tone={tone}>{g.status}</Badge>
      </div>
      {g.clip_file && (
        <video src={fileUrl(s.jobId, g.clip_file)} controls muted playsInline loop className="mt-1 aspect-[9/16] w-full rounded bg-black" />
      )}
      {g.reason && <p className="mt-1 text-[10px] text-rose-300">{g.reason}</p>}
      <p className="mt-0.5 font-mono text-[10px] text-neutral-500">{fmtInr(g.cost?.inr ?? 0)}</p>
    </div>
  );
}

function InFlight({ events, type }: { events: SlimEvent[]; type: string }) {
  const last = [...events].reverse().find((e) => e.type === type);
  if (!last) return null;
  return (
    <div className="rounded-lg border border-amber-900/60 p-2 text-[11px] text-amber-300">
      {String(last.photoId ?? "")} {String(last.step ?? "")}
    </div>
  );
}
