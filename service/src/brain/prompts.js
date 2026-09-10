/**
 * The system prompts, from docs/property-reel-brain-v1.md section 2.
 *
 * These are the contract, not a paraphrase. Where a prompt says "from rules.json", the
 * relevant slice of rules.json is interpolated rather than restated, so editing
 * rules.json changes behaviour and this file does not drift from it.
 *
 * Every prompt ends with the same instruction: return only JSON matching the schema,
 * no prose.
 */
import { rules, schemas } from "../config.js";

const JSON_ONLY =
  "\nReturn only JSON matching the schema. No prose, no markdown fences, no commentary.";

/** Append the retry hint the runner produces from schema errors. */
export function withRetry(prompt, retryHint) {
  return retryHint ? `${prompt}\n\n${retryHint}` : prompt;
}

/**
 * The node's actual JSON Schema, inlined into the prompt.
 *
 * Describing a shape in prose and then validating it against schemas.json is two
 * sources of truth, and the model loses that game: the first run dropped
 * `price_display`, every `specials[].source` and every `provable_numbers[].label`,
 * all of which the prose mentioned but never named as required. Handing over the
 * schema costs a few hundred input tokens at $0.30/M and removes the whole class.
 */
function walkLimits(node, path, out, defs, seen = new Set()) {
  if (!node || typeof node !== "object") return;
  if (node.$ref) {
    const key = node.$ref.replace("#/$defs/", "");
    if (seen.has(key)) return;
    walkLimits(defs[key], path, out, defs, new Set([...seen, key]));
    return;
  }
  const limits = [];
  if (node.maxLength != null) {
    /* Models count words far better than characters. A bare "at most 200 characters"
       was ignored twice in a row by flash-lite; the word budget alongside it is what
       actually lands. ~6 characters per word including the space. */
    const words = Math.floor(node.maxLength / 6);
    limits.push(`at most ${node.maxLength} characters (roughly ${words} words) — COUNT THIS`);
  }
  if (node.minLength != null) limits.push(`at least ${node.minLength} characters`);
  if (node.maxItems != null) limits.push(`at most ${node.maxItems} items`);
  if (node.minItems != null) limits.push(`at least ${node.minItems} items`);
  if (node.minimum != null) limits.push(`minimum ${node.minimum}`);
  if (node.maximum != null) limits.push(`maximum ${node.maximum}`);
  if (limits.length) out.push(`${path || "(root)"}: ${limits.join(", ")}`);

  for (const [k, v] of Object.entries(node.properties || {})) {
    walkLimits(v, path ? `${path}.${k}` : k, out, defs, seen);
  }
  if (node.items) walkLimits(node.items, `${path}[]`, out, defs, seen);
  for (const branch of node.allOf || []) walkLimits(branch, path, out, defs, seen);
}

/**
 * The numeric limits, pulled out of the schema and put where they can be seen.
 *
 * They are already in the schema block below, but buried three kilobytes deep: B2
 * failed twice in a row on `rationale: maxLength 200` with the schema right there in
 * the prompt. Constraints that are easy to violate deserve their own list.
 */
export function limitDigest(name) {
  const out = [];
  walkLimits(schemas[name], "", out, schemas.$defs);
  return out.length
    ? `\n\nHARD LIMITS, these fail validation if exceeded:\n${out.map((l) => `- ${l}`).join("\n")}`
    : "";
}

export function schemaBlock(name) {
  const body = schemas[name];
  if (!body) throw new Error(`no schema named "${name}"`);
  return `

The reply MUST validate against this JSON Schema (draft 2020-12). Every "required" property must be present; every enum value must be one of the listed strings. Definitions referenced as "#/$defs/X" are given after it.

${j(body)}

$defs:
${j(schemas.$defs)}${limitDigest(name)}`;
}

const j = (v) => JSON.stringify(v);

/* ------------------------------------------------------------------- B0 */

/* The room classes are schemas.json $defs/RoomClass, not a second copy of the list. */
const ROOM_CLASSES = schemas.$defs.RoomClass.enum;

