-- 0033_company_holidays.sql
-- Company holidays, PEI statutory holidays and office closures.
-- 1. company_holidays: name, start and end date (end = start for one day,
--    for example Christmas break Dec 24 – Jan 1), kind (statutory / company /
--    closure), "day off" (the shop is closed, so ship dates skip it), hidden.
--    Everyone signed in can read them; Admin → Company Holidays changes them.
-- 2. The ship date calculator (Admin → Scheduling) now uses these dates. The
--    holidays typed in Admin → Scheduling before are moved here.
-- 3. PEI statutory holidays are imported from the canada-holidays.ca API
--    (province PE) for this year and next year: "Import Now" in Admin →
--    Company Holidays, and automatically every December 31 (for the next two
--    years) by the database scheduler. An entry an admin has changed is never
--    overwritten by an import.

-- ===========================================================================
-- 1. company_holidays
-- ===========================================================================
create table public.company_holidays (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (btrim(name) <> '' and length(name) <= 120),
  start_date  date not null,
  end_date    date not null,
  kind        text not null default 'company' check (kind in ('statutory', 'company', 'closure')),
  -- true = nobody works that day; the ship date calculator skips it.
  day_off     boolean not null default true,
  hidden      boolean not null default false,
  notes       text check (notes is null or length(notes) <= 500),
  source      text not null default 'manual' check (source in ('manual', 'canada-holidays')),
  -- For imported entries: "PE-2026-12" (province, year, holiday number).
  source_key  text unique,
  -- An admin changed the name or dates of an imported entry: imports leave it alone.
  edited      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_date >= start_date),
  check (end_date - start_date <= 60)
);
create index company_holidays_dates_idx on public.company_holidays (start_date, end_date);
alter table public.company_holidays enable row level security;

-- End date defaults to the start date; imported entries changed by hand are marked "edited".
create or replace function public.company_holidays_fill()
returns trigger
language plpgsql
as $$
begin
  if new.end_date is null then
    new.end_date := new.start_date;
  end if;
  if tg_op = 'UPDATE' and old.source <> 'manual'
     and coalesce(current_setting('app.holiday_import', true), '') <> 'on'
     and (new.name, new.start_date, new.end_date) is distinct from (old.name, old.start_date, old.end_date) then
    new.edited := true;
  end if;
  if tg_op = 'UPDATE' and coalesce(current_setting('app.holiday_import', true), '') <> 'on' then
    new.source := old.source;
    new.source_key := old.source_key;
  end if;
  return new;
end;
$$;
create trigger company_holidays_fill before insert or update on public.company_holidays
  for each row execute function public.company_holidays_fill();
create trigger company_holidays_updated_at before update on public.company_holidays
  for each row execute function public.set_updated_at();
create trigger log_activity after insert or update or delete on public.company_holidays
  for each row execute function public.log_activity();

create policy "Allowed users can read" on public.company_holidays
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Holiday admins can add" on public.company_holidays
  for insert to authenticated with check ((select public.can_admin('holidays')));
create policy "Holiday admins can change" on public.company_holidays
  for update to authenticated
  using ((select public.can_admin('holidays'))) with check ((select public.can_admin('holidays')));
-- Entries are hidden, never deleted, from the app.
revoke delete on public.company_holidays from authenticated;

-- ===========================================================================
-- 2. Ship dates use these days off
-- ===========================================================================
-- Holidays typed in Admin → Scheduling before this migration move here.
insert into public.company_holidays (name, start_date, end_date, kind)
select coalesce(nullif(btrim(h ->> 'name'), ''), 'Holiday'), (h ->> 'date')::date, (h ->> 'date')::date, 'company'
  from public.app_settings s, jsonb_array_elements(coalesce(s.value -> 'holidays', '[]'::jsonb)) h
 where s.key = 'scheduling' and (h ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$';
update public.app_settings set value = value - 'holidays' where key = 'scheduling';

-- Every day off (not hidden) between two dates, one row per day.
create or replace function public.holiday_off_dates(p_from date, p_to date)
returns table (day date, name text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (g.d::date) g.d::date, h.name
    from public.company_holidays h
    cross join lateral generate_series(greatest(h.start_date, p_from), least(h.end_date, p_to), interval '1 day') g(d)
   where h.day_off and not h.hidden
     and h.end_date >= p_from and h.start_date <= p_to
     and p_to - p_from <= 4000
   order by g.d::date, h.start_date, h.name;
$$;

-- The scheduling settings, with "holidays" filled from company_holidays
-- (last year to three years ahead), so everything reading them stays the same.
create or replace function public.scheduling_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.app_settings where key = 'scheduling'), '{}'::jsonb)
         || jsonb_build_object('holidays', coalesce((
              select jsonb_agg(jsonb_build_object('date', d.day, 'name', d.name) order by d.day)
                from public.holiday_off_dates(current_date - 400, current_date + 1100) d), '[]'::jsonb));
