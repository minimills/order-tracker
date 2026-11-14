-- 0041 Service / Training and the technician calendar
--
-- 1. Service calls: moving a call into the last stage of the Service Calls board
--    ("Done") completes its card (finish time stamped, so it is never overdue);
--    moving it out again reopens the card.
-- 2. Email templates (Admin → Email Templates): default subject and CC for the
--    commissioning certificate and service report emails. certificate_sends also
--    records CC, BCC and the subject.
-- 3. Technician calendar: own entries can have a start and end time (or stay
--    all-day) and a title; phone entries keep their end time. calendar_rows /
--    calendar_entries / calendar_feed return end_at.
-- 4. The linked phone calendars ("to app") are read every 5 minutes.
-- 5. Access lockdown.

-- ===========================================================================
-- 1. Service call Done = card complete
-- ===========================================================================
-- Runs after board_cards_guard and board_cards_zzz_service (alphabetical order).
create or replace function public.board_cards_zzzz_service_done()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last uuid;
begin
  if new.card_kind is distinct from 'service' then return new; end if;
  if tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id then return new; end if;
  select s.id into v_last from public.board_stages s
   where s.board_id = new.board_id and not s.archived
   order by s.sort_order desc, s.id desc limit 1;
  if new.stage_id = v_last then
    if new.finished_at is null then
      if new.started_at is null then
        new.started_at := now(); new.started_by := public.current_user_email(); new.started_by_name := public.current_user_name();
      end if;
      new.finished_at := now(); new.finished_by := public.current_user_email(); new.finished_by_name := public.current_user_name();
    end if;
  elsif tg_op = 'UPDATE' and old.stage_id = v_last and new.finished_at is not null then
    -- Taken out of Done: the call is open again.
    new.finished_at := null; new.finished_by := null; new.finished_by_name := null;
  end if;
  return new;
end;
$$;
create trigger board_cards_zzzz_service_done before insert or update of stage_id on public.board_cards
  for each row execute function public.board_cards_zzzz_service_done();

-- Calls already in Done: complete their cards now.
do $$
begin
  perform set_config('app.system_change', 'on', true);
  update public.board_cards c
     set started_at = coalesce(c.started_at, c.updated_at, now()),
         finished_at = coalesce(c.updated_at, now()),
         finished_by_name = coalesce(c.finished_by_name, 'Marked complete when moved to the last stage')
   where c.card_kind = 'service' and c.finished_at is null and not c.archived
     and c.stage_id = (select s.id from public.board_stages s
                        where s.board_id = c.board_id and not s.archived
                        order by s.sort_order desc, s.id desc limit 1);
  perform set_config('app.system_change', '', true);
end;
$$;

-- ===========================================================================
-- 2. Email templates for certificates and service reports
-- ===========================================================================
insert into public.app_settings (key, value) values ('email_templates', jsonb_build_object(
  'certificate_subject', 'Commissioning Certificate Belfast Mini Mills – {customer_company}',
  'certificate_cc', '{office_email}',
  'service_report_subject', 'Service Report Belfast Mini Mills – {customer_company}',
  'service_report_cc', '{office_email}'))
on conflict (key) do nothing;

