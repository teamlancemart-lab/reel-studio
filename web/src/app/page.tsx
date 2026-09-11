"use client";

/**
 * Listing Reel Studio.
 *
 * The whole job runs from this page: drop photos, fill the facts, set the run controls,
 * Generate, and watch the pipeline produce three reels over SSE. No terminal step.
 * The canvas preview still interprets the same ReelRecipe the exporter renders.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Inter, Playfair_Display } from "next/font/google";
import CanvasPreview from "@/components/CanvasPreview";
import FactsForm from "@/components/FactsForm";
import UploadPanel from "@/components/UploadPanel";
import BrainPanel from "@/components/BrainPanel";
import HookPanel from "@/components/HookPanel";
import RunControls from "@/components/RunControls";
import JobView from "@/components/JobView";
import JobHistory from "@/components/JobHistory";
import AccessKeyField from "@/components/AccessKeyField";
import { submitJob } from "@/lib/service";
import { DEFAULT_OPTIONS, toRequestOptions, type RunOptions } from "@/lib/estimate";
import { MIN_PHOTOS } from "@/lib/photos";
import { absolutiseRecipe, getRecipes } from "@/lib/nodes";
import type { Bucket, StudioPhoto } from "@/lib/photos";
import { EMPTY_FACTS, buildRecipeFromStudio, imageBank, type Facts } from "@/lib/stub-recipe";
import { COST_MODEL_VERSION, RULES_VERSION } from "@/lib/rules";
import type { Aspect, ReelRecipe, Tier, TypeVoice } from "@/shared/recipe";
import { validateRecipe } from "@/shared/recipe";

/* rules.json type_systems names these two faces. The canvas draws with them, so they
   are loaded here rather than only declared in CSS. */
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "700"] });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["500", "700"] });

