/**
 * What a caption is about, where it may sit, and what it may never say.
 *
 * Two D3 exports shipped copy that made the reel look broken:
 *   - "Water Damage Visible" as an on-screen caption. B1 recorded the damage as an
 *     ordinary observed item, and B6 marketed it on all three reels.
 *   - captions on the wrong rooms. "Two Full Kitchens" was the proof card, which rides
 *     the proof slot, and the proof shot was a living room. "Brick Facade" was bound to
 *     a bedroom. B6's prompt DID list each shot's room_class; the model ignored it.
 *
 * So both are code, not prompt. Pure functions, no model call, no I/O:
 *   defectMatch       rules.json defect_terms, the single list every stage reads
 *   quarantineDefects B1: defects leave observed/specials/provable_numbers
 *   subjectOf         which room (or the whole property) a card is about
 *   bindCaptions      B6: every caption on a shot of its own room, or dropped by name
 */
import { rules } from "../config.js";

/* ---------------------------------------------------------------- defects */

const DEFECT_RE = new RegExp(`\\b(?:${rules.defect_terms.patterns.join("|")})\\b`, "i");

/** The matched term, or null. */
export function defectMatch(text) {
  const m = String(text ?? "").match(DEFECT_RE);
  return m ? m[0] : null;
}

/**
 * B1 post-process. Negative observations become `defects` — recorded with their photo
 * so a person can see them, and removed from everything copy is allowed to cite.
 * Mutates and returns `truth`, plus what moved and why.
 */
export function quarantineDefects(truth) {
  const defects = [...(truth.defects || [])];
  const moved = [];

  truth.observed = (truth.observed || []).filter((o) => {
    const term = defectMatch(o.text);
    if (!term) return true;
    defects.push({ id: o.id, text: o.text, photo_id: o.photo_id, term });
    moved.push(`observed ${o.id} "${o.text}" -> defects (term "${term}")`);
    return false;
  });

  const defectIds = new Set(defects.map((d) => d.id));
  truth.specials = (truth.specials || []).filter((s) => {
    const term = defectMatch(s.text);
    const cites = defectIds.has(s.source?.id);
    if (!term && !cites) return true;
    moved.push(`special ${s.id} "${s.text}" removed (${term ? `term "${term}"` : `cites defect ${s.source.id}`})`);
    return false;
  });

  truth.provable_numbers = (truth.provable_numbers || []).filter((p) => {
    const term = defectMatch(`${p.label} ${p.display}`);
    if (!term) return true;
    moved.push(`provable_number ${p.id} "${p.label}" removed (term "${term}")`);
    return false;
  });

  if (defects.length) {
    const rule = "any mention of a property defect, damage, condition issue or repair, on screen or in the post";
    truth.never_claim = [...new Set([...(truth.never_claim || []), rule])];
  }
  truth.defects = defects;
  return { truth, moved, defectIds };
}

/* ---------------------------------------------------------------- subjects */

/** RoomClass -> the room family a caption subject is matched against. */
export const ROOM_FAMILY = {
  exterior_front: "exterior",
  exterior_rear: "exterior",
  exterior_side: "exterior",
  aerial_34: "exterior",
  aerial_topdown: "exterior",
  aerial_wide: "exterior",
  garden: "exterior",
  terrace: "outdoor",
  balcony_view: "outdoor",
  pool: "pool",
  foyer: "entry",
  hallway: "entry",
  stairs: "entry",
  living: "living",
  dining: "dining",
  kitchen: "kitchen",
  primary_bedroom: "bedroom",
  bedroom: "bedroom",
  bathroom: "bathroom",
  half_bath: "bathroom",
  garage: "garage",
  gym: "amenity",
  clubhouse: "amenity",
  floor_plan: "plan",
  site_plan: "plan",
  other: null,
};

/**
 * Subject -> the shot families that may carry it. A room subject is carried only by
 * that room. A whole-property fact (price, beds, area, year) is about the house, so it
 * sits on the house: an exterior or the plan, never on some particular room.
 */
const HOSTS = {
  whole: ["exterior", "plan"],
  outdoor: ["outdoor", "exterior"],
};
export const hostsFor = (subject) => HOSTS[subject] ?? [subject];

