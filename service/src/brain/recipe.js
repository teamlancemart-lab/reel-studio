/**
 * buildRecipe(B3, B5, B6, B7) -> ReelRecipe[]
 *
 * Pure function. No model call, no cost, no I/O. This is the seam the whole system
 * turns on: everything above it is planning, everything below it is rendering, and
 * both the browser canvas and the ffmpeg exporter consume exactly what comes out.
 *
 * It is also the reason a retune is free. Change a cut time, rebuild the recipe,
 * re-render. Nothing upstream re-runs.
 */

/** ShotList.slot -> ReelRecipe SegmentKind. */
const SLOT_TO_KIND = {
  hook: "hook",
  exterior_title: "exterior_title",
  proof: "interior",
  interior: "interior",
  amenity: "interior",
  floor_plan: "floor_plan",
  exterior_return: "exterior_return",
  aerial_topdown: "exterior_return",
  aerial_wide: "exterior_return",
  cta_card: "cta",
};

/** ShotList.direction -> ReelRecipe Motion. */
const DIRECTION_TO_MOTION = {
  push: "push",
  pull: "pull",
  pan_l: "pan_l",
  pan_r: "pan_r",
  parallax: "parallax_lr",
  static: "static",
  self_draw: "self_draw",
};

/**
 * rules.json transitions -> what both renderers implement.
 *
 * rules.json v1.5 dropped light_leak (it rendered as a near-white flash frame) and
 * blueprint_wipe (never had a renderer). B7 plans stored before v1.5 can still name
 * them, so both map to a crossfade — which can create a repeat the plan did not have,
 * so no_repeat_consecutive is re-applied after mapping, below.
 */
const TRANSITION_MAP = {
  cut: "cut",
  crossfade_short: "crossfade",
  crossfade: "crossfade",
  zoom_through: "zoom_through",
  whip_blur: "whip_blur",
  light_leak: "crossfade",
  blueprint_wipe: "crossfade",
};

/** Alternatives to fall back on, in order, when the mapping creates a repeat. */
const TRANSITION_FALLBACKS = ["crossfade", "zoom_through", "cut"];

/** Room classes a closing card may sit on, best first: the reference reels end on the
 *  wide aerial, and a CTA over the property reads as the end of a tour, not an ad. */
const CTA_GROUNDS = ["aerial_wide", "aerial_34", "aerial_topdown", "exterior_front"];

const camelCrop = (c) =>
  c
    ? {
        xCenter: clamp01(c.x_center),
        yCenter: clamp01(c.y_center ?? 0.5),
        widthFrac: clamp01(c.width_frac || 1) || 1,
        ...(c.keeps_feature ? { keepsFeature: c.keeps_feature } : {}),
      }
    : { xCenter: 0.5, yCenter: 0.5, widthFrac: 1 };

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
const round3 = (n) => Number(n.toFixed(3));

/**
 * @param b3 FormatPlan
 * @param b5 ShotList
 * @param b6 CopySet[] indexed by reel_n
 * @param b7 PacingPlan[] indexed by reel_n
 * @param opts.photoUrl (photoId) => url
 * @param opts.typeVoice from B2
 * @returns { recipes, notes }  notes records every adjustment, never silent
 */
export function buildRecipes(b3, b5, b6, b7, opts = {}) {
  const { photoUrl = () => undefined, typeVoice = "sans_pill", facts = null, assets = [] } = opts;
  const recipes = [];
  const notes = [];

  for (const formatEntry of b3.reels) {
    const reelN = formatEntry.reel_n;
    const copy = b6.find((c) => c.reel_n === reelN);
    const pacing = b7.find((p) => p.reel_n === reelN);
    if (!copy || !pacing) {
      notes.push(`reel ${reelN}: missing ${!copy ? "B6" : "B7"}, no recipe built`);
      continue;
    }

    const built = buildOne({ formatEntry, shotList: b5, copy, pacing, photoUrl, typeVoice, facts, assets });
    recipes.push(built.recipe);
    notes.push(...built.notes.map((n) => `reel ${reelN}: ${n}`));
  }

  return { recipes, notes };
}

