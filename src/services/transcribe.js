import fs from "node:fs";
import OpenAI from "openai";
import { config } from "../config.js";

let client;
function getClient() {
  if (!config.transcription.apiKey) {
    throw new Error("Set GROQ_API_KEY (or TRANSCRIBE_API_KEY for another provider) to enable transcription");
  }
  // Groq's free tier rate-limits quickly; retry 429s a few more times than the default 2.
  client ??= new OpenAI({ apiKey: config.transcription.apiKey, baseURL: config.transcription.baseURL, maxRetries: 4 });
  return client;
}

/**
 * Transcribe audio chunks in order and stitch them together, with timestamps.
 * Timestamps need a model that supports response_format "verbose_json"
 * (Groq's whisper-large-v3*, OpenAI's whisper-1, faster-whisper servers). Models
 * without it (gpt-4o-*-transcribe) get one segment per audio chunk.
 * @param {{file: string, offsetSec: number, durationSec: number}[]} chunks
 * @param {{language?: string, signal?: AbortSignal}} opts language is an ISO-639-1 hint, e.g. "es".
 * @returns {Promise<{text: string, language: string|null, segments: {start: number, end: number, text: string}[]}>}
 */
export async function transcribe(chunks, { language, signal } = {}) {
  const openai = getClient();
  const { model } = config.transcription;
  const verbose = !/gpt-4o.*transcribe/i.test(model);

  const texts = [];
  const segments = [];
  let detectedLanguage = language ?? null;

  for (const { file, offsetSec, durationSec } of chunks) {
    const res = await openai.audio.transcriptions.create(
      {
        file: fs.createReadStream(file),
        model,
        response_format: verbose ? "verbose_json" : "json",
        ...(verbose ? { timestamp_granularities: ["segment"] } : {}),
        ...(language ? { language } : {}),
        ...config.transcription.extraFields,
      },
      { signal },
    );
    texts.push(res.text.trim());
    detectedLanguage ??= res.language ?? null;
    if (res.segments?.length) {
      for (const s of res.segments) {
        if (s.text.trim()) segments.push({ start: s.start + offsetSec, end: s.end + offsetSec, text: s.text.trim() });
      }
    } else if (res.text.trim()) {
      segments.push({ start: offsetSec, end: offsetSec + durationSec, text: res.text.trim() });
    }
  }

  return { text: texts.join(" ").trim(), language: detectedLanguage, segments };
}
