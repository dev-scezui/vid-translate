import fs from "node:fs";
import OpenAI from "openai";
import { config } from "../config.js";

let client;
function getClient() {
  if (!config.transcription.apiKey) {
    throw new Error("Set TRANSCRIBE_API_KEY (or OPENAI_API_KEY) to enable transcription");
  }
  client ??= new OpenAI({ apiKey: config.transcription.apiKey, baseURL: config.transcription.baseURL });
  return client;
}

/**
 * Transcribe audio chunks in order and stitch them together, with timestamps.
 * Timestamps need a model that supports response_format "verbose_json"
 * (whisper-1, Groq's whisper-large-v3*, faster-whisper servers). Models
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
