-- 0046 Timesheets, step 3 of 4: time off requests
--
-- 1. time_off_requests (vacation / sick / banked time / unpaid; whole days or
--    some hours a day, note). This is the table chat_time_off (0040) reads for
--    "<name> is on vacation and may not read this until …".
-- 2. Request → the employee's department managers are notified (in the app and
--    by email, their channel choices apply) → Approve or Decline with a comment
--    → the employee is notified. Approved requests write the hours of the days
--    off into the timesheet (vacation, sick, banked used, unpaid).
-- 3. Work during the time off: cards assigned to the person, service calls and
--    training visits they are the technician of. The manager sees the list and
--    chooses to reassign or move each one; nothing moves without confirming.
-- 4. Who's off today (dashboard, Notice Board) and the Absence Calendar.
-- 5. Access lockdown.

insert into public.notification_kinds (kind, label, description, sort_order, default_modes) values
  ('time_off_request', 'Time off request', 'For department managers: someone asked for time off.', 90, '{"app": "on", "push": "on", "email": "instant", "desktop": "on"}'),
  ('time_off_decision', 'Time off approved or declined', 'Your time off request was approved or declined.', 91, '{"app": "on", "push": "on", "email": "instant", "desktop": "on"}')
on conflict (kind) do nothing;

-- ===========================================================================
-- 1. Requests
-- ===========================================================================
create table public.time_off_requests (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references public.employees (id) on delete cascade,
  user_email       text references public.allowed_users (email) on update cascade on delete set null,
  kind             text not null check (kind in ('vacation', 'sick', 'banked', 'unpaid')),
  start_date       date not null,
  end_date         date not null,
  hours            numeric(5, 2) check (hours is null or hours > 0 and hours <= 24),   -- null = whole days
  note             text,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decided_by       text,
  decided_by_name  text,
  decided_at       timestamptz,
  decision_comment text,
  -- reassigned / moved work: [{item_type, item_id, title, action, to, new_date, by, at}]
  work_changes     jsonb not null default '[]',
  created_by       text default public.current_user_email(),
  created_by_name  text default public.current_user_name(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (end_date >= start_date)
);
create index time_off_requests_dates_idx on public.time_off_requests (start_date, end_date);
create index time_off_requests_emp_idx on public.time_off_requests (employee_id, start_date);
create trigger time_off_requests_updated_at before update on public.time_off_requests for each row execute function public.set_updated_at();

-- May the signed-in person approve or decline for this employee?
create or replace function public.ts_can_decide(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (public.has_perm('timesheets.time_off.manage', 'edit') or public.ts_is_manager_of(p_employee))
     and (public.is_admin() or not exists (select 1 from public.employees e where e.id = p_employee and e.user_email = public.current_user_email()));
$$;

alter table public.time_off_requests enable row level security;
create policy "Own, managers and time off managers" on public.time_off_requests for select to authenticated
  using (user_email = (select public.current_user_email())
         or (select public.has_perm('timesheets.time_off.manage', 'view'))
         or public.ts_is_manager_of(employee_id));
revoke insert, update, delete on public.time_off_requests from authenticated;
revoke all on public.time_off_requests from anon;

create or replace function public.ts_kind_words(p_kind text)
returns text
language sql
immutable
as $$
  select case p_kind when 'vacation' then 'vacation' when 'sick' then 'sick leave' when 'banked' then 'banked time' else 'unpaid time off' end;
$$;

create or replace function public.ts_dates_text(p_from date, p_to date)
returns text
language sql
immutable
as $$
  select case when p_from = p_to then to_char(p_from, 'Dy, Mon FMDD')
              else to_char(p_from, 'Dy, Mon FMDD') || ' to ' || to_char(p_to, 'Dy, Mon FMDD') end;
$$;

-- Ask for time off. Employees ask for themselves; people who enter hours may ask for anyone.
create or replace function public.request_time_off(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp uuid := nullif(p ->> 'employee_id', '')::uuid;
  v_e public.employees;
  v_id uuid;
  v_kind text := p ->> 'kind';
  v_from date := (p ->> 'start_date')::date;
  v_to date := coalesce(nullif(p ->> 'end_date', '')::date, (p ->> 'start_date')::date);
  v_to_notify text[];
  v_who text;
begin
  if v_emp is null or v_emp = public.my_employee_id() then
    perform public.require_perm('timesheets.time_off.request', 'edit');
    v_emp := public.my_employee_id();
    if v_emp is null then
      raise exception 'You are not set up as an employee yet. Ask the office to add you in Admin → Users → Employee Setup.' using errcode = 'P0002';
    end if;
  else
    perform public.require_perm('timesheets.enter', 'edit');
  end if;
  select * into v_e from public.employees where id = v_emp;
  if v_kind not in ('vacation', 'sick', 'banked', 'unpaid') then raise exception 'Choose the type of time off.' using errcode = '22023'; end if;
  if v_from is null then raise exception 'Choose the first day off.' using errcode = '22023'; end if;
  if v_to < v_from then raise exception 'The last day must be on or after the first day.' using errcode = '22023'; end if;
  if v_to - v_from > 120 then raise exception 'A request can cover at most 120 days.' using errcode = '22023'; end if;
  if exists (select 1 from public.time_off_requests r where r.employee_id = v_emp and r.status in ('pending', 'approved')
              and daterange(r.start_date, r.end_date, '[]') && daterange(v_from, v_to, '[]')) then
    raise exception 'There is already a request for some of these days.' using errcode = '22023';
  end if;
  insert into public.time_off_requests (employee_id, user_email, kind, start_date, end_date, hours, note)
  values (v_emp, v_e.user_email, v_kind, v_from, v_to, nullif(p ->> 'hours', '')::numeric, nullif(btrim(p ->> 'note'), ''))
  returning id into v_id;

  -- The department managers, else the people who manage time off.
  select array_agg(m) into v_to_notify from public.ts_managers_of(v_emp) m where m is distinct from v_e.user_email;
  if v_to_notify is null then
    select array_agg(a.email) into v_to_notify from public.allowed_users a
     where public.perm_of(a.email, 'timesheets.time_off.manage', 'edit') and a.email is distinct from v_e.user_email;
  end if;
  foreach v_who in array coalesce(v_to_notify, '{}') loop
    insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
    values (v_who, 'time_off_request', v_e.name || ' asked for ' || public.ts_kind_words(v_kind),
            public.ts_dates_text(v_from, v_to)
              || case when nullif(p ->> 'hours', '') is not null then ' (' || trim_scale((p ->> 'hours')::numeric) || ' hours a day)' else '' end
              || coalesce(E'\n' || nullif(btrim(p ->> 'note'), ''), ''),
            '/time-off?request=' || v_id, 'time_off:' || v_id || ':request')
    on conflict do nothing;
  end loop;
  return v_id;
end;
$$;

-- Cancel: the employee (their own pending request), or a manager (also an approved one).
create or replace function public.cancel_time_off(p_request uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.time_off_requests;
begin
  select * into r from public.time_off_requests where id = p_request for update;
  if r.id is null then raise exception 'That request could not be found.' using errcode = 'P0002'; end if;
  if not ((r.user_email = public.current_user_email() and r.status = 'pending' and public.has_perm('timesheets.time_off.request', 'edit'))
          or public.ts_can_decide(r.employee_id)) then
    raise exception 'You cannot cancel this request.' using errcode = 'P0001';
  end if;
  if r.status not in ('pending', 'approved') then raise exception 'This request is already %.', r.status using errcode = '55000'; end if;
  if exists (select 1 from public.time_entries t join public.timesheet_weeks w on w.id = t.week_id
              where t.time_off_id = r.id and w.status = 'approved') then
    raise exception 'Some of these days are in an approved timesheet week. Unlock that week first.' using errcode = '55000';
  end if;
  delete from public.time_entries where time_off_id = r.id;
  update public.time_off_requests set status = 'cancelled', decided_by = public.current_user_email(),
         decided_by_name = public.current_user_name(), decided_at = now()
   where id = r.id;
end;
$$;

-- Approve or decline (with an optional comment). Approving writes the hours.
create or replace function public.decide_time_off(p_request uuid, p_decision text, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.time_off_requests;
  v_hpd numeric;
  v_day date;
  v_hours numeric;
  v_status text;
  v_made integer := 0;
  v_skipped text[] := '{}';
  v_needed numeric := 0;
  v_balance numeric;
begin
  select * into r from public.time_off_requests where id = p_request for update;
  if r.id is null then raise exception 'That request could not be found.' using errcode = 'P0002'; end if;
  if not public.ts_can_decide(r.employee_id) then
    raise exception 'Only the employee''s department manager (or someone allowed to manage time off) can decide this request.' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then raise exception 'This request is already %.', r.status using errcode = '55000'; end if;
  if p_decision not in ('approved', 'declined') then raise exception 'Choose Approve or Decline.' using errcode = '22023'; end if;

  if p_decision = 'approved' then
    select coalesce(e.hours_per_day, (public.payroll_settings() ->> 'hours_per_day')::numeric) into v_hpd
      from public.employees e where e.id = r.employee_id;
    v_hours := least(coalesce(r.hours, v_hpd), 24);
    if r.kind = 'banked' then
      select count(*) * v_hours into v_needed from generate_series(r.start_date, r.end_date, interval '1 day') d
       where public.is_working_day(d::date);
      v_balance := public.ts_bank_balance(r.employee_id);
      if v_needed > v_balance then
        raise exception 'Not enough banked hours: % hours available, % hours asked for.', trim_scale(v_balance), trim_scale(v_needed) using errcode = '22023';
      end if;
    end if;
    for v_day in select d::date from generate_series(r.start_date, r.end_date, interval '1 day') d loop
      continue when not public.is_working_day(v_day);
      select w.status into v_status from public.timesheet_weeks w
       where w.employee_id = r.employee_id and w.week_start = public.ts_week_start(v_day);
      if v_status = 'approved' then
        v_skipped := v_skipped || to_char(v_day, 'Dy Mon FMDD');
        continue;
      end if;
      insert into public.time_entries (employee_id, work_date, kind, hours, notes, source, time_off_id)
      values (r.employee_id, v_day, r.kind, v_hours, nullif(btrim(coalesce(r.note, '')), ''), 'time_off', r.id);
      perform public.ts_log(public.ts_week_id(r.employee_id, v_day), 'time_off',
        jsonb_build_object('day', v_day, 'kind', r.kind, 'hours', v_hours), 'Approved time off request');
      v_made := v_made + 1;
    end loop;
  end if;

  update public.time_off_requests set status = p_decision, decided_by = public.current_user_email(),
         decided_by_name = public.current_user_name(), decided_at = now(), decision_comment = nullif(btrim(p_comment), '')
   where id = r.id;

  if r.user_email is not null then
    insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
    values (r.user_email, 'time_off_decision',
            'Your ' || public.ts_kind_words(r.kind) || ' request was ' || p_decision,
            public.ts_dates_text(r.start_date, r.end_date) || coalesce(E'\n' || public.current_user_name() || ': ' || nullif(btrim(p_comment), ''), ''),
            '/time-off?request=' || r.id, 'time_off:' || r.id || ':decision')
    on conflict do nothing;
  end if;
  return jsonb_build_object('days_written', v_made, 'skipped_days', to_jsonb(v_skipped));
end;
$$;

-- ===========================================================================
-- 3. Work that falls during the time off
-- ===========================================================================
create or replace function public.time_off_affected_work(p_request uuid)
returns table (item_type text, item_id uuid, title text, context text, start_date date, end_date date, link text,
               can_reassign boolean, can_move boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r public.time_off_requests;
begin
  select * into r from public.time_off_requests where id = p_request;
  if r.id is null or not public.ts_can_decide(r.employee_id) then
    raise exception 'You cannot see the work of this request.' using errcode = 'P0001';
  end if;
  if r.user_email is null then return; end if;
  return query
    -- cards and tasks assigned to them, due during the time off
    select 'card'::text, c.id, c.title, b.name, c.due_date, c.due_date, '/boards/' || b.id || '?card=' || c.id,
           public.board_level(b.id) >= 2 and public.has_perm('boards.card.edit', 'edit') and public.has_perm('boards.card.assignees', 'edit'),
           public.board_level(b.id) >= 2 and public.has_perm('boards.card.edit', 'edit') and public.has_perm('boards.card.due', 'edit')
      from public.board_cards c
      join public.board_card_assignees a on a.card_id = c.id and a.user_email = r.user_email
      join public.boards b on b.id = c.board_id and not b.archived
     where not c.archived and c.finished_at is null and c.card_kind <> 'service'
       and c.due_date between r.start_date and r.end_date
    union all
    -- service calls they are the technician of
    select 'service_call', s.card_id, 'S-' || s.call_number || ' ' || c.title, coalesce(cu.company, cu.name, ''),
           s.planned_start, coalesce(s.planned_end, s.planned_start), '/service/calls/' || s.card_id,
           public.has_perm('service.calls.edit', 'edit'), public.has_perm('service.calls.edit', 'edit')
      from public.service_calls s
      join public.board_cards c on c.id = s.card_id and not c.archived and c.finished_at is null
      left join public.customers cu on cu.id = s.customer_id
     where s.technician_email = r.user_email and s.planned_start is not null
       and daterange(s.planned_start, coalesce(s.planned_end, s.planned_start), '[]') && daterange(r.start_date, r.end_date, '[]')
    union all
    -- training visits they are the technician of
    select 'training', o.id, 'Order ' || o.order_code || ' training', coalesce(cu.company, cu.name, ''),
           o.service_start, coalesce(o.service_end, o.service_start), '/orders/' || o.id,
           public.has_perm('order.field.technician', 'edit'), public.has_perm('order.field.service_dates', 'edit')
      from public.orders o
      left join public.customers cu on cu.id = o.customer_id
     where o.technician_email = r.user_email and not o.archived and o.stage <> 'Cancelled' and o.service_start is not null
       and daterange(o.service_start, coalesce(o.service_end, o.service_start), '[]') && daterange(r.start_date, r.end_date, '[]')
     order by 5, 3;
end;
$$;

-- Reassign or move the chosen items: [{item_type, item_id, action 'reassign' | 'move', to_email, new_date}].
-- Each change is checked with the manager's own permissions (board and field guards apply too).
create or replace function public.apply_time_off_changes(p_request uuid, p_changes jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.time_off_requests;
  c jsonb;
  v_item record;
  v_to text;
  v_date date;
  v_n integer := 0;
  v_log jsonb := '[]';
  v_board uuid;
begin
  select * into r from public.time_off_requests where id = p_request for update;
  if r.id is null or not public.ts_can_decide(r.employee_id) then
    raise exception 'You cannot change the work of this request.' using errcode = 'P0001';
  end if;
  for c in select x from jsonb_array_elements(coalesce(p_changes, '[]')) x loop
    select * into v_item from public.time_off_affected_work(p_request) w
     where w.item_type = c ->> 'item_type' and w.item_id = (c ->> 'item_id')::uuid;
    if v_item.item_id is null then raise exception 'One of the items is no longer during this time off. Refresh the list.' using errcode = 'P0002'; end if;
    v_to := nullif(lower(btrim(c ->> 'to_email')), '');
    v_date := nullif(c ->> 'new_date', '')::date;
    if c ->> 'action' = 'reassign' then
      if not v_item.can_reassign then raise exception 'You cannot reassign “%”.', v_item.title using errcode = 'P0001'; end if;
      if v_to is null or not exists (select 1 from public.allowed_users where email = v_to) then
        raise exception 'Choose who takes over “%”.', v_item.title using errcode = '22023';
      end if;
      if v_item.item_type = 'card' then
        select board_id into v_board from public.board_cards where id = v_item.item_id;
        if public.board_access_of(v_board, v_to) < 1 then
          raise exception '% cannot open the board of “%”. Share the board first.', v_to, v_item.title using errcode = '22023';
        end if;
        delete from public.board_card_assignees where card_id = v_item.item_id and user_email = r.user_email;
        insert into public.board_card_assignees (card_id, user_email) values (v_item.item_id, v_to) on conflict do nothing;
      elsif v_item.item_type = 'service_call' then
        perform public.update_service_call(v_item.item_id, jsonb_build_object('technician_email', v_to));
      else
        update public.orders set technician_email = v_to where id = v_item.item_id;
      end if;
    elsif c ->> 'action' = 'move' then
      if not v_item.can_move then raise exception 'You cannot move “%”.', v_item.title using errcode = 'P0001'; end if;
      if v_date is null then raise exception 'Choose the new date of “%”.', v_item.title using errcode = '22023'; end if;
      if v_item.item_type = 'card' then
        update public.board_cards set due_date = v_date where id = v_item.item_id;
      elsif v_item.item_type = 'service_call' then
        perform public.update_service_call(v_item.item_id, jsonb_build_object(
          'planned_start', v_date, 'planned_end', v_date + (v_item.end_date - v_item.start_date)));
      else
        update public.orders set service_start = v_date, service_end = v_date + (v_item.end_date - v_item.start_date) where id = v_item.item_id;
      end if;
    else
      continue;
    end if;
    v_n := v_n + 1;
    v_log := v_log || jsonb_build_object('item_type', v_item.item_type, 'item_id', v_item.item_id, 'title', v_item.title,
      'action', c ->> 'action', 'to', v_to, 'new_date', v_date, 'by', public.current_user_name(), 'at', now());
  end loop;
  update public.time_off_requests set work_changes = work_changes || v_log where id = r.id;
  return v_n;
end;
$$;

-- ===========================================================================
-- 4. Who's off, absence calendar
-- ===========================================================================
-- People off on a day (approved requests and whole days of leave in the timesheet).
-- The reason is only given to people who see the Absence Calendar.
create or replace function public.whos_off(p_day date default null)
returns table (employee_id uuid, name text, user_email text, kind text, start_date date, end_date date, back_on date, hours numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_day date := coalesce(p_day, public.halifax_today());
  v_kinds boolean := public.has_perm('timesheets.absences', 'view');
begin
  if not public.has_any_perm(array['dashboard.whos_off', 'notices.whos_off', 'timesheets.absences'], 'view') then
    raise exception 'You do not have permission to see who is off.' using errcode = 'P0001';
  end if;
  return query
    with off as (
      select r.employee_id, r.kind, r.start_date, r.end_date, r.hours
        from public.time_off_requests r
       where r.status = 'approved' and v_day between r.start_date and r.end_date
      union all
      select t.employee_id, t.kind, t.work_date, t.work_date, t.hours
        from public.time_entries t
       where t.work_date = v_day and t.kind in ('vacation', 'sick', 'banked', 'unpaid') and t.time_off_id is null)
    select distinct on (e.id) e.id, e.name, e.user_email, case when v_kinds then o.kind end, o.start_date, o.end_date,
           (select min(d)::date from generate_series(o.end_date + 1, o.end_date + 40, interval '1 day') d where public.is_working_day(d::date)),
           o.hours
      from off o join public.employees e on e.id = o.employee_id and not e.archived
     order by e.id, o.end_date desc;
end;
$$;

-- Absences for managers: everyone (time off managers, approvers) or the departments they manage.
create or replace function public.absence_calendar(p_from date, p_to date)
returns table (employee_id uuid, name text, department_id uuid, kind text, start_date date, end_date date, hours numeric,
               status text, request_id uuid, source text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_all boolean := public.has_any_perm(array['timesheets.time_off.manage', 'timesheets.approve'], 'view');
begin
  perform public.require_perm('timesheets.absences', 'view');
  if p_to - p_from > 400 then raise exception 'Choose at most 400 days.' using errcode = '22023'; end if;
  return query
    select e.id, e.name, e.department_id, r.kind, r.start_date, r.end_date, r.hours, r.status, r.id, 'request'::text
      from public.time_off_requests r join public.employees e on e.id = r.employee_id
     where r.status in ('pending', 'approved') and r.end_date >= p_from and r.start_date <= p_to
       and (v_all or public.ts_is_manager_of(e.id))
    union all
    select e.id, e.name, e.department_id, t.kind, t.work_date, t.work_date, t.hours, 'approved', null::uuid, t.source
      from public.time_entries t join public.employees e on e.id = t.employee_id
     where t.kind in ('vacation', 'sick', 'banked', 'unpaid') and t.time_off_id is null
       and t.work_date between p_from and p_to
       and (v_all or public.ts_is_manager_of(e.id))
     order by 2, 5;
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
revoke execute on function public.pay_rate_on(uuid, date), public.ts_managers_of(uuid),
  public.ts_week_id(uuid, date), public.ts_log(uuid, text, jsonb, text) from authenticated;
