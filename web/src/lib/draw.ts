/**
 * The browser half of the ReelRecipe contract.
 *
 * This module interprets a ReelRecipe onto a 2D canvas at an arbitrary time t.
 * /service/src/render (D3) will interpret the SAME recipe with ffmpeg. Everything here
 * that decides what a frame looks like — crop maths, motion curves, overlay layout,
 * safe zone — is written so the ffmpeg side can reproduce it: no canvas-only tricks in
 * the geometry, and every constant is named.
 *
 * Type systems and the safe zone come from rules.json. They are not duplicated here.
 */
import type {
  Crop,
  Motion,
  Overlay,
  ReelRecipe,
  Segment,
  Transition,
  TypeVoice,
} from "@/shared/recipe";
import { segmentAt, segmentProgress } from "@/shared/recipe";
import { SAFE_ZONE_9X16, TYPE_SYSTEMS, type TypeSystem } from "./rules";

export type ImageBank = Map<string, HTMLImageElement>;

export interface DrawOptions {
  /** Draw the safe-zone rectangle and the crop centre. Off for recording. */
  showGuides?: boolean;
  /** Resolved font families, from next/font. */
  fonts: { sans: string; serif: string };
}

/** Transition length in seconds. The prototype used 0.45 for everything. */
export const TRANSITION_S: Record<Transition, number> = {
  cut: 0,
  crossfade: 0.45,
  zoom_through: 0.4,
  whip_blur: 0.25,
  light_leak: 0.5,
};

const ease = (p: number) => {
  const x = Math.min(1, Math.max(0, p));
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
};
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/* ------------------------------------------------------------------ motion */

interface MotionState {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Motion curves. rules.json motion_vocabulary names the presets per room class
 * (push_slow, push_medium, parallax_lr...); the recipe carries the collapsed verb and
 * these are the amplitudes both renderers use.
 */
export function motionAt(motion: Motion, p: number): MotionState {
  const e = ease(p);
  switch (motion) {
    case "push":
      return { zoom: lerp(1.0, 1.12, e), panX: 0, panY: lerp(0.02, 0, e) };
    case "pull":
      return { zoom: lerp(1.12, 1.0, e), panX: 0, panY: 0 };
    case "pan_l":
      return { zoom: 1.08, panX: lerp(0.1, -0.1, e), panY: 0 };
    case "pan_r":
      return { zoom: 1.08, panX: lerp(-0.1, 0.1, e), panY: 0 };
    case "parallax_lr":
      // Full-frame lateral drift, as service/src/render/render.js draws it.
      return { zoom: 1.1, panX: lerp(-0.045, 0.045, p), panY: 0 };
    case "self_draw":
      return { zoom: lerp(1.0, 1.06, e), panX: 0, panY: 0 };
    case "static":
    default:
      return { zoom: 1, panX: 0, panY: 0 };
  }
}

/**
 * Source rectangle for a crop under a motion state.
 * Crop semantics are schemas.json $defs/Crop: centre plus width as source fractions.
 * Height follows from the OUTPUT aspect, so one crop serves 9:16 and 16:9 from
 * safe_crop_9x16 / safe_crop_16x9 without the renderer inventing a second rule.
 */
export function sourceRect(
  img: { width: number; height: number },
  crop: Crop,
  outAspect: number,
  m: MotionState,
) {
  let sw = img.width * crop.widthFrac;
  let sh = sw / outAspect;
  if (sh > img.height) {
    sh = img.height;
    sw = sh * outAspect;
  }
  sw /= m.zoom;
  sh /= m.zoom;

  let sx = crop.xCenter * img.width + m.panX * sw - sw / 2;
  let sy = crop.yCenter * img.height + m.panY * sh - sh / 2;
  sx = Math.max(0, Math.min(img.width - sw, sx));
  sy = Math.max(0, Math.min(img.height - sh, sy));
  return { sx, sy, sw, sh };
}

/* ------------------------------------------------------------------ layers */

function drawPhotoLayer(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  crop: Crop,
  motion: Motion,
  p: number,
  W: number,
  H: number,
) {
  const outAspect = W / H;

  const m = motionAt(motion, p);
  const r = sourceRect(img, crop, outAspect, m);
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
}

/**
 * Floor plan self-draw. The preview approximates D3's ffmpeg version (threshold the
 * plan, animate a stroke reveal, then fill) with a wipe over a paper ground: same
 * timing, same end state, cheaper construction. It is an approximation and is labelled
 * as one in the UI.
 */
function drawSelfDraw(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | undefined,
  p: number,
  W: number,
  H: number,
) {
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, W, H);
  if (!img) return;

