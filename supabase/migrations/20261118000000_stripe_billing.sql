-- Stripe billing: link plans to Stripe Prices and users to Stripe customers/subscriptions.

alter table public.plans add column if not exists stripe_price_id text unique;

alter table public.users
  add column if not exists stripe_customer_id     text unique,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status    text,
  add column if not exists current_period_end     timestamptz,
  add column if not exists cancel_at_period_end   boolean not null default false;

-- Apply the latest state of a Stripe subscription to its user.
-- Called from the webhook with data freshly fetched from Stripe, so it is safe to
-- run repeatedly and in any order.
--  * active / trialing / past_due -> the plan whose stripe_price_id matches
--    (past_due keeps access while Stripe retries the card)
--  * anything else (canceled, unpaid, incomplete, ...) -> free, but only if it is
--    the user's current subscription, so an old canceled one can't downgrade a newer one.
create or replace function public.apply_subscription(
  p_user_id              uuid,
  p_customer_id          text,
  p_subscription_id      text,
  p_status               text,
  p_price_id             text,
  p_period_end           timestamptz,
  p_cancel_at_period_end boolean
) returns public.users language plpgsql as $$
declare
  v_user public.users;
  v_plan text;
begin
  select * into v_user from public.users
  where (p_user_id is not null and id = p_user_id) or stripe_customer_id = p_customer_id
  order by (id = p_user_id) desc nulls last
  limit 1
  for update;
  if not found then
    raise exception 'No user for Stripe customer %', p_customer_id using errcode = 'PT404';
  end if;

  if p_status in ('active', 'trialing', 'past_due') then
    select id into v_plan from public.plans where stripe_price_id = p_price_id;
    if v_plan is null then
      raise exception 'No plan has stripe_price_id %', p_price_id using errcode = 'PT422';
    end if;
    update public.users set
      plan = v_plan,
      stripe_customer_id = p_customer_id,
      stripe_subscription_id = p_subscription_id,
      subscription_status = p_status,
      current_period_end = p_period_end,
      cancel_at_period_end = p_cancel_at_period_end
    where id = v_user.id
    returning * into v_user;
  elsif v_user.stripe_subscription_id is null or v_user.stripe_subscription_id = p_subscription_id then
    update public.users set
      plan = 'free',
      stripe_customer_id = p_customer_id,
      subscription_status = p_status,
      current_period_end = null,
      cancel_at_period_end = false
    where id = v_user.id
    returning * into v_user;
  end if;

  return v_user;
end
$$;

revoke all on function public.apply_subscription(uuid, text, text, text, text, timestamptz, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.apply_subscription(uuid, text, text, text, text, timestamptz, boolean) from anon, authenticated;
    grant execute on function public.apply_subscription(uuid, text, text, text, text, timestamptz, boolean) to service_role;
  end if;
end $$;

-- Billing fields in get_usage.
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