create or replace function public.set_email_templates(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := coalesce((select value from public.app_settings where key = 'email_templates'), '{}'::jsonb) || coalesce(p, '{}'::jsonb);
  v_key text;
  v_addr text;
begin
  perform public.require_admin_area('email_templates');
  foreach v_key in array array['certificate_subject', 'service_report_subject'] loop
    if length(btrim(coalesce(v ->> v_key, ''))) = 0 then
      raise exception 'Enter a subject for each email.' using errcode = '22023';
    end if;
    if length(v ->> v_key) > 300 then
      raise exception 'A subject can have at most 300 characters.' using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array array['certificate_cc', 'service_report_cc'] loop
    for v_addr in select x from regexp_split_to_table(coalesce(v ->> v_key, ''), '[,;\s]+') x where x <> '' loop
      if v_addr <> '{office_email}' and v_addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'Check this CC address: %', v_addr using errcode = '22023';
      end if;
    end loop;
  end loop;
  insert into public.app_settings (key, value) values ('email_templates', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'email_templates', null, jsonb_build_object('action', 'Email templates changed'));
end;
$$;

alter table public.certificate_sends
  add column cc_emails  text[] not null default '{}',
  add column bcc_emails text[] not null default '{}',
  add column subject    text;

-- ===========================================================================
-- 3. Technician calendar: times, titles and end times
-- ===========================================================================
alter table public.tech_calendar_entries
  add column title     text,
  add column all_day   boolean not null default true,
  add column starts_at timestamptz,
  add column ends_at   timestamptz,
  add constraint tech_calendar_entries_times check (all_day or (starts_at is not null and ends_at is not null and ends_at > starts_at)),
  add constraint tech_calendar_entries_title check (title is null or length(title) <= 200);
grant select, insert, update (title, all_day, starts_at, ends_at) on public.tech_calendar_entries to authenticated;

-- A timed entry's dates follow its times (Halifax); an all-day entry has no times.
create or replace function public.tech_calendar_entries_fill()
returns trigger
language plpgsql
as $$
begin
  if new.all_day then
    new.starts_at := null;
    new.ends_at := null;
  elsif new.starts_at is not null and new.ends_at is not null then
    new.start_date := (new.starts_at at time zone 'America/Halifax')::date;
    new.end_date := greatest(new.start_date, ((new.ends_at - interval '1 second') at time zone 'America/Halifax')::date);
  end if;
  new.title := nullif(btrim(new.title), '');
  return new;
end;
$$;
create trigger tech_calendar_entries_fill before insert or update on public.tech_calendar_entries
  for each row execute function public.tech_calendar_entries_fill();

-- Phone entries keep their end time.
alter table public.tech_phone_events add column end_at timestamptz;

create or replace function public.apply_phone_events(p_email text, p_url text, p_events jsonb, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_imp   public.calendar_imports%rowtype;
  v_added integer;
  v_gone  integer;
begin
  select * into v_imp from public.calendar_imports where user_email = p_email for update;
  -- The link was removed or replaced while it was being read.
  if v_imp.user_email is null or v_imp.url <> p_url then
    return jsonb_build_object('skipped', true);
  end if;
  if p_error is not null then
    update public.calendar_imports
       set status = 'error', last_error = left(p_error, 500), failures = failures + 1, last_attempt_at = now()
     where user_email = p_email;
    return jsonb_build_object('error', p_error);
  end if;

  with incoming as (
    select distinct on (e ->> 'key')
           e ->> 'key' as event_key, left(coalesce(nullif(btrim(e ->> 'title'), ''), '(no title)'), 300) as title,
           left(nullif(btrim(e ->> 'location'), ''), 300) as location, left(nullif(btrim(e ->> 'description'), ''), 2000) as description,
           coalesce((e ->> 'all_day')::boolean, true) as all_day, nullif(e ->> 'start_at', '')::timestamptz as start_at,
           nullif(e ->> 'end_at', '')::timestamptz as end_at,
           (e ->> 'start_date')::date as start_date, greatest((e ->> 'end_date')::date, (e ->> 'start_date')::date) as end_date
      from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
     where nullif(e ->> 'key', '') is not null and nullif(e ->> 'start_date', '') is not null
  ), up as (
    insert into public.tech_phone_events as t (user_email, event_key, title, location, description, all_day, start_at, end_at, start_date, end_date, kind)
    select p_email, i.event_key, i.title, i.location, i.description, i.all_day, i.start_at, i.end_at, i.start_date, i.end_date,
           public.guess_phone_event_kind(i.title)
      from incoming i
    on conflict (user_email, event_key) do update
      set title = excluded.title, location = excluded.location, description = excluded.description,
          all_day = excluded.all_day, start_at = excluded.start_at, end_at = excluded.end_at,
          start_date = excluded.start_date, end_date = excluded.end_date,
          -- the office's type stays; a guessed type follows the new title
          kind = case when t.kind_set_by is null then excluded.kind else t.kind end
      where (t.title, t.location, t.description, t.all_day, t.start_at, t.end_at, t.start_date, t.end_date)
            is distinct from (excluded.title, excluded.location, excluded.description, excluded.all_day, excluded.start_at, excluded.end_at, excluded.start_date, excluded.end_date)
    returning 1
  )
  select count(*) into v_added from up;
  -- Gone from the phone calendar = gone from the app.
  delete from public.tech_phone_events t
   where t.user_email = p_email
     and not exists (select 1 from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e where e ->> 'key' = t.event_key);
  get diagnostics v_gone = row_count;
  update public.calendar_imports
     set status = 'ok', last_error = null, failures = 0, last_synced_at = now(), last_attempt_at = now(),
         event_count = (select count(*) from public.tech_phone_events where user_email = p_email)
   where user_email = p_email;
  return jsonb_build_object('changed', v_added, 'removed', v_gone);
end;
$$;

-- The calendar rows gain end_at (timed entries).
drop function public.calendar_entries(date, date, text);
drop function public.calendar_feed(text);
drop function public.calendar_rows(text, date, date, boolean);

create function public.calendar_rows(p_tech text, p_from date, p_to date, p_with_phone boolean)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text, end_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with rows as (
    select 'training'::text as source, o.id::text as source_id, o.technician_email as tech_email, 'training'::text as kind,
           o.service_start as start_date, coalesce(o.service_end, o.service_start) as end_date,
           'Training – ' || coalesce(c.name, 'customer') || ' (Order ' || o.order_code || ')' as title,
           c.name as customer, c.country, null::text as notes, '/service/' || o.id as link,
           false as from_phone, null::timestamptz as start_at, null::text as location, null::timestamptz as end_at
      from public.orders o left join public.customers c on c.id = o.customer_id
     where o.technician_email is not null and o.service_start is not null and not o.archived and o.stage <> 'Cancelled'
    union all
    select 'service_call', sc.card_id::text, sc.technician_email, 'service',
           sc.planned_start, coalesce(sc.planned_end, sc.planned_start),
           'Service call S-' || sc.call_number || ' – ' || coalesce(cu.name, bc.title),
           cu.name, cu.country, bc.title, '/service/calls/' || sc.card_id,
           false, null, null, null
      from public.service_calls sc
      join public.board_cards bc on bc.id = sc.card_id and not bc.archived
      left join public.customers cu on cu.id = sc.customer_id
     where sc.technician_email is not null and sc.planned_start is not null
    union all
    select 'travel_log', e.id::text, e.created_by, 'travel', e.entry_date, e.entry_date,
           'Travel – ' || coalesce(cu.name, 'customer'), cu.name, cu.country, e.notes,
           case when e.order_id is not null then '/service/' || e.order_id else '/service/calls/' || e.service_call_id end,
           false, null, null, null
      from public.service_entries e
      left join public.orders o on o.id = e.order_id
      left join public.service_calls sc on sc.card_id = e.service_call_id
      left join public.customers cu on cu.id = coalesce(o.customer_id, sc.customer_id)
     where e.kind = 'travel' and not e.archived and e.created_by is not null
    union all
    select 'manual', t.id::text, t.tech_email, t.kind, t.start_date, t.end_date,
           coalesce(t.title,
             (case when t.kind = 'travel' then 'Travel' else 'On site' end) || coalesce(' – ' || coalesce(cu.name, nullif(btrim(t.customer_text), '')), '')),
           coalesce(cu.name, nullif(btrim(t.customer_text), '')), cu.country, t.notes, null::text,
           false, case when t.all_day then null else t.starts_at end, null, case when t.all_day then null else t.ends_at end
      from public.tech_calendar_entries t left join public.customers cu on cu.id = t.customer_id
     where not t.archived
    union all
    -- Read from the technician's own phone calendar ("From phone"); never sent back out.
    select 'phone', p.id::text, p.user_email, p.kind, p.start_date, p.end_date,
           p.title, coalesce(cu.name, cu2.name), coalesce(cu.country, cu2.country), p.description,
           case when p.order_id is not null then '/service/' || p.order_id end,
           true, case when p.all_day then null else p.start_at end, p.location, case when p.all_day then null else p.end_at end
      from public.tech_phone_events p
      left join public.customers cu on cu.id = p.customer_id
      left join public.orders o on o.id = p.order_id
      left join public.customers cu2 on cu2.id = o.customer_id
     where p_with_phone
  )
  select r.source, r.source_id, r.tech_email,
         (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = r.tech_email),
         r.kind, r.start_date, r.end_date, r.title, r.customer, r.country, r.notes, r.link, r.from_phone, r.start_at, r.location, r.end_at
    from rows r
   where (p_tech is null or r.tech_email = p_tech)
     and r.start_date <= p_to and r.end_date >= p_from
   order by r.start_date, r.start_at nulls first, r.tech_email, r.title;
$$;

-- What the Technician Calendar shows (copy of 0035 + end_at).
create function public.calendar_entries(p_from date, p_to date, p_tech text default null)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text, end_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_perm('service.calendar', 'view');
  if p_tech is distinct from public.current_user_email() then
    perform public.require_perm('service.calendar.all', 'view');
  end if;
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a shorter period.';
  end if;
  return query
    select * from public.calendar_rows(lower(p_tech), p_from, p_to, true)
    union all
    select 'event'::text, e.id::text, null::text, null::text, 'event'::text, e.start_date, e.end_date,
           e.title, null::text, null::text, e.description_text, '/notices?event=' || e.id,
           false, e.starts_at, e.location, e.ends_at
      from public.company_events e
     where not e.archived and e.start_date <= p_to and e.end_date >= p_from
       and (p_tech is null or lower(p_tech) = public.current_user_email())
       and public.has_perm('notices.events', 'view')
       and public.event_is_for(e.id, public.current_user_email())
    order by 6, 14 nulls first, 3, 8;
end;
$$;

-- Outgoing phone link (calendar-feed): app entries only, never what came from the phone.
create function public.calendar_feed(p_token text)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text, end_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select user_email into v_email from public.calendar_feeds f
   where f.token = p_token and length(p_token) >= 32
     and exists (select 1 from public.allowed_users a where a.email = f.user_email);
  if v_email is null then return; end if;
  update public.calendar_feeds set last_used_at = now() where user_email = v_email;
  return query select * from public.calendar_rows(v_email, current_date - 120, current_date + 400, false);
end;
$$;

-- ===========================================================================
-- 4. Linked phone calendars are read every 5 minutes (copy of 0034)
-- ===========================================================================
create or replace function public.start_email_schedule(p_supabase_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := rtrim(btrim(p_supabase_url), '/') || '/functions/v1/';
begin
  perform public.require_admin_area('email');
  if p_supabase_url !~ '^https://[a-z0-9.-]+$' then
    raise exception 'The Supabase address looks wrong: %', p_supabase_url using errcode = '22023';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Turn on the pg_cron and pg_net extensions first (Supabase → Database → Extensions).' using errcode = '55000';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications', 'calendar-import', 'notice-board');
  perform cron.schedule('send-notifications', '* * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "dispatch"}'::jsonb, timeout_milliseconds := 55000)$job$,
    v_base || 'send-email'));
  perform cron.schedule('board-due-notifications', '*/10 * * * *', 'select public.board_due_notifications()');
  perform cron.schedule('calendar-import', '*/5 * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "sync_all"}'::jsonb, timeout_milliseconds := 120000)$job$,
    v_base || 'calendar-import'));
  perform cron.schedule('notice-board', '* * * * *', 'select public.notice_board_tick()');
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned on', 'url', v_base));
end;
$$;