  const scale = lerp(1.0, 1.06, ease(p));
  const fit = Math.min((W * 0.86) / img.width, (H * 0.7) / img.height) * scale;
  const dw = img.width * fit;
  const dh = img.height * fit;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;

  const reveal = Math.min(1, p / 0.7); // stroke completes at 70%, then it fills
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw * reveal, dh);
  ctx.clip();
  ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, Math.max(0, (p - 0.5) / 0.4));
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();

  // The drawing edge.
  if (reveal < 1) {
    ctx.save();
    ctx.strokeStyle = "rgba(19,32,56,.55)";
    ctx.lineWidth = Math.max(1.5, W * 0.004);
    ctx.beginPath();
    ctx.moveTo(dx + dw * reveal, dy);
    ctx.lineTo(dx + dw * reveal, dy + dh);
    ctx.stroke();
    ctx.restore();
  }
}

/** How dark the closing card's photo goes under the CTA text (render.js CTA_SCRIM). */
const CTA_SCRIM = 0.5;

/** A CTA with no aerial or exterior to sit on is a plain card. */
function drawCtaGround(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.fillStyle = "#132038";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(245,179,1,.75)";
  ctx.lineWidth = Math.max(1.5, W * 0.004);
  ctx.strokeRect(W * 0.06, H * 0.06, W * 0.88, H * 0.88);
}

/** Bottom scrim so overlay text reads over any photo. */
function scrim(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const g = ctx.createLinearGradient(0, H * 0.5, 0, H);
  g.addColorStop(0, "rgba(8,10,15,0)");
  g.addColorStop(1, "rgba(8,10,15,.88)");
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.5, W, H * 0.5);
}

/* ---------------------------------------------------------------- overlays */

function fontString(
  system: TypeSystem,
  which: "title" | "sub",
  px: number,
  fonts: { sans: string; serif: string },
) {
  const family =
    (which === "title" ? system.title_font : system.sub_font) === "Playfair Display"
      ? fonts.serif
      : fonts.sans;
  const weight = which === "title" ? system.title_weight : system.sub_weight;
  return `${weight} ${Math.round(px)}px ${family}`;
}

function casedText(text: string, mode?: string) {
  if (mode === "caps_small" || mode === "smallcaps") return text.toUpperCase();
  return text;
}

/** Width of a string including letter tracking, at the ctx's current font. */
function measureTracked(ctx: CanvasRenderingContext2D, text: string, track: number) {
  const chars = [...text];
  return (
    chars.reduce((s, c) => s + ctx.measureText(c).width, 0) +
    track * Math.max(0, chars.length - 1)
  );
}

/** Draw with optional letter tracking. */
function trackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  track: number,
  align: "left" | "center",
) {
  if (track <= 0) {
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    return;
  }
  const chars = [...text];
  const total = measureTracked(ctx, text, track);
  let cx = align === "center" ? x - total / 2 : x;
  ctx.textAlign = "left";
  for (const c of chars) {
    ctx.fillText(c, cx, y);
    cx += ctx.measureText(c).width + track;
  }
}

/**
 * Shrink a size until the string fits maxWidth, tracking included. Leaves ctx.font set
 * to the chosen size.
 *
 * rules.json SAFE_ZONE is a BLOCK rule at pre-export, so "it fits" is not cosmetic:
 * a preview that lets text spill is a preview of a reel the exporter will refuse.
 */
function fitPx(
  ctx: CanvasRenderingContext2D,
  text: string,
  startPx: number,
  maxWidth: number,
  makeFont: (px: number) => string,
  track = 0,
) {
  let px = startPx;
  for (let i = 0; i < 40; i++) {
    ctx.font = makeFont(px);
    // Tracking scales with px, so re-derive it each pass.
    const scaled = track * (px / startPx);
    if (measureTracked(ctx, text, scaled) <= maxWidth) break;
    px *= 0.94;
  }
  ctx.font = makeFont(px);
  return px;
}

interface SafeBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

