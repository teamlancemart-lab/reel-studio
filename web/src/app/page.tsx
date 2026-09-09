"use client";

/**
 * Listing Reel Studio, D1.
 *
 * Upload -> facts -> canvas preview, all in the browser. The recipe is a stub until D2
 * replaces it with the brain's output; nothing else on this page changes when it does,
 * because the canvas only ever knew about ReelRecipe.
 */
import { useMemo, useState } from "react";
import { Inter, Playfair_Display } from "next/font/google";
import CanvasPreview from "@/components/CanvasPreview";
import FactsForm from "@/components/FactsForm";
import ServicePanel from "@/components/ServicePanel";
import UploadPanel from "@/components/UploadPanel";
import type { Bucket, StudioPhoto } from "@/lib/photos";
import { EMPTY_FACTS, buildRecipeFromStudio, imageBank, type Facts } from "@/lib/stub-recipe";
import { COST_MODEL_VERSION, RULES_VERSION } from "@/lib/rules";
import type { Aspect, Tier, TypeVoice } from "@/shared/recipe";

/* rules.json type_systems names these two faces. The canvas draws with them, so they
   are loaded here rather than only declared in CSS. */
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "700"] });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["500", "700"] });

export default function StudioPage() {
  const [photos, setPhotos] = useState<StudioPhoto[]>([]);
  const [facts, setFacts] = useState<Facts>(EMPTY_FACTS);
  const [aspect, setAspect] = useState<Aspect>("9x16");
  const [tier, setTier] = useState<Tier>("medium");
  const [typeVoice, setTypeVoice] = useState<TypeVoice>("serif_smallcaps");

  const { recipe, problems } = useMemo(
    () => buildRecipeFromStudio({ photos, facts, aspect, tier, typeVoice }),
    [photos, facts, aspect, tier, typeVoice],
  );
  const images = useMemo(() => imageBank(photos), [photos]);
  const fonts = useMemo(
    () => ({ sans: inter.style.fontFamily, serif: playfair.style.fontFamily }),
    [],
  );

  const move = (id: string, bucket: Bucket) =>
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, bucket } : p)));
  const remove = (id: string) =>
    setPhotos((prev) => prev.filter((p) => p.id !== id));

  return (
    <div className={`${inter.className} min-h-full bg-neutral-950 text-neutral-100`}>
      <header className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-400 font-extrabold text-neutral-900">
            R
          </span>
          <div>
            <h1 className="text-sm font-semibold">Listing Reel Studio</h1>
            <p className="text-[11px] text-neutral-500">
              D1 skeleton · rules v{RULES_VERSION} · cost-model v{COST_MODEL_VERSION}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as Tier)}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
              title="rules.json tiers"
            >
              <option value="fast">fast</option>
              <option value="medium">medium</option>
              <option value="slow">slow</option>
            </select>
            <select
              value={typeVoice}
              onChange={(e) => setTypeVoice(e.target.value as TypeVoice)}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
              title="rules.json type_systems"
            >
              <option value="serif_smallcaps">serif_smallcaps</option>
              <option value="sans_pill">sans_pill</option>
            </select>
            <span className="rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-500">
              {photos.length} photos
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] gap-4 px-4 py-5 lg:grid-cols-[380px_minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <UploadPanel
            photos={photos}
            onAdd={(added) => setPhotos((prev) => [...prev, ...added])}
            onMove={move}
            onRemove={remove}
          />
          <ServicePanel photos={photos} facts={facts} />
        </div>

        <CanvasPreview
          recipe={recipe}
          images={images}
          aspect={aspect}
          onAspectChange={setAspect}
          fonts={fonts}
          problems={problems}
        />

        <FactsForm facts={facts} onChange={setFacts} />
      </main>

      <footer className="mx-auto max-w-[1400px] px-4 pb-10 text-[11px] text-neutral-600">
        <p className={playfair.className}>
          Interiors are never AI-altered. Every generated hook ends on the untouched hero
          photo. Paid video stays gated until Stage 6.
        </p>
      </footer>
    </div>
  );
}
