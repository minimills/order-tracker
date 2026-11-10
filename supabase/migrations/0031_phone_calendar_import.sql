-- 0031: Phone calendar → app ("to app" direction of the technician calendar)
--
-- Each technician can paste a private calendar link (iCal / ICS) of a work
-- calendar on their phone (for example "BMM – to app"). Every 15 minutes the
-- Edge Function "calendar-import" reads every link and the database adds,
-- updates or removes the matching entries (tech_phone_events), shown in the
-- technician calendar as "From phone". They are read-only in the app; the
-- office can set their type (travel, on site, service call, training, other)
-- and link them to a customer or order. They are never sent back out through
-- the phone calendar link (calendar-feed), so nothing is duplicated.
--
-- Paste this whole file into the Supabase SQL Editor and click Run.

-- ===========================================================================
-- 1. Linked calendars and their entries
-- ===========================================================================
create table public.calendar_imports (
  user_email      text primary key references public.allowed_users (email) on update cascade on delete cascade,
  url             text not null check (url ~ '^https://' and length(url) <= 2000),
  status          text not null default 'pending' check (status in ('pending', 'ok', 'error')),
  last_synced_at  timestamptz,
  last_attempt_at timestamptz,
  last_error      text,
  failures        integer not null default 0,
  event_count     integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger calendar_imports_updated_at before update on public.calendar_imports
  for each row execute function public.set_updated_at();
alter table public.calendar_imports enable row level security;
-- Own link only (it is private: anyone with it can read that calendar).
create policy "Own phone calendar link" on public.calendar_imports
  for select to authenticated using (user_email = (select public.current_user_email()));
revoke insert, update, delete on public.calendar_imports from authenticated;

create table public.tech_phone_events (
  id            uuid primary key default gen_random_uuid(),
  user_email    text not null references public.allowed_users (email) on update cascade on delete cascade,
  -- the event's UID, plus the date for each repeat of a repeating event
  event_key     text not null,
  title         text not null,
  location      text,
  description   text,
  all_day       boolean not null default true,
  start_at      timestamptz,
  start_date    date not null,
  end_date      date not null check (end_date >= start_date),
  -- set by the office (kind_set_by not null), otherwise guessed from the title
  kind          text not null default 'other' check (kind in ('travel', 'onsite', 'service', 'training', 'other')),
  kind_set_by   text,
  customer_id   uuid references public.customers (id) on delete set null,
  order_id      uuid references public.orders (id) on delete set null,
  linked_by     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_email, event_key)
);
create index tech_phone_events_dates_idx on public.tech_phone_events (user_email, start_date);
create trigger tech_phone_events_updated_at before update on public.tech_phone_events
  for each row execute function public.set_updated_at();
alter table public.tech_phone_events enable row level security;
create policy "Calendar readers" on public.tech_phone_events
  for select to authenticated
  using ((select public.has_perm('service.calendar', 'view'))
         and (user_email = (select public.current_user_email()) or (select public.has_perm('service.calendar.all', 'view'))));
revoke insert, update, delete on public.tech_phone_events from authenticated;