export function safeBox(W: number, H: number): SafeBox {
  const left = W * SAFE_ZONE_9X16.side_frac;
  const right = W * (1 - SAFE_ZONE_9X16.side_frac);
  return {
    left,
    right,
    top: H * SAFE_ZONE_9X16.top_frac,
    bottom: H * (1 - SAFE_ZONE_9X16.bottom_frac),
    width: right - left,
  };
}

/**
 * Overlay layout. `system` picks the arrangement, `voice` picks the type system from
 * rules.json. Every box is clamped into safe_zone_9x16 — rules.json SAFE_ZONE is a
 * BLOCK rule at pre-export, so the preview must never show text the exporter would
 * refuse.
 */
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: Overlay,
  voice: TypeVoice,
  t: number,
  W: number,
  H: number,
  fonts: { sans: string; serif: string },
  /** The segment underneath is light (floor plan paper), so the ink must be dark. */
  onLight = false,
  /** A closing card drawn over a real photo rather than the plain card. */
  onPhoto = false,
) {
  const system = TYPE_SYSTEMS[overlay.voice ?? voice];
  const box = safeBox(W, H);
  // Same normalisation as service/src/render/overlays.py: B6 sometimes puts a newline
  // inside one line, and every resulting line is drawn.
  const lines = overlay.lines.flatMap((l) => (l ? l.split("\n") : [])).filter((l) => l.trim());
  if (lines.length === 0) return;

  const inkTitle = onLight ? "#132038" : "#ffffff";
  const inkSub = onLight ? "rgba(19,32,56,.78)" : "rgba(232,232,238,.94)";

  // Fade in over the overlay's own window; fadeInS 0 means it is already there.
  const fadeIn = overlay.fadeInS ?? overlay.fadeS ?? 0.35;
  const alpha = fadeIn > 0 ? ease(Math.min(1, (t - overlay.tIn) / fadeIn)) : 1;
  const rise = lerp(W * 0.02, 0, alpha);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = "alphabetic";
  // A drop shadow under dark ink on paper reads as dirt, not depth.
  if (system.shadow && !onLight) {
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = W * 0.02;
    ctx.shadowOffsetY = W * 0.004;
  }

  const titleCase = casedText(lines[0], system.title_case);
  const track = system.title_case === "caps_small" ? W * 0.006 : 0;

  if (overlay.kind === "title" && overlay.system === "status_card") {
    drawStatusTitle(ctx, lines, Boolean(overlay.statsLine), W, H, fonts, box);
    ctx.restore();
    return;
  }
  if (overlay.kind === "caption" && overlay.system === "address_only" && !onLight) {
    ctx.shadowColor = "transparent";
    drawSocialCaption(ctx, lines, W, H, fonts, box);
    ctx.restore();
    return;
  }
  if (overlay.kind === "cta_band" && onPhoto) {
    drawCtaOverPhoto(ctx, lines, W, H, fonts, box);
    ctx.restore();
    return;
  }

  /* Only a cta_band gets the centred treatment. "search_intent" is a legitimate
     title_card_system for a HOOK card ("Homes for sale in Uptown"), and keying on it
     here rendered reel 2's hook as a gold CTA kicker in the middle of the frame. */
  if (overlay.kind === "cta_band") {
    // Centred stack. rules.json overlay_style wants the compliance band tall and legible.
    const cx = W / 2;
    let y = H * 0.42;

    const kickerTrack = W * 0.006;
    ctx.fillStyle = "#f5b301";
    const kickerPx = fitPx(
      ctx,
      titleCase,
      W * 0.05,
      box.width,
      (px) => fontString(system, "sub", px, fonts),
      kickerTrack,
    );
    trackedText(ctx, titleCase, cx, y, kickerTrack * (kickerPx / (W * 0.05)), "center");
    y += H * 0.07;

    if (lines[1]) {
      fitPx(ctx, lines[1], W * 0.085, box.width, (p) =>
        fontString(system, "title", p, fonts),
      );
      ctx.fillStyle = "#f4f4f5";
      ctx.textAlign = "center";
      ctx.fillText(lines[1], cx, y);
      y += H * 0.055;
    }
    ctx.fillStyle = "rgba(214,208,196,.92)";
    for (const line of lines.slice(2)) {
      fitPx(ctx, line, W * 0.04, box.width, (p) => fontString(system, "sub", p, fonts));
      ctx.textAlign = "center";
      ctx.fillText(line, cx, Math.min(y, box.bottom));
      y += H * 0.045;
    }
    ctx.restore();
    return;
  }

  if (overlay.kind === "disclosure") {
    // rules.json overlay_style: hook_label_min_px_height_at_1080 = 28 -> 2.6% of width.
    const px = Math.max(W * 0.026, 11);
    ctx.font = fontString(system, "sub", px, fonts);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    const text = lines[0];
    const w = ctx.measureText(text).width;
    const padX = W * 0.015;
    const padY = px * 0.5;
    ctx.save();
    ctx.globalAlpha = alpha * 0.75;
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.beginPath();
    ctx.roundRect(box.left, box.top, w + padX * 2, px + padY * 2, px * 0.4);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,.95)";
    ctx.textAlign = "left";
    ctx.fillText(text, box.left + padX, box.top + px + padY * 0.7);
    ctx.restore();
    return;
  }

  /* Lower-third systems: price_stack, status_card, address_only, number_first. */
  const hasSub = Boolean(lines[1]);
  const padX = W * 0.03;
  const textLeft = box.left + (system.pill ? padX : 0);
  // The pill's padding eats into the usable width, so measure against what is left.
  const usable = box.right - textLeft - (system.pill ? padX : 0);

  const titleStart =
    overlay.system === "number_first" || overlay.system === "price_stack"
      ? W * 0.105
      : W * 0.075;
  const titlePx = fitPx(
    ctx,
    titleCase,
    titleStart,
    usable,
    (px) => fontString(system, "title", px, fonts),
    track,
  );

  const subTrack = system.sub_case === "smallcaps" ? W * 0.005 : 0;
  const subs = lines.slice(1).map((line) => {
    const text = casedText(line, system.sub_case);
    const px = fitPx(ctx, text, W * 0.04, usable, (p) => fontString(system, "sub", p, fonts), subTrack);
    return { text, px };
  });

  /* Lay the block out from its BOTTOM so descenders stay inside the safe zone.
     A baseline exactly on box.bottom still hangs its descenders below it. */
  const descender = 0.22;
  const subBaselines: number[] = [];
  let baseline = box.bottom;
  for (let i = subs.length - 1; i >= 0; i--) {
    baseline -= subs[i].px * descender;
    subBaselines.unshift(baseline);
    baseline -= subs[i].px * (1.5 - descender);
  }
  const titleBaseline = hasSub
    ? subBaselines[0] - subs[0].px * 1.5
    : box.bottom - titlePx * descender;

  const titleY =
    (overlay.system === "status_card"
      ? Math.max(box.top + titlePx, H * 0.33)
      : titleBaseline) - rise;
  const subYs =
    overlay.system === "status_card"
      ? subs.map((s, i) => titleY + s.px * 1.5 * (i + 1))
      : subBaselines.map((y) => y - rise);

  if (system.pill) {
    ctx.font = fontString(system, "title", titlePx, fonts);
    const w = measureTracked(ctx, titleCase, track * (titlePx / titleStart));
    const padY = titlePx * 0.34;
    ctx.save();
    ctx.globalAlpha = alpha * system.pill_alpha!;
    ctx.fillStyle = onLight ? "#f4f1ea" : "#0a0a0b";
    ctx.beginPath();
    ctx.roundRect(
      box.left,
      titleY - titlePx - padY * 0.7,
      Math.min(w + padX * 2, box.width),
      titlePx + padY * 2,
      titlePx * 0.28,
    );
    ctx.fill();
    ctx.restore();
  }

  ctx.font = fontString(system, "title", titlePx, fonts);
  ctx.fillStyle = inkTitle;
  trackedText(ctx, titleCase, textLeft, titleY, track * (titlePx / titleStart), "left");

  ctx.fillStyle = inkSub;
  subs.forEach((s, i) => {
    ctx.font = fontString(system, "sub", s.px, fonts);
    trackedText(ctx, s.text, textLeft, subYs[i], subTrack, "left");
  });

  ctx.restore();
}

