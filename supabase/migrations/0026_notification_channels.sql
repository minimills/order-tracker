-- 0026_notification_channels.sql
-- Email (cPanel mailbox), phone push and in-app notifications, with each
-- person choosing per type. Sending is done by the Edge Function "send-email"
-- (supabase/functions/send-email), started every minute by the database's own
-- scheduler (pg_cron + pg_net, switched on from Admin → Email).
--
-- 1. notification_kinds (types and their default settings) and
--    notification_channels (app, email, push; SMS later = one more row plus
--    a sender in the Edge Function).
-- 2. notification_settings: each person's choice per type and channel
--    (app / push: on or off; email: off, instant or daily digest).
-- 3. notifications.in_app + routing: every new notification gets one
--    notification_deliveries row per channel the person wants. Emails about
--    the same card are grouped and sent at most once every 10 minutes.
-- 4. push_subscriptions (phones and browsers that accept push).
-- 5. email_log (every email sent, for Admin → Email Log and Resend).
-- 6. Settings (app_settings key "email") and the automatic sender.

-- ===========================================================================
-- 1. Types and channels
-- ===========================================================================
create table public.notification_kinds (
  kind          text primary key,
  label         text not null,
  description   text,
  sort_order    integer not null default 0,
  -- {"app": "on", "email": "instant" | "digest" | "off", "push": "on" | "off"}
  default_modes jsonb not null default '{}'::jsonb
);
insert into public.notification_kinds (kind, label, description, sort_order, default_modes) values
  ('board_assigned',     'Assigned to a card',   'Someone assigns you to a card.',                         10, '{"app": "on", "email": "instant", "push": "on"}'),
  ('board_comment',      'Comments',             'Someone comments on a card you are on.',                 20, '{"app": "on", "email": "instant", "push": "on"}'),
  ('board_overdue',      'Overdue cards',        'A card you are on has passed its due date.',             30, '{"app": "on", "email": "instant", "push": "on"}'),
  ('board_due_soon',     'Cards due soon',       'A card you are on is due soon.',                         40, '{"app": "on", "email": "digest", "push": "off"}'),
  ('board_card_moved',   'Cards moved',          'A card is moved to another stage on a board you follow.', 50, '{"app": "on", "email": "off", "push": "off"}'),
  ('board_card_created', 'New cards',            'A card is created on a board you follow.',               60, '{"app": "on", "email": "off", "push": "off"}'),
  ('test',               'Test messages',        'Test messages you send to yourself from Settings.',      90, '{"app": "on", "email": "instant", "push": "on"}');

create table public.notification_channels (
  channel    text primary key,
  label      text not null,
  sort_order integer not null default 0,
  enabled    boolean not null default true
);
insert into public.notification_channels (channel, label, sort_order) values
  ('app', 'In the app', 1), ('email', 'Email', 2), ('push', 'Phone push', 3);

alter table public.notification_kinds enable row level security;
alter table public.notification_channels enable row level security;
create policy "Allowed users can read" on public.notification_kinds
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Allowed users can read" on public.notification_channels
  for select to authenticated using ((select public.is_allowed_user()));

-- ===========================================================================
-- 2. Each person's choices
-- ===========================================================================
create table public.notification_settings (
  user_email text not null references public.allowed_users (email) on delete cascade on update cascade,
  kind       text not null references public.notification_kinds (kind) on delete cascade,
  channel    text not null references public.notification_channels (channel) on delete cascade,
  mode       text not null,
  updated_at timestamptz not null default now(),
  primary key (user_email, kind, channel),
  check ((channel = 'email' and mode in ('off', 'instant', 'digest')) or (channel <> 'email' and mode in ('off', 'on')))
);
alter table public.notification_settings enable row level security;
create policy "Own settings" on public.notification_settings
  for all to authenticated
  using (user_email = (select public.current_user_email()) and (select public.has_perm('settings.notification_channels', 'edit')))
  with check (user_email = (select public.current_user_email()) and (select public.has_perm('settings.notification_channels', 'edit')));