-- If automatic sending is already on, read the phone calendars every 5 minutes from now.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.alter_job(jobid, schedule := '*/5 * * * *') from cron.job where jobname = 'calendar-import';
  end if;
end;
$$;

-- ===========================================================================
-- 5. Access lockdown
-- ===========================================================================
-- Full lockdown block (see CLAUDE.md, BOARDS UPGRADE).
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
grant execute on function public.admin_auth_user_id(text) to service_role;
revoke execute on function public.check_dispatch_key(text) from authenticated;
grant execute on function public.check_dispatch_key(text) to service_role;
-- Internal helpers: only through the triggers above.
revoke execute on function public.system_on(), public.production_split_leftovers(uuid, uuid),
  public.production_merge_leftover(uuid, text), public.production_card_entered(uuid),
  public.production_refresh_due(uuid, uuid) from authenticated;
-- Internals: only through the functions above / the Edge Function.
revoke execute on function public.calendar_rows(text, date, date, boolean) from authenticated;
revoke execute on function public.calendar_feed(text) from authenticated;
grant execute on function public.calendar_feed(text) to service_role;
revoke execute on function public.apply_phone_events(text, text, jsonb, text) from authenticated;
grant execute on function public.apply_phone_events(text, text, jsonb, text) to service_role;
revoke execute on function public.calendar_imports_due(text) from authenticated;
grant execute on function public.calendar_imports_due(text) to service_role;
-- Chat internals.
revoke execute on function public.chat_sync_department(uuid), public.chat_sync_user_group(uuid), public.chat_find_links(text),
  public.in_quiet_hours(text, timestamptz) from authenticated;
-- Saved signatures are only checked inside the signing functions.
revoke execute on function public.use_saved_signature(uuid, text, text) from authenticated;
-- Closure alert notifications are only sent by the functions above.
revoke execute on function public.closure_alert_notify(uuid, text, text) from authenticated;
