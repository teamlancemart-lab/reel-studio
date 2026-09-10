/**
 * CORS.
 *
 * Vercel gives every preview deploy its own hostname, so a single ALLOWED_ORIGIN
 * breaks every preview the moment it is set. The policy:
 *
 *   1. exact match against ALLOWED_ORIGIN (comma separated, so several are fine)
 *   2. any https://*.vercel.app          — production alias and every preview
 *   3. any http://localhost:<port>       — and 127.0.0.1, for local dev
 *
 * The matched origin is REFLECTED rather than answered with "*", because a wildcard
 * cannot carry credentials and tells us nothing in a log. An unmatched origin gets no
 * CORS header at all: the request still succeeds server-side, the browser refuses to
 * hand the body to the page, which is the correct failure.
 *
 * ALLOWED_ORIGIN="*" keeps the old behaviour of reflecting everything, for the window
 * before the Vercel domain exists.
 */

const VERCEL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i;
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

export function makeOriginMatcher(allowedOrigin = "") {
  const exact = allowedOrigin
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const allowAll = exact.includes("*");

  return function isAllowed(origin) {
    if (!origin) return false;
    const clean = origin.replace(/\/$/, "");
    if (allowAll) return true;
    if (exact.includes(clean)) return true;
    if (VERCEL.test(clean)) return true;
    if (LOCALHOST.test(clean)) return true;
    return false;
  };
}

export function corsMiddleware(allowedOrigin) {
  const isAllowed = makeOriginMatcher(allowedOrigin);

  return function cors(req, res, next) {
    const origin = req.headers.origin;

    if (origin && isAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      // The reflected value varies by request, so caches must key on Origin.
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        req.headers["access-control-request-headers"] || "Content-Type",
      );
      res.setHeader("Access-Control-Max-Age", "86400");
      // 204 even for a disallowed origin: the preflight itself is not a secret, and
      // the missing Allow-Origin header is what stops the real request.
      return res.status(204).end();
    }

    next();
  };
}
