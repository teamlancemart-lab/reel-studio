# Listing Reel Studio: Full System Build

Complete system. Listing images in, three finished reels out. Vercel for the dashboard, Railway for rendering. Built around the segment model from your prototype.

## 0. TLDR

1. **Two services, split by what they need.** Vercel runs the dashboard because it deploys from git in 90 seconds and is where the ReoClaw frontend lives. Railway runs the render service because ffmpeg and Python cannot run on Vercel.
2. **Your prototype's biggest idea stays: canvas preview in the browser.** It is instant, free, and scrubbing is how you actually iterate. So preview is browser canvas, export is Railway ffmpeg. Same recipe JSON drives both, so what you scrub is what you get.
3. **Only the hook costs money.** Walkthrough, floor plan and CTA are deterministic. That is why a 30-second reel costs ₹38 and three reels cost ₹45.
4. Railway MCP is not connected to this chat, so Railway is browser setup (5 clicks, Part C). Vercel MCP is connected, so I can deploy and check that side directly.
5. Build order is four prompts: skeleton, brain, render, three-reel. Each ends in something you can look at.

---

## 1. Architecture

```
                    ┌──────────────────────────────────────┐
 Browser ──────────▶│ VERCEL: Next.js dashboard            │
                    │  • upload, listing facts             │
                    │  • brain cards (editable)            │
                    │  • CANVAS PREVIEW + scrub  ← instant │
                    │  • retune sliders          ← free    │
                    └──────────────┬───────────────────────┘
                                   │ recipe JSON + SSE
                    ┌──────────────▼───────────────────────┐
                    │ RAILWAY: render service              │
                    │  • Vertex: Gemini, Nano Banana, Veo  │
                    │  • ffmpeg + python venv (Pillow)     │
                    │  • /data volume                      │
                    └──────────────────────────────────────┘
```

| Concern | Where | Why |
|---|---|---|
| Dashboard, uploads, forms | Vercel | Git deploys, edge, same stack as ReoClaw |
| Preview and scrubbing | **Browser canvas** | Instant. No round trip. Free iteration |
| Brain (Gemini text and vision) | Railway | Keeps the service account key in one place |
| Hook generation (Veo) | Railway | Long-running, needs the ffmpeg reverse |
| Final render and export | Railway | ffmpeg, Pillow, fonts |
| Files | Railway volume | Move to R2 later behind one function |

**The recipe is the contract.** The brain emits a `ReelRecipe` JSON. The browser canvas interprets it for preview; the Railway ffmpeg renderer interprets the same JSON for export. One source of truth, two renderers. If they ever diverge, that is a bug with an obvious test.

---

## 2. The reel model, from your prototype

Your `segments()` was hook 0-3, walkthrough 3-18 split by interior count, plan 18-25, CTA 25-30. Keeping the shape, adjusting durations to the reference-reel research:

| Segment | Duration | Content | Cost |
|---|---|---|---|
| Hook | 2.5s | Generative reveal ending on the untouched exterior | **paid** |
| Exterior title | 2.0s | Front exterior, slow push, status card | free |
| Walkthrough | 12 to 16s | 4 to 6 interiors, 2 to 3s each, alternating push and pull, one fact caption each | free |
| Floor plan | 4.0s | Self-draw stroke reveal, then area caption | free |
| Exterior return | 2.0s | Aerial or front, slow pull | free |
| CTA | 4.0s | Price, address, agent, compliance band | free |

Three tiers from the same assets: fast 15s, medium 24s, slow 34s. Different tier, different hook, different title system, different transition family per reel.

---

## 3. Build prompts

Four prompts, in order. Each ends with something visible.

### PROMPT D1 — Skeleton and preview

