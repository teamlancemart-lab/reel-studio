/**
 * Builds the D1 stub ReelRecipe from what is currently in the browser.
 *
 * This is the ONLY place the web app constructs a recipe. In D2 it is replaced by the
 * real one arriving from /service (buildRecipe over B3/B5/B6/B7) and the canvas does
 * not change, because the canvas only ever knew about ReelRecipe.
 */
import {
  buildStubRecipe,
  validateRecipe,
  type ReelRecipe,
  type Aspect,
  type Tier,
  type TypeVoice,
} from "@/shared/recipe";
import type { StudioPhoto } from "./photos";
import { MAX_INTERIORS } from "./rules";

export interface Facts {
  addressLine: string;
  locality: string;
  city: string;
  market: "us" | "in";
  priceDisplay: string;
  beds: string;
  baths: string;
  areaValue: string;
  areaUnit: string;
  areaBasis: string;
  propertyType: string;
  statusLabel: string;
  agentName: string;
  phone: string;
  brokerage: string;
  captions: string;
  /** Service-only facts: the brain and the compliance lines need them. */
  region: string;
  agentHandle: string;
  mlsNumber: string;
  yearBuilt: string;
  featuresText: string;
  /** Required before any generated media ships (US_ALTERED_NO_DISCLOSURE, INTERIOR_ALTERED). */
  originalsUrl: string;
}

export const EMPTY_FACTS: Facts = {
  addressLine: "",
  locality: "",
  city: "",
  market: "us",
  priceDisplay: "",
  beds: "",
  baths: "",
  areaValue: "",
  areaUnit: "sqft",
  areaBasis: "carpet",
  propertyType: "single_family",
  statusLabel: "Just Listed",
  agentName: "",
  phone: "",
  brokerage: "",
  captions: "",
  region: "",
  agentHandle: "",
  mlsNumber: "",
  yearBuilt: "",
  featuresText: "",
  originalsUrl: "",
};

function specLine(f: Facts) {
  const parts: string[] = [];
  if (f.beds) parts.push(`${f.beds} bed`);
  if (f.baths) parts.push(`${f.baths} bath`);
  if (f.areaValue) {
    // rules.json IN_AREA_BASIS: an Indian area figure must carry the "Carpet area"
    // label. B8 BLOCKs on it at pre-export; the preview shows it from the start so it
    // is not a surprise at the end.
    const label = f.market === "in" ? "Carpet area " : "";
    parts.push(`${label}${f.areaValue} ${f.areaUnit}`);
  }
  return parts.join(" · ");
}

/**
 * rules.json required_overlays[market].hook_label. In D1 the hook is an untouched
 * photo, so no disclosure is due — the string is built here so D3 has one line to
 * change when the hook becomes generated.
 */
function disclosureFor(f: Facts, hookIsGenerated: boolean) {
  if (!hookIsGenerated) return undefined;
  return f.market === "in"
    ? "AI-generated / artist's impression"
    : "AI-generated reveal. Actual exterior at 2.0s.";
}

export function buildRecipeFromStudio(opts: {
  photos: StudioPhoto[];
  facts: Facts;
  aspect: Aspect;
  tier: Tier;
  typeVoice: TypeVoice;
}): { recipe: ReelRecipe; problems: string[] } {
  const { photos, facts, aspect, tier, typeVoice } = opts;

  const exteriors = photos.filter((p) => p.bucket === "exterior");
  const interiors = photos
    .filter((p) => p.bucket === "interior")
    .slice(0, MAX_INTERIORS); // rules.json max_interiors
  const floorPlan = photos.find((p) => p.bucket === "floor_plan");

  const asStub = (p: StudioPhoto) => ({ id: p.id, url: p.url });

  const captions = facts.captions
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const recipe = buildStubRecipe({
    reelId: "preview-1",
    tier,
    aspect,
    typeVoice,
    exteriors: exteriors.map(asStub),
    interiors: interiors.map(asStub),
    floorPlan: floorPlan ? asStub(floorPlan) : undefined,
    facts: {
      priceDisplay: facts.priceDisplay,
      addressLine: facts.addressLine,
      locality: facts.locality,
      city: facts.city,
      statusLabel: facts.statusLabel,
      specs: specLine(facts),
      agentName: facts.agentName,
      brokerage: facts.brokerage,
      phone: facts.phone,
      captions,
      ctaLine: facts.market === "in" ? "Book a site visit" : "Book a private tour",
      disclosure: disclosureFor(facts, false),
    },
  });

  return { recipe, problems: validateRecipe(recipe) };
}

/** Photo id -> decoded image, for the canvas. */
export function imageBank(photos: StudioPhoto[]) {
  return new Map(photos.map((p) => [p.id, p.img]));
}
