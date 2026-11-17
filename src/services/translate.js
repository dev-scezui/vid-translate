import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let client;
function getClient() {
  // Resolves ANTHROPIC_API_KEY (or another configured credential) from the environment.
  client ??= new Anthropic();
  return client;
}

const SEGMENTS_PER_REQUEST = 100;
const CONTEXT_SEGMENTS = 5;
const PARALLEL_REQUESTS = 4;

const SYSTEM_PROMPT = `You translate the transcripts of online videos into subtitles.
The input comes from automatic speech recognition, split into timed segments, so it may contain recognition errors, missing punctuation, filler words and slang.
Translate each segment faithfully into the requested language: keep the speaker's meaning, tone and register, fix obvious recognition errors from context, and use natural punctuation.
Each translated segment must stay aligned with its source segment, because it is shown on screen at that segment's time. Do not merge, split, reorder or skip segments; return exactly one translation per id. If a sentence runs across segments, translate each part so it reads naturally where it falls.
Keep names, brands, handles and hashtags as they are.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

async function translateChunk(chunk, context, { targetLanguage, sourceLanguage, signal }) {
  const source = sourceLanguage ? ` from ${sourceLanguage}` : "";
  const contextBlock = context.length
    ? `For context only (already translated, do not include in your output), the preceding segments were:\n<context>\n${context.map((s) => s.text).join("\n")}\n</context>\n\n`
    : "";
  const stream = getClient().beta.messages.stream(
    {
      model: config.translation.model,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: config.translation.effort,
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      // If a safety classifier declines, the API retries on a fallback model
      // within the same call instead of failing the job.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [
        {
          role: "user",
          content:
            `${contextBlock}Translate these ${chunk.length} transcript segments${source} into ${targetLanguage}.\n` +
            `<segments>\n${JSON.stringify(chunk.map((s) => ({ id: s.id, text: s.text })))}\n</segments>`,
        },
      ],
    },
    { signal },
  );

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("Translation was declined by the model");
  if (message.stop_reason === "max_tokens") throw new Error("Translation output was cut off");
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const byId = new Map(JSON.parse(text).translations.map((t) => [t.id, t.text.trim()]));
  return byId;
}

/**
 * Translate timed segments with Claude, keeping one translation per segment so
 * subtitle timing is preserved.
 * @param {{start: number, end: number, text: string}[]} segments
 * @returns {Promise<{start: number, end: number, text: string, translation: string}[]>}
 */
export async function translateSegments(segments, { targetLanguage, sourceLanguage, signal }) {
  const indexed = segments.map((s, id) => ({ ...s, id }));
  const chunks = [];
  for (let i = 0; i < indexed.length; i += SEGMENTS_PER_REQUEST) {
    chunks.push({
      items: indexed.slice(i, i + SEGMENTS_PER_REQUEST).filter((s) => s.text.trim()),
      context: indexed.slice(Math.max(0, i - CONTEXT_SEGMENTS), i),
    });
  }

  const translations = new Map();
  const opts = { targetLanguage, sourceLanguage, signal };
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const { items, context } = chunks[next++];
      if (!items.length) continue;
      let byId = await translateChunk(items, context, opts);
      // The model occasionally drops or merges a segment; retry just the missing ones once.
      const missing = items.filter((s) => !byId.get(s.id));
      if (missing.length) {
        const retry = await translateChunk(missing, context, opts);
        byId = new Map([...byId, ...retry]);
      }
      for (const [id, text] of byId) translations.set(id, text);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, chunks.length) }, worker));

  // Anything still missing falls back to the original text rather than failing the whole job.
  return indexed.map(({ id, ...s }) => ({ ...s, translation: translations.get(id) || s.text }));
}
