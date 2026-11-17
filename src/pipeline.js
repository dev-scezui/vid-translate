import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { downloadMedia, getVideoInfo } from "./services/download.js";
import { extractAudio, getDuration, splitForUpload } from "./services/audio.js";
import { transcribe } from "./services/transcribe.js";
import { translate } from "./services/translate.js";

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);

/** In-memory job store. Swap for Redis/a DB if you run more than one instance. */
const jobs = new Map();
const queue = [];
let active = 0;

export function getJob(id) {
  return jobs.get(id);
}

export function createJob({ url, targetLanguage, sourceLanguage }) {
  const job = {
    id: crypto.randomUUID(),
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
    if (config.maxDurationSec && job.video.durationSec > config.maxDurationSec) {
      throw new Error(`Video is ${Math.round(job.video.durationSec)}s long; the limit is ${config.maxDurationSec}s`);
    }

    job.status = "downloading";
    const media = await downloadMedia(url, dir);

    job.status = "extracting_audio";
    const audio = await extractAudio(media, dir);
    job.video.durationSec ??= await getDuration(audio);
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
  } catch (err) {
    console.error(`[job ${job.id}]`, err);
    job.status = "error";
    job.error = err.message;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Public view of a job (drops internal fields). */
export function serializeJob(job) {
  const { done, resolveDone, ...rest } = job;
  return rest;
}
