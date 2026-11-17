import os from "node:os";
import path from "node:path";

function parseJson(value, name) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON, e.g. {"without_timestamps":"false"}`);
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  tmpDir: process.env.TMP_DIR ?? path.join(os.tmpdir(), "vid-translate"),

  ytDlpPath: process.env.YT_DLP_PATH ?? "yt-dlp",
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
  // Reject videos longer than this (seconds). 0 = no limit.
  maxDurationSec: Number(process.env.MAX_DURATION_SEC ?? 60 * 60),

  // Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint.
  // Defaults to Groq's hosted Whisper; point it at OpenAI or the self-hosted
  // server in compose.whisper.yaml instead by changing these.
  transcription: {
    apiKey: process.env.TRANSCRIBE_API_KEY ?? process.env.GROQ_API_KEY,
    baseURL: process.env.TRANSCRIBE_BASE_URL || "https://api.groq.com/openai/v1",
    model: process.env.TRANSCRIBE_MODEL ?? "whisper-large-v3-turbo",
    // Extra form fields some servers need, as JSON. The self-hosted speaches
    // server needs {"without_timestamps":"false"} to return segment timestamps.
    extraFields: parseJson(process.env.TRANSCRIBE_EXTRA_FIELDS, "TRANSCRIBE_EXTRA_FIELDS"),
    // Most hosted endpoints cap uploads at 25 MB; chunks are cut below this.
    maxUploadBytes: Number(process.env.TRANSCRIBE_MAX_BYTES ?? 24 * 1024 * 1024),
  },

  // Translation: Claude
  translation: {
    model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
    effort: process.env.CLAUDE_EFFORT ?? "medium",
  },
};