create policy "Own settings: read" on public.notification_settings
  for select to authenticated using (user_email = (select public.current_user_email()));

-- The mode that applies: the person's choice, else the type's default.
create or replace function public.notification_mode(p_email text, p_kind text, p_channel text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not coalesce((select enabled from public.notification_channels where channel = p_channel), false) then 'off'
    else coalesce(
      (select mode from public.notification_settings where user_email = p_email and kind = p_kind and channel = p_channel),
      (select default_modes ->> p_channel from public.notification_kinds where kind = p_kind),
      case p_channel when 'app' then 'on' else 'off' end)
  end;
$$;

-- ===========================================================================
-- 3. Routing new notifications to channels
-- ===========================================================================
alter table public.notifications add column in_app boolean not null default true;

create table public.notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  user_email      text not null,
  channel         text not null references public.notification_channels (channel),
  mode            text not null default 'instant' check (mode in ('instant', 'digest')),
  -- Emails with the same group (person + card) are sent together.
  group_key       text not null,
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  not_before      timestamptz,
  attempts        integer not null default 0,
  last_error      text,
  sent_at         timestamptz,
  email_log_id    uuid,
  created_at      timestamptz not null default now()
);
create index notification_deliveries_due_idx on public.notification_deliveries (channel, status, not_before);
create index notification_deliveries_group_idx on public.notification_deliveries (channel, group_key, sent_at desc);
alter table public.notification_deliveries enable row level security;
-- Only the Edge Function (service role) reads and writes deliveries.

create or replace function public.notifications_set_in_app()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.in_app := public.notification_mode(new.user_email, new.kind, 'app') = 'on';
  return new;
end;
$$;
create trigger notifications_set_in_app before insert on public.notifications
  for each row execute function public.notifications_set_in_app();

create or replace function public.notifications_route()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_channel  record;
  v_mode     text;
  v_group    text := new.user_email || '|' || coalesce('card:' || new.card_id::text, 'n:' || new.id::text);
  v_settings jsonb := coalesce((select value from public.app_settings where key = 'email'), '{}'::jsonb);
  v_throttle interval := make_interval(mins => coalesce((v_settings ->> 'throttle_minutes')::int, 10));
  v_gather   interval := make_interval(mins => coalesce((v_settings ->> 'group_minutes')::int, 2));
  v_last     timestamptz;
begin
  for v_channel in select channel from public.notification_channels where enabled and channel <> 'app' loop
    v_mode := public.notification_mode(new.user_email, new.kind, v_channel.channel);
    continue when v_mode = 'off';
    if v_channel.channel = 'email' and v_mode = 'instant' then
      -- Group rapid changes; never more than one email per person and card per 10 minutes.
      select max(sent_at) into v_last from public.notification_deliveries
       where channel = 'email' and group_key = v_group and status = 'sent';
      insert into public.notification_deliveries (notification_id, user_email, channel, mode, group_key, not_before)
      values (new.id, new.user_email, 'email', 'instant', v_group,
              greatest(now() + v_gather, coalesce(v_last + v_throttle, now())));
    elsif v_channel.channel = 'email' then
      insert into public.notification_deliveries (notification_id, user_email, channel, mode, group_key, not_before)
      values (new.id, new.user_email, 'email', 'digest', new.user_email || '|digest', null);
    else
      insert into public.notification_deliveries (notification_id, user_email, channel, mode, group_key, not_before)
      values (new.id, new.user_email, v_channel.channel, 'instant', v_group, now());
    end if;
  end loop;
  return null;
end;
$$;
create trigger notifications_route after insert on public.notifications
  for each row execute function public.notifications_route();

-- Settings → Notifications: "Send Me a Test Notification" (goes through every channel I chose).
create or replace function public.send_me_test_notification()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_allowed_user() then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  perform public.require_perm('settings.notification_channels', 'view');
  insert into public.notifications (user_email, kind, title, body, link)
  values (public.current_user_email(), 'test', 'Test notification',
          'This is a test message from the Order Tracker. Your notification settings are working.', '/settings');