export const B0_SYSTEM = `You classify real estate listing photos. Return JSON only.
room_class: one of ${j(ROOM_CLASSES)}.
Score sharpness, exposure and composition 0 to 1 each.
List visible features as short nouns (island, bay window, fireplace, modular kitchen, wardrobe, false ceiling, balcony, solar panels). At most 8.
flags: people_present, vehicles_present, pets_present, brand_logos_present, staging_suspected (furniture looks rendered: identical pieces, no wear, no shadows), text_overlay_present, watermark_present.
safe_crop_9x16: the x_center, y_center and width fraction (0 to 1) of the 9:16 window that keeps the most important feature, and safe_crop_16x9 the same for landscape.
hook_candidate: true only for exterior_front or aerial_34 with the whole building visible and no people.
dedupe_key: a 4 to 6 word lowercase description of the SPACE, not the photo. Two photos of the same room from different angles must get the SAME key. Two different rooms of the same class must get DIFFERENT keys (use a distinguishing feature: "front bedroom bay window", "rear bedroom two closets").`;

export function b0Prompt(batch, retryHint) {
  const list = batch
    .map((p, i) => `image ${i + 1} -> photo_id "${p.id}" (filename ${p.filename})`)
    .join("\n");
  return withRetry(
    `${B0_SYSTEM}

You are given ${batch.length} images, in this order:
${list}

Return {"photos": [...]} with one entry per image IN THE SAME ORDER, each entry:
{ "photo_id": string (echo the id above),
  "room_class": string, "confidence": 0..1,
  "scores": { "sharpness": 0..1, "exposure": 0..1, "composition": 0..1 },
  "features": [string],
  "flags": { "people_present": bool, "vehicles_present": bool, "pets_present": bool,
             "brand_logos_present": bool, "staging_suspected": bool,
             "text_overlay_present": bool, "watermark_present": bool },
  "safe_crop_9x16": { "x_center": 0..1, "y_center": 0..1, "width_frac": 0..1, "keeps_feature": string },
  "safe_crop_16x9": { "x_center": 0..1, "y_center": 0..1, "width_frac": 0..1 },
  "hook_candidate": bool,
  "dedupe_key": string }${JSON_ONLY}`,
    retryHint,
  );
}

/* ------------------------------------------------------------------- B1 */

export function b1Prompt({ facts, assets, market, reraPortal }, retryHint) {
  return withRetry(
    `You build the listing truth record for a property reel. Return JSON only.
Rules:
- facts: copy the form fields exactly. Normalise currency and area units. For market=in the area_basis must be carpet; if the form says super_builtup or saleable, keep the number but set area_basis accordingly and set flags.area_basis_not_carpet=true.
- observed: facts you can see in the photos (from the B0 features below) that are not on the form. Mark each with the photo id. Never infer size, age, condition or renovation from photos.
- specials: 3 to 5 things that make this listing distinct, each tied to a fact or an observed item by id. No adjectives that describe the buyer.
- never_claim: list every claim that would fail compliance for this market and listing: schools with quality words, safety, family or demographic words, religious proximity, amenities not in the sanctioned plan (in), area on any basis except carpet (in), luxury without stated criteria (in), price drop or sold in N days unless the form supplies the prior price or sale date, any twilight, fireworks, people, vehicles or furniture changes in generated media.
- provable_numbers: numbers the copy may use, each with its source field.
- defects: every condition problem visible in the photos or stated on the form (damage, water stains, cracks, mould, broken fixtures, peeling, needed repairs), each with its photo id and an id like "def1". Record them so nobody markets them. A defect NEVER appears in observed, specials or provable_numbers.
- compliance_context: market, rera_project, rera_agent, rera_portal_url, brokerage, mls_number, is_new_launch, is_under_construction, is_brokered, disclosure_required_us (true when market=us), disclosure_required_in (true when any hook is generative).

Give every observed item an id like "obs1", every special "sp1", every provable number "pn1". These ids are what the copy node must cite, so they must be stable and unique.

market: ${market}
rera_portal_url for this region: ${reraPortal || "null"}
form facts:
${j(facts)}

photo pool (id, room_class, features, flags):
${j(assets.map((a) => ({ id: a.photo_id, room_class: a.room_class, features: a.features, flags: a.flags })))}${schemaBlock("ListingTruth")}${JSON_ONLY}`,
    retryHint,
  );
}

