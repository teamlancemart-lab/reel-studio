# Handoff: decisions and the mistakes not to repeat

Written 2026-09-15 at handoff. Every decision below was paid for, in money or in a
failed run. Read this before you change a hook, a QA prompt or a spend gate. The rules
themselves live in `CLAUDE.md` and `shared/rules.json`; this file records why they exist.

---

## 1. Interiors are real photos with ffmpeg motion, not Veo

**Decision.** Interiors are the listing's real photos, moved with depth parallax, Ken Burns,
speed ramps and transitions. Any generated pixel on an interior is a hard block
(`INTERIOR_ALTERED`), with no override.

**Why: compliance.** A listing reel is advertising for a real property. If a video model
adds a window, widens a room, moves a door or "tidies" a fixture, the reel misrepresents
the property. That is a truth-in-advertising problem for the agent (MLS rules, RERA in
India), and the viewer cannot tell it happened. The exterior hook gets away with generation
only because it is visibly theatrical and ends on the untouched photo (the truth lock,
section 3). An interior shot has no such exit.

**Why: cost.** Veo 3.1 Lite on Vertex is $0.05/s. Five or six interiors at 2 to 4 s each
comes to about $0.60 to $1.20 per reel on top of the hook. That breaks the
$1.50-per-listing warn line, and the paid shots are the ones that most need QA. ffmpeg
motion costs ₹0 and is deterministic, so retunes are free forever.

**The one exception, opt-in (decided 2026-09-10).** With `INTERIOR_MOTION=veo`, up to 3 hero
interiors (kitchen, primary room, living space) get a 4 s Veo camera glide. The first frame
is the real photo and the prompt locks the architecture. Interior Q2 compares the clip to
the photo: any wall, door, window or fixture change rejects the clip, and that shot falls
back to 2.5d with no regeneration. Glides carry a motion disclosure on the segment and in
the CTA. The default is `2.5d`. On Lexington 2 of 3 glides passed (p013, p018) and p010 was
rejected. Treat this as deferred, not as the product (section 5).

---

## 2. Concealment hooks fail on row houses; camera-only hooks are the safe default

**What concealment means.** `helicopter_drape`, `block_build` (build-itself) and
`haze_reveal` hide the building, then reveal it. The model has to put an object exactly over
*the house*: a drape, scaffolding, fog.

**Why they fail on row houses and cluttered fronts.** The model needs a clear subject with a
silhouette. An attached row house has none: it shares walls and a roofline with its
neighbours, so there is no edge where "the building" stops. On 2572 Lexington (attached,
with an SUV parked in front, and the only exterior photo in the set):
- `helicopter_drape` put the cover on the **SUV** in 4 of 4 stills and left the house
  visible. The first paid run passed Q1 ("vehicles 1 vs 1", since a covered car is still a
  car) and Veo animated a drape onto the car. Q1 now asks what the object is ON
  (`concealment_target_wrong`).
- `block_build` failed Q1 twice on the same photo, the attached walls and the SUV again.
- Result: about ₹50 of paid spend across three builds and no accepted paid hook. The reel
  shipped on the free `blueprint_to_photo` hook.

The same pipeline worked 2 of 2 times on 253 Brindle Rd, a detached house with a clean
front and an aerial. The pipeline is not broken; the subject matters.

**Decision.** Camera-only hooks are the safe default for exteriors: push-in, orbit and crane
moves on the real photo, where no object is invented and only the camera moves. There is
nothing to mis-place, the building never has to be re-drawn, and Q2 only has to confirm
that nothing changed. Offer concealment only when B0 sees a detached building with a clear
silhouette and nothing in front of it.

**Status: not built yet.** Today the default paid concept is still `block_build`, and the
only camera concept, `unveiling_flyover` (`clip_only`, needs an `aerial_34`), is marked
`never_default`. `service/src/hook/index.js` also refuses any path except `reverse_conceal`
and `free_2p5d`. Building a `camera_only` generation path and making it the default is the
first job on the hook side. A camera move with no `lastFrame` can run at 4 or 6 s, so it is
also cheaper (section 4).

**Don't:** keep rerolling a drape on a hard property. `max_rerolls_per_hook` is 1 for a
reason. Two Q1 failures means the photo is wrong for the concept, not that the dice are bad.

---

## 3. The verified hook pipeline: `reverse_conceal`

Verified September 2026 in `docs/hook-v4.mjs`, ported step for step to
`service/src/hook/paid.js`. The order is the point:

1. **Crop the hero to 9:16 before any model call** (B0 `safe_crop_9x16`). Otherwise the
   model letterboxes or reframes.
2. **H1 still = the END state.** The object fully covers the building, with the hero as the
   reference image. The prompt lists everything that stays unchanged: neighbours, vehicles,
   trees, power lines, sky, light direction.
3. **Q1** checks the still against the hero in one vision call. One reroll, then fall back
   to a free hook.
4. **H2 Veo clip: first frame = the REAL hero, `lastFrame` = the still.** The clip covers
   the building *forward*.
   - **Never condition only on a still where the building is hidden.** Veo invented a
     completely different house, twice.
   - **`lastFrame` requires `durationSeconds: 8` on Vertex.** 4 and 6 are rejected when a
     last frame is given, so every paid hook is an 8 s clip ($0.40).
   - `generateAudio: false` does **not** lower the Vertex price. Audio is bundled.
     `personGeneration: dont_allow`.
5. **Reverse** at fps 30. The clip now plays as a reveal that ends on the real photo.
6. **Cut the window from the END**, 2 to 3 s, where the reveal completes. Never use the whole
   clip.