function buildOne({ formatEntry, shotList, copy, pacing, photoUrl, typeVoice, facts, assets }) {
  const notes = [];
  const tier = pacing.tier || formatEntry.tier;
  const dropped = new Set(pacing.dropped_shot_ids || []);
  const shotById = new Map(shotList.shots.map((s) => [s.shot_id, s]));

  /* The cut map is the timeline. Sort it, drop cuts whose shot does not exist or was
     dropped, and de-duplicate identical times so the segments tile cleanly. */
  let cuts = (pacing.cuts || [])
    .filter((c) => {
      if (dropped.has(c.shot_id)) return false;
      if (!shotById.has(c.shot_id)) {
        notes.push(`cut references unknown shot_id "${c.shot_id}", ignored`);
        return false;
      }
      return true;
    })
    .map((c) => ({ ...c, t: Number(c.t) || 0 }))
    .sort((a, b) => a.t - b.t);

  cuts = cuts.filter((c, i) => i === 0 || c.t > cuts[i - 1].t + 0.01);

  if (cuts.length === 0) {
    notes.push("no usable cuts, falling back to the shot list order at tier durations");
    let t = 0;
    cuts = shotList.shots
      .filter((s) => !dropped.has(s.shot_id))
      .map((s) => {
        const entry = { t, shot_id: s.shot_id, transition: "cut" };
        t += s.duration_by_tier?.[tier] ?? 2;
        return entry;
      });
  }

  if (cuts[0].t > 0.001) {
    notes.push(`first cut was at ${cuts[0].t.toFixed(2)}s, moved to 0 so the reel starts at zero`);
    cuts[0].t = 0;
  }

  let total = Number(pacing.total_length_s) || 0;
  const lastShot = shotById.get(cuts[cuts.length - 1].shot_id);
  const minTotal =
    cuts[cuts.length - 1].t + (lastShot?.duration_by_tier?.[tier] ?? 2);
  if (total < minTotal) {
    notes.push(
      `total_length_s ${total.toFixed(2)} was shorter than the last cut plus its duration, extended to ${minTotal.toFixed(2)}`,
    );
    total = minTotal;
  }

  /* Segments tile [0, total] exactly: each runs to the next cut. */
  const segments = cuts.map((cut, i) => {
    const shot = shotById.get(cut.shot_id);
    const tIn = round3(cut.t);
    const tOut = round3(i + 1 < cuts.length ? cuts[i + 1].t : total);
    const kind = SLOT_TO_KIND[shot.slot] || "interior";
    const photoId = shot.photo_id;

    return {
      kind,
      tIn,
      tOut,
      source:
        kind === "cta" || !photoId
          ? { type: "photo", id: `card:cta:${copy.reel_n}` }
          : { type: "photo", id: photoId, url: photoUrl(photoId) },
      crop: camelCrop(shot.crop_9x16),
      motion: DIRECTION_TO_MOTION[shot.direction] || "static",
      transitionIn: i === 0 ? "cut" : TRANSITION_MAP[cut.transition] || "cut",
      overlays: [],
      shotId: shot.shot_id,
      slot: shot.slot,
    };
  });

  /* Re-apply no_repeat_consecutive after the mapping collapsed six values into five.
     "cut" is exempt: two hard cuts in a row is ordinary editing, not a repeated effect. */
  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1].transitionIn;
    if (segments[i].transitionIn !== previous || previous === "cut") continue;
    const replacement = TRANSITION_FALLBACKS.find((t) => t !== previous);
    notes.push(
      `${segments[i].kind} at ${segments[i].tIn}s repeated "${previous}" after the transition mapping, changed to "${replacement}"`,
    );
    segments[i].transitionIn = replacement;
  }

  /* Overlays. Each one is clamped inside its segment, because validateRecipe rejects
     an overlay that escapes and rules.json SAFE_ZONE blocks the export. */
  const attach = (segment, overlay) => {
    if (!segment) return;
    const lead = Math.min(0.3, (segment.tOut - segment.tIn) * 0.15);
    segment.overlays.push({
      ...overlay,
      tIn: round3(Math.max(segment.tIn, segment.tIn + lead)),
      tOut: round3(segment.tOut),
    });
  };

  const bySlot = (slot) => segments.find((s) => s.slot === slot);
  const byShotId = (id) => segments.find((s) => s.shotId === id);

  const cardLines = (card) => [card?.title, card?.subtitle].filter(Boolean);

  const hookSeg = bySlot("hook") || segments[0];
  if (copy.hook_card) {
    const system = formatEntry.title_card_system || "status_card";
    const lines = cardLines(copy.hook_card);
    /* status_card is the reference title: status, address, then the beds / baths / area
       line. That line is the form's own numbers, formatted here rather than written by a
       model, so it cannot drift from the facts. */
    const statsLine = system === "status_card" ? factsLine(facts) : null;
    if (statsLine) lines.push(statsLine);
    const title = { kind: "title", system, lines, ...(statsLine ? { statsLine: true } : {}) };

    /* The title holds from the reveal through the exterior shot, as in the reference
       reels, so it is attached to both segments and the join does not fade. */
    const exteriorSeg = segments[segments.indexOf(hookSeg) + 1];
    const carries = system === "status_card" && exteriorSeg?.slot === "exterior_title";
    attach(hookSeg, { ...title, ...(carries ? { fadeOutS: 0 } : {}) });
    if (carries) {
      exteriorSeg.overlays.push({ ...title, fadeInS: 0, tIn: exteriorSeg.tIn, tOut: exteriorSeg.tOut });
    }
  }

  /* The subject rides along so CAPTION_SUBJECT_MISMATCH checks what the binder decided,
     not a re-guess from the words. */
  const subjectOf = (card) => (card?.subject ? { subject: card.subject } : {});

  const proofSeg = bySlot("proof") || bySlot("exterior_title");
  if (copy.proof_card && proofSeg?.overlays.some((o) => o.kind === "title")) {
    notes.push(`proof_card "${copy.proof_card.title}" dropped: no proof shot, and ${proofSeg.kind} already carries the title card`);
  } else if (copy.proof_card) {
    attach(proofSeg, {
      kind: "caption",
      system: "address_only",
      lines: cardLines(copy.proof_card),
      ...subjectOf(copy.proof_card),
    });
  }

  for (const caption of copy.fact_captions || []) {
    const seg = byShotId(caption.shot_id);
    if (!seg) {
      notes.push(`fact_caption for unknown shot "${caption.shot_id}" dropped`);
      continue;
    }
    /* A copy set bound before the binder kept captions off exterior_title can still put
       one under the carried title. Two text blocks on one shot is never the intent. */
    if (seg.overlays.some((o) => o.kind === "title")) {
      notes.push(`fact_caption "${caption.title}" dropped: ${seg.kind} at ${seg.tIn}s already carries the title card`);
      continue;
    }
    attach(seg, { kind: "caption", system: "address_only", lines: cardLines(caption), ...subjectOf(caption) });
  }

  if (copy.floor_plan_card) {
    const seg = bySlot("floor_plan");
    if (seg) {
      attach(seg, {
        kind: "caption",
        system: "number_first",
        lines: cardLines(copy.floor_plan_card),
      });
    } else {
      notes.push("floor_plan_card written but no floor_plan shot in the cut map");
    }
  }

  const ctaSeg = bySlot("cta_card") || segments[segments.length - 1];
  if (ctaSeg?.kind === "cta") {
    const ground = ctaGround(segments, ctaSeg, assets);
    if (ground) {
      ctaSeg.source = { type: "photo", id: ground.photo_id, url: photoUrl(ground.photo_id) };
      ctaSeg.crop = camelCrop(ground.safe_crop_9x16);
      ctaSeg.motion = "pull";
      notes.push(`cta_card sits on ${ground.photo_id} (${ground.room_class})`);
    } else {
      notes.push("cta_card has no aerial or exterior photo to sit on; it is a plain card");
    }
  }
  if (copy.cta_card) {
    attach(ctaSeg, {
      kind: "cta_band",
      system: "search_intent",
      lines: [
        copy.cta_card.title,
        copy.cta_card.agent_line,
        ...(copy.cta_card.compliance_lines || []),
      ].filter(Boolean),
    });
  }

  /* The disclosure rides the hook. In D2 the hook is an untouched photo, so B6 may
     have left it empty; only attach one when there is text. */
  if (copy.disclosure_overlay?.text) {
    attach(hookSeg, {
      kind: "disclosure",
      system: "address_only",
      lines: [copy.disclosure_overlay.text],
    });
  }

  const recipe = {
    reelId: `reel-${copy.reel_n}`,
    tier,
    aspect: "9x16",
    fps: 30,
    durationS: round3(total),
    typeVoice,
    segments: segments.map(({ shotId, slot, ...s }) => ({ ...s, shotId, slot })),
    audio: {
      trackId: pacing.track_id,
      dropMs: Math.round((pacing.drop_time_s ?? 0) * 1000),
    },
  };

  return { recipe, notes };
}

