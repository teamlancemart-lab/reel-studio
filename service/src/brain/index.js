/**
 * The brain, end to end.
 *
 * B0 -> dedupe -> B1 -> B2 -> B3 -> B4 per reel -> B5 -> (B6, B7 per reel) -> B8 -> buildRecipes
 *
 * Cheap-first ordering is not an accident of sequence: B8 runs before anything can be
 * generated, so a Fair Housing violation costs one text call rather than three Veo
 * clips. B4 only PLANS the hook. Nothing here spends on generation: the paid hook runs
 * from POST /jobs/:id/hooks/:reelN/generate, behind the pre_generation gate.
 */
import fs from "node:fs";
import path from "node:path";
import { SERVICE_ROOT } from "../config.js";
import {
  readJob,
  writeJob,
  setStage,
  addExclusion,
  emit,
  complete,
  fail,
} from "../store.js";
import { ledgerTotals } from "../ledger.js";
import {
  computeHashes,
  runB0,
  runDedupe,
  runB1,
  runB2,
  runB3,
  runB4,
  runB5,
  runB6,
  runB7,
} from "./nodes.js";
import { runB8 } from "./preflight.js";
import { buildRecipes, validateRecipe } from "./recipe.js";
import { jobFlags } from "../jobOptions.js";

export function loadTracks() {
  const p = path.join(SERVICE_ROOT, "assets", "music", "tracks.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8")).tracks || [];
}

/**
 * @param opts.resume  reuse nodes already stored as ok and not stale.
 *
 * A transient "fetch failed" on B6 reel 3 killed a run that had already paid for B0,
 * B1, B2, B3, B5 and four other nodes. Re-running all of that to retry one call is
 * money set on fire, and the graph already knows which nodes are good.
 */
