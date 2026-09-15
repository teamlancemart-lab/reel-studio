/**
 * Access key for the public service.
 *
 * With STUDIO_ACCESS_KEY set, every request that can spend money or change a job
 * (anything but GET, HEAD and OPTIONS) must carry the key in the x-studio-key header.
 * Reads stay open, so a shared job link still plays its reels. With the variable unset
 * the service is open, which is how local development runs.
 */
import crypto from "node:crypto";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function accessMiddleware(key) {
  const expected = key ? Buffer.from(key) : null;

  return function access(req, res, next) {
    if (!expected || READ_METHODS.has(req.method)) return next();
    const given = Buffer.from(String(req.headers["x-studio-key"] || ""));
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.status(401).json({ error: "access key required: enter it in the dashboard header" });
  };
}
