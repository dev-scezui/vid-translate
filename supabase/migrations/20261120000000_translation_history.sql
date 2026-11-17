-- Translation history for paid plans.
-- Free plans store nothing. Paid plans keep each finished result for
-- plans.history_days days; users can view, re-download or delete them.
-- After a downgrade the rows stay (until they expire) but the API locks access.

alter table public.plans add column if not exists history_days integer check (history_days > 0);
update public.plans set history_days = 90  where id = 'pro'      and history_days is null;
update public.plans set history_days = 365 where id = 'business' and history_days is null;

create table if not exists public.job_results (
  job_id          uuid primary key references public.jobs (id) on delete cascade,
  user_id         uuid not null references public.users (id) on delete cascade,
  source_language text,
  target_language text not null,
  segments        jsonb not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);
create index if not exists job_results_user_created on public.job_results (user_id, created_at desc);
create index if not exists job_results_expires on public.job_results (expires_at);
alter table public.job_results enable row level security;

-- Delete expired history. Called periodically by the app (or schedule it with pg_cron).
create or replace function public.purge_expired_history()
returns integer language sql as $$
  with gone as (delete from public.job_results where expires_at < now() returning 1)
  select count(*)::integer from gone
$$;

-- reserve_job now also returns the plan's history retention.
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

  return jsonb_build_object('planName', v_plan.name, 'maxVideoSec', v_plan.max_video_sec, 'historyDays', v_plan.history_days);
end
$$;

-- get_usage now also reports historyDays (null = no history on this plan).
create or replace function public.get_usage(p_user_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'plan',                p.id,
    'planName',            p.name,
    'maxVideoSec',         p.max_video_sec,
    'monthlyTranslations', p.monthly_translations,
    'historyDays',         p.history_days,
    'used',                coalesce(j.used, 0),
    'remaining',           greatest(0, p.monthly_translations - coalesce(j.used, 0)),
    'minutesProcessed',    round(coalesce(j.seconds, 0)::numeric / 60, 1),
    'resetsAt',            public.month_start() + interval '1 month',
    'subscription', case when u.stripe_subscription_id is null then null else jsonb_build_object(
        'status',            u.subscription_status,
        'currentPeriodEnd',  u.current_period_end,
        'cancelAtPeriodEnd', u.cancel_at_period_end) end
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

revoke all on function public.purge_expired_history() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.purge_expired_history() from anon, authenticated;
    grant execute on function public.purge_expired_history() to service_role;
  end if;
end $$;
