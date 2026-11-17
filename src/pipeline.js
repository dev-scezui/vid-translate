import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { downloadMedia, getVideoInfo } from "./services/download.js";
import { extractAudio, getDuration, splitForUpload } from "./services/audio.js";
import { transcribe } from "./services/transcribe.js";
import { translateSegments } from "./services/translate.js";
import { failStaleJobs, reserveJob, updateJob } from "./store.js";

/*
 * Transcripts and translations are never stored. A job's result exists only in
 * this server's memory until it is sent back on the request that started it.
 * The database only keeps job metadata (status, video title, duration) for
 * quotas and history.
 *
 * If the client disconnects before the result is ready, the job is cancelled
 * and the translation is refunded (status 'error').
 */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);
const queue = [];
let active = 0;

setInterval(() => failStaleJobs().catch((err) => console.error("stale-job sweep failed:", err)), 10 * 60 * 1000).unref();

/**
 * Reserve one translation from the user's quota (throws 402 when used up), then queue the job.
 * @param {object} user
 * @param {{url: string, targetLanguage: string, sourceLanguage: string|null}} input
 * @param {{onStatus?: (status: string, info?: object) => void, signal?: AbortSignal}} hooks
 * @returns {Promise<{id: string, result: Promise<object>}>} result rejects if the job fails.
 */
export async function createJob(user, input, { onStatus = () => {}, signal } = {}) {
  const id = crypto.randomUUID();
  const { planName, maxVideoSec } = await reserveJob(user.id, id, { url: input.url, targetLanguage: input.targetLanguage });
  const limits = [maxVideoSec, config.maxDurationSec].filter(Boolean);

  let resolve, reject;
  const result = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  result.catch(() => {}); // callers await it; avoid unhandled-rejection noise if they don't

  queue.push({
    id, input, planName, onStatus, signal, resolve, reject,
    maxVideoSec: limits.length ? Math.min(...limits) : null,
  });
  onStatus("queued");
  pump();
  return { id, result };
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    runJob(job).finally(() => {
      active--;
      pump();
    });
  }
}

async function runJob(job) {
  const dir = path.join(config.tmpDir, job.id);
  const { url, targetLanguage, sourceLanguage } = job.input;
  const { signal } = job;
  const step = async (status, meta = {}) => {
    if (signal?.aborted) throw Object.assign(new Error("Cancelled: the client disconnected"), { expected: true });
    job.onStatus(status, meta);
    await updateJob(job.id, { status, ...meta });
  };

  try {
    await step("fetching_info");
    const video = await getVideoInfo(url, signal);
    checkLength(job, video.durationSec);

    await step("downloading", { video });
    const media = await downloadMedia(url, dir, signal);

    await step("extracting_audio");
    const audio = await extractAudio(media, dir, signal);
    await fs.rm(media, { force: true });
    const audioSec = await getDuration(audio);
    // Some sites don't report a duration up front; use the audio's length instead.
    video.durationSec ??= audioSec;
    checkLength(job, video.durationSec);

    await step("transcribing", { video, duration_sec: video.durationSec });
    const chunks = await splitForUpload(audio, dir, config.transcription.maxUploadBytes, audioSec, signal);
    const transcript = await transcribe(chunks, { language: sourceLanguage ?? undefined, signal });

    await step("translating");
    const segments = await translateSegments(transcript.segments, {
      targetLanguage,
      sourceLanguage: sourceLanguage ?? transcript.language ?? undefined,
      signal,
    });

    if (signal?.aborted) throw Object.assign(new Error("Cancelled: the client disconnected"), { expected: true });
    await updateJob(job.id, { status: "done", finished_at: new Date().toISOString() });
    job.resolve({
      id: job.id,
      video,
      sourceLanguage: transcript.language,
      targetLanguage,
      segments,
    });
  } catch (err) {
    const cancelled = signal?.aborted;
    const message = cancelled ? "Cancelled: the client disconnected" : err.message;
    if (!err.expected && !cancelled) console.error(`[job ${job.id}]`, err);
    // Status 'error' refunds the translation (it no longer counts against the quota).
    await updateJob(job.id, { status: "error", error: message, finished_at: new Date().toISOString() }).catch((e) =>
      console.error(`[job ${job.id}] could not record failure:`, e),
    );
    job.reject(Object.assign(new Error(message), { status: 422 }));
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