7. **Truth lock.** Crossfade the last 15 frames into a 1 s hold of the untouched hero photo.
   Every hook, paid or free, ends this way.
8. **Q2** on frames at 33/66/100% of the reversed clip.

**QA rules that took four attempts to learn** (enforced in code in
`service/src/hook/qa.js`, not in a prompt someone can soften):
- **Score the property on the final frame only.** Mid-reveal the building is *supposed* to
  be hidden.
- **The theatrical object is never a reject.** Rejects are codes from
  `rules.json qa_reject_list`, and remarks about the object go in `object_notes`, which
  cannot fail a hook.
- **Counts drift between runs** (8 vs 14 front windows on the same photo). Compare reference
  and generated **inside one call** only, never across runs or against a stored number.
- **Ask what the object is ON.** See the SUV in section 2.

**Retune is free.** Steps 5 to 7 are ffmpeg only (`cutAndLock`), so moving the hook window
re-renders with zero model calls, and the ledger proves it. A Veo video blocked by the
safety filter is credited back in the ledger.

---

## 4. The cost model

Rates are in `shared/cost-model.json` (usd_inr 84). Only the Veo hook costs real money.

| Step | Cost |
|---|---|
| Brain B0–B8 (text and vision, B0 per photo) | under ₹5 per job |
| H1 still (Gemini 2.5 Flash Image) | $0.039, about ₹3.3 |
| Q1 and Q2 vision | about ₹0.5 each |
| **H2 Veo 3.1 Lite, 8 s × $0.05/s** | **$0.40, about ₹33.6** |
| Walkthrough, CTA, overlays, assembly, retunes | ₹0 |
| **One video with a paid hook, no reroll** | **about ₹39** |
| A reroll | about +₹37 |
| Opt-in interior glides, 3 × 4 s | +$0.60, about ₹50 |

- **Guards:** warn above $1.50 and block above $3 per listing. The block is enforced in
  `budgetCheck` before every paid step. A Veo call also needs `GENERATIVE_ENABLED=true` on
  the server; no job option can override that.
- **Every model call writes a `cost_ledger` row before success is reported.** The dashboard
  totals come from the ledger, not from estimates.
- **The benchmark is Rendy at $2.50 per video wholesale.** `cost-model.json` also records
  Rendy's partner guidance of $75 for three reels. At ₹39 (about $0.46) we have headroom for
  one reroll, but not for Veo on every shot.
- Cheaper Veo exists: fal lists Veo 3.1 Lite with audio off at about $0.03/s. That rate is
  unverified, so check the provider page before switching.

---

## 5. Deliberately deferred

| What | State | Why it waits |
|---|---|---|
| **Three distinct reels per job (D4)** | The pipeline exports three reels from one asset pool, but reel-to-reel variety (tier, hook, title system, transitions) is unverified and the 16:9 derivative is flagged in the recipe, not rendered | Get one reel right first. D5 (reference format) is merged but not verified end to end; the 2530 N 2nd St run never finished |
| **Interior Veo glides** | Built, opt-in (`INTERIOR_MOTION=veo`), QA-gated | Compliance risk and about ₹50 per job. Default stays 2.5d |
| **Licensed music** | `service/assets/music/tracks.json` holds placeholder beat grids with no audio files, all `licensed:false`. Masters render silent; B8 flags `MUSIC_UNLICENSED` | Needs a licensed library and real beat analysis (librosa) to replace the arithmetic grids |
| **Camera-only hook path** | Decided, not built (section 2) | The next hook task |

---

## 6. Operational traps we already fell into

- **Railway does not auto-deploy.** Vercel deploys `main` on push; Railway needs
  `railway up --detach --service reel-studio` from a clean checkout of `main`. The project
  is in the *Haus of Intelligence* Railway workspace, which is a different account from the
  GitHub and Vercel owner (`teamlancemart-lab`).
- **Production is not wired yet (as of 2026-09-15).** Railway runs pre-D5 code.
  `GCP_SA_JSON_B64` there is a 74-character placeholder, so every brain call fails at B0.
  There is no volume at `/data`, so job history dies with each deploy. `GENERATIVE_ENABLED`
  is `true` and `INTERIOR_MOTION` is `veo`, and the service is public. **Set
  `STUDIO_ACCESS_KEY` before you put the real key there.** Otherwise anyone who finds the
  URL can spend Veo money. The per-job $3 block limits spend per job, not the number of
  jobs.
- **Never put `DATA_DIR` in a temp or scratch directory.** Veo returns video bytes inline
  and we use no GCS bucket, so Vertex keeps no copy. A wiped `DATA_DIR` destroyed every
  D2/D3 job, ledger and paid clip on 2026-09-12. Use `service/data/` (gitignored) locally
  and a volume in production.
- **`sa.json` never goes in git**, in a doc, in a log or in a chat. The service reads it only
  as base64 from `GCP_SA_JSON_B64`. `.gitignore` covers `sa.json` at any depth and every
  `.env*` except `.env.example`. History was audited clean at handoff.
- **No `drawtext`.** The container's ffmpeg is built without freetype. All text is Pillow
  PNG sequences (`service/src/render/overlays.py`), inside `rules.json safe_zone_9x16`.
- **Edit `/shared`, never `web/src/shared`.** The latter is a generated copy
  (`npm run sync:shared`); `npm run check:shared` catches drift.
- **Test listing photos are licensed and never committed** (`fixtures/`, `tmp/` are
  gitignored). Ask the project owner for the Lexington, Brindle and N 2nd St sets and for
  `tmp/archive-import/`, which holds manifests to re-import surviving reels as archived
  jobs via `POST /archive`.
