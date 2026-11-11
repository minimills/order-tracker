-- 0036_layout_theme_status.sql
-- 1. Each person's look: theme (Light / Dark / System), the sidebar collapsed
--    or not, and whether desktop notifications are shown at all. Saved per
--    person with set_my_preferences().
-- 2. "Desktop" notifications: a fourth choice per notification type in
--    Settings → Notifications. The open app shows them as computer
--    notifications; nothing is sent by the server (so the email / push sender
--    ignores this channel).
-- 3. Admin → System Status: health of the database, email, phone push,
--    scheduled jobs and calendar sync, database statistics, active users
--    today and recent errors (system_status()). The free-plan limits used for
--    the "storage used" bars are in app_settings key 'system'.

-- ===========================================================================
-- 1. Personal look
-- ===========================================================================
alter table public.user_preferences
  add column theme text not null default 'system' check (theme in ('light', 'dark', 'system')),
  add column sidebar_collapsed boolean not null default false,
  add column desktop_notifications boolean not null default true;

-- p: any of {"theme": "light|dark|system", "sidebar_collapsed": bool, "desktop_notifications": bool}
create or replace function public.set_my_preferences(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  if not public.is_allowed_user() then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  if p ? 'theme' then
    perform public.require_perm('settings.theme');
    if p ->> 'theme' not in ('light', 'dark', 'system') then
      raise exception 'Choose Light, Dark or System.' using errcode = '22023';
    end if;
  end if;
  if p ? 'desktop_notifications' then
    perform public.require_perm('settings.notifications', 'view');
  end if;
  insert into public.user_preferences (user_email) values (v_me) on conflict (user_email) do nothing;
  update public.user_preferences
     set theme = case when p ? 'theme' then p ->> 'theme' else theme end,
         sidebar_collapsed = case when p ? 'sidebar_collapsed' then (p ->> 'sidebar_collapsed')::boolean else sidebar_collapsed end,
         desktop_notifications = case when p ? 'desktop_notifications' then (p ->> 'desktop_notifications')::boolean else desktop_notifications end
   where user_email = v_me;
end;
$$;

-- ===========================================================================
-- 2. Desktop notifications (shown by the open app)
-- ===========================================================================
insert into public.notification_channels (channel, label, sort_order) values ('desktop', 'Desktop', 4)
on conflict (channel) do nothing;
-- Desktop follows each type's phone push default.
update public.notification_kinds
   set default_modes = default_modes || jsonb_build_object('desktop', coalesce(default_modes ->> 'push', 'off'))
 where not default_modes ? 'desktop';

alter table public.notifications add column desktop boolean not null default false;

create or replace function public.notifications_set_in_app()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.in_app := public.notification_mode(new.user_email, new.kind, 'app') = 'on';
  new.desktop := public.notification_mode(new.user_email, new.kind, 'desktop') = 'on';
  return new;
end;
$$;

-- Routing: the server sends email and push only; app and desktop are shown by the app.
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
  for v_channel in select channel from public.notification_channels where enabled and channel not in ('app', 'desktop') loop
    v_mode := public.notification_mode(new.user_email, new.kind, v_channel.channel);
    continue when v_mode = 'off';
    if v_channel.channel = 'email' and v_mode = 'instant' then
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

-- ===========================================================================
-- 3. System status (Admin → System Status)
-- ===========================================================================
insert into public.app_settings (key, value)
values ('system', '{"db_limit_mb": 500, "storage_limit_mb": 1024}'::jsonb)
on conflict (key) do nothing;

-- Only System Status admins change the plan limits.
create or replace function public.set_system_limits(p_db_mb integer, p_storage_mb integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('status');
  if p_db_mb not between 100 and 10000000 or p_storage_mb not between 100 and 100000000 then
    raise exception 'Enter sizes in MB (at least 100).' using errcode = '22023';
  end if;
  insert into public.app_settings (key, value)
  values ('system', jsonb_build_object('db_limit_mb', p_db_mb, 'storage_limit_mb', p_storage_mb))
  on conflict (key) do update set value = public.app_settings.value || excluded.value;
end;
$$;

create or replace function public.system_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today   timestamptz := (public.halifax_today()::timestamp at time zone 'America/Halifax');
  v_jobs    jsonb := '[]'::jsonb;
  v_cron    boolean := exists (select 1 from pg_extension where extname = 'pg_cron');
  v_net     boolean := exists (select 1 from pg_extension where extname = 'pg_net');
  v_storage bigint := 0;
  v_signins integer := 0;
  v_errors  jsonb;
begin
  perform public.require_admin_area('status');

  if v_cron then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', j.jobname, 'schedule', j.schedule, 'active', j.active,
               'last_run', r.start_time, 'last_status', r.status, 'last_message', left(r.return_message, 300),
               'failed_24h', (select count(*) from cron.job_run_details f
                               where f.jobid = j.jobid and f.status = 'failed' and f.start_time > now() - interval '1 day'))
             order by j.jobname), '[]'::jsonb)
        from cron.job j
        left join lateral (select d.start_time, d.status, d.return_message from cron.job_run_details d
                            where d.jobid = j.jobid order by d.start_time desc limit 1) r on true
    $q$ into v_jobs;
  end if;

  begin
    execute $q$select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects$q$ into v_storage;
  exception when others then
    v_storage := 0;
  end;
  begin
    execute 'select count(*)::integer from auth.users where last_sign_in_at >= $1' into v_signins using v_today;
  exception when others then
    v_signins := 0;
  end;

  select coalesce(jsonb_agg(e order by e ->> 'at' desc), '[]'::jsonb) into v_errors
    from (
      (select jsonb_build_object('at', l.created_at, 'source', 'Email', 'message', coalesce(l.error, 'Email could not be sent') || ' (' || l.to_email || ')') as e
         from public.email_log l where l.status = 'failed' order by l.created_at desc limit 10)
      union all
      (select jsonb_build_object('at', d.created_at, 'source', 'Phone push', 'message', coalesce(d.last_error, 'Push could not be sent'))
         from public.notification_deliveries d where d.channel = 'push' and d.status = 'failed' order by d.created_at desc limit 10)
      union all
      (select jsonb_build_object('at', c.last_attempt_at, 'source', 'Calendar sync', 'message', coalesce(c.last_error, 'Calendar could not be read') || ' (' || c.user_email || ')')
         from public.calendar_imports c where c.status = 'error' order by c.last_attempt_at desc nulls last limit 10)
      union all
      (select jsonb_build_object('at', r ->> 'last_run', 'source', 'Scheduled job', 'message', (r ->> 'name') || ': ' || coalesce(r ->> 'last_message', 'failed'))
         from jsonb_array_elements(v_jobs) r where r ->> 'last_status' = 'failed')
    ) x
   limit 20;

  return jsonb_build_object(
    'checked_at', now(),
    'database', jsonb_build_object('version', current_setting('server_version'), 'size', pg_database_size(current_database())),
    'extensions', jsonb_build_object('pg_cron', v_cron, 'pg_net', v_net),
    'email', jsonb_build_object(
      'sent_24h', (select count(*) from public.email_log where status = 'sent' and created_at > now() - interval '1 day'),
      'failed_24h', (select count(*) from public.email_log where status = 'failed' and created_at > now() - interval '1 day'),
      'waiting', (select count(*) from public.notification_deliveries where channel = 'email' and status = 'pending'
                   and mode = 'instant' and not_before < now() - interval '15 minutes'),
      'last_sent_at', (select max(created_at) from public.email_log where status = 'sent'),
      'ever_sent', exists (select 1 from public.email_log where status = 'sent')),
    'push', jsonb_build_object(
      'sent_24h', (select count(*) from public.notification_deliveries where channel = 'push' and status = 'sent' and sent_at > now() - interval '1 day'),
      'failed_24h', (select count(*) from public.notification_deliveries where channel = 'push' and status = 'failed' and created_at > now() - interval '1 day'),
      'waiting', (select count(*) from public.notification_deliveries where channel = 'push' and status = 'pending' and created_at < now() - interval '15 minutes'),
      'devices', (select count(*) from public.push_subscriptions),
      'last_sent_at', (select max(sent_at) from public.notification_deliveries where channel = 'push' and status = 'sent')),
    'jobs', v_jobs,
    'calendar', jsonb_build_object(
      'links', (select count(*) from public.calendar_imports),
      'ok', (select count(*) from public.calendar_imports where status = 'ok'),
      'errors', (select count(*) from public.calendar_imports where status = 'error'),
      'last_synced_at', (select max(last_synced_at) from public.calendar_imports)),
    'storage', jsonb_build_object('files_size', v_storage),
    'limits', coalesce((select value from public.app_settings where key = 'system'), '{}'::jsonb),
    'users', jsonb_build_object(
      'total', (select count(*) from public.allowed_users),
      'signed_in_today', v_signins,
      'active_today', (select count(distinct user_email) from public.activity_log where at >= v_today and user_email is not null)),
    'tables', (select coalesce(jsonb_agg(jsonb_build_object('name', t.relname, 'rows', t.n_live_tup,
                                                         'size', pg_total_relation_size(t.relid)) order by pg_total_relation_size(t.relid) desc), '[]'::jsonb)
                 from pg_stat_user_tables t where t.schemaname = 'public'),
    'errors', v_errors);
end;
$$;

-- Access lockdown, as in earlier migrations.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
revoke execute on function public.calendar_rows(text, date, date, boolean) from authenticated;
revoke execute on function public.calendar_feed(text) from authenticated;
grant execute on function public.calendar_feed(text) to service_role;
