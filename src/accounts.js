import crypto from "node:crypto";
import { db } from "./db.js";
import { DEFAULT_PLAN, PLANS, getPlan } from "./plans.js";

const hashKey = (key) => crypto.createHash("sha256").update(key).digest("hex");

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
function nextMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** Create a user and return their API key. The key is shown once; only its hash is stored. */
export function createUser(email, plan = DEFAULT_PLAN) {
  const id = crypto.randomUUID();
  const apiKey = `vt_${crypto.randomBytes(24).toString("base64url")}`;
  try {
    db.prepare("INSERT INTO users (id, email, api_key_hash, plan) VALUES (?, ?, ?, ?)").run(id, email, hashKey(apiKey), plan);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw Object.assign(new Error("An account with that email already exists"), { status: 409 });
    throw err;
  }
  return { user: getUserById(id), apiKey };
}

export function getUserByApiKey(apiKey) {
  return db.prepare("SELECT id, email, plan, created_at FROM users WHERE api_key_hash = ?").get(hashKey(apiKey));
}
export function getUserById(id) {
  return db.prepare("SELECT id, email, plan, created_at FROM users WHERE id = ?").get(id);
}
export function getUserByEmail(email) {
  return db.prepare("SELECT id, email, plan, created_at FROM users WHERE email = ?").get(email);
}

export function setPlan(userId, plan) {
  if (!PLANS[plan]) throw Object.assign(new Error(`Unknown plan "${plan}"`), { status: 400 });
  db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, userId);
  return getUserById(userId);
}

/** Issue a new API key, invalidating the old one. */
export function rotateApiKey(userId) {
  const apiKey = `vt_${crypto.randomBytes(24).toString("base64url")}`;
  db.prepare("UPDATE users SET api_key_hash = ? WHERE id = ?").run(hashKey(apiKey), userId);
  return apiKey;
}

export function getUsage(user) {
  const plan = getPlan(user.plan);
  const { used } = db
    .prepare("SELECT COUNT(*) AS used FROM usage WHERE user_id = ? AND status IN ('pending', 'done') AND created_at >= ?")
    .get(user.id, monthStart());
  const { minutes } = db
    .prepare("SELECT COALESCE(SUM(duration_sec), 0) / 60.0 AS minutes FROM usage WHERE user_id = ? AND status = 'done' AND created_at >= ?")
    .get(user.id, monthStart());
  return {
    plan: user.plan,
    planName: plan.name,
    maxVideoSec: plan.maxVideoSec,
    monthlyTranslations: plan.monthlyTranslations,
    used,
    remaining: Math.max(0, plan.monthlyTranslations - used),
    minutesProcessed: Math.round(minutes * 10) / 10,
    resetsAt: nextMonthStart(),
  };
}

/**
 * Atomically check the quota and reserve one translation for `jobId`.
 * node:sqlite is synchronous, so check + insert cannot interleave with another request.
 */
export function reserveTranslation(user, jobId) {
  const usage = getUsage(user);
  if (usage.remaining <= 0) {
    throw Object.assign(
      new Error(`Monthly limit reached (${usage.monthlyTranslations} translations on the ${usage.planName} plan). Upgrade or wait until ${usage.resetsAt}.`),
      { status: 402, usage },
    );
  }
  db.prepare("INSERT INTO usage (job_id, user_id, status) VALUES (?, ?, 'pending')").run(jobId, user.id);
}

export function completeTranslation(jobId, durationSec) {
  db.prepare("UPDATE usage SET status = 'done', duration_sec = ? WHERE job_id = ?").run(durationSec ?? null, jobId);
}

/** Failed jobs don't count against the quota. */
export function refundTranslation(jobId) {
  db.prepare("UPDATE usage SET status = 'failed' WHERE job_id = ?").run(jobId);
}