end;
$$;

-- Due soon / overdue can now also run from the automatic job (no login).
create or replace function public.board_due_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'America/Halifax')::date;
  v_card  record;
  v_count integer := 0;
begin
  -- Signed-in people (the app) and the automatic job (no login) may run it.
  if not public.is_allowed_user() and not public.is_service_caller() then return 0; end if;
  for v_card in
    select c.id, c.title, c.stage_id, c.due_date, b.name as board_name, b.due_soon_days,
           coalesce((select array_agg(a.user_email) from public.board_card_assignees a where a.card_id = c.id), '{}') as assignees
      from public.board_cards c join public.boards b on b.id = c.board_id
     where not c.archived and not b.archived and c.finished_at is null and c.due_date is not null
       and c.due_date <= v_today + b.due_soon_days
       and exists (select 1 from public.board_notify_rules r where r.board_id = b.id and r.event in ('due_soon', 'overdue'))
  loop
    if v_card.due_date < v_today then
      perform public.board_notify(v_card.id, 'overdue', v_card.stage_id,
        'Overdue · ' || v_card.board_name, v_card.title || ' was due ' || to_char(v_card.due_date, 'Mon FMDD'),
        v_card.assignees, 'overdue:' || v_card.id || ':' || v_card.due_date);
    else
      perform public.board_notify(v_card.id, 'due_soon', v_card.stage_id,
        'Due ' || case when v_card.due_date = v_today then 'today' else to_char(v_card.due_date, 'Mon FMDD') end || ' · ' || v_card.board_name,
        v_card.title, v_card.assignees, 'due_soon:' || v_card.id || ':' || v_card.due_date);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ===========================================================================
-- 4. Phones and browsers that accept push
-- ===========================================================================
create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_email   text not null default public.current_user_email()
               references public.allowed_users (email) on delete cascade on update cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  device_name  text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  failed_count integer not null default 0
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_email);
alter table public.push_subscriptions enable row level security;
create policy "Own devices" on public.push_subscriptions
  for select to authenticated using (user_email = (select public.current_user_email()));
create policy "Own devices: add" on public.push_subscriptions
  for insert to authenticated
  with check (user_email = (select public.current_user_email()) and (select public.has_perm('settings.push', 'edit')));
create policy "Own devices: change" on public.push_subscriptions
  for update to authenticated
  using (user_email = (select public.current_user_email())) with check (user_email = (select public.current_user_email()));
create policy "Own devices: remove" on public.push_subscriptions
  for delete to authenticated using (user_email = (select public.current_user_email()));

-- ===========================================================================
-- 5. Email log
-- ===========================================================================
create table public.email_log (
  id               uuid primary key default gen_random_uuid(),
  to_email         text not null,
  subject          text not null,
  html             text,
  body_text        text,
  kind             text not null default 'notification' check (kind in ('notification', 'digest', 'test', 'resend')),
  status           text not null check (status in ('sent', 'failed')),
  error            text,
  saved_to_sent    boolean,
  notification_ids uuid[] not null default '{}',
  resend_of        uuid references public.email_log (id) on delete set null,
  created_by       text,
  created_at       timestamptz not null default now()
);
create index email_log_created_idx on public.email_log (created_at desc);
alter table public.email_log enable row level security;
create policy "Email log readers" on public.email_log
  for select to authenticated using ((select public.has_perm('admin.email_log', 'view')));
-- Written only by the Edge Function (service role).

-- ===========================================================================
-- 6. Settings and the automatic sender
-- ===========================================================================
insert into public.app_settings (key, value) values
  ('email', '{"digest_hour": 7, "throttle_minutes": 10, "group_minutes": 2}')
on conflict (key) do nothing;

