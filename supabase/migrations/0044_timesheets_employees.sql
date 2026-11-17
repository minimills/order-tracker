-- 0044 Timesheets, step 1 of 4: employees, pay rates, payroll settings, leave entitlements
--
-- 1. Payroll settings (Admin → Payroll Settings): overtime threshold, banked
--    overtime credit, hours per day, vacation and sick day rules, the PEI
--    minimums the app warns about.
-- 2. Department managers (Admin → Departments).
-- 3. Employees (Admin → Users → Employee Setup, Admin → Timesheets → Employees):
--    pay type, start date, payroll department. People without a login (for
--    example former staff in the imported sheets) can be employees too.
-- 4. Pay rates with their effective dates. ONLY people with "payroll.pay" can
--    read them (row security); they are never written to the activity log.
-- 5. Leave entitlements: the company rule from the settings, changed per
--    employee with a reason (history kept).
-- 6. Access lockdown.

-- ===========================================================================
-- 1. Payroll settings
-- ===========================================================================
insert into public.app_settings (key, value) values ('payroll', jsonb_build_object(
  'week_start', 1,                       -- ISO day the pay week starts (1 = Monday … 7 = Sunday)
  'overtime_weekly_hours', 44,           -- hours over this in a week are overtime
  'overtime_rate', 1.5,                  -- overtime is paid at this times the hourly rate
  'banked_overtime_credit', 1.5,         -- one banked overtime hour adds this many hours to the bank (1 or 1.5)
  'hours_per_day', 8,                    -- a full day (vacation, sick, banked day, statutory holiday)
  'vacation_tiers', '[{"after_years": 1, "days": 10}, {"after_years": 5, "days": 15}]'::jsonb,
  'sick_tiers', '[{"after_years": 1, "days": 3}]'::jsonb,
  'stat_min_days_employed', 30,          -- statutory holiday pay after this many days of employment
  'paid_holiday_kinds', '["statutory"]'::jsonb,
  'employer_cost_pct', 0,                -- employer costs (CPP, EI, WCB) as a % of pay, for labour cost
  'pei_minimum', jsonb_build_object(
    'overtime_weekly_hours', 44,
    'vacation_tiers', '[{"after_years": 1, "days": 10}, {"after_years": 5, "days": 15}]'::jsonb,
    'sick_tiers', '[{"after_years": 1, "days": 1}, {"after_years": 2, "days": 2}, {"after_years": 3, "days": 3}]'::jsonb)
))
on conflict (key) do nothing;

-- The settings with every key filled in (anyone signed in may read them: no pay data).
create or replace function public.payroll_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'week_start', 1, 'overtime_weekly_hours', 44, 'overtime_rate', 1.5, 'banked_overtime_credit', 1.5,
    'hours_per_day', 8,
    'vacation_tiers', '[{"after_years": 1, "days": 10}, {"after_years": 5, "days": 15}]'::jsonb,
    'sick_tiers', '[{"after_years": 1, "days": 3}]'::jsonb,
    'stat_min_days_employed', 30, 'paid_holiday_kinds', '["statutory"]'::jsonb, 'employer_cost_pct', 0,
    'pei_minimum', jsonb_build_object('overtime_weekly_hours', 44,
      'vacation_tiers', '[{"after_years": 1, "days": 10}, {"after_years": 5, "days": 15}]'::jsonb,
      'sick_tiers', '[{"after_years": 1, "days": 1}, {"after_years": 2, "days": 2}, {"after_years": 3, "days": 3}]'::jsonb))
    || coalesce((select value from public.app_settings where key = 'payroll'), '{}'::jsonb)
   where public.is_trusted_caller();
$$;

-- Days for a number of years of service from a list of tiers [{after_years, days}].
create or replace function public.leave_tier_days(p_tiers jsonb, p_years numeric)
returns numeric
language sql
immutable
as $$
  select coalesce(max((t ->> 'days')::numeric), 0)
    from jsonb_array_elements(coalesce(p_tiers, '[]'::jsonb)) t
   where p_years >= (t ->> 'after_years')::numeric;
$$;

create or replace function public.set_payroll_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := public.payroll_settings() || coalesce(p, '{}'::jsonb);
  t jsonb;
