/**
 * Job store on the /data volume.
 *
 * One directory per job:
 *   <DATA_DIR>/jobs/<jobId>/job.json
 *   <DATA_DIR>/jobs/<jobId>/photos/<name>
 *   <DATA_DIR>/jobs/<jobId>/out/<name>      (renders, from D3)
 *
 * Every event is appended to the job's event log as well as pushed to live SSE
 * subscribers, so a client that connects late replays the whole job rather than
 * joining halfway through and looking broken.
 */
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { config } from "./config.js";

const JOBS_DIR = path.join(config.dataDir, "jobs");
fs.mkdirSync(JOBS_DIR, { recursive: true });

/** jobId -> EventEmitter. Live only; the durable copy is job.events in job.json. */
const buses = new Map();

export const jobDir = (jobId) => path.join(JOBS_DIR, jobId);
export const photosDir = (jobId) => path.join(jobDir(jobId), "photos");
export const outDir = (jobId) => path.join(jobDir(jobId), "out");
const jobFile = (jobId) => path.join(jobDir(jobId), "job.json");

export function newJobId() {
  return crypto.randomUUID();
}

export function createJob(jobId, facts) {
  fs.mkdirSync(photosDir(jobId), { recursive: true });
  fs.mkdirSync(outDir(jobId), { recursive: true });
  const job = {
    jobId,
    createdAt: new Date().toISOString(),
    completedAt: null,
    status: "queued",
    stage: "queued",
    progress: 0,
    facts,
    photos: [],
    /** Nothing is ever silently dropped. Every skipped photo lands here with a reason. */
    excluded: [],
    nodes: {},
    ledger: [],
    artefacts: [],
    events: [],
    failureReason: null,
  };
  writeJob(job);
  return job;
}

export function readJob(jobId) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(jobId), "utf8"));
  } catch {
    return null;
  }
}

export function writeJob(job) {
  const tmp = jobFile(job.jobId) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jobFile(job.jobId));
}

export function listJobs() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs
    .readdirSync(JOBS_DIR)
    .map((id) => readJob(id))
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function bus(jobId) {
  let b = buses.get(jobId);
  if (!b) {
    b = new EventEmitter();
    b.setMaxListeners(50);
    buses.set(jobId, b);
  }
  return b;
}

/**
 * Record an event on the job and push it to subscribers. `mutate` applies the same
 * change to the persisted job so a reload and a live stream agree.
 */
export function emit(jobId, type, data = {}, mutate) {
  const job = readJob(jobId);
  if (!job) return null;
  if (mutate) mutate(job);
  const event = { seq: job.events.length, type, at: new Date().toISOString(), ...data };
  job.events.push(event);
  writeJob(job);
  bus(jobId).emit("event", event);
  return job;
}

export function setStage(jobId, stage, progress, extra = {}) {
  return emit(jobId, "stage", { stage, progress, ...extra }, (job) => {
    job.stage = stage;
    job.progress = progress;
    if (extra.status) job.status = extra.status;
  });
}

export function addLedgerRow(jobId, row) {
  return emit(jobId, "ledger", { row }, (job) => {
    job.ledger.push(row);
  });
}

export function addArtefact(jobId, artefact) {
  return emit(jobId, "artefact", { artefact }, (job) => {
    job.artefacts.push(artefact);
  });
}

export function addExclusion(jobId, photoId, reason) {
  return emit(jobId, "excluded", { photoId, reason }, (job) => {
    job.excluded.push({ photo_id: photoId, reason });
  });
}

export function setNode(jobId, node, payload) {
  return emit(jobId, "node", { node, payload }, (job) => {
    job.nodes[node] = payload;
  });
}

export function fail(jobId, reason) {
  return emit(jobId, "failed", { reason }, (job) => {
    job.status = "failed";
    job.stage = "failed";
    job.failureReason = reason;
    job.completedAt = new Date().toISOString();
  });
}

export function complete(jobId) {
  return emit(jobId, "completed", {}, (job) => {
    job.status = "completed";
    job.stage = "completed";
    job.progress = 1;
    job.completedAt = new Date().toISOString();
  });
}