/** "6 Beds · 8 Baths · 13,847 Sq Ft" from the form, or null when the form has none of it. */
export function factsLine(facts) {
  if (!facts) return null;
  const parts = [];
  const n = (v) => (v == null || v === "" ? null : Number(v));
  const beds = n(facts.beds);
  const baths = n(facts.baths);
  const area = n(facts.area_value);
  if (beds) parts.push(`${beds} ${beds === 1 ? "Bed" : "Beds"}`);
  if (baths) parts.push(`${baths} ${baths === 1 ? "Bath" : "Baths"}`);
  if (area) {
    const unit = { sqft: "Sq Ft", sqm: "sq m", sqyd: "sq yd" }[facts.area_unit] ?? facts.area_unit ?? "";
    /* rules.json IN_AREA_BASIS: an area in India says carpet. Elsewhere the number stands. */
    const basis = facts.market === "in" && facts.area_basis ? ` ${facts.area_basis}` : "";
    parts.push(`${area.toLocaleString("en-US")} ${unit}${basis}`.trim());
  }
  return parts.length ? parts.join("  ·  ") : null;
}

/**
 * The photo a closing card sits on: the best aerial or exterior that is not the shot
 * straight before it (a cut to the same photo reads as a stutter), and one the reel has
 * not used at all when there is a choice.
 */
