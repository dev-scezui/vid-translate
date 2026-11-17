# vid-translate

An Express API that takes a public video link (TikTok, YouTube, Instagram, Facebook, Threads, X, Vimeo, Reddit, and the [1,800+ sites yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)), then:

1. **Downloads** the media with `yt-dlp` (it grabs an audio-only stream when the site has one)
2. **Extracts the audio** with `ffmpeg` (mono, 16 kHz, 32 kbps MP3, about 14 MB per hour)
3. **Transcribes** it with Whisper, through any OpenAI-compatible speech-to-text API (OpenAI, Groq, self-hosted)
4. **Translates** the transcript with Claude

## Requirements

- Node.js 20+
- A [Supabase](https://supabase.com) project (the free tier is fine to start)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#installation) and `ffmpeg` on `PATH`. Keep yt-dlp updated (`yt-dlp -U`): sites change often.
- An Anthropic API key (for translation) and a speech-to-text API key (for transcription)

Or skip the local installs and use Docker: `docker build -t vid-translate . && docker run --env-file .env -p 3000:3000 vid-translate`

## Supabase setup

1. Create a project at supabase.com.
2. Apply the schema in `supabase/migrations/`. Either paste the file into the dashboard's **SQL Editor** and run it, or use the CLI: `supabase link --project-ref <ref> && supabase db push`. It's safe to run more than once.
3. Copy the **Project URL** and the **service_role** key (Project Settings → API) into `.env` as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

The service-role key bypasses row-level security, so keep it on the server only. The tables have RLS turned on with no policies, so the public `anon` key can't read or write anything.

## Run

```bash
npm install
cp .env.example .env   # fill in the Supabase, Anthropic and transcription keys, plus ADMIN_TOKEN
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

The tiers are rows in the `plans` table. Edit them in the Supabase table editor and the change takes effect immediately, with no deploy.

- **Monthly count:** a translation is reserved when the job starts. If the job fails for any reason (a bad link, a video over the length limit, a download or API error), the translation is refunded. Counts reset on the 1st of each month (UTC). Once a user runs out, `POST /api/jobs` returns `402` with their usage.
- **Video length:** checked from the site's metadata before downloading. If the site doesn't report a length, it's checked again on the extracted audio, before any paid transcription.
- **Storage:** users, plans and jobs live in Supabase. API keys are stored as hashes only. The `jobs` table doubles as the usage ledger: every job that didn't end in `error` counts toward the monthly limit.
- **Atomic checks:** the quota check and the signup limit run inside Postgres functions with row and advisory locks. They stay correct however many app servers you run. In a test, 20 simultaneous requests from a Free user produced exactly 5 jobs.
- **Upgrades:** handled by Stripe subscriptions (see below). The admin endpoint can still change a plan by hand, for example to give someone free access.
- **Signup abuse:** limited to 3 signups per IP per day, enforced in the database. Set `TRUST_PROXY` when running behind a load balancer so the real client IP is used.

## Stripe billing

Paid plans are monthly Stripe subscriptions:

1. A user clicks **Upgrade**. `POST /api/billing/checkout` sends them to a Stripe Checkout page.
2. After they pay, Stripe calls `POST /api/stripe/webhook`. The app fetches the subscription from Stripe and sets the user's plan.
3. **Manage billing** (`POST /api/billing/portal`) opens Stripe's Customer Portal, where users switch plans, cancel, update their card and download invoices. Each change comes back through the webhook.

How each subscription state maps to a plan:

| Subscription state | Plan |
|---|---|
| `active`, `trialing` | The paid plan |
| `past_due` | The paid plan is kept while Stripe retries the card |
| `canceled`, `unpaid`, `incomplete_expired` | `free` |
| Cancelled "at period end" | The paid plan is kept until the period ends, then drops to `free` |

### Setup

1. **Create the products.** In the Stripe dashboard (start in **test mode**), create a product for each paid plan with a recurring monthly price.
2. **Link the prices.** Copy each price ID into the `plans` table:
   ```sql
   update plans set stripe_price_id = 'price_...' where id = 'pro';
   update plans set stripe_price_id = 'price_...' where id = 'business';
   ```
   Amounts and currency come from Stripe, so you change prices there. A plan with no `stripe_price_id`, like `free`, can't be bought.
3. **Add the webhook.** Under **Developers → Webhooks**, add an endpoint at `https://<your-app>/api/stripe/webhook` with these events:
   - `checkout.session.completed`
   - `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`

   Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. **Set up the portal.** Under **Settings → Billing → Customer portal**, enable it, allow customers to switch between your plan products, and allow cancellations.
5. **Add the keys.** Set `STRIPE_SECRET_KEY` and `APP_URL` in `.env`.

### Testing locally

Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and run:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook   # prints a whsec_... for STRIPE_WEBHOOK_SECRET
```

Then subscribe through the UI using the test card `4242 4242 4242 4242`, any future expiry date and any CVC.

### Notes

- The webhook verifies Stripe's signature. It always re-fetches the subscription from Stripe rather than trusting the event body, so retried and out-of-order events are handled safely.
- If the webhook fails (for example, a price ID isn't linked to a plan), it returns `500` and Stripe retries for up to 3 days.
- A user with an active subscription who tries to check out again is sent to the portal instead, so nobody gets billed twice.

## Scaling

The app servers keep no state, so you can run as many as you like behind a load balancer:

- Job status and results are in the database, so any server can answer `GET /api/jobs/:id`.
- Each server processes the jobs it accepted, up to `MAX_CONCURRENT_JOBS` at a time, using its local disk for temporary files.
- If a server dies mid-job, a sweep marks the job as failed (which refunds the translation) once it has made no progress for an hour. Every server runs the sweep every 10 minutes, and running it more than once is harmless.
- `?wait=true` keeps the HTTP request open on the server running the job. For long videos, polling is more robust.

For heavy traffic, the next step is to split API servers from worker servers, with a proper queue between them (for example pg-boss on the same Postgres, or BullMQ with Redis), so a burst of jobs doesn't slow down API responses.

## API

Send the key as `Authorization: Bearer vt_...` (or `X-API-Key`).

### `POST /api/signup`

`{ "email": "you@example.com" }` returns `201` with `{ apiKey, user, usage }`. The key is shown only once.

### `GET /api/me`

Shows your plan and usage: `used`, `remaining`, `maxVideoSec`, `minutesProcessed`, `resetsAt`.

### `POST /api/me/rotate-key`

Issues a new key. The old key stops working.

### `GET /api/plans`

Lists the plans with their limits and their Stripe price (`amount` in cents, `currency`, `interval`).

### `POST /api/billing/checkout`

`{ "plan": "pro" }` returns `{ url }` for a Stripe Checkout page. Returns `409` if you're already subscribed; use the portal instead.

### `POST /api/billing/portal`

Returns `{ url }` for the Stripe Customer Portal.

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

### `GET /api/jobs`

Your recent jobs, newest first. Use `?limit=` to get up to 100.

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

Only the user who created a job can read it. Jobs, including their transcripts and translations, are stored permanently. Add a cleanup job if you'd rather not keep results forever.

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
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | (none) | Required |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | (none) | Billing. Without them, paid plans can't be bought |
| `APP_URL` | `http://localhost:3000` | Where Checkout and the portal send users back to |
| `MAX_DURATION_SEC` | `3600` | A global cap on video length, applied on top of each plan's limit |
| `MAX_CONCURRENT_JOBS` | `2` | |
| `YT_DLP_COOKIES` | (none) | A cookies.txt file, which helps with Instagram and Facebook |

## Notes

- **Only public videos.** Instagram and Facebook sometimes block anonymous downloads from server or datacenter IPs. If they fail, set `YT_DLP_COOKIES`.
- **Long audio** is split into 10-minute chunks to stay under the 25 MB upload limit, and timestamps are re-based across chunks.
- **SSRF protection:** only public `http(s)` URLs are accepted, and hosts that resolve to private or loopback addresses are rejected.
- Respect each platform's terms of service and copyright when downloading content.
