# reel-studio

Listing photos plus a property address in, finished vertical property reels out.
Each reel is **Hook → Walkthrough → CTA** at 1080×1920. The hook is a Veo reveal of the
exterior that ends on the untouched hero photo. The walkthrough and CTA are real photos
with ffmpeg motion and Pillow-rendered text, and cost nothing to render.

Read [`docs/HANDOFF.md`](docs/HANDOFF.md) before changing anything. It is the decisions log.

## Architecture

```
 browser ──▶ web/      Next.js 16 dashboard on Vercel. Upload, facts, run controls,
                       canvas preview, live pipeline view over SSE. No credentials.
               │  REST + SSE (NEXT_PUBLIC_SERVICE_URL)
               ▼
            service/   Node 20 + Express + ffmpeg + Python/Pillow on Railway (Docker).
                       Brain (Gemini), hooks (Gemini image + Veo), QA, render, ledger.
                       The only place the GCP service-account key lives.

            shared/    rules.json       hook bank, tiers, motion, safe zones, banned phrases, preflight
                       schemas.json     the JSON every brain node must return
                       cost-model.json  rates, per-node estimates, budget guards ($1.50 warn, $3 block)
                       recipe.ts        ReelRecipe, the contract both renderers interpret
```

Both sides read `/shared`. The hook pool is `hook_bank` inside `rules.json`; there is no
separate hook-pool file.

**How the shared copy works.** Vercel builds with Root Directory `web`, so it cannot see
`../shared`. `web/scripts/sync-shared.mjs` copies `/shared` into `web/src/shared` on every
`npm run dev` and `npm run build`, and the copy is committed. Edit `/shared` only, then run
`npm run sync:shared` in `web/` and commit both. `npm run check:shared` fails if they have
drifted. The service reads `/shared` directly: `../shared` locally, `/app/shared` in the
container.

## Live

| | URL | Deploys |
|---|---|---|
| Dashboard (Vercel) | https://reel-studio-omega.vercel.app | automatically on push to `main` |
| Service (Railway)  | https://reel-studio-production-18ec.up.railway.app/health | **manually**, `railway up` (see Deploy) |

## Local setup

Needs Node 20+, `ffmpeg` on PATH and `python3` (macOS: `brew install node ffmpeg python`).

```bash
git clone https://github.com/teamlancemart-lab/reel-studio.git
cd reel-studio

# 1. Credentials. Get sa.json (the Vertex service-account key) from the project owner and
#    put it at the repo root. It is gitignored; never commit it or paste it anywhere.
cp ~/Downloads/sa.json ./sa.json

# 2. Env. The service reads the key only as base64 in GCP_SA_JSON_B64, never from a file.
cp .env.example .env
KEY=$(base64 < sa.json | tr -d '\n')
PROJECT=$(node -p "require('./sa.json').project_id")
sed -i.bak -e "s|^GCP_SA_JSON_B64=.*|GCP_SA_JSON_B64=$KEY|" \
           -e "s|^GCP_PROJECT_ID=.*|GCP_PROJECT_ID=$PROJECT|" .env && rm .env.bak

# 3. Service on :8080
cd service
npm install
npm run fonts                                   # Inter, Playfair Display, Great Vibes
python3 -m venv .venv && .venv/bin/pip install "Pillow>=11"
npm run dev                                     # loads ../.env
```

In a second terminal, from the repo root:

```bash
# 4. Dashboard on :3000
cd web
npm install
echo "NEXT_PUBLIC_SERVICE_URL=http://localhost:8080" > .env.local
npm run dev                                     # http://localhost:3000
```

Check it: `curl http://localhost:8080/health` should return `"ok":true` with ffmpeg,
python/Pillow and fonts all `"ok":true`. The dashboard header should read
"paid calls OFF (kill switch) · interiors 2.5d". Before pushing web changes run
`npm run typecheck && npm run lint && npm run build` in `web/`.

Notes: the container pins Pillow 11.0.0 on Python 3.11. Recent Pythons (3.13+) have no
11.0.0 wheel, so locally take any Pillow 11 or newer; the overlays render the same on
12.3. `npm install` in `web/` may print an `allow-scripts` warning for `unrs-resolver`;
it is harmless.

Local runs are free until you choose otherwise. `.env` ships with
`GENERATIVE_ENABLED=false`, which blocks every Veo call whatever the job asks for. The brain
and still images still call Vertex, for a few rupees a job. Jobs are written to
`service/data/` (gitignored).

## Deploy

- **Web.** Push to `main`. Vercel builds `web/` and aliases it to
  reel-studio-omega.vercel.app in about 20 s. Its only variable is `NEXT_PUBLIC_SERVICE_URL`.
- **Service.** Railway does **not** deploy on push. It is not connected to the GitHub repo:
  the project `affectionate-creativity`, service `reel-studio`, sits in the *Haus of
  Intelligence* Railway workspace. Deploy from a clean checkout of `main`:
  ```bash
  railway link            # once: pick affectionate-creativity / production / reel-studio
  railway up --detach --service reel-studio
  ```
  The build uses `railway.json` → `service/Dockerfile`, with the repo root as the build
  context. Set variables in Railway → Variables per the SERVICE block of `.env.example`.
  To make it auto-deploy, connect the service to `teamlancemart-lab/reel-studio`, branch
  `main`, in Railway → Settings → Source.

