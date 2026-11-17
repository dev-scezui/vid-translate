import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { run } from "../lib/exec.js";

function baseArgs() {
  const args = ["--no-playlist", "--no-warnings", "--no-progress"];
  // Some platforms (Instagram, Facebook) rate-limit or require a session for
  // anonymous requests; a Netscape cookies.txt helps there.
  if (process.env.YT_DLP_COOKIES) args.push("--cookies", process.env.YT_DLP_COOKIES);
  return args;
}

/** Fetch metadata without downloading (title, duration, platform). */
export async function getVideoInfo(url) {
  const out = await run(config.ytDlpPath, [...baseArgs(), "--dump-single-json", url], { timeoutMs: 2 * 60 * 1000 });
  const info = JSON.parse(out);
  return {
    id: info.id,
    title: info.title ?? null,
    uploader: info.uploader ?? info.channel ?? null,
    platform: info.extractor_key ?? info.extractor ?? null,
    durationSec: info.duration ?? null,
    webpageUrl: info.webpage_url ?? url,
  };
}

/**
 * Download the media into `dir`. Prefers an audio-only stream (much smaller);
 * falls back to the full video when the site only serves muxed files.
 */
export async function downloadMedia(url, dir) {
  await fs.mkdir(dir, { recursive: true });
  const out = await run(config.ytDlpPath, [
    ...baseArgs(),
    "-f", "bestaudio/best",
    "-o", path.join(dir, "source.%(ext)s"),
    "--print", "after_move:filepath",
    url,
  ]);
  const file = out.trim().split("\n").pop();
  if (!file) throw new Error("yt-dlp did not report a downloaded file");
  return file;
}
