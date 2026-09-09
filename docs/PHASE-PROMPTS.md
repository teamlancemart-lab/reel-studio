# Property Reel Studio: Phase Prompts

One prompt per message. Wait for the report, check it against the gate in `EXECUTION-PLAN.md`, then send the next.

Every prompt assumes Claude Code has already read, in this session: `shared/rules.json`, `shared/schemas.json`, `shared/cost-model.json`, and `docs/property-reel-brain-v1.md`. Tell it to read those first if it has not.

---

## PROMPT 1 — Foundation

```
Proceed with Stage 1.

Stack: Next.js 15 App Router in /web deployed on Vercel. Node 20 worker in /worker
deployed on Railway. Supabase for auth, Postgres, Realtime and Storage.
Read shared/schemas.json first; the database tables mirror those node outputs.

DATABASE
1. One migration creating: tenants, jobs, assets, brain_nodes, hooks, clips, renders,
   music_tracks, cost_ledger.
   - jobs: id, tenant_id, address_line, locality, city, region, country, market ('us'|'in'),
     price, currency, beds, baths, area_value, area_unit, area_basis, property_type,
     status_label, agent_name, brokerage, agent_handle, photo_count, reel_count default 3,
     status ('queued'|'claimed'|'processing'|'completed'|'failed'), stage_detail,
     failure_reason, locked_until, attempts, preflight jsonb, created_at, completed_at.
   - assets: id, job_id, storage_path, sort_index, width, height, bytes, phash,
     room_class, room_confidence, scores jsonb, features jsonb, flags jsonb,
     safe_crop_9x16 jsonb, safe_crop_16x9 jsonb, hook_candidate bool, dedupe_key,
     is_hero bool, excluded_reason.
   - brain_nodes: id, job_id, reel_n nullable, node ('B0'..'B8'), version, payload jsonb,
     model, cost_inr, locked bool, stale bool, parent_versions jsonb, generated_at.
     Unique on (job_id, reel_n, node, version).
   - hooks: id, job_id, reel_n, concept_id, generation_path, engine, still_url,
     clip_url, q1 jsonb, q2 jsonb, usable_start_s, usable_end_s, truth_lock_frames,
     status, fallback_from, qc_reason.
   - clips: id, job_id, asset_id, motion_type, motion_preset, storage_path, qc_reason.
   - renders: id, job_id, reel_n, variant_key, aspect, silent bool, storage_path,
     bytes, render_ms, duration_ms.
   - cost_ledger: id, job_id, reel_n, stage, provider, provider_model, units, unit_type,
     cost_usd, cost_inr, status, created_at.
2. Apply it with a single migration call. Never db push.
3. RLS on every table keyed to tenant_id. Storage buckets: uploads (private),
   assets (private), output (private, signed URL only).

WORKER
4. Scaffold /worker on Node 20, Dockerfile with ffmpeg and a Python 3.11 venv already
   installed (Stage 4 needs Python for depth; set it up now, nothing calls it yet).
5. Claim loop: FOR UPDATE SKIP LOCKED, locked_until extended every 30s, max 3 attempts,
   graceful shutdown on SIGTERM for Railway restarts.
6. On claim, log and set status='failed', failure_reason='not_implemented'. No processing yet.
7. A vertex.ts module that reads GCP_SA_JSON_B64, mints an access token with
   google-auth-library, caches it until 5 minutes before expiry, and exposes
   callText(), callVision(), callImage(), callVideo(). Port them from
   docs/vertex-smoke-test.mjs. Every one writes a cost_ledger row before returning.
   callVideo() throws immediately if GENERATIVE_ENABLED is not 'true'.

FRONTEND
8. /studio: drag-drop for 8 to 40 images plus up to 5 floor plans, client-side downscale
   to 2560px longest edge, direct-to-Storage upload into uploads/{tenant}/{job}/.
9. A listing facts form beside it: address, locality, city, region, market, price, beds,
   baths, area value + unit + basis, property type, status, agent name, brokerage, handle.
   Only address and market are required; everything else optional.
10. On submit, create the job row and one asset row per file, then subscribe to the job
    over Supabase Realtime and show status and stage_detail live.
11. /studio/[jobId]: an empty node graph shell, one card per brain node B0 to B8, all
    showing "not run". No logic yet.

REPORT BACK WITH
- Files changed, tsc result, commit hash
- The exact migration SQL
- select count(*) from jobs run as an authenticated browser user, query and result shown
- Terminal capture of the worker claiming a manually inserted job and heartbeating twice
- Screenshot of /studio after a 25-photo upload showing the job row and live status
```

