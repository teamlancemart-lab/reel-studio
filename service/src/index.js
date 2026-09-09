/**
 * Railway render service. D1 surface:
 *
 *   GET  /health                  liveness + what the container actually has
 *   POST /jobs                    multipart photos[] + facts JSON -> { jobId }
 *   GET  /jobs                    recent jobs
 *   GET  /jobs/:id                full job JSON
 *   GET  /jobs/:id/events         SSE: stage, progress, node payloads, ledger, artefacts
 *   GET  /jobs/:id/file/:name     streams an artefact
 *
 * The GCP service-account key lives here and only here. /web never sees it.
 */
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { config, versions, rules } from "./config.js";
import {
  newJobId,
  createJob,
  readJob,
  writeJob,
  listJobs,
  bus,
  photosDir,
  jobDir,
} from "./store.js";
import { runJobDetached } from "./pipeline.js";
import { ledgerTotals } from "./ledger.js";
import { ffmpegVersion, pythonStatus, fontStatus } from "./lib/media.js";
import { vertexStatus } from "./lib/vertex.js";

const app = express();
app.disable("x-powered-by");

app.use(
  cors({
    origin: config.allowedOrigin === "*" ? true : config.allowedOrigin.split(","),
    methods: ["GET", "POST", "OPTIONS"],
  }),
);
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: config.maxPhotos },
});

/* --------------------------------------------------------------- health */

app.get("/health", async (_req, res) => {
  const [ffmpeg, python] = await Promise.all([ffmpegVersion(), pythonStatus()]);
  const fonts = fontStatus();
  res.json({
    ok: true,
    service: "reel-studio-service",
    stage: "D1",
    uptimeS: Math.round(process.uptime()),
    node: process.version,
    dataDir: config.dataDir,
    dataDirWritable: isWritable(config.dataDir),
    shared: versions,
    ffmpeg,
    python,
    fonts,
    vertex: vertexStatus(),
  });
});

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The rules the browser canvas needs so it does not carry its own copy of the truth. */
app.get("/rules", (_req, res) => {
  res.json({
    version: rules.version,
    type_systems: rules.type_systems,
    safe_zone_9x16: rules.safe_zone_9x16,
    tiers: rules.tiers,
    transitions: rules.transitions,
    motion_vocabulary: rules.motion_vocabulary,
    job_defaults: rules.job_defaults,
  });
});

/* ----------------------------------------------------------------- jobs */

app.post("/jobs", upload.array(config.uploadFieldName, config.maxPhotos), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res
      .status(400)
      .json({ error: `no files. Send multipart field "${config.uploadFieldName}"` });
  }

  let facts = {};
  if (req.body?.facts) {
    try {
      facts = JSON.parse(req.body.facts);
    } catch (err) {
      return res.status(400).json({ error: `facts is not valid JSON: ${err.message}` });
    }
  }

  /* Bucket assignment. The client sends its own split (exterior / interior /
     floor_plan) because the user can drag photos between buckets; if it does not,
     everything lands in "unsorted" and B0 classifies it in D2. Never guessed silently. */
  let buckets = {};
  if (req.body?.buckets) {
    try {
      buckets = JSON.parse(req.body.buckets);
    } catch {
      buckets = {};
    }
  }

  const jobId = newJobId();
  const job = createJob(jobId, facts);

  files.forEach((file, i) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const id = `p${String(i + 1).padStart(3, "0")}`;
    const storedName = `${id}${ext.toLowerCase()}`;
    fs.writeFileSync(path.join(photosDir(jobId), storedName), file.buffer);
    job.photos.push({
      id,
      filename: file.originalname,
      storedName,
      bucket: buckets[file.originalname] || buckets[String(i)] || "unsorted",
      sortIndex: i,
      bytes: file.size,
      mimeType: file.mimetype,
      width: null,
      height: null,
      excluded_reason: null,
    });
  });
  writeJob(job);

  res.status(202).json({
    jobId,
    photoCount: job.photos.length,
    events: `/jobs/${jobId}/events`,
    job: `/jobs/${jobId}`,
  });

  runJobDetached(jobId);
});

app.get("/jobs", (_req, res) => {
  res.json(
    listJobs()
      .slice(0, 50)
      .map((j) => ({
        jobId: j.jobId,
        status: j.status,
        stage: j.stage,
        progress: j.progress,
        photoCount: j.photos.length,
        createdAt: j.createdAt,
        ledger: ledgerTotals(j.ledger),
      })),
  );
});

app.get("/jobs/:id", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  res.json({ ...job, ledgerTotals: ledgerTotals(job.ledger) });
});

/* ------------------------------------------------------------------ SSE */

app.get("/jobs/:id/events", (req, res) => {
  const jobId = req.params.id;
  const job = readJob(jobId);
  if (!job) return res.status(404).json({ error: "no such job" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay first: a client that connects after the job finished still sees the whole
  // job rather than an empty stream.
  const from = Number(req.query.from ?? 0);
  for (const event of job.events.slice(from)) send(event);

  if (job.status === "completed" || job.status === "failed") {
    send({ type: "eof", at: new Date().toISOString() });
    return res.end();
  }

  const onEvent = (event) => {
    send(event);
    if (event.type === "completed" || event.type === "failed") {
      send({ type: "eof", at: new Date().toISOString() });
      res.end();
    }
  };
  bus(jobId).on("event", onEvent);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    bus(jobId).off("event", onEvent);
  });
});

/* -------------------------------------------------------------- artefacts */

app.get("/jobs/:id/file/:name", (req, res) => {
  const jobId = req.params.id;
  if (!readJob(jobId)) return res.status(404).json({ error: "no such job" });

  // Resolve inside the job directory and refuse anything that escapes it.
  const name = path.basename(req.params.name);
  const root = jobDir(jobId);
  const candidates = [
    path.join(photosDir(jobId), name),
    path.join(root, "out", name),
  ];
  const hit = candidates.find(
    (p) => p.startsWith(root + path.sep) && fs.existsSync(p),
  );
  if (!hit) return res.status(404).json({ error: "no such file" });

  res.sendFile(hit);
});

/* ------------------------------------------------------------------ boot */

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "internal error" });
});

const server = app.listen(config.port, () => {
  console.log(
    `reel-studio-service listening on :${config.port}\n` +
      `  data      ${config.dataDir}\n` +
      `  shared    rules v${versions.rules}, cost-model v${versions.costModel}\n` +
      `  generative ${config.generativeEnabled ? "ENABLED" : "disabled (paid video gated)"}`,
  );
});

// Railway restarts containers; finish in-flight responses before dying.
process.on("SIGTERM", () => {
  console.log("SIGTERM, closing");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