```
Build the Listing Reel Studio skeleton. Two deployables in one repo.

  /web      Next.js 15 App Router, deploys to Vercel. Dashboard and canvas preview.
  /service  Node 20 + ffmpeg + python venv, deploys to Railway from /service/Dockerfile.
  /shared   rules.json, schemas.json, cost-model.json. BOTH read these.

Read shared/rules.json (v1.1) and shared/schemas.json first.
docs/hook-v4.mjs and docs/retune.mjs are a VERIFIED hook pipeline. Port them in D3.
Do not redesign the hook path.

=== SHARED: the recipe contract ===
/shared/recipe.ts, imported by both sides. A ReelRecipe is the ONLY thing that describes a
reel:
  { reelId, tier, aspect: "9x16", fps: 30, durationS,
    segments: [ { kind: "hook"|"exterior_title"|"interior"|"floor_plan"|
                        "exterior_return"|"cta",
                  tIn, tOut,
                  source: { type: "photo"|"clip"|"generated", id, url },
                  crop: { xCenter, yCenter, widthFrac },
                  motion: "push"|"pull"|"pan_l"|"pan_r"|"parallax_lr"|"self_draw"|"static",
                  transitionIn: "cut"|"crossfade"|"zoom_through"|"whip_blur"|"light_leak",
                  overlays: [ { kind:"title"|"caption"|"cta_band"|"disclosure",
                                system:"price_stack"|"status_card"|"address_only"|
                                       "search_intent"|"number_first",
                                lines: string[], tIn, tOut } ] } ],
    audio: { trackId, dropMs },
    truthLock: { atS, frames, sourcePhotoId } }

=== /service ===
Express. Dockerfile: node:20-bookworm-slim, apt ffmpeg python3 python3-venv, /opt/venv with
Pillow, and download Playfair Display + Great Vibes + Inter from Google Fonts at build time
into /app/assets/fonts. macOS system fonts do not exist in the container.

  lib/vertex.js   token minting with google-auth-library, cached. callText, callVision,
                  callImage, submitVideo, pollVideo. Ledger row before every return.
  POST /jobs      multipart photos[] + facts JSON -> {jobId}, processes async
  GET  /jobs/:id/events   SSE: stage, progress, node payloads, ledger, artefact URLs
  GET  /jobs/:id          full job JSON
  GET  /jobs/:id/file/:name   streams an artefact
  GET  /health
  In D1 the pipeline only: saves files, returns dimensions, sets status=completed.

=== /web ===
  Upload panel: drag-drop 8 to 40 images. Client-side downscale to 1600px. Three buckets
  auto-split by filename order for now (exterior / interior / floor plan), each with a
  thumbnail strip you can drag between buckets. Ports the drop-zone logic from your
  prototype listing_reel_studio.html.
  Listing facts form: address, locality, city, market (us|in), price, beds, baths, area
  value+unit+basis, property type, status, agent, phone, brokerage, captions.
  CANVAS PREVIEW, the centrepiece. Port the canvas renderer, scrubber, play/restart and
  aspect toggle from listing_reel_studio.html, but drive it from a ReelRecipe instead of
  the hardcoded segments() function. It must:
    - draw each segment's photo with its crop and motion at the scrubbed time
    - draw overlays with the two type systems from rules.json (sans_pill, serif_smallcaps)
    - respect safe_zone_9x16: top 15%, bottom 12%, sides 4%
    - show the segment name and timecode, like your prototype's phase/time readout
  Until D2 exists, build the recipe locally in the browser with a stub that mirrors your
  prototype's segments(): hook 0-2.5, exterior_title to 4.5, interiors split evenly,
  floor plan 4s, exterior return 2s, cta 4s.

REPORT BACK WITH
- Files changed, tsc result, commit hash, Vercel URL, Railway URL
- A screen recording of uploading 25 photos and scrubbing the canvas preview end to end
- /health returning 200 from the Railway URL, called from the deployed Vercel app
```

### PROMPT D2 — The brain

```
Build the brain in /service. Stage D1 accepted.

Prompts from docs/property-reel-brain-v1.md section 2. Schemas from shared/schemas.json.
Every node validates against its schema, retries once with the error appended, then fails
with a named reason. Gemini 2.5 Flash, responseMimeType application/json.

  B0 classify   5 photos per call at 512px. Full PhotoAsset: room_class, scores, features,
                flags (people, vehicles, staging, watermark), safe_crop_9x16, hook_candidate,
                dedupe_key. Also phash on upload.
  dedupe        phash hamming < 6, then identical dedupe_key. Keep the best composition
                score. Losers keep excluded_reason. Never delete.
  B1 truth      facts verbatim, observed items with photo ids, 3 to 5 specials, never_claim,
                provable_numbers, compliance_context
  B2 tier       price tier by market band, buyer intent, tone, type_voice, caption density
  B3 format     three distinct formats AND three distinct tiers
  B5 shot list  skeleton_order from rules.json, cap 6 interiors, motion alternating push and
                pull, crops that keep any feature a caption names, exclusions with reasons
  B6 copy x3    title + one factual subtitle per card. REJECT any card containing a number or
                feature without a claims_trace entry pointing at a B1 id
  B7 pacing x3  track from /service/assets/music/tracks.json (bpm, beat_times, intro_end_ms,
                drop_ms). Hook length = intro_end_ms when a drop exists else 2000. First cut
                on drop_ms. Cuts snap: every beat (fast), 4 beats (medium), 8 beats (slow)
  B8 preflight  pure function over rules.json preflight_rules + one phrase-scan call. BLOCK
                stops the job with the rule id

  buildRecipe(B3, B5, B6, B7) -> ReelRecipe[] . Pure function, no model call.

/web: one card per node showing status, model, cost, elapsed, and the payload in an editable
form with Save and Regenerate. Editing marks descendants stale with a visible rebuild cost.
The canvas preview now renders the REAL recipe from B-nodes, not the stub.

REPORT BACK WITH
- The assets table for one job: room_class, scores, flags, dedupe_key, excluded_reason
- B1 and B6 side by side with claims_trace resolving
- Ledger summing to roughly ₹4 for a 30-photo job
- A US job with "great schools, perfect for families" in the features, showing B8 BLOCKing
  it with the rule id
- The canvas preview playing a real generated recipe
```

### PROMPT D3 — Hook and export

