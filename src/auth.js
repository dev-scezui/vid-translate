import crypto from "node:crypto";
import { getUserByApiKey } from "./accounts.js";

function bearer(req) {
  const h = req.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : req.get("x-api-key");
}

/** Require a valid user API key; sets req.user. */
export function requireUser(req, res, next) {
  const key = bearer(req);
  const user = key && getUserByApiKey(key);
  if (!user) return res.status(401).json({ error: "Missing or invalid API key. Sign up at POST /api/signup." });
  req.user = user;
  next();
}

/** Require the ADMIN_TOKEN from the environment. */
export function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  const got = bearer(req) ?? "";
  const ok =
    expected &&
    got.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: "Admin token required" });
  next();
}

/** Tiny fixed-window per-IP limiter, enough to slow down signup spam on a single instance. */
export function ipRateLimit({ max, windowMs }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) ?? 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: "Too many requests, try again later" });
    next();
  };
}
