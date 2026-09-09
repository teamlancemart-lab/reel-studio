"use client";

/**
 * Upload panel. Drag-drop 8 to 40 images, downscaled to 1600px in the browser, split
 * into three buckets by filename order, then draggable between buckets.
 *
 * The drop-zone logic is ported from the prototype's wireDrop().
 */
import { useCallback, useRef, useState } from "react";
import {
  BUCKETS,
  BUCKET_LABEL,
  MAX_EDGE,
  MAX_PHOTOS,
  MIN_PHOTOS,
  autoBucket,
  downscale,
  fmtBytes,
  sortByFilename,
  type Bucket,
  type StudioPhoto,
} from "@/lib/photos";

interface Props {
  photos: StudioPhoto[];
  onAdd: (photos: StudioPhoto[]) => void;
  onMove: (id: string, bucket: Bucket) => void;
  onRemove: (id: string) => void;
}

export default function UploadPanel({ photos, onAdd, onMove, onRemove }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState<Bucket | "drop" | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const ingest = useCallback(
    async (fileList: FileList | File[], forceBucket?: Bucket) => {
      const incoming = sortByFilename(
        [...fileList].filter((f) => f.type.startsWith("image/")),
      );
      const skipped = [...fileList].length - incoming.length;
      const room = MAX_PHOTOS - photos.length;
      const accepted = incoming.slice(0, Math.max(0, room));

      const messages: string[] = [];
      if (skipped > 0) messages.push(`${skipped} file(s) skipped: not an image`);
      if (incoming.length > accepted.length) {
        messages.push(
          `${incoming.length - accepted.length} file(s) skipped: ${MAX_PHOTOS}-photo cap reached`,
        );
      }

      setBusy(true);
      const made: StudioPhoto[] = [];
      for (let i = 0; i < accepted.length; i++) {
        const file = accepted[i];
        try {
          const { blob, img, width, height } = await downscale(file, MAX_EDGE);
          made.push({
            id: `p${String(photos.length + made.length + 1).padStart(3, "0")}`,
            filename: file.name,
            bucket: forceBucket ?? autoBucket(i, accepted.length),
            url: img.src,
            blob,
            width,
            height,
            bytes: blob.size,
            originalBytes: file.size,
            img,
          });
        } catch (err) {
          // Nothing is silently dropped, in the browser either.
          messages.push(
            `${file.name} skipped: ${err instanceof Error ? err.message : "decode failed"}`,
          );
        }
      }
      setBusy(false);
      setNotes(messages);
      if (made.length) onAdd(made);
    },
    [photos.length, onAdd],
  );

  const counts = BUCKETS.map((b) => photos.filter((p) => p.bucket === b).length);
  const total = photos.length;

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Photos</h2>
        <span className="text-[11px] text-neutral-500">
          {total} of {MAX_PHOTOS}
          {total > 0 && total < MIN_PHOTOS ? ` · ${MIN_PHOTOS} is the target minimum` : ""}
        </span>
      </div>
      <p className="mb-3 text-[11px] text-neutral-500">
        Downscaled to {MAX_EDGE}px in your browser before upload. Split by filename
        order — drag a thumbnail to fix a bucket.
      </p>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver("drop");
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(null);
          if (e.dataTransfer.files.length) void ingest(e.dataTransfer.files);
        }}
        className={`cursor-pointer rounded-lg border border-dashed p-6 text-center text-xs transition ${
          over === "drop"
            ? "border-amber-400 bg-amber-400/5 text-neutral-200"
            : "border-neutral-700 text-neutral-500 hover:border-neutral-600"
        }`}
      >
        {busy ? "Decoding and downscaling…" : "Drop 8 to 40 listing photos, or click to choose"}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void ingest(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {notes.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-lg border border-amber-900/50 bg-amber-950/20 p-2 text-[11px] text-amber-300">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-3">
        {BUCKETS.map((bucket, i) => (
          <div
            key={bucket}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(bucket);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData("text/photo-id");
              if (id) onMove(id, bucket);
              else if (e.dataTransfer.files.length) void ingest(e.dataTransfer.files, bucket);
            }}
            className={`rounded-lg border p-2 transition ${
              over === bucket ? "border-amber-400 bg-amber-400/5" : "border-neutral-800"
            }`}
          >
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-medium">{BUCKET_LABEL[bucket]}</span>
              <span className="text-[11px] text-neutral-500">{counts[i]}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {photos
                .filter((p) => p.bucket === bucket)
                .map((p) => (
                  <figure
                    key={p.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/photo-id", p.id)}
                    className="group relative h-14 w-14 cursor-grab overflow-hidden rounded border border-neutral-700"
                    title={`${p.filename}\n${p.width}×${p.height} · ${fmtBytes(p.bytes)} (was ${fmtBytes(p.originalBytes)})`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.url}
                      alt={p.filename}
                      className="h-full w-full object-cover"
                    />
                    <button
                      onClick={() => onRemove(p.id)}
                      className="absolute right-0 top-0 hidden bg-black/70 px-1 text-[10px] text-rose-300 group-hover:block"
                      aria-label={`Remove ${p.filename}`}
                    >
                      ✕
                    </button>
                  </figure>
                ))}
              {counts[i] === 0 && (
                <span className="py-3 text-[11px] text-neutral-600">
                  drag photos here
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