---

## PROMPT 2 — Slideshow MVP, zero model cost

```
Proceed with Stage 2. Stage 1 accepted.

WORKER
1. Implement the real process path. Read shared/rules.json: skeleton_order,
   interior_priority, drop_first, max_interiors, tiers, motion_vocabulary, transitions.
2. Without any model call, build a deterministic shot list: order assets by sort_index,
   assume room classes are unknown, take the first asset as the hero, cap interiors at 6.
   Stage 3 replaces this with the real B5.
3. Render three reels from one asset pool, using the three tiers in rules.json
   (fast 13-16s, medium 18-24s, slow 30-40s). ffmpeg zoompan Ken Burns per shot,
   alternating push and pull, transitions from rules.json with no consecutive repeats.
4. Structure every reel as Hook + Walkthrough + CTA:
   - Hook: the hero photo, slow push, title card over it, 2 to 3s
   - Walkthrough: the interior shots at the tier's per-shot duration
   - Closing: exterior return, then the CTA card, 4 to 5s
5. Overlays are rendered by node-canvas into PNG sequences and composited by ffmpeg.
   Never ffmpeg drawtext. Read type_systems and safe_zone_9x16 from rules.json and keep
   every text box inside the safe zone. Two type systems: sans_pill and serif_smallcaps.
6. Music: one hardcoded placeholder track with a watermark burned into the output,
   because it is not licensed for delivery. Analyse it once with librosa into
   tracks/placeholder.json (bpm, beat_times, intro_end_ms, drop_ms) and snap cuts to
   that grid: every beat on fast, every 4 beats on medium, every 8 on slow.
7. Output 1080x1920 H.264 30fps, one renders row per reel, upload to the output bucket,
   set job status='completed'.

FRONTEND
8. Results grid: three players with per-reel name, duration and download button.

REPORT BACK WITH
- Files changed, tsc result, commit hash
- The three actual MP4s from a real 25-photo listing, played in browser
- The three renders rows with non-null render_ms, bytes and duration_ms
- Wall clock from upload to completed
- Confirmation the watermark is visibly present
```

---

## PROMPT 3 — The brain

```
Proceed with Stage 3. Stage 2 accepted.

Read docs/property-reel-brain-v1.md sections 2 and 3 for the node contracts, and
shared/schemas.json for the exact output shapes. Every node validates against its schema
before it is stored; on a validation failure, retry once with the error appended, then fail
the node with a named reason.

1. Implement runNode(nodeId, jobId, reelN): load inputs by edge, render the prompt from
   the template, call the routed model with response_mime_type application/json, validate
   against the schema, write a brain_nodes row and a cost_ledger row, mark descendants stale.
   Model routing from shared/cost-model.json brain_nodes.
2. B0 photo classification: 5 photos per call, downscaled to 512px before sending.
   Populate every PhotoAsset field including flags, both safe crops, hook_candidate and
   dedupe_key. Also compute phash on upload.
3. Dedupe twice: phash hamming < 6 → excluded_reason='duplicate_of_asset_{id}';
   then same dedupe_key → keep the highest composition score,
   excluded_reason='duplicate_room_of_asset_{id}'. Never delete a row.
4. B1 listing truth and B2 tier and persona and B3 format selection, per the spec.
   B3 must return three distinct formats and three distinct tiers.
5. B5 shot list replacing the Stage 2 deterministic version: real room classes,
   skeleton_order, cap 6 interiors, crops that keep any feature a caption will name,
   and an exclusions array with a reason per dropped photo.
6. B6 copy per reel. Reject the output if any card contains a number or feature without a
   claims_trace entry pointing at a B1 id. B7 music and pacing per reel.
7. B8 pre-flight: a pure function over shared/rules.json preflight_rules plus one phrase
   scan call. Runs before any paid call and before export. BLOCK sets job.failure_reason;
   WARN is stored and shown with an override that records who and when.
8. Wire the assembly to consume B5, B6 and B7 instead of the Stage 2 defaults.

FRONTEND
9. Each brain node renders as a card: status, model, cost, generated_at, the JSON payload
   in an editable form, a Regenerate button and a Lock toggle. Stale nodes show a badge
   and the rebuild cost. Editing a field marks the node edited and its descendants stale.

REPORT BACK WITH
- Files changed, tsc result, commit hash
- The full assets table for one job: room_class, scores, flags, dedupe_key, excluded_reason
- The B1 and B6 payloads side by side, with the claims_trace resolving
- select stage, provider_model, cost_inr from cost_ledger where job_id='...' summing to
  roughly ₹4
- A US job with "great schools, perfect for families" in the features text, showing B8
  blocking it with the rule id
- A rendered reel that now opens on the exterior and follows the real room order
```

