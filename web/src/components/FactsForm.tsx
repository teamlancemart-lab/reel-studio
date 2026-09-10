"use client";

/**
 * Listing facts. These are the ONLY source a claim may trace to — B1 turns this into
 * ListingTruth and B6 rejects any card carrying a number that is not in here.
 * Typing in this form repaints the canvas immediately.
 */
import { useState } from "react";
import type { Facts } from "@/lib/stub-recipe";
import { fromServiceFacts } from "@/lib/facts";

interface Props {
  facts: Facts;
  onChange: (facts: Facts) => void;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-[13px] outline-none focus:border-amber-400"
      />
      {hint && <span className="mt-0.5 block text-[10px] text-neutral-600">{hint}</span>}
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-[13px] outline-none focus:border-amber-400"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function FactsForm({ facts, onChange }: Props) {
  const set = <K extends keyof Facts>(key: K, value: Facts[K]) =>
    onChange({ ...facts, [key]: value });

  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <h2 className="text-sm font-semibold">Listing facts</h2>
      <p className="mb-3 text-[11px] text-neutral-500">
        Everything on screen must trace back to a fact here. B1 makes this ListingTruth.
      </p>

      <details className="mb-3 rounded-md border border-neutral-800 p-2">
        <summary className="cursor-pointer text-[11px] text-neutral-400">Import facts JSON</summary>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={4}
          aria-label="Facts JSON"
          placeholder='{"address_line": "…", "price_display": "…"}'
          className="mt-2 w-full rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[10px]"
        />
        <button
          type="button"
          onClick={() => {
            try {
              onChange(fromServiceFacts(JSON.parse(importText)));
              setImportError(null);
            } catch (e) {
              setImportError(e instanceof Error ? e.message : "not JSON");
            }
          }}
          className="mt-1 rounded border border-neutral-700 px-2 py-0.5 text-[11px]"
        >
          Apply
        </button>
        {importError && <p className="mt-1 text-[10px] text-rose-300">{importError}</p>}
      </details>

      <div className="space-y-2.5">
        <div className="grid grid-cols-2 gap-2.5">
          <Select
            label="Market"
            value={facts.market}
            options={[
              ["us", "United States"],
              ["in", "India"],
            ]}
            onChange={(v) => set("market", v as Facts["market"])}
          />
          <Field
            label="Status"
            value={facts.statusLabel}
            onChange={(v) => set("statusLabel", v)}
            placeholder="Just Listed"
          />
        </div>

        <Field
          label="Address"
          value={facts.addressLine}
          onChange={(v) => set("addressLine", v)}
          placeholder="253 Brindle Rd"
        />
        <div className="grid grid-cols-2 gap-2.5">
          <Field
            label="Locality"
            value={facts.locality}
            onChange={(v) => set("locality", v)}
            placeholder="Silver Spring Twp"
          />
          <Field
            label="City"
            value={facts.city}
            onChange={(v) => set("city", v)}
            placeholder="Mechanicsburg, PA"
          />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <Field
            label="Price"
            value={facts.priceDisplay}
            onChange={(v) => set("priceDisplay", v)}
            placeholder={facts.market === "in" ? "₹1.85 Cr" : "$789,900"}
          />
          <Select
            label="Property type"
            value={facts.propertyType}
            options={[
              ["single_family", "Single family"],
              ["condo", "Condo"],
              ["townhouse", "Townhouse"],
              ["apartment", "Apartment"],
              ["builder_floor", "Builder floor"],
              ["villa", "Villa"],
              ["independent_house", "Independent house"],
              ["penthouse", "Penthouse"],
              ["plot", "Plot"],
            ]}
            onChange={(v) => set("propertyType", v)}
          />
        </div>

        <div className="grid grid-cols-3 gap-2.5">
          <Field label="Beds" value={facts.beds} onChange={(v) => set("beds", v)} placeholder="4" />
          <Field label="Baths" value={facts.baths} onChange={(v) => set("baths", v)} placeholder="2" />
          <Field
            label="Area"
            value={facts.areaValue}
            onChange={(v) => set("areaValue", v)}
            placeholder="1562"
          />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <Select
            label="Area unit"
            value={facts.areaUnit}
            options={[
              ["sqft", "sqft"],
              ["sqm", "sqm"],
              ["sqyd", "sqyd"],
            ]}
            onChange={(v) => set("areaUnit", v)}
          />
          <Select
            label="Area basis"
            value={facts.areaBasis}
            options={[
              ["carpet", "Carpet"],
              ["builtup", "Built-up"],
              ["super_builtup", "Super built-up"],
              ["saleable", "Saleable"],
              ["lot", "Lot"],
            ]}
            onChange={(v) => set("areaBasis", v)}
          />
        </div>
        {facts.market === "in" && facts.areaBasis !== "carpet" && (
          <p className="rounded-md border border-amber-900/50 bg-amber-950/20 p-2 text-[11px] text-amber-300">
            rules.json IN_AREA_BASIS: only carpet area may be the price basis in Indian
            advertising. B8 BLOCKs this at pre-export in D2.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2.5">
          <Field
            label="Agent"
            value={facts.agentName}
            onChange={(v) => set("agentName", v)}
            placeholder="Agent name"
          />
          <Field
            label="Phone"
            value={facts.phone}
            onChange={(v) => set("phone", v)}
            placeholder="(717) 555-0100"
          />
        </div>
        <Field
          label="Brokerage"
          value={facts.brokerage}
          onChange={(v) => set("brokerage", v)}
          placeholder="Brokerage"
        />
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Region / state" value={facts.region} onChange={(v) => set("region", v)} placeholder="PA" />
          <Field label="Year built" value={facts.yearBuilt} onChange={(v) => set("yearBuilt", v)} placeholder="1920" />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Agent handle" value={facts.agentHandle} onChange={(v) => set("agentHandle", v)} placeholder="@handle" />
          <Field label="MLS number" value={facts.mlsNumber} onChange={(v) => set("mlsNumber", v)} placeholder="PADA2039114" />
        </div>
        <Field
          label="Originals URL"
          value={facts.originalsUrl}
          onChange={(v) => set("originalsUrl", v)}
          placeholder="https://…/originals"
          hint="Required for a paid hook or Veo glides: the disclosure links the unaltered photos."
        />
        <Field
          label="Features"
          value={facts.featuresText}
          onChange={(v) => set("featuresText", v)}
          placeholder="Two full kitchens, finished basement…"
          hint="What the listing says about itself. B1 draws specials from here."
        />
        <Field
          label="Room captions"
          value={facts.captions}
          onChange={(v) => set("captions", v)}
          placeholder="Bright primary suite, Corner living room, Full kitchen"
          hint="Comma separated, one per interior, in order."
        />
      </div>
    </section>
  );
}