## How a job runs

**In the dashboard:** drop 8 to 40 photos → fill the facts (address, price, beds/baths/area,
agent, MLS) → set the run controls (paid hook on or off plus a concept per reel, interiors
2.5d or Veo glides, a live cost estimate against the $1.50 warn and $3 block lines) →
**Generate**. The pipeline view streams every brain node, hook attempt (still, Q1 verdict,
Veo clip, Q2 verdict), glide and export. Results play inline with the cost ledger. **Retune**
re-cuts the hook window for free. History lets you reopen or duplicate any job.

**In the service** (`service/src/pipeline.js`, one `POST /jobs`):

1. **Probe.** ffprobe every upload. Unreadable photos are excluded with a named reason.
2. **Brain, B0–B8** (`service/src/brain/`, spec in `docs/property-reel-brain-v1.md`):
   B0 photo classification (vision) → B1 listing truth → B2 tier and persona → B3 format →
   B4 hook concept per reel, chosen from `rules.json` `hook_bank` → B5 shot list → B6 copy →
   B7 track and pacing → B8 preflight gate. Every node is schema-validated and has a status,
   a cost, a lock and a regenerate. Nothing paid runs unless B8 passes.
3. **Hook** (`service/src/hook/`). Free concepts render in ffmpeg. A paid concept runs the
   verified `reverse_conceal` path: crop the hero to 9:16 → H1 still of the end state → Q1
   vision QA → H2 Veo 8 s clip from the *real* photo → reverse → Q2 QA → truth lock (a
   crossfade into the untouched hero). A second QA failure falls back to a free hook.
4. **Interior glides** (only with `INTERIOR_MOTION=veo`). Up to 3 hero interiors, each
   gated by interior Q2. Any change to a wall, door, window or fixture puts that shot back
   to 2.5d.
5. **Export** (`service/src/render/`). ffmpeg assembles the hook window, 2.5d walkthrough and
   CTA. All text is Pillow PNG sequences (`overlays.py`), never `drawtext`, inside
   `safe_zone_9x16`. Every model call writes a `cost_ledger` row before success is reported.

## State, as of 2026-09-15

**Works (verified on real listings):** canvas preview; the brain B0–B8; free hooks; export;
free retune; caption binding (defects never become copy); the `reverse_conceal` Veo hook on
a detached house (253 Brindle Rd, 2 of 2 runs preserved the building); Veo interior glides
(2 of 3 approved on 2572 Lexington); the end-to-end dashboard run; access-key-gated writes
and archived jobs (tsc, lint, build, local curl).

**In progress:**
- D5, the reference-reel format (serif status, beds/baths pill, CTA over a darkened aerial,
  one paid hook per reel), is merged but **not verified end to end**. The 2530 N 2nd St run
  never finished.
- Production Railway still runs pre-D5 code (rules 1.4, no access key). It needs a
  `railway up`. Before that, set `STUDIO_ACCESS_KEY`, because the service is public with
  `GENERATIVE_ENABLED=true`.

**Known issues:**
- **Row-house exterior hooks fail.** Concealment concepts (`helicopter_drape`,
  `block_build`) failed Q1 on every attempt on the attached Lexington row house with an SUV
  in front. Camera-only hooks are the intended safe default but are **not implemented yet**:
  the only camera concept, `unveiling_flyover`, is marked `never_default`. See HANDOFF.
- **Music is a placeholder.** `service/assets/music/tracks.json` holds beat grids with no
  audio files, and every track is `licensed:false`. Masters render silent and B8 flags
  `MUSIC_UNLICENSED`.
- **Three distinct reels per job is deferred (D4).** The pipeline exports three reels from
  one asset pool, but reel-to-reel variety and the 16:9 derivative are unverified or not
  rendered.
- **Production cannot run the brain.** Railway's `GCP_SA_JSON_B64` is a placeholder, so
  every job fails at B0. Railway also has **no volume** at `/data`, so job history is
  wiped on each deploy.

## Where to read more

| Doc | What |
|---|---|
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Decisions and the mistakes not to repeat |
| [`docs/FULL-SYSTEM-BUILD.md`](docs/FULL-SYSTEM-BUILD.md) | Architecture, the D1–D4 build prompts, deploy, cost per listing |
| [`docs/property-reel-brain-v1.md`](docs/property-reel-brain-v1.md) | Node graph B0–B8 and H1/Q1/H2/Q2, every contract and prompt |
| [`docs/reference-reel-anatomy-v1.md`](docs/reference-reel-anatomy-v1.md) | Breakdown of the reference (Rendy) reels the format copies |
| [`docs/PHASE-PROMPTS.md`](docs/PHASE-PROMPTS.md) | Stage-by-stage build prompts |
| [`docs/hook-v4.mjs`](docs/hook-v4.mjs), [`docs/retune.mjs`](docs/retune.mjs), [`docs/vertex-smoke-test.mjs`](docs/vertex-smoke-test.mjs) | The verified standalone hook pipeline, free retune and Vertex smoke test |
| `stage0/*.mjs` | The earlier hook attempts that led to hook-v4 |
| [`CLAUDE.md`](CLAUDE.md) | The non-negotiable rules. Coding agents load it automatically |
