/**
 * The still and clip prompts for reverse_conceal, lifted from docs/hook-v4.mjs.
 *
 * These are not written by B4. v4 took four attempts to get right and the prompt text
 * is part of what was verified, so a model paraphrasing it per job would quietly undo
 * that. B4 picks the concept, the source photo and the crop; the words come from here,
 * and B4 stores them on the plan so the hook card shows exactly what gets sent.
 *
 * Three substitutions from v4, all forced by the pool rather than chosen:
 *   - v4 was run on an aerial. When the hero is a street-level exterior_front, "aerial
 *     photograph" / "Aerial drone shot" / "drone footage" / "altitude" would describe a
 *     camera that does not exist, so they become the street-level equivalents.
 *   - the drape colour is a parameter, as it was in v4 (DRAPE).
 *   - v4 describes the fit as "like a tailored cover on a car". Its aerial had no car in
 *     the foreground. On 2572 Lexington the 9:16 hero has an SUV parked in front of the
 *     house at the centre of the frame, and three stills in a row put the cover on the
 *     SUV — one of them after a reroll hint saying "cover ONLY the house". When B0 flags
 *     vehicles_present on the hero, the simile loses the car.
 *
 * No negative block is appended. v4 did not append one, and rules.json
 * qa_prompt_negative_block says "no vehicles" — on a hero with a parked car that
 * instruction fights "same vehicles" and invites the model to remove it.
 */

export const DEFAULT_DRAPE = "matte charcoal black";

/** Concepts with a verified or derived reverse_conceal prompt. */
export const REVERSE_CONCEAL_TEMPLATES = new Set(["helicopter_drape", "haze_reveal", "block_build"]);

function shot(roomClass) {
  const aerial = String(roomClass || "").startsWith("aerial");
  return aerial
    ? {
        photo: "aerial photograph",
        clipOpen: "Aerial drone shot",
        footage: "drone footage",
        position: "same camera position and altitude",
        ground: "the driveway, the lawns",
      }
    : {
        photo: "street-level photograph",
        clipOpen: "Street-level shot",
        footage: "footage",
        position: "same camera position and height",
        ground: "the street, the pavement, the lawns",
      };
}

/**
 * @returns { still_prompt, clip_prompt, verified, template }
 */
export function reverseConcealPrompts(conceptId, { roomClass, vehiclesPresent = false, drape = DEFAULT_DRAPE } = {}) {
  const s = shot(roomClass);
  const fit = vehiclesPresent ? "like a tailored fitted dust cover" : "like a tailored cover on a car";

  switch (conceptId) {
    case "helicopter_drape":
      // hook-v4.mjs steps 2 and 3, verbatim apart from the shot substitutions above.
      return {
        template: vehiclesPresent ? "hook-v4.helicopter_drape+no_car_simile" : "hook-v4.helicopter_drape",
        verified: true,
        still_prompt: `Using the reference ${s.photo} exactly as it is, add ONE element: a ${drape} fabric cover pulled taut over the single house at the centre of the frame. The fabric follows the exact shape of the roof planes, the ridges and the walls, ${fit}. It is smooth and taut, not bunched or crumpled. It covers that one house completely and stops at the ground line. It does not extend onto the lawn, the driveway, the trees or any neighbouring building.
Everything else is identical to the reference: same neighbouring buildings, same roads and driveway, same trees and shrubs, same vehicles, same sky, same time of day, same light and shadow direction, ${s.position}.
Photographic, matching the exposure and colour of the reference. No people. No text. No logos.`,
        clip_prompt: `${s.clipOpen}, camera completely locked off, no camera movement whatsoever.
A ${drape} fabric cover is lowered by two thin cables from a small helicopter high at the top of the frame. The fabric descends and draws itself smoothly and evenly over the house at the centre of the frame until it is taut over the roof and walls.
The neighbouring buildings, ${s.ground}, the trees, the shrubs, the parked vehicles and the sky remain exactly as they are and never change. Nothing else in the scene moves.
Real photographic ${s.footage}, bright daylight, no cuts.`,
      };

    case "haze_reveal":
      // Same skeleton as v4 with the object swapped. Not independently verified.
      return {
        template: "hook-v4.skeleton.haze",
        verified: false,
        still_prompt: `Using the reference ${s.photo} exactly as it is, add ONE element: a dense pale haze of fine construction dust that hangs over the single house at the centre of the frame and hides it completely. The haze is thickest over that house and thins out at its edges. It does not hide the neighbouring buildings, the trees or the sky.
Everything else is identical to the reference: same neighbouring buildings, same roads and driveway, same trees and shrubs, same vehicles, same sky, same time of day, same light and shadow direction, ${s.position}.
Photographic, matching the exposure and colour of the reference. No people. No text. No logos.`,
        clip_prompt: `${s.clipOpen}, camera completely locked off, no camera movement whatsoever.
A pale haze of fine construction dust drifts in and thickens over the house at the centre of the frame until the house is completely hidden.
The neighbouring buildings, ${s.ground}, the trees, the shrubs, the parked vehicles and the sky remain exactly as they are and never change. Nothing else in the scene moves.
Real photographic ${s.footage}, bright daylight, no cuts.`,
      };

    case "block_build":
      /* Build itself, the default paid hook. docs/reference-reel-anatomy-v1.md 2.2
         (Electricity): bare lot, slab, framing rising floor by floor, walls, roof, then
         the crossfade to the true photo. Veo cannot be trusted to build the RIGHT house
         from an empty lot — that is the still_then_clip failure — so it is generated
         the other way: the real house (first frame) comes down to its slab (last frame),
         and the clip is reversed. The house that assembles is the real one by
         construction, and the reel ends on the untouched photo. */
      return {
        template: "electricity.build_itself.reverse_conceal",
        verified: false,
        still_prompt: `Using the reference ${s.photo} exactly as it is, change ONE thing: the single house at the centre of the frame is gone, and in its place is its empty building lot with a clean, level concrete foundation slab on exactly the same footprint. If the house shares walls with neighbouring houses, those neighbouring houses stay complete and untouched, and their exposed side walls are plain brick.
Everything else is identical to the reference: same neighbouring buildings, same roads and driveway, same trees and shrubs, same vehicles, same sky, same time of day, same light and shadow direction, ${s.position}.
Photographic, matching the exposure and colour of the reference. No people. No text. No logos. No machinery. No construction equipment.`,
        clip_prompt: `${s.clipOpen}, camera completely locked off, no camera movement whatsoever.
Construction time-lapse in reverse: the house at the centre of the frame takes itself apart smoothly and evenly. First the roof lifts away, then the walls come down floor by floor, brick course by brick course, down to the timber framing, then the framing disappears, leaving only the clean concrete foundation slab on the empty lot.
The neighbouring buildings, ${s.ground}, the trees, the shrubs, the parked vehicles and the sky remain exactly as they are and never change. No people, no machinery. Nothing else in the scene moves.
Real photographic ${s.footage}, bright daylight, no cuts.`,
      };

    default:
      return null;
  }
}
