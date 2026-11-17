import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { downloadMedia, getVideoInfo } from "./services/download.js";
import { extractAudio, getDuration, splitForUpload } from "./services/audio.js";
import { transcribe } from "./services/transcribe.js";
import { translate } from "./services/translate.js";
import { completeTranslation, refundTranslation, reserveTranslation } from "./accounts.js";
import { getPlan } from "./plans.js";

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);

/** In-memory job store. Swap for Redis/a DB if you run more than one instance. */
const jobs = new Map();
const queue = [];
let active = 0;

export function getJob(id) {
  return jobs.get(id);
}

/** Reserves one translation from the user's quota (throws 402 if none left), then queues the job. */
export function createJob(user, { url, targetLanguage, sourceLanguage }) {
  const id = crypto.randomUUID();
  reserveTranslation(user, id);

  const plan = getPlan(user.plan);
  const limits = [plan.maxVideoSec, config.maxDurationSec].filter(Boolean);
  const job = {
    id,
    userId: user.id,
    maxVideoSec: limits.length ? Math.min(...limits) : null,
    planName: plan.name,
    status: "queued",
    input: { url, targetLanguage, sourceLanguage: sourceLanguage ?? null },
    video: null,
    transcript: null,
    translation: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  let resolveDone;
  job.done = new Promise((r) => (resolveDone = r));
  job.resolveDone = resolveDone;

  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    runJob(job).finally(() => {
      active--;
      job.finishedAt = new Date().toISOString();
      job.resolveDone(job);
      setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref();
      pump();
    });
  }
}

async function runJob(job) {
  const dir = path.join(config.tmpDir, job.id);
  const { url, targetLanguage, sourceLanguage } = job.input;
  try {
    job.status = "fetching_info";
    job.video = await getVideoInfo(url);
    checkLength(job, job.video.durationSec);

    job.status = "downloading";
    const media = await downloadMedia(url, dir);

    job.status = "extracting_audio";
    const audio = await extractAudio(media, dir);
    // Some sites don't report a duration up front; measure the audio instead.
    job.video.durationSec ??= await getDuration(audio);
    checkLength(job, job.video.durationSec);
    await fs.rm(media, { force: true });

    job.status = "transcribing";
    const chunks = await splitForUpload(audio, dir, config.transcription.maxUploadBytes);
    job.transcript = await transcribe(chunks, { language: sourceLanguage ?? undefined });

    job.status = "translating";
    job.translation = {
      language: targetLanguage,
      text: await translate(job.transcript.text, {
        targetLanguage,
        sourceLanguage: sourceLanguage ?? job.transcript.language ?? undefined,
      }),
    };

    job.status = "done";
    completeTranslation(job.id, job.video.durationSec);
  } catch (err) {
    if (!err.expected) console.error(`[job ${job.id}]`, err);
    job.status = "error";
    job.error = err.message;
    refundTranslation(job.id);
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

/** Public view of a job (drops internal fields). */
export function serializeJob(job) {
  const { done, resolveDone, userId, maxVideoSec, planName, ...rest } = job;
  return rest;
}