function Studio() {
  const [photos, setPhotos] = useState<StudioPhoto[]>([]);
  const [facts, setFacts] = useState<Facts>(EMPTY_FACTS);
  const [aspect, setAspect] = useState<Aspect>("9x16");
  const [tier, setTier] = useState<Tier>("medium");
  const [typeVoice, setTypeVoice] = useState<TypeVoice>("serif_smallcaps");

  /* Once the brain has run, the canvas draws the REAL recipe. Until then it draws the
     D1 stub. Nothing else on the page changes, because the canvas only ever knew about
     ReelRecipe. */
  /* ?job=<id> opens an existing job. A job is a durable thing on the service with a
     ledger and a node graph; being able to link to one is worth the hook.
     useSearchParams rather than window.location: reading location during render made
     the server and client trees disagree and React threw a hydration mismatch. */
  const params = useSearchParams();
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(params.get("job"));
  const [options, setOptions] = useState<RunOptions>(DEFAULT_OPTIONS);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [realRecipes, setRealRecipes] = useState<ReelRecipe[]>([]);
  const [reelIndex, setReelIndex] = useState(0);
  const [brainImages, setBrainImages] = useState<Map<string, HTMLImageElement>>(new Map());

  /** Fetch the recipes and decode every photo they reference. */
  const fetchRecipes = useCallback(async (id: string) => {
    const { recipes } = await getRecipes(id);
    const absolute = recipes.map(absolutiseRecipe);
    const bank = new Map<string, HTMLImageElement>();
    await Promise.all(
      absolute.flatMap((r) =>
        r.segments
          .filter((s) => s.source.url && !bank.has(s.source.id))
          .map(
            (s) =>
              new Promise<void>((resolve) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                  bank.set(s.source.id, img);
                  resolve();
                };
                img.onerror = () => resolve();
                img.src = s.source.url!;
              }),
          ),
      ),
    );
    return { recipes: absolute, bank };
  }, []);

  const applyRecipes = useCallback(
    ({ recipes, bank }: { recipes: ReelRecipe[]; bank: Map<string, HTMLImageElement> }) => {
      setRealRecipes(recipes);
      setBrainImages(bank);
    },
    [],
  );

  const loadRecipes = useCallback(
    (id: string) => fetchRecipes(id).then(applyRecipes),
    [fetchRecipes, applyRecipes],
  );

  // Subscribing to an external system: state lands in the promise callback.
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    fetchRecipes(jobId)
      .then((result) => {
        if (live) applyRecipes(result);
      })
      .catch(() => {
        /* the brain panel surfaces the error */
      });
    return () => {
      live = false;
    };
  }, [jobId, fetchRecipes, applyRecipes]);

  const stub = useMemo(
    () => buildRecipeFromStudio({ photos, facts, aspect, tier, typeVoice }),
    [photos, facts, aspect, tier, typeVoice],
  );
  const stubImages = useMemo(() => imageBank(photos), [photos]);

  const usingReal = realRecipes.length > 0;
  const active = usingReal
    ? { ...realRecipes[Math.min(reelIndex, realRecipes.length - 1)], aspect }
    : stub.recipe;
  const recipe = active;
  const images = usingReal ? brainImages : stubImages;
  const problems = usingReal ? validateRecipe(active) : stub.problems;
  const fonts = useMemo(
    () => ({ sans: inter.style.fontFamily, serif: playfair.style.fontFamily }),
    [],
  );

  const openJob = useCallback(
    (id: string) => {
      setJobId(id);
      setRealRecipes([]);
      router.replace(`?job=${encodeURIComponent(id)}`, { scroll: false });
    },
    [router],
  );

  const generatesMedia = options.paidHook || options.interiorMotion === "veo";
  const disabledReason =
    photos.length < MIN_PHOTOS
      ? `Add at least ${MIN_PHOTOS} photos (${photos.length} so far).`
      : !facts.addressLine.trim()
        ? "Fill in the address in Listing facts."
        : generatesMedia && !facts.originalsUrl.trim()
          ? "A paid hook or Veo glides needs an Originals URL: the on-screen disclosure links to it."
          : null;

  const generate = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { jobId: id } = await submitJob(photos, facts, toRequestOptions(options));
      openJob(id);
      setHistoryKey((k) => k + 1);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setSubmitting(false);
    }
  };

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
              rules v{RULES_VERSION} · cost-model v{COST_MODEL_VERSION}
              {jobId ? ` · job ${jobId.slice(0, 8)}` : ""}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <AccessKeyField />
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

      <main className="mx-auto grid max-w-[1500px] gap-4 px-4 py-5 lg:grid-cols-[360px_minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <UploadPanel
            photos={photos}
            onAdd={(added) => setPhotos((prev) => [...prev, ...added])}
            onMove={move}
            onRemove={remove}
          />
          <RunControls
            options={options}
            onChange={setOptions}
            photoCount={photos.length}
            onGenerate={() => void generate()}
            generating={submitting}
            disabledReason={disabledReason}
          />
          {submitError && (
            <p className="rounded-md border border-rose-900/60 bg-rose-950/30 p-2 text-[11px] text-rose-300">{submitError}</p>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          {jobId ? (
            <>
              <JobView
                key={jobId}
                jobId={jobId}
                onFinished={() => {
                  void loadRecipes(jobId);
                  setHistoryKey((k) => k + 1);
                }}
              />
              <details className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
                <summary className="cursor-pointer text-[12px] text-neutral-400">Recipe preview (canvas, instant)</summary>
                <div className="mt-3">
                  <CanvasPreview
                    recipe={recipe}
                    images={images}
                    aspect={aspect}
                    onAspectChange={setAspect}
                    fonts={fonts}
                    problems={problems}
                    source={usingReal ? "brain" : "stub"}
                    reels={realRecipes}
                    reelIndex={reelIndex}
                    onReelChange={setReelIndex}
                  />
                </div>
              </details>
              <details className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
                <summary className="cursor-pointer text-[12px] text-neutral-400">Advanced: node cards and hook controls</summary>
                <div className="mt-3 grid gap-4 xl:grid-cols-2">
                  <BrainPanel jobId={jobId} onChanged={() => void loadRecipes(jobId)} />
                  <HookPanel jobId={jobId} />
                </div>
              </details>
            </>
          ) : (
            <CanvasPreview
              recipe={recipe}
              images={images}
              aspect={aspect}
              onAspectChange={setAspect}
              fonts={fonts}
              problems={problems}
              source={usingReal ? "brain" : "stub"}
              reels={realRecipes}
              reelIndex={reelIndex}
              onReelChange={setReelIndex}
            />
          )}
        </div>

        <div className="space-y-4">
          <FactsForm facts={facts} onChange={setFacts} />
          <JobHistory currentJobId={jobId} options={options} onOpen={openJob} refreshKey={historyKey} />
        </div>
      </main>

      <footer className="mx-auto max-w-[1400px] px-4 pb-10 text-[11px] text-neutral-600">
        <p className={playfair.className}>
          Every generated hook ends on the untouched hero photo. Interiors are real photos unless a
          run turns on Veo glides, and every glide carries an on-screen AI label.
        </p>
      </footer>
    </div>
  );
}

/* useSearchParams needs a Suspense boundary on a statically prerendered route. */
export default function StudioPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading studio…</div>}>
      <Studio />
    </Suspense>
  );
}
