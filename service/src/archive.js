/**
 * Archived jobs: work made before the service kept its jobs.
 *
 * The D2 to D5 runs happened on a local service whose data directory was deleted with
 * the session, so their job records, node outputs and ledgers are gone. What survived
 * (finished reels, hook tests, still sheets, the listing photos and facts) is imported
 * as an archived job, so it can be reviewed next to live jobs and duplicated into a real
 * run. An archived job never claims what it does not have: it has no nodes and no ledger
 * rows, and every lost run is named in archived.lost.
 *
 *   POST /archive   multipart files[] + manifest JSON -> { jobId }
 *
 * Re-importing the same archiveId replaces that archive instead of adding a second copy.
 */
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { createJob, jobDir, outDir, photosDir, readJob, writeJob } from "./store.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024, files: 80 },
});

const ITEM_KINDS = new Set(["reel", "hook_test", "comparison", "still_sheet"]);
const ARCHIVE_ID = /^[a-z0-9][a-z0-9-]{1,60}$/;

export function mountArchive(app) {
  app.post("/archive", upload.array("files", 80), (req, res) => {
    let manifest;
    try {
      manifest = JSON.parse(req.body?.manifest || "");
    } catch (err) {
      return res.status(400).json({ error: `manifest is not valid JSON: ${err.message}` });
    }

    const { archiveId, title, note } = manifest;
    if (!ARCHIVE_ID.test(archiveId || "")) return res.status(400).json({ error: "archiveId must be lowercase letters, digits and dashes" });
    if (!title || !note) return res.status(400).json({ error: "manifest needs a title and a note saying what was lost" });

    const items = manifest.items || [];
    const photos = manifest.photos || [];
    const badKind = items.find((i) => !ITEM_KINDS.has(i.kind));
    if (badKind) return res.status(400).json({ error: `unknown item kind "${badKind.kind}"` });

    const files = new Map((req.files || []).map((f) => [f.originalname, f]));
    const missing = [...items.map((i) => i.file), ...photos].filter((name) => !files.has(name));
    if (missing.length) return res.status(400).json({ error: `manifest names files that were not sent: ${missing.join(", ")}` });

    const jobId = `archive-${archiveId}`;
    const existing = readJob(jobId);
    if (existing && existing.status !== "archived") return res.status(409).json({ error: `${jobId} exists and is not an archive` });
    if (existing) fs.rmSync(jobDir(jobId), { recursive: true, force: true });

    const job = createJob(jobId, manifest.facts || {});
    job.createdAt = manifest.createdAt || job.createdAt;
    job.completedAt = new Date().toISOString();
    job.status = "archived";
    job.stage = "archived";
    job.progress = 1;

    photos.forEach((name, i) => {
      const file = files.get(name);
      const id = `p${String(i + 1).padStart(3, "0")}`;
      const storedName = `${id}${path.extname(name).toLowerCase() || ".jpg"}`;
      fs.writeFileSync(path.join(photosDir(jobId), storedName), file.buffer);
      job.photos.push({
        id,
        filename: name,
        storedName,
        bucket: "unsorted",
        sortIndex: i,
        bytes: file.size,
        mimeType: file.mimetype,
        width: null,
        height: null,
        excluded_reason: null,
      });
    });

    job.archived = {
      title,
      note,
      imported_at: job.completedAt,
      sources: manifest.sources || [],
      lost: manifest.lost || [],
      items: items.map((item) => {
        const file = files.get(item.file);
        const name = path.basename(item.file);
        fs.writeFileSync(path.join(outDir(jobId), name), file.buffer);
        return {
          kind: item.kind,
          file: name,
          title: item.title,
          note: item.note ?? null,
          made_at: item.madeAt ?? null,
          bytes: file.size,
        };
      }),
    };
    writeJob(job);
    res.status(201).json({ jobId, items: job.archived.items.length, photos: job.photos.length });
  });
}
