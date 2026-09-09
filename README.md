# reel-studio

Listing photos in, three vertical property reels out.

    shared/    rules.json, schemas.json, cost-model.json, recipe.ts  — BOTH sides read these
    web/       Next.js App Router dashboard + canvas preview, deploys to Vercel
    service/   Node 20 + ffmpeg + Python/Pillow render service, deploys to Railway
    docs/      the brain spec, the build plan, the VERIFIED hook pipeline
    stage0/    one-off Vertex smoke test and the hook attempts that produced hook-v4

Build order is `docs/FULL-SYSTEM-BUILD.md` (D1 skeleton, D2 brain, D3 hook and export,
D4 three reels). One prompt at a time.

## The contract

`shared/recipe.ts` defines `ReelRecipe`: the only thing that describes a reel. The
browser canvas in `web/src/lib/draw.ts` interprets it for preview; the ffmpeg renderer
in `service/` (D3) interprets the same object for export. One source of truth, two
renderers — if they diverge, `validateRecipe()` is the test that catches it.

`web/src/shared/` is a build-time copy of `/shared`, kept in step by
`web/scripts/sync-shared.mjs` (runs on predev/prebuild). It exists because Vercel builds
`web/` as the root directory and cannot see files above it. `npm run check:shared` fails
if the copy has drifted.

## Local development

    # service on :8080
    cd service && npm install && npm run fonts && npm run dev

    # web on :3000, pointed at it
    cd web && npm install
    NEXT_PUBLIC_SERVICE_URL=http://localhost:8080 npm run dev

`npm run fonts` downloads Inter, Playfair Display and Great Vibes into
`service/assets/fonts`. The container does this at image build time; locally you do it
once. macOS system fonts do not exist in `node:20-bookworm-slim`.

## Deploy

**Railway** — New Project → Deploy from GitHub → `reel-studio`.
Root Directory `/`, Dockerfile Path `service/Dockerfile`, Volume `/data` 5 GB,
Networking → Generate Domain. Variables per `.env.example`.

**Vercel** — Import `reel-studio` → Root Directory `web` → set
`NEXT_PUBLIC_SERVICE_URL` to the Railway domain. No GCP credentials on Vercel, ever.

## The three that never bend

1. Interiors are never AI-altered. Real photos, motion only.
2. Every generated hook ends on the untouched hero photo (the truth lock).
3. Cheap-first, and nothing is silently dropped: text plans, a still verifies, a vision
   call approves, only then does video run — gated by `GENERATIVE_ENABLED` until Stage 6
   — and every excluded photo carries a named reason.