-- Paste or replace my link. webcal:// links (Apple) are read as https://.
create or replace function public.set_my_calendar_import(p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
begin
  perform public.require_perm('service.calendar.import', 'edit');
  v_url := regexp_replace(v_url, '^webcals?://', 'https://', 'i');
  if v_url !~* '^https://[^/\s]+\.[^/\s]+/\S*$' or length(v_url) > 2000 then
    raise exception 'That does not look like a calendar link. Copy the whole link (it starts with webcal:// or https://).' using errcode = '22023';
  end if;
  if v_url ~* '^https://(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' then
    raise exception 'That link points to a private network. Use the link from Apple Calendar or Google Calendar.' using errcode = '22023';
  end if;
  insert into public.calendar_imports (user_email, url) values (public.current_user_email(), v_url)
  on conflict (user_email) do update
    set url = excluded.url, status = 'pending', last_error = null, failures = 0, last_attempt_at = null;
  insert into public.activity_log (user_id, user_email, table_name, record_id, action, changes)
  values (auth.uid(), auth.jwt() ->> 'email', 'calendar_imports', public.current_user_email(), 'update',
          jsonb_build_object('action', 'phone calendar link added or replaced'));
end;
$$;

-- Remove my link and everything read from it.
create or replace function public.remove_my_calendar_import()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('service.calendar.import', 'edit');
  delete from public.tech_phone_events where user_email = public.current_user_email();
  delete from public.calendar_imports where user_email = public.current_user_email();
  insert into public.activity_log (user_id, user_email, table_name, record_id, action, changes)
  values (auth.uid(), auth.jwt() ->> 'email', 'calendar_imports', public.current_user_email(), 'update',
          jsonb_build_object('action', 'phone calendar link removed'));
end;
$$;

-- A first guess at the type from the title (the office can change it).
create or replace function public.guess_phone_event_kind(p_title text)
returns text
language sql
immutable
as $$
  select case
    when p_title ~* '\m(travel|travelling|traveling|flight|fly|flying|drive|driving|airport|ferry|train|hotel)\M' then 'travel'
    when p_title ~* '\m(training|commissioning)\M' then 'training'
    when p_title ~* '\m(service|repair|breakdown)\M' then 'service'
    when p_title ~* '\m(on site|on-site|onsite|install|installation|visit)\M' then 'onsite'
    else 'other' end;
$$;

-- For the calendar-import Edge Function only (service role). p_events = the
-- whole calendar as read now: [{key, title, location, description, all_day,
-- start_at, start_date, end_date}]. With p_error the link failed: the entries
-- already read stay as they were.
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
           (e ->> 'start_date')::date as start_date, greatest((e ->> 'end_date')::date, (e ->> 'start_date')::date) as end_date
      from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
     where nullif(e ->> 'key', '') is not null and nullif(e ->> 'start_date', '') is not null
  ), up as (
    insert into public.tech_phone_events as t (user_email, event_key, title, location, description, all_day, start_at, start_date, end_date, kind)
    select p_email, i.event_key, i.title, i.location, i.description, i.all_day, i.start_at, i.start_date, i.end_date,
           public.guess_phone_event_kind(i.title)
      from incoming i
    on conflict (user_email, event_key) do update
      set title = excluded.title, location = excluded.location, description = excluded.description,
          all_day = excluded.all_day, start_at = excluded.start_at, start_date = excluded.start_date, end_date = excluded.end_date,
          -- the office's type stays; a guessed type follows the new title
          kind = case when t.kind_set_by is null then excluded.kind else t.kind end
      where (t.title, t.location, t.description, t.all_day, t.start_at, t.start_date, t.end_date)
            is distinct from (excluded.title, excluded.location, excluded.description, excluded.all_day, excluded.start_at, excluded.start_date, excluded.end_date)
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

-- The office sets the type and links a customer or order (the rest comes from the phone).
create or replace function public.classify_phone_event(p_id uuid, p_kind text, p_customer uuid, p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid := p_customer;
begin
  perform public.require_perm('service.calendar.classify', 'edit');
  if p_kind not in ('travel', 'onsite', 'service', 'training', 'other') then
    raise exception 'Choose a type.' using errcode = '22023';
  end if;
  if p_order is not null then
    select customer_id into v_customer from public.orders where id = p_order;
    if not found then raise exception 'That order could not be found.'; end if;
  end if;
  update public.tech_phone_events
     set kind = p_kind, kind_set_by = public.current_user_email(), customer_id = v_customer, order_id = p_order,
         linked_by = public.current_user_email()
   where id = p_id;
  if not found then raise exception 'That entry could not be found. It may have been removed on the phone.'; end if;
end;
$$;

-- ===========================================================================
-- 2. The calendar rows now include phone entries (the outgoing link does not)
-- ===========================================================================
drop function public.calendar_entries(date, date, text);
drop function public.calendar_feed(text);
drop function public.calendar_rows(text, date, date);

create function public.calendar_rows(p_tech text, p_from date, p_to date, p_with_phone boolean)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text)
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
           false as from_phone, null::timestamptz as start_at, null::text as location
      from public.orders o left join public.customers c on c.id = o.customer_id
     where o.technician_email is not null and o.service_start is not null and not o.archived and o.stage <> 'Cancelled'
    union all
    select 'service_call', sc.card_id::text, sc.technician_email, 'service',
           sc.planned_start, coalesce(sc.planned_end, sc.planned_start),
           'Service call S-' || sc.call_number || ' – ' || coalesce(cu.name, bc.title),
           cu.name, cu.country, bc.title, '/service/calls/' || sc.card_id,
           false, null, null
      from public.service_calls sc
      join public.board_cards bc on bc.id = sc.card_id and not bc.archived
      left join public.customers cu on cu.id = sc.customer_id
     where sc.technician_email is not null and sc.planned_start is not null
    union all
    select 'travel_log', e.id::text, e.created_by, 'travel', e.entry_date, e.entry_date,
           'Travel – ' || coalesce(cu.name, 'customer'), cu.name, cu.country, e.notes,
           case when e.order_id is not null then '/service/' || e.order_id else '/service/calls/' || e.service_call_id end,
           false, null, null
      from public.service_entries e
      left join public.orders o on o.id = e.order_id
      left join public.service_calls sc on sc.card_id = e.service_call_id
      left join public.customers cu on cu.id = coalesce(o.customer_id, sc.customer_id)
     where e.kind = 'travel' and not e.archived and e.created_by is not null
    union all
    select 'manual', t.id::text, t.tech_email, t.kind, t.start_date, t.end_date,
           (case when t.kind = 'travel' then 'Travel' else 'On site' end) || coalesce(' – ' || coalesce(cu.name, nullif(btrim(t.customer_text), '')), ''),
           coalesce(cu.name, nullif(btrim(t.customer_text), '')), cu.country, t.notes, null::text,
           false, null, null
      from public.tech_calendar_entries t left join public.customers cu on cu.id = t.customer_id
     where not t.archived
    union all
    -- Read from the technician's own phone calendar ("From phone"); never sent back out.
    select 'phone', p.id::text, p.user_email, p.kind, p.start_date, p.end_date,
           p.title, coalesce(cu.name, cu2.name), coalesce(cu.country, cu2.country), p.description,
           case when p.order_id is not null then '/service/' || p.order_id end,
           true, case when p.all_day then null else p.start_at end, p.location
      from public.tech_phone_events p
      left join public.customers cu on cu.id = p.customer_id
      left join public.orders o on o.id = p.order_id
      left join public.customers cu2 on cu2.id = o.customer_id
     where p_with_phone
  )
  select r.source, r.source_id, r.tech_email,
         (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = r.tech_email),
         r.kind, r.start_date, r.end_date, r.title, r.customer, r.country, r.notes, r.link, r.from_phone, r.start_at, r.location
    from rows r
   where (p_tech is null or r.tech_email = p_tech)
     and r.start_date <= p_to and r.end_date >= p_from
   order by r.start_date, r.start_at nulls first, r.tech_email, r.title;