/* ------------------------------------------------------- reference layouts */
/* The same three layouts as service/src/render/overlays.py: the Foxwood reference title
   (large serif status, address, beds / baths / area pill), the white social caption box,
   and the closing text over a darkened aerial. */

function setShadow(ctx: CanvasRenderingContext2D, blur: number, alpha: number) {
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = 0;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const trial = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(trial).width <= maxWidth) current = trial;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

function drawStatusTitle(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  statsLine: boolean,
  W: number,
  H: number,
  fonts: { sans: string; serif: string },
  box: SafeBox,
) {
  const cx = W / 2;
  const subs = lines.slice(1);
  const stats = statsLine && subs.length ? subs.pop()! : null;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  const titlePx = fitPx(ctx, lines[0], W * 0.15, box.width * 0.86, (px) => `500 ${Math.round(px)}px ${fonts.serif}`);
  const top = H * 0.205;
  setShadow(ctx, W * 0.024, 0.55);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(lines[0], cx, top);
  let y = top + titlePx * 1.32;

  for (const sub of subs) {
    const px = fitPx(ctx, sub, W * 0.04, box.width * 0.92, (p) => `500 ${Math.round(p)}px ${fonts.sans}`);
    setShadow(ctx, W * 0.012, 0.6);
    ctx.fillText(sub, cx, y);
    y += px * 1.9;
  }

  if (stats) {
    const px = fitPx(ctx, stats, W * 0.036, box.width * 0.78, (p) => `600 ${Math.round(p)}px ${fonts.sans}`);
    const w = ctx.measureText(stats).width;
    const padX = px * 1.1;
    const padY = px * 0.62;
    y += px * 0.2;
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "rgba(20,22,26,.51)";
    ctx.beginPath();
    ctx.roundRect(cx - w / 2 - padX, y - padY, w + padX * 2, px * 1.18 + padY * 2, (px * 1.18 + padY * 2) / 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(stats, cx, y);
  }
}

function drawSocialCaption(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  W: number,
  H: number,
  fonts: { sans: string; serif: string },
  box: SafeBox,
) {
  const cx = W / 2;
  const px = W * 0.05;
  const subPx = W * 0.036;
  const textW = box.width * 0.8;
  const rows: { text: string; px: number; font: string; fill: string }[] = [];
  const titleFont = `600 ${Math.round(px)}px ${fonts.sans}`;
  const subFont = `500 ${Math.round(subPx)}px ${fonts.sans}`;
  ctx.font = titleFont;
  for (const l of wrapLines(ctx, lines[0], textW)) rows.push({ text: l, px, font: titleFont, fill: "#111113" });
  ctx.font = subFont;
  for (const extra of lines.slice(1)) {
    for (const l of wrapLines(ctx, extra, textW)) rows.push({ text: l, px: subPx, font: subFont, fill: "#46464c" });
  }
  const gap = 1.28;
  const blockH = rows.reduce((s, r) => s + r.px * gap, 0) - rows[rows.length - 1].px * (gap - 1);
  const widest = Math.max(...rows.map((r) => ((ctx.font = r.font), ctx.measureText(r.text).width)));
  const padX = px * 0.7;
  const padY = px * 0.5;
  const top = H * 0.235;
  ctx.fillStyle = "rgba(255,255,255,.95)";
  ctx.beginPath();
  ctx.roundRect(cx - widest / 2 - padX, top - padY, widest + padX * 2, blockH + padY * 2.25, px * 0.55);
  ctx.fill();
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  let y = top;
  for (const r of rows) {
    ctx.font = r.font;
    ctx.fillStyle = r.fill;
    ctx.fillText(r.text, cx, y);
    y += r.px * gap;
  }
}

function drawCtaOverPhoto(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  W: number,
  H: number,
  fonts: { sans: string; serif: string },
  box: SafeBox,
) {
  const cx = W / 2;
  let y = H * 0.36;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  setShadow(ctx, W * 0.016, 0.55);
  const kicker = fitPx(ctx, lines[0], W * 0.1, box.width * 0.92, (px) => `500 ${Math.round(px)}px ${fonts.serif}`);
  ctx.fillText(lines[0], cx, y);
  y += kicker * 1.45;
  if (lines[1]) {
    const px = fitPx(ctx, lines[1], W * 0.05, box.width * 0.9, (p) => `600 ${Math.round(p)}px ${fonts.sans}`);
    ctx.fillText(lines[1], cx, y);
    y += px * 1.9;
  }
  const small = W * 0.03;
  ctx.font = `500 ${Math.round(small)}px ${fonts.sans}`;
  ctx.fillStyle = "rgba(232,232,236,.94)";
  for (const line of lines.slice(2)) {
    for (const part of wrapLines(ctx, line, box.width * 0.9)) {
      if (y + small * 1.3 > box.bottom) break;
      ctx.fillText(part, cx, y);
      y += small * 1.45;
    }
  }
}

/* ------------------------------------------------------------- segment draw */

function drawSegment(
  ctx: CanvasRenderingContext2D,
  recipe: ReelRecipe,
  seg: Segment,
  t: number,
  images: ImageBank,
  W: number,
  H: number,
  opts: DrawOptions,
) {
  const p = segmentProgress(seg, t);
  const img = images.get(seg.source.id);
  /* The floor plan draws on paper. Everything else carries a dark scrim or a navy
     card, so white ink is right there and wrong here. */
  const onLight = seg.motion === "self_draw";

  const onPhoto = seg.kind === "cta" && Boolean(img);
  if (seg.kind === "cta" && img) {
    drawPhotoLayer(ctx, img, seg.crop, seg.motion, p, W, H);
    ctx.fillStyle = `rgba(0,0,0,${CTA_SCRIM})`;
    ctx.fillRect(0, 0, W, H);
  } else if (seg.kind === "cta") {
    drawCtaGround(ctx, W, H);
  } else if (seg.motion === "self_draw") {
    drawSelfDraw(ctx, img, p, W, H);
  } else if (img) {
    drawPhotoLayer(ctx, img, seg.crop, seg.motion, p, W, H);
    scrim(ctx, W, H);
  } else {
    // A missing photo is drawn as a labelled placeholder, never as a silent black frame.
    ctx.fillStyle = "#1b1b1f";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#6b6b74";
    ctx.font = `500 ${Math.round(W * 0.035)}px ${opts.fonts.sans}`;
    ctx.textAlign = "center";
    ctx.fillText(`no photo for ${seg.kind}`, W / 2, H / 2);
  }

  for (const overlay of seg.overlays) {
    if (t < overlay.tIn || t >= overlay.tOut) continue;
    drawOverlay(ctx, overlay, recipe.typeVoice, t, W, H, opts.fonts, onLight, onPhoto);
  }
}

/* -------------------------------------------------------------- main entry */

/**
 * Draw the recipe at absolute time t. Called by the scrubber, the play loop and the
 * recorder; there is no separate "export path" in the browser.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  recipe: ReelRecipe,
  t: number,
  images: ImageBank,
  opts: DrawOptions,
) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  const seg = segmentAt(recipe, t);
  if (!seg) return;

  const index = recipe.segments.indexOf(seg);
  const prev = index > 0 ? recipe.segments[index - 1] : null;
  const since = t - seg.tIn;
  const xfade = TRANSITION_S[seg.transitionIn] ?? 0;

  if (prev && xfade > 0 && since < xfade) {
    // The outgoing segment keeps running underneath, as it will in the ffmpeg xfade.
    drawSegment(ctx, recipe, prev, t, images, W, H, opts);
    const a = ease(since / xfade);
    ctx.save();
    ctx.globalAlpha = a;
    if (seg.transitionIn === "whip_blur") ctx.filter = `blur(${(1 - a) * 12}px)`;
    if (seg.transitionIn === "zoom_through") {
      const s = lerp(1.15, 1, a);
      ctx.translate(W / 2, H / 2);
      ctx.scale(s, s);
      ctx.translate(-W / 2, -H / 2);
    }
    drawSegment(ctx, recipe, seg, t, images, W, H, opts);
    ctx.restore();
    // light_leak (pre rules v1.5) renders as a plain dissolve, as it does in ffmpeg.
  } else {
    drawSegment(ctx, recipe, seg, t, images, W, H, opts);
  }

  if (opts.showGuides) drawGuides(ctx, W, H);
}

function drawGuides(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const box = safeBox(W, H);
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "rgba(245,179,1,.8)";
  ctx.lineWidth = 1;
  ctx.strokeRect(box.left, box.top, box.width, box.bottom - box.top);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(245,179,1,.9)";
  ctx.font = `500 ${Math.round(W * 0.022)}px system-ui`;
  ctx.textAlign = "left";
  ctx.fillText("safe_zone_9x16", box.left + 4, box.top - 6);
  ctx.restore();
}

/** Canvas pixel size for an aspect. 1080x1920 masters are rendered by /service. */
export function canvasSize(aspect: "9x16" | "16x9") {
  return aspect === "9x16" ? { width: 540, height: 960 } : { width: 960, height: 540 };
}

export { ease, lerp };
export type { Overlay, Segment };
