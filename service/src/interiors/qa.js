/**
 * Interior Q2: is this still the room in the photograph, with only the camera moving?
 *
 * Different from hook Q2 in one respect that matters: the camera is SUPPOSED to move.
 * A push-in legitimately crops the room's edges, so raw counts shrink and are not
 * compared. What is compared, element by element, is whether anything that is visible
 * in a frame is the same element, the same shape and in the same place in the room as
 * in the photograph. One changed wall, door, window or fixture rejects the clip.
 */
import { config } from "../config.js";
import { callVision } from "../lib/vertex.js";

const j = (v) => JSON.stringify(v);

export const INTERIOR_REJECT_CODES = [
  "architecture_changed",
  "door_opens_or_wall_passthrough",
  "window_count_mismatch",
  "door_count_mismatch",
  "fixture_changed",
  "furniture_changed_moved_added_removed",
  "lights_switched",
  "people_added_or_removed",
  "text_or_logo_added",
  "time_of_day_changed",
  "fire_or_fireplace_added",
  "water_or_pool_added",
  "not_the_same_room",
];

export async function qaInterior({ jobId, stage, roomClass, referenceB64, frames, model = config.textModel }) {
  const prompt = `You are checking a generated interior video against the real photograph it started from.

Image 1 is the REFERENCE photograph of a ${roomClass}. Images 2, 3 and 4 are frames at 33%, 66% and 100% of a clip in which ONLY the camera should move: a slow push forward through the room.

Camera movement is expected and is NEVER a fail: the frame getting closer, the edges of the room leaving the frame, and normal perspective shift are correct.

For every wall, door, window, fixture (lights, cabinets, counters, appliances, radiators, sinks, toilets, built-ins) and piece of furniture that is visible in images 2, 3 or 4, find it in image 1 and check it is the SAME element, the SAME shape, the SAME size relative to the room and in the SAME place. Report every difference in changes, frame by frame. Anything that appears in a frame but does not exist in image 1 is a change. A door that opens or closes, a wall that moves or bends, a window that changes panes, a light that switches, furniture that moves: all changes.

Rejects are CODES only, from: ${j(INTERIOR_REJECT_CODES)}.

Return:
{"target":"interior_clip","pass":bool,
 "same_room":bool,
 "changes":[{"frame":2|3|4,"element":string,"change":"added|removed|moved|reshaped|opened|closed|switched","where":string}],
 "rejects_found":[code],
 "diff_notes":"one sentence"}
pass is true only when same_room is true and changes and rejects_found are both empty.
Return only JSON.`;

  const { json } = await callVision({
    jobId,
    stage,
    model,
    prompt,
    images: [{ mimeType: "image/png", data: referenceB64 }, ...frames.map((f) => ({ mimeType: "image/png", data: f }))],
    temperature: 0,
  });

  const rejects = [];
  const dismissed = [];
  for (const r of Array.isArray(json?.rejects_found) ? json.rejects_found.map(String) : []) {
    const code = r.trim().split(/[\s:(]/)[0];
    if (INTERIOR_REJECT_CODES.includes(code)) rejects.push(r);
    else dismissed.push(`${r} (not a reject code)`);
  }
  const changes = Array.isArray(json?.changes) ? json.changes : [];
  for (const c of changes) rejects.push(`architecture_changed: frame ${c.frame} ${c.element} ${c.change}${c.where ? ` (${c.where})` : ""}`);
  if (json?.same_room === false) rejects.push("not_the_same_room");
  if (json == null) rejects.push("qa_reply_unparseable");
  if (json && json.pass === false && rejects.length === 0 && dismissed.length === 0) {
    rejects.push(`model_failed_without_reason: ${json.diff_notes || "no notes"}`);
  }
  const unique = [...new Set(rejects)];
  return {
    target: "interior_clip",
    pass: unique.length === 0,
    model_said_pass: Boolean(json?.pass),
    same_room: json?.same_room ?? null,
    changes,
    rejects_found: unique,
    dismissed_rejects: dismissed,
    diff_notes: String(json?.diff_notes ?? "").slice(0, 400),
  };
}

