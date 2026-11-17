import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

/**
 * Data access for users, plans and jobs, backed by Supabase (Postgres).
 * Uses the service-role key, so this must only ever run server-side.
 * Quota checks and signup limits run inside Postgres functions (see
 * supabase/migrations) so they stay correct with any number of app servers.
 */

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see README: Supabase setup)");
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const USER_COLUMNS = "id, email, plan, created_at";
const JOB_COLUMNS = "id, status, input, video, duration_sec, error, created_at, finished_at";

/** Turn a Supabase/PostgREST error into an Error with an HTTP status. */
function fail(error) {
  // Our SQL functions raise SQLSTATE 'PTxyz' to mean HTTP status xyz.
  let status = 500;
  if (/^PT\d{3}$/.test(error.code ?? "")) status = Number(error.code.slice(2));
  else if (error.code === "23503") status = 400; // foreign key, e.g. unknown plan
  throw Object.assign(new Error(error.message), { status, code: error.code });
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) fail(error);
  return data;
}

export const hashKey = (apiKey) => crypto.createHash("sha256").update(apiKey).digest("hex");
const newApiKey = () => `vt_${crypto.randomBytes(24).toString("base64url")}`;

// ---- Plans -----------------------------------------------------------------

export const listPlans = () =>
  q(supabase.from("plans").select("id, name, max_video_sec, monthly_translations, stripe_price_id").order("sort"));

// ---- Users -----------------------------------------------------------------

/** Create a user and return their API key (shown once; only the hash is stored). */
export async function createUser(email, ip) {
  const apiKey = newApiKey();
  const user = await q(
    supabase.rpc("create_user", {
      p_email: email,
      p_api_key_hash: hashKey(apiKey),
      p_ip: ip ?? null,
      p_max_per_ip: Number(process.env.SIGNUPS_PER_IP_PER_DAY ?? 3),
    }),
  );
  return { user: { id: user.id, email: user.email, plan: user.plan, created_at: user.created_at }, apiKey };
}

export const getUserByApiKey = (apiKey) =>
  q(supabase.from("users").select(USER_COLUMNS).eq("api_key_hash", hashKey(apiKey)).maybeSingle());

export const getUserById = (id) =>
  q(supabase.from("users").select(USER_COLUMNS).eq("id", id).maybeSingle());

export const getUserByEmail = (email) =>
  q(supabase.from("users").select(USER_COLUMNS).eq("email", email.toLowerCase()).maybeSingle());

export const setPlan = (userId, plan) =>
  q(supabase.from("users").update({ plan }).eq("id", userId).select(USER_COLUMNS).maybeSingle());

export async function rotateApiKey(userId) {
  const apiKey = newApiKey();
  await q(supabase.from("users").update({ api_key_hash: hashKey(apiKey) }).eq("id", userId));
  return apiKey;
}

export const getUsage = (userId) => q(supabase.rpc("get_usage", { p_user_id: userId }));

// ---- Jobs ------------------------------------------------------------------

/**
 * Check the user's quota and insert a queued job in one transaction.
 * Throws status 402 when the monthly limit is used up.
 * @returns {Promise<{planName: string, maxVideoSec: number}>}
 */
export const reserveJob = (userId, jobId, input) =>
  q(supabase.rpc("reserve_job", { p_user_id: userId, p_job_id: jobId, p_input: input }));

export const updateJob = (id, patch) =>
  q(supabase.from("jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id));

export const getJobForUser = (id, userId) =>
  q(supabase.from("jobs").select(JOB_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle());

export const listJobsForUser = (userId, limit = 20) =>
  q(supabase.from("jobs").select(JOB_COLUMNS).eq("user_id", userId).order("created_at", { ascending: false }).limit(limit));

/** Fail (and so refund) jobs whose server died mid-run. Safe to call from every instance. */
export const failStaleJobs = () => q(supabase.rpc("fail_stale_jobs"));

// ---- Billing -----------------------------------------------------------------

const BILLING_COLUMNS = "id, email, plan, stripe_customer_id, stripe_subscription_id, subscription_status";

export const getBillingUser = (id) =>
  q(supabase.from("users").select(BILLING_COLUMNS).eq("id", id).maybeSingle());

export const getPlanById = (id) =>
  q(supabase.from("plans").select("id, name, stripe_price_id").eq("id", id).maybeSingle());

/** Save the Stripe customer id unless one is already set; returns the stored id. */
export async function saveStripeCustomer(userId, customerId) {
  await q(supabase.from("users").update({ stripe_customer_id: customerId }).eq("id", userId).is("stripe_customer_id", null));
  return (await getBillingUser(userId)).stripe_customer_id;
}

/** Apply a Stripe subscription's current state to its user (sets the plan). */
export const applySubscription = (s) =>
  q(
    supabase.rpc("apply_subscription", {
      p_user_id: s.userId ?? null,
      p_customer_id: s.customerId,
      p_subscription_id: s.subscriptionId,
      p_status: s.status,
      p_price_id: s.priceId ?? null,
      p_period_end: s.periodEnd ?? null,
      p_cancel_at_period_end: s.cancelAtPeriodEnd ?? false,
    }),
  );
