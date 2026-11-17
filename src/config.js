import os from "node:os";
import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  tmpDir: process.env.TMP_DIR ?? path.join(os.tmpdir(), "vid-translate"),

  ytDlpPath: process.env.YT_DLP_PATH ?? "yt-dlp",
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
  // Reject videos longer than this (seconds). 0 = no limit.
  maxDurationSec: Number(process.env.MAX_DURATION_SEC ?? 60 * 60),

  // Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint
  // (OpenAI, Groq, a self-hosted faster-whisper server, ...).
  transcription: {
    apiKey: process.env.TRANSCRIBE_API_KEY ?? process.env.OPENAI_API_KEY,
    baseURL: process.env.TRANSCRIBE_BASE_URL || undefined,
    model: process.env.TRANSCRIBE_MODEL ?? "whisper-1",
    // Most hosted endpoints cap uploads at 25 MB; chunks are cut below this.
    maxUploadBytes: Number(process.env.TRANSCRIBE_MAX_BYTES ?? 24 * 1024 * 1024),
  },

  // Translation: Claude
  translation: {
    model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
    effort: process.env.CLAUDE_EFFORT ?? "medium",
  },
};