---

## PROMPT 4 — Depth parallax

```
Proceed with Stage 4. Stage 3 accepted.

1. Add Depth Anything V2 Small (ONNX) to the worker image at build time. Never download at
   job time. Preload at boot, warm on deploy.
2. Depth-layer parallax renderer: slice each photo's depth map into 6 layers, move a virtual
   camera along the preset path from rules.json motion_vocabulary for that room class,
   render frames, fill disocclusion by edge-extending the nearest layer. 1080x1920, 30fps.
3. Flat-depth guard: if p95 minus p5 of the depth map is below threshold, fall back to
   zoompan and log qc_reason='flat_depth' on the clips row.
4. Direction alternates: no two consecutive shots share push or pull.
5. Every clip stored in clips with motion_type and motion_preset. Clips are built ONCE per
   job and reused by all three reels. Show me the function where that reuse happens.
6. Wire all three reels to use these clips.

REPORT BACK WITH
- Files changed, tsc result, commit hash
- Two videos of the SAME listing, one from Stage 2 and one from Stage 4. Do not tell me it
  looks better, show me both files
- Median depth computation time per photo across the set
- One asset that genuinely triggered flat_depth, with qc_reason visible in the row
- The exact code location proving clip reuse across the three reels
```

---

## PROMPT 5 — Free hooks and title systems. GO/NO-GO STAGE

```
Proceed with Stage 5. Stage 4 accepted.

Read shared/rules.json hook_bank. This stage implements only the concepts whose
default_path is free_2p5d. No model calls. GENERATIVE_ENABLED stays false.

1. blueprint_to_photo: edge-detect the hero exterior, animate the line drawing appearing
   stroke by stroke, then crossfade to the real photo. Reference: the Mochi template.
2. sky_drop: cut the house from the top-down aerial (or the hero if no aerial), pin it
   centre frame, ease-zoom from a high altitude down to the lot, fade in a lot outline
   polygon, land it, cut to the exterior on the music drop. Reference: the Alright template.
3. paper_popup_room: depth layers of a living or kitchen photo fold open like a pop-up
   book and settle into the flat photo.
4. dollhouse_plan_to_house: extrude the uploaded floor plan into an isometric view in SVG,
   hold 1.5s, crossfade to the real exterior. Only when a floor_plan asset exists.
5. Truth lock on all four: the last 12 to 20 frames crossfade to the untouched hero photo.
   The assembly cuts a 2 to 3 second usable window, never the whole animation.
6. Title systems from rules.json: price_stack, status_card, address_only, search_intent,
   number_first. Implement all five as canvas PNG sequences. search_intent types the string
   word by word. address_only uses a letter-scramble reveal.
7. Hook selection: B4 scores the free concepts only and picks a different one per reel.
8. Disclosure: free hooks render an "Animated" corner label, minimum 28px tall at 1080 wide,
   for the hook duration. No toggle.

REPORT BACK WITH
- Files changed, tsc result, commit hash
- Three reels from one listing with three different free hooks, three different tiers and
  at least two different title systems
- Frame captures proving each hook's last frame is the untouched hero photo
- cost_ledger for the hook rows showing zero
- The three files, so I can put them next to the Rendy reference reels
```