```
Build hook generation and ffmpeg export in /service. Stage D2 accepted.

=== HOOK, port docs/hook-v4.mjs exactly ===
Verified pipeline, four attempts to get right. generation_paths.reverse_conceal in
rules.json v1.1 documents why each step exists.
  1. crop the hero to 9:16 BEFORE any model call (16:9 into a 9:16 endpoint wastes 40% of
     paid pixels on black bars)
  2. generateStill: fitted-cover END state, hero as reference
  3. generateClip: Veo 3.1 Lite, 8s, 9:16, 720p, generateAudio false,
     personGeneration dont_allow, image = the REAL hero as first frame,
     lastFrame = the fitted-cover still. NEVER condition only on a still where the building
     is hidden; that produced a completely different house in testing.
  4. reverse, fps=30
  5. cutWindow, default start = duration - length, because the reversed clip ENDS on the real
     photo and that is where the reveal completes
  6. truth lock: crossfade the last 15 frames to the untouched hero. No flag, no toggle
  7. Q1 on the still and Q2 on frames at 33/66/100 percent, per rules.json qa_rules: score the
     property on the FINAL frame only, never treat the theatrical object as a reject, compare
     counts only within a single call. One reroll, then fall back to a free hook.

Free hooks, no model call: blueprint_to_photo (Sobel edges revealed under an expanding mask),
sky_drop (hero over a sky gradient, ease-zoom, lot outline), paper_popup.

=== EXPORT ===
renderReel(recipe) -> mp4, 1080x1920 H.264 30fps.
  Per segment: crop, then zoompan for push/pull, or two-layer fake parallax (photo drawn
  twice, blurred offset copy behind a soft mask) for parallax_lr.
  Transitions with xfade. Never the same transition twice consecutively. whip_blur only on
  the drop.
  Overlays: Pillow renders every card and caption to a PNG sequence, composited with the
  overlay filter. NEVER ffmpeg drawtext; some builds ship without it.
  Floor plan self_draw: threshold the plan, animate a stroke reveal, then fill.
  Audio from the licensed track, plus a silent variant.

POST /jobs/:id/retune   re-runs reverse, cut, overlays and assembly ONLY. Zero model calls.
                        Label it in the UI as free. Keep every retune as a numbered version.

/web: hook cards (concept, why it scored highest, prompts, engine, duration, est cost,
Generate button disabled while preflight BLOCKs), retune sliders, and a version list.

REPORT BACK WITH
- One reel with a paid hook ending on the real photo, disclosure label visible
- A Q1 rejection that genuinely fired, with the reroll succeeding
- Three retunes at different window starts, ledger showing zero extra cost
- Ledger for the paid hook under $0.50
```

### PROMPT D4 — Three reels and export

```
Stage D3 accepted.
  1. Three reels per job: three tiers, three hook concepts, three title systems, three
     transition families. Assets built ONCE and reused. Show me the code proving reuse.
  2. 16:9 derivative and a silent variant per reel from the same recipe using safe_crop_16x9.
  3. Export zip: three 9:16 masters, three 16:9, three silent, captions.txt, and a compliance
     sheet listing every disclosure the reels carry.
  4. Header spend meter reading the ledger, not estimates. Estimator panel showing per-node
     cost, job total, and the $75 retail anchor from cost-model.json.
  5. getDeliveryUrl(render) as the single indirection point for moving to R2 later.

REPORT BACK WITH
- Three reels from one 25-photo listing, visibly different, total ledger under ₹60
- The export zip
- A screen recording of regenerating B4 for reel 2 only: reel 2 rebuilds, 1 and 3 do not
```

---

## 4. Deploy

### Railway (browser, 5 clicks)
New Project → Deploy from GitHub → `reel-studio`.

| Setting | Value |
|---|---|
| Root Directory | `/` |
| Dockerfile Path | `service/Dockerfile` |
| Volume | `/data`, 5 GB |
| Networking | Generate Domain |

Variables:
```
GCP_PROJECT_ID=<your-gcp-project-id>
GCP_LOCATION=us-central1
GCP_SA_JSON_B64=<base64 -i sa.json | tr -d '\n' | pbcopy>
IMAGE_MODEL=gemini-2.5-flash-image
VEO_MODEL=veo-3.1-lite-generate-001
TEXT_MODEL=gemini-2.5-flash
DATA_DIR=/data
GENERATIVE_ENABLED=true
ALLOWED_ORIGIN=<your vercel url, * until you have it>
```

### Vercel
Import `reel-studio` → **Root Directory `web`** → one variable:
```
NEXT_PUBLIC_SERVICE_URL=https://<your-railway-domain>
```
No GCP credentials on Vercel, ever.

---

## 5. Cost per listing, three reels

| | |
|---|---|
| Brain, 20 calls | ₹4 |
| One paid hook (still + QA + Veo 8s + QA, with reroll allowance) | ₹36 |
| Two free hooks | ₹0 |
| Walkthrough, floor plan, CTA, all three reels | ₹0 |
| **Total** | **₹40** |

Retunes are ₹0 forever. Rendy's own partner guidance is $75 for three reels.