export async function runBrain(jobId, { resume = false, finish = true } = {}) {
  const tracks = loadTracks();

  const stored = (key) => {
    if (!resume) return null;
    const n = readJob(jobId).nodes[key];
    return n && n.status === "ok" && !n.stale ? n.payload : null;
  };
  const reuse = async (key, run) => {
    const hit = stored(key);
    if (hit) {
      emit(jobId, "node", { key, status: "reused", note: "already ok, not stale" });
      return hit;
    }
    return run();
  };

  setStage(jobId, "hashing", 0.05, { status: "processing" });
  {
    const job = readJob(jobId);
    await computeHashes(jobId, job);
    writeJob(job);
  }

  /* ---- B0 + dedupe ---- */
  setStage(jobId, "brain:B0", 0.1);
  const b0 = await reuse("B0", () => runB0(jobId));

  setStage(jobId, "dedupe", 0.25);
  const { kept, dropped, groups } = runDedupe(jobId);
  {
    const job = readJob(jobId);
    job.dedupe = { groups, dropped };
    for (const d of dropped) {
      const photo = job.photos.find((p) => p.id === d.photo_id);
      if (photo) photo.excluded_reason = d.reason;
      const asset = job.nodes.B0.payload.assets.find((a) => a.photo_id === d.photo_id);
      if (asset) asset.excluded_reason = d.reason;
    }
    writeJob(job);
    for (const d of dropped) addExclusion(jobId, d.photo_id, d.reason);
  }

  const assets = kept;
  emit(jobId, "dedupe", {
    kept: assets.length,
    dropped: dropped.length,
    groups: groups.length,
  });

  /* ---- B1 ---- */
  const job0 = readJob(jobId);
  setStage(jobId, "brain:B1", 0.3);
  const truth = await reuse("B1", () => runB1(jobId, { facts: job0.facts, assets }));

  /* ---- B2 ---- */
  setStage(jobId, "brain:B2", 0.4);
  const persona = await reuse("B2", () => runB2(jobId, { truth }));

  /* ---- B3 ---- */
  setStage(jobId, "brain:B3", 0.45);
  const formats = await reuse("B3", () => runB3(jobId, { truth, persona, assets }));

  /* ---- B4, per reel. One paid hook per job at most (cost-model presets.one_paid_hook). */
  const hooks = [];
  const flags = jobFlags(readJob(jobId));
  for (const entry of formats.reels) {
    const reelN = entry.reel_n;
    /* Reel 1 carries the run controls' concept. A paid hook is only allowed on a job
       run with generative on, and at most one per job. */
    const forcedConcept = reelN === 1 ? flags.hookConcept : null;
    setStage(jobId, `brain:B4:${reelN}`, 0.47 + 0.02 * reelN);
    hooks.push(
      await reuse(`B4:${reelN}`, () =>
        runB4(jobId, reelN, {
          truth,
          persona,
          assets,
          alreadyPicked: hooks.map((h) => h.concept_id),
          paidAllowed: flags.paidHook && !hooks.some((h) => h.generation_path !== "free_2p5d"),
          forcedConcept,
        }),
      ),
    );
  }

  /* ---- B5 ---- */
  setStage(jobId, "brain:B5", 0.55);
  const shotList = await reuse("B5", () =>
    runB5(jobId, { truth, persona, assets, formats, excluded: dropped }),
  );

  /* ---- B6 and B7, per reel ---- */
  const copySets = [];
  const pacings = [];
  for (const entry of formats.reels) {
    const reelN = entry.reel_n;
    setStage(jobId, `brain:B6:${reelN}`, 0.6 + 0.08 * reelN);
    copySets.push(
      await reuse(`B6:${reelN}`, () =>
        runB6(jobId, reelN, { truth, persona, format: entry, shots: shotList.shots, assets }),
      ),
    );

    setStage(jobId, `brain:B7:${reelN}`, 0.63 + 0.08 * reelN);
    pacings.push(
      await reuse(`B7:${reelN}`, () =>
        runB7(jobId, reelN, {
          tier: entry.tier,
          persona,
          shots: shotList.shots,
          tracks,
          hookLengthS: 2.5,
        }),
      ),
    );
  }

  /* ---- buildRecipes: pure, no model call ---- */
  setStage(jobId, "recipes", 0.85);
  const job = readJob(jobId);
  const photoUrl = (photoId) => {
    const photo = job.photos.find((p) => p.id === photoId);
    return photo ? `/jobs/${jobId}/file/${encodeURIComponent(photo.storedName)}` : undefined;
  };
  const { recipes, notes } = buildRecipes(formats, shotList, copySets, pacings, {
    photoUrl,
    typeVoice: persona.type_voice,
  });

  const recipeProblems = recipes.flatMap((r) =>
    validateRecipe(r).map((p) => `${r.reelId}: ${p}`),
  );
  {
    const j = readJob(jobId);
    j.recipes = recipes;
    j.recipeNotes = notes;
    j.recipeProblems = recipeProblems;
    writeJob(j);
  }
  emit(jobId, "recipes", {
    count: recipes.length,
    notes,
    problems: recipeProblems,
    recipes,
  });

  /* ---- B8 ---- */
  setStage(jobId, "brain:B8", 0.95);
  const preflight = await runB8(jobId, {
    stage: "pre_export",
    truth,
    formats,
    shots: shotList.shots,
    assets,
    copySets,
    pacings,
    recipes,
    tracks,
    hooks,
  });

  const finalJob = readJob(jobId);
  emit(jobId, "ledger_total", ledgerTotals(finalJob.ledger));

  if (!preflight.pass) {
    const blocks = preflight.results.filter((r) => r.level === "BLOCK");
    fail(
      jobId,
      `preflight BLOCK: ${blocks.map((b) => `${b.rule_id} — ${b.message}`).join(" | ")}`,
    );
    return { blocked: true, preflight };
  }

  if (finish) complete(jobId);
  return { blocked: false, preflight, recipes };
}

/* ------------------------------------------------------- single-node regenerate */

/**
 * Re-run ONE node from stored inputs. Siblings are untouched; descendants were already
 * marked stale by the runner, with a rebuild cost the UI shows.
 *
 * Inputs come from the stored payloads of the parents, not from a re-run of them —
 * that is the whole point of the graph.
 */