begin
  perform public.require_admin_area('payroll');
  if (v ->> 'week_start')::int not between 1 and 7 then raise exception 'The week must start on a day from Monday to Sunday.' using errcode = '22023'; end if;
  if (v ->> 'overtime_weekly_hours')::numeric not between 1 and 80 then raise exception 'The overtime threshold must be between 1 and 80 hours.' using errcode = '22023'; end if;
  if (v ->> 'overtime_rate')::numeric not between 1 and 3 then raise exception 'The overtime rate must be between 1 and 3 times the hourly rate.' using errcode = '22023'; end if;
  if (v ->> 'banked_overtime_credit')::numeric not between 1 and 3 then raise exception 'Banked overtime must count between 1 and 3 times the hours.' using errcode = '22023'; end if;
  if (v ->> 'hours_per_day')::numeric not between 1 and 24 then raise exception 'A day must be between 1 and 24 hours.' using errcode = '22023'; end if;
  if (v ->> 'employer_cost_pct')::numeric not between 0 and 100 then raise exception 'Employer costs must be between 0 and 100 %%.' using errcode = '22023'; end if;
  for t in select x from jsonb_array_elements(coalesce(v -> 'vacation_tiers', '[]') || coalesce(v -> 'sick_tiers', '[]')) x loop
    if (t ->> 'after_years')::numeric < 0 or (t ->> 'days')::numeric < 0 then
      raise exception 'Years of service and days cannot be negative.' using errcode = '22023';
    end if;
  end loop;
  insert into public.app_settings (key, value) values ('payroll', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'payroll', null, jsonb_build_object('action', 'payroll settings changed'));
end;
$$;

-- ===========================================================================
-- 2. Department managers
-- ===========================================================================
alter table public.departments add column manager_email text references public.allowed_users (email) on update cascade on delete set null;

-- People to choose from (department managers, linking a login to an employee,
-- reassigning work during time off).
create or replace function public.ts_people()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.can_admin('departments') or public.can_admin('employees') or public.can_admin('timesheets')
      or public.has_perm('timesheets.time_off.manage', 'view') or exists (
           select 1 from public.departments d where d.manager_email = public.current_user_email() and not d.archived)
   order by 2;
$$;

