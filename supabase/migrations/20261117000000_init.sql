-- vid-translate schema for Supabase (Postgres).
-- Apply with `supabase db push`, or paste into the Supabase SQL editor.
-- The server talks to these tables with the service-role key only; RLS is on with
-- no policies, so the public anon key cannot read or write anything.

-- ---------------------------------------------------------------------------
-- Plans: edit rows here to change pricing tiers without a deploy.
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id                   text primary key,
  name                 text not null,
  max_video_sec        integer not null check (max_video_sec > 0),
  monthly_translations integer not null check (monthly_translations >= 0),
  sort                 integer not null default 0
);

insert into public.plans (id, name, max_video_sec, monthly_translations, sort) values
  ('free',     'Free',     180,  5,    0),
  ('pro',      'Pro',      1800, 200,  1),
  ('business', 'Business', 7200, 2000, 2)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Users: API keys are stored as SHA-256 hashes only.
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique,
  api_key_hash text not null unique,
  plan         text not null default 'free' references public.plans (id),
  signup_ip    inet,
  created_at   timestamptz not null default now()
);
create index if not exists users_signup_ip_created on public.users (signup_ip, created_at);

-- ---------------------------------------------------------------------------
-- Jobs: one row per translation request. Doubles as the usage ledger:
-- every job not in status 'error' counts against the monthly quota, so a
-- failed job is automatically refunded.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id           uuid primary key,
  user_id      uuid not null references public.users (id) on delete cascade,
  status       text not null default 'queued' check (status in
                 ('queued', 'fetching_info', 'downloading', 'extracting_audio',
                  'transcribing', 'translating', 'done', 'error')),
  input        jsonb not null,
  video        jsonb,
  transcript   jsonb,
  translation  jsonb,
  duration_sec real,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists jobs_user_created on public.jobs (user_id, created_at desc);
create index if not exists jobs_active on public.jobs (updated_at) where status not in ('done', 'error');

alter table public.plans enable row level security;
alter table public.users enable row level security;
alter table public.jobs  enable row level security;

-- ---------------------------------------------------------------------------
-- Functions (called over RPC). Errors use SQLSTATE 'PTxyz' so the HTTP status
-- is easy to map: PT402 quota exhausted, PT429 rate limited, PT409 conflict.
-- ---------------------------------------------------------------------------

create or replace function public.month_start(t timestamptz default now())
returns timestamptz language sql immutable as $$
  select date_trunc('month', t at time zone 'utc') at time zone 'utc'
$$;

-- Plan limits plus this month's usage for one user.
create or replace function public.get_usage(p_user_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'plan',                p.id,
    'planName',            p.name,
    'maxVideoSec',         p.max_video_sec,
    'monthlyTranslations', p.monthly_translations,
    'used',                coalesce(j.used, 0),
    'remaining',           greatest(0, p.monthly_translations - coalesce(j.used, 0)),
    'minutesProcessed',    round(coalesce(j.seconds, 0)::numeric / 60, 1),
    'resetsAt',            public.month_start() + interval '1 month'
  )
  from public.users u
  join public.plans p on p.id = u.plan
  left join lateral (
    select count(*) filter (where status <> 'error')                   as used,
           sum(duration_sec) filter (where status = 'done')             as seconds
    from public.jobs
    where user_id = u.id and created_at >= public.month_start()
  ) j on true
  where u.id = p_user_id
$$;

-- Sign up, at most p_max_per_ip new accounts per IP per 24h.
create or replace function public.create_user(p_email text, p_api_key_hash text, p_ip inet, p_max_per_ip integer)
returns public.users language plpgsql as $$
declare
  v_user public.users;
begin
  if p_ip is not null and p_max_per_ip > 0 then
    -- Serialize signups per IP so concurrent requests can't slip past the limit.
    perform pg_advisory_xact_lock(hashtext('signup:' || host(p_ip)));
    if (select count(*) from public.users
        where signup_ip = p_ip and created_at > now() - interval '24 hours') >= p_max_per_ip then
      raise exception 'Too many signups from this address, try again tomorrow' using errcode = 'PT429';
    end if;
  end if;

  insert into public.users (email, api_key_hash, signup_ip)
  values (lower(p_email), p_api_key_hash, p_ip)
  returning * into v_user;
  return v_user;
exception when unique_violation then
  raise exception 'An account with that email already exists' using errcode = 'PT409';
end
$$;

-- Atomically check the quota and create a queued job.
-- Locks the user row, so concurrent requests from one user (on any server) queue up here.
create or replace function public.reserve_job(p_user_id uuid, p_job_id uuid, p_input jsonb)
returns jsonb language plpgsql as $$
declare
  v_plan public.plans;
  v_used integer;
begin
  select p.* into v_plan
  from public.users u join public.plans p on p.id = u.plan
  where u.id = p_user_id
  for update of u;
  if not found then
    raise exception 'User not found' using errcode = 'PT404';
  end if;

  select count(*) into v_used
  from public.jobs
  where user_id = p_user_id and status <> 'error' and created_at >= public.month_start();

  if v_used >= v_plan.monthly_translations then
    raise exception 'Monthly limit reached (% translations on the % plan). Upgrade or wait until %.',
      v_plan.monthly_translations, v_plan.name,
      to_char(public.month_start() + interval '1 month', 'YYYY-MM-DD')
      using errcode = 'PT402';
  end if;

  insert into public.jobs (id, user_id, input) values (p_job_id, p_user_id, p_input);

  return jsonb_build_object('planName', v_plan.name, 'maxVideoSec', v_plan.max_video_sec);
end
$$;

-- Fail (and so refund) jobs whose worker died: no progress for p_stale_after.
create or replace function public.fail_stale_jobs(p_stale_after interval default interval '1 hour')
returns integer language sql as $$
  with stale as (
    update public.jobs
    set status = 'error', error = 'Job was interrupted, please try again',
        finished_at = now(), updated_at = now()
    where status not in ('done', 'error') and updated_at < now() - p_stale_after
    returning 1
  )
  select count(*)::integer from stale
$$;

-- Server-only: no direct access for the public roles Supabase exposes.
revoke all on function public.get_usage(uuid), public.create_user(text, text, inet, integer),
  public.reserve_job(uuid, uuid, jsonb), public.fail_stale_jobs(interval) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_usage(uuid), public.create_user(text, text, inet, integer),
      public.reserve_job(uuid, uuid, jsonb), public.fail_stale_jobs(interval) from anon, authenticated;
    grant execute on function public.get_usage(uuid), public.create_user(text, text, inet, integer),
      public.reserve_job(uuid, uuid, jsonb), public.fail_stale_jobs(interval) to service_role;
  end if;
end $$;
