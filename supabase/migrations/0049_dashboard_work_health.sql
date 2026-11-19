-- 0049 Dashboard: "My Work" widget and good / bad colours
--
-- 1. Good and bad colours: app_settings.dashboard_charts gains `health`
--    {widget key: {direction low | high | none, good, bad}} (Admin → Dashboard
--    Charts). set_dashboard_chart_settings checks it. A widget can also carry
--    its own `health` in the dashboard's widgets (Widget Settings).
-- 2. Live updates for "My Work": checklist tasks, timer pauses and card
--    assignments are added to Supabase Realtime (row security still decides
--    what each person receives). Start / Pause / Finish use the existing
--    board_cards / board_checklist_items guards and pause_board_timer /
--    resume_board_timer, so nothing else changes in the database.
-- 3. Access lockdown.

-- ===========================================================================
-- 1. Good and bad colours
-- ===========================================================================
create or replace function public.set_dashboard_chart_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := coalesce((select value from public.app_settings where key = 'dashboard_charts'), '{}'::jsonb) || coalesce(p, '{}'::jsonb);
  t record;
begin
  perform public.require_admin_area('dashboard_charts');
  if jsonb_typeof(v -> 'targets') <> 'object' or jsonb_typeof(v -> 'defaults') <> 'array' then
    raise exception 'The chart settings are not complete.' using errcode = '22023';
  end if;
  for t in select key, value from jsonb_each(v -> 'targets') loop
    if coalesce(t.value ->> 'good', '') not in ('low', 'high')
       or (t.value ->> 'green') is null or (t.value ->> 'amber') is null or coalesce((t.value ->> 'max')::numeric, 0) <= 0 then
      raise exception 'Enter the green and amber limits and the top of the scale for every gauge.' using errcode = '22023';
    end if;
  end loop;
  if v ? 'health' then
    if jsonb_typeof(v -> 'health') <> 'object' then
      raise exception 'The good and bad colours are not complete.' using errcode = '22023';
    end if;
    for t in select key, value from jsonb_each(v -> 'health') loop
      if jsonb_typeof(t.value) <> 'object'
         or coalesce(t.value ->> 'direction', '') not in ('low', 'high', 'none')
         or jsonb_typeof(t.value -> 'good') <> 'number' or jsonb_typeof(t.value -> 'bad') <> 'number' then
        raise exception 'Enter a direction and a green and red limit for every widget with good and bad colours.' using errcode = '22023';
      end if;
    end loop;
  end if;
  insert into public.app_settings (key, value) values ('dashboard_charts', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'dashboard_charts', null, jsonb_build_object('action', 'Dashboard chart settings changed'));
end;
$$;

-- ===========================================================================
-- 2. Live updates for "My Work"
-- ===========================================================================
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['board_checklist_items', 'board_time_pauses', 'board_card_assignees'] loop
      if to_regclass('public.' || t) is not null and not exists (
           select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- ===========================================================================
-- 3. Access lockdown
-- ===========================================================================
-- Full lockdown block (see CLAUDE.md, BOARDS UPGRADE).
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
grant execute on function public.admin_auth_user_id(text) to service_role;
revoke execute on function public.check_dispatch_key(text) from authenticated;
grant execute on function public.check_dispatch_key(text) to service_role;
revoke execute on function public.system_on(), public.production_split_leftovers(uuid, uuid),
  public.production_merge_leftover(uuid, text), public.production_card_entered(uuid),
  public.production_refresh_due(uuid, uuid) from authenticated;
revoke execute on function public.calendar_rows(text, date, date, boolean) from authenticated;
revoke execute on function public.calendar_feed(text) from authenticated;
grant execute on function public.calendar_feed(text) to service_role;
revoke execute on function public.apply_phone_events(text, text, jsonb, text) from authenticated;
grant execute on function public.apply_phone_events(text, text, jsonb, text) to service_role;
revoke execute on function public.calendar_imports_due(text) from authenticated;
grant execute on function public.calendar_imports_due(text) to service_role;
revoke execute on function public.chat_sync_department(uuid), public.chat_sync_user_group(uuid), public.chat_find_links(text),
  public.in_quiet_hours(text, timestamptz) from authenticated;
revoke execute on function public.use_saved_signature(uuid, text, text) from authenticated;
revoke execute on function public.closure_alert_notify(uuid, text, text) from authenticated;
revoke execute on function public.build_summary(text, text, date), public.post_summary(text, text, date, boolean),
  public.daily_summary_tick(), public.rename_user_email(text, text), public.apply_email_change(uuid),
  public.notify_user_managers(text, text, text), public.auth_email_changed() from authenticated;
-- Timesheets internals: only inside the functions above.
revoke execute on function public.pay_rate_on(uuid, date), public.ts_managers_of(uuid),
  public.ts_week_id(uuid, date), public.ts_log(uuid, text, jsonb, text) from authenticated;
-- Dashboards internals: only inside the functions above.
revoke execute on function public.dashboard_template_people(uuid), public.dashboard_copy_template(uuid, text) from authenticated;