$$;


create function public.calendar_entries(p_from date, p_to date, p_tech text default null)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text)
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
  return query select * from public.calendar_rows(lower(p_tech), p_from, p_to, true);
end;
$$;

-- Outgoing phone link (calendar-feed): app entries only, never what came from the phone.
create function public.calendar_feed(p_token text)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text)
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

-- For the calendar-import Edge Function (service role): the links to read.
create or replace function public.calendar_imports_due(p_email text default null)
returns table (user_email text, url text)
language sql
stable
security definer
set search_path = public
as $$
  select i.user_email, i.url
    from public.calendar_imports i
    join public.allowed_users a on a.email = i.user_email
   where p_email is null or i.user_email = p_email
   order by i.last_attempt_at nulls first;
$$;

-- ===========================================================================
-- 3. Every 15 minutes, with automatic email sending (Admin → Email)
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
  perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications', 'calendar-import');
  perform cron.schedule('send-notifications', '* * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "dispatch"}'::jsonb, timeout_milliseconds := 55000)$job$,
    v_base || 'send-email'));
  perform cron.schedule('board-due-notifications', '*/10 * * * *', 'select public.board_due_notifications()');
  perform cron.schedule('calendar-import', '*/15 * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "sync_all"}'::jsonb, timeout_milliseconds := 120000)$job$,
    v_base || 'calendar-import'));
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned on', 'url', v_base));
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
    perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications', 'calendar-import');
  end if;
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned off'));
end;
$$;

-- If automatic sending is already on, start reading phone calendars now too.
do $$
declare
  v_cmd text;
  v_base text;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select command from cron.job where jobname = 'send-notifications' limit 1$q$ into v_cmd;
    v_base := substring(v_cmd from $re$url := '(https://[^']+/functions/v1/)send-email'$re$);
    if v_base is not null then
      perform cron.unschedule(jobid) from cron.job where jobname = 'calendar-import';
      perform cron.schedule('calendar-import', '*/15 * * * *', format(
        $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "sync_all"}'::jsonb, timeout_milliseconds := 120000)$job$,
        v_base || 'calendar-import'));
    end if;
  end if;
end $$;

-- Technician preset: also link a phone calendar.
update public.permission_templates
   set perms = perms || '{"service.calendar.import": "edit", "settings": "view"}'::jsonb
 where lower(btrim(name)) = 'technician';

-- Access lockdown, as in earlier migrations.
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
