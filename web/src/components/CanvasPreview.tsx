"use client";

/**
 * The centrepiece. Ports the prototype's canvas renderer, scrubber, play/restart and
 * aspect toggle, but driven by a ReelRecipe instead of a hardcoded segments().
 *
 * Instant and free: no round trip to Railway to see a change. What you scrub here is
 * what /service renders, because both read the same recipe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Aspect, ReelRecipe } from "@/shared/recipe";
import { SEGMENT_LABEL, segmentAt } from "@/shared/recipe";
import { canvasSize, drawFrame, type ImageBank } from "@/lib/draw";

interface Props {
  recipe: ReelRecipe;
  images: ImageBank;
  aspect: Aspect;
  onAspectChange: (a: Aspect) => void;
  fonts: { sans: string; serif: string };
  problems: string[];
  /** "stub" until the brain has run, then "brain". */
  source?: "stub" | "brain";
  reels?: ReelRecipe[];
  reelIndex?: number;
  onReelChange?: (i: number) => void;
}

export default function CanvasPreview({
  recipe,
  images,
  aspect,
  onAspectChange,
  fonts,
  problems,
  source = "stub",
  reels = [],
  reelIndex = 0,
  onReelChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);
  const tRef = useRef(0);

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [fontsReady, setFontsReady] = useState(false);

  const duration = recipe.durationS;

  useEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const paint = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      drawFrame(ctx, recipe, time, images, { showGuides, fonts });
    },
    [recipe, images, showGuides, fonts],
  );

  // Resize the backing store when the aspect changes, then repaint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = canvasSize(aspect);
    canvas.width = size.width;
    canvas.height = size.height;
    paint(tRef.current);
  }, [aspect, paint]);

  // Repaint on any recipe/image/guide/font change while paused.
  useEffect(() => {
    if (!playing) paint(tRef.current);
  }, [paint, playing, fontsReady]);

  // Clamp the playhead when the recipe gets shorter (photos removed).
  useEffect(() => {
    if (tRef.current > duration) {
      tRef.current = duration;
      setT(duration);
    }
  }, [duration]);

  const stop = useCallback(() => {
    setPlaying(false);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    lastRef.current = 0;
  }, []);

  useEffect(() => {
    if (!playing) return;
    const loop = (ts: number) => {
      if (!lastRef.current) lastRef.current = ts;
      const dt = (ts - lastRef.current) / 1000;
      lastRef.current = ts;
      let next = tRef.current + dt;
      if (next >= duration) {
        next = duration;
        tRef.current = next;
        setT(next);
        paint(next);
        stop();
        return;
      }
      tRef.current = next;
      setT(next);
      paint(next);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastRef.current = 0;
    };
  }, [playing, duration, paint, stop]);

  const seek = (next: number) => {
    stop();
    tRef.current = next;
    setT(next);
    paint(next);
  };

  const current = segmentAt(recipe, t);
  const label = current ? SEGMENT_LABEL[current.kind] : "—";

  const ticks = useMemo(
    () =>
      recipe.segments.map((s) => ({
        kind: s.kind,
        left: (s.tIn / duration) * 100,
        width: ((s.tOut - s.tIn) / duration) * 100,
      })),
    [recipe.segments, duration],
  );

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Canvas preview</h2>
        <span className="text-[11px] text-neutral-500">
          {source === "brain"
            ? "real recipe from the brain · instant · free"
            : "D1 stub recipe · instant · free"}
        </span>
      </div>

      {reels.length > 1 && (
        <div className="mb-2 inline-flex rounded-lg border border-neutral-800 bg-neutral-950 p-1">
          {reels.map((r, i) => (
            <button
              key={r.reelId}
              onClick={() => onReelChange?.(i)}
              className={`rounded-md px-3 py-1 text-xs transition ${
                i === reelIndex
                  ? "bg-amber-400 font-semibold text-neutral-900"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {r.reelId} · {r.tier}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 inline-flex rounded-lg border border-neutral-800 bg-neutral-950 p-1">
        {(["9x16", "16x9"] as Aspect[]).map((a) => (
          <button
            key={a}
            onClick={() => onAspectChange(a)}
            className={`rounded-md px-3 py-1 text-xs transition ${
              aspect === a
                ? "bg-amber-400 font-semibold text-neutral-900"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {a.replace("x", ":")}
          </button>
        ))}
        <button
          onClick={() => setShowGuides((g) => !g)}
          className={`ml-1 rounded-md px-3 py-1 text-xs transition ${
            showGuides
              ? "bg-neutral-800 text-amber-300"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          title="rules.json safe_zone_9x16"
        >
          safe zone
        </button>
      </div>

      <div className="flex justify-center">
        <div className="rounded-2xl border-4 border-neutral-800 bg-black p-2">
          <canvas
            ref={canvasRef}
            className="block max-h-[58vh] rounded-lg bg-black"
            style={{ aspectRatio: aspect === "9x16" ? "9 / 16" : "16 / 9" }}
          />
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-amber-400">{label}</span>
          <span className="font-mono text-neutral-400 tabular-nums">
            {t.toFixed(1)}s / {duration.toFixed(1)}s
          </span>
        </div>

        {/* Segment map under the scrubber: the recipe's shape, visible. */}
        <div className="relative mt-2 h-2 w-full overflow-hidden rounded bg-neutral-950">
          {ticks.map((tick, i) => (
            <span
              key={i}
              className={`absolute top-0 h-full border-r border-neutral-900 ${
                current?.kind === tick.kind ? "bg-amber-400/60" : "bg-neutral-700/60"
              }`}
              style={{ left: `${tick.left}%`, width: `${tick.width}%` }}
              title={tick.kind}
            />
          ))}
        </div>

        <input
          type="range"
          min={0}
          max={duration}
          step={1 / recipe.fps}
          value={t}
          onChange={(e) => seek(parseFloat(e.target.value))}
          className="mt-2 w-full accent-amber-400"
        />

        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => {
              if (playing) {
                stop();
              } else {
                if (tRef.current >= duration) seek(0);
                setPlaying(true);
              }
            }}
            className="rounded-lg bg-amber-400 px-4 py-1.5 text-sm font-semibold text-neutral-900 hover:bg-amber-300"
          >
            {playing ? "Pause" : "Play"}
          </button>
          <button
            onClick={() => seek(0)}
            className="rounded-lg border border-neutral-700 px-4 py-1.5 text-sm hover:border-neutral-500"
          >
            Restart
          </button>
          <span className="ml-auto text-[11px] text-neutral-500">
            {recipe.segments.length} segments · {recipe.tier} · {recipe.fps}fps
          </span>
        </div>

        {problems.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg border border-rose-900/60 bg-rose-950/30 p-2 text-[11px] text-rose-300">
            {problems.map((p) => (
              <li key={p}>validateRecipe: {p}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
