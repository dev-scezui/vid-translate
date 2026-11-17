import crypto from "node:crypto";
import { getUserByApiKey } from "./store.js";

function bearer(req) {
  const h = req.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : req.get("x-api-key");
}

/** Require a valid user API key; sets req.user. */
export async function requireUser(req, res, next) {
  try {
    const key = bearer(req);
    const user = key && (await getUserByApiKey(key));
    if (!user) return res.status(401).json({ error: "Missing or invalid API key. Sign up at POST /api/signup." });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
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