**Stop here. Send me the three reels before Stage 6.**

---

## PROMPT 6 — Paid Veo hook

```
Proceed with Stage 6. Stage 5 accepted and the free hooks were judged good enough to
build on.

Set GENERATIVE_ENABLED=true on Railway. MOTION_PROVIDER=vertex.

1. Implement the still_then_clip path for helicopter_drape, earth_to_doorstep, block_build
   and dollhouse per rules.json hook_bank, using the prompts B4 produces.
2. H1: Nano Banana still with the hero photo as reference, still_prompt plus
   rules.json qa_prompt_negative_block as the negative. Store still_url.
3. Q1: vision call comparing the still to the hero. Count floors, front windows, doors and
   balconies, check the roof line, and run the full qa_reject_list. Any mismatch fails.
   On failure, regenerate H1 once with the Q1 diff appended. Second failure escalates to
   B4.fallback_concept.
4. H2: Veo 3.1 Lite via Vertex, image-to-video from the approved still, 9:16, 720p,
   generateAudio false, personGeneration dont_allow, duration from
   cost-model.json hook_duration_by_concept_s. Poll the long-running operation.
5. Q2: sample frames at 33, 66 and 100 percent. Frame 0 is the input still, do not score it.
   Same counts and reject list, plus does the last frame match the hero within the truth-lock
   window. Two failures substitute the free hook with fallback_from and qc_reason set.
6. Truth lock: crossfade the final 15 frames to the untouched hero. Assembly cuts the
   usable window B4 specified.
7. Disclosure: paid hooks render "AI-generated reveal" for the hook window, and the CTA card
   gains the altered-image line with the originals URL. No toggle.
8. Budget guard: read cost-model.json guards. Warn above $1.50 per listing, block above
   $3.00, max one reroll per hook, fall back to free on second failure.
9. Kill switch test: with GENERATIVE_ENABLED=false the job must complete with free hooks,
   no partial failures, no broken UI.

REPORT BACK WITH
- Files changed, tsc result, commit hash
- One reel with a paid drape hook, ending on the real photo, disclosure visible
- A Q1 rejection that genuinely fired on a wrong window count, with the reroll succeeding
- cost_ledger for that hook: still, Q1, clip, Q2, totalling under $0.50
- The GENERATIVE_ENABLED=false run behaving identically to Stage 5
```

---

## PROMPT 7 — Productise

```
Proceed with Stage 7. Stage 6 accepted.

1. Header spend meter reading cost_ledger sums where status='succeeded'. Estimates show
   greyed until the real entry lands.
2. Pre-generate estimator panel: per-node estimated cost, job total, and the $75 retail
   anchor line from cost-model.json market_anchors.
3. Per-node regenerate that never re-runs siblings. Descendants go stale with a visible
   rebuild cost. Locked nodes are skipped and badged "locked, may be inconsistent".
4. 16:9 derivative and a silent-audio variant per reel from the same recipe using
   safe_crop_16x9. Extra renders rows, no new clips.
5. Export: a zip with three 9:16 masters, three 16:9 derivatives, three silent variants,
   the post captions as a text file, and a compliance sheet listing every disclosure the
   reels carry.
6. Move output delivery behind a single getDeliveryUrl(render) function, still pointing at
   Supabase Storage. This is what swaps to R2 later without touching calling code.
7. Cost dashboard: cost per job, per stage, per tenant, with margin against the retail
   anchor, over real historical jobs.

REPORT BACK WITH
- Files changed, tsc result, commit hash
- A screen recording of regenerating B4 for reel 2 only: reel 2 rebuilds, reels 1 and 3 do
  not, and the rebuild cost was shown before it ran
- The export zip
- The cost dashboard across at least 10 real jobs
```

---

## Check after every prompt, regardless of number

1. Did it show the artefact, or only describe it?
2. Does cost_ledger have real non-zero rows for anything that should have cost money?
3. Did anything get silently dropped instead of getting a named reason?
4. Is every text box inside safe_zone_9x16?
5. Does every hook end on the untouched hero photo?
6. Did it touch main, or only the feature branch?