drop policy "Admins can change" on public.app_settings;
create policy "Admins can change" on public.app_settings
  for all to authenticated
  using ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company')))
         or (key = 'stage_labels' and (select public.can_admin('stages')))
         or (key = 'order_defaults' and (select public.can_admin('order_defaults')))
         or (key = 'scheduling' and (select public.can_admin('scheduling')))
         or (key = 'email' and (select public.can_admin('email'))))
  with check ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company')))
         or (key = 'stage_labels' and (select public.can_admin('stages')))
         or (key = 'order_defaults' and (select public.can_admin('order_defaults')))
         or (key = 'scheduling' and (select public.can_admin('scheduling')))
         or (key = 'email' and (select public.can_admin('email'))));

-- A random key only the database scheduler and the Edge Function know.
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
create table app_private.dispatch_key (
  id  boolean primary key default true check (id),
  key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
insert into app_private.dispatch_key default values on conflict do nothing;

create or replace function public.check_dispatch_key(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, app_private
as $$
  select exists (select 1 from app_private.dispatch_key where key = p_key);
$$;

-- The scheduler: needs the pg_cron and pg_net extensions (Database → Extensions).
-- (If Supabase refuses here, switch them on in Database → Extensions; this step still finishes.)
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net could not be switched on here: %. Switch it on in Database → Extensions.', sqlerrm;
end $$;
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron could not be switched on here: %. Switch it on in Database → Extensions.', sqlerrm;
end $$;

-- Admin → Email → "Turn On Automatic Sending": every minute the database asks
-- the Edge Function to send what is due; every 10 minutes it checks due dates.
create or replace function public.start_email_schedule(p_supabase_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := rtrim(btrim(p_supabase_url), '/') || '/functions/v1/send-email';
begin
  perform public.require_admin_area('email');
  if p_supabase_url !~ '^https://[a-z0-9.-]+$' then
    raise exception 'The Supabase address looks wrong: %', p_supabase_url using errcode = '22023';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Turn on the pg_cron and pg_net extensions first (Supabase → Database → Extensions).' using errcode = '55000';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications');
  perform cron.schedule('send-notifications', '* * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "dispatch"}'::jsonb, timeout_milliseconds := 55000)$job$,
    v_url));
  perform cron.schedule('board-due-notifications', '*/10 * * * *', 'select public.board_due_notifications()');
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned on', 'url', v_url));
end;
$$;

create or replace function public.stop_email_schedule()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('email');
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications');
  end if;
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned off'));
end;
$$;

-- For Admin → Email: is automatic sending on, and how did the last runs go?
create or replace function public.email_schedule_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_on   boolean := false;
  v_last jsonb;
begin
  perform public.require_admin_area('email');
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    select count(*) > 0 into v_on from cron.job where jobname = 'send-notifications';
    select jsonb_build_object('at', d.start_time, 'status', d.status, 'message', d.return_message) into v_last
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
     where j.jobname = 'send-notifications' order by d.start_time desc limit 1;
  end if;
  return jsonb_build_object(
    'scheduled', v_on,
    'last_run', v_last,
    'pending_email', (select count(*) from public.notification_deliveries where channel = 'email' and status = 'pending'),
    'pending_push', (select count(*) from public.notification_deliveries where channel = 'push' and status = 'pending'),
    'failed_today', (select count(*) from public.email_log where status = 'failed' and created_at > now() - interval '1 day'));
end;
$$;

-- Access lockdown, as in earlier migrations, then the exceptions.
revoke all on public.notification_kinds, public.notification_channels, public.notification_settings,
  public.notification_deliveries, public.push_subscriptions, public.email_log from anon;
revoke insert, update, delete on public.notification_deliveries, public.email_log,
  public.notification_kinds, public.notification_channels from authenticated;
revoke select on public.notification_deliveries from authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
grant execute on function public.admin_auth_user_id(text) to service_role;
revoke execute on function public.check_dispatch_key(text) from authenticated;
grant execute on function public.check_dispatch_key(text) to service_role;
