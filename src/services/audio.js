import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { run } from "../lib/exec.js";

// Mono 16 kHz at 32 kbps is plenty for speech recognition: ~14 MB per hour.
const AUDIO_ARGS = ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k"];
const CHUNK_SECONDS = 10 * 60;

/** Strip the video track and re-encode to a small speech-friendly MP3. */
export async function extractAudio(inputFile, dir) {
  const out = path.join(dir, "audio.mp3");
  await run(config.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", inputFile, ...AUDIO_ARGS, out]);
  return out;
}

export async function getDuration(file) {
  const out = await run(config.ffprobePath, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  return Number.parseFloat(out) || 0;
}

/**
 * Split audio into chunks under the transcription upload limit.
 * Returns [{ file, offsetSec }] so segment timestamps can be re-based.
 */
export async function splitForUpload(audioFile, dir, maxBytes) {
  const { size } = await fs.stat(audioFile);
  if (size <= maxBytes) return [{ file: audioFile, offsetSec: 0 }];

  const pattern = path.join(dir, "chunk_%03d.mp3");
  await run(config.ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", audioFile,
    "-f", "segment", "-segment_time", String(CHUNK_SECONDS), "-c", "copy", pattern,
  ]);
  const files = (await fs.readdir(dir)).filter((f) => f.startsWith("chunk_")).sort();
  return files.map((f, i) => ({ file: path.join(dir, f), offsetSec: i * CHUNK_SECONDS }));
}
