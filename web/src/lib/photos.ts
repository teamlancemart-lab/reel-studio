/**
 * Client-side photo handling: downscale on upload, deterministic bucket split.
 *
 * Downscaling happens in the browser so a 25-photo drop is a few MB over the wire
 * instead of 200. 1600px is the longest edge FULL-SYSTEM-BUILD names for D1.
 */

export type Bucket = "exterior" | "interior" | "floor_plan";

export const BUCKETS: Bucket[] = ["exterior", "interior", "floor_plan"];

export const BUCKET_LABEL: Record<Bucket, string> = {
  exterior: "Exterior",
  interior: "Interiors",
  floor_plan: "Floor plan",
};

export interface StudioPhoto {
  id: string;
  filename: string;
  bucket: Bucket;
  /** Object URL of the downscaled blob; also what the canvas draws. */
  url: string;
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
  img: HTMLImageElement;
}

export const MAX_EDGE = 1600;
export const MIN_PHOTOS = 8;
export const MAX_PHOTOS = 40;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = url;
  });
}

/** Downscale to MAX_EDGE longest edge. Returns the blob and the decoded image. */
export async function downscale(
  file: File,
  maxEdge = MAX_EDGE,
): Promise<{ blob: Blob; img: HTMLImageElement; width: number; height: number }> {
  const sourceUrl = URL.createObjectURL(file);
  let source: HTMLImageElement;
  try {
    source = await loadImage(sourceUrl);
  } finally {
    // The decoded image keeps its own pixels; the object URL is no longer needed.
    URL.revokeObjectURL(sourceUrl);
  }

  const longest = Math.max(source.width, source.height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);

  if (scale === 1) {
    // Already small enough: keep the original bytes rather than re-encoding and
    // losing quality for nothing.
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    return { blob: file, img, width, height };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for downscale");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      "image/jpeg",
      0.9,
    ),
  );
  const img = await loadImage(URL.createObjectURL(blob));
  return { blob, img, width, height };
}

/**
 * D1 bucket split: by filename order, as FULL-SYSTEM-BUILD specifies ("auto-split by
 * filename order for now"). B0 replaces this with real classification in D2.
 *
 * First two go to exterior (hero + return shot), the last goes to floor plan, the rest
 * are interiors. Every assignment is visible and draggable, so a wrong guess costs one
 * drag rather than a re-upload.
 */
export function autoBucket(index: number, total: number): Bucket {
  if (total <= 2) return index === 0 ? "exterior" : "interior";
  if (index < 2) return "exterior";
  if (index === total - 1) return "floor_plan";
  return "interior";
}

export function sortByFilename(files: File[]): File[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
