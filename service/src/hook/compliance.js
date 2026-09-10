/**
 * The disclosure a generated hook carries, filled from rules.json required_overlays.
 *
 * These strings are templates in rules.json, not copy. A model does not get to word
 * them, and an unfilled placeholder is treated as missing: "Originals: {originals_url}"
 * on screen is not a disclosure, it is a bug that looks like one.
 */
import { rules } from "../config.js";

const fill = (template, values) =>
  String(template || "").replace(/\{(\w+)\}/g, (m, k) => (values[k] != null && values[k] !== "" ? String(values[k]) : m));

export const hasPlaceholder = (s) => /\{\w+\}/.test(String(s || ""));

/**
 * @param market          "us" | "in"
 * @param truth           B1 ListingTruth
 * @param truthLockS      reel time at which the untouched photo is fully on screen
 * @returns { label, ctaLine, problems[] }
 */
export function hookDisclosure({ market, truth, truthLockS }) {
  const spec = rules.required_overlays[market] || {};
  const values = {
    truth_lock_s: truthLockS != null ? Number(truthLockS).toFixed(1) : null,
    originals_url: truth?.compliance_context?.originals_url || truth?.facts?.originals_url,
    brokerage: truth?.facts?.brokerage,
  };

  const label = fill(spec.hook_label, values);
  const ctaTemplate = (spec.cta_lines || []).find((l) => /digitally created|originals/i.test(l));
  const ctaLine = ctaTemplate ? fill(ctaTemplate, values) : null;

  const problems = [];
  if (!label) problems.push(`rules.json required_overlays.${market}.hook_label is empty`);
  else if (hasPlaceholder(label)) problems.push(`hook label has an unfilled placeholder: "${label}"`);
  if (market === "us") {
    if (!ctaLine) problems.push("no altered-image line in required_overlays.us.cta_lines");
    else if (hasPlaceholder(ctaLine)) problems.push(`CTA altered-image line has an unfilled placeholder: "${ctaLine}"`);
  }
  return { label, ctaLine, problems };
}

/**
 * The disclosure an approved interior glide carries, and the CTA line once any scene in
 * the reel is generated. With glides the "opening scene" line alone would be false, so
 * rules.json motion_cta_line replaces it.
 */
export function motionDisclosure({ market, truth, hookGenerated = false }) {
  const spec = rules.required_overlays[market] || {};
  const values = { originals_url: truth?.compliance_context?.originals_url || truth?.facts?.originals_url };
  const label = spec.motion_label || spec.hook_label || "";
  /* Claiming a real opening shot was digitally created is a misrepresentation too: the
     first glide export said "Opening scene and camera moves digitally created" over a
     free sky_drop hook. The opening is only named when the hook really was generated. */
  const template = hookGenerated ? spec.motion_cta_line : spec.motion_only_cta_line ?? spec.motion_cta_line;
  const ctaLine = template ? fill(template, values) : null;
  const problems = [];
  if (!label) problems.push(`rules.json required_overlays.${market}.motion_label is empty`);
  if (market === "us" && (!ctaLine || hasPlaceholder(ctaLine))) {
    problems.push(`motion CTA line missing or has an unfilled placeholder: "${ctaLine}"`);
  }
  return { label, ctaLine, problems };
}