function ctaGround(segments, ctaSeg, assets) {
  const i = segments.indexOf(ctaSeg);
  const previous = segments[i - 1]?.source?.id;
  const used = new Set(segments.map((s) => s.source?.id));
  const candidates = assets.filter(
    (a) => CTA_GROUNDS.includes(a.room_class) && a.photo_id !== previous && !a.flags?.people_present && !a.excluded_reason,
  );
  const rank = (a) => CTA_GROUNDS.indexOf(a.room_class) * 2 + (used.has(a.photo_id) ? 1 : 0);
  return candidates.sort((a, b) => rank(a) - rank(b) || (b.scores?.composition ?? 0) - (a.scores?.composition ?? 0))[0] ?? null;
}

/**
 * The same validator the browser runs, so the service can refuse to hand out a recipe
 * the canvas would reject. Kept in step with shared/recipe.ts by the shape of the test.
 */
export function validateRecipe(recipe) {
  const problems = [];
  if (!recipe.segments?.length) problems.push("recipe has no segments");
  let cursor = 0;
  recipe.segments.forEach((seg, i) => {
    if (Math.abs(seg.tIn - cursor) > 1e-3) {
      problems.push(
        `segment ${i} (${seg.kind}) starts at ${seg.tIn} , expected ${cursor.toFixed(3)}`,
      );
    }
    if (seg.tOut <= seg.tIn) problems.push(`segment ${i} (${seg.kind}) has no duration`);
    for (const o of seg.overlays) {
      if (o.tIn < seg.tIn - 1e-3 || o.tOut > seg.tOut + 1e-3) {
        problems.push(`segment ${i} overlay "${o.lines[0]}" escapes its segment`);
      }
    }
    cursor = seg.tOut;
  });
  if (Math.abs(cursor - recipe.durationS) > 1e-3) {
    problems.push(`segments end at ${cursor.toFixed(3)} but durationS is ${recipe.durationS}`);
  }
  return problems;
}
