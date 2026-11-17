import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { downloadMedia, getVideoInfo } from "./services/download.js";
import { extractAudio, getDuration, splitForUpload } from "./services/audio.js";
import { transcribe } from "./services/transcribe.js";
import { translate } from "./services/translate.js";
import { failStaleJobs, reserveJob, updateJob } from "./store.js";

/*
 * Job state lives in the database, so any app server can answer
 * GET /api/jobs/:id. Each server runs the jobs it accepted, with at most
 * MAX_CONCURRENT_JOBS at once. If a server dies mid-job, the stale-job sweep
 * marks it failed, which also refunds the user's quota.
 */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);
const queue = [];
const waiters = new Map(); // jobId -> resolve(), for ?wait=true on this server
let active = 0;

setInterval(() => failStaleJobs().catch((err) => console.error("stale-job sweep failed:", err)), 10 * 60 * 1000).unref();

/**
 * Reserve one translation from the user's quota (throws 402 when used up), then queue the job.
 * @returns {Promise<{id: string, done: Promise<void>}>}
 */
export async function createJob(user, input) {
  const id = crypto.randomUUID();
  const { planName, maxVideoSec } = await reserveJob(user.id, id, input);
  const limits = [maxVideoSec, config.maxDurationSec].filter(Boolean);

  const done = new Promise((resolve) => waiters.set(id, resolve));
  queue.push({ id, input, planName, maxVideoSec: limits.length ? Math.min(...limits) : null });
  pump();
  return { id, done };
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    runJob(job).finally(() => {
      active--;
      waiters.get(job.id)?.();
      waiters.delete(job.id);
      pump();
    });
  }
}

async function runJob(job) {
  const dir = path.join(config.tmpDir, job.id);
  const { url, targetLanguage, sourceLanguage } = job.input;
  const step = (status, extra = {}) => updateJob(job.id, { status, ...extra });
  try {
    await step("fetching_info");
    const video = await getVideoInfo(url);
    checkLength(job, video.durationSec);

    await step("downloading", { video });
    const media = await downloadMedia(url, dir);

    await step("extracting_audio");
    const audio = await extractAudio(media, dir);
    await fs.rm(media, { force: true });
    // Some sites don't report a duration up front; measure the audio instead.
    video.durationSec ??= await getDuration(audio);
    checkLength(job, video.durationSec);

    await step("transcribing", { video, duration_sec: video.durationSec });
    const chunks = await splitForUpload(audio, dir, config.transcription.maxUploadBytes);
    const transcript = await transcribe(chunks, { language: sourceLanguage ?? undefined });

    await step("translating", { transcript });
    const text = await translate(transcript.text, {
      targetLanguage,
      sourceLanguage: sourceLanguage ?? transcript.language ?? undefined,
    });

    await step("done", { translation: { language: targetLanguage, text }, finished_at: new Date().toISOString() });
  } catch (err) {
    if (!err.expected) console.error(`[job ${job.id}]`, err);
    // Status 'error' refunds the translation (it no longer counts against the quota).
    await step("error", { error: err.message, finished_at: new Date().toISOString() }).catch((e) =>
      console.error(`[job ${job.id}] could not record failure:`, e),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function checkLength(job, durationSec) {
  if (job.maxVideoSec && durationSec > job.maxVideoSec) {
    const fmt = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
    throw Object.assign(
      new Error(`Video is ${fmt(durationSec)} long; the ${job.planName} plan allows up to ${fmt(job.maxVideoSec)}. Upgrade to translate longer videos.`),
      { expected: true },
    );
  }
}
