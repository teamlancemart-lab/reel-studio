/**
 * Q1 and Q2, per rules.json qa_rules.
 *
 * Three rules that took four attempts to learn, and all three are enforced here rather
 * than in a prompt somebody can soften later:
 *
 *   score_property_on: final_frame_only
 *     The concealment state is SUPPOSED to hide the building. Q1 looks at the END-state
 *     still, where the building is under the object, so Q1 never counts the building's
 *     windows or doors. The building is counted in Q2, on the frame where the reveal
 *     completes.
 *
 *   theatrical_object_is_never_a_reject
 *     The drape, the haze, the helicopter are the concept, not a defect. The model
 *     reports rejects as CODES from rules.json qa_reject_list, which never name the
 *     object, and anything it says about the object goes in object_notes, which can
 *     never fail a hook.
 *
 *   count_tolerance
 *     The same photo counts 8 or 14 front windows on different runs. A count is only
 *     compared with the reference INSIDE one call. Every count here is a {ref, gen} pair
 *     from a single reply.
 *
 * One rule learned in D3, on the first paid run: the still draped the parked SUV and
 * left the house fully visible, and Q1 passed it ("no differences beyond the object",
 * vehicles 1 vs 1 — a covered car is still a car). Veo then animated a drape onto the
 * car. So both checks now ask what the object is ON. That does not treat the object as
 * a defect: a still where the building is visible is simply not the concealment state
 * the concept needs, and every frame after it inherits the wrong subject.
 */
import { rules } from "../config.js";
import { callVision } from "../lib/vertex.js";

const j = (v) => JSON.stringify(v);
const REJECT_CODES = rules.qa_reject_list;

/** Codes this module adds on top of rules.json qa_reject_list. */
export const QA_EXTRA_CODES = {
  concealment_target_wrong: "the theatrical object is not on the main building",
  scene_element_changed: "a scene element was added, removed or changed",
  camera_moved: "framing, lens or camera position differs",
};

/**
 * rules.json hook_bank conceal_mode. "cover": an object hides the building (drape, haze).
 * "remove": the building itself is taken away to its slab (build itself). The questions
 * differ; the rules about the object, the scene and the counts do not.
 */
const MODE = {
  cover: {
    still: "ONE theatrical object added that covers or hides the MAIN BUILDING, and nothing else changed",
    target: "The object MUST be on the MAIN BUILDING (the house the photograph is of). If it covers or sits on something else instead (a parked vehicle, a tree, the street, a neighbouring building) while the main building stays visible, that is concealment_target_wrong.",
    targetQ: "what does the object cover? concealment_target_ok is true only if it covers the main building",
    shape: "if the building is covered, does the covered shape have the same outline, roof line and footprint as the building in image 1? If the building is not covered, answer true and rely on concealment_target_ok",
    clip: "the theatrical object starts on the MAIN BUILDING and lifts away, and the clip ends on the uncovered building",
    midFrames: "partly or wholly covered by the object",
  },
  remove: {
    still: "the MAIN BUILDING removed down to a bare foundation slab on its own footprint, and nothing else changed",
    target: "ONLY the MAIN BUILDING (the house the photograph is of) may be removed. If a neighbouring building, a vehicle, a tree or anything else is removed, damaged or cut into, or if the main building is still standing, that is concealment_target_wrong.",
    targetQ: "what was removed? concealment_target_ok is true only if exactly the main building is gone, down to a slab, and every attached or neighbouring building is still complete",
    shape: "does the slab sit on the same footprint as the building in image 1 (same width, same position against the neighbours)?",
    clip: "it is a construction time-lapse: it starts on the bare lot or slab, the MAIN BUILDING rises, and the clip ends on the complete building",
    midFrames: "partly built (slab, framing, walls without roof)",
  },
};
const modeOf = (concept) => MODE[concept?.conceal_mode] || MODE.cover;

function sharedRules(concept) {
  const objects = (concept?.theatrical_objects || []).join(", ") || "the added object";
  return `Rules you must follow exactly:
- The theatrical object (${objects}, its cables, its shadow) is the CONCEPT. It is never a defect in itself. Put anything you notice about the object's own look in object_notes; object_notes never fail the check.
- ${modeOf(concept).target}
- Counting: ${rules.qa_rules.count_tolerance} Make every count in THIS reply only.
- Scene elements that must not be added or removed: ${j([...rules.qa_rules.scene_elements, "shrubs", "signs", "street furniture"])}.
- Look region by region (left, centre, right; sky, building, ground level) and report every element that appears, disappears, moves or changes shape between the reference and the generated image(s) in scene_changes, except the theatrical object itself.
- rejects_found holds CODES only, chosen from: ${j([...REJECT_CODES, ...Object.keys(QA_EXTRA_CODES)])}.`;
}

