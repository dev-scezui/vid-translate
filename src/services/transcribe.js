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
 * Transcribe audio chunks in order and stitch them together.
 * @param {{file: string, offsetSec: number}[]} chunks
 * @param {{language?: string}} opts ISO-639-1 hint, e.g. "es". Omit to auto-detect.
 */
export async function transcribe(chunks, { language } = {}) {
  const openai = getClient();
  const { model } = config.transcription;
  // whisper-1 (and Groq/faster-whisper servers) return timestamps + detected
  // language with verbose_json; newer gpt-4o-*-transcribe models only do json.
  const verbose = /whisper/i.test(model);

  const texts = [];
  const segments = [];
  let detectedLanguage = language ?? null;

  for (const { file, offsetSec } of chunks) {
    const res = await openai.audio.transcriptions.create({
      file: fs.createReadStream(file),
      model,
      response_format: verbose ? "verbose_json" : "json",
      ...(language ? { language } : {}),
    });
    texts.push(res.text.trim());
    detectedLanguage ??= res.language ?? null;
    for (const s of res.segments ?? []) {
      segments.push({ start: s.start + offsetSec, end: s.end + offsetSec, text: s.text.trim() });
    }
  }

  return { text: texts.join(" ").trim(), language: detectedLanguage, segments };
}
