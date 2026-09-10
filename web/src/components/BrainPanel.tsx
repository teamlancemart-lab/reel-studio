"use client";

/**
 * One card per brain node.
 *
 * "Every brain node has a fixed JSON schema, a status, a cost, a lock and a
 * regenerate. Regenerating one node never re-runs its siblings; descendants go stale
 * with a visible rebuild cost." Everything on this card exists to make that true and
 * visible before you click, not after.
 */
import { useCallback, useEffect, useState } from "react";
import {
  fmtInr,
  fmtMs,
  getNodePayload,
  getNodes,
  regenerateNode,
  saveNodePayload,
  setNodeLock,
  type NodeCard,
  type NodesResponse,
} from "@/lib/nodes";

interface Props {
  jobId: string;
  onChanged: () => void;
}

export default function BrainPanel({ jobId, onChanged }: Props) {
  const [data, setData] = useState<NodesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    getNodes(jobId).then(setData).catch((e) => setError(String(e.message)));
  }, [jobId]);

  useEffect(() => {
    getNodes(jobId).then(setData).catch((e) => setError(String(e.message)));
  }, [jobId]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <section className="rounded-xl border border-rose-900/60 bg-rose-950/20 p-4 text-[11px] text-rose-300">
        {error}
      </section>
    );
  }
  if (!data) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-[11px] text-neutral-500">
        loading brain…
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Brain</h2>
        <span className="text-[11px] text-neutral-500">
          {data.ledger.rows} calls · {fmtInr(data.ledger.inr)}
        </span>
      </div>
      <p className="mb-3 text-[11px] text-neutral-500">
        Editing a node stales its descendants. The rebuild cost is on the button.
      </p>

      {error && (
        <p className="mb-2 rounded-md border border-rose-900/60 bg-rose-950/30 p-2 text-[11px] text-rose-300">
          {error}
        </p>
      )}

      <div className="space-y-1.5">
        {data.cards.map((card) => (
          <Card
            key={card.key}
            card={card}
            jobId={jobId}
            open={open === card.key}
            busy={busy === card.key}
            onToggle={() => setOpen(open === card.key ? null : card.key)}
            onRegenerate={() => act(card.key, () => regenerateNode(jobId, card.key))}
            onLock={() => act(card.key, () => setNodeLock(jobId, card.key, !card.locked))}
            onSaved={() => act(card.key, async () => {})}
          />
        ))}
      </div>

      {data.dedupe && data.dedupe.dropped.length > 0 && (
        <details className="mt-3 rounded-lg border border-neutral-800 p-2">
          <summary className="cursor-pointer text-[11px] text-neutral-400">
            dedupe · {data.dedupe.dropped.length} dropped, each with a reason
          </summary>
          <ul className="mt-2 space-y-1 text-[10px] text-neutral-500">
            {data.dedupe.dropped.map((d) => (
              <li key={d.photo_id}>
                <span className="text-neutral-300">{d.photo_id}</span> — {d.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {data.recipeNotes.length > 0 && (
        <details className="mt-2 rounded-lg border border-neutral-800 p-2">
          <summary className="cursor-pointer text-[11px] text-neutral-400">
            recipe adjustments · {data.recipeNotes.length}
          </summary>
          <ul className="mt-2 space-y-1 text-[10px] text-neutral-500">
            {data.recipeNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Card({
  card,
  jobId,
  open,
  busy,
  onToggle,
  onRegenerate,
  onLock,
  onSaved,
}: {
  card: NodeCard;
  jobId: string;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onRegenerate: () => void;
  onLock: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string>("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    getNodePayload(jobId, card.key)
      .then((n) => {
        setDraft(JSON.stringify(n.payload, null, 2));
        setLoaded(true);
      })
      .catch((e) => setSaveError(String(e.message)));
  }, [open, loaded, jobId, card.key]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await saveNodePayload(jobId, card.key, JSON.parse(draft));
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const tone =
    card.status === "failed"
      ? "border-rose-900/60 bg-rose-950/20"
      : card.stale
        ? "border-amber-900/60 bg-amber-950/15"
        : "border-neutral-800";

  return (
    <div className={`rounded-lg border ${tone}`}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <span className="w-14 shrink-0 font-mono text-[11px] text-amber-400">
          {card.key}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300">
          {card.label}
          {card.editedBy && <span className="text-neutral-500"> · edited</span>}
        </span>
        {card.locked && <span title="locked">🔒</span>}
        {card.stale && (
          <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-300">
            stale
          </span>
        )}
        {card.status === "failed" && (
          <span className="rounded bg-rose-900/50 px-1.5 py-0.5 text-[10px] text-rose-300">
            failed
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-neutral-500">
          v{card.version} · {fmtInr(card.costInr)} · {fmtMs(card.elapsedMs)}
        </span>
      </button>

      {open && (
        <div className="border-t border-neutral-800 px-2.5 py-2">
          <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
            <dt className="text-neutral-500">model</dt>
            <dd className="font-mono">{card.model}</dd>
            <dt className="text-neutral-500">calls / attempts</dt>
            <dd>
              {card.calls} / {card.attempts}
            </dd>
            <dt className="text-neutral-500">parents</dt>
            <dd className="font-mono">
              {Object.entries(card.parentVersions || {})
                .map(([k, v]) => `${k}@v${v}`)
                .join(" ") || "—"}
            </dd>
            {card.wouldStale.length > 0 && (
              <>
                <dt className="text-neutral-500">re-running stales</dt>
                <dd className="font-mono text-amber-300">
                  {card.wouldStale.join(", ")}
                </dd>
              </>
            )}
          </dl>

          {card.failureReason && (
            <p className="mb-2 rounded border border-rose-900/60 bg-rose-950/30 p-1.5 text-[10px] text-rose-300">
              {card.failureReason}
            </p>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={14}
            className="w-full rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[10px] leading-relaxed outline-none focus:border-amber-400"
          />
          {saveError && (
            <p className="mt-1 rounded border border-rose-900/60 bg-rose-950/30 p-1.5 text-[10px] text-rose-300">
              {saveError}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              onClick={save}
              disabled={saving || card.locked}
              className="rounded bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-neutral-900 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={onRegenerate}
              disabled={busy || card.locked}
              className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] hover:border-neutral-500 disabled:opacity-40"
              title={
                card.wouldStale.length
                  ? `stales ${card.wouldStale.join(", ")}`
                  : "nothing downstream"
              }
            >
              {busy ? "Running…" : "Regenerate"}
              {card.wouldStale.length > 0 && (
                <span className="ml-1 text-amber-300">
                  +{fmtInr(card.rebuildCostInr)} rebuild
                </span>
              )}
            </button>
            <button
              onClick={onLock}
              className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] hover:border-neutral-500"
            >
              {card.locked ? "Unlock" : "Lock"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
