-- 0047 Timesheets, step 4 of 4: import of the old timesheet sheets, labour cost
--
-- 1. Import layouts: how the columns of each tab of a sheet are matched
--    ("2025 sheet", "2026 sheet"), saved to reuse. The file itself is read in
--    the browser and never stored: only the cleaned rows are saved.
-- 2. import_timesheet_rows(): saves the cleaned rows as time entries (and
--    banked hours) marked as imported; rows kept as-is are "needs review".
--    Duplicates (the same row imported before) are skipped.
-- 3. labour_cost_weeks(): the cost of every employee per week (regular,
--    overtime, vacation, sick, statutory holiday pay, salary, employer costs).
--    ONLY for people with "payroll.pay".
-- 4. Access lockdown.

-- ===========================================================================
-- 1. Import layouts and batches
-- ===========================================================================
create table public.timesheet_import_layouts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (btrim(name) <> ''),
  -- {tabs: {<tab name>: {header_row, employee_id, columns: {<column letter>: <field>}}}, default: {...}}
  config     jsonb not null default '{}',
  created_by text default public.current_user_email(),
  updated_at timestamptz not null default now()
);
alter table public.timesheet_import_layouts enable row level security;
create policy "Import layouts" on public.timesheet_import_layouts for select to authenticated using ((select public.can_admin('timesheets')));
revoke insert, update, delete on public.timesheet_import_layouts from authenticated;
revoke all on public.timesheet_import_layouts from anon;

