import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { validateVideoUrl } from "./lib/validateUrl.js";
import { run } from "./lib/exec.js";
import { createJob } from "./pipeline.js";
import { FORMATS } from "./lib/subtitles.js";
import {
  createUser, getJobForUser, getUsage, getUserByEmail, getUserById,
  listJobsForUser, rotateApiKey, setPlan, supabase,
  deleteHistory, getHistoryItem, listHistory,
} from "./store.js";
import { requireAdmin, requireUser } from "./auth.js";
import { billingRouter } from "./billing.js";

// Express 5 forwards errors from async handlers to the error middleware.
const app = express();
// Set TRUST_PROXY (e.g. "1") behind a load balancer so req.ip is the client's IP.
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
// Billing first: the Stripe webhook must see the raw, unparsed body.
app.use(billingRouter);
app.use(express.json({ limit: "16kb" }));
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, "..", "public")));
// The browser builds subtitle files with the same code the server uses.
app.get("/lib/subtitles.js", (_req, res) => res.type("text/javascript").sendFile(path.join(here, "lib", "subtitles.js")));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Public -----------------------------------------------------------------

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

const TRACKS = new Set(["translation", "original", "bilingual"]);

function fileName(result, ext, track) {
  const base = (result.video?.title ?? "video").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "video";
  const suffix = track === "original" ? result.sourceLanguage ?? "original" : track === "bilingual" ? "bilingual" : result.targetLanguage;
  return `${base}.${String(suffix).toLowerCase().replace(/[^\w-]/g, "")}.${ext}`;
}

/**
 * POST /api/jobs
 * body: { url, targetLanguage = "English", sourceLanguage? }
 *
 * Results are not stored, so they come back on this request:
 *  - Accept: text/event-stream -> Server-Sent Events: `job`, `status`, then `result` or `error`
 *  - otherwise waits and returns JSON { id, video, sourceLanguage, targetLanguage, segments }
 *  - ?format=srt|vtt|txt -> waits and returns that subtitle file as a download
 *    (&track=translation|original|bilingual, default translation)
 * Uses one translation from the monthly quota; refunded if the job fails or the client disconnects.
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
  const format = req.query.format ? String(req.query.format) : null;
  const track = String(req.query.track ?? "translation");
  if (format && !FORMATS[format]) return res.status(400).json({ error: "`format` must be srt, vtt or txt" });
  if (!TRACKS.has(track)) return res.status(400).json({ error: "`track` must be translation, original or bilingual" });
  const sse = !format && (req.get("accept") ?? "").includes("text/event-stream");

  const safeUrl = await validateVideoUrl(url);

  // Cancel the job (and refund it) if the client goes away before the result is sent.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  // Events raised before the stream opens (e.g. "fetching_info") are held and sent once it does.
  let streaming = false;
  const pending = [];
  const send = (event, data) => {
    if (!streaming) return void pending.push([event, data]);
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const { id, result } = await createJob(
    req.user,
    { url: safeUrl, targetLanguage, sourceLanguage: sourceLanguage?.toLowerCase() ?? null },
    { signal: abort.signal, onStatus: (status, meta) => sse && send("status", { status, video: meta?.video }) },
  );

  if (sse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no", // don't let nginx buffer the stream
    });
    streaming = true;
    send("job", { id, usage: await getUsage(req.user.id) });
    for (const [event, data] of pending.splice(0)) send(event, data);
    const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000); // keeps proxies from timing out
    try {
      send("result", await result);
    } catch (err) {
      send("error", { error: err.message });
    } finally {
      clearInterval(ping);
      if (!res.writableEnded) {
        send("usage", await getUsage(req.user.id).catch(() => null));
        res.end();
      }
    }
    return;
  }

  let out;
  try {
    out = await result;
  } catch (err) {
    return res.status(422).json({ id, error: err.message, usage: await getUsage(req.user.id) });
  }
  if (format) {
    const f = FORMATS[format];
    res.attachment(fileName(out, f.ext, track)).type(`${f.mime}; charset=utf-8`);
    return res.send(f.render(out.segments, track));
  }
  res.json({ ...out, usage: await getUsage(req.user.id) });
});

app.get("/api/jobs", requireUser, async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  res.json(await listJobsForUser(req.user.id, limit));
});

/** Job metadata only (status, video, timing). Transcripts and translations are never stored. */
app.get("/api/jobs/:id", requireUser, async (req, res) => {
  const job = /^[0-9a-f-]{36}$/i.test(req.params.id) && (await getJobForUser(req.params.id, req.user.id));
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ---- Translation history (plans with history_days only) ---------------------

/** Lock history behind a plan that includes it. Rows of downgraded users are kept until they expire. */
async function requireHistory(req, res, next) {
  const usage = await getUsage(req.user.id);
  if (!usage.historyDays) {
    return res.status(402).json({
      error: `Translation history isn't included in the ${usage.planName} plan. Upgrade to keep your translations.`,
      upgrade: true,
    });
  }
  next();
}

/** GET /api/history?limit=20&before=<createdAt> -> saved translations, newest first (no segments). */
app.get("/api/history", requireUser, requireHistory, async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before).toISOString() : undefined;
  res.json(await listHistory(req.user.id, { limit, before }));
});

/** GET /api/history/:id -> one saved translation with segments; ?format=srt|vtt|txt&track=... downloads it. */
app.get("/api/history/:id", requireUser, requireHistory, async (req, res) => {
  const item = /^[0-9a-f-]{36}$/i.test(req.params.id) && (await getHistoryItem(req.user.id, req.params.id));
  if (!item) return res.status(404).json({ error: "Not found (it may have expired)" });
  const format = req.query.format ? String(req.query.format) : null;
  const track = String(req.query.track ?? "translation");
  if (format) {
    if (!FORMATS[format]) return res.status(400).json({ error: "`format` must be srt, vtt or txt" });
    if (!TRACKS.has(track)) return res.status(400).json({ error: "`track` must be translation, original or bilingual" });
    const f = FORMATS[format];
    res.attachment(fileName(item, f.ext, track)).type(`${f.mime}; charset=utf-8`);
    return res.send(f.render(item.segments, track));
  }
  res.json(item);
});

/** Deleting is allowed on any plan, so downgraded users can still remove what was saved. */
app.delete("/api/history/:id", requireUser, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "Not found" });
  const deleted = await deleteHistory(req.user.id, req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

app.delete("/api/history", requireUser, async (req, res) => {
  res.json({ deleted: await deleteHistory(req.user.id) });
});

// ---- Admin (Authorization: Bearer $ADMIN_TOKEN) -----------------------------
// Manual overrides (e.g. comp accounts). Paying users' plans are set by the Stripe webhook.

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
    stripe: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
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
