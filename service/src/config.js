import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVICE_ROOT = path.resolve(here, "..");

/**
 * /shared is copied to /app/shared in the container and sits at ../shared in the repo.
 * Both deployables read the SAME files; this resolves whichever layout we are in.
 */
function resolveSharedDir() {
  const candidates = [
    process.env.SHARED_DIR,
    path.join(SERVICE_ROOT, "shared"),
    path.resolve(SERVICE_ROOT, "..", "shared"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "rules.json"))) return c;
  }
  throw new Error(
    `shared/rules.json not found. Looked in:\n  ${candidates.join("\n  ")}`,
  );
}

export const SHARED_DIR = resolveSharedDir();

const readShared = (name) =>
  JSON.parse(fs.readFileSync(path.join(SHARED_DIR, name), "utf8"));

export const rules = readShared("rules.json");
export const schemas = readShared("schemas.json");
export const costModel = readShared("cost-model.json");

export const config = {
  port: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR || path.join(SERVICE_ROOT, "data"),
  fontsDir: process.env.FONTS_DIR || path.join(SERVICE_ROOT, "assets", "fonts"),
  pythonBin: process.env.PYTHON_BIN || "/opt/venv/bin/python3",
  allowedOrigin: process.env.ALLOWED_ORIGIN || "*",

  gcpProjectId: process.env.GCP_PROJECT_ID || "",
  gcpLocation: process.env.GCP_LOCATION || "us-central1",
  gcpSaJsonB64: process.env.GCP_SA_JSON_B64 || "",
  textModel: process.env.TEXT_MODEL || "gemini-2.5-flash",
  textLiteModel: process.env.TEXT_LITE_MODEL || "gemini-2.5-flash-lite",
  imageModel: process.env.IMAGE_MODEL || "gemini-2.5-flash-image",
  veoModel: process.env.VEO_MODEL || "veo-3.1-lite-generate-001",

  /** The paid-video gate. Exactly the string "true" opens it. Stays shut until Stage 6. */
  generativeEnabled: process.env.GENERATIVE_ENABLED === "true",

  /** Interior motion. "2.5d" (default, compliance-strict: real stills, parallax and Ken
   *  Burns) or exactly "veo": approved, labelled Veo camera glides on up to three hero
   *  interiors. Paid clips still need GENERATIVE_ENABLED as well. */
  interiorMotion: process.env.INTERIOR_MOTION === "veo" ? "veo" : "2.5d",

  maxPhotos: 40,
  minPhotos: 8,
  uploadFieldName: "photos",
};

fs.mkdirSync(config.dataDir, { recursive: true });

export const versions = {
  rules: rules.version,
  schemas: schemas.$id,
  costModel: costModel.version,
};
