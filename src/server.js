import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { validateVideoUrl } from "./lib/validateUrl.js";
import { run } from "./lib/exec.js";
import { createJob } from "./pipeline.js";
import {
  createUser, getJobForUser, getUsage, getUserByEmail, getUserById,
  listJobsForUser, listPlans, rotateApiKey, setPlan, supabase,
} from "./store.js";
import { requireAdmin, requireUser } from "./auth.js";

// Express 5 forwards errors from async handlers to the error middleware.
const app = express();
// Set TRUST_PROXY (e.g. "1") behind a load balancer so req.ip is the client's IP.
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public")));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Public -----------------------------------------------------------------

app.get("/api/plans", async (_req, res) => res.json(await listPlans()));

/** POST /api/signup { email } -> a free-plan API key (returned once). */
app.post("/api/signup", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: "A valid `email` is required" });
  const { user, apiKey } = await createUser(email, req.ip);
  res.status(201).json({ apiKey, user, usage: await getUsage(user.id), note: "Store this key now; it is not shown again." });
});

// ---- Authenticated (Authorization: Bearer <api key>) -----------------------

app.get("/api/me", requireUser, async (req, res) => {
  res.json({ user: req.user, usage: await getUsage(req.user.id) });
});

app.post("/api/me/rotate-key", requireUser, async (req, res) => {
  res.json({ apiKey: await rotateApiKey(req.user.id), note: "Your previous key no longer works." });
});

/**
 * POST /api/jobs
 * body: { url, targetLanguage = "English", sourceLanguage? }
 * Uses one translation from the monthly quota (refunded if the job fails).
 * Returns 202 with a job id to poll. Add ?wait=true to block until it finishes.
 */
app.post("/api/jobs", requireUser, async (req, res) => {
  const { url, targetLanguage = "English", sourceLanguage } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "`url` is required" });
  if (typeof targetLanguage !== "string" || targetLanguage.length > 50) {
    return res.status(400).json({ error: "`targetLanguage` must be a short string, e.g. \"English\"" });
  }
  if (sourceLanguage != null && !/^[a-z]{2}$/i.test(sourceLanguage)) {
    return res.status(400).json({ error: "`sourceLanguage` must be an ISO-639-1 code, e.g. \"es\"" });
  }

  const safeUrl = await validateVideoUrl(url);
  const { id, done } = await createJob(req.user, {
    url: safeUrl,
    targetLanguage,
    sourceLanguage: sourceLanguage?.toLowerCase() ?? null,
  });

  if (req.query.wait === "true") await done;
  const job = await getJobForUser(id, req.user.id);
  const status = req.query.wait === "true" ? (job.status === "done" ? 200 : 422) : 202;
  res.status(status).location(`/api/jobs/${id}`).json({ ...job, usage: await getUsage(req.user.id) });
});

app.get("/api/jobs", requireUser, async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  res.json(await listJobsForUser(req.user.id, limit));
});

app.get("/api/jobs/:id", requireUser, async (req, res) => {
  const job = /^[0-9a-f-]{36}$/i.test(req.params.id) && (await getJobForUser(req.params.id, req.user.id));
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ---- Admin (Authorization: Bearer $ADMIN_TOKEN) -----------------------------
// Hook a payment provider's webhook up to setPlan() to automate upgrades.

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const user = req.query.email ? await getUserByEmail(String(req.query.email)) : await getUserById(String(req.query.id ?? ""));
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user, usage: await getUsage(user.id) });
});

app.post("/api/admin/users/:id/plan", requireAdmin, async (req, res) => {
  const user = await setPlan(req.params.id, String(req.body?.plan ?? ""));
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user, usage: await getUsage(user.id) });
});

// ---- Ops --------------------------------------------------------------------

app.get("/health", async (_req, res) => {
  const check = (cmd, args) => run(cmd, args, { timeoutMs: 10_000 }).then(() => true, () => false);
  const deps = {
    ytDlp: await check(config.ytDlpPath, ["--version"]),
    ffmpeg: await check(config.ffmpegPath, ["-version"]),
    database: !(await supabase.from("plans").select("id").limit(1)).error,
    transcriptionKey: Boolean(config.transcription.apiKey),
    anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  };
  const ok = deps.ytDlp && deps.ffmpeg && deps.database;
  res.status(ok ? 200 : 503).json({ ok, deps });
});

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
});

app.listen(config.port, () => {
  console.log(`vid-translate listening on http://localhost:${config.port}`);
});