-- ===========================================================================
-- 3. Employees
-- ===========================================================================
create table public.employees (
  id            uuid primary key default gen_random_uuid(),
  user_email    text unique references public.allowed_users (email) on update cascade on delete set null,
  name          text not null check (btrim(name) <> ''),
  pay_type      text not null default 'hourly' check (pay_type in ('hourly', 'salaried')),
  department_id uuid references public.departments (id),
  start_date    date,
  end_date      date,
  hours_per_day numeric(4, 2) check (hours_per_day is null or hours_per_day between 1 and 24),
  -- other spellings of the name in imported timesheets
  import_names  text[] not null default '{}',
  notes         text,
  archived      boolean not null default false,
  archived_at   timestamptz,
  archived_by   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create trigger employees_updated_at before update on public.employees for each row execute function public.set_updated_at();
create trigger employees_archived_info before insert or update of archived on public.employees for each row execute function public.set_archived_info();

-- Is the signed-in person a manager of one of this employee's departments?
create or replace function public.ts_is_manager_of(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employees e
      join public.departments d on not d.archived and d.manager_email = public.current_user_email()
     where e.id = p_employee
       and (d.id = e.department_id
            or exists (select 1 from public.user_departments ud where ud.user_email = e.user_email and ud.department_id = d.id)));
$$;

-- The managers of an employee (emails).
create or replace function public.ts_managers_of(p_employee uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct d.manager_email
    from public.employees e
    join public.departments d on not d.archived and d.manager_email is not null
   where e.id = p_employee
     and (d.id = e.department_id
          or exists (select 1 from public.user_departments ud where ud.user_email = e.user_email and ud.department_id = d.id));
$$;

-- Who may see an employee's hours (not pay): timesheet people, report readers,
-- payroll, employee setup, their managers, and the employee themselves.
create or replace function public.ts_can_see(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_service_caller()
      or public.has_any_perm(array['timesheets', 'timesheets.reports', 'payroll.pay', 'admin.employees'], 'view')
      or public.ts_is_manager_of(p_employee)
      or exists (select 1 from public.employees e where e.id = p_employee and e.user_email = public.current_user_email()
                  and public.has_perm('timesheets.mine', 'view'));
$$;

alter table public.employees enable row level security;
create policy "Employees visible" on public.employees for select to authenticated
  using ((select public.ts_can_see(id)));
revoke insert, update, delete on public.employees from authenticated;
revoke all on public.employees from anon;

-- The signed-in person's own employee record.
create or replace function public.my_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.employees where user_email = public.current_user_email() and not archived;
$$;

-- Create or change an employee (not the pay rate: see set_pay_rate).
create or replace function public.save_employee(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_email text := nullif(lower(btrim(p ->> 'user_email')), '');
  v_name text := btrim(coalesce(p ->> 'name', ''));
begin
  perform public.require_admin_area('employees');
  if v_name = '' and v_email is not null then
    select coalesce(nullif(btrim(name), ''), email) into v_name from public.allowed_users where email = v_email;
  end if;
  if coalesce(v_name, '') = '' then raise exception 'Enter the employee''s name.' using errcode = '22023'; end if;
  if v_email is not null and not exists (select 1 from public.allowed_users where email = v_email) then
    raise exception '% is not on the users list.', v_email using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.employees (user_email, name, pay_type, department_id, start_date, end_date, hours_per_day, notes)
    values (v_email, v_name, coalesce(p ->> 'pay_type', 'hourly'), nullif(p ->> 'department_id', '')::uuid,
            nullif(p ->> 'start_date', '')::date, nullif(p ->> 'end_date', '')::date,
            nullif(p ->> 'hours_per_day', '')::numeric, nullif(btrim(p ->> 'notes'), ''))
    returning id into v_id;
    perform public.log_admin_action('employees', v_id::text, null, jsonb_build_object('action', 'employee added', 'name', v_name));
  else
    update public.employees e set
      user_email = case when p ? 'user_email' then v_email else e.user_email end,
      name = v_name,
      pay_type = case when p ? 'pay_type' then p ->> 'pay_type' else e.pay_type end,
      department_id = case when p ? 'department_id' then nullif(p ->> 'department_id', '')::uuid else e.department_id end,
      start_date = case when p ? 'start_date' then nullif(p ->> 'start_date', '')::date else e.start_date end,
      end_date = case when p ? 'end_date' then nullif(p ->> 'end_date', '')::date else e.end_date end,
      hours_per_day = case when p ? 'hours_per_day' then nullif(p ->> 'hours_per_day', '')::numeric else e.hours_per_day end,
      import_names = case when p ? 'import_names' then array(select distinct btrim(x) from jsonb_array_elements_text(p -> 'import_names') x where btrim(x) <> '') else e.import_names end,
      notes = case when p ? 'notes' then nullif(btrim(p ->> 'notes'), '') else e.notes end,
      archived = case when p ? 'archived' then (p ->> 'archived')::boolean else e.archived end
     where e.id = v_id;
    if not found then raise exception 'That employee could not be found.' using errcode = 'P0002'; end if;
    perform public.log_admin_action('employees', v_id::text, null, jsonb_build_object('action', 'employee changed', 'name', v_name));
  end if;
  return v_id;
end;
$$;

-- An imported name means this employee from now on.
create or replace function public.add_employee_alias(p_employee uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.can_admin('employees') or public.can_admin('timesheets')) then
    raise exception 'You do not have permission to do this (admin.timesheets). Ask an admin.' using errcode = 'P0001';
  end if;
  update public.employees set import_names = array(select distinct x from unnest(import_names || btrim(p_name)) x)
   where id = p_employee and btrim(p_name) <> '' and not btrim(p_name) = any (import_names);
end;
$$;

-- ===========================================================================
-- 4. Pay rates (secret: payroll.pay only)
-- ===========================================================================
create table public.employee_pay_rates (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees (id) on delete cascade,
  effective_from  date not null,
  pay_type        text not null check (pay_type in ('hourly', 'salaried')),
  hourly_rate     numeric(10, 2) check (hourly_rate is null or hourly_rate >= 0),
  annual_salary   numeric(12, 2) check (annual_salary is null or annual_salary >= 0),
  reason          text,
  created_by      text default public.current_user_email(),
  created_by_name text default public.current_user_name(),
  created_at      timestamptz not null default now(),
  check ((pay_type = 'hourly' and hourly_rate is not null) or (pay_type = 'salaried' and annual_salary is not null))
);
create index employee_pay_rates_idx on public.employee_pay_rates (employee_id, effective_from desc, created_at desc);
alter table public.employee_pay_rates enable row level security;
create policy "Pay readers" on public.employee_pay_rates for select to authenticated
  using ((select public.has_perm('payroll.pay', 'view')));
revoke insert, update, delete on public.employee_pay_rates from authenticated;
revoke all on public.employee_pay_rates from anon;

-- The rate on a day (internal; the earliest rate when the day is before every rate).
create or replace function public.pay_rate_on(p_employee uuid, p_day date)
returns public.employee_pay_rates
language sql
stable
security definer
set search_path = public
as $$
  select r.* from public.employee_pay_rates r
   where r.employee_id = p_employee
   order by (r.effective_from <= p_day) desc,
            case when r.effective_from <= p_day then r.effective_from end desc nulls last,
            r.effective_from asc, r.created_at desc
   limit 1;
$$;

create or replace function public.set_pay_rate(p_employee uuid, p_effective date, p_pay_type text, p_hourly numeric, p_salary numeric, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cur public.employee_pay_rates;
begin
  perform public.require_perm('payroll.pay', 'edit');
  if p_effective is null then raise exception 'Enter the date the rate starts.' using errcode = '22023'; end if;
  if p_pay_type not in ('hourly', 'salaried') then raise exception 'Choose Hourly or Salaried.' using errcode = '22023'; end if;
  if p_pay_type = 'hourly' and coalesce(p_hourly, 0) <= 0 then raise exception 'Enter the hourly rate.' using errcode = '22023'; end if;
  if p_pay_type = 'salaried' and coalesce(p_salary, 0) <= 0 then raise exception 'Enter the annual salary.' using errcode = '22023'; end if;
  if not exists (select 1 from public.employees where id = p_employee) then raise exception 'That employee could not be found.' using errcode = 'P0002'; end if;
  insert into public.employee_pay_rates (employee_id, effective_from, pay_type, hourly_rate, annual_salary, reason)
  values (p_employee, p_effective, p_pay_type,
          case when p_pay_type = 'hourly' then round(p_hourly, 2) end,
          case when p_pay_type = 'salaried' then round(p_salary, 2) end,
          nullif(btrim(p_reason), ''));
  -- The employee's pay type follows the rate in force today.
  v_cur := public.pay_rate_on(p_employee, public.halifax_today());
  update public.employees set pay_type = v_cur.pay_type where id = p_employee and v_cur.pay_type is not null;
  -- The activity log never holds amounts (it is readable by more people).
  perform public.log_admin_action('employee_pay_rates', p_employee::text, null,
    jsonb_build_object('action', 'pay rate changed', 'effective_from', p_effective));
end;
$$;

-- ===========================================================================
-- 5. Leave entitlements
-- ===========================================================================
create table public.leave_entitlement_changes (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees (id) on delete cascade,
  kind            text not null check (kind in ('vacation', 'sick')),
  year            integer check (year is null or year between 2000 and 2100),   -- null = every year
  days            numeric(5, 2) check (days is null or days >= 0),             -- null = back to the company rule
  reason          text not null check (btrim(reason) <> ''),
  created_by      text default public.current_user_email(),
  created_by_name text default public.current_user_name(),
  created_at      timestamptz not null default now()
);
create index leave_entitlement_changes_idx on public.leave_entitlement_changes (employee_id, kind, created_at desc);
alter table public.leave_entitlement_changes enable row level security;
create policy "Leave changes visible" on public.leave_entitlement_changes for select to authenticated
  using ((select public.ts_can_see(employee_id)));
revoke insert, update, delete on public.leave_entitlement_changes from authenticated;
revoke all on public.leave_entitlement_changes from anon;

-- Years of service on a day.
create or replace function public.years_of_service(p_employee uuid, p_day date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case when e.start_date is null or e.start_date > p_day then 0
              else extract(year from age(p_day, e.start_date)) + extract(month from age(p_day, e.start_date)) / 12.0 end
    from public.employees e where e.id = p_employee;
$$;

-- Days of vacation / paid sick leave for a calendar year: the employee's own
-- number for that year, else their own number for every year, else the company
-- rule for the years of service they reach by the end of that year.
create or replace function public.leave_entitlement(p_employee uuid, p_kind text, p_year integer)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days numeric;
begin
  -- the latest change for that year (empty days = back to the next rule)
  select c.days into v_days from public.leave_entitlement_changes c
   where c.employee_id = p_employee and c.kind = p_kind and c.year = p_year
   order by c.created_at desc limit 1;
  if v_days is not null then return v_days; end if;
  select c.days into v_days from public.leave_entitlement_changes c
   where c.employee_id = p_employee and c.kind = p_kind and c.year is null
   order by c.created_at desc limit 1;
  if v_days is not null then return v_days; end if;
  return public.leave_tier_days(public.payroll_settings() -> (p_kind || '_tiers'),
                                public.years_of_service(p_employee, make_date(p_year, 12, 31)));
end;
$$;

create or replace function public.set_leave_entitlement(p_employee uuid, p_kind text, p_year integer, p_days numeric, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('timesheets.adjust', 'edit');
  if p_kind not in ('vacation', 'sick') then raise exception 'Choose vacation or sick days.' using errcode = '22023'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Enter the reason for the change.' using errcode = '22023'; end if;
  insert into public.leave_entitlement_changes (employee_id, kind, year, days, reason)
  values (p_employee, p_kind, p_year, p_days, btrim(p_reason));
end;
$$;

-- ===========================================================================
-- 6. Access lockdown
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
-- Timesheets: pay rates only inside the payroll functions.
revoke execute on function public.pay_rate_on(uuid, date), public.ts_managers_of(uuid) from authenticated;