/* ------------------------------------------------------------------- B2 */

export function b2Prompt({ truth, market, city }, retryHint) {
  const bands = rules.price_bands[market] || {};
  const band = bands[String(city || "").toLowerCase()] || bands.default;
  return withRetry(
    `Classify the listing. Return JSON only.
price_tier by market using these price bands for ${market}/${city || "default"}: ${j(band)}
buyer_intent: one of first_home, upgrade, investor, nri_remote, relocation, downsizer_by_size (size only, never age), rental_yield. Choose by price tier, property type and status. Never use age, family status, religion, nationality or ability.
tone: one of factual_fast, warm_local, premium_calm, investor_numbers.
type_voice: sans_pill or serif_smallcaps (serif for premium and luxury, sans otherwise).
music_energy: low, mid, high.
caption_density: sparse (hook and CTA only), normal (plus two facts), dense (one fact per room).
rationale: ONE short sentence naming the price tier and the buyer intent. 25 words maximum. Do not restate every field.
language: en, or hinglish_overlay when market=in and city is one of ${j(rules.hinglish_cities)} and price_tier in [budget, mid].
Set price_band_ref to the band name you used.

listing truth facts: ${j(truth.facts)}
specials: ${j(truth.specials)}${schemaBlock("TierPersona")}${JSON_ONLY}`,
    retryHint,
  );
}

/* ------------------------------------------------------------------- B3 */

export function b3Prompt({ truth, persona, assets, market }, retryHint) {
  const available = [...new Set(assets.map((a) => a.room_class))];
  return withRetry(
    `Choose three distinct formats for a three-reel job. Return JSON only.
Reel 1 is always just_listed_reveal unless status is coming_soon, price_improved or sold, in which case use the matching format.
Reel 2 and 3 pick from the remaining formats by score: market_fit x intent_fit x asset_fit, where asset_fit is 0 if the format needs an asset the pool lacks (floor_plan_first needs a floor_plan photo; neighbourhood_named_places needs a named place in facts; before_after needs two photos with the same dedupe_key and different dates).
Never pick a format whose compliance_risk for this market is high unless facts explicitly supply what it needs.
For each: format_id, why (one line, under 140 chars), score, required_assets, title_card_system (price_stack, status_card, address_only, search_intent, number_first), tier (fast, medium, slow).
The three reels MUST use three different format_id values AND three different tier values.

formats: ${j(rules.formats)}
market: ${market}
buyer_intent: ${persona.buyer_intent}
status: ${truth.facts.status}
room classes present in the pool: ${j(available)}
named_places on the form: ${j(truth.facts.named_places || [])}${schemaBlock("FormatPlan")}${JSON_ONLY}`,
    retryHint,
  );
}

/* ------------------------------------------------------------------- B5 */