/** Title before subtitle, first match wins, most specific rooms first. */
const TEXT_SUBJECTS = [
  ["kitchen", /\b(kitchens?|island|pantry|stove|range hood|cabinet(ry|s)?|counter ?tops?|dishwasher|refrigerator|fridge)\b/i],
  ["bathroom", /\b(bath ?rooms?|baths?|shower|tubs?|vanity|powder room|toilet)\b/i],
  ["bedroom", /\b(bed ?rooms?|primary suite|master suite|closets?|wardrobes?)\b/i],
  ["dining", /\bdining\b/i],
  ["living", /\b(living rooms?|family rooms?|fireplace|lounge)\b/i],
  ["entry", /\b(foyer|entryway|hallway|staircase|stairs)\b/i],
  ["garage", /\bgarage\b/i],
  ["basement", /\bbasement\b/i],
  ["pool", /\bpool\b/i],
  ["outdoor", /\b(balcon(y|ies)|terrace|deck|patio)\b/i],
  ["exterior", /\b(fa[cç]ade|exterior|porch|yard|lawn|driveway|parking|roof|siding|curb appeal|brick)\b/i],
];

export function subjectFromText(text) {
  for (const [subject, re] of TEXT_SUBJECTS) if (re.test(String(text ?? ""))) return subject;
  return null;
}

/** Form fields that hold free prose; a claim sourced from one is placed by its words. */
const FREE_TEXT_FACTS = new Set(["features_text", "description", "remarks", "highlights", "captions"]);

/**
 * @returns { subject, via } or null when nothing says what the card is about.
 *
 * Evidence order: a room named by a source (an observed item's photo, or a special
 * that traces to one) > a whole-property source (a provable number, a structured form
 * field) > the card's own words. A card about "4 bedrooms" sourced from beds is a
 * whole-property count, not a bedroom caption.
 */
export function subjectOf(card, { truth, assetsById }) {
  const resolve = (src, seen = new Set()) => {
    if (!src?.id || seen.has(`${src.kind}:${src.id}`)) return null;
    seen.add(`${src.kind}:${src.id}`);
    switch (src.kind) {
      case "observed": {
        const o = truth.observed.find((x) => x.id === src.id);
        const rc = o && assetsById[o.photo_id]?.room_class;
        const fam = rc && ROOM_FAMILY[rc];
        return fam ? { subject: fam, via: `observed ${src.id} is photo ${o.photo_id} (${rc})` } : null;
      }
      case "special": {
        const sp = truth.specials.find((x) => x.id === src.id);
        if (!sp) return null;
        const up = resolve(sp.source, seen);
        if (up) return { subject: up.subject, via: `special ${sp.id} <- ${up.via}` };
        const t = subjectFromText(sp.text);
        return t ? { subject: t, via: `special ${sp.id} text "${sp.text}"` } : null;
      }
      case "provable_number":
        return { subject: "whole", via: `provable_number ${src.id}` };
      case "fact":
        return FREE_TEXT_FACTS.has(src.id) ? null : { subject: "whole", via: `fact ${src.id}` };
      default:
        return null;
    }
  };

  const found = (card.sources || []).map((s) => resolve(s)).filter(Boolean);
  const room = found.find((f) => f.subject !== "whole");
  if (room) return room;
  if (found.length) return found[0];
  const fromTitle = subjectFromText(card.title);
  if (fromTitle) return { subject: fromTitle, via: `title "${card.title}"` };
  const fromSub = subjectFromText(card.subtitle);
  if (fromSub) return { subject: fromSub, via: `subtitle "${card.subtitle}"` };
  return null;
}

/* ---------------------------------------------------------------- binding */

/** Slots that never carry a fact caption: the hook has its title card, the CTA its band,
 *  and the plan its own floor_plan_card. */
const NO_FACT_SLOTS = new Set(["hook", "cta_card", "floor_plan"]);

/**
 * B6 post-process. Every proof card and fact caption ends on a shot of its own room,
 * or is removed with the reason recorded in copy.caption_binding.
 *
 * Pass 1 keeps every card already on a matching shot, so a correct caption is never
 * bumped by a misplaced one. Pass 2 moves each misplaced card to the first free shot of
 * its room (shot-list order), or drops it. A proof card that moves becomes a fact
 * caption on its new shot, because the proof slot is a place, not a promise.
 *
 * @returns { copy, binding }  copy is mutated
 */
