# reel-studio

Listing photos in, three vertical property reels out.

    stage0/   one-off Vertex smoke test, run before anything else
    shared/   rules.json, schemas.json, cost-model.json  (loaded at boot by web and worker)
    docs/     the brain spec, the research bible, reference anatomies, phase prompts
    web/      Next.js dashboard, deploys to Vercel
    worker/   Node 20 + ffmpeg + python render worker, deploys to Railway

Build order is docs/PHASE-PROMPTS.md. One prompt at a time, check the gate in
docs/EXECUTION-PLAN.md before moving on.