export function b5Prompt({ truth, persona, assets, formats }, retryHint) {
  return withRetry(
    `Build the shot list from the photo pool and the skeleton. Return JSON only.
- Photos have already been grouped and deduped; only the survivors are given to you.
- Skeleton order: ${j(rules.skeleton_order)}
- The skeleton is the MAXIMUM, not a quota. OMIT any slot the pool cannot fill with a photo of the right class: with no aerial_34, aerial_topdown or aerial_wide in the pool, those slots do not appear in the shot list at all. Do not substitute a front exterior for an aerial.
- The "proof" slot is the strongest INTERIOR shot (kitchen, living, or a view), never the exterior again.
- No photo_id may appear more than TWICE in the whole shot list, and never in two consecutive shots.
- Interior priority when choosing which rooms make the cut: ${j(rules.interior_priority)}
- Drop these first when over budget: ${j(rules.drop_first)}
- Cap interiors at ${rules.max_interiors}. Set interior_count to how many interior shots you emitted.
- Motion per shot from this vocabulary by room_class: ${j(rules.motion_vocabulary)}
- Alternate push and pull so no two consecutive shots share a direction.
- Durations from these tiers, per slot: ${j(rules.tiers)}. Give all three tiers for every shot.
- crop_9x16 from the photo's safe_crop_9x16; if a caption will name a feature, keep that feature in the crop and say so in keeps_feature.
- caption_slot: none, fact, or title. Only exterior_front, proof, floor_plan and cta_card get title; at most two interiors get fact when caption_density is normal, one per room when dense.
- caption_density for this job is: ${persona.caption_density}
- exclusions: list every photo in the pool you did NOT use and why (duplicate, people_present, exterior_rear, low_score, watermark, over_interior_cap).
- The cta_card shot has slot "cta_card", photo_id null, and room_class "other" — "cta_card" is a SLOT, not a room class, and the RoomClass enum has no such value.

specials that a crop must not cut off: ${j(truth.specials)}
formats chosen: ${j(formats.reels)}

surviving photo pool:
${j(assets.map((a) => ({ photo_id: a.photo_id, room_class: a.room_class, scores: a.scores, features: a.features, flags: a.flags, safe_crop_9x16: a.safe_crop_9x16, safe_crop_16x9: a.safe_crop_16x9, dedupe_key: a.dedupe_key })))}${schemaBlock("ShotList")}${JSON_ONLY}`,
    retryHint,
  );
}

/* ------------------------------------------------------------------- B6 */

export function b6Prompt(
  { reelN, truth, persona, format, shots, assetsById = {}, market, hookIsGenerated = false },
  retryHint,
) {
  const cta = rules.cta_forms[market] || [];
  const overlays = rules.required_overlays[market] || {};
  const banned = rules.banned_phrases[market] || [];
  return withRetry(
    `Write on-screen and post copy for reel ${reelN} in the ${persona.type_voice} voice for market ${market}. Return JSON only.
Grammar: every card is a title line (2 to 5 words, max 40 chars) plus at most one subtitle line (facts only, under 9 words, max 70 chars). Lower third. No exclamation marks. No emoji.
- hook_card: by title_card_system "${format.title_card_system}". price_stack: price, then address line, then beds | baths | area with basis label. status_card: status word, address. number_first: "What {price} gets you in {locality}". search_intent: "Homes for sale in {locality}". address_only: address only.
- proof_card: one special from specials with its source.
- fact_captions: one per shot whose caption_slot is "fact", each carrying that shot_id. Facts only, from provable_numbers or observed items. A caption about a room goes ONLY on a shot of that room_class: a kitchen fact on a kitchen shot, a facade or porch fact on an exterior shot. If no listed shot is that room, leave the fact out. Whole-property numbers (price, beds, baths, area, year) do not go on a single room.
- proof_card: the proof shot is a ${j(assetsById[shots.find((s) => s.slot === "proof")?.photo_id]?.room_class ?? shots.find((s) => s.slot === "proof")?.room_class ?? "none")}; the special you choose must be about that room.
- Never mention the property's condition, damage, repairs or defects anywhere, even if you know of them.
- floor_plan_card: area with basis label plus one layout fact.
- cta_card: action line from ${j(cta)}, agent_line, and compliance_lines from ${j(overlays.cta_lines || [])} with the placeholders filled from compliance_context. Leave a line out entirely if its value is missing rather than printing an empty placeholder.${
      hookIsGenerated
        ? ""
        : " Omit the altered-image / originals line: nothing in this reel is digitally created."
    }
- disclosure_overlay: ${
      hookIsGenerated
        ? `text ${j(overlays.hook_label || "")} with placeholders filled, in_s 0, out_s 2.5, corner "${rules.overlay_style.corner_default}".`
        : `the hook for this reel is the UNTOUCHED source photograph — nothing in this reel is AI-generated — so text MUST be the empty string "". A disclosure that claims a real photo was digitally created is itself a misrepresentation. Still emit the object with in_s 0, out_s 0, corner "${rules.overlay_style.corner_default}".`
    }
- post_caption: 3 lines: locality keyword phrase with "for sale", the three strongest provable facts, one CTA verb.
- hashtags: 3 to 5, locality first.
- claims_trace: EVERY number and EVERY named feature that appears in ANY card, caption or the post_caption must have an entry here, with the exact text and the listing_truth id it came from (kind fact|observed|special|provable_number, id). A card containing a number with no claims_trace entry is a rejected reel.

NEVER use any of these phrases or any coded variant of them: ${j(banned)}
Never characterise the buyer. Never rate a school. Never use "luxury" for market=in unless luxury_criteria is set.

listing truth: ${j({ facts: truth.facts, observed: truth.observed, specials: truth.specials, provable_numbers: truth.provable_numbers, never_claim: truth.never_claim, compliance_context: truth.compliance_context })}
persona: ${j(persona)}
format: ${j(format)}
shots needing a caption: ${j(shots.filter((s) => s.caption_slot !== "none").map((s) => ({ shot_id: s.shot_id, slot: s.slot, room_class: assetsById[s.photo_id]?.room_class ?? s.room_class, caption_slot: s.caption_slot })))}${schemaBlock("CopySet")}${JSON_ONLY}`,
    retryHint,
  );
}

