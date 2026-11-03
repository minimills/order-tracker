-- 0011_alerts.sql
-- Alerts (see ALERTS in CLAUDE.md).
-- 1. Alert thresholds live in app_settings (key 'alerts'); admins change them
--    in Settings > Alerts.
-- 2. active_alerts view: every alert that applies right now, worked out from
--    the live data (nothing to keep in sync).
-- 3. alert_states table: each user's own snoozes and dismissals.
-- 4. my_alerts view: active alerts plus the signed-in user's snooze/dismiss.
-- 5. snooze_alert / dismiss_alert / restore_alert functions.
--
-- Each alert has a key such as 'payment_overdue:<payment id>:<due date>'.
-- The key includes the level, so dismissing "due in 7 days" does not hide the
-- later "due today" or "overdue" alert, and a new due date gives a new alert.

-- ===========================================================================
-- 1. Thresholds
-- ===========================================================================
insert into public.app_settings (key, value)
values ('alerts', '{"payment_warn_days": 7, "payment_urgent_days": 3, "ship_warn_days": 14}'::jsonb)
on conflict (key) do nothing;

-- ===========================================================================
-- 2. active_alerts
-- kind:     payment_overdue, payment_due_today, payment_due_urgent (within
--           payment_urgent_days), payment_due_soon (within payment_warn_days),
--           ship_passed, ship_soon (within ship_warn_days), voltage_unknown
-- severity: 'red' (overdue, due today, ship date passed) or 'amber'
-- days:     days until the due / ship date (negative = days ago)
-- ===========================================================================
create view public.active_alerts
with (security_invoker = true)
as
with settings as (
  select coalesce((v ->> 'payment_warn_days')::integer, 7)   as payment_warn,
         coalesce((v ->> 'payment_urgent_days')::integer, 3) as payment_urgent,
         coalesce((v ->> 'ship_warn_days')::integer, 14)     as ship_warn
    from (select (select value from public.app_settings where key = 'alerts') as v) x
),
today as (
  select (now() at time zone 'America/Halifax')::date as d
),
pay as (
  select p.id as payment_id, p.order_id, p.payment_type, p.due_date,
         p.amount - coalesce(p.received_amount, 0) as remaining,
         p.due_date - today.d as days,
         settings.payment_warn, settings.payment_urgent
    from public.payments p
    join public.orders o on o.id = p.order_id
    cross join settings cross join today
   where p.due_date is not null
     and p.amount - coalesce(p.received_amount, 0) > 0
     and not o.archived
     and o.stage <> 'Cancelled'
),
pay_alerts as (
  select case
           when days < 0 then 'payment_overdue'
           when days = 0 then 'payment_due_today'
           when days <= payment_urgent then 'payment_due_urgent'
           else 'payment_due_soon'
         end as kind,
         *
    from pay
   where days <= payment_warn
),
ship as (
  select o.id as order_id, o.expected_ship_date,
         o.expected_ship_date - today.d as days, settings.ship_warn
    from public.orders o
    cross join settings cross join today
   where public.is_board_stage(o.stage)
     and not o.archived
     and o.actual_ship_date is null
     and o.expected_ship_date is not null
)
select
  a.kind || ':' || a.payment_id || ':' || a.due_date as alert_key,
  a.kind,
  case when a.kind in ('payment_overdue', 'payment_due_today') then 'red' else 'amber' end as severity,
  a.order_id,
  a.payment_id,
  a.payment_type,
  a.remaining as amount,
  a.due_date  as alert_date,
  a.days
from pay_alerts a
union all
select
  case when s.days < 0 then 'ship_passed' else 'ship_soon' end || ':' || s.order_id || ':' || s.expected_ship_date,
  case when s.days < 0 then 'ship_passed' else 'ship_soon' end,
  case when s.days < 0 then 'red' else 'amber' end,
  s.order_id, null, null, null, s.expected_ship_date, s.days
from ship s
where s.days <= s.ship_warn
union all
select
  'voltage_unknown:' || o.id,
  'voltage_unknown',
  'amber',
  o.id, null, null, null, null, null
from public.orders o
where public.is_board_stage(o.stage)
  and not o.archived
  and o.voltage = 'Unknown';

-- ===========================================================================
-- 3. alert_states: per-user snooze / dismiss
-- ===========================================================================
create table public.alert_states (
  user_id       uuid not null default auth.uid(),
  alert_key     text not null,
  snoozed_until timestamptz,
  dismissed_at  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (user_id, alert_key)
);
alter table public.alert_states enable row level security;
create trigger alert_states_updated_at before update on public.alert_states
  for each row execute function public.set_updated_at();

create policy "Users manage their own alert states" on public.alert_states
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed_user()))
  with check (user_id = (select auth.uid()) and (select public.is_allowed_user()));

-- ===========================================================================
-- 4. my_alerts: active alerts with order details and my snooze / dismiss
-- hidden = true when I dismissed it or it is snoozed.
-- ===========================================================================
create view public.my_alerts
with (security_invoker = true)
as
select
  a.alert_key,
  a.kind,
  a.severity,
  a.order_id,
  o.order_code,
  o.stage,
  c.name    as customer_name,
  c.company as customer_company,
  o.currency,
  a.payment_id,
  a.payment_type,
  a.amount,
  a.alert_date,
  a.days,
  st.snoozed_until,
  st.dismissed_at,
  (st.dismissed_at is not null or st.snoozed_until > now()) is true as hidden
from public.active_alerts a
join public.orders o    on o.id = a.order_id
join public.customers c on c.id = o.customer_id
left join public.alert_states st
       on st.alert_key = a.alert_key and st.user_id = (select auth.uid());

-- ===========================================================================
-- 5. Snooze / dismiss / restore (for the signed-in user only)
-- ===========================================================================
create or replace function public.snooze_alert(p_alert_key text, p_days integer)
returns void
language sql
as $$
  insert into public.alert_states (alert_key, snoozed_until, dismissed_at)
  values (p_alert_key, now() + make_interval(days => greatest(p_days, 1)), null)
  on conflict (user_id, alert_key)
  do update set snoozed_until = excluded.snoozed_until, dismissed_at = null;
$$;

create or replace function public.dismiss_alert(p_alert_key text)
returns void
language sql
as $$
  insert into public.alert_states (alert_key, dismissed_at)
  values (p_alert_key, now())
  on conflict (user_id, alert_key)
  do update set dismissed_at = now(), snoozed_until = null;
$$;

create or replace function public.restore_alert(p_alert_key text)
returns void
language sql
as $$
  delete from public.alert_states
   where user_id = (select auth.uid()) and alert_key = p_alert_key;
$$;

-- Access: same rules as before.
revoke all on public.active_alerts, public.my_alerts, public.alert_states from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