const SCENE_COUNTS = `"vehicles":{"ref":int,"gen":int},"neighbouring_buildings":{"ref":int,"gen":int}`;
const SHARED_FIELDS = `"concealment_target":"what the object covers, in a few words",
 "concealment_target_ok":bool,
 "scene_changes":[{"element":string,"change":"added|removed|moved|changed","where":string}],
 "object_notes":string,`;

/**
 * Q1: the generated END-state still against the source photograph, both in one call.
 */
export async function q1({ jobId, reelN, stage, referenceB64, stillB64, concept, model }) {
  const prompt = `You are checking a generated still against the reference photograph it was built from.

Image 1 is the REFERENCE photograph. Image 2 is the GENERATED still. Image 2 is meant to show the reference scene with ${modeOf(concept).still}.
${sharedRules(concept)}

The main building is hidden or gone in image 2 by design. Do NOT count its windows, doors, floors or balconies, and never fail because they are not visible.

Check, comparing image 1 and image 2 in this reply:
1. concealment_target: ${modeOf(concept).targetQ}.
2. Count parked vehicles and neighbouring buildings visible in each image.
3. roof_line_match: ${modeOf(concept).shape}
4. camera_same: same camera position, framing and lens?
5. Time of day, weather and light direction the same?
6. scene_changes, region by region.

Return:
{"target":"still","pass":bool,
 ${SHARED_FIELDS}
 "counts":{${SCENE_COUNTS}},
 "roof_line_match":bool,
 "camera_same":bool,
 "rejects_found":[code],
 "last_frame_matches_source":null,
 "diff_notes":"one sentence naming the most important difference, or 'no differences beyond the object'"}
pass is true only when concealment_target_ok is true, the counts agree, roof_line_match and camera_same are true, scene_changes is empty and rejects_found is empty.
Return only JSON.`;

  const { json } = await callVision({
    jobId,
    reelN,
    stage,
    model,
    prompt,
    images: [
      { mimeType: "image/png", data: referenceB64 },
      { mimeType: "image/png", data: stillB64 },
    ],
    temperature: 0,
  });
  return normalise(json, "still");
}

/**
 * Q2: frames at 33 / 66 / 100 percent of the REVERSED clip against the source.
 *
 * Run on the whole reversed clip, not on one cut window, so the verdict holds for every
 * window a free retune can choose later. The building is scored on the 100% frame only;
 * the earlier frames are checked for the concealment target, scene changes and camera.
 */
export async function q2({ jobId, reelN, stage, referenceB64, frames, concept, model }) {
  const prompt = `You are checking a generated video against the reference photograph it was built from.

Image 1 is the REFERENCE photograph.
Images 2, 3 and 4 are frames at 33%, 66% and 100% of the clip. The clip is a REVEAL: ${modeOf(concept).clip}, so image 4 is the frame that must match the reference.
${sharedRules(concept)}
- Score the BUILDING on image 4 only (${rules.qa_rules.score_property_on}). Images 2 and 3 are expected to be ${modeOf(concept).midFrames}; that is correct and never a fail.
- concealment_target: in images 2 and 3, which building is the concept happening to? It must be the main building only.
- Score the SCENE on all frames (${rules.qa_rules.score_scene_on}).
- The camera is locked off. Any pan, zoom or parallax between frames is camera_moved.

In this reply, count in image 1 and in image 4: floors of the main building, windows on its front face, its doors, its balconies, parked vehicles, neighbouring buildings.

Fail conditions: ${j(rules.qa_rules.fail_conditions)}

Return:
{"target":"clip","pass":bool,
 ${SHARED_FIELDS}
 "counts":{"floors":{"ref":int,"gen":int},"windows_front":{"ref":int,"gen":int},"doors":{"ref":int,"gen":int},"balconies":{"ref":int,"gen":int},${SCENE_COUNTS}},
 "roof_line_match":bool,
 "camera_same":bool,
 "rejects_found":[code],
 "last_frame_matches_source":bool,
 "diff_notes":"one sentence"}
Return only JSON.`;

  const { json } = await callVision({
    jobId,
    reelN,
    stage,
    model,
    prompt,
    images: [
      { mimeType: "image/png", data: referenceB64 },
      ...frames.map((f) => ({ mimeType: "image/png", data: f })),
    ],
    temperature: 0,
  });
  return normalise(json, "clip");
}

/** Q1 cannot see the covered building's openings, so these codes are Q2's to raise. */
const COVERED_BUILDING_CODES = new Set([
  "window_count_mismatch",
  "door_count_mismatch",
  "floor_count_mismatch",
  "balcony_count_mismatch",
]);
const KNOWN_CODES = new Set([...REJECT_CODES, ...Object.keys(QA_EXTRA_CODES)]);

