/**
 * Fit the shot list to a tier's length window. Pure function, no model call.
 *
 * rules.json slow tier is 30 to 40s, and the skeleton at slow durations is
 *   2.0 hook + 4.0 title + 6 x 3.9 interiors + 4.0 plan + 3.9 return + 5.0 cta = 42.3s
 * which overflows. B7's prompt says to drop from the tail of the interiors when that
 * happens, and B7 could not do the arithmetic reliably: reel 3 failed twice on
 * "total_length_s must be <= 40".
 *
 * So the model no longer does it. It picks the track and snaps cuts to the beat grid;
 * the length budget is decided here, deterministically, where it can be tested.
 *
 * The drop order is the spec's: never the hook, the floor plan or the CTA — only the
 * tail of the interiors, and amenities before interiors.
 */
import { rules } from "../config.js";

const PROTECTED = new Set([
  "hook",
  "exterior_title",
  "floor_plan",
  "cta_card",
  "exterior_return",
]);

const durationOf = (shot, tier) => Number(shot.duration_by_tier?.[tier]) || 0;

export function totalFor(shots, tier) {
  return Number(shots.reduce((s, shot) => s + durationOf(shot, tier), 0).toFixed(3));
}

/**
 * @returns { shots, dropped: [{shot_id, reason}], total, target }
 */
export function fitShotsToTier(allShots, tier) {
  const spec = rules.tiers[tier];
  const [, maxLen] = spec.target_length_s;
  // rules.json LENGTH is a WARN at 12..40; the tier target is the tighter bound.
  const ceiling = Math.min(maxLen, 40);

  const shots = [...allShots];
  const dropped = [];

  /* Amenities go first, then interiors from the tail. Both from the end, so the
     strongest rooms (which B5 ordered first) survive. */
  const droppableIndex = () => {
    for (let i = shots.length - 1; i >= 0; i--) {
      if (shots[i].slot === "amenity") return i;
    }
    for (let i = shots.length - 1; i >= 0; i--) {
      if (shots[i].slot === "interior") return i;
    }
    return -1;
  };

  let total = totalFor(shots, tier);
  let guard = 0;
  while (total > ceiling && guard++ < 50) {
    const i = droppableIndex();
    if (i === -1) break; // only protected slots left; the WARN is the right outcome
    const [gone] = shots.splice(i, 1);
    dropped.push({
      shot_id: gone.shot_id,
      reason: `tier_overflow: ${tier} tier caps at ${ceiling}s, dropped from the tail of the ${gone.slot} shots (${durationOf(gone, tier)}s)`,
    });
    total = totalFor(shots, tier);
  }

  return {
    shots,
    dropped,
    total,
    target: ceiling,
    /* True when even the protected skeleton overflows. B8's LENGTH rule reports it
       rather than this function pretending it fits. */
    stillOver: total > ceiling,
  };
}

/** Interiors left after fitting, for the record. */
export function interiorCount(shots) {
  return shots.filter((s) => s.slot === "interior" || s.slot === "amenity").length;
}

/* ------------------------------------------------------------- cut map */

/**
 * The cut map. Deterministic.
 *
 * B7 was asked to "snap cuts to the nearest beat" and instead returned the beat grid
 * itself: at 96bpm with cut_every_beats 8 it emitted cuts 5s apart for shots 2 to 4s
 * long, so reel 3 planned 38.4s of shots and produced a 72s timeline.
 *
 * Snapping is a small correction to the cumulative position, not a replacement for it.
 * A cut moves to the nearest beat only when that beat is within half a beat; otherwise
 * the shot's own duration wins. The model still chooses the track and the transitions,
 * which are taste. The clock is arithmetic.
 */
export function buildCutMap(shots, tier, track) {
  const beats = track?.beat_times || [];
  const spb = track?.seconds_per_beat || 0;
  const tolerance = spb / 2;
  const everyN = rules.tiers[tier]?.cut_every_beats ?? 1;

  const nearestBeat = (t) => {
    if (!beats.length) return null;
    let best = null;
    let bestD = Infinity;
    // Only beats on this tier's grid are candidates.
    for (let i = 0; i < beats.length; i += everyN) {
      const d = Math.abs(beats[i] - t);
      if (d < bestD) {
        bestD = d;
        best = beats[i];
      }
    }
    return bestD <= tolerance ? best : null;
  };

  const cuts = [];
  let t = 0;
  for (const shot of shots) {
    const snapped = cuts.length === 0 ? 0 : nearestBeat(t);
    const at = snapped ?? t;
    cuts.push({
      t: Number(at.toFixed(3)),
      shot_id: shot.shot_id,
      on_beat: snapped !== null,
    });
    // The next shot starts where this one ends, measured from the snapped position.
    t = at + durationOf(shot, tier);
  }

  return { cuts, total: Number(t.toFixed(3)) };
}
