/**
 * Dedupe: phash hamming < 6, then identical dedupe_key.
 *
 * Two passes because they catch different things. The hash catches the same photo
 * twice — a resave, a crop, an exposure tweak. It does NOT catch the same room shot
 * from the doorway and then from the corner, which is most of the redundancy in a real
 * listing set; that is what B0's dedupe_key is for.
 *
 * Losers are never deleted. They keep an excluded_reason naming the winner, so
 * "why isn't the nice kitchen photo in the reel" has an answer in the database.
 */
import { hamming } from "./phash.js";

const HAMMING_THRESHOLD = 6;

/** score used to pick the survivor of a group */
const compositionOf = (a) => a?.scores?.composition ?? 0;

/**
 * @param assets PhotoAsset[] with .phash attached
 * @returns { kept, dropped: [{photo_id, reason, duplicate_of}], groups }
 */
export function dedupe(assets) {
  const dropped = [];
  const droppedIds = new Set();
  const groups = [];

  /* Pass 1: perceptual hash. Near-identical pixels. */
  for (let i = 0; i < assets.length; i++) {
    if (droppedIds.has(assets[i].photo_id)) continue;
    const group = [assets[i]];
    for (let k = i + 1; k < assets.length; k++) {
      if (droppedIds.has(assets[k].photo_id)) continue;
      const d = hamming(assets[i].phash, assets[k].phash);
      if (d < HAMMING_THRESHOLD) {
        group.push(assets[k]);
        assets[k]._hammingTo = { id: assets[i].photo_id, d };
      }
    }
    if (group.length > 1) {
      const winner = [...group].sort((a, b) => compositionOf(b) - compositionOf(a))[0];
      for (const loser of group) {
        if (loser.photo_id === winner.photo_id) continue;
        droppedIds.add(loser.photo_id);
        dropped.push({
          photo_id: loser.photo_id,
          reason: `duplicate_phash: hamming ${loser._hammingTo?.d ?? "<6"} from ${winner.photo_id}, kept the higher composition score (${compositionOf(winner).toFixed(2)} vs ${compositionOf(loser).toFixed(2)})`,
          duplicate_of: winner.photo_id,
          method: "phash",
        });
      }
      groups.push({ method: "phash", winner: winner.photo_id, members: group.map((g) => g.photo_id) });
    }
  }

  /* Pass 2: identical dedupe_key. Same room, different angle. */
  const byKey = new Map();
  for (const a of assets) {
    if (droppedIds.has(a.photo_id)) continue;
    const k = (a.dedupe_key || "").trim().toLowerCase();
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(a);
  }
  for (const [k, group] of byKey) {
    if (group.length < 2) continue;
    const winner = [...group].sort((a, b) => compositionOf(b) - compositionOf(a))[0];
    for (const loser of group) {
      if (loser.photo_id === winner.photo_id) continue;
      droppedIds.add(loser.photo_id);
      dropped.push({
        photo_id: loser.photo_id,
        reason: `duplicate_dedupe_key: "${k}" also on ${winner.photo_id}, kept the higher composition score (${compositionOf(winner).toFixed(2)} vs ${compositionOf(loser).toFixed(2)})`,
        duplicate_of: winner.photo_id,
        method: "dedupe_key",
      });
    }
    groups.push({ method: "dedupe_key", key: k, winner: winner.photo_id, members: group.map((g) => g.photo_id) });
  }

  const kept = assets.filter((a) => !droppedIds.has(a.photo_id));
  return { kept, dropped, groups };
}