export async function regenerateNode(jobId, nodeKey) {
  const job = readJob(jobId);
  const record = job.nodes[nodeKey];
  if (!record) throw new Error(`no node ${nodeKey} on job ${jobId}`);

  const payloadOf = (k) => {
    const n = job.nodes[k];
    if (!n?.payload) throw new Error(`${nodeKey} needs ${k}, which has no payload`);
    return n.payload;
  };
  const { node, reelN } = record;
  const tracks = loadTracks();

  const survivors = () => {
    const b0 = payloadOf("B0");
    const droppedIds = new Set((job.dedupe?.dropped || []).map((d) => d.photo_id));
    return b0.assets.filter((a) => !droppedIds.has(a.photo_id));
  };

  switch (node) {
    case "B0":
      return runB0(jobId);
    case "B1":
      return runB1(jobId, { facts: job.facts, assets: survivors() });
    case "B2":
      return runB2(jobId, { truth: payloadOf("B1") });
    case "B3":
      return runB3(jobId, {
        truth: payloadOf("B1"),
        persona: payloadOf("B2"),
        assets: survivors(),
      });
    case "B4": {
      const others = Object.keys(job.nodes)
        .filter((k) => k.startsWith("B4:") && k !== nodeKey)
        .map((k) => job.nodes[k].payload)
        .filter(Boolean);
      const flags = jobFlags(job);
      return runB4(jobId, reelN, {
        truth: payloadOf("B1"),
        persona: payloadOf("B2"),
        assets: survivors(),
        alreadyPicked: others.map((h) => h.concept_id),
        paidAllowed: flags.paidHook && !others.some((h) => h.generation_path !== "free_2p5d"),
        forcedConcept: reelN === 1 ? flags.hookConcept : null,
      });
    }
    case "B5":
      return runB5(jobId, {
        truth: payloadOf("B1"),
        persona: payloadOf("B2"),
        assets: survivors(),
        formats: payloadOf("B3"),
        excluded: job.dedupe?.dropped || [],
      });
    case "B6": {
      const formats = payloadOf("B3");
      const entry = formats.reels.find((r) => r.reel_n === reelN);
      return runB6(jobId, reelN, {
        truth: payloadOf("B1"),
        persona: payloadOf("B2"),
        format: entry,
        shots: payloadOf("B5").shots,
        assets: survivors(),
      });
    }
    case "B7": {
      const formats = payloadOf("B3");
      const entry = formats.reels.find((r) => r.reel_n === reelN);
      return runB7(jobId, reelN, {
        tier: entry.tier,
        persona: payloadOf("B2"),
        shots: payloadOf("B5").shots,
        tracks,
        hookLengthS: 2.5,
      });
    }
    case "B8": {
      const formats = payloadOf("B3");
      /* The gate reads the recipes the reels will actually be built from. Regenerating
         B8 alone used to read job.recipes as stored, which can predate a B6 regenerate:
         it BLOCKed on captions that no longer existed, and could as easily PASS a reel
         whose new copy was the problem. Rebuilding is pure and free. */
      const { recipes: current } = rebuildRecipes(jobId);
      return runB8(jobId, {
        stage: "pre_export",
        truth: payloadOf("B1"),
        formats,
        shots: payloadOf("B5").shots,
        assets: survivors(),
        copySets: formats.reels.map((r) => payloadOf(`B6:${r.reel_n}`)),
        pacings: formats.reels.map((r) => payloadOf(`B7:${r.reel_n}`)),
        recipes: current,
        tracks,
        hooks: formats.reels.map((r) => job.nodes[`B4:${r.reel_n}`]?.payload).filter(Boolean),
      });
    }
    default:
      throw new Error(`regenerate not implemented for ${node}`);
  }
}

/** Rebuild the recipes from the stored B3/B5/B6/B7. Pure, free, no model call. */
export function rebuildRecipes(jobId) {
  const job = readJob(jobId);
  const formats = job.nodes.B3?.payload;
  const shotList = job.nodes.B5?.payload;
  if (!formats || !shotList) throw new Error("need B3 and B5");

  const copySets = formats.reels.map((r) => job.nodes[`B6:${r.reel_n}`]?.payload).filter(Boolean);
  const pacings = formats.reels.map((r) => job.nodes[`B7:${r.reel_n}`]?.payload).filter(Boolean);
  const photoUrl = (photoId) => {
    const photo = job.photos.find((p) => p.id === photoId);
    return photo ? `/jobs/${jobId}/file/${encodeURIComponent(photo.storedName)}` : undefined;
  };

  const { recipes, notes } = buildRecipes(formats, shotList, copySets, pacings, {
    photoUrl,
    typeVoice: job.nodes.B2?.payload?.type_voice || "sans_pill",
  });
  const problems = recipes.flatMap((r) => validateRecipe(r).map((p) => `${r.reelId}: ${p}`));

  const j = readJob(jobId);
  j.recipes = recipes;
  j.recipeNotes = notes;
  j.recipeProblems = problems;
  writeJob(j);
  emit(jobId, "recipes", { count: recipes.length, notes, problems, recipes });
  return { recipes, notes, problems };
}
