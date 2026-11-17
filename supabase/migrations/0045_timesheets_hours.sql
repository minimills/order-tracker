-- 0045 Timesheets, step 2 of 4: hours, weeks, approval, overtime, banked hours, balances
--
-- 1. Weeks (one per employee and pay week): approval by the department
--    manager locks the week; the overtime choice ("Overtime" / "Regular pay")
--    when banked hours used take the week over the threshold; the week's history.
-- 2. Time entries: work (start, end, unpaid break or a total), vacation, sick,
--    banked time used and unpaid time off, per day. Only written by the
--    functions below (people with "timesheets.enter"); employees only read their own.
-- 3. Banked hours: hours earned into the bank (regular ×1, overtime × the
--    setting), adjustments with a reason, the ledger and the balance.
-- 4. timesheet_week_rows(): THE weekly totals every screen and report uses.
-- 5. Access lockdown.

-- Monday-based (or the setting's) start of the pay week holding a day.
create or replace function public.ts_week_start(p_day date)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select p_day - ((extract(isodow from p_day)::int - coalesce((public.payroll_settings() ->> 'week_start')::int, 1) + 7) % 7);
$$;

-- People who enter hours may see every employee's hours too.
create or replace function public.ts_can_see(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_service_caller()
      or public.has_any_perm(array['timesheets', 'timesheets.enter', 'timesheets.reports', 'payroll.pay', 'admin.employees', 'admin.timesheets'], 'view')
      or public.ts_is_manager_of(p_employee)
      or exists (select 1 from public.employees e where e.id = p_employee and e.user_email = public.current_user_email()
                  and public.has_perm('timesheets.mine', 'view'));
$$;

-- ===========================================================================
-- 1. Weeks
-- ===========================================================================
create table public.timesheet_weeks (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references public.employees (id) on delete cascade,
  week_start        date not null,
  status            text not null default 'open' check (status in ('open', 'approved')),
  approved_by       text,
  approved_by_name  text,
  approved_at       timestamptz,
  -- how the hours over the threshold are paid when banked hours used take the week over it
  ot_choice         text check (ot_choice in ('overtime', 'regular')),
  ot_choice_by      text,
  ot_choice_by_name text,
  ot_choice_at      timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (employee_id, week_start)
);
create trigger timesheet_weeks_updated_at before update on public.timesheet_weeks for each row execute function public.set_updated_at();
alter table public.timesheet_weeks enable row level security;
create policy "Weeks visible" on public.timesheet_weeks for select to authenticated using ((select public.ts_can_see(employee_id)));
revoke insert, update, delete on public.timesheet_weeks from authenticated;
revoke all on public.timesheet_weeks from anon;

create table public.timesheet_week_events (
  id         uuid primary key default gen_random_uuid(),
  week_id    uuid not null references public.timesheet_weeks (id) on delete cascade,
  action     text not null,   -- entered / approved / unlocked / ot_choice / banked / bank_removed / reviewed / imported / time_off
  detail     jsonb not null default '{}',
  note       text,
  by_email   text default public.current_user_email(),
  by_name    text default public.current_user_name(),
  at         timestamptz not null default now()
);
create index timesheet_week_events_idx on public.timesheet_week_events (week_id, at);
alter table public.timesheet_week_events enable row level security;
create policy "Week history visible" on public.timesheet_week_events for select to authenticated
  using (exists (select 1 from public.timesheet_weeks w where w.id = week_id and public.ts_can_see(w.employee_id)));
revoke insert, update, delete on public.timesheet_week_events from authenticated;
revoke all on public.timesheet_week_events from anon;

-- The week row for an employee and a day (made when missing). Internal.
create or replace function public.ts_week_id(p_employee uuid, p_day date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws date := public.ts_week_start(p_day);
  v_id uuid;
begin
  insert into public.timesheet_weeks (employee_id, week_start) values (p_employee, v_ws)
  on conflict (employee_id, week_start) do nothing;
  select id into v_id from public.timesheet_weeks where employee_id = p_employee and week_start = v_ws;
  return v_id;
end;
$$;

create or replace function public.ts_log(p_week uuid, p_action text, p_detail jsonb, p_note text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.timesheet_week_events (week_id, action, detail, note)
  values (p_week, p_action, coalesce(p_detail, '{}'), nullif(btrim(p_note), ''));
$$;

-- ===========================================================================
-- 2. Time entries
-- ===========================================================================
create table public.time_entries (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees (id) on delete cascade,
  week_id         uuid references public.timesheet_weeks (id),
  work_date       date not null,
  kind            text not null default 'work' check (kind in ('work', 'vacation', 'sick', 'banked', 'unpaid')),
  start_time      time,
  end_time        time,
  break_minutes   integer not null default 0 check (break_minutes between 0 and 600),
  hours           numeric(6, 2) not null default 0 check (hours between 0 and 24),
  notes           text,
  source          text not null default 'app' check (source in ('app', 'import', 'time_off')),
  time_off_id     uuid,
  import_batch_id uuid,
  import_key      text,
  needs_review    boolean not null default false,
  review_note     text,
  created_by      text default public.current_user_email(),
  created_at      timestamptz not null default now(),
  updated_by      text,
  updated_at      timestamptz not null default now()
);
create index time_entries_emp_date_idx on public.time_entries (employee_id, work_date);
create index time_entries_week_idx on public.time_entries (week_id);
create unique index time_entries_import_key on public.time_entries (import_key) where import_key is not null;
alter table public.time_entries enable row level security;
create policy "Hours visible" on public.time_entries for select to authenticated using ((select public.ts_can_see(employee_id)));
revoke insert, update, delete on public.time_entries from authenticated;
revoke all on public.time_entries from anon;

-- Hours from the start, end and break; the week; locked weeks refuse changes.
create or replace function public.time_entries_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mins integer;
  v_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select status into v_status from public.timesheet_weeks where id = old.week_id;
    if v_status = 'approved' and coalesce(current_setting('app.ts_system', true), '') <> 'on' then
      raise exception 'The week of % is approved and locked. Unlock it first.', to_char(old.work_date, 'Mon FMDD, YYYY') using errcode = '55000';
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;
  if new.start_time is not null and new.end_time is not null then
    v_mins := extract(epoch from (new.end_time - new.start_time))::int / 60;
    if v_mins <= 0 then v_mins := v_mins + 24 * 60; end if;   -- past midnight
    v_mins := v_mins - coalesce(new.break_minutes, 0);
    if v_mins < 0 then raise exception 'The break is longer than the time worked on %.', to_char(new.work_date, 'Mon FMDD') using errcode = '22023'; end if;
    new.hours := round(v_mins / 60.0, 2);
  end if;
  new.week_id := public.ts_week_id(new.employee_id, new.work_date);
  select status into v_status from public.timesheet_weeks where id = new.week_id;
  if v_status = 'approved' and coalesce(current_setting('app.ts_system', true), '') <> 'on' then
    raise exception 'The week of % is approved and locked. Unlock it first.', to_char(new.work_date, 'Mon FMDD, YYYY') using errcode = '55000';
  end if;
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.updated_by := public.current_user_email(); end if;
  return new;
end;
$$;
create trigger time_entries_fill before insert or update or delete on public.time_entries
  for each row execute function public.time_entries_fill();

-- ===========================================================================
-- 3. Banked hours
-- ===========================================================================
create table public.banked_hours (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees (id) on delete cascade,
  week_id         uuid references public.timesheet_weeks (id),
  work_date       date not null,
  kind            text not null check (kind in ('earn', 'adjust', 'import')),
  -- earn / import: banked from regular or overtime hours
  source          text check (source in ('regular', 'overtime')),
  hours           numeric(6, 2) not null,   -- hours of work put in the bank (adjust: the change)
  credited        numeric(6, 2) not null,   -- what the bank changes by
  note            text,
  import_batch_id uuid,
  import_key      text,
  needs_review    boolean not null default false,
  created_by      text default public.current_user_email(),
  created_by_name text default public.current_user_name(),
  created_at      timestamptz not null default now(),
  check (kind = 'adjust' or (hours > 0 and source is not null)),
  check (kind <> 'adjust' or btrim(coalesce(note, '')) <> '')
);
create index banked_hours_emp_idx on public.banked_hours (employee_id, work_date);
create unique index banked_hours_import_key on public.banked_hours (import_key) where import_key is not null;
alter table public.banked_hours enable row level security;
create policy "Banked hours visible" on public.banked_hours for select to authenticated using ((select public.ts_can_see(employee_id)));
revoke insert, update, delete on public.banked_hours from authenticated;
revoke all on public.banked_hours from anon;

create or replace function public.banked_hours_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_week uuid := case when tg_op = 'DELETE' then old.week_id else null end;
begin
  if tg_op <> 'DELETE' and new.kind <> 'adjust' then
    new.week_id := public.ts_week_id(new.employee_id, new.work_date);
    v_week := new.week_id;
  end if;
  select status into v_status from public.timesheet_weeks where id = v_week;
  if v_status = 'approved' and coalesce(current_setting('app.ts_system', true), '') <> 'on' then
    raise exception 'That week is approved and locked. Unlock it first.' using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger banked_hours_fill before insert or update or delete on public.banked_hours
  for each row execute function public.banked_hours_fill();

-- Every change to the bank: earned and adjusted (+), used (−). Row security of the two tables applies.
create view public.banked_hours_ledger with (security_invoker = true) as
  select b.id, b.employee_id, b.work_date, b.kind, b.source, b.hours, b.credited as change, b.note,
         b.created_by_name as by_name, b.created_at
    from public.banked_hours b
  union all
  select t.id, t.employee_id, t.work_date, 'used', null, t.hours, -t.hours, t.notes, null, t.created_at
    from public.time_entries t where t.kind = 'banked';
grant select on public.banked_hours_ledger to authenticated;

create or replace function public.ts_bank_balance(p_employee uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select sum(credited) from public.banked_hours where employee_id = p_employee), 0)
       - coalesce((select sum(hours) from public.time_entries where employee_id = p_employee and kind = 'banked'), 0);
$$;

-- ===========================================================================
-- 4. Weekly totals (THE calculation; the browser has the same in src/lib/timesheets.ts)
-- ===========================================================================
-- worked = work hours; banked used, vacation, sick, unpaid from the entries;
-- stat = paid holidays in the week (Admin → Company Holidays, kinds from the
-- settings) on working weekdays, once employed long enough, × hours per day.
-- Overtime (hourly only): hours worked over the threshold. When banked hours
-- used take the week over it, the hours they add over it are overtime with the
-- choice "overtime" (and when nobody chose yet), regular pay with "regular".
-- Regular = worked + banked used − overtime. Hours banked this week are not paid now.
create or replace function public.timesheet_week_rows(p_from date, p_to date, p_employee uuid default null)
returns table (
  employee_id uuid, employee_name text, user_email text, pay_type text, department_id uuid,
  week_start date, week_id uuid, status text, approved_by_name text,
  worked numeric, banked_used numeric, vacation numeric, sick numeric, unpaid numeric, stat numeric,
  earned_regular numeric, earned_overtime numeric, credited numeric,
  threshold numeric, over_by_banked numeric, ot_choice text, ot_choice_by_name text, ot_choice_at timestamptz,
  overtime numeric, regular numeric, paid_regular numeric, paid_overtime numeric,
  needs_review boolean, entries integer, imported boolean)
language sql
stable
security definer
set search_path = public
as $$
  with st as (
    select (s ->> 'overtime_weekly_hours')::numeric thr, (s ->> 'hours_per_day')::numeric hpd,
           coalesce((s ->> 'stat_min_days_employed')::int, 30) statmin,
           array(select jsonb_array_elements_text(coalesce(s -> 'paid_holiday_kinds', '["statutory"]'))) kinds,
           array(select jsonb_array_elements_text(coalesce((select value from public.app_settings where key = 'scheduling') -> 'working_days', '[1,2,3,4,5]'))::int) wdays,
           public.ts_week_start(p_from) f, public.ts_week_start(p_to) t
      from (select public.payroll_settings() s) x),
  emp as (
    select e.* from public.employees e
     where (p_employee is null or e.id = p_employee) and public.ts_can_see(e.id)),
  wk as (
    select distinct e.id emp_id, x.ws
      from emp e cross join st
      cross join lateral (
        select public.ts_week_start(te.work_date) ws from public.time_entries te
         where te.employee_id = e.id and te.work_date between st.f and st.t + 6
        union
        select public.ts_week_start(b.work_date) from public.banked_hours b
         where b.employee_id = e.id and b.kind <> 'adjust' and b.work_date between st.f and st.t + 6
        union
        select g::date from generate_series(greatest(st.f, public.ts_week_start(e.start_date)),
                                            least(st.t, public.ts_week_start(coalesce(e.end_date, st.t))), interval '7 days') g
         where e.start_date is not null and not e.archived) x),
  agg as (
    select w.emp_id, w.ws,
           coalesce(sum(te.hours) filter (where te.kind = 'work'), 0) worked,
           coalesce(sum(te.hours) filter (where te.kind = 'banked'), 0) banked_used,
           coalesce(sum(te.hours) filter (where te.kind = 'vacation'), 0) vacation,
           coalesce(sum(te.hours) filter (where te.kind = 'sick'), 0) sick,
           coalesce(sum(te.hours) filter (where te.kind = 'unpaid'), 0) unpaid,
           count(te.id)::int n,
           coalesce(bool_or(te.needs_review), false) review,
           coalesce(bool_or(te.source = 'import'), false) imported
      from wk w
      left join public.time_entries te on te.employee_id = w.emp_id and te.work_date between w.ws and w.ws + 6
     group by w.emp_id, w.ws),
  bank as (
    select w.emp_id, w.ws,
           coalesce(sum(b.hours) filter (where b.source = 'regular'), 0) er,
           coalesce(sum(b.hours) filter (where b.source = 'overtime'), 0) eo,
           coalesce(sum(b.credited), 0) cr,
           coalesce(bool_or(b.needs_review), false) review
      from wk w
      left join public.banked_hours b on b.employee_id = w.emp_id and b.kind <> 'adjust' and b.work_date between w.ws and w.ws + 6
     group by w.emp_id, w.ws),
  stat as (
    select w.emp_id, w.ws, count(distinct d.d)::numeric days
      from wk w
      join public.employees e on e.id = w.emp_id
      cross join st
      cross join lateral generate_series(w.ws, w.ws + 6, interval '1 day') d(d)
     where extract(isodow from d.d)::int = any (st.wdays)
       and e.start_date is not null and e.start_date <= d.d::date - st.statmin
       and (e.end_date is null or e.end_date >= d.d::date)
       and exists (select 1 from public.company_holidays h
                    where not h.hidden and h.day_off and h.kind = any (st.kinds) and d.d::date between h.start_date and h.end_date)
     group by w.emp_id, w.ws),
  calc as (
    select e.id, e.name, e.user_email, e.pay_type, e.department_id, a.ws, tw.id week_id,
           coalesce(tw.status, 'open') status, tw.approved_by_name,
           a.worked, a.banked_used, a.vacation, a.sick, a.unpaid,
           coalesce(s.days, 0) * coalesce(e.hours_per_day, st.hpd) stat,
           b.er, b.eo, b.cr, st.thr,
           greatest(0, a.worked - st.thr) ot_base,
           greatest(0, a.worked + a.banked_used - st.thr) - greatest(0, a.worked - st.thr) extra,
           tw.ot_choice, tw.ot_choice_by_name, tw.ot_choice_at,
           a.review or b.review review, a.n, a.imported
      from agg a
      join emp e on e.id = a.emp_id
      cross join st
      join bank b on b.emp_id = a.emp_id and b.ws = a.ws
      left join stat s on s.emp_id = a.emp_id and s.ws = a.ws
      left join public.timesheet_weeks tw on tw.employee_id = a.emp_id and tw.week_start = a.ws)
  select c.id, c.name, c.user_email, c.pay_type, c.department_id, c.ws, c.week_id, c.status, c.approved_by_name,
         c.worked, c.banked_used, c.vacation, c.sick, c.unpaid, c.stat,
         c.er, c.eo, c.cr, c.thr, c.extra, c.ot_choice, c.ot_choice_by_name, c.ot_choice_at,
         o.ot, c.worked + c.banked_used - o.ot,
         greatest(0, c.worked + c.banked_used - o.ot - c.er), greatest(0, o.ot - c.eo),
         c.review, c.n, c.imported
    from calc c
    cross join lateral (select case when c.pay_type <> 'hourly' then 0
                                    when c.ot_choice = 'regular' then c.ot_base
                                    else c.ot_base + c.extra end as ot) o
   order by c.name, c.ws;
$$;

-- Balances for one employee and calendar year: banked hours, vacation and sick days.
create or replace function public.employee_balances(p_employee uuid, p_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hpd numeric;
  v_from date := make_date(p_year, 1, 1);
  v_to date := make_date(p_year, 12, 31);
  v_vac numeric; v_sick numeric; v_vac_ent numeric; v_sick_ent numeric;
  v_earned numeric; v_used numeric; v_unpaid numeric;
begin
  if not public.ts_can_see(p_employee) then
    raise exception 'You do not have permission to see this timesheet.' using errcode = 'P0001';
  end if;
  select coalesce(e.hours_per_day, (public.payroll_settings() ->> 'hours_per_day')::numeric) into v_hpd
    from public.employees e where e.id = p_employee;
  select coalesce(sum(hours) filter (where kind = 'vacation'), 0), coalesce(sum(hours) filter (where kind = 'sick'), 0),
         coalesce(sum(hours) filter (where kind = 'banked'), 0), coalesce(sum(hours) filter (where kind = 'unpaid'), 0)
    into v_vac, v_sick, v_used, v_unpaid
    from public.time_entries where employee_id = p_employee and work_date between v_from and v_to;
  select coalesce(sum(credited) filter (where credited > 0), 0) into v_earned
    from public.banked_hours where employee_id = p_employee and work_date between v_from and v_to;
  v_vac_ent := public.leave_entitlement(p_employee, 'vacation', p_year);
  v_sick_ent := public.leave_entitlement(p_employee, 'sick', p_year);
  return jsonb_build_object(
    'year', p_year, 'hours_per_day', v_hpd,
    'years_of_service', round(public.years_of_service(p_employee, v_to), 1),
    'banked', jsonb_build_object('earned', v_earned, 'used', v_used, 'balance', public.ts_bank_balance(p_employee)),
    'vacation', jsonb_build_object('entitlement', v_vac_ent, 'used_days', round(v_vac / v_hpd, 2), 'used_hours', v_vac,
                                   'left', round(v_vac_ent - v_vac / v_hpd, 2)),
    'sick', jsonb_build_object('entitlement', v_sick_ent, 'used_days', round(v_sick / v_hpd, 2), 'used_hours', v_sick,
                               'left', round(v_sick_ent - v_sick / v_hpd, 2)),
    'unpaid_hours', v_unpaid);
end;
$$;

-- ===========================================================================
-- Saving hours (people with "timesheets.enter"; employees never)
-- ===========================================================================
-- Replaces the entries of one employee's week with p_entries
-- [{id?, work_date, kind, start_time, end_time, break_minutes, hours, notes}].
-- p_ot_choice ('overtime' | 'regular') is required when banked hours used take
-- the week over the threshold and nobody has chosen yet.
create or replace function public.save_timesheet_week(p_employee uuid, p_week_start date, p_entries jsonb, p_ot_choice text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws date := public.ts_week_start(p_week_start);
  v_week public.timesheet_weeks;
  v_e jsonb;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_before numeric;
  v_after numeric;
  r record;
begin
  perform public.require_perm('timesheets.enter', 'edit');
  if not exists (select 1 from public.employees where id = p_employee) then raise exception 'That employee could not be found.' using errcode = 'P0002'; end if;
  if p_ot_choice is not null and p_ot_choice not in ('overtime', 'regular') then raise exception 'Choose Overtime or Regular pay.' using errcode = '22023'; end if;
  v_id := public.ts_week_id(p_employee, v_ws);
  select * into v_week from public.timesheet_weeks where id = v_id;
  v_id := null;
  if v_week.status = 'approved' then
    raise exception 'This week is approved and locked. Unlock it first.' using errcode = '55000';
  end if;
  v_before := public.ts_bank_balance(p_employee);

  for v_e in select x from jsonb_array_elements(coalesce(p_entries, '[]')) x loop
    if (v_e ->> 'work_date')::date not between v_ws and v_ws + 6 then
      raise exception 'Every day must be in the week of %.', to_char(v_ws, 'Mon FMDD, YYYY') using errcode = '22023';
    end if;
    if nullif(v_e ->> 'id', '') is not null then v_ids := v_ids || (v_e ->> 'id')::uuid; end if;
  end loop;
  delete from public.time_entries where week_id = v_week.id and not (id = any (v_ids));

  for v_e in select x from jsonb_array_elements(coalesce(p_entries, '[]')) x loop
    if coalesce(v_e ->> 'kind', 'work') not in ('work', 'vacation', 'sick', 'banked', 'unpaid') then
      raise exception 'Unknown type of hours: %.', v_e ->> 'kind' using errcode = '22023';
    end if;
    if nullif(v_e ->> 'start_time', '') is null and coalesce(nullif(v_e ->> 'hours', '')::numeric, 0) <= 0 then
      continue;   -- an empty row
    end if;
    if (nullif(v_e ->> 'start_time', '') is null) <> (nullif(v_e ->> 'end_time', '') is null) then
      raise exception 'Enter both the start and the end on %, or only the total hours.', to_char((v_e ->> 'work_date')::date, 'Dy Mon FMDD') using errcode = '22023';
    end if;
    v_id := nullif(v_e ->> 'id', '')::uuid;
    if v_id is not null then
      update public.time_entries set
        work_date = (v_e ->> 'work_date')::date, kind = coalesce(v_e ->> 'kind', 'work'),
        start_time = nullif(v_e ->> 'start_time', '')::time, end_time = nullif(v_e ->> 'end_time', '')::time,
        break_minutes = coalesce(nullif(v_e ->> 'break_minutes', '')::int, 0),
        hours = coalesce(nullif(v_e ->> 'hours', '')::numeric, 0), notes = nullif(btrim(v_e ->> 'notes'), '')
       where id = v_id and employee_id = p_employee;
      if not found then v_id := null; end if;
    end if;
    if v_id is null then
      insert into public.time_entries (employee_id, work_date, kind, start_time, end_time, break_minutes, hours, notes)
      values (p_employee, (v_e ->> 'work_date')::date, coalesce(v_e ->> 'kind', 'work'),
              nullif(v_e ->> 'start_time', '')::time, nullif(v_e ->> 'end_time', '')::time,
              coalesce(nullif(v_e ->> 'break_minutes', '')::int, 0), coalesce(nullif(v_e ->> 'hours', '')::numeric, 0),
              nullif(btrim(v_e ->> 'notes'), ''));
    end if;
  end loop;

  -- No day over 24 hours.
  for r in select work_date, sum(hours) h from public.time_entries where week_id = v_week.id group by work_date having sum(hours) > 24 loop
    raise exception '% has % hours. A day cannot have more than 24.', to_char(r.work_date, 'Dy Mon FMDD'), trim_scale(r.h) using errcode = '22023';
  end loop;

  if p_ot_choice is not null and p_ot_choice is distinct from v_week.ot_choice then
    update public.timesheet_weeks set ot_choice = p_ot_choice, ot_choice_by = public.current_user_email(),
           ot_choice_by_name = public.current_user_name(), ot_choice_at = now()
     where id = v_week.id;
  end if;

  select * into r from public.timesheet_week_rows(v_ws, v_ws, p_employee) w where w.week_start = v_ws;
  if r.over_by_banked > 0 then
    if coalesce(p_ot_choice, v_week.ot_choice) is null then
      raise exception 'This week will be % hours: % worked + % banked. Choose how to pay the hours over %: Overtime or Regular pay.',
        trim_scale(r.worked + r.banked_used), trim_scale(r.worked), trim_scale(r.banked_used), trim_scale(r.threshold) using errcode = 'P0001', hint = 'ot_choice_needed';
    end if;
    if p_ot_choice is not null and p_ot_choice is distinct from v_week.ot_choice then
      perform public.ts_log(v_week.id, 'ot_choice', jsonb_build_object(
        'choice', p_ot_choice, 'total', r.worked + r.banked_used, 'worked', r.worked, 'banked', r.banked_used,
        'threshold', r.threshold, 'overtime', r.overtime, 'regular', r.regular), null);
    end if;
  end if;

  -- Hours banked this week cannot be more than the hours left in the week.
  if r.earned_overtime > r.overtime or r.earned_regular > greatest(0, r.regular - r.banked_used) then
    raise exception 'This week has % hours banked, more than these hours allow. Remove the banked hours first (Banked This Week).',
      trim_scale(r.earned_regular + r.earned_overtime) using errcode = '22023';
  end if;

  v_after := public.ts_bank_balance(p_employee);
  if v_after < 0 and v_after < v_before then
    raise exception 'Not enough banked hours: the balance would be % hours.', trim_scale(v_after) using errcode = '22023';
  end if;

  perform public.ts_log(v_week.id, 'entered', jsonb_build_object(
    'worked', r.worked, 'banked_used', r.banked_used, 'vacation', r.vacation, 'sick', r.sick, 'unpaid', r.unpaid,
    'overtime', r.overtime, 'regular', r.regular), null);
  return to_jsonb(r);
end;
$$;

-- Bank hours worked instead of being paid for them (a full day or part of a day).
create or replace function public.bank_hours(p_employee uuid, p_day date, p_hours numeric, p_source text, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws date := public.ts_week_start(p_day);
  v_credit numeric := case when p_source = 'overtime' then coalesce((public.payroll_settings() ->> 'banked_overtime_credit')::numeric, 1.5) else 1 end;
  r record;
begin
  perform public.require_perm('timesheets.enter', 'edit');
  if p_source not in ('regular', 'overtime') then raise exception 'Choose regular or overtime hours.' using errcode = '22023'; end if;
  if coalesce(p_hours, 0) <= 0 then raise exception 'Enter the hours to bank.' using errcode = '22023'; end if;
  insert into public.banked_hours (employee_id, work_date, kind, source, hours, credited, note)
  values (p_employee, p_day, 'earn', p_source, round(p_hours, 2), round(p_hours * v_credit, 2), nullif(btrim(p_note), ''));
  select * into r from public.timesheet_week_rows(v_ws, v_ws, p_employee) w where w.week_start = v_ws;
  if p_source = 'overtime' and r.earned_overtime > r.overtime then
    raise exception 'Only % overtime hours this week can be banked.', trim_scale(greatest(0, r.overtime - (r.earned_overtime - p_hours))) using errcode = '22023';
  end if;
  if p_source = 'regular' and r.earned_regular > greatest(0, r.regular - r.banked_used) then
    raise exception 'Only % regular hours worked this week can be banked.', trim_scale(greatest(0, r.regular - r.banked_used - (r.earned_regular - p_hours))) using errcode = '22023';
  end if;
  perform public.ts_log(r.week_id, 'banked', jsonb_build_object('day', p_day, 'hours', p_hours, 'source', p_source, 'credited', round(p_hours * v_credit, 2)), p_note);
end;
$$;

create or replace function public.remove_banked_hours(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.banked_hours;
begin
  perform public.require_perm('timesheets.enter', 'edit');
  select * into v from public.banked_hours where id = p_id;
  if v.id is null or v.kind = 'adjust' then raise exception 'That banked entry could not be found.' using errcode = 'P0002'; end if;
  if v.credited > 0 and public.ts_bank_balance(v.employee_id) - v.credited < 0 then
    raise exception 'These hours have already been used: the balance would go below zero.' using errcode = '22023';
  end if;
  delete from public.banked_hours where id = p_id;
  perform public.ts_log(v.week_id, 'bank_removed', jsonb_build_object('day', v.work_date, 'hours', v.hours, 'source', v.source), null);
end;
$$;

-- Correct a bank balance (users with "timesheets.adjust"), with a reason.
create or replace function public.adjust_banked_hours(p_employee uuid, p_hours numeric, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('timesheets.adjust', 'edit');
  if coalesce(p_hours, 0) = 0 then raise exception 'Enter the hours to add (or a negative number to take away).' using errcode = '22023'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Enter the reason for the change.' using errcode = '22023'; end if;
  insert into public.banked_hours (employee_id, work_date, kind, hours, credited, note)
  values (p_employee, public.halifax_today(), 'adjust', round(p_hours, 2), round(p_hours, 2), btrim(p_reason));
end;
$$;

-- Approve (and lock) a week: the employee's department manager, or "timesheets.approve".
create or replace function public.approve_timesheet_week(p_employee uuid, p_week_start date, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws date := public.ts_week_start(p_week_start);
  v_id uuid;
begin
  if not (public.has_perm('timesheets.approve', 'edit')
          or (public.ts_is_manager_of(p_employee) and public.has_perm('timesheets', 'view'))) then
    raise exception 'Only the employee''s department manager (or someone allowed to approve timesheets) can approve this week.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.employees where id = p_employee and user_email = public.current_user_email()) and not public.is_admin() then
    raise exception 'You cannot approve your own timesheet.' using errcode = 'P0001';
  end if;
  v_id := public.ts_week_id(p_employee, v_ws);
  if exists (select 1 from public.time_entries where week_id = v_id and needs_review)
     or exists (select 1 from public.banked_hours where week_id = v_id and needs_review) then
    raise exception 'This week has imported hours that need review. Mark them as reviewed first.' using errcode = '55000';
  end if;
  update public.timesheet_weeks set status = 'approved', approved_by = public.current_user_email(),
         approved_by_name = public.current_user_name(), approved_at = now()
   where id = v_id and status = 'open';
  if found then perform public.ts_log(v_id, 'approved', '{}', p_note); end if;
end;
$$;

create or replace function public.unlock_timesheet_week(p_employee uuid, p_week_start date, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_perm('timesheets.unlock', 'edit');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Enter the reason for unlocking the week.' using errcode = '22023'; end if;
  v_id := public.ts_week_id(p_employee, public.ts_week_start(p_week_start));
  update public.timesheet_weeks set status = 'open', approved_by = null, approved_by_name = null, approved_at = null
   where id = v_id and status = 'approved';
  if found then perform public.ts_log(v_id, 'unlocked', '{}', p_reason); end if;
end;
$$;

-- Imported hours checked: no longer "needs review".
create or replace function public.review_timesheet_week(p_employee uuid, p_week_start date, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_perm('timesheets.enter', 'edit');
  v_id := public.ts_week_id(p_employee, public.ts_week_start(p_week_start));
  update public.time_entries set needs_review = false where week_id = v_id and needs_review;
  update public.banked_hours set needs_review = false where week_id = v_id and needs_review;
  perform public.ts_log(v_id, 'reviewed', '{}', p_note);
end;
$$;

-- My Timesheet (read-only): the signed-in employee's weeks, entries, bank and leave for a year.
create or replace function public.my_timesheet(p_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp uuid := public.my_employee_id();
begin
  perform public.require_perm('timesheets.mine', 'view');
  if v_emp is null then return null; end if;
  return jsonb_build_object(
    'employee', (select jsonb_build_object('id', e.id, 'name', e.name, 'pay_type', e.pay_type, 'start_date', e.start_date)
                   from public.employees e where e.id = v_emp),
    'balances', public.employee_balances(v_emp, p_year),
    'weeks', coalesce((select jsonb_agg(to_jsonb(w) order by w.week_start desc)
                         from public.timesheet_week_rows(make_date(p_year, 1, 1), make_date(p_year, 12, 31), v_emp) w
                        where w.entries > 0 or w.stat > 0 or w.credited <> 0), '[]'),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'work_date', t.work_date, 'kind', t.kind,
                                 'start_time', t.start_time, 'end_time', t.end_time, 'break_minutes', t.break_minutes,
                                 'hours', t.hours, 'notes', t.notes) order by t.work_date, t.start_time)
                           from public.time_entries t
                          where t.employee_id = v_emp and t.work_date between make_date(p_year, 1, 1) - 6 and make_date(p_year, 12, 31) + 6), '[]'),
    'bank', coalesce((select jsonb_agg(to_jsonb(l) order by l.work_date desc, l.created_at desc)
                        from public.banked_hours_ledger l where l.employee_id = v_emp), '[]'));
end;
$$;

-- The new menu pages can be start pages.
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/freight', '/reports/department-delays',
     '/reports/build-times', '/machines', '/boards', '/notices', '/service', '/service/calendar', '/chat', '/agent', '/settings', '/admin', '/shop-board',
     '/timesheets', '/my-timesheet', '/time-off'));

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