export function bindCaptions(copy, { truth, shots, assetsById }) {
  const roomOf = (shot) => assetsById[shot?.photo_id]?.room_class ?? shot?.room_class ?? null;
  const famOf = (shot) => ROOM_FAMILY[roomOf(shot)] ?? null;
  const fits = (subject, shot) => Boolean(shot) && hostsFor(subject).includes(famOf(shot));
  const byId = new Map(shots.map((s) => [s.shot_id, s]));
  const proofShot = shots.find((s) => s.slot === "proof") || shots.find((s) => s.slot === "exterior_title");

  const items = [];
  if (copy.proof_card) items.push({ label: "proof_card", card: copy.proof_card, shot: proofShot, isProof: true });
  (copy.fact_captions || []).forEach((c, i) =>
    items.push({ label: `fact_captions[${i}]`, card: c, shot: byId.get(c.shot_id), isProof: false }),
  );

  const occupied = new Set();
  const binding = [];
  const keptFacts = [];
  let proofKept = false;

  const record = (item, action, extra) => {
    binding.push({
      card: item.label,
      title: item.card.title,
      subject: item.subject?.subject ?? null,
      subject_via: item.subject?.via ?? null,
      from_shot: item.shot?.shot_id ?? item.card.shot_id ?? null,
      from_room: roomOf(item.shot),
      action,
      ...extra,
    });
  };

  for (const item of items) item.subject = subjectOf(item.card, { truth, assetsById });

  /* One fact, one caption per reel. Reel 2 carried "Two full kitchens" as a fact caption
     on one kitchen AND as the proof card, which the binder then moved onto the other
     kitchen: correct rooms, same line twice. A card already on its own room wins over a
     copy that would have to move. */
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seenTitles = new Map();
  const placedFirst = [...items].sort(
    (a, b) => Number(!(a.subject && fits(a.subject.subject, a.shot))) - Number(!(b.subject && fits(b.subject.subject, b.shot))),
  );
  for (const item of placedFirst) {
    const k = norm(item.card.title);
    if (!k) continue;
    if (seenTitles.has(k)) {
      item.done = true;
      record(item, "dropped", { reason: `duplicate of ${seenTitles.get(k)} "${item.card.title}"` });
    } else {
      seenTitles.set(k, item.label);
    }
  }

  // pass 1: already right
  for (const item of items) {
    if (item.done || !item.subject || !fits(item.subject.subject, item.shot) || occupied.has(item.shot.shot_id)) continue;
    if (!item.isProof && NO_FACT_SLOTS.has(item.shot.slot)) continue;
    occupied.add(item.shot.shot_id);
    item.done = true;
    if (item.isProof) proofKept = true;
    else keptFacts.push({ ...item.card, shot_id: item.shot.shot_id, subject: item.subject.subject });
    record(item, "kept", { to_shot: item.shot.shot_id, to_room: roomOf(item.shot) });
  }

  // pass 2: move or drop
  for (const item of items) {
    if (item.done) continue;
    if (!item.subject) {
      record(item, "dropped", { reason: "no identifiable subject: no source names a room or the property, and the text names no room" });
      continue;
    }
    const host = shots.find(
      (s) => s.photo_id && !NO_FACT_SLOTS.has(s.slot) && !occupied.has(s.shot_id) && fits(item.subject.subject, s),
    );
    if (!host) {
      record(item, "dropped", {
        reason: `no free shot of ${hostsFor(item.subject.subject).join("/")} in this reel; ${
          item.shot ? `it was on ${item.shot.shot_id} (${roomOf(item.shot)})` : "its shot_id does not exist"
        }`,
      });
      continue;
    }
    occupied.add(host.shot_id);
    const { shot_id: _old, ...card } = item.card;
    keptFacts.push({ ...card, shot_id: host.shot_id, subject: item.subject.subject });
    record(item, "moved", { to_shot: host.shot_id, to_room: roomOf(host) });
  }

  if (!proofKept) delete copy.proof_card;
  else copy.proof_card = { ...copy.proof_card, subject: items.find((i) => i.isProof).subject.subject };
  copy.fact_captions = keptFacts;
  copy.caption_binding = binding;
  return { copy, binding };
}

/** Every string in a CopySet a viewer could read, with where it lives. */
export function copyTexts(copy) {
  const out = [];
  const push = (where, text) => text && out.push({ where, text: String(text) });
  for (const name of ["hook_card", "proof_card", "floor_plan_card", "cta_card"]) {
    push(`${name}.title`, copy[name]?.title);
    push(`${name}.subtitle`, copy[name]?.subtitle);
  }
  push("cta_card.agent_line", copy.cta_card?.agent_line);
  (copy.cta_card?.compliance_lines || []).forEach((l, i) => push(`cta_card.compliance_lines[${i}]`, l));
  (copy.fact_captions || []).forEach((c, i) => {
    push(`fact_captions[${i}].title`, c.title);
    push(`fact_captions[${i}].subtitle`, c.subtitle);
  });
  push("post_caption", copy.post_caption);
  (copy.hashtags || []).forEach((h, i) => push(`hashtags[${i}]`, h));
  return out;
}