/* ------------------------------------------------------------------- B7 */

export function b7Prompt({ reelN, tier, persona, shots, tracks, hookLengthS, budget }, retryHint) {
  const tierSpec = rules.tiers[tier];
  return withRetry(
    `Choose a track and produce the cut map for reel ${reelN}. Return JSON only.
- Pick from the track library below where energy matches music_energy "${persona.music_energy}" and the tier fits: fast wants bpm 115 to 140 with a drop between 1.8 and 2.4s; medium wants 100 to 130 with a drop between 1.8 and 2.6s or a flat intro; slow wants 80 to 110 flat.
- tier for this reel is ${tier}: ${j(tierSpec)}
- hook_length_s = drop_time if the track has a drop, else 2.0. The hook clip is ${hookLengthS}s of usable material.
- Emit one cut per shot, in order, with the shot_id and a transition. Put t at the cumulative shot duration; the exact times and on_beat flags are RECOMPUTED from the chosen track's beat grid after you reply, so do not labour over them. What matters from you is the track and the transitions.
- The shot list below has ALREADY been trimmed to fit. Its durations sum to exactly ${budget.total}s, which is within the ${budget.target}s ceiling. Set total_length_s to ${budget.total} and do not add or remove shots. ${budget.dropped.length ? `Shots already dropped for length: ${j(budget.dropped.map((d) => d.shot_id))} — repeat them in dropped_shot_ids.` : "Nothing needed dropping."}
- Emit the transition per cut from ${j(rules.transitions)}. Never the same transition twice in a row. whip_blur only on the drop. ${tierSpec.stutter_allowed ? "A stutter block is allowed for this tier." : "No stutter block for this tier: set stutter_block to null."}

track library: ${j(tracks)}
shots in order, with this tier's duration:
${j(shots.map((s) => ({ shot_id: s.shot_id, slot: s.slot, duration: s.duration_by_tier[tier] })))}${schemaBlock("PacingPlan")}${JSON_ONLY}`,
    retryHint,
  );
}

/* ------------------------------------------------------------------- B8 */