create or replace function public.save_timesheet_layout(p_name text, p_config jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('timesheets');
  if coalesce(btrim(p_name), '') = '' then raise exception 'Enter a name for the layout, for example “2025 sheet”.' using errcode = '22023'; end if;
  insert into public.timesheet_import_layouts (name, config) values (btrim(p_name), coalesce(p_config, '{}'))
  on conflict (name) do update set config = excluded.config, updated_at = now();
end;
$$;

create or replace function public.delete_timesheet_layout(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('timesheets');
  delete from public.timesheet_import_layouts where name = p_name;
end;
$$;

create table public.timesheet_imports (
  id            uuid primary key default gen_random_uuid(),
  file_name     text,
  layout_name   text,
  rows_saved    integer not null default 0,
  rows_skipped  integer not null default 0,
  needs_review  integer not null default 0,
  imported_by   text default public.current_user_email(),
  imported_by_name text default public.current_user_name(),
  imported_at   timestamptz not null default now()
);
alter table public.timesheet_imports enable row level security;
create policy "Import history" on public.timesheet_imports for select to authenticated using ((select public.can_admin('timesheets')));
revoke insert, update, delete on public.timesheet_imports from authenticated;
revoke all on public.timesheet_imports from anon;

-- Days that already have hours (for the "already imported / already entered" check).
create or replace function public.timesheet_days_with_hours(p_from date, p_to date)
returns table (employee_id uuid, work_date date, hours numeric, sources text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('timesheets');
  return query
    select t.employee_id, t.work_date, sum(t.hours), array_agg(distinct t.source)
      from public.time_entries t
     where t.work_date between p_from and p_to
     group by t.employee_id, t.work_date;
end;
$$;

create or replace function public.timesheet_import_keys(p_keys text[])
returns setof text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('timesheets');
  return query
    select split_part(t.import_key, '#', 1) from public.time_entries t where split_part(t.import_key, '#', 1) = any (p_keys)
    union
    select split_part(b.import_key, '#', 1) from public.banked_hours b where split_part(b.import_key, '#', 1) = any (p_keys);
end;
$$;

-- ===========================================================================
-- 2. Import
-- ===========================================================================
-- p_rows: [{employee_id, work_date, start_time, end_time, break_minutes, hours,
--   banked_earned, banked_used, vacation_hours, sick_hours, notes, needs_review,
--   review_note, import_key}]. p_approve: weeks with nothing to review are
--   marked approved ("Imported").
create or replace function public.import_timesheet_rows(p_file text, p_layout text, p_rows jsonb, p_approve boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid;
  v_r jsonb;
  v_key text;
  v_review boolean;
  v_saved integer := 0;
  v_skipped integer := 0;
  v_review_n integer := 0;
  v_prev text := coalesce(current_setting('app.ts_system', true), '');
  v_weeks uuid[] := '{}';
  v_n integer;
  v_w uuid;
begin
  perform public.require_admin_area('timesheets');
  if jsonb_array_length(coalesce(p_rows, '[]')) > 20000 then raise exception 'Import at most 20,000 rows at a time.' using errcode = '22023'; end if;
  insert into public.timesheet_imports (file_name, layout_name) values (left(p_file, 200), left(p_layout, 200)) returning id into v_batch;
  perform set_config('app.ts_system', 'on', true);

  for v_r in select x from jsonb_array_elements(coalesce(p_rows, '[]')) x loop
    if not exists (select 1 from public.employees where id = (v_r ->> 'employee_id')::uuid) then
      raise exception 'Row %: choose the employee.', coalesce(v_r ->> 'row', '?') using errcode = '22023';
    end if;
    if nullif(v_r ->> 'work_date', '') is null then
      raise exception 'Row %: the date is missing.', coalesce(v_r ->> 'row', '?') using errcode = '22023';
    end if;
    v_key := coalesce(nullif(v_r ->> 'import_key', ''), md5(v_r::text));
    v_review := coalesce((v_r ->> 'needs_review')::boolean, false);
    v_n := 0;

    if nullif(v_r ->> 'start_time', '') is not null and nullif(v_r ->> 'end_time', '') is not null
       or coalesce(nullif(v_r ->> 'hours', '')::numeric, 0) > 0 then
      insert into public.time_entries (employee_id, work_date, kind, start_time, end_time, break_minutes, hours, notes, source,
                                       import_batch_id, import_key, needs_review, review_note)
      values ((v_r ->> 'employee_id')::uuid, (v_r ->> 'work_date')::date, 'work',
              nullif(v_r ->> 'start_time', '')::time, nullif(v_r ->> 'end_time', '')::time,
              least(600, greatest(0, coalesce(nullif(v_r ->> 'break_minutes', '')::int, 0))),
              least(24, greatest(0, coalesce(nullif(v_r ->> 'hours', '')::numeric, 0))),
              nullif(btrim(v_r ->> 'notes'), ''), 'import', v_batch, v_key || '#work', v_review, nullif(btrim(v_r ->> 'review_note'), ''))
      on conflict do nothing;
      get diagnostics v_n = row_count;
    end if;
    if coalesce(nullif(v_r ->> 'banked_used', '')::numeric, 0) > 0 then
      insert into public.time_entries (employee_id, work_date, kind, hours, source, import_batch_id, import_key, needs_review, review_note)
      values ((v_r ->> 'employee_id')::uuid, (v_r ->> 'work_date')::date, 'banked', least(24, (v_r ->> 'banked_used')::numeric),
              'import', v_batch, v_key || '#banked', v_review, nullif(btrim(v_r ->> 'review_note'), ''))
      on conflict do nothing;
    end if;
    if coalesce(nullif(v_r ->> 'vacation_hours', '')::numeric, 0) > 0 then
      insert into public.time_entries (employee_id, work_date, kind, hours, source, import_batch_id, import_key, needs_review, review_note)
      values ((v_r ->> 'employee_id')::uuid, (v_r ->> 'work_date')::date, 'vacation', least(24, (v_r ->> 'vacation_hours')::numeric),
              'import', v_batch, v_key || '#vacation', v_review, nullif(btrim(v_r ->> 'review_note'), ''))
      on conflict do nothing;
    end if;
    if coalesce(nullif(v_r ->> 'sick_hours', '')::numeric, 0) > 0 then
      insert into public.time_entries (employee_id, work_date, kind, hours, source, import_batch_id, import_key, needs_review, review_note)
      values ((v_r ->> 'employee_id')::uuid, (v_r ->> 'work_date')::date, 'sick', least(24, (v_r ->> 'sick_hours')::numeric),
              'import', v_batch, v_key || '#sick', v_review, nullif(btrim(v_r ->> 'review_note'), ''))
      on conflict do nothing;
    end if;
    if coalesce(nullif(v_r ->> 'banked_earned', '')::numeric, 0) > 0 then
      insert into public.banked_hours (employee_id, work_date, kind, source, hours, credited, note, import_batch_id, import_key, needs_review)
      values ((v_r ->> 'employee_id')::uuid, (v_r ->> 'work_date')::date, 'import', 'regular',
              (v_r ->> 'banked_earned')::numeric, (v_r ->> 'banked_earned')::numeric, 'Imported', v_batch, v_key || '#earned', v_review)
      on conflict do nothing;
    end if;

    if exists (select 1 from public.time_entries where import_key like v_key || '#%' and import_batch_id = v_batch)
       or exists (select 1 from public.banked_hours where import_key like v_key || '#%' and import_batch_id = v_batch) then
      v_saved := v_saved + 1;
      if v_review then v_review_n := v_review_n + 1; end if;
      v_w := public.ts_week_id((v_r ->> 'employee_id')::uuid, (v_r ->> 'work_date')::date);
      if not v_w = any (v_weeks) then v_weeks := v_weeks || v_w; end if;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  foreach v_w in array v_weeks loop
    perform public.ts_log(v_w, 'imported', jsonb_build_object('batch', v_batch, 'file', p_file, 'layout', p_layout), null);
    if p_approve and not exists (select 1 from public.time_entries where week_id = v_w and needs_review)
       and not exists (select 1 from public.banked_hours where week_id = v_w and needs_review) then
      update public.timesheet_weeks set status = 'approved', approved_by = public.current_user_email(),
             approved_by_name = 'Imported (' || public.current_user_name() || ')', approved_at = now()
       where id = v_w and status = 'open';
    end if;
  end loop;

  perform set_config('app.ts_system', v_prev, true);
  update public.timesheet_imports set rows_saved = v_saved, rows_skipped = v_skipped, needs_review = v_review_n where id = v_batch;
  perform public.log_admin_action('timesheet_imports', v_batch::text, null, jsonb_build_object(
    'action', 'timesheets imported', 'file', p_file, 'layout', p_layout, 'rows', v_saved, 'skipped', v_skipped, 'needs_review', v_review_n));
  return jsonb_build_object('batch', v_batch, 'saved', v_saved, 'skipped', v_skipped, 'needs_review', v_review_n);
end;
$$;

-- Remove everything one import added (weeks approved since then stay as they are).
create or replace function public.delete_timesheet_import(p_batch uuid, p_confirm text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
  v_prev text := coalesce(current_setting('app.ts_system', true), '');
begin
  perform public.require_admin_area('timesheets');
  if p_confirm is distinct from 'DELETE' then raise exception 'Type DELETE to confirm.' using errcode = '22023'; end if;
  perform set_config('app.ts_system', 'on', true);
  delete from public.time_entries where import_batch_id = p_batch;
  get diagnostics v_n = row_count;
  delete from public.banked_hours where import_batch_id = p_batch;
  delete from public.timesheet_imports where id = p_batch;
  perform set_config('app.ts_system', v_prev, true);
  perform public.log_admin_action('timesheet_imports', p_batch::text, null, jsonb_build_object('action', 'import removed', 'entries', v_n));
  return v_n;
end;
$$;

-- ===========================================================================
-- 3. Labour cost (payroll.pay only)
-- ===========================================================================
-- One row per employee and week (weeks of timesheet_week_rows) with the pay
-- rate in force at the start of the week (the earliest rate when the week is
-- before every rate: rate_assumed) and the cost:
--   hourly:   paid regular × rate, paid overtime × rate × overtime rate,
--             vacation, sick and statutory holiday hours × rate
--   salaried: annual salary ÷ 52 for every week employed
--   employer costs: the setting's % of all of it.
create or replace function public.labour_cost_weeks(p_from date, p_to date)
returns table (
  employee_id uuid, employee_name text, department_id uuid, department_name text, week_start date,
  pay_type text, hourly_rate numeric, annual_salary numeric, rate_assumed boolean, no_rate boolean,
  worked numeric, paid_regular numeric, paid_overtime numeric, vacation numeric, sick numeric, stat numeric,
  banked_used numeric, unpaid numeric, imported boolean,
  cost_regular numeric, cost_overtime numeric, cost_vacation numeric, cost_sick numeric, cost_stat numeric,
  cost_salary numeric, cost_employer numeric, cost_total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ot numeric := coalesce((public.payroll_settings() ->> 'overtime_rate')::numeric, 1.5);
  v_pct numeric := coalesce((public.payroll_settings() ->> 'employer_cost_pct')::numeric, 0);
begin
  perform public.require_perm('payroll.pay', 'view');
  if p_to - p_from > 3700 then raise exception 'Choose at most 10 years.' using errcode = '22023'; end if;
  return query
    with w as (
      select t.*, e.start_date es, e.end_date ee, d.name dname, r.pay_type rpt, r.hourly_rate hr, r.annual_salary sal,
             r.effective_from > t.week_start assumed, r.id is null missing
        from public.timesheet_week_rows(p_from, p_to) t
        join public.employees e on e.id = t.employee_id
        left join public.departments d on d.id = t.department_id
        left join lateral public.pay_rate_on(t.employee_id, t.week_start) r on true),
    c as (
      select w.*,
             case when w.rpt = 'hourly' then round(w.paid_regular * w.hr, 2) else 0 end c_reg,
             case when w.rpt = 'hourly' then round(w.paid_overtime * w.hr * v_ot, 2) else 0 end c_ot,
             case when w.rpt = 'hourly' then round(w.vacation * w.hr, 2) else 0 end c_vac,
             case when w.rpt = 'hourly' then round(w.sick * w.hr, 2) else 0 end c_sick,
             case when w.rpt = 'hourly' then round(w.stat * w.hr, 2) else 0 end c_stat,
             case when w.rpt = 'salaried' and (w.es is null or w.es <= w.week_start + 6) and (w.ee is null or w.ee >= w.week_start)
                  then round(w.sal / 52, 2) else 0 end c_sal
        from w)
    select c.employee_id, c.employee_name, c.department_id, c.dname, c.week_start,
           coalesce(c.rpt, c.pay_type), c.hr, c.sal, coalesce(c.assumed, false), c.missing,
           c.worked, c.paid_regular, c.paid_overtime, c.vacation, c.sick, c.stat, c.banked_used, c.unpaid, c.imported,
           c.c_reg, c.c_ot, c.c_vac, c.c_sick, c.c_stat, c.c_sal,
           round((c.c_reg + c.c_ot + c.c_vac + c.c_sick + c.c_stat + c.c_sal) * v_pct / 100, 2),
           round((c.c_reg + c.c_ot + c.c_vac + c.c_sick + c.c_stat + c.c_sal) * (1 + v_pct / 100), 2)
      from c
     order by c.employee_name, c.week_start;
end;
$$;

-- The pay rates with their history (payroll.pay; the table's row security applies too).
create or replace function public.pay_rate_history(p_employee uuid)
returns setof public.employee_pay_rates
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_perm('payroll.pay', 'view');
  return query select * from public.employee_pay_rates where employee_id = p_employee order by effective_from desc, created_at desc;
end;
$$;

-- ===========================================================================
-- 4. Access lockdown
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
