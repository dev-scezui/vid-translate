import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let client;
function getClient() {
  // Resolves ANTHROPIC_API_KEY (or another configured credential) from the environment.
  client ??= new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You translate transcripts of short social-media and online videos.
The transcript comes from automatic speech recognition, so it may contain recognition errors, missing punctuation, filler words and slang.
Translate faithfully into the requested language: keep the speaker's meaning, tone and register, fix obvious recognition errors from context, and add natural punctuation and paragraph breaks.
Keep names, brands, handles and hashtags as they are.
Reply with the translation only - no preamble, notes or quotation marks.`;

/**
 * Translate a transcript with Claude.
 * @returns {Promise<string>}
 */
export async function translate(text, { targetLanguage, sourceLanguage }) {
  if (!text.trim()) return "";

  const source = sourceLanguage ? ` from ${sourceLanguage}` : "";
  const stream = getClient().beta.messages.stream({
    model: config.translation.model,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    output_config: { effort: config.translation.effort },
    // If a safety classifier declines, the API retries on a fallback model
    // within the same call instead of failing the job.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [
      {
        role: "user",
        content: `Translate this transcript${source} into ${targetLanguage}.\n\n<transcript>\n${text}\n</transcript>`,
      },
    ],
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("Translation was declined by the model");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Transcript too long to translate in one pass");
  }
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