export function b8PhraseScanPrompt({ strings, market }, retryHint) {
  const us = market === "us";
  return withRetry(
    `You scan real estate advertising copy for compliance risk in market "${market}". Return JSON only.

Flag a string ONLY when it does one of these, and say which:
- "protected_class": names or implies race, religion, national origin, sex, familial status, disability or age${
      us
        ? ', including coded language such as "family-friendly", "perfect for families", "safe neighborhood", "great for kids", "walking distance to church", "exclusive", "mature"'
        : ""
    }
- "occupant_targeting": describes WHO should live there (a person, a household type, a life stage) rather than what the property is
- "school_rating": names a school or district with any quality or desirability word
- "guaranteed_return": promises a return, appreciation, a free gift or a foreign trip
- "unprovable_superlative": a best/finest/unmatched claim that no listing fact can support${
      market === "in"
        ? '\n- "area_basis": states an area figure on any basis other than carpet area, or without the "Carpet area" label'
        : ""
    }

Do NOT flag:
- a factual description of the property\'s layout, configuration or flexibility ("two full kitchens", "versatile living options", "separate entrance") — these describe the BUILDING, not the buyer
- a neighbourhood or locality NAME used as a location
- a number that is stated as a plain fact
- a call to action ("request a showing", "book a site visit")${
      market === "in"
        ? ""
        : "\n- an area figure: carpet-area labelling is an Indian rule and does not apply in this market"
    }

Exact-match banned phrases are already caught by a separate deterministic pass. Your job is the coded and paraphrased cases those miss. Be precise: a false flag stops a compliant job.

Return {"phrase_scan": [{"text": the offending string, "category": one of the categories above, "reason": short reason, "reel_n": number}]}.
An empty array means clean, and clean is the common case.

strings to scan:
${j(strings)}${JSON_ONLY}`,
    retryHint,
  );
}

/* ------------------------------------------------------------------- B4 */

export function b4Prompt(
  { reelN, truth, persona, assets, alreadyPicked, paidAllowed, market, costModel },
  retryHint,
) {
  const pool = assets.map((a) => ({
    photo_id: a.photo_id,
    room_class: a.room_class,
    hook_candidate: a.hook_candidate,
    people: a.flags?.people_present ?? false,
    features: a.features,
    safe_crop_9x16: a.safe_crop_9x16,
  }));

  return withRetry(
    `Select one hook concept for reel ${reelN} from the hook bank, excluding ${j(alreadyPicked)}. Return JSON only.

Score each remaining concept: scroll_stop x engine_survival x compliance_fit x asset_fit x novelty.
- asset_fit is 0 when the concept needs an asset the pool lacks. Each concept's "needs" is a list of requirements where "a|b" means either satisfies it; check it against the room classes actually present in the photo pool.
- novelty is 1 (already-picked concepts are excluded outright).
- Skip any concept whose restrictions include "never_default".
- paid_allowed is ${paidAllowed}. ${
      paidAllowed
        ? `A concept whose default_path is not free_2p5d may be chosen. The paid concept is ${j(rules.hook_bank.find((h) => h.default_paid)?.id ?? null)} (default_paid) unless its needs or restrictions exclude this property.`
        : "Another reel already has the job's one paid hook: choose ONLY concepts whose default_path is free_2p5d."
    }

Pick the top score and fill:
- concept_id, scores {scroll_stop, engine_survival, compliance_fit, asset_fit, novelty, total}
- why: one sentence on why this concept scored highest for THIS listing and pool
- ranked_alternatives: the next three [{concept_id,total}]
- source_photo_id: a photo with hook_candidate true. If none has it, the best exterior_front for an exterior concept, or the best living/kitchen for a room concept. Never a photo with people.
- clip_prompt: one sentence describing the motion (the code replaces it with the verified prompt for paid paths)
- fallback_concept: the next best concept id whose default_path is free_2p5d, so a QA failure costs nothing more.
The code fills generation_path, engine, prompts, duration, window, truth lock, cost and disclosure from rules.json and cost-model.json; send any value for them.

hook bank: ${j(rules.hook_bank)}
market: ${market}
property_type: ${truth.facts.property_type}
photo pool: ${j(pool)}${schemaBlock("HookPlan")}${JSON_ONLY}`,
    retryHint,
  );
}
