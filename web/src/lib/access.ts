/**
 * The service's access key. The public service refuses any request that can spend money
 * or change a job without it; reads stay open. It is kept per browser in localStorage and
 * never in the bundle: a NEXT_PUBLIC_ variable would publish it to everyone who loads
 * the page.
 */
const STORAGE_KEY = "reel-studio-access-key";

/** Fallback for a browser that blocks storage: the key lasts for this page only. */
let memory = "";

export function getAccessKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setAccessKey(key: string) {
  memory = key;
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked: memory holds it */
  }
}

/** Headers for a request that writes. Merges with the caller's own. */
export function writeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = getAccessKey();
  return key ? { ...extra, "x-studio-key": key } : extra;
}
