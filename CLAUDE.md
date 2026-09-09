# Property Reel Studio

Turns 20 to 30 real estate listing photos plus a property address into three finished
vertical reels. Each reel is Hook + Walkthrough + CTA. 9:16 master, 16:9 derivative.

## Read before writing any code
- shared/rules.json      hook bank, formats, tiers, motion vocabulary, banned phrases, preflight rules
- shared/schemas.json    the exact JSON shape every brain node must return
- shared/cost-model.json rates, node token estimates, budget guards
- docs/property-reel-brain-v1.md  the node graph and every prompt
- docs/PHASE-PROMPTS.md  the build order. Do only the stage you were asked for.

## Architecture, non-negotiable
- Cheap-first. Text plans it, a still verifies the frame, a vision call approves the still,
  only then does video run. Errors die at the cheap layer.
- Every brain node has a fixed JSON schema, a status, a cost, a lock and a regenerate.
  Regenerating one node never re-runs its siblings; descendants go stale with a visible
  rebuild cost.
- Interiors are NEVER AI-altered. Real photos with depth parallax, Ken Burns, speed ramps
  and transitions only. This is a hard block, no override.
- Every hook ends with a crossfade to the untouched hero photo (the truth lock). The
  assembly cuts a 2 to 3 second window from the reveal, never the whole clip.
- The asset pool is built ONCE per job and reused by all three reels. If any reel triggers
  new depth computation or new clip generation, stop and flag it.
- All text overlays are canvas-rendered PNG sequences composited by ffmpeg. Never ffmpeg
  drawtext. Every text box stays inside safe_zone_9x16 from rules.json.
- Nothing is ever silently dropped. Every excluded photo, failed clip or skipped shot gets
  a named reason in the database.
- Every model call writes a cost_ledger row BEFORE the caller reports success.
- GENERATIVE_ENABLED gates every paid video call. It stays false until Stage 6.

## Reporting
When a stage is done, show the artefact: the actual video file, the actual query result,
the actual screenshot. "It works" is not evidence. Always report files changed, tsc result
and the commit hash.

## Style
Feature branch only, never main. Migrations applied with a migration call, never db push.
