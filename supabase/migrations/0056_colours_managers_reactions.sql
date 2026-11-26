-- 0056: custom colours, several managers per department, who reacted to a notice.
--
-- 1. Custom colours: notices, personal notes and company events also accept a
--    colour code (#rrggbb) chosen with the full colour picker, besides the
--    named preset colours.
-- 2. Department managers: a department can have any number of managers
--    (department_managers). Every manager is told about time off requests and
--    may approve weeks and decide time off; the first decision settles a
--    request and the other managers are told who decided.
--    departments.manager_email is kept as the first manager (older screens).
-- 3. notice_reaction_people(notice): who reacted to a notice, with names.
-- 4. Access lockdown.

-- ===========================================================================
-- 1. Custom colours
-- ===========================================================================
alter table public.notices drop constraint if exists notices_colour_check;
alter table public.notices add constraint notices_colour_check
  check (colour in ('yellow', 'blue', 'green', 'pink', 'orange', 'purple', 'white') or colour ~ '^#[0-9a-fA-F]{6}$');
alter table public.personal_notes drop constraint if exists personal_notes_colour_check;
alter table public.personal_notes add constraint personal_notes_colour_check
  check (colour in ('yellow', 'blue', 'green', 'pink', 'orange', 'purple', 'white') or colour ~ '^#[0-9a-fA-F]{6}$');
alter table public.company_events drop constraint if exists company_events_colour_check;
alter table public.company_events add constraint company_events_colour_check
  check (colour is null or colour in ('blue', 'green', 'amber', 'red', 'purple', 'teal', 'slate') or colour ~ '^#[0-9a-fA-F]{6}$');

-- ===========================================================================
-- 2. Several managers per department
-- ===========================================================================
create table public.department_managers (
  department_id uuid not null references public.departments (id) on delete cascade,
  user_email    text not null references public.allowed_users (email) on update cascade on delete cascade,
  added_by      text,
  added_at      timestamptz not null default now(),
  primary key (department_id, user_email)
);
create index department_managers_email on public.department_managers (user_email);

insert into public.department_managers (department_id, user_email)
select id, manager_email from public.departments where manager_email is not null
on conflict do nothing;

alter table public.department_managers enable row level security;
create policy "Signed-in people read" on public.department_managers
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Admins add" on public.department_managers
  for insert to authenticated with check ((select public.can_admin('departments')));
create policy "Admins remove" on public.department_managers
  for delete to authenticated using ((select public.can_admin('departments')));
grant select, insert, delete on public.department_managers to authenticated;

-- Keep departments.manager_email = the first manager (the departments
-- activity trigger logs that change).
create or replace function public.department_managers_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_email := lower(btrim(new.user_email));
  new.added_by := coalesce(new.added_by, public.current_user_email());
  return new;
end;
$$;
create trigger department_managers_fill before insert on public.department_managers
  for each row execute function public.department_managers_fill();

create or replace function public.department_managers_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dept uuid := coalesce(new.department_id, old.department_id);
  v_first text;
begin
  select m.user_email into v_first from public.department_managers m
   where m.department_id = v_dept order by m.added_at, m.user_email limit 1;
  update public.departments set manager_email = v_first
   where id = v_dept and manager_email is distinct from v_first;
  return null;
end;
$$;
create trigger department_managers_changed after insert or delete on public.department_managers
  for each row execute function public.department_managers_after();

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
           select 1 from public.department_managers m join public.departments d on d.id = m.department_id
            where m.user_email = public.current_user_email() and not d.archived)
   order by 2;
$$;

-- Is the signed-in person one of the managers of one of this employee's departments?
create or replace function public.ts_is_manager_of(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employees e
      join public.department_managers m on m.user_email = public.current_user_email()
      join public.departments d on d.id = m.department_id and not d.archived
     where e.id = p_employee
       and (d.id = e.department_id
            or exists (select 1 from public.user_departments ud where ud.user_email = e.user_email and ud.department_id = d.id)));
$$;