$$;

-- Faster than reading the whole list for every day.
create or replace function public.is_working_day(p_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select extract(isodow from p_day)::integer in
           (select jsonb_array_elements_text(coalesce(s -> 'working_days', '[1,2,3,4,5]'::jsonb))::integer)
     and not exists (select 1 from public.company_holidays h
                      where h.day_off and not h.hidden and p_day between h.start_date and h.end_date)
    from (select coalesce((select value from public.app_settings where key = 'scheduling'), '{}'::jsonb) as s) x;
$$;

-- ===========================================================================
-- 3. Statutory holidays from canada-holidays.ca
-- ===========================================================================
-- Settings and last import (app_settings key 'holidays'): {"province": "PE",
-- "last_import_at", "last_import_years", "last_import_count", "last_error"}.
insert into public.app_settings (key, value)
values ('holidays', '{"province": "PE"}'::jsonb)
on conflict (key) do nothing;

create or replace function public.holiday_province()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(upper(btrim((select value ->> 'province' from public.app_settings where key = 'holidays'))), ''), 'PE');
$$;

-- Admin → Company Holidays: which province's statutory holidays to import.
create or replace function public.set_holiday_province(p_province text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := upper(btrim(coalesce(p_province, '')));
begin
  perform public.require_admin_area('holidays');
  if v not in ('AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT') then
    raise exception 'Choose a Canadian province or territory.' using errcode = '22023';
  end if;
  insert into public.app_settings (key, value) values ('holidays', jsonb_build_object('province', v))
  on conflict (key) do update set value = public.app_settings.value || jsonb_build_object('province', v);
end;
$$;

-- Saves one year of holidays as returned by
-- https://canada-holidays.ca/api/v1/provinces/PE?year=2026
-- ({"province": {"holidays": [{"id", "date", "observedDate", "nameEn"}]}}).
-- Uses the observed date (the day off when a holiday falls on a weekend).
-- Returns how many holidays were in the answer.
create or replace function public.apply_statutory_holidays(p_year integer, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list     jsonb := coalesce(p_payload -> 'province' -> 'holidays', p_payload -> 'holidays',
                               case when jsonb_typeof(p_payload) = 'array' then p_payload end);
  v_province text := coalesce(nullif(upper(p_payload -> 'province' ->> 'id'), ''), public.holiday_province());
  v_h        jsonb;
  v_day      date;
  v_count    integer := 0;
begin
  if not public.is_service_caller() then
    perform public.require_admin_area('holidays');
  end if;
  if v_list is null or jsonb_typeof(v_list) <> 'array' then
    raise exception 'The holiday list could not be read.' using errcode = '22023';
  end if;
  perform set_config('app.holiday_import', 'on', true);
  for v_h in select value from jsonb_array_elements(v_list) loop
    v_day := coalesce(nullif(v_h ->> 'observedDate', ''), v_h ->> 'date')::date;
    continue when v_day is null or extract(year from v_day) not in (p_year, p_year + 1)
               or nullif(btrim(v_h ->> 'nameEn'), '') is null;
    insert into public.company_holidays (name, start_date, end_date, kind, day_off, source, source_key)
    values (btrim(v_h ->> 'nameEn'), v_day, v_day, 'statutory', true, 'canada-holidays',
            v_province || '-' || p_year || '-' || coalesce(v_h ->> 'id', v_h ->> 'nameEn'))
    on conflict (source_key) do update
       set name = excluded.name, start_date = excluded.start_date, end_date = excluded.end_date
     where not public.company_holidays.edited;
    v_count := v_count + 1;
  end loop;
  perform set_config('app.holiday_import', 'off', true);
  insert into public.app_settings (key, value) values ('holidays', '{}'::jsonb) on conflict (key) do nothing;
  update public.app_settings
     set value = value || jsonb_build_object('last_import_at', now(), 'last_import_count', v_count,
                                            'last_import_years', coalesce(value -> 'last_import_years', '[]'::jsonb) - p_year::text || to_jsonb(p_year::text),
                                            'last_error', null)
   where key = 'holidays';
  return v_count;
end;
$$;

-- The automatic import (database scheduler, needs the pg_net extension):
-- request_statutory_holidays() asks canada-holidays.ca, and
-- collect_statutory_holidays() saves the answers a few minutes later.
create table if not exists app_private.holiday_requests (
  request_id  bigint primary key,
  year        integer not null,
  created_at  timestamptz not null default now()
);

create or replace function public.request_statutory_holidays()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  -- On December 31 the next two years; otherwise this year and next year.
  v_first integer := extract(year from (now() at time zone 'America/Halifax')::date + 1)::integer;
  v_year  integer;
  v_id    bigint;
  v_n     integer := 0;
begin
  if not public.is_service_caller() then
    perform public.require_admin_area('holidays');
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Turn on the pg_net extension first (Supabase → Database → Extensions).' using errcode = '55000';
  end if;
  for v_year in v_first .. v_first + 1 loop
    execute 'select net.http_get(url := $1, timeout_milliseconds := 20000)'
       into v_id
      using format('https://canada-holidays.ca/api/v1/provinces/%s?year=%s', public.holiday_province(), v_year);
    insert into app_private.holiday_requests (request_id, year) values (v_id, v_year) on conflict do nothing;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function public.collect_statutory_holidays()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_code  integer;
  v_body  text;
  v_done  integer := 0;
begin
  if not public.is_service_caller() then
    perform public.require_admin_area('holidays');
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return 0;
  end if;
  for r in select * from app_private.holiday_requests order by request_id loop
    v_code := null;
    execute 'select status_code, content from net._http_response where id = $1' into v_code, v_body using r.request_id;
    if v_code is null then
      -- No answer yet; give up after an hour.
      if r.created_at < now() - interval '1 hour' then
        delete from app_private.holiday_requests where request_id = r.request_id;
        update public.app_settings set value = value || jsonb_build_object('last_error', 'canada-holidays.ca did not answer.')
         where key = 'holidays';
      end if;
      continue;
    end if;
    begin
      if v_code <> 200 then
        raise exception 'canada-holidays.ca answered with code %.', v_code;
      end if;
      perform public.apply_statutory_holidays(r.year, v_body::jsonb);
      v_done := v_done + 1;
    exception when others then
      update public.app_settings set value = value || jsonb_build_object('last_error', sqlerrm, 'last_error_at', now())
       where key = 'holidays';
    end;
    delete from app_private.holiday_requests where request_id = r.request_id;
  end loop;
  return v_done;
end;
$$;

-- Yearly refresh: December 31 at noon (Halifax, 16:00 UTC), saved 10 minutes later.
create or replace function public.start_holiday_schedule()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_service_caller() then
    perform public.require_admin_area('holidays');
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Turn on the pg_cron and pg_net extensions first (Supabase → Database → Extensions).' using errcode = '55000';
  end if;
  execute $q$select cron.unschedule(jobid) from cron.job where jobname in ('holidays-request', 'holidays-collect')$q$;
  execute $q$select cron.schedule('holidays-request', '0 16 31 12 *', 'select public.request_statutory_holidays()')$q$;
  execute $q$select cron.schedule('holidays-collect', '*/10 16-18 31 12 *', 'select public.collect_statutory_holidays()')$q$;
end;
$$;

create or replace function public.holiday_schedule_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_on boolean := false;
begin
  perform public.require_admin_area('holidays');
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select exists (select 1 from cron.job where jobname = 'holidays-request')$q$ into v_on;
  end if;
  return jsonb_build_object(
    'scheduled', v_on,
    'pg_cron', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'pg_net', exists (select 1 from pg_extension where extname = 'pg_net'));
end;
$$;

-- Turn the yearly refresh on now when the extensions are already on (Admin → Email set them up).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform public.start_holiday_schedule();
  end if;
end $$;

-- Access lockdown, as in earlier migrations.
revoke all on public.company_holidays from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
