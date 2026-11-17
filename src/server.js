import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { validateVideoUrl } from "./lib/validateUrl.js";
import { run } from "./lib/exec.js";
import { createJob, getJob, serializeJob } from "./pipeline.js";

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public")));

/**
 * POST /api/jobs
 * body: { url, targetLanguage = "English", sourceLanguage? }
 * Returns 202 with a job id to poll. Add ?wait=true to block until it finishes.
 */
app.post("/api/jobs", async (req, res, next) => {
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
    const job = createJob({ url: safeUrl, targetLanguage, sourceLanguage: sourceLanguage?.toLowerCase() });

    if (req.query.wait === "true") {
      await job.done;
      return res.status(job.status === "done" ? 200 : 422).json(serializeJob(job));
    }
    res.status(202).location(`/api/jobs/${job.id}`).json(serializeJob(job));
  } catch (err) {
    next(err);
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found (jobs expire after an hour)" });
  res.json(serializeJob(job));
});

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
  res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
});

app.listen(config.port, () => {
  console.log(`vid-translate listening on http://localhost:${config.port}`);
});
