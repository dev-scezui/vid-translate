# vid-translate

An Express API that takes a public video link (TikTok, YouTube, Instagram, Facebook, Threads, X, Vimeo, Reddit, and the [1,800+ sites yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)), then:

1. **Downloads** the media with `yt-dlp` (it grabs an audio-only stream when the site has one)
2. **Extracts the audio** with `ffmpeg` (mono, 16 kHz, 32 kbps MP3, about 14 MB per hour)
3. **Transcribes** it with Whisper, through any OpenAI-compatible speech-to-text API (OpenAI, Groq, self-hosted)
4. **Translates** the transcript with Claude

## Requirements

- Node.js 22.13+ (uses the built-in `node:sqlite`)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#installation) and `ffmpeg` on `PATH`. Keep yt-dlp updated (`yt-dlp -U`): sites change often.
- An Anthropic API key (for translation) and a speech-to-text API key (for transcription)

Or skip the local installs and use Docker: `docker build -t vid-translate . && docker run --env-file .env -p 3000:3000 vid-translate`

## Run

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY, TRANSCRIBE_API_KEY and ADMIN_TOKEN
npm run dev
```

Open http://localhost:3000 for a simple web UI, or call the API.

## Plans and limits

Every request to `/api/jobs` needs an API key. Each user is on a plan, and the plan sets two limits:

| Plan | Longest video | Translations per month |
|---|---|---|
| `free` (the default at signup) | 3 min | 5 |
| `pro` | 30 min | 200 |
| `business` | 2 h | 2,000 |

Edit `src/plans.js` to change the tiers.

- **Monthly count:** a translation is reserved when the job starts. If the job fails for any reason (a bad link, a video over the length limit, a download or API error), the translation is refunded. Counts reset on the 1st of each month (UTC). Once a user runs out, `POST /api/jobs` returns `402` with their usage.
- **Video length:** checked from the site's metadata before downloading. If the site doesn't report a length, it's checked again on the extracted audio, before any paid transcription.
- **Storage:** users and usage live in SQLite (`data/vid-translate.db`, or set `DATABASE_PATH`). API keys are stored as hashes only.
- **Upgrades:** there's no payment integration yet. Change a user's plan with the admin endpoint below, or call `setPlan()` from a payment webhook (for example Stripe).
- **Signup abuse:** limited to 3 signups per IP per day. Set `TRUST_PROXY` when running behind a proxy so the real client IP is used.

## API

Send the key as `Authorization: Bearer vt_...` (or `X-API-Key`).

### `POST /api/signup`

`{ "email": "you@example.com" }` returns `201` with `{ apiKey, user, usage }`. The key is shown only once.

### `GET /api/me`

Shows your plan and usage: `used`, `remaining`, `maxVideoSec`, `minutesProcessed`, `resetsAt`.

### `POST /api/me/rotate-key`

Issues a new key. The old key stops working.

### `GET /api/plans`

Lists the plans and their limits.

### `POST /api/jobs`

```json
{ "url": "https://www.tiktok.com/@user/video/123", "targetLanguage": "English", "sourceLanguage": "es" }
```

- `targetLanguage`: optional, defaults to `"English"`. Any language name works.
- `sourceLanguage`: optional ISO-639-1 hint. Leave it out to auto-detect.

The response is `202` with a job to poll. Add `?wait=true` to block until the job finishes instead, which is handy for bots and scripts:

```bash
curl -X POST 'localhost:3000/api/jobs?wait=true' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"url":"https://youtu.be/jNQXAC9IVRw","targetLanguage":"Spanish"}'
```

### `GET /api/jobs/:id`

`status` moves through `queued` → `fetching_info` → `downloading` → `extracting_audio` → `transcribing` → `translating` → `done`, or ends at `error`.

```json
{
  "id": "…",
  "status": "done",
  "video": { "title": "…", "platform": "TikTok", "durationSec": 31 },
  "transcript": { "text": "…", "language": "spanish", "segments": [{ "start": 0, "end": 3.2, "text": "…" }] },
  "translation": { "language": "English", "text": "…" },
  "error": null
}
```

Only the user who created a job can read it. Jobs live in memory and expire an hour after they finish. Usage records are kept permanently in the database.

### Admin endpoints

These need `Authorization: Bearer $ADMIN_TOKEN`.

- `GET /api/admin/users?email=...` looks up a user and their usage.
- `POST /api/admin/users/:id/plan` with `{ "plan": "pro" }` changes a user's plan.

### `GET /health`

Shows whether yt-dlp and ffmpeg are installed and whether the API keys are set.

## Configuration

See `.env.example`. The main settings:

| Variable | Default | |
|---|---|---|
| `TRANSCRIBE_API_KEY` | `OPENAI_API_KEY` | Speech-to-text key |
| `TRANSCRIBE_BASE_URL` | OpenAI | For example `https://api.groq.com/openai/v1` |
| `TRANSCRIBE_MODEL` | `whisper-1` | Whisper models also return timestamps |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Translation model |
| `CLAUDE_EFFORT` | `medium` | `low` is cheaper and faster for casual clips |
| `ADMIN_TOKEN` | (none) | Required for the admin endpoints |
| `DATABASE_PATH` | `./data/vid-translate.db` | |
| `MAX_DURATION_SEC` | `3600` | A global cap on video length, applied on top of each plan's limit |
| `MAX_CONCURRENT_JOBS` | `2` | |
| `YT_DLP_COOKIES` | (none) | A cookies.txt file, which helps with Instagram and Facebook |

## Notes

- **Only public videos.** Instagram and Facebook sometimes block anonymous downloads from server or datacenter IPs. If they fail, set `YT_DLP_COOKIES`.
- **Long audio** is split into 10-minute chunks to stay under the 25 MB upload limit, and timestamps are re-based across chunks.
- **SSRF protection:** only public `http(s)` URLs are accepted, and hosts that resolve to private or loopback addresses are rejected.
- Respect each platform's terms of service and copyright when downloading content.
