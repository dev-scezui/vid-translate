import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { validateVideoUrl } from "./lib/validateUrl.js";
import { run } from "./lib/exec.js";
import { createJob, getJob, serializeJob } from "./pipeline.js";
import { createUser, getUsage, getUserByEmail, getUserById, rotateApiKey, setPlan } from "./accounts.js";
import { ipRateLimit, requireAdmin, requireUser } from "./auth.js";
import { PLANS } from "./plans.js";

const app = express();
// Set TRUST_PROXY (e.g. "1") when running behind a reverse proxy so req.ip is the client's IP.
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public")));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Public -----------------------------------------------------------------

app.get("/api/plans", (_req, res) => res.json(PLANS));

/** POST /api/signup { email } -> a free-plan API key (returned once). */
app.post(
  "/api/signup",
  ipRateLimit({ max: Number(process.env.SIGNUPS_PER_IP_PER_DAY ?? 3), windowMs: 24 * 60 * 60 * 1000 }),
  (req, res, next) => {
    try {
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: "A valid `email` is required" });
      const { user, apiKey } = createUser(email);
      res.status(201).json({ apiKey, user, usage: getUsage(user), note: "Store this key now; it is not shown again." });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Authenticated (Authorization: Bearer <api key>) -----------------------

app.get("/api/me", requireUser, (req, res) => {
  res.json({ user: req.user, usage: getUsage(req.user) });
});

app.post("/api/me/rotate-key", requireUser, (req, res) => {
  res.json({ apiKey: rotateApiKey(req.user.id), note: "Your previous key no longer works." });
});

/**
 * POST /api/jobs
 * body: { url, targetLanguage = "English", sourceLanguage? }
 * Uses one translation from the monthly quota (refunded if the job fails).
 * Returns 202 with a job id to poll. Add ?wait=true to block until it finishes.
 */
app.post("/api/jobs", requireUser, async (req, res, next) => {
  try {
    const { url, targetLanguage = "English", sourceLanguage } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "`url` is required" });
    if (typeof targetLanguage !== "string" || targetLanguage.length > 50) {
      return res.status(400).json({ error: "`targetLanguage` must be a short string, e.g. \"English\"" });
    }
    if (sourceLanguage != null && !/^[a-z]{2}$/i.test(sourceLanguage)) {
      return res.status(400).json({ error: "`sourceLanguage` must be an ISO-639-1 code, e.g. \"es\"" });
    }

    const safeUrl = await validateVideoUrl(url);
    const job = createJob(req.user, { url: safeUrl, targetLanguage, sourceLanguage: sourceLanguage?.toLowerCase() });

    if (req.query.wait === "true") {
      await job.done;
      return res.status(job.status === "done" ? 200 : 422).json({ ...serializeJob(job), usage: getUsage(req.user) });
    }
    res.status(202).location(`/api/jobs/${job.id}`).json({ ...serializeJob(job), usage: getUsage(req.user) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/jobs/:id", requireUser, (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.userId !== req.user.id) {
    return res.status(404).json({ error: "Job not found (jobs expire after an hour)" });
  }
  res.json(serializeJob(job));
});

// ---- Admin (Authorization: Bearer $ADMIN_TOKEN) -----------------------------
// Hook a payment provider's webhook up to setPlan() to automate upgrades.

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const user = req.query.email ? getUserByEmail(String(req.query.email).toLowerCase()) : getUserById(String(req.query.id ?? ""));
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user, usage: getUsage(user) });
});

app.post("/api/admin/users/:id/plan", requireAdmin, (req, res, next) => {
  try {
    if (!getUserById(req.params.id)) return res.status(404).json({ error: "User not found" });
    const user = setPlan(req.params.id, req.body?.plan);
    res.json({ user, usage: getUsage(user) });
  } catch (err) {
    next(err);
  }
});

// ---- Ops --------------------------------------------------------------------

app.get("/health", async (_req, res) => {
  const check = (cmd, args) => run(cmd, args, { timeoutMs: 10_000 }).then(() => true, () => false);
  const deps = {
    ytDlp: await check(config.ytDlpPath, ["--version"]),
    ffmpeg: await check(config.ffmpegPath, ["-version"]),
    transcriptionKey: Boolean(config.transcription.apiKey),
    anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  };
  res.status(deps.ytDlp && deps.ffmpeg ? 200 : 503).json({ ok: deps.ytDlp && deps.ffmpeg, deps });
});

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : err.message,
    ...(err.usage ? { usage: err.usage } : {}),
  });
});

app.listen(config.port, () => {
  console.log(`vid-translate listening on http://localhost:${config.port}`);
});
