"use client";

/**
 * An archived job: reels and hook tests made before the service kept its jobs. Plays
 * what survived, names what was lost, and says how to run the listing again. Nothing
 * here is a live run: no ledger, no node graph, no retune.
 */
import { fileUrl, type ArchiveItem, type JobSummary } from "@/lib/jobs";

const KIND_LABEL: Record<ArchiveItem["kind"], string> = {
  reel: "Finished reel",
  hook_test: "Hook test",
  comparison: "Comparison",
  still_sheet: "Stills",
};

export default function ArchiveView({ summary: s }: { summary: JobSummary }) {
  const a = s.archived!;
  const videos = a.items.filter((i) => i.kind !== "still_sheet");
  const sheets = a.items.filter((i) => i.kind === "still_sheet");

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4" aria-label="Archived job">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{a.title}</h2>
        <span className="rounded border border-sky-900 px-1.5 py-0.5 text-[10px] text-sky-300">archived</span>
      </div>
      <p className="mt-1 text-[11px] text-neutral-400">{a.note}</p>

      {a.lost.length > 0 && (
        <div className="mt-2 rounded border border-rose-900/50 bg-rose-950/20 p-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-rose-300">Lost</h3>
          <ul className="mt-1 space-y-1 text-[11px] text-neutral-300">
            {a.lost.map((l) => (
              <li key={l.what}>
                <span className="text-neutral-100">{l.what}</span>: {l.why}
              </li>
            ))}
          </ul>
        </div>
      )}

      {videos.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {videos.map((v) => (
            <figure key={v.file} className={`rounded-lg border border-neutral-800 p-2 ${v.kind === "comparison" ? "sm:col-span-2" : ""}`}>
              <figcaption className="mb-1 text-[11px]">
                <span className="font-mono text-amber-400">{KIND_LABEL[v.kind]}</span>
                <span className="block text-neutral-200">{v.title}</span>
              </figcaption>
              <video
                src={`${fileUrl(s.jobId, v.file)}#t=0.5`}
                controls
                playsInline
                preload="metadata"
                className="max-h-[70vh] w-full rounded bg-black"
                aria-label={v.title}
              />
              {v.note && <p className="mt-1 text-[10px] text-neutral-500">{v.note}</p>}
              <a
                href={fileUrl(s.jobId, v.file, true)}
                className="mt-1.5 inline-block rounded bg-amber-400 px-2 py-1 text-[11px] font-semibold text-neutral-900"
              >
                Download
              </a>
            </figure>
          ))}
        </div>
      )}

      {sheets.length > 0 && (
        <div className="mt-4 space-y-3">
          {sheets.map((sheet) => (
            <figure key={sheet.file}>
              <figcaption className="mb-1 text-[11px] text-neutral-300">
                <span className="font-mono text-amber-400">{KIND_LABEL[sheet.kind]}</span> · {sheet.title}
              </figcaption>
              <a href={fileUrl(s.jobId, sheet.file)} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- service-hosted artefact */}
                <img src={fileUrl(s.jobId, sheet.file)} alt={sheet.title} className="w-full rounded border border-neutral-800" />
              </a>
              {sheet.note && <p className="mt-1 text-[10px] text-neutral-500">{sheet.note}</p>}
            </figure>
          ))}
        </div>
      )}

      <p className="mt-3 text-[10px] text-neutral-500">
        {s.photoCount} listing photos kept. To run this listing again as a live job with its own ledger, use
        &ldquo;Duplicate with current controls&rdquo; on it in Jobs.
      </p>
    </section>
  );
}
