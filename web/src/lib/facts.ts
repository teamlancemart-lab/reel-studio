/**
 * The dashboard's facts form -> the shape the service's B1 reads.
 *
 * The form is camelCase and display-oriented; B1 and the compliance templates read
 * snake_case form facts (the same keys tmp/facts-lexington.json used in D2). Sending the
 * form object as-is meant originals_url never arrived, and every generated hook or glide
 * would BLOCK on the disclosure rules.
 */
import type { Facts } from "./stub-recipe";
import { EMPTY_FACTS } from "./stub-recipe";

const num = (s: string) => {
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return s.trim() && Number.isFinite(n) ? n : undefined;
};

const STATUS: Record<string, string> = {
  "just listed": "just_listed",
  "coming soon": "coming_soon",
  "open house": "open_house",
  "price improved": "price_improved",
  sold: "sold",
  "under contract": "under_contract",
  "new launch": "new_launch",
};

export function toServiceFacts(f: Facts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    market: f.market,
    address_line: f.addressLine,
    locality: f.locality,
    city: f.city,
    region: f.region,
    country: f.market === "in" ? "India" : "USA",
    price: num(f.priceDisplay),
    currency: f.market === "in" ? "INR" : "USD",
    price_display: f.priceDisplay,
    beds: num(f.beds),
    baths: num(f.baths),
    area_value: num(f.areaValue),
    area_unit: f.areaUnit,
    area_basis: f.areaBasis,
    property_type: f.propertyType,
    status: STATUS[f.statusLabel.trim().toLowerCase()] ?? f.statusLabel.trim().toLowerCase().replace(/\s+/g, "_"),
    year_built: num(f.yearBuilt),
    agent_name: f.agentName,
    agent_handle: f.agentHandle,
    agent_phone_or_wa: f.phone,
    brokerage: f.brokerage,
    mls_number: f.mlsNumber,
    originals_url: f.originalsUrl,
    features_text: f.featuresText || f.captions,
  };
  // Empty strings are "not provided", not a value B1 should copy.
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== "" && v !== undefined));
}

/** Pasted JSON in either shape -> the form. */
export function fromServiceFacts(raw: Record<string, unknown>): Facts {
  const s = (k: string) => (raw[k] == null ? "" : String(raw[k]));
  if ("addressLine" in raw) return { ...EMPTY_FACTS, ...(raw as Partial<Facts>) };
  const status = s("status");
  return {
    ...EMPTY_FACTS,
    market: s("market") === "in" ? "in" : "us",
    addressLine: s("address_line"),
    locality: s("locality"),
    city: s("city"),
    region: s("region"),
    priceDisplay: s("price_display") || s("price"),
    beds: s("beds"),
    baths: s("baths"),
    areaValue: s("area_value"),
    areaUnit: s("area_unit") || "sqft",
    areaBasis: s("area_basis") || "carpet",
    propertyType: s("property_type") || "single_family",
    statusLabel: status ? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Just Listed",
    agentName: s("agent_name"),
    agentHandle: s("agent_handle"),
    phone: s("agent_phone_or_wa"),
    brokerage: s("brokerage"),
    mlsNumber: s("mls_number"),
    yearBuilt: s("year_built"),
    featuresText: s("features_text"),
    originalsUrl: s("originals_url"),
  };
}