/**
 * Coerce a QA reply into a QAResult and re-derive `pass` from the evidence rather than
 * trusting the model's own boolean. A reply that reports vehicles ref 2 / gen 1 and
 * then says pass:true has contradicted itself, and the count is the harder evidence.
 *
 * Every reason is kept in rejects_found by name, and every reason that was set aside is
 * kept in dismissed_rejects with why. Nothing is silent in either direction.
 */
export function normalise(json, target) {
  const dismissed = [];
  const rejects = [];
  for (const raw of Array.isArray(json?.rejects_found) ? json.rejects_found.map(String) : []) {
    const code = raw.trim().split(/[\s:(]/)[0];
    if (target === "still" && COVERED_BUILDING_CODES.has(code)) {
      dismissed.push(`${raw} (building is covered in the still; counted in Q2)`);
    } else if (!KNOWN_CODES.has(code)) {
      dismissed.push(`${raw} (not a reject code; free text goes in diff_notes or object_notes)`);
    } else {
      rejects.push(raw);
    }
  }

  const out = {
    target,
    pass: Boolean(json?.pass),
    concealment_target: json?.concealment_target ?? null,
    concealment_target_ok: json?.concealment_target_ok ?? null,
    counts: json?.counts ?? {},
    roof_line_match: json?.roof_line_match ?? null,
    camera_same: json?.camera_same ?? null,
    scene_changes: Array.isArray(json?.scene_changes) ? json.scene_changes : [],
    object_notes: String(json?.object_notes ?? "").slice(0, 300),
    rejects_found: rejects,
    last_frame_matches_source: target === "clip" ? (json?.last_frame_matches_source ?? null) : null,
    diff_notes: String(json?.diff_notes ?? "").slice(0, 400),
    model_said_pass: Boolean(json?.pass),
    dismissed_rejects: dismissed,
  };

  if (out.concealment_target_ok === false) {
    out.rejects_found.push(`concealment_target_wrong: object is on "${out.concealment_target}"`);
  }
  for (const c of out.scene_changes) {
    out.rejects_found.push(`scene_element_changed: ${c.element} ${c.change}${c.where ? ` (${c.where})` : ""}`);
  }
  for (const [name, pair] of Object.entries(out.counts)) {
    if (typeof pair?.ref !== "number" || typeof pair?.gen !== "number") continue;
    if (pair.ref !== pair.gen) {
      out.rejects_found.push(`count_mismatch: ${name} ref ${pair.ref} vs gen ${pair.gen}`);
    }
  }
  if (out.roof_line_match === false) out.rejects_found.push("roof_line_mismatch");
  if (out.camera_same === false) out.rejects_found.push("camera_moved");
  if (target === "clip" && out.last_frame_matches_source === false) {
    out.rejects_found.push("last_frame_not_source");
  }
  if (json == null) out.rejects_found.push("qa_reply_unparseable");

  // A bare code the model sent is redundant once the same code carries its evidence.
  out.rejects_found = [...new Set(out.rejects_found)].filter(
    (r, _, all) => r.includes(":") || !all.some((o) => o !== r && o.startsWith(`${r}:`)),
  );
  if (!out.model_said_pass && out.rejects_found.length === 0 && dismissed.length === 0) {
    out.rejects_found.push(`model_failed_without_reason: ${out.diff_notes || "no notes"}`);
  }
  out.pass = out.rejects_found.length === 0;
  return out;
}

/** The Q1 diff, phrased so it can be appended to the still prompt on a reroll. */
export function rerollHint(result, concept) {
  const bits = [];
  if (result.concealment_target_ok === false) {
    bits.push(
      concept?.conceal_mode === "remove"
        ? `A previous attempt got the removal wrong (${result.concealment_target || "wrong subject"}). Remove ONLY the house at the centre, down to its concrete slab. Every neighbouring building stays complete, and vehicles, trees and the street are unchanged.`
        : `A previous attempt put the cover on ${result.concealment_target || "the wrong thing"} instead of the house. The cover goes ONLY on the house building itself, over its roof and front wall. Parked vehicles, trees and the street stay completely uncovered and unchanged.`,
    );
  }
  const others = result.rejects_found.filter((r) => !r.startsWith("concealment_target_wrong"));
  if (others.length) bits.push(`It was also rejected for: ${others.join("; ")}.`);
  if (result.diff_notes) bits.push(`Reviewer note: ${result.diff_notes}`);
  bits.push(
    "Change ONLY what the concept changes. Every neighbouring building, every vehicle, every shrub and tree, the road, the sky, the light direction and the camera framing must match the reference photograph exactly. Do not add plants or objects.",
  );
  return bits.join(" ");
}