-- Every manager of an employee (emails).
create or replace function public.ts_managers_of(p_employee uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct m.user_email
    from public.employees e
    join public.departments d on not d.archived
    join public.department_managers m on m.department_id = d.id
   where e.id = p_employee
     and (d.id = e.department_id
          or exists (select 1 from public.user_departments ud where ud.user_email = e.user_email and ud.department_id = d.id));
$$;

-- Departments the signed-in person manages (for the Weekly Hours screen).
create or replace function public.my_managed_departments()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.department_id from public.department_managers m
    join public.departments d on d.id = m.department_id and not d.archived
   where m.user_email = public.current_user_email();
$$;

-- Automations: department managers (several per department now).
create or replace function public.automation_can_message(p_owner text, p_target text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.allowed_users where email = lower(p_target))
     and (lower(p_target) = lower(p_owner)
          or public.perm_of(p_owner, 'admin.automations', 'edit')
          or (public.perm_of(p_owner, 'chat', 'view') and public.perm_of(p_owner, 'chat.direct', 'edit'))
          or exists (select 1 from public.user_departments a join public.user_departments b on b.department_id = a.department_id
                      where a.user_email = lower(p_owner) and b.user_email = lower(p_target))
          or exists (select 1 from public.user_group_members a join public.user_group_members b on b.group_id = a.group_id
                       join public.user_groups g on g.id = a.group_id
                      where a.user_email = lower(p_owner) and b.user_email = lower(p_target) and not g.archived)
          or exists (select 1 from public.department_managers d join public.user_departments u on u.department_id = d.department_id
                      where (u.user_email = lower(p_owner) and d.user_email = lower(p_target))
                         or (u.user_email = lower(p_target) and d.user_email = lower(p_owner))));
$$;

-- A whole group or department may be messaged by its members (and the people above).
create or replace function public.automation_can_message_target(p_owner text, p_type text, p_target text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.perm_of(p_owner, 'admin.automations', 'edit')
      or (public.perm_of(p_owner, 'chat', 'view') and public.perm_of(p_owner, 'chat.direct', 'edit'))
      or case p_type
           when 'group' then exists (select 1 from public.user_group_members m join public.user_groups g on g.id = m.group_id
                                      where m.group_id::text = p_target and m.user_email = lower(p_owner) and not g.archived)
           when 'department' then exists (select 1 from public.user_departments d where d.department_id::text = p_target and d.user_email = lower(p_owner))
                                  or exists (select 1 from public.department_managers d where d.department_id::text = p_target and d.user_email = lower(p_owner))
           else false
         end;
$$;

-- Can this person see what the automation is about (so a message never shows
-- them something they may not see)?
create or replace function public.automation_visible_to(p_ctx jsonb, p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case p_ctx ->> 'subject_type'
    when 'card' then public.perm_of(p_email, 'boards', 'view') and public.board_access_of((p_ctx ->> 'board_id')::uuid, p_email) >= 1
    when 'order' then public.perm_of(p_email, 'orders.board') or public.perm_of(p_email, 'orders.list') or public.perm_of(p_email, 'order.page')
    when 'payment' then public.perm_of(p_email, 'payments')
    when 'machine' then public.perm_of(p_email, 'checklist') or public.perm_of(p_email, 'order.page')
    when 'notice' then public.perm_of(p_email, 'notices') and (public.notice_is_for((p_ctx ->> 'notice_id')::uuid, p_email) or p_ctx ->> 'author_email' = lower(p_email))
    when 'time_off' then lower(p_email) = p_ctx ->> 'person_email'
                         or public.perm_of(p_email, 'timesheets.absences') or public.perm_of(p_email, 'timesheets')
                         or public.perm_of(p_email, 'timesheets.time_off.manage')
                         or exists (select 1 from public.department_managers d join public.user_departments u on u.department_id = d.department_id
                                     where u.user_email = p_ctx ->> 'person_email' and d.user_email = lower(p_email))
    else true
  end;
$$;


-- ===========================================================================
-- Time off: the first manager to decide settles it
-- ===========================================================================
insert into public.notification_kinds (kind, label, description, sort_order, default_modes) values
  ('time_off_settled', 'Time off decided by another manager', 'For department managers: another manager approved or declined a time off request.', 92, '{"app": "on", "push": "off", "email": "off", "desktop": "off"}')
on conflict (kind) do nothing;

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
  -- The first manager to decide settles it; the others are told who did.
  if r.status in ('approved', 'declined') then
    raise exception 'This request was already % by % on %.', r.status, coalesce(r.decided_by_name, r.decided_by, 'another manager'),
      to_char(r.decided_at at time zone 'America/Halifax', 'FMMon FMDD, YYYY at FMHH12:MI AM') using errcode = '55000';
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
  -- Tell the employee's other managers that it is settled and by whom.
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  select m, 'time_off_settled',
         coalesce((select e.name from public.employees e where e.id = r.employee_id), 'A') || '''s ' || public.ts_kind_words(r.kind)
           || ' request was ' || p_decision || ' by ' || public.current_user_name(),
         public.ts_dates_text(r.start_date, r.end_date) || coalesce(E'\n' || nullif(btrim(p_comment), ''), ''),
         '/time-off?request=' || r.id, 'time_off:' || r.id || ':settled:' || m
    from public.ts_managers_of(r.employee_id) m
   where m is distinct from public.current_user_email() and m is distinct from r.user_email
  on conflict do nothing;
  return jsonb_build_object('days_written', v_made, 'skipped_days', to_jsonb(v_skipped));
end;
$$;
-- ===========================================================================
-- 3. Who reacted to a notice
-- ===========================================================================
create or replace function public.notice_reaction_people(p_notice uuid)
returns table (emoji text, user_email text, name text, reacted_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.emoji, r.user_email, coalesce(nullif(btrim(a.name), ''), r.user_email), r.created_at
    from public.notice_reactions r
    left join public.allowed_users a on a.email = r.user_email
   where public.has_perm('notices.reactions.who', 'view') and public.notice_visible(r.notice_id)
     and r.notice_id = p_notice
   order by r.emoji, r.created_at;
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
-- Dashboards internals: only inside the functions above.
revoke execute on function public.dashboard_template_people(uuid), public.dashboard_copy_template(uuid, text) from authenticated;
-- Sending mailboxes: the password is only ever read by the send-email Edge Function.
revoke execute on function public.mailbox_for_sending(text), public.set_mailbox_status(text, boolean, text) from authenticated;
grant execute on function public.mailbox_for_sending(text), public.set_mailbox_status(text, boolean, text) to service_role;
revoke execute on function public.summary_business_admin_only(), public.allowed_users_summary_business(),
  public.notifications_plain_text() from authenticated;

-- Boards upgrade 2 internals: only inside the functions above.
revoke execute on function public.board_label_for(uuid, text, text), public.board_place_card(uuid, uuid, integer),
  public.board_target_check(uuid, uuid), public.production_assign_defaults(uuid),
  public.orders_production_close(), public.orders_crating_changed(), public.order_machines_crating() from authenticated;
-- Calendar internals: only inside the functions above.
revoke execute on function public.calendar_entry_visible(uuid, text), public.calendar_team_keys(),
  public.orders_training_done_guard() from authenticated;
-- (system_on() stays revoked above; mark_training_done uses it as the owner.)
-- Crating hand-off internals: only through the triggers and functions above.
revoke execute on function public.crating_handoff_check(uuid), public.crates_handoff_trigger(),
  public.orders_crating_assignee_default(), public.orders_crating_handoff_guard(),
  public.freight_settings_check_contact() from authenticated;
-- (default_crating_assignee stays callable: the order trigger runs as the person; it only reads Production Assignments, which everyone may read.)
-- Automations internals: the engine, running as another person, and checks about other people.
revoke execute on function public.automation_become(text), public.automation_restore(jsonb),
  public.automation_context(public.automation_events, public.automations), public.automation_order_ctx(uuid), public.automation_card_ctx(uuid),
  public.automation_action(jsonb, jsonb, public.automations), public.automation_try(jsonb, jsonb, public.automations),
  public.automation_run(public.automations, public.automation_events, boolean),
  public.automation_log(public.automations, public.automation_events, text, text, jsonb, jsonb, boolean),
  public.automation_process_event(bigint), public.automation_emit(text, text, uuid, uuid, jsonb, uuid),
  public.automations_tick(), public.automation_tell_owner(public.automations, text),
  public.automation_recipients(jsonb, jsonb, text), public.automation_can_message(text, text),
  public.automation_can_message_target(text, text, text), public.automation_visible_to(jsonb, text),
  public.automation_problems_for(text, jsonb), public.automation_condition(jsonb, jsonb),
  public.automation_level_of(uuid, text) from authenticated;
-- 0056 internals: only through the triggers.
revoke execute on function public.department_managers_fill(), public.department_managers_after() from authenticated;
