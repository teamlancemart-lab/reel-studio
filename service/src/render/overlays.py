#!/usr/bin/env python3
"""
Overlay renderer. Pillow -> PNG sequence, composited by ffmpeg's overlay filter.

CLAUDE.md: "All text overlays are canvas-rendered PNG sequences composited by ffmpeg.
Never ffmpeg drawtext." rules.json render_constraints.no_drawtext says the same and
adds why: the ffmpeg in use ships without freetype, so drawtext does not exist. The
environment now enforces what was already the design.

This is the SECOND renderer of the same ReelRecipe overlays. The browser canvas in
web/src/lib/draw.ts is the first. The layout constants below are the same numbers:
safe zone from rules.json, the two type systems from rules.json type_systems, the
lower-third block laid out from its bottom so descenders stay inside the safe box.

Input: a JSON spec on stdin. Output: one PNG per overlay, plus a manifest on stdout.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ----------------------------------------------------------------- fonts

FONT_FILES = {
    "Inter": "Inter-Variable.ttf",
    "Playfair Display": "PlayfairDisplay-Variable.ttf",
    "Great Vibes": "GreatVibes-Regular.ttf",
}
_font_cache = {}


def load_font(fonts_dir, family, size):
    key = (family, int(size))
    if key in _font_cache:
        return _font_cache[key]
    name = FONT_FILES.get(family, FONT_FILES["Inter"])
    path = os.path.join(fonts_dir, name)
    try:
        font = ImageFont.truetype(path, int(size))
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            f"font {family} ({path}) failed to load: {exc}. "
            "The container fetches these at build time; macOS system fonts do not exist there."
        )
    _font_cache[key] = font
    return font


# ------------------------------------------------------------- measuring


def text_width(draw, text, font, track=0.0):
    if not text:
        return 0
    total = sum(draw.textlength(ch, font=font) for ch in text)
    return total + track * max(0, len(text) - 1)


def fit_size(draw, text, start_px, max_width, fonts_dir, family, track_ratio=0.0):
    """Shrink until it fits, tracking included. Returns (font, size, track)."""
    size = start_px
    for _ in range(40):
        font = load_font(fonts_dir, family, size)
        track = track_ratio * size
        if text_width(draw, text, font, track) <= max_width:
            return font, size, track
        size *= 0.94
    font = load_font(fonts_dir, family, size)
    return font, size, track_ratio * size


def draw_tracked(draw, xy, text, font, fill, track=0.0, anchor_center_x=None):
    x, y = xy
    if track <= 0:
        if anchor_center_x is not None:
            w = draw.textlength(text, font=font)
            x = anchor_center_x - w / 2
        draw.text((x, y), text, font=font, fill=fill)
        return
    if anchor_center_x is not None:
        x = anchor_center_x - text_width(draw, text, font, track) / 2
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + track


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


# ---------------------------------------------------------------- layout


def render_overlay(spec, W, H, fonts_dir, safe, systems):
    """One overlay -> one RGBA image the size of the frame."""
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)

    kind = spec.get("kind", "caption")
    voice = spec.get("voice") or spec.get("typeVoice") or "sans_pill"
    system = systems.get(voice, systems["sans_pill"])
    # Pillow cannot measure a string with a newline in it; B6 sometimes writes one.
    lines = [part for l in spec.get("lines", []) if l for part in str(l).split("\n") if part.strip()]
    if not lines:
        return im

    left = W * safe["side_frac"]
    right = W * (1 - safe["side_frac"])
    top = H * safe["top_frac"]
    bottom = H * (1 - safe["bottom_frac"])
    box_w = right - left

    on_light = bool(spec.get("onLight"))
    ink_title = (19, 32, 56, 255) if on_light else (255, 255, 255, 255)
    ink_sub = (19, 32, 56, 199) if on_light else (232, 232, 238, 240)

    title_family = system["title_font"]
    sub_family = system["sub_font"]
    title_case = system.get("title_case")
    sub_case = system.get("sub_case")

    title = lines[0].upper() if title_case in ("caps_small", "smallcaps") else lines[0]
    track_ratio = 0.06 if title_case == "caps_small" else 0.0

    # ---- disclosure: the AI-generated label. rules.json overlay_style min height.
    if kind == "disclosure":
        px = max(W * 0.026, 11)
        font = load_font(fonts_dir, sub_family, px)
        text = lines[0]
        w = draw.textlength(text, font=font)
        pad_x, pad_y = W * 0.015, px * 0.5
        rounded_rect(
            draw,
            [left, top, left + w + pad_x * 2, top + px + pad_y * 2],
            radius=px * 0.4,
            fill=(0, 0, 0, 150),
        )
        draw.text((left + pad_x, top + pad_y * 0.55), text, font=font, fill=(255, 255, 255, 242))
        return im

    # ---- cta band: centred stack
    if kind == "cta_band":
        cx = W / 2
        y = H * 0.42
        font, size, track = fit_size(
            draw, title, W * 0.05, box_w, fonts_dir, sub_family, 0.12
        )
        draw_tracked(draw, (0, y), title, font, (245, 179, 1, 255), track, anchor_center_x=cx)
        y += H * 0.07
        if len(lines) > 1:
            font, size, _ = fit_size(draw, lines[1], W * 0.085, box_w, fonts_dir, title_family)
            draw_tracked(draw, (0, y), lines[1], font, (244, 244, 245, 255), 0, anchor_center_x=cx)
            y += H * 0.055
        for line in lines[2:]:
            font, size, _ = fit_size(draw, line, W * 0.04, box_w, fonts_dir, sub_family)
            draw_tracked(
                draw, (0, min(y, bottom)), line, font, (214, 208, 196, 235), 0, anchor_center_x=cx
            )
            y += H * 0.045
        return im

    # ---- lower third: price_stack, status_card, address_only, number_first
    pill = bool(system.get("pill"))
    pad_x = W * 0.03
    text_left = left + (pad_x if pill else 0)
    usable = right - text_left - (pad_x if pill else 0)

    start_px = W * 0.105 if spec.get("system") in ("number_first", "price_stack") else W * 0.075
    title_font, title_px, title_track = fit_size(
        draw, title, start_px, usable, fonts_dir, title_family, track_ratio
    )

    # Every subtitle line is drawn. A third line used to be dropped without a word.
    sub_texts = [
        (l.upper() if sub_case in ("caps_small", "smallcaps") else l) for l in lines[1:]
    ]
    sub_track_ratio = 0.05 if sub_case == "smallcaps" else 0.0
    subs = [
        fit_size(draw, s, W * 0.04, usable, fonts_dir, sub_family, sub_track_ratio) for s in sub_texts
    ]
    has_sub = bool(subs)

    # Lay out from the BOTTOM so descenders stay inside the safe box.
    descender = 0.22
    sub_tops = []
    y = bottom
    for _, px, _ in reversed(subs):
        y -= px * (1 + descender)
        sub_tops.insert(0, y)
    first_sub_top = sub_tops[0] if has_sub else bottom
    # Without a subtitle the title is the bottom line, and a pill's padding hangs below
    # the glyphs further than a descender does. SAFE_ZONE caught it 8px over the line,
    # then 1.4px over once padded exactly (the rounded rectangle antialiases a row past
    # its coordinates), so the pill gets its padding plus 3 percent of the type size.
    title_block = max(1 + descender, 1.33 if pill else 0)
    title_top = (first_sub_top - title_px * 1.15) if has_sub else (bottom - title_px * title_block)

    if spec.get("system") == "status_card":
        title_top = max(top, H * 0.30)
        y = title_top + title_px * 1.25
        sub_tops = []
        for _, px, _ in subs:
            sub_tops.append(y)
            y += px * (1 + descender)

    if pill:
        w = text_width(draw, title, title_font, title_track)
        pad_y = title_px * 0.30
        alpha = int(255 * float(system.get("pill_alpha", 0.55)))
        rounded_rect(
            draw,
            [
                left,
                title_top - pad_y * 0.5,
                min(left + w + pad_x * 2, right),
                title_top + title_px + pad_y,
            ],
            radius=title_px * 0.28,
            fill=(244, 241, 234, alpha) if on_light else (10, 10, 11, alpha),
        )

    if system.get("shadow") and not on_light:
        for ox, oy in ((0, 3), (2, 2), (-2, 2)):
            draw_tracked(
                draw, (text_left + ox, title_top + oy), title, title_font, (0, 0, 0, 140), title_track
            )

    draw_tracked(draw, (text_left, title_top), title, title_font, ink_title, title_track)
    for (font, _, track), text, top_y in zip(subs, sub_texts, sub_tops):
        draw_tracked(draw, (text_left, top_y), text, font, ink_sub, track)

    return im


def main():
    spec = json.load(sys.stdin)
    W, H = spec["width"], spec["height"]
    fonts_dir = spec["fontsDir"]
    safe = spec["safeZone"]
    systems = spec["typeSystems"]
    out_dir = spec["outDir"]
    os.makedirs(out_dir, exist_ok=True)

    # The safe box in pixels. rules.json SAFE_ZONE: "any card bounding box outside
    # safe_zone_9x16" BLOCKs the export, so the box is measured from the pixels actually
    # drawn (alpha > 0: text, shadows, pills), not from the layout maths that placed them.
    safe_box = (
        W * safe["side_frac"],
        H * safe["top_frac"],
        W * (1 - safe["side_frac"]),
        H * (1 - safe["bottom_frac"]),
    )

    manifest = []
    for overlay in spec["overlays"]:
        im = render_overlay(overlay, W, H, fonts_dir, safe, systems)
        path = os.path.join(out_dir, f"{overlay['id']}.png")
        im.save(path)
        box = im.getchannel("A").getbbox()  # (l, t, r, b) exclusive, or None if empty
        outside = bool(box) and (
            box[0] < safe_box[0] - 0.5
            or box[1] < safe_box[1] - 0.5
            or box[2] > safe_box[2] + 0.5
            or box[3] > safe_box[3] + 0.5
        )
        manifest.append(
            {
                "id": overlay["id"],
                "path": path,
                "tIn": overlay["tIn"],
                "tOut": overlay["tOut"],
                "fadeS": overlay.get("fadeS", 0.35),
                "kind": overlay.get("kind"),
                "text": " / ".join(overlay.get("lines", []))[:120],
                "box": list(box) if box else None,
                "safe_box": [round(v, 1) for v in safe_box],
                "outside_safe_zone": outside,
            }
        )

    json.dump({"overlays": manifest}, sys.stdout)


if __name__ == "__main__":
    main()
