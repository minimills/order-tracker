-- 0055 Automations: WHEN something happens, IF optional conditions are true,
-- THEN do one or more actions.
--
-- Paste into the Supabase SQL Editor and run it once (after 0054).
--
-- Step by step (the sections below, in this order):
--  1. Permissions: "automations" (use automations) is allowed for everyone by
--     default; "automations.share" and "admin.automations" are separate.
--  2. Settings (limits) in app_settings key "automations"; /automations can be a start page.
--  3. Tables: automations, automation_shares, automation_runs (the run log),
--     automation_events (the queue), automation_fired (once-only memory for
--     time-based triggers), automation_templates (examples to start from);
--     notification types.
--  4. The catalog of triggers, conditions, fields and actions (one place).
--  5. Who can see / edit an automation; who an automation may message; and
--     (4b) the catalog and lists each person may choose from (only what they
--     can see and do).
--  8. The engine: every automation runs AS ITS OWNER (the owner's permissions
--     are checked again on every run): context, conditions, actions, one run,
--     loop protection and run limits. Events are queued by small triggers and
--     run when the change is saved (deferred trigger at the end of the save).
--  9. Triggers on boards, orders, payments, final checks, crates, notices and
--     time off; the minute job for schedules, due dates and payments.
--  6. Checking a rule (for the person saving it AND for its owner).
--  7. Saving, sharing, switching on / off, copying, archiving; admin
--     functions; owner removed = paused.
-- 10. Test (shows what would happen, changes nothing) and templates.
--  9c. Turning the minute job on and off.
-- 11. Access lockdown.

-- ===========================================================================
-- 1. Permissions: "use automations" on for everyone by default
-- ===========================================================================
insert into public.user_permissions (user_email, perms)
select a.email, '{"automations": "edit"}'::jsonb
  from public.allowed_users a
 where not exists (select 1 from public.user_permissions up where up.user_email = a.email)
on conflict (user_email) do nothing;
update public.user_permissions set perms = perms || '{"automations": "edit"}'::jsonb where not perms ? 'automations';
update public.permission_templates set perms = perms || '{"automations": "edit"}'::jsonb where not perms ? 'automations';
update public.departments set default_permissions = default_permissions || '{"automations": "edit"}'::jsonb
 where default_permissions <> '{}'::jsonb and not default_permissions ? 'automations';

-- People added later start with it too (unless their permissions are set to something without it).
create or replace function public.automations_default_permission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_permissions (user_email, perms) values (new.email, '{"automations": "edit"}'::jsonb)
  on conflict (user_email) do nothing;
  return null;
end;
$$;
drop trigger if exists allowed_users_automations_default on public.allowed_users;
create trigger allowed_users_automations_default after insert on public.allowed_users
  for each row execute function public.automations_default_permission();

-- ===========================================================================
-- 2. Settings
-- ===========================================================================
insert into public.app_settings (key, value) values ('automations', jsonb_build_object(
  'enabled', true,               -- master switch (Admin → Automations)
  'max_rules_per_user', 25,
  'max_actions_per_rule', 10,
  'runs_per_minute_rule', 20,
  'runs_per_minute_user', 60,
  'max_chain', 3,                -- an automation's change may start at most 3 more in a row
  'keep_days', 90))              -- run log kept this many days
on conflict (key) do nothing;

create or replace function public.automation_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('enabled', true, 'max_rules_per_user', 25, 'max_actions_per_rule', 10,
                            'runs_per_minute_rule', 20, 'runs_per_minute_user', 60, 'max_chain', 3, 'keep_days', 90)
         || coalesce((select value from public.app_settings where key = 'automations'), '{}'::jsonb);
$$;

create or replace function public.set_automation_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := public.automation_settings();
  v_new jsonb := v_old;
  k text;
begin
  perform public.require_admin_area('automations');
  foreach k in array array['max_rules_per_user', 'max_actions_per_rule', 'runs_per_minute_rule', 'runs_per_minute_user', 'max_chain', 'keep_days'] loop
    if p ? k then
      if jsonb_typeof(p -> k) <> 'number' or (p ->> k)::numeric < 1 or (p ->> k)::numeric > 1000 then
        raise exception 'Enter a whole number from 1 to 1000 for every limit.' using errcode = '22023';
      end if;
      v_new := v_new || jsonb_build_object(k, (p ->> k)::numeric::int);
    end if;
  end loop;
  if (v_new ->> 'max_chain')::int > 10 then
    raise exception 'At most 10 automations can follow one another.' using errcode = '22023';
  end if;
  if p ? 'enabled' then
    v_new := v_new || jsonb_build_object('enabled', coalesce((p ->> 'enabled')::boolean, true));
  end if;
  insert into public.app_settings (key, value) values ('automations', v_new)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'automations', null,
    jsonb_build_object('action', 'automation settings changed', 'old', v_old, 'new', v_new));
  return v_new;
end;
$$;

-- The Automations page can be a start page.
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/freight', '/reports/department-delays',
     '/reports/build-times', '/machines', '/boards', '/notices', '/service', '/calendar', '/chat', '/agent', '/settings', '/admin', '/shop-board',
     '/timesheets', '/my-timesheet', '/time-off', '/automations'));

-- ===========================================================================
-- 3. Tables
-- ===========================================================================
create table public.automations (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(btrim(name)) between 1 and 120),
  description      text check (description is null or length(description) <= 1000),
  -- The owner: the automation runs with this person's permissions.
  owner_email      text references public.allowed_users (email) on update cascade on delete set null,
  owner_name       text,
  -- personal = "My automations" (plus whoever it is shared with); board = every member of that board can see it
  scope            text not null default 'personal' check (scope in ('personal', 'board')),
  board_id         uuid references public.boards (id) on delete cascade,
  enabled          boolean not null default false,
  -- why it is paused when not by the owner: owner_removed / admin
  paused_reason    text check (paused_reason in ('owner_removed', 'admin')),
  paused_by        text,
  paused_at        timestamptz,
  removed_owner_email text,
  trigger_key      text not null,
  trigger_config   jsonb not null default '{}',
  match            text not null default 'all' check (match in ('all', 'any')),
  conditions       jsonb not null default '[]' check (jsonb_typeof(conditions) = 'array'),
  actions          jsonb not null default '[]' check (jsonb_typeof(actions) = 'array'),
  template_key     text,
  last_run_at      timestamptz,
  last_status      text,
  run_count        integer not null default 0,
  last_scheduled_on date,
  archived         boolean not null default false,
  archived_at      timestamptz,
  archived_by      text,
  created_at       timestamptz not null default now(),
  created_by       text default public.current_user_email(),
  updated_at       timestamptz not null default now(),
  updated_by       text,
  check ((scope = 'board') = (board_id is not null))
);
create index automations_trigger_idx on public.automations (trigger_key) where enabled and not archived;
create index automations_owner_idx on public.automations (owner_email);
create index automations_board_idx on public.automations (board_id) where board_id is not null;
create trigger automations_archived_info before update on public.automations for each row execute function public.set_archived_info();

create table public.automation_shares (
  automation_id uuid not null references public.automations (id) on delete cascade,
  share_type    text not null check (share_type in ('user', 'group', 'department')),
  target        text not null,
  can_edit      boolean not null default false,
  created_at    timestamptz not null default now(),
  created_by    text default public.current_user_email(),
  primary key (automation_id, share_type, target)
);

create table public.automation_runs (
  id             bigserial primary key,
  automation_id  uuid not null references public.automations (id) on delete cascade,
  owner_email    text,
  started_at     timestamptz not null default now(),
  trigger_key    text,
  -- what started it: "Card moved to Done · Production board"
  trigger_text   text,
  subject_type   text,
  subject_id     uuid,
  subject_title  text,
  link           text,
  actor_email    text,
  actor_name     text,
  -- done / partial (some actions skipped or failed) / failed / skipped (not run: no access) / limited / loop / test
  status         text not null,
  message        text,
  -- [{type, label, status ok / skipped / failed, message}]
  actions        jsonb not null default '[]',
  is_test        boolean not null default false,
  depth          integer not null default 0
);
create index automation_runs_rule_idx on public.automation_runs (automation_id, started_at desc);
create index automation_runs_owner_idx on public.automation_runs (owner_email, started_at desc);

create table public.automation_events (
  id            bigserial primary key,
  trigger_key   text not null,
  subject_type  text not null,
  subject_id    uuid,
  board_id      uuid,
  data          jsonb not null default '{}',
  actor_email   text,
  actor_name    text,
  -- automations that led to this event (loop protection)
  chain         uuid[] not null default '{}',
  -- time-based events are meant for one automation only
  only_rule     uuid,
  created_at    timestamptz not null default now()
);

create table public.automation_fired (
  automation_id uuid not null references public.automations (id) on delete cascade,
  fire_key      text not null,
  fired_at      timestamptz not null default now(),
  primary key (automation_id, fire_key)
);

create table public.automation_templates (
  id             uuid primary key default gen_random_uuid(),
  key            text unique,
  name           text not null,
  description    text,
  trigger_key    text not null,
  trigger_config jsonb not null default '{}',
  match          text not null default 'all',
  conditions     jsonb not null default '[]',
  actions        jsonb not null default '[]',
  sort_order     integer not null default 0,
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  created_by     text default public.current_user_email()
);

alter table public.automations enable row level security;
alter table public.automation_shares enable row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_events enable row level security;
alter table public.automation_fired enable row level security;
alter table public.automation_templates enable row level security;
revoke insert, update, delete on public.automations, public.automation_shares, public.automation_runs,
  public.automation_events, public.automation_fired, public.automation_templates from authenticated, anon;
revoke select on public.automation_events, public.automation_fired from authenticated, anon;

-- Notification types (people choose the channels in Settings → Notifications).
insert into public.notification_kinds (kind, label, description, sort_order, default_modes) values
  ('automation_app', 'Automation: in-app message', 'Sent by an automation that asks for an in-app notification.', 200,
   '{"app": "on", "push": "off", "email": "off", "desktop": "on"}'),
  ('automation_push', 'Automation: phone push', 'Sent by an automation that asks for a phone notification.', 201,
   '{"app": "on", "push": "on", "email": "off", "desktop": "on"}'),
  ('automation_email', 'Automation: email', 'Sent by an automation that asks for an email.', 202,
   '{"app": "on", "push": "off", "email": "instant", "desktop": "off"}'),
  ('automation_problem', 'Automation needs attention', 'One of your automations skipped an action, was limited or was paused.', 203,
   '{"app": "on", "push": "off", "email": "digest", "desktop": "off"}'),
  ('automation_shared', 'Automation shared with you', 'Someone shared an automation with you.', 204,
   '{"app": "on", "push": "off", "email": "off", "desktop": "off"}')
on conflict (kind) do nothing;

-- ===========================================================================
-- 4. The catalog (one place: the screens read it through automation_catalog())
-- ===========================================================================
-- perms = any one of these keys is needed (triggers: view level; actions: edit level).
-- subject = what the trigger is about (card, order, payment, machine, notice, time_off, none).
-- config  = what the trigger asks for: to_stage, label, days, order_stage, schedule.
create or replace function public.automation_defs()
returns jsonb
language sql
immutable
as $$
select $j${
 "triggers": [
  {"key": "card_created", "group": "Boards", "label": "A card is created", "subject": "card", "perms": ["boards"]},
  {"key": "card_moved", "group": "Boards", "label": "A card is moved to a stage", "subject": "card", "perms": ["boards"], "config": ["to_stage"]},
  {"key": "checklist_completed", "group": "Boards", "label": "A checklist on a card is completed", "subject": "card", "perms": ["boards"]},
  {"key": "card_due_soon", "group": "Boards", "label": "A card's due date is approaching", "subject": "card", "perms": ["boards"], "config": ["days"], "timed": true},
  {"key": "card_overdue", "group": "Boards", "label": "A card's due date has passed", "subject": "card", "perms": ["boards"], "timed": true},
  {"key": "label_added", "group": "Boards", "label": "A label is added to a card", "subject": "card", "perms": ["boards"], "config": ["label"]},
  {"key": "card_assigned", "group": "Boards", "label": "Someone is assigned to a card", "subject": "card", "perms": ["boards"]},
  {"key": "order_created", "group": "Orders", "label": "An order is created", "subject": "order", "perms": ["orders.board", "orders.list", "order.page"]},
  {"key": "order_stage_changed", "group": "Orders", "label": "An order's stage changes", "subject": "order", "perms": ["orders.board", "orders.list", "order.page"], "config": ["order_stage"]},
  {"key": "order_confirmed", "group": "Orders", "label": "An order is confirmed", "subject": "order", "perms": ["orders.board", "orders.list", "order.page"]},
  {"key": "order_shipped", "group": "Orders", "label": "An order is shipped", "subject": "order", "perms": ["orders.board", "orders.list", "order.page"]},
  {"key": "payment_due", "group": "Payments", "label": "A payment is coming due", "subject": "payment", "perms": ["payments"], "config": ["days"], "timed": true},
  {"key": "payment_overdue", "group": "Payments", "label": "A payment is overdue", "subject": "payment", "perms": ["payments"], "timed": true},
  {"key": "payment_received", "group": "Payments", "label": "A payment is received", "subject": "payment", "perms": ["payments"]},
  {"key": "final_check_signed", "group": "Final check", "label": "A final check is signed", "subject": "machine", "perms": ["checklist"]},
  {"key": "crating_complete", "group": "Crating", "label": "Every machine on an order is crated", "subject": "order", "perms": ["crating"]},
  {"key": "service_call_status", "group": "Service / Training", "label": "A service call's status changes", "subject": "card", "perms": ["service.calls"], "config": ["to_stage"]},
  {"key": "notice_posted", "group": "Notice Board", "label": "A notice is posted", "subject": "notice", "perms": ["notices"]},
  {"key": "time_off_approved", "group": "Timesheets", "label": "Time off is approved", "subject": "time_off", "perms": ["timesheets", "timesheets.absences", "timesheets.time_off.manage"]},
  {"key": "schedule", "group": "Schedule", "label": "On a schedule (daily or weekly at a time)", "subject": "none", "perms": [], "config": ["schedule"], "timed": true}
 ],
 "conditions": [
  {"key": "board", "label": "Board is", "subjects": ["card"], "input": "boards"},
  {"key": "board_kind", "label": "Kind of board is", "subjects": ["card"], "input": "board_kinds"},
  {"key": "stage", "label": "Card stage is", "subjects": ["card"], "input": "stages"},
  {"key": "last_stage", "label": "The card is in the last stage of its board", "subjects": ["card"], "input": "yes_no"},
  {"key": "label", "label": "Card has the label", "subjects": ["card"], "input": "labels", "ops": ["has", "has_not"]},
  {"key": "assignee", "label": "Card is assigned to", "subjects": ["card"], "input": "people", "ops": ["has", "has_not", "nobody"]},
  {"key": "department", "label": "Department (of the card's stage, or of the person who made the change)", "subjects": ["card", "order", "payment", "machine", "notice", "time_off"], "input": "departments"},
  {"key": "machine_type", "label": "Machine type", "subjects": ["card", "order", "payment", "machine"], "input": "machine_types"},
  {"key": "country", "label": "Customer country", "subjects": ["card", "order", "payment", "machine"], "input": "text_list"},
  {"key": "order_value", "label": "Order value", "subjects": ["card", "order", "payment", "machine"], "input": "number", "ops": ["gt", "lt", "eq"], "perms": ["order.field.order_total"]},
  {"key": "voltage", "label": "Voltage", "subjects": ["card", "order", "payment", "machine"], "input": "voltages"},
  {"key": "order_stage", "label": "Order stage is", "subjects": ["card", "order", "payment", "machine"], "input": "order_stages"},
  {"key": "field", "label": "A field", "subjects": ["card", "order", "payment", "machine", "notice", "time_off", "none"], "input": "field", "ops": ["equals", "not_equals", "contains", "gt", "lt", "is_empty", "is_not_empty"]}
 ],
 "fields": {
  "card": [
   {"key": "title", "label": "Card title", "type": "text"}, {"key": "board", "label": "Board name", "type": "text"},
   {"key": "stage", "label": "Stage", "type": "text"}, {"key": "due_date", "label": "Due date", "type": "date"},
   {"key": "order_number", "label": "Order #", "type": "text"}, {"key": "customer", "label": "Customer", "type": "text"},
   {"key": "serial", "label": "Serial number", "type": "text"}, {"key": "person", "label": "Person who made the change", "type": "text"}],
  "order": [
   {"key": "order_number", "label": "Order #", "type": "text"}, {"key": "customer", "label": "Customer", "type": "text"},
   {"key": "country", "label": "Country", "type": "text"}, {"key": "order_stage", "label": "Order stage", "type": "text"},
   {"key": "currency", "label": "Currency", "type": "text"}, {"key": "order_total", "label": "Order total", "type": "number", "perms": ["order.field.order_total"]},
   {"key": "expected_ship_date", "label": "Expected ship date", "type": "date"}, {"key": "freight_type", "label": "Freight type", "type": "text"},
   {"key": "delivery_equipment", "label": "Delivery equipment", "type": "text"}, {"key": "quote_number", "label": "Quote #", "type": "text"},
   {"key": "invoice_number", "label": "Invoice #", "type": "text"}, {"key": "machine_count", "label": "Number of machines", "type": "number"},
   {"key": "person", "label": "Person who made the change", "type": "text"}],
  "payment": [
   {"key": "order_number", "label": "Order #", "type": "text"}, {"key": "customer", "label": "Customer", "type": "text"},
   {"key": "payment_type", "label": "Payment type", "type": "text"}, {"key": "amount", "label": "Amount", "type": "number"},
   {"key": "remaining", "label": "Amount still to receive", "type": "number"}, {"key": "due_date", "label": "Due date", "type": "date"},
   {"key": "currency", "label": "Currency", "type": "text"}, {"key": "country", "label": "Country", "type": "text"}],
  "machine": [
   {"key": "serial", "label": "Serial number", "type": "text"}, {"key": "machine_type", "label": "Machine type", "type": "text"},
   {"key": "order_number", "label": "Order #", "type": "text"}, {"key": "customer", "label": "Customer", "type": "text"},
   {"key": "country", "label": "Country", "type": "text"}, {"key": "person", "label": "Person who signed", "type": "text"}],
  "notice": [
   {"key": "title", "label": "Notice title", "type": "text"}, {"key": "priority", "label": "Priority", "type": "text"},
   {"key": "category", "label": "Category", "type": "text"}, {"key": "person", "label": "Posted by", "type": "text"}],
  "time_off": [
   {"key": "person_name", "label": "Person off", "type": "text"}, {"key": "kind", "label": "Kind of time off", "type": "text"},
   {"key": "start_date", "label": "First day", "type": "date"}, {"key": "end_date", "label": "Last day", "type": "date"},
   {"key": "days", "label": "Number of days", "type": "number"}],
  "none": [{"key": "weekday", "label": "Day of the week (1 = Monday)", "type": "number"}]
 },
 "actions": [
  {"key": "move_card", "group": "Cards", "label": "Move the card to a stage", "subjects": ["card"], "perms": ["boards.card.move"]},
  {"key": "copy_card", "group": "Cards", "label": "Copy the card to a board", "subjects": ["card"], "perms": ["boards.card.copy"]},
  {"key": "archive_card", "group": "Cards", "label": "Archive the card", "subjects": ["card"], "perms": ["boards.card.archive"]},
  {"key": "add_label", "group": "Cards", "label": "Add a label", "subjects": ["card"], "perms": ["boards.card.labels"]},
  {"key": "remove_label", "group": "Cards", "label": "Remove a label", "subjects": ["card"], "perms": ["boards.card.labels"]},
  {"key": "mark_complete", "group": "Cards", "label": "Mark the card complete", "subjects": ["card"], "perms": ["boards.card.complete", "boards.card.timing"]},
  {"key": "assign", "group": "Cards", "label": "Assign someone to the card", "subjects": ["card"], "perms": ["boards.card.assignees"]},
  {"key": "unassign", "group": "Cards", "label": "Remove someone from the card", "subjects": ["card"], "perms": ["boards.card.assignees"]},
  {"key": "set_due", "group": "Cards", "label": "Set or clear the due date", "subjects": ["card"], "perms": ["boards.card.edit"]},
  {"key": "shift_due", "group": "Cards", "label": "Move the due date earlier or later", "subjects": ["card"], "perms": ["boards.card.edit"]},
  {"key": "add_checklist", "group": "Cards", "label": "Add a checklist", "subjects": ["card"], "perms": ["boards.card.checklists"]},
  {"key": "create_card", "group": "Cards", "label": "Create a card on a board", "subjects": ["card", "order", "payment", "machine", "notice", "time_off", "none"], "perms": ["boards.card.create"]},
  {"key": "change_order_stage", "group": "Orders", "label": "Change the order's stage", "subjects": ["card", "order", "payment", "machine"], "perms": ["order.action.change_stage", "orders.board.change_stage", "order.action.mark_shipped"]},
  {"key": "close_production_board", "group": "Orders", "label": "Close the order's production board", "subjects": ["card", "order", "payment", "machine"], "perms": ["boards.close"]},
  {"key": "notify", "group": "Messages", "label": "Send a notification", "subjects": ["card", "order", "payment", "machine", "notice", "time_off", "none"], "perms": []},
  {"key": "post_notice", "group": "Messages", "label": "Post a notice on the Notice Board", "subjects": ["card", "order", "payment", "machine", "notice", "time_off", "none"], "perms": ["notices.post.everyone", "notices.post.department"]},
  {"key": "add_calendar_entry", "group": "Calendar", "label": "Add an entry to the Calendar", "subjects": ["card", "order", "payment", "machine", "notice", "time_off", "none"], "perms": ["service.calendar"]}
 ],
 "placeholders": ["title", "board", "stage", "from_stage", "order_number", "customer", "serial", "machine_type", "due_date", "label", "person", "person_name", "rule", "today"]
}$j$::jsonb;
$$;

-- Saturday → Friday, Sunday → Monday (the rule for every calculated date).
create or replace function public.automation_weekend(p date)
returns date
language sql
immutable
as $$
  select case extract(isodow from p)::int when 6 then p - 1 when 7 then p + 1 else p end;
$$;

-- ===========================================================================
-- 5. Access
-- ===========================================================================
-- 0 = none, 1 = view (and Test, Copy), 2 = edit, 3 = owner / manage all.
create or replace function public.automation_level_of(p_rule uuid, p_email text)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me  text := lower(coalesce(p_email, public.current_user_email()));
  r     public.automations%rowtype;
  v_lvl integer := 0;
  v_b   integer;
begin
  select * into r from public.automations where id = p_rule;
  if not found or v_me is null then
    return 0;
  end if;
  if public.perm_of(v_me, 'admin.automations', 'edit') then
    return 3;
  end if;
  if not public.perm_of(v_me, 'automations', 'view') then
    return 0;
  end if;
  if r.owner_email = v_me then
    return 3;
  end if;
  if r.scope = 'board' and public.perm_of(v_me, 'boards', 'view') then
    v_b := public.board_access_of(r.board_id, v_me);
    if v_b >= 3 then
      v_lvl := 2;
    elsif v_b >= 1 then
      v_lvl := 1;
    end if;
  end if;
  select greatest(v_lvl, coalesce(max(case when s.can_edit then 2 else 1 end), 0)) into v_lvl
    from public.automation_shares s
   where s.automation_id = r.id
     and ((s.share_type = 'user' and s.target = v_me)
          or (s.share_type = 'group' and exists (select 1 from public.user_group_members m join public.user_groups g on g.id = m.group_id
                                                  where m.group_id::text = s.target and m.user_email = v_me and not g.archived))
          or (s.share_type = 'department' and exists (select 1 from public.user_departments d
                                                       where d.department_id::text = s.target and d.user_email = v_me)));
  -- editing someone else's automation also needs "use automations" at edit level
  if v_lvl = 2 and not public.perm_of(v_me, 'automations', 'edit') then
    v_lvl := 1;
  end if;
  if r.archived and v_lvl < 3 then
    return 0;
  end if;
  return v_lvl;
end;
$$;

-- For the signed-in person (used by the row security below).
create or replace function public.automation_level(p_rule uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select public.automation_level_of(p_rule, public.current_user_email());
$$;

create policy "Automations: people who can see them" on public.automations for select to authenticated
  using ((select public.automation_level(id)) >= 1);
create policy "Automation shares: people who can see the automation" on public.automation_shares for select to authenticated
  using ((select public.automation_level(automation_id)) >= 1);
create policy "Automation runs: people who can see the automation" on public.automation_runs for select to authenticated
  using ((select public.automation_level(automation_id)) >= 1);
create policy "Automation templates: everyone with automations" on public.automation_templates for select to authenticated
  using ((select public.has_perm('automations', 'view')) and (not archived or (select public.can_admin('automations'))));

-- Who an automation may message: the owner, people in one of the owner's
-- departments or groups, their department managers; everyone for owners who
-- may start direct chats with anyone, and for automation admins.
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
          or exists (select 1 from public.departments d join public.user_departments u on u.department_id = d.id
                      where (u.user_email = lower(p_owner) and d.manager_email = lower(p_target))
                         or (u.user_email = lower(p_target) and d.manager_email = lower(p_owner))));
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
                                  or exists (select 1 from public.departments d where d.id::text = p_target and d.manager_email = lower(p_owner))
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
                         or exists (select 1 from public.departments d join public.user_departments u on u.department_id = d.id
                                     where u.user_email = p_ctx ->> 'person_email' and d.manager_email = lower(p_email))
    else true
  end;
$$;

-- ===========================================================================
-- 4b. The catalog and choices for the signed-in person
-- ===========================================================================
create or replace function public.automation_allowed(p_perms jsonb, p_level text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_array_length(p_perms), 0) = 0
      or public.has_any_perm(array(select jsonb_array_elements_text(p_perms)), p_level);
$$;

create or replace function public.automation_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d jsonb := public.automation_defs();
  v_boards boolean := public.has_perm('boards', 'view');
  v_fields jsonb := '{}';
  k text;
begin
  perform public.require_perm('automations', 'view');
  for k in select jsonb_object_keys(d -> 'fields') loop
    v_fields := v_fields || jsonb_build_object(k, coalesce((
      select jsonb_agg(f) from jsonb_array_elements(d -> 'fields' -> k) f
       where public.automation_allowed(f -> 'perms', 'view')), '[]'::jsonb));
  end loop;
  return jsonb_build_object(
    'triggers', coalesce((select jsonb_agg(t) from jsonb_array_elements(d -> 'triggers') t
                           where public.automation_allowed(t -> 'perms', 'view')), '[]'::jsonb),
    'conditions', coalesce((select jsonb_agg(c) from jsonb_array_elements(d -> 'conditions') c
                             where public.automation_allowed(c -> 'perms', 'view')), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(a) from jsonb_array_elements(d -> 'actions') a
                          where public.automation_allowed(a -> 'perms', 'edit')
                            and (a ->> 'group' <> 'Cards' or v_boards)
                            and (a ->> 'key' not in ('close_production_board') or v_boards)), '[]'::jsonb),
    'fields', v_fields,
    'placeholders', d -> 'placeholders',
    'can_share', public.has_perm('automations.share', 'edit'),
    'can_edit', public.has_perm('automations', 'edit'),
    'can_manage_all', public.has_perm('admin.automations', 'edit'),
    'settings', public.automation_settings() - 'enabled');
end;
$$;

-- The boards, stages, labels, people, groups and departments this person may choose.
create or replace function public.automation_choices()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('automations', 'view');
  return jsonb_build_object(
    'boards', case when public.has_perm('boards', 'view') then coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'purpose', b.purpose, 'level', b.lvl,
               'stages', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.sort_order)
                                     from public.board_stages s where s.board_id = b.id and not s.archived), '[]'::jsonb),
               'labels', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'colour', l.colour) order by l.sort_order)
                                     from public.board_labels l where l.board_id = b.id and not l.archived), '[]'::jsonb))
             order by (b.purpose = 'production'), b.name)
        from (select bb.*, public.board_access_of(bb.id, v_me) as lvl,
                     row_number() over (partition by bb.purpose = 'production' order by bb.created_at desc) as rn
                from public.boards bb where not bb.archived and bb.closed_at is null) b
       where b.lvl >= 1 and (b.purpose <> 'production' or b.rn <= 60)), '[]'::jsonb) else '[]'::jsonb end,
    'people', coalesce((select jsonb_agg(jsonb_build_object('email', a.email, 'name', coalesce(nullif(btrim(a.name), ''), a.email)) order by coalesce(nullif(btrim(a.name), ''), a.email))
                          from public.allowed_users a where public.automation_can_message(v_me, a.email)), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
                                 'can_message', public.automation_can_message_target(v_me, 'group', g.id::text)) order by g.name)
                          from public.user_groups g where not g.archived), '[]'::jsonb),
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name,
                                 'can_message', public.automation_can_message_target(v_me, 'department', d.id::text)) order by d.sort_order)
                               from public.departments d where not d.archived), '[]'::jsonb),
    'machine_types', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.name)
                                 from public.machine_types m where not m.archived), '[]'::jsonb),
    'voltages', coalesce((select jsonb_agg(o.value order by o.sort_order) from public.option_lists o
                            where o.list_name = 'voltage' and not o.archived), '[]'::jsonb),
    'order_stages', '["Quote", "Confirmed", "In production", "Ready", "Ready to ship", "Shipped", "Cancelled"]'::jsonb,
    'my_departments', coalesce((select jsonb_agg(department_id) from public.user_departments where user_email = v_me), '[]'::jsonb),
    'can_post_everyone', public.has_perm('notices.post.everyone', 'edit'),
    'can_calendar_others', public.has_perm('service.calendar.manage', 'edit'),
    'can_service', public.has_perm('service', 'view'),
    'can_board_rules', public.has_perm('boards', 'view'));
end;
$$;

-- ===========================================================================
-- 8a. Running as the owner
-- ===========================================================================
-- Every automation runs with its OWNER's sign-in details, so every permission
-- check (has_perm, board access, row guards) sees the owner, never the person
-- whose change started it, and never a system routine's "system change" pass.
create or replace function public.automation_become(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v   jsonb := '{}';
  k   text;
  v_sub uuid;
begin
  foreach k in array array['request.jwt.claims', 'request.jwt.claim', 'request.jwt.claim.sub', 'request.jwt.claim.email',
                           'request.jwt.claim.role', 'app.system_change', 'app.ts_system', 'app.checklist_gate_off',
                           'app.checklist_override', 'app.renumbering', 'app.production_merging', 'app.holiday_import',
                           'app.automation_chain'] loop
    v := v || jsonb_build_object(k, coalesce(current_setting(k, true), ''));
  end loop;
  select id into v_sub from auth.users where lower(email) = lower(p_email) order by created_at limit 1;
  perform set_config('request.jwt.claims', jsonb_build_object('email', lower(p_email), 'role', 'authenticated', 'sub', v_sub, 'automation', true)::text, true);
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub::text, ''), true);
  perform set_config('request.jwt.claim.email', lower(p_email), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  foreach k in array array['app.system_change', 'app.ts_system', 'app.checklist_gate_off', 'app.checklist_override',
                           'app.renumbering', 'app.production_merging', 'app.holiday_import'] loop
    perform set_config(k, '', true);
  end loop;
  return v;
end;
$$;

create or replace function public.automation_restore(p_saved jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
begin
  for k in select jsonb_object_keys(p_saved) loop
    perform set_config(k, p_saved ->> k, true);
  end loop;
end;
$$;

create or replace function public.automation_skip(p_message text)
returns void
language plpgsql
as $$
begin
  raise exception '%', p_message using errcode = 'AU001';
end;
$$;

-- Plain text → a small safe HTML paragraph (for card descriptions and notices).
create or replace function public.automation_html(p text)
returns text
language sql
immutable
as $$
  select case when nullif(btrim(coalesce(p, '')), '') is null then null
              else '<p>' || replace(replace(replace(replace(btrim(p), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\n', '<br>') || '</p>' end;
$$;

-- ===========================================================================
-- 8b. What the automation is about (built AS THE OWNER: hidden fields are left out)
-- ===========================================================================
create or replace function public.automation_order_ctx(p_order uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'subject_type', 'order', 'subject_id', o.id, 'order_id', o.id, 'order_number', o.order_code,
           'order_stage', o.stage, 'stage', o.stage,
           'title', 'Order ' || o.order_code || ' – ' || coalesce(nullif(btrim(c.company), ''), c.name),
           'customer', coalesce(nullif(btrim(c.company), ''), c.name), 'customer_name', c.name, 'customer_id', c.id,
           'country', c.country, 'voltage', o.voltage, 'currency', o.currency,
           'expected_ship_date', o.expected_ship_date, 'freight_type', o.freight_type, 'delivery_equipment', o.delivery_equipment,
           'quote_number', o.quote_number, 'invoice_number', o.invoice_number,
           'technician_email', o.technician_email, 'service_start', o.service_start, 'service_end', o.service_end,
           'machine_types', coalesce((select jsonb_agg(distinct mt.name) from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id
                                       where m.order_id = o.id and not m.archived), '[]'::jsonb),
           'machine_type_ids', coalesce((select jsonb_agg(distinct m.machine_type_id) from public.order_machines m
                                          where m.order_id = o.id and not m.archived), '[]'::jsonb),
           'machine_count', (select count(*) from public.order_machines m where m.order_id = o.id and not m.archived),
           'production_board_id', (select b.id from public.boards b where b.purpose = 'production' and b.order_id = o.id
                                    order by b.created_at desc limit 1),
           'link', '/orders/' || o.id)
         || case when public.has_perm('order.field.order_total', 'view') then jsonb_build_object('order_total', o.order_total) else '{}'::jsonb end
    from public.orders o join public.customers c on c.id = o.customer_id
   where o.id = p_order;
$$;

create or replace function public.automation_card_ctx(p_card uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'subject_type', 'card', 'subject_id', c.id, 'card_id', c.id, 'board_id', c.board_id, 'board', b.name,
           'board_purpose', b.purpose,
           'board_kind', case b.purpose when 'production' then 'production' when 'service' then 'service' else 'other' end,
           'stage_id', c.stage_id, 'stage', s.name, 'stage_department_id', s.department_id,
           'is_last_stage', s.id = (select s2.id from public.board_stages s2 where s2.board_id = c.board_id and not s2.archived
                                     order by s2.sort_order desc limit 1),
           'title', c.title, 'card_title', c.title, 'due_date', c.due_date, 'card_kind', c.card_kind,
           'finished', c.finished_at is not null, 'archived', c.archived,
           'labels', coalesce((select jsonb_agg(l.name) from public.board_card_labels cl join public.board_labels l on l.id = cl.label_id
                                where cl.card_id = c.id), '[]'::jsonb),
           'assignees', coalesce((select jsonb_agg(a.user_email) from public.board_card_assignees a where a.card_id = c.id), '[]'::jsonb),
           'link', '/boards/' || c.board_id || '?card=' || c.id)
         || case when c.order_id is not null
                 then coalesce(public.automation_order_ctx(c.order_id), '{}'::jsonb) - 'subject_type' - 'subject_id' - 'title' - 'link' - 'stage'
                 else '{}'::jsonb end
         || case when c.machine_id is not null
                 then jsonb_build_object('machine_id', m.id, 'serial', m.serial_number, 'machine_type', mt.name,
                                         'machine_type_ids', jsonb_build_array(m.machine_type_id))
                 else '{}'::jsonb end
         || case when c.card_kind = 'service'
                 then coalesce((select jsonb_build_object('call_number', 'S-' || sc.call_number, 'technician_email', sc.technician_email,
                                                          'customer_id', sc.customer_id, 'country', cu.country,
                                                          'customer', coalesce(nullif(btrim(cu.company), ''), cu.name),
                                                          'start_date', sc.planned_start, 'end_date', coalesce(sc.planned_end, sc.planned_start))
                                  from public.service_calls sc left join public.customers cu on cu.id = sc.customer_id
                                 where sc.card_id = c.id), '{}'::jsonb)
                 else '{}'::jsonb end
    from public.board_cards c
    join public.boards b on b.id = c.board_id
    join public.board_stages s on s.id = c.stage_id
    left join public.order_machines m on m.id = c.machine_id
    left join public.machine_types mt on mt.id = m.machine_type_id
   where c.id = p_card;
$$;

-- The whole context for one event and one automation, or null when the owner
-- cannot see what it is about (or it is gone).
create or replace function public.automation_context(e public.automation_events, r public.automations)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v   jsonb;
  v_ok boolean := false;
begin
  case e.subject_type
    when 'card' then
      v := public.automation_card_ctx(e.subject_id);
      v_ok := v is not null and public.has_perm('boards', 'view') and public.board_level((v ->> 'board_id')::uuid) >= 1
              and (r.trigger_key <> 'service_call_status' or public.has_perm('service.calls', 'view'));
    when 'order' then
      v := public.automation_order_ctx(e.subject_id);
      v_ok := v is not null and (public.has_any_perm(array['orders.board', 'orders.list', 'order.page'], 'view')
                                 or (r.trigger_key = 'crating_complete' and public.has_perm('crating', 'view')));
    when 'payment' then
      select public.automation_order_ctx(p.order_id) - 'subject_type' - 'subject_id' - 'title'
             || jsonb_build_object('subject_type', 'payment', 'subject_id', p.id, 'payment_id', p.id, 'payment_type', p.payment_type,
                                   'amount', p.amount, 'remaining', greatest(p.amount - coalesce(p.received_amount, 0), 0),
                                   'due_date', p.due_date, 'received_date', p.received_date,
                                   'title', p.payment_type || ' for order ' || o.order_code)
        into v
        from public.payments p join public.orders o on o.id = p.order_id where p.id = e.subject_id;
      v_ok := v is not null and public.has_perm('payments', 'view');
    when 'machine' then
      select public.automation_order_ctx(m.order_id) - 'subject_type' - 'subject_id' - 'title' - 'link' - 'machine_type_ids'
             || jsonb_build_object('subject_type', 'machine', 'subject_id', m.id, 'machine_id', m.id, 'serial', m.serial_number,
                                   'machine_type', mt.name, 'machine_type_ids', jsonb_build_array(m.machine_type_id),
                                   'title', mt.name || ' ' || coalesce(m.serial_number, ''), 'link', '/checklists/' || m.id,
                                   'person', (select k.signed_name from public.machine_checklists k where k.machine_id = m.id))
        into v
        from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id where m.id = e.subject_id;
      v_ok := v is not null and public.has_any_perm(array['checklist', 'order.page'], 'view');
    when 'notice' then
      select jsonb_build_object('subject_type', 'notice', 'subject_id', n.id, 'notice_id', n.id, 'title', n.title, 'priority', n.priority,
                                'category', n.category, 'author_email', n.author_email, 'person', n.author_name,
                                'link', '/notices?notice=' || n.id)
        into v from public.notices n where n.id = e.subject_id and not n.archived;
      v_ok := v is not null and public.has_perm('notices', 'view')
              and (public.notice_is_for(e.subject_id, public.current_user_email())
                   or v ->> 'author_email' = public.current_user_email() or public.has_perm('notices.manage', 'edit'));
    when 'time_off' then
      select jsonb_build_object('subject_type', 'time_off', 'subject_id', t.id, 'time_off_id', t.id, 'employee_id', t.employee_id,
                                'person_email', coalesce(t.user_email, em.user_email), 'person_name', em.name, 'kind', t.kind,
                                'start_date', t.start_date, 'end_date', t.end_date, 'days', t.end_date - t.start_date + 1,
                                'title', em.name || ': ' || t.kind || ' ' || to_char(t.start_date, 'Mon FMDD') || ' to ' || to_char(t.end_date, 'Mon FMDD'),
                                'link', '/time-off')
        into v from public.time_off_requests t join public.employees em on em.id = t.employee_id where t.id = e.subject_id;
      v_ok := v is not null and public.ts_can_see((v ->> 'employee_id')::uuid);
    else
      v := jsonb_build_object('subject_type', 'none', 'title', r.name, 'link', '/automations/' || r.id);
      v_ok := true;
  end case;
  if not v_ok then
    return null;
  end if;
  v := v || jsonb_build_object(
    'actor_email', e.actor_email, 'actor_name', e.actor_name,
    'person', coalesce(v ->> 'person', e.actor_name),
    'rule', r.name, 'rule_id', r.id, 'owner_email', r.owner_email,
    'today', public.halifax_today(), 'weekday', extract(isodow from public.halifax_today())::int);
  -- what happened
  if e.data ? 'from_stage_id' then
    v := v || jsonb_build_object('from_stage', (select name from public.board_stages where id = (e.data ->> 'from_stage_id')::uuid),
                                 'to_stage', (select name from public.board_stages where id = (e.data ->> 'to_stage_id')::uuid));
  end if;
  v := v || (e.data - 'from_stage_id' - 'to_stage_id');
  return v;
end;
$$;

-- Fill {placeholders} from the context.
create or replace function public.automation_fill(p text, p_ctx jsonb)
returns text
language plpgsql
immutable
as $$
declare
  v text := coalesce(p, '');
  k text;
begin
  for k in select jsonb_array_elements_text(public.automation_defs() -> 'placeholders') loop
    v := replace(v, '{' || k || '}', coalesce(p_ctx ->> k, ''));
  end loop;
  return v;
end;
$$;

-- ===========================================================================
-- 8c. Conditions
-- ===========================================================================
create or replace function public.automation_condition(c jsonb, p_ctx jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_type text := c ->> 'type';
  v_op   text := coalesce(nullif(c ->> 'op', ''), 'is');
  v_vals jsonb := coalesce(c -> 'values', '[]'::jsonb);
  v_low  text[] := array(select lower(btrim(x)) from jsonb_array_elements_text(coalesce(c -> 'values', '[]'::jsonb)) x);
  v_res  boolean;
  v_txt  text;
  v_num  numeric;
  v_ftyp text;
begin
  case v_type
    when 'board' then v_res := p_ctx ->> 'board_id' in (select jsonb_array_elements_text(v_vals));
    when 'board_kind' then v_res := p_ctx ->> 'board_kind' in (select jsonb_array_elements_text(v_vals));
    when 'stage' then v_res := lower(p_ctx ->> 'stage') = any (v_low);
    when 'last_stage' then v_res := coalesce((p_ctx ->> 'is_last_stage')::boolean, false) = coalesce((c ->> 'value')::boolean, true);
    when 'label' then
      v_res := exists (select 1 from jsonb_array_elements_text(coalesce(p_ctx -> 'labels', '[]'::jsonb)) l where lower(l) = any (v_low));
      if v_op = 'has_not' then v_res := not v_res; end if;
    when 'assignee' then
      if v_op = 'nobody' then
        v_res := jsonb_array_length(coalesce(p_ctx -> 'assignees', '[]'::jsonb)) = 0;
      else
        v_res := exists (select 1 from jsonb_array_elements_text(coalesce(p_ctx -> 'assignees', '[]'::jsonb)) a
                          where a = any (v_low) or ('actor' = any (v_low) and a = p_ctx ->> 'actor_email'));
        if v_op = 'has_not' then v_res := not v_res; end if;
      end if;
    when 'department' then
      v_res := p_ctx ->> 'stage_department_id' in (select jsonb_array_elements_text(v_vals))
            or exists (select 1 from public.user_departments d
                        where d.user_email in (p_ctx ->> 'actor_email', p_ctx ->> 'person_email')
                          and d.department_id::text in (select jsonb_array_elements_text(v_vals)));
    when 'machine_type' then
      v_res := exists (select 1 from jsonb_array_elements_text(coalesce(p_ctx -> 'machine_type_ids', '[]'::jsonb)) m
                        where m in (select jsonb_array_elements_text(v_vals)));
    when 'country' then v_res := lower(btrim(p_ctx ->> 'country')) = any (v_low);
    when 'voltage' then v_res := p_ctx ->> 'voltage' in (select jsonb_array_elements_text(v_vals));
    when 'order_stage' then v_res := p_ctx ->> 'order_stage' in (select jsonb_array_elements_text(v_vals));
    when 'order_value' then
      if not p_ctx ? 'order_total' or nullif(c ->> 'value', '') is null then
        return false;
      end if;
      v_num := (p_ctx ->> 'order_total')::numeric;
      v_res := case v_op when 'gt' then v_num > (c ->> 'value')::numeric when 'lt' then v_num < (c ->> 'value')::numeric
                         else v_num = (c ->> 'value')::numeric end;
    when 'field' then
      v_txt := p_ctx ->> (c ->> 'field');
      select f ->> 'type' into v_ftyp
        from jsonb_array_elements(public.automation_defs() -> 'fields' -> (p_ctx ->> 'subject_type')) f
       where f ->> 'key' = c ->> 'field';
      if v_ftyp is null then
        return false;
      end if;
      if v_op = 'is_empty' then return nullif(btrim(coalesce(v_txt, '')), '') is null; end if;
      if v_op = 'is_not_empty' then return nullif(btrim(coalesce(v_txt, '')), '') is not null; end if;
      if v_txt is null then return v_op = 'not_equals'; end if;
      if v_ftyp = 'number' and v_op in ('gt', 'lt', 'equals', 'not_equals') then
        v_res := case v_op when 'gt' then v_txt::numeric > (c ->> 'value')::numeric
                           when 'lt' then v_txt::numeric < (c ->> 'value')::numeric
                           when 'equals' then v_txt::numeric = (c ->> 'value')::numeric
                           else v_txt::numeric <> (c ->> 'value')::numeric end;
      elsif v_ftyp = 'date' and v_op in ('gt', 'lt', 'equals', 'not_equals') then
        v_res := case v_op when 'gt' then v_txt::date > (c ->> 'value')::date
                           when 'lt' then v_txt::date < (c ->> 'value')::date
                           when 'equals' then v_txt::date = (c ->> 'value')::date
                           else v_txt::date <> (c ->> 'value')::date end;
      else
        v_res := case v_op when 'contains' then position(lower(coalesce(c ->> 'value', '')) in lower(v_txt)) > 0
                           when 'not_equals' then lower(btrim(v_txt)) <> lower(btrim(coalesce(c ->> 'value', '')))
                           when 'gt' then lower(v_txt) > lower(coalesce(c ->> 'value', ''))
                           when 'lt' then lower(v_txt) < lower(coalesce(c ->> 'value', ''))
                           else lower(btrim(v_txt)) = lower(btrim(coalesce(c ->> 'value', ''))) end;
      end if;
    else
      return false;
  end case;
  return coalesce(v_res, false);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  return false;
end;
$$;

-- The trigger's own choice (to which stage, which label, which order stage).
create or replace function public.automation_trigger_matches(r public.automations, p_ctx jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when r.trigger_key in ('card_moved', 'service_call_status') and nullif(r.trigger_config ->> 'stage_name', '') is not null
      then lower(btrim(coalesce(p_ctx ->> 'to_stage', p_ctx ->> 'stage', ''))) = lower(btrim(r.trigger_config ->> 'stage_name'))
    when r.trigger_key = 'label_added' and nullif(r.trigger_config ->> 'label', '') is not null
      then lower(btrim(coalesce(p_ctx ->> 'label', ''))) = lower(btrim(r.trigger_config ->> 'label'))
    when r.trigger_key = 'order_stage_changed' and nullif(r.trigger_config ->> 'stage', '') is not null
      then coalesce(p_ctx ->> 'to_stage', p_ctx ->> 'order_stage') = r.trigger_config ->> 'stage'
    else true
  end;
$$;


-- ===========================================================================
-- 8d. Actions (each one checks the OWNER's permissions again, every run)
-- ===========================================================================
-- Who a "notify" action reaches; problem = why a person is left out.
create or replace function public.automation_recipients(p_targets jsonb, p_ctx jsonb, p_owner text)
returns table (email text, name text, problem text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t jsonb;
  v_people text[] := '{}';
  x text;
begin
  for t in select * from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) loop
    case t ->> 'type'
      when 'user' then v_people := v_people || lower(t ->> 'target');
      when 'owner' then v_people := v_people || lower(p_owner);
      when 'actor' then
        if p_ctx ->> 'actor_email' is not null then v_people := v_people || (p_ctx ->> 'actor_email'); end if;
      when 'assignees' then
        v_people := v_people || array(select jsonb_array_elements_text(coalesce(p_ctx -> 'assignees', '[]'::jsonb)));
      when 'person' then
        if p_ctx ->> 'person_email' is not null then v_people := v_people || (p_ctx ->> 'person_email'); end if;
      when 'technician' then
        if p_ctx ->> 'technician_email' is not null then v_people := v_people || (p_ctx ->> 'technician_email'); end if;
      when 'board' then
        if p_ctx ? 'board_id' then
          v_people := v_people || array(select a.email from public.allowed_users a
                                         where public.board_access_of((p_ctx ->> 'board_id')::uuid, a.email) >= 1);
        end if;
      when 'group', 'department' then
        if not public.automation_can_message_target(p_owner, t ->> 'type', t ->> 'target') then
          email := null;
          name := coalesce((select g.name from public.user_groups g where g.id::text = t ->> 'target'),
                           (select d.name from public.departments d where d.id::text = t ->> 'target'), t ->> 'type');
          problem := 'the owner may not message this ' || (t ->> 'type');
          return next;
        elsif t ->> 'type' = 'group' then
          v_people := v_people || array(select m.user_email from public.user_group_members m where m.group_id::text = t ->> 'target');
        else
          v_people := v_people || array(select d.user_email from public.user_departments d where d.department_id::text = t ->> 'target');
        end if;
      else
        null;
    end case;
  end loop;
  for x in select distinct p from unnest(v_people) p where p is not null loop
    email := x;
    name := coalesce((select nullif(btrim(a.name), '') from public.allowed_users a where a.email = x), x);
    problem := case
      when not exists (select 1 from public.allowed_users a where a.email = x) then 'no longer a user'
      when not public.automation_can_message(p_owner, x) then 'the owner may not message this person'
      when not public.automation_visible_to(p_ctx, x) then 'cannot see this ' || replace(coalesce(p_ctx ->> 'subject_type', 'item'), '_', ' ')
      else null end;
    return next;
  end loop;
end;
$$;

create or replace function public.automation_card_or_skip(p_ctx jsonb)
returns uuid
language plpgsql
immutable
as $$
begin
  if p_ctx ->> 'card_id' is null then
    perform public.automation_skip('There is no card for this action.');
  end if;
  return (p_ctx ->> 'card_id')::uuid;
end;
$$;

-- The name people see for an order stage (Admin → Stage names).
create or replace function public.automation_stage_label(p_stage text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim((select value ->> p_stage from public.app_settings where key = 'stage_labels')), ''), p_stage);
$$;

-- A list of names in words: "Pat Shop", "Pat Shop and Lee Office", "Pat Shop and 3 others".
create or replace function public.automation_names(p text[])
returns text
language sql
immutable
as $$
  select case coalesce(cardinality(p), 0)
    when 0 then 'nobody'
    when 1 then p[1]
    when 2 then p[1] || ' and ' || p[2]
    else p[1] || ' and ' || (cardinality(p) - 1) || ' others' end;
$$;

-- Does one action and says in words what it did. Raises AU001 to skip it,
-- 42501 when the owner is not permitted, anything else when it fails.
create or replace function public.automation_action(a jsonb, p_ctx jsonb, r public.automations)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type  text := a ->> 'type';
  v_card  uuid;
  v_board uuid := nullif(p_ctx ->> 'board_id', '')::uuid;
  v_stage uuid;
  v_name  text;
  v_id    uuid;
  v_new   uuid;
  v_n     integer;
  v_date  date;
  v_end   date;
  v_title text;
  v_body  text;
  v_tech  text;
  v_list  text[];
  v_skip  text[];
  v_cl    uuid;
  x       record;
  i       jsonb;
  v_aud   jsonb;
begin
  case v_type
  when 'move_card' then
    v_card := public.automation_card_or_skip(p_ctx);
    if a ->> 'stage' = 'next' then
      select s.id, s.name into v_stage, v_name from public.board_stages s
       where s.board_id = v_board and not s.archived
         and s.sort_order > (select sort_order from public.board_stages where id = (p_ctx ->> 'stage_id')::uuid)
       order by s.sort_order limit 1;
      if v_stage is null then
        perform public.automation_skip('The card is already in the last stage.');
      end if;
    else
      select s.id, s.name into v_stage, v_name from public.board_stages s
       where s.board_id = v_board and not s.archived
         and (s.id::text = coalesce(a ->> 'stage_id', '') or lower(btrim(s.name)) = lower(btrim(coalesce(a ->> 'stage_name', ''))))
       order by (s.id::text = coalesce(a ->> 'stage_id', '')) desc limit 1;
      if v_stage is null then
        perform public.automation_skip(format('The board “%s” has no stage called “%s”.', p_ctx ->> 'board', coalesce(a ->> 'stage_name', '')));
      end if;
    end if;
    if v_stage = (p_ctx ->> 'stage_id')::uuid then
      perform public.automation_skip(format('The card is already in %s.', v_name));
    end if;
    perform public.move_board_card(v_card, v_stage, null);
    return format('Moved the card to %s.', v_name);

  when 'copy_card', 'create_card' then
    perform public.require_perm(case when v_type = 'copy_card' then 'boards.card.copy' else 'boards.card.create' end, 'edit');
    if v_type = 'copy_card' then
      v_card := public.automation_card_or_skip(p_ctx);
    end if;
    v_id := nullif(a ->> 'board_id', '')::uuid;
    if v_id is null then
      perform public.automation_skip('Choose a board for the new card.');
    end if;
    perform public.require_board(v_id, 'edit');
    select s.id, s.name into v_stage, v_name from public.board_stages s
     where s.board_id = v_id and not s.archived
     order by (s.id::text = coalesce(a ->> 'stage_id', '')) desc,
              (lower(btrim(s.name)) = lower(btrim(coalesce(a ->> 'stage_name', '')))) desc, s.sort_order
     limit 1;
    if v_stage is null then
      perform public.automation_skip('That board has no stages.');
    end if;
    if v_type = 'copy_card' then
      perform public.copy_board_card(v_card, v_id, v_stage, null);
      return format('Copied the card to %s – %s.', (select name from public.boards where id = v_id), v_name);
    end if;
    v_title := left(nullif(btrim(public.automation_fill(a ->> 'title', p_ctx)), ''), 200);
    if v_title is null then
      v_title := coalesce(p_ctx ->> 'title', r.name);
    end if;
    v_date := case when nullif(a ->> 'due_days', '') is not null
                   then public.automation_weekend(public.halifax_today() + (a ->> 'due_days')::int) end;
    insert into public.board_cards (board_id, stage_id, title, description, due_date, order_id, customer_id, machine_id)
    values (v_id, v_stage, v_title, public.automation_html(public.automation_fill(a ->> 'description', p_ctx)), v_date,
            case when coalesce((a ->> 'link')::boolean, false) and public.has_perm('boards.card.link', 'edit') then (p_ctx ->> 'order_id')::uuid end,
            case when coalesce((a ->> 'link')::boolean, false) and public.has_perm('boards.card.link', 'edit') and p_ctx ->> 'order_id' is null
                 then (p_ctx ->> 'customer_id')::uuid end,
            case when coalesce((a ->> 'link')::boolean, false) and public.has_perm('boards.card.link', 'edit') then (p_ctx ->> 'machine_id')::uuid end)
    returning id into v_new;
    return format('Created the card “%s” on %s – %s.', v_title, (select name from public.boards where id = v_id), v_name);

  when 'archive_card' then
    v_card := public.automation_card_or_skip(p_ctx);
    perform public.require_board(v_board, 'edit');
    perform public.require_perm('boards.card.archive', 'edit');
    update public.board_cards set archived = true where id = v_card and not archived;
    if not found then perform public.automation_skip('The card is already archived.'); end if;
    return 'Archived the card.';

  when 'add_label', 'remove_label' then
    v_card := public.automation_card_or_skip(p_ctx);
    perform public.require_board(v_board, 'edit');
    perform public.require_perm('boards.card.labels', 'edit');
    v_name := nullif(btrim(coalesce(a ->> 'label', '')), '');
    if v_name is null then perform public.automation_skip('Choose a label.'); end if;
    select id, name into v_id, v_name from public.board_labels
     where board_id = v_board and not archived and lower(btrim(name)) = lower(v_name) limit 1;
    if v_type = 'remove_label' then
      if v_id is null then perform public.automation_skip(format('This board has no label called “%s”.', btrim(a ->> 'label'))); end if;
      delete from public.board_card_labels where card_id = v_card and label_id = v_id;
      if not found then perform public.automation_skip(format('The card does not have the label “%s”.', v_name)); end if;
      return format('Removed the label “%s”.', v_name);
    end if;
    if v_id is null then
      if not public.has_perm('boards.labels.create', 'edit') then
        perform public.automation_skip(format('This board has no label called “%s”, and the owner may not create labels.', btrim(a ->> 'label')));
      end if;
      v_name := btrim(a ->> 'label');
      v_id := public.add_board_label(v_board, v_name, coalesce(nullif(a ->> 'colour', ''), '#16a34a'));
    end if;
    insert into public.board_card_labels (card_id, label_id) values (v_card, v_id) on conflict do nothing;
    if not found then perform public.automation_skip(format('The card already has the label “%s”.', v_name)); end if;
    return format('Added the label “%s”.', v_name);

  when 'mark_complete' then
    v_card := public.automation_card_or_skip(p_ctx);
    perform public.require_board(v_board, 'edit');
    perform public.require_any_perm(array['boards.card.complete', 'boards.card.timing'], 'edit');
    update public.board_cards set started_at = coalesce(started_at, now()), finished_at = now()
     where id = v_card and finished_at is null;
    if not found then perform public.automation_skip('The card is already complete.'); end if;
    return 'Marked the card complete.';

  when 'assign', 'unassign' then
    v_card := public.automation_card_or_skip(p_ctx);
    perform public.require_board(v_board, 'edit');
    perform public.require_perm('boards.card.assignees', 'edit');
    if v_type = 'unassign' and a ->> 'person' = 'all' then
      delete from public.board_card_assignees where card_id = v_card;
      get diagnostics v_n = row_count;
      if v_n = 0 then perform public.automation_skip('Nobody is assigned to the card.'); end if;
      return format('Removed %s %s from the card.', v_n, case when v_n = 1 then 'person' else 'people' end);
    end if;
    v_tech := lower(case a ->> 'person' when 'actor' then p_ctx ->> 'actor_email' when 'owner' then r.owner_email else a ->> 'person' end);
    if v_tech is null then perform public.automation_skip('There is no person for this action.'); end if;
    v_name := coalesce((select nullif(btrim(name), '') from public.allowed_users where email = v_tech), v_tech);
    if v_type = 'unassign' then
      delete from public.board_card_assignees where card_id = v_card and user_email = v_tech;
      if not found then perform public.automation_skip(format('%s is not on the card.', v_name)); end if;
      return format('Removed %s from the card.', v_name);
    end if;
    if not public.automation_can_message(r.owner_email, v_tech) then
      perform public.automation_skip(format('The owner may not assign %s.', v_name));
    end if;
    insert into public.board_card_assignees (card_id, user_email) values (v_card, v_tech) on conflict do nothing;
    if not found then perform public.automation_skip(format('%s is already on the card.', v_name)); end if;
    return format('Assigned %s to the card.', v_name);

  when 'set_due', 'shift_due' then
    v_card := public.automation_card_or_skip(p_ctx);
    perform public.require_board(v_board, 'edit');
    perform public.require_perm('boards.card.edit', 'edit');
    if v_type = 'set_due' and coalesce((a ->> 'clear')::boolean, false) then
      update public.board_cards set due_date = null where id = v_card and due_date is not null;
      if not found then perform public.automation_skip('The card has no due date.'); end if;
      return 'Cleared the due date.';
    end if;
    if v_type = 'shift_due' then
      select due_date into v_date from public.board_cards where id = v_card;
      if v_date is null then perform public.automation_skip('The card has no due date to move.'); end if;
      v_date := public.automation_weekend(v_date + coalesce((a ->> 'days')::int, 0));
    else
      v_date := public.automation_weekend(public.halifax_today() + coalesce((a ->> 'days')::int, 0));
    end if;
    update public.board_cards set due_date = v_date where id = v_card and due_date is distinct from v_date;
    if not found then perform public.automation_skip(format('The due date is already %s.', to_char(v_date, 'Mon FMDD, YYYY'))); end if;
    return format('Set the due date to %s.', to_char(v_date, 'Dy, Mon FMDD, YYYY'));

  when 'add_checklist' then
    v_card := public.automation_card_or_skip(p_ctx);
    perform public.require_board(v_board, 'edit');
    perform public.require_perm('boards.card.checklists', 'edit');
    v_title := left(coalesce(nullif(btrim(public.automation_fill(a ->> 'title', p_ctx)), ''), 'Checklist'), 200);
    insert into public.board_checklists (card_id, title, sort_order)
    values (v_card, v_title, coalesce((select max(sort_order) from public.board_checklists where card_id = v_card), 0) + 1)
    returning id into v_cl;
    v_n := 0;
    for i in select * from jsonb_array_elements(coalesce(a -> 'items', '[]'::jsonb)) loop
      if nullif(btrim(i #>> '{}'), '') is not null then
        v_n := v_n + 1;
        insert into public.board_checklist_items (checklist_id, item_text, sort_order)
        values (v_cl, left(btrim(public.automation_fill(i #>> '{}', p_ctx)), 500), v_n);
      end if;
    end loop;
    return format('Added the checklist “%s” with %s %s.', v_title, v_n, case when v_n = 1 then 'task' else 'tasks' end);

  when 'change_order_stage' then
    v_id := nullif(p_ctx ->> 'order_id', '')::uuid;
    if v_id is null then perform public.automation_skip('There is no order for this action.'); end if;
    v_name := a ->> 'stage';
    if v_name is null or v_name not in ('Quote', 'Confirmed', 'In production', 'Ready', 'Ready to ship', 'Shipped', 'Cancelled') then
      perform public.automation_skip('Choose a stage for the order.');
    end if;
    if (select stage from public.orders where id = v_id) = v_name then
      perform public.automation_skip(format('The order is already in %s.', public.automation_stage_label(v_name)));
    end if;
    perform public.apply_board_change(v_id, v_name);
    return format('Moved order %s to %s.', (select order_code from public.orders where id = v_id), public.automation_stage_label(v_name));

  when 'close_production_board' then
    v_id := coalesce(nullif(p_ctx ->> 'production_board_id', '')::uuid,
                     case when p_ctx ->> 'board_purpose' = 'production' then v_board end);
    if v_id is null then perform public.automation_skip('This order has no production board.'); end if;
    if exists (select 1 from public.boards where id = v_id and (closed_at is not null or archived)) then
      perform public.automation_skip('The production board is already closed'
        || case when (select close_reason from public.boards where id = v_id) = 'shipped' then ' (boards close by themselves when the order is shipped).' else '.' end);
    end if;
    perform public.close_board(v_id);
    return format('Closed the production board “%s”.', (select name from public.boards where id = v_id));

  when 'notify' then
    v_title := left(coalesce(nullif(btrim(public.automation_fill(a ->> 'title', p_ctx)), ''), r.name || ': ' || coalesce(p_ctx ->> 'title', '')), 200);
    v_body := left(nullif(btrim(public.automation_fill(a ->> 'message', p_ctx)), ''), 2000);
    v_list := '{}';
    v_skip := '{}';
    for x in select * from public.automation_recipients(a -> 'targets', p_ctx, r.owner_email) order by name loop
      if x.problem is null then
        v_list := v_list || x.name;
        insert into public.notifications (user_email, kind, title, body, link, board_id, card_id)
        values (x.email, 'automation_' || coalesce(nullif(a ->> 'channel', ''), 'app'), v_title, v_body, p_ctx ->> 'link',
                case when p_ctx ->> 'subject_type' = 'card' then v_board end,
                case when p_ctx ->> 'subject_type' = 'card' then (p_ctx ->> 'card_id')::uuid end);
      else
        v_skip := v_skip || (x.name || ' (' || x.problem || ')');
      end if;
    end loop;
    if cardinality(v_list) = 0 then
      perform public.automation_skip('Nobody could be notified' || case when cardinality(v_skip) > 0 then ': ' || array_to_string(v_skip, ', ') else '.' end);
    end if;
    return format('Sent %s to %s.', case coalesce(a ->> 'channel', 'app') when 'push' then 'a phone notification'
                                          when 'email' then 'an email notification' else 'an in-app notification' end,
                  public.automation_names(v_list))
           || case when cardinality(v_skip) > 0 then ' Left out: ' || array_to_string(v_skip, ', ') || '.' else '' end;

  when 'post_notice' then
    v_title := left(coalesce(nullif(btrim(public.automation_fill(a ->> 'title', p_ctx)), ''), coalesce(p_ctx ->> 'title', r.name)), 200);
    if coalesce(a ->> 'audience', 'everyone') = 'everyone' then
      v_aud := null;
    else
      select jsonb_agg(jsonb_build_object('type', 'department', 'target', d)) into v_aud
        from jsonb_array_elements_text(coalesce(a -> 'departments', '[]'::jsonb)) d;
      if v_aud is null then perform public.automation_skip('Choose the departments the notice is for.'); end if;
    end if;
    v_id := public.save_notice(jsonb_build_object(
      'title', v_title,
      'body', coalesce(public.automation_html(public.automation_fill(a ->> 'body', p_ctx)), '<p>' || replace(replace(v_title, '<', '&lt;'), '>', '&gt;') || '</p>'),
      'everyone', v_aud is null, 'audience', coalesce(v_aud, '[]'::jsonb),
      'priority', coalesce(nullif(a ->> 'priority', ''), 'normal'),
      'colour', coalesce(nullif(a ->> 'colour', ''), 'yellow'),
      'show_until', case when nullif(a ->> 'show_days', '') is not null then public.halifax_today() + (a ->> 'show_days')::int end));
    return format('Posted the notice “%s”.', v_title);

  when 'add_calendar_entry' then
    perform public.require_perm('service.calendar', 'view');
    v_tech := lower(case coalesce(a ->> 'tech', 'owner') when 'owner' then r.owner_email when 'person' then p_ctx ->> 'person_email'
                                                     when 'technician' then p_ctx ->> 'technician_email' else a ->> 'tech' end);
    if v_tech is null or not exists (select 1 from public.allowed_users where email = v_tech) then
      perform public.automation_skip('There is no person for the calendar entry.');
    end if;
    if coalesce(a ->> 'when', 'days') = 'subject' then
      v_date := coalesce(nullif(p_ctx ->> 'start_date', '')::date, nullif(p_ctx ->> 'service_start', '')::date,
                         nullif(p_ctx ->> 'due_date', '')::date, nullif(p_ctx ->> 'expected_ship_date', '')::date);
      v_end := coalesce(nullif(p_ctx ->> 'end_date', '')::date, nullif(p_ctx ->> 'service_end', '')::date, v_date);
      if v_date is null then perform public.automation_skip('There are no dates for the calendar entry.'); end if;
    else
      v_date := public.automation_weekend(public.halifax_today() + coalesce((a ->> 'days')::int, 0));
      v_end := v_date + greatest(coalesce((a ->> 'length')::int, 1), 1) - 1;
    end if;
    v_title := left(coalesce(nullif(btrim(public.automation_fill(a ->> 'title', p_ctx)), ''), coalesce(p_ctx ->> 'title', r.name)), 200);
    -- Through the Calendar's own function: its rules (private / shared, someone
    -- else's calendar, service kinds) are checked for the owner.
    perform public.save_calendar_entry(jsonb_build_object(
      'tech_email', v_tech,
      'kind', case when a ->> 'kind' in ('onsite', 'travel', 'training') then a ->> 'kind' else 'other' end,
      'title', v_title, 'start_date', v_date, 'end_date', greatest(v_end, v_date), 'all_day', true,
      'customer_id', nullif(p_ctx ->> 'customer_id', ''),
      'notes', nullif(btrim(public.automation_fill(a ->> 'notes', p_ctx)), ''),
      'visibility', case when v_tech = r.owner_email then 'private' else 'shared' end)
      || case when v_tech = r.owner_email then '{}'::jsonb
              else jsonb_build_object('shares', jsonb_build_array(jsonb_build_object('type', 'user', 'target', r.owner_email))) end);
    return format('Added “%s” to the Calendar for %s, %s.',
                  v_title, coalesce((select nullif(btrim(name), '') from public.allowed_users where email = v_tech), v_tech),
                  to_char(v_date, 'Mon FMDD') || case when v_end > v_date then ' to ' || to_char(v_end, 'Mon FMDD') else '' end);
  else
    perform public.automation_skip('This action is not available.');
  end case;
  return null;
end;
$$;

-- One action, with the result: ok / skipped / failed.
create or replace function public.automation_try(a jsonb, p_ctx jsonb, r public.automations)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := coalesce((select x ->> 'label' from jsonb_array_elements(public.automation_defs() -> 'actions') x
                             where x ->> 'key' = a ->> 'type'), a ->> 'type');
  v_msg text;
begin
  begin
    v_msg := public.automation_action(a, p_ctx, r);
    return jsonb_build_object('type', a ->> 'type', 'label', v_label, 'status', 'ok', 'message', v_msg);
  exception
    when sqlstate 'AU001' then
      return jsonb_build_object('type', a ->> 'type', 'label', v_label, 'status', 'skipped', 'message', sqlerrm);
    when insufficient_privilege then
      return jsonb_build_object('type', a ->> 'type', 'label', v_label, 'status', 'skipped', 'permission', true,
                                'message', 'Not permitted for the owner: ' || sqlerrm);
    when others then
      return jsonb_build_object('type', a ->> 'type', 'label', v_label, 'status', 'failed', 'message', sqlerrm);
  end;
end;
$$;

-- ===========================================================================
-- 8e. Running one automation for one event
-- ===========================================================================
create or replace function public.automation_tell_owner(r public.automations, p_message text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if r.owner_email is null then
    return;
  end if;
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  values (r.owner_email, 'automation_problem', format('Automation “%s” needs attention', r.name), left(p_message, 1000),
          '/automations/' || r.id || '?tab=log',
          'automation:' || r.id || ':' || public.halifax_today() || ':' || md5(p_message))
  on conflict (user_email, dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

-- Runs (or, with p_test, tries and rolls back) one automation for one event.
-- Returns {status, message, actions, conditions, ctx}. status: done / partial /
-- failed / skipped / not_matched.
create or replace function public.automation_run(r public.automations, e public.automation_events, p_test boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t      jsonb;
  v_saved  jsonb;
  v_ctx    jsonb;
  v_res    jsonb := '[]';
  v_conds  jsonb := '[]';
  v_status text;
  v_msg    text;
  v_ok     boolean;
  v_all    boolean := true;
  v_any    boolean := false;
  c        jsonb;
  a        jsonb;
begin
  select t into v_t from jsonb_array_elements(public.automation_defs() -> 'triggers') t where t ->> 'key' = r.trigger_key;
  if r.owner_email is null then
    return jsonb_build_object('status', 'skipped', 'message', 'This automation has no owner. An administrator can give it to another person.', 'actions', '[]'::jsonb);
  end if;
  v_saved := public.automation_become(r.owner_email);
  begin
    if not public.has_perm('automations', 'view') then
      v_status := 'skipped';
      v_msg := 'The owner may no longer use automations.';
    elsif v_t is null or not public.automation_allowed(v_t -> 'perms', 'view') then
      v_status := 'skipped';
      v_msg := format('The owner no longer has access to “%s”.', coalesce(v_t ->> 'label', r.trigger_key));
    else
      v_ctx := public.automation_context(e, r);
      if v_ctx is null then
        v_status := 'skipped';
        v_msg := 'The owner cannot see what this automation is about (or it was removed).';
      elsif r.scope = 'board' and v_ctx ->> 'subject_type' = 'card' and (v_ctx ->> 'board_id')::uuid <> r.board_id then
        v_status := 'not_matched';
      elsif not public.automation_trigger_matches(r, v_ctx) then
        v_status := 'not_matched';
      else
        for c in select * from jsonb_array_elements(r.conditions) loop
          v_ok := public.automation_condition(c, v_ctx);
          v_conds := v_conds || jsonb_build_object('type', c ->> 'type', 'ok', v_ok);
          v_all := v_all and v_ok;
          v_any := v_any or v_ok;
        end loop;
        if jsonb_array_length(r.conditions) > 0 and not (case when r.match = 'any' then v_any else v_all end) then
          v_status := 'not_matched';
        else
          -- loop protection: changes made now remember which automations led to them
          perform set_config('app.automation_chain', array_to_string(e.chain || r.id, ','), true);
          if p_test then
            begin
              for a in select * from jsonb_array_elements(r.actions) loop
                v_res := v_res || public.automation_try(a, v_ctx, r);
              end loop;
              raise exception 'test only' using errcode = 'AU009';
            exception when sqlstate 'AU009' then
              null;  -- everything the actions did is rolled back
            end;
          else
            for a in select * from jsonb_array_elements(r.actions) loop
              v_res := v_res || public.automation_try(a, v_ctx, r);
            end loop;
          end if;
          select case when count(*) = 0 then 'done'
                      when count(*) filter (where x ->> 'status' = 'ok') = count(*) then 'done'
                      when count(*) filter (where x ->> 'status' = 'ok') > 0 then 'partial'
                      when count(*) filter (where x ->> 'status' = 'failed') > 0 then 'failed'
                      else 'skipped' end
            into v_status from jsonb_array_elements(v_res) x;
        end if;
      end if;
    end if;
  exception when others then
    v_status := 'failed';
    v_msg := sqlerrm;
  end;
  perform public.automation_restore(v_saved);
  return jsonb_build_object('status', v_status, 'message', v_msg, 'actions', v_res, 'conditions', v_conds, 'ctx', v_ctx);
end;
$$;

create or replace function public.automation_log(r public.automations, e public.automation_events, p_status text, p_message text,
                                                 p_actions jsonb, p_ctx jsonb, p_test boolean)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_label text := (select t ->> 'label' from jsonb_array_elements(public.automation_defs() -> 'triggers') t where t ->> 'key' = r.trigger_key);
begin
  insert into public.automation_runs (automation_id, owner_email, trigger_key, trigger_text, subject_type, subject_id, subject_title, link,
                                      actor_email, actor_name, status, message, actions, is_test, depth)
  values (r.id, r.owner_email, r.trigger_key,
          coalesce(v_label, r.trigger_key)
            || coalesce(': ' || nullif(concat_ws(' → ', p_ctx ->> 'from_stage', coalesce(p_ctx ->> 'to_stage', p_ctx ->> 'label')), ''), ''),
          e.subject_type, e.subject_id, left(p_ctx ->> 'title', 300), p_ctx ->> 'link',
          e.actor_email, e.actor_name, p_status, p_message, coalesce(p_actions, '[]'::jsonb), p_test, coalesce(cardinality(e.chain), 0))
  returning id into v_id;
  return v_id;
end;
$$;

-- Processes one queued event: every automation waiting for it, with the limits.
create or replace function public.automation_process_event(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e   public.automation_events%rowtype;
  r   public.automations%rowtype;
  s   jsonb := public.automation_settings();
  v   jsonb;
  v_n integer;
  v_reason text;
begin
  delete from public.automation_events where id = p_id returning * into e;
  if e.id is null or not coalesce((s ->> 'enabled')::boolean, true) then
    return;
  end if;
  for r in select * from public.automations a
            where a.enabled and not a.archived and a.trigger_key = e.trigger_key and a.owner_email is not null
              and (e.only_rule is null or a.id = e.only_rule)
              and (a.scope <> 'board' or e.board_id is null or a.board_id = e.board_id)
            order by a.created_at loop
    v_reason := null;
    -- a rule never starts itself again, and only a few may follow one another
    if r.id = any (e.chain) then
      v_reason := 'loop';
    elsif coalesce(cardinality(e.chain), 0) >= (s ->> 'max_chain')::int then
      v_reason := 'chain';
    end if;
    if v_reason is not null then
      if not exists (select 1 from public.automation_runs where automation_id = r.id and status = 'loop' and started_at > now() - interval '1 minute') then
        perform public.automation_log(r, e, 'loop',
          case v_reason when 'loop' then 'Not run: the change was made by this automation itself, so running it again could repeat endlessly.'
               else format('Not run: %s automations already followed one another for this change (the limit).', cardinality(e.chain)) end,
          '[]', jsonb_build_object('title', coalesce(e.data ->> 'title', '')), false);
      end if;
      continue;
    end if;
    -- runs per minute
    select count(*) into v_n from public.automation_runs
     where automation_id = r.id and not is_test and status in ('done', 'partial', 'failed') and started_at > now() - interval '1 minute';
    if v_n >= (s ->> 'runs_per_minute_rule')::int then
      v_reason := format('Not run: this automation already ran %s times in the last minute (the limit).', v_n);
    else
      select count(*) into v_n from public.automation_runs
       where owner_email = r.owner_email and not is_test and status in ('done', 'partial', 'failed') and started_at > now() - interval '1 minute';
      if v_n >= (s ->> 'runs_per_minute_user')::int then
        v_reason := format('Not run: the owner''s automations already ran %s times in the last minute (the limit).', v_n);
      end if;
    end if;
    if v_reason is not null then
      if not exists (select 1 from public.automation_runs where automation_id = r.id and status = 'limited' and started_at > now() - interval '1 minute') then
        perform public.automation_log(r, e, 'limited', v_reason, '[]', '{}'::jsonb, false);
        perform public.automation_tell_owner(r, v_reason);
      end if;
      continue;
    end if;

    v := public.automation_run(r, e, false);
    if v ->> 'status' = 'not_matched' then
      continue;
    end if;
    perform public.automation_log(r, e, v ->> 'status', v ->> 'message', v -> 'actions', coalesce(v -> 'ctx', '{}'::jsonb), false);
    update public.automations
       set last_run_at = now(), last_status = v ->> 'status',
           run_count = run_count + case when v ->> 'status' in ('done', 'partial', 'failed') then 1 else 0 end
     where id = r.id;
    if v ->> 'status' = 'skipped' and v ->> 'message' is not null then
      perform public.automation_tell_owner(r, v ->> 'message');
    elsif exists (select 1 from jsonb_array_elements(v -> 'actions') x where (x ->> 'permission')::boolean or x ->> 'status' = 'failed') then
      perform public.automation_tell_owner(r, (select string_agg(x ->> 'label' || ': ' || (x ->> 'message'), ' ')
                                                 from jsonb_array_elements(v -> 'actions') x
                                                where (x ->> 'permission')::boolean or x ->> 'status' = 'failed'));
    end if;
  end loop;
end;
$$;

-- The queue runs when the change is saved (deferred to the end of the
-- transaction), so the change that started it is complete.
create or replace function public.automation_events_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.automation_process_event(new.id);
  return null;
end;
$$;
create constraint trigger automation_events_run after insert on public.automation_events
  deferrable initially deferred for each row execute function public.automation_events_run();

-- Queues an event, but only when some automation is waiting for it.
create or replace function public.automation_emit(p_trigger text, p_type text, p_subject uuid, p_board uuid,
                                                  p_data jsonb default '{}', p_only uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chain uuid[] := coalesce(string_to_array(nullif(current_setting('app.automation_chain', true), ''), ',')::uuid[], '{}');
begin
  if not exists (select 1 from public.automations a where a.enabled and not a.archived and a.trigger_key = p_trigger
                  and (p_only is null or a.id = p_only)) then
    return;
  end if;
  -- the same thing twice in one save counts once
  if exists (select 1 from public.automation_events q where q.trigger_key = p_trigger and q.subject_id is not distinct from p_subject
              and q.data = coalesce(p_data, '{}'::jsonb) and q.only_rule is not distinct from p_only and q.created_at = now()) then
    return;
  end if;
  insert into public.automation_events (trigger_key, subject_type, subject_id, board_id, data, actor_email, actor_name, chain, only_rule)
  values (p_trigger, p_type, p_subject, p_board, coalesce(p_data, '{}'::jsonb), public.current_user_email(),
          case when public.current_user_email() is not null then public.current_user_name() end, v_chain, p_only);
end;
$$;

-- ===========================================================================
-- 9. The triggers that queue events
-- ===========================================================================
create or replace function public.automation_on_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.automation_emit('card_created', 'card', new.id, new.board_id);
  elsif new.stage_id is distinct from old.stage_id then
    perform public.automation_emit('card_moved', 'card', new.id, new.board_id,
      jsonb_build_object('from_stage_id', old.stage_id, 'to_stage_id', new.stage_id));
    if new.card_kind = 'service' then
      perform public.automation_emit('service_call_status', 'card', new.id, new.board_id,
        jsonb_build_object('from_stage_id', old.stage_id, 'to_stage_id', new.stage_id));
    end if;
  end if;
  return null;
end;
$$;
create trigger board_cards_zzzzz_automations after insert or update of stage_id on public.board_cards
  for each row execute function public.automation_on_card();

create or replace function public.automation_on_card_label()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.automation_emit('label_added', 'card', new.card_id, public.board_of_card(new.card_id),
    jsonb_build_object('label', (select name from public.board_labels where id = new.label_id)));
  return null;
end;
$$;
create trigger board_card_labels_automations after insert on public.board_card_labels
  for each row execute function public.automation_on_card_label();

create or replace function public.automation_on_card_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.automation_emit('card_assigned', 'card', new.card_id, public.board_of_card(new.card_id),
    jsonb_build_object('assignee', new.user_email,
                       'assignee_name', (select coalesce(nullif(btrim(name), ''), email) from public.allowed_users where email = new.user_email)));
  return null;
end;
$$;
create trigger board_card_assignees_automations after insert on public.board_card_assignees
  for each row execute function public.automation_on_card_assignee();

create or replace function public.automation_on_checklist_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid;
begin
  if new.finished_at is not null and old.finished_at is null
     and not exists (select 1 from public.board_checklist_items i where i.checklist_id = new.checklist_id and i.finished_at is null) then
    select card_id into v_card from public.board_checklists where id = new.checklist_id;
    perform public.automation_emit('checklist_completed', 'card', v_card, public.board_of_card(v_card),
      jsonb_build_object('checklist', (select title from public.board_checklists where id = new.checklist_id)));
  end if;
  return null;
end;
$$;
create trigger board_checklist_items_automations after update of finished_at on public.board_checklist_items
  for each row execute function public.automation_on_checklist_item();

create or replace function public.automation_on_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.automation_emit('order_created', 'order', new.id, null);
    if new.stage = 'Confirmed' then
      perform public.automation_emit('order_confirmed', 'order', new.id, null);
    end if;
  elsif new.stage is distinct from old.stage then
    perform public.automation_emit('order_stage_changed', 'order', new.id, null,
      jsonb_build_object('from_stage', old.stage, 'to_stage', new.stage));
    if new.stage = 'Confirmed' then
      perform public.automation_emit('order_confirmed', 'order', new.id, null);
    elsif new.stage = 'Shipped' then
      perform public.automation_emit('order_shipped', 'order', new.id, null);
    end if;
  end if;
  return null;
end;
$$;
create trigger orders_zzz_automations after insert or update of stage on public.orders
  for each row execute function public.automation_on_order();

create or replace function public.automation_on_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.received_date is not null and (tg_op = 'INSERT' or old.received_date is null) then
    perform public.automation_emit('payment_received', 'payment', new.id, null);
  end if;
  return null;
end;
$$;
create trigger payments_automations after insert or update of received_date on public.payments
  for each row execute function public.automation_on_payment();

create or replace function public.automation_on_final_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.signed_at is not null and old.signed_at is null then
    perform public.automation_emit('final_check_signed', 'machine', new.machine_id, null);
  end if;
  return null;
end;
$$;
create trigger machine_checklists_automations after update of signed_at on public.machine_checklists
  for each row execute function public.automation_on_final_check();

-- Every machine that needs a crate (or already has one) on the order is crated.
create or replace function public.automation_on_crate_machine()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order uuid;
begin
  select order_id into v_order from public.order_machines where id = new.machine_id;
  if (select count(*) from public.crate_machines cm join public.crates c on c.id = cm.crate_id
       where cm.machine_id = new.machine_id and not c.archived) = 1
     and not exists (select 1 from public.order_machines m
                      where m.order_id = v_order and not m.archived and m.needs_crate
                        and not exists (select 1 from public.crate_machines cm join public.crates c on c.id = cm.crate_id
                                         where cm.machine_id = m.id and not c.archived)) then
    perform public.automation_emit('crating_complete', 'order', v_order, null);
  end if;
  return null;
end;
$$;
create trigger crate_machines_automations after insert on public.crate_machines
  for each row execute function public.automation_on_crate_machine();

create or replace function public.automation_on_notice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.archived then
    perform public.automation_emit('notice_posted', 'notice', new.id, null);
  end if;
  return null;
end;
$$;
create trigger notices_automations after insert on public.notices
  for each row execute function public.automation_on_notice();

create or replace function public.automation_on_time_off()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.automation_emit('time_off_approved', 'time_off', new.id, null);
  end if;
  return null;
end;
$$;
create trigger time_off_requests_automations after update of status on public.time_off_requests
  for each row execute function public.automation_on_time_off();

-- ===========================================================================
-- 9b. Every minute: schedules, due dates, payments; old log lines removed
-- ===========================================================================
create or replace function public.automations_tick()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  s       jsonb := public.automation_settings();
  v_now   timestamp := now() at time zone 'America/Halifax';
  v_today date := (now() at time zone 'America/Halifax')::date;
  r       public.automations%rowtype;
  x       record;
  v_time  time;
  v_days  int[];
  v_key   text;
  v_n     integer := 0;
begin
  if not coalesce((s ->> 'enabled')::boolean, true) then
    return 0;
  end if;
  for r in select * from public.automations where enabled and not archived and owner_email is not null
              and trigger_key in ('schedule', 'card_due_soon', 'card_overdue', 'payment_due', 'payment_overdue') loop
    if r.trigger_key = 'schedule' then
      v_time := coalesce(nullif(r.trigger_config ->> 'time', ''), '08:00')::time;
      v_days := case coalesce(r.trigger_config ->> 'frequency', 'daily')
                  when 'weekdays' then array[1, 2, 3, 4, 5]
                  when 'weekly' then array(select jsonb_array_elements_text(coalesce(r.trigger_config -> 'days', '[1]'::jsonb))::int)
                  else array[1, 2, 3, 4, 5, 6, 7] end;
      if extract(isodow from v_today)::int = any (v_days) and v_now::time >= v_time and v_now::time < v_time + interval '2 hours'
         and (r.last_scheduled_on is null or r.last_scheduled_on < v_today) then
        update public.automations set last_scheduled_on = v_today where id = r.id;
        perform public.automation_emit('schedule', 'none', null, null, jsonb_build_object('scheduled_for', v_today), r.id);
        v_n := v_n + 1;
      end if;
    elsif r.trigger_key in ('card_due_soon', 'card_overdue') then
      for x in select c.id, c.board_id, c.due_date from public.board_cards c join public.boards b on b.id = c.board_id
                where not c.archived and not b.archived and b.closed_at is null and c.finished_at is null and c.due_date is not null
                  and (r.scope <> 'board' or c.board_id = r.board_id)
                  and case when r.trigger_key = 'card_overdue' then c.due_date < v_today
                           else c.due_date between v_today and v_today + coalesce(nullif(r.trigger_config ->> 'days', '')::int, b.due_soon_days, 2) end
                  and public.board_access_of(c.board_id, r.owner_email) >= 1
                  and not exists (select 1 from public.automation_fired f where f.automation_id = r.id
                                   and f.fire_key = r.trigger_key || ':' || c.id || ':' || c.due_date)
                order by c.due_date limit 100 loop
        insert into public.automation_fired (automation_id, fire_key) values (r.id, r.trigger_key || ':' || x.id || ':' || x.due_date);
        perform public.automation_emit(r.trigger_key, 'card', x.id, x.board_id, jsonb_build_object('due', x.due_date), r.id);
        v_n := v_n + 1;
      end loop;
    elsif public.perm_of(r.owner_email, 'payments') then
      for x in select p.id, p.due_date from public.payment_overview p
                where not p.order_archived and p.stage <> 'Cancelled' and p.remaining > 0 and p.due_date is not null
                  and case when r.trigger_key = 'payment_overdue' then p.due_date < v_today
                           else p.due_date between v_today and v_today + coalesce(nullif(r.trigger_config ->> 'days', '')::int, 7) end
                  and not exists (select 1 from public.automation_fired f where f.automation_id = r.id
                                   and f.fire_key = r.trigger_key || ':' || p.id || ':' || p.due_date)
                order by p.due_date limit 100 loop
        insert into public.automation_fired (automation_id, fire_key) values (r.id, r.trigger_key || ':' || x.id || ':' || x.due_date);
        perform public.automation_emit(r.trigger_key, 'payment', x.id, null, jsonb_build_object('due', x.due_date), r.id);
        v_n := v_n + 1;
      end loop;
    end if;
  end loop;
  delete from public.automation_runs where started_at < now() - make_interval(days => (s ->> 'keep_days')::int);
  delete from public.automation_fired where fired_at < now() - interval '400 days';
  delete from public.automation_events where created_at < now() - interval '1 day';
  return v_n;
end;
$$;

-- ===========================================================================
-- 6. Checking a rule for the signed-in person (problems in plain words)
-- ===========================================================================
create or replace function public.automation_problems(p jsonb)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d       jsonb := public.automation_defs();
  s       jsonb := public.automation_settings();
  v_me    text := public.current_user_email();
  v_out   text[] := '{}';
  v_t     jsonb;
  v_def   jsonb;
  v_subj  text;
  c       jsonb;
  a       jsonb;
  t       jsonb;
  v_val   text;
  v_board boolean := public.has_perm('boards', 'view');
begin
  if not public.has_perm('automations', 'view') then
    return array['You do not have permission to use automations.'];
  end if;
  select x into v_t from jsonb_array_elements(d -> 'triggers') x where x ->> 'key' = p ->> 'trigger_key';
  if v_t is null then
    return array['Choose what starts the automation (When).'];
  end if;
  if nullif(btrim(coalesce(p ->> 'name', '')), '') is null then
    v_out := v_out || 'Enter a name for the automation.'::text;
  end if;
  if not public.automation_allowed(v_t -> 'perms', 'view') then
    v_out := v_out || format('You do not have access to “%s”.', v_t ->> 'label');
  end if;
  v_subj := v_t ->> 'subject';
  -- what the trigger asks for
  if p ->> 'trigger_key' = 'schedule' then
    if coalesce(p #>> '{trigger_config,time}', '08:00') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      v_out := v_out || 'Enter the time as hours and minutes, for example 08:00.'::text;
    end if;
    if coalesce(p #>> '{trigger_config,frequency}', 'daily') not in ('daily', 'weekdays', 'weekly') then
      v_out := v_out || 'Choose every day, weekdays or chosen days of the week.'::text;
    elsif p #>> '{trigger_config,frequency}' = 'weekly'
          and coalesce(jsonb_array_length(p #> '{trigger_config,days}'), 0) = 0 then
      v_out := v_out || 'Choose at least one day of the week.'::text;
    end if;
  end if;
  if nullif(p #>> '{trigger_config,days}', '') is not null and p ->> 'trigger_key' in ('card_due_soon', 'payment_due')
     and (p #>> '{trigger_config,days}' !~ '^[0-9]{1,3}$') then
    v_out := v_out || 'Enter the number of days as a whole number.'::text;
  end if;
  -- board automations
  if coalesce(p ->> 'scope', 'personal') = 'board' then
    if nullif(p ->> 'board_id', '') is null or not v_board or public.board_level((p ->> 'board_id')::uuid) < 2 then
      v_out := v_out || 'A board automation needs a board you can edit.'::text;
    end if;
  end if;
  -- conditions
  for c in select * from jsonb_array_elements(coalesce(p -> 'conditions', '[]'::jsonb)) loop
    select x into v_def from jsonb_array_elements(d -> 'conditions') x where x ->> 'key' = c ->> 'type';
    if v_def is null then
      v_out := v_out || 'One of the conditions is not available.'::text;
      continue;
    end if;
    if not (v_def -> 'subjects') ? v_subj then
      v_out := v_out || format('The condition “%s” does not apply to “%s”.', v_def ->> 'label', v_t ->> 'label');
    end if;
    if not public.automation_allowed(v_def -> 'perms', 'view') then
      v_out := v_out || format('You do not have access to the condition “%s”.', v_def ->> 'label');
    end if;
    if c ->> 'type' = 'board' then
      for v_val in select jsonb_array_elements_text(coalesce(c -> 'values', '[]'::jsonb)) loop
        if not v_board or public.board_level(v_val::uuid) < 1 then
          v_out := v_out || 'One of the boards in the conditions cannot be opened by you.'::text;
        end if;
      end loop;
    elsif c ->> 'type' = 'field' and not exists (
            select 1 from jsonb_array_elements(d -> 'fields' -> v_subj) f
             where f ->> 'key' = c ->> 'field' and public.automation_allowed(f -> 'perms', 'view')) then
      v_out := v_out || 'Choose a field for the condition.'::text;
    end if;
  end loop;
  -- actions
  if coalesce(jsonb_array_length(p -> 'actions'), 0) = 0 then
    v_out := v_out || 'Add at least one action (Then).'::text;
  elsif jsonb_array_length(p -> 'actions') > (s ->> 'max_actions_per_rule')::int then
    v_out := v_out || format('An automation can have at most %s actions.', s ->> 'max_actions_per_rule');
  end if;
  for a in select * from jsonb_array_elements(coalesce(p -> 'actions', '[]'::jsonb)) loop
    select x into v_def from jsonb_array_elements(d -> 'actions') x where x ->> 'key' = a ->> 'type';
    if v_def is null then
      v_out := v_out || 'One of the actions is not available.'::text;
      continue;
    end if;
    if not (v_def -> 'subjects') ? v_subj then
      v_out := v_out || format('“%s” cannot be used with “%s”.', v_def ->> 'label', v_t ->> 'label');
    end if;
    if not public.automation_allowed(v_def -> 'perms', 'edit') or (v_def ->> 'group' = 'Cards' and not v_board) then
      v_out := v_out || format('You are not permitted to “%s”.', lower(v_def ->> 'label'));
      continue;
    end if;
    case a ->> 'type'
      when 'move_card' then
        if coalesce(a ->> 'stage', '') <> 'next' and nullif(btrim(coalesce(a ->> 'stage_name', '')), '') is null then
          v_out := v_out || 'Choose the stage to move the card to.'::text;
        end if;
      when 'copy_card', 'create_card' then
        if nullif(a ->> 'board_id', '') is null or not v_board or public.board_level((a ->> 'board_id')::uuid) < 2 then
          v_out := v_out || 'Choose a board you can edit for the card.'::text;
        end if;
        if a ->> 'type' = 'create_card' and nullif(btrim(coalesce(a ->> 'title', '')), '') is null then
          v_out := v_out || 'Enter a title for the new card.'::text;
        end if;
      when 'add_label', 'remove_label' then
        if nullif(btrim(coalesce(a ->> 'label', '')), '') is null then
          v_out := v_out || 'Choose the label.'::text;
        end if;
      when 'assign', 'unassign' then
        if coalesce(a ->> 'person', '') = '' then
          v_out := v_out || 'Choose the person.'::text;
        elsif a ->> 'person' not in ('actor', 'owner', 'all') and not public.automation_can_message(v_me, a ->> 'person') then
          v_out := v_out || 'You may only assign people you can message.'::text;
        end if;
      when 'set_due', 'shift_due' then
        if not coalesce((a ->> 'clear')::boolean, false) and coalesce(a ->> 'days', '') !~ '^-?[0-9]{1,3}$' then
          v_out := v_out || 'Enter the number of days for the due date.'::text;
        end if;
      when 'add_checklist' then
        if nullif(btrim(coalesce(a ->> 'title', '')), '') is null then
          v_out := v_out || 'Enter a title for the checklist.'::text;
        end if;
      when 'change_order_stage' then
        if coalesce(a ->> 'stage', '') not in ('Quote', 'Confirmed', 'In production', 'Ready', 'Ready to ship', 'Shipped', 'Cancelled') then
          v_out := v_out || 'Choose the stage for the order.'::text;
        elsif a ->> 'stage' <> 'Shipped' and not public.has_any_perm(array['order.action.change_stage', 'orders.board.change_stage'], 'edit') then
          v_out := v_out || 'You are not permitted to change an order''s stage.'::text;
        end if;
      when 'notify' then
        if coalesce(a ->> 'channel', 'app') not in ('app', 'push', 'email') then
          v_out := v_out || 'Choose in-app, phone push or email for the notification.'::text;
        end if;
        if coalesce(jsonb_array_length(a -> 'targets'), 0) = 0 then
          v_out := v_out || 'Choose who to notify.'::text;
        end if;
        for t in select * from jsonb_array_elements(coalesce(a -> 'targets', '[]'::jsonb)) loop
          if t ->> 'type' = 'user' and not public.automation_can_message(v_me, t ->> 'target') then
            v_out := v_out || 'You may only notify people you can message.'::text;
          elsif t ->> 'type' in ('group', 'department') and not public.automation_can_message_target(v_me, t ->> 'type', t ->> 'target') then
            v_out := v_out || format('You may not message that %s.', t ->> 'type');
          elsif t ->> 'type' not in ('user', 'group', 'department', 'assignees', 'actor', 'owner', 'board', 'person', 'technician') then
            v_out := v_out || 'Choose who to notify.'::text;
          end if;
        end loop;
      when 'post_notice' then
        if nullif(btrim(coalesce(a ->> 'title', '')), '') is null then
          v_out := v_out || 'Enter a title for the notice.'::text;
        end if;
        if coalesce(a ->> 'audience', 'everyone') = 'everyone' and not public.has_perm('notices.post.everyone', 'edit') then
          v_out := v_out || 'You may post notices only for your own departments.'::text;
        end if;
        if coalesce(a ->> 'priority', 'normal') not in ('normal', 'important') then
          v_out := v_out || 'An automation can post normal or important notices.'::text;
        elsif a ->> 'priority' = 'important' and not public.has_perm('notices.priority.important', 'edit') then
          v_out := v_out || 'You are not permitted to post important notices.'::text;
        end if;
      when 'add_calendar_entry' then
        if coalesce(a ->> 'tech', 'owner') <> 'owner' and not public.has_perm('service.calendar.manage', 'edit') then
          v_out := v_out || 'You may only add entries to your own calendar.'::text;
        end if;
        if coalesce(a ->> 'kind', 'other') in ('onsite', 'travel', 'training') and not public.has_perm('service', 'view') then
          v_out := v_out || 'Only people with the Service / Training page can add travel, on-site and training entries.'::text;
        end if;
      else
        null;
    end case;
  end loop;
  return array(select distinct x from unnest(v_out) x);
end;
$$;

-- The problems for another person (the owner), checked with their permissions.
create or replace function public.automation_problems_for(p_email text, p jsonb)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saved jsonb := public.automation_become(p_email);
  v_out   text[];
begin
  v_out := public.automation_problems(p);
  perform public.automation_restore(v_saved);
  return v_out;
end;
$$;

-- ===========================================================================
-- 7. Saving, sharing, switching on and off, copying, archiving
-- ===========================================================================
create or replace function public.automation_clean(p jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'name', btrim(coalesce(p ->> 'name', '')),
    'description', nullif(btrim(coalesce(p ->> 'description', '')), ''),
    'scope', coalesce(nullif(p ->> 'scope', ''), 'personal'),
    'board_id', case when p ->> 'scope' = 'board' then nullif(p ->> 'board_id', '') end,
    'trigger_key', p ->> 'trigger_key',
    'trigger_config', coalesce(case when jsonb_typeof(p -> 'trigger_config') = 'object' then p -> 'trigger_config' end, '{}'::jsonb),
    'match', case when p ->> 'match' = 'any' then 'any' else 'all' end,
    'conditions', coalesce(case when jsonb_typeof(p -> 'conditions') = 'array' then p -> 'conditions' end, '[]'::jsonb),
    'actions', coalesce(case when jsonb_typeof(p -> 'actions') = 'array' then p -> 'actions' end, '[]'::jsonb),
    'template_key', nullif(p ->> 'template_key', ''));
$$;

create or replace function public.automation_raise_problems(p_problems text[], p_prefix text default '')
returns void
language plpgsql
as $$
begin
  if coalesce(cardinality(p_problems), 0) > 0 then
    raise exception '%', p_prefix || array_to_string(p_problems, ' ') using errcode = '22023';
  end if;
end;
$$;

create or replace function public.save_automation(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   text := public.current_user_email();
  v_id   uuid := nullif(p ->> 'id', '')::uuid;
  v      jsonb := public.automation_clean(p);
  r      public.automations%rowtype;
  v_owner text;
  v_lvl  integer;
  v_on   boolean;
begin
  perform public.require_perm('automations', 'edit');
  if v_id is null then
    if (select count(*) from public.automations where owner_email = v_me and not archived)
       >= (public.automation_settings() ->> 'max_rules_per_user')::int then
      raise exception 'You already have % automations (the limit). Archive one you no longer need first.',
        public.automation_settings() ->> 'max_rules_per_user' using errcode = '22023';
    end if;
    v_owner := v_me;
  else
    select * into r from public.automations where id = v_id for update;
    if not found then
      raise exception 'That automation could not be found.' using errcode = 'P0002';
    end if;
    v_lvl := public.automation_level(v_id);
    if v_lvl < 2 then
      raise exception 'You may not change this automation.' using errcode = '42501';
    end if;
    v_owner := r.owner_email;
    if r.scope is distinct from v ->> 'scope' or r.board_id::text is distinct from v ->> 'board_id' then
      if v_lvl < 3 then
        raise exception 'Only the owner can change whether this is a board automation.' using errcode = '42501';
      end if;
    end if;
  end if;
  -- checked for the person saving it, and for the owner it runs as
  perform public.automation_raise_problems(public.automation_problems(v));
  if v_owner is not null and v_owner <> v_me then
    perform public.automation_raise_problems(public.automation_problems_for(v_owner, v),
      format('The owner, %s, cannot run this: ', coalesce((select name from public.allowed_users where email = v_owner), v_owner)));
  end if;
  v_on := coalesce((p ->> 'enabled')::boolean, coalesce(r.enabled, true));
  if v_on and v_owner is null then
    raise exception 'This automation has no owner. Give it to another person first (Admin → Automations).' using errcode = '22023';
  end if;
  if v_on and r.paused_reason = 'admin' and not public.has_perm('admin.automations', 'edit') then
    v_on := false;
  end if;
  if v_id is null then
    insert into public.automations (name, description, owner_email, owner_name, scope, board_id, enabled, trigger_key, trigger_config,
                                    match, conditions, actions, template_key, created_by, updated_by)
    values (v ->> 'name', v ->> 'description', v_me, public.current_user_name(), v ->> 'scope', (v ->> 'board_id')::uuid, v_on,
            v ->> 'trigger_key', v -> 'trigger_config', v ->> 'match', v -> 'conditions', v -> 'actions', v ->> 'template_key', v_me, v_me)
    returning id into v_id;
  else
    update public.automations
       set name = v ->> 'name', description = v ->> 'description', scope = v ->> 'scope', board_id = (v ->> 'board_id')::uuid,
           enabled = v_on, paused_reason = case when v_on then null else paused_reason end,
           trigger_key = v ->> 'trigger_key', trigger_config = v -> 'trigger_config', match = v ->> 'match',
           conditions = v -> 'conditions', actions = v -> 'actions', updated_at = now(), updated_by = v_me,
           last_scheduled_on = case when trigger_config is distinct from v -> 'trigger_config' then null else last_scheduled_on end
     where id = v_id;
    if v_me <> coalesce(r.owner_email, '') then
      perform public.log_admin_action('automations', v_id::text, null,
        jsonb_build_object('action', 'automation changed by someone other than its owner', 'automation', v ->> 'name', 'owner', r.owner_email));
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.set_automation_enabled(p_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.automations%rowtype;
  v_me text := public.current_user_email();
  v_admin boolean := public.has_perm('admin.automations', 'edit');
begin
  select * into r from public.automations where id = p_id for update;
  if not found or public.automation_level(p_id) < 2 then
    raise exception 'You may not change this automation.' using errcode = '42501';
  end if;
  if p_on then
    if r.owner_email is null then
      raise exception 'This automation has no owner. Give it to another person first (Admin → Automations).' using errcode = '22023';
    end if;
    if r.paused_reason = 'admin' and not v_admin then
      raise exception 'An administrator paused this automation. Ask them to turn it on again.' using errcode = '42501';
    end if;
    perform public.automation_raise_problems(public.automation_problems_for(r.owner_email, to_jsonb(r)),
      'This automation cannot run with its owner''s permissions: ');
    update public.automations set enabled = true, paused_reason = null, paused_by = null, paused_at = null, updated_at = now(), updated_by = v_me
     where id = p_id;
  else
    update public.automations
       set enabled = false, updated_at = now(), updated_by = v_me,
           paused_reason = case when v_admin and v_me is distinct from r.owner_email then 'admin' else paused_reason end,
           paused_by = v_me, paused_at = now()
     where id = p_id;
  end if;
  if v_me is distinct from r.owner_email then
    perform public.log_admin_action('automations', p_id::text, null,
      jsonb_build_object('action', case when p_on then 'automation turned on' else 'automation paused' end, 'automation', r.name, 'owner', r.owner_email));
  end if;
end;
$$;

create or replace function public.archive_automation(p_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.automations%rowtype;
begin
  select * into r from public.automations where id = p_id for update;
  if not found or not (public.automation_level(p_id) >= 3
                       or (r.scope = 'board' and public.board_level(r.board_id) >= 3 and public.has_perm('automations', 'edit'))) then
    raise exception 'Only the owner (or the board''s managers, for a board automation) can archive this automation.' using errcode = '42501';
  end if;
  update public.automations set archived = p_archived, enabled = case when p_archived then false else enabled end, updated_at = now()
   where id = p_id;
end;
$$;

create or replace function public.copy_automation(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.automations%rowtype;
begin
  select * into r from public.automations where id = p_id;
  if not found or public.automation_level(p_id) < 1 then
    raise exception 'That automation could not be found.' using errcode = 'P0002';
  end if;
  return public.save_automation(jsonb_build_object(
    'name', left('Copy of ' || r.name, 120), 'description', r.description, 'scope', 'personal',
    'trigger_key', r.trigger_key, 'trigger_config', r.trigger_config, 'match', r.match,
    'conditions', r.conditions, 'actions', r.actions, 'enabled', false));
end;
$$;

-- Shares: [{type: user / group / department, target, can_edit}]. Replaces the list.
create or replace function public.share_automation(p_id uuid, p_shares jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r  public.automations%rowtype;
  v_me text := public.current_user_email();
  s  jsonb;
  v_new text[] := '{}';
begin
  perform public.require_perm('automations.share', 'edit');
  select * into r from public.automations where id = p_id for update;
  if not found or public.automation_level(p_id) < 3 then
    raise exception 'Only the owner can share this automation.' using errcode = '42501';
  end if;
  for s in select * from jsonb_array_elements(coalesce(p_shares, '[]'::jsonb)) loop
    if s ->> 'type' not in ('user', 'group', 'department') or nullif(s ->> 'target', '') is null then
      raise exception 'Choose a person, group or department to share with.' using errcode = '22023';
    end if;
    if s ->> 'type' = 'user' and not public.automation_can_message(v_me, s ->> 'target') then
      raise exception 'You may only share with people you can message.' using errcode = '42501';
    end if;
    if s ->> 'type' <> 'user' and not public.automation_can_message_target(v_me, s ->> 'type', s ->> 'target') then
      raise exception 'You may only share with your own groups and departments.' using errcode = '42501';
    end if;
  end loop;
  select array_agg(lower(x ->> 'target')) into v_new from jsonb_array_elements(coalesce(p_shares, '[]'::jsonb)) x
   where x ->> 'type' = 'user'
     and not exists (select 1 from public.automation_shares o where o.automation_id = p_id and o.share_type = 'user' and o.target = lower(x ->> 'target'));
  delete from public.automation_shares where automation_id = p_id;
  insert into public.automation_shares (automation_id, share_type, target, can_edit)
  select distinct on (x ->> 'type', case when x ->> 'type' = 'user' then lower(x ->> 'target') else x ->> 'target' end)
         p_id, x ->> 'type', case when x ->> 'type' = 'user' then lower(x ->> 'target') else x ->> 'target' end,
         coalesce((x ->> 'can_edit')::boolean, false)
    from jsonb_array_elements(coalesce(p_shares, '[]'::jsonb)) x;
  insert into public.notifications (user_email, kind, title, body, link)
  select e, 'automation_shared', 'Automation shared with you', public.current_user_name() || ' shared “' || r.name || '” with you.', '/automations/' || p_id
    from unnest(coalesce(v_new, '{}')) e where e <> v_me and exists (select 1 from public.allowed_users where email = e);
end;
$$;

-- Every automation the signed-in person can see, with what they may do.
create or replace function public.automation_list(p_all boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('automations', 'view');
  if p_all then
    perform public.require_admin_area('automations');
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(a) - 'last_scheduled_on'
             || jsonb_build_object(
                  'level', lv.level,
                  'mine', a.owner_email = v_me,
                  'shared_with_me', a.owner_email is distinct from v_me and exists (select 1 from public.automation_shares s where s.automation_id = a.id)
                                     and lv.level between 1 and 2,
                  'board_name', (select name from public.boards where id = a.board_id),
                  'can_archive', lv.level >= 3 or (a.scope = 'board' and public.board_level(a.board_id) >= 3),
                  'shares', case when lv.level >= 3 then coalesce((select jsonb_agg(jsonb_build_object('type', s.share_type, 'target', s.target, 'can_edit', s.can_edit,
                                   'name', case s.share_type when 'user' then coalesce((select nullif(btrim(name), '') from public.allowed_users where email = s.target), s.target)
                                                             when 'group' then (select name from public.user_groups where id::text = s.target)
                                                             else (select name from public.departments where id::text = s.target) end))
                                   from public.automation_shares s where s.automation_id = a.id), '[]'::jsonb) else '[]'::jsonb end,
                  'runs_today', (select count(*) from public.automation_runs u where u.automation_id = a.id and not u.is_test
                                  and u.status in ('done', 'partial', 'failed')
                                  and u.started_at >= (public.halifax_today()::timestamp at time zone 'America/Halifax')))
             order by a.archived, a.name)
      from public.automations a
      cross join lateral (select public.automation_level(a.id) as level) lv
     where lv.level >= 1 and (p_all or not a.archived or a.owner_email = v_me)), '[]'::jsonb);
end;
$$;

-- Admin: give an automation (for example of a removed person) to someone else.
create or replace function public.admin_reassign_automation(p_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.automations%rowtype;
  v_email text := lower(btrim(p_email));
begin
  perform public.require_admin_area('automations');
  select * into r from public.automations where id = p_id for update;
  if not found then
    raise exception 'That automation could not be found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.allowed_users where email = v_email) then
    raise exception 'Choose a person on the users list.' using errcode = '22023';
  end if;
  perform public.automation_raise_problems(public.automation_problems_for(v_email, to_jsonb(r)),
    format('%s cannot run this automation: ', coalesce((select name from public.allowed_users where email = v_email), v_email)));
  update public.automations
     set owner_email = v_email, owner_name = (select name from public.allowed_users where email = v_email),
         enabled = false, paused_reason = null, paused_by = null, paused_at = null, updated_at = now(),
         updated_by = public.current_user_email()
   where id = p_id;
  perform public.log_admin_action('automations', p_id::text, null,
    jsonb_build_object('action', 'automation given to another person', 'automation', r.name, 'old', coalesce(r.owner_email, r.removed_owner_email), 'new', v_email));
end;
$$;

-- The owner is removed: their automations are paused and listed for admins.
create or replace function public.automation_owner_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.automations
     set enabled = false, paused_reason = 'owner_removed', paused_at = now(), removed_owner_email = old.email,
         owner_name = coalesce(owner_name, old.name)
   where owner_email = old.email;
  return old;
end;
$$;
create trigger allowed_users_automations_owner before delete on public.allowed_users
  for each row execute function public.automation_owner_removed();

-- ===========================================================================
-- 10. Test: what would happen, without doing anything
-- ===========================================================================
-- Recent things the automation could be tested on (only what the owner can see).
create or replace function public.automation_test_subjects(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid := nullif(p ->> 'id', '')::uuid;
  v_owner text := public.current_user_email();
  v_key   text := p ->> 'trigger_key';
  v_subj  text;
  v_board uuid := case when p ->> 'scope' = 'board' then nullif(p ->> 'board_id', '')::uuid end;
  v_out   jsonb;
  v_saved jsonb;
begin
  perform public.require_perm('automations', 'view');
  if v_id is not null then
    if public.automation_level(v_id) < 1 then
      raise exception 'That automation could not be found.' using errcode = 'P0002';
    end if;
    select coalesce(owner_email, v_owner), coalesce(v_key, trigger_key), coalesce(v_board, board_id) into v_owner, v_key, v_board
      from public.automations where id = v_id;
  end if;
  select t ->> 'subject' into v_subj from jsonb_array_elements(public.automation_defs() -> 'triggers') t where t ->> 'key' = v_key;
  v_saved := public.automation_become(v_owner);
  v_out := case v_subj
    when 'card' then (select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title || ' · ' || x.board)) from (
        select c.id, c.title, b.name as board from public.board_cards c join public.boards b on b.id = c.board_id
         where not c.archived and not b.archived and (v_board is null or c.board_id = v_board)
           and (v_key <> 'service_call_status' or c.card_kind = 'service')
           and public.has_perm('boards', 'view') and public.board_level(c.board_id) >= 1
         order by c.updated_at desc limit 25) x)
    when 'order' then (select jsonb_agg(jsonb_build_object('id', x.id, 'title', 'Order ' || x.order_code || ' – ' || x.cust)) from (
        select o.id, o.order_code, coalesce(nullif(btrim(cu.company), ''), cu.name) as cust
          from public.orders o join public.customers cu on cu.id = o.customer_id
         where not o.archived order by o.created_at desc limit 25) x)
    when 'payment' then case when public.has_perm('payments', 'view') then (select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.t)) from (
        select p2.id, p2.payment_type || ' for order ' || o.order_code || coalesce(' (due ' || to_char(p2.due_date, 'Mon FMDD') || ')', '') as t
          from public.payments p2 join public.orders o on o.id = p2.order_id
         where not o.archived order by p2.due_date desc nulls last limit 25) x) end
    when 'machine' then (select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.t)) from (
        select m.id, mt.name || ' ' || coalesce(m.serial_number, '') || ' · order ' || o.order_code as t
          from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id join public.orders o on o.id = m.order_id
         where not m.archived order by m.checklist_done desc, m.updated_at desc limit 25) x)
    when 'notice' then (select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title)) from (
        select n.id, n.title from public.notices n
         where not n.archived and (public.notice_is_for(n.id, v_owner) or n.author_email = v_owner)
         order by n.created_at desc limit 25) x)
    when 'time_off' then (select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.t)) from (
        select t.id, e.name || ': ' || t.kind || ' ' || to_char(t.start_date, 'Mon FMDD') as t
          from public.time_off_requests t join public.employees e on e.id = t.employee_id
         where public.ts_can_see(t.employee_id) order by t.created_at desc limit 25) x)
    else '[{"id": null, "title": "Now"}]'::jsonb end;
  perform public.automation_restore(v_saved);
  return coalesce(v_out, '[]'::jsonb);
end;
$$;

-- p: {id (saved automation), rule (unsaved changes, optional), subject_id (optional)}
create or replace function public.test_automation(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   text := public.current_user_email();
  v_id   uuid := nullif(p ->> 'id', '')::uuid;
  r      public.automations%rowtype;
  v      jsonb;
  e      public.automation_events%rowtype;
  v_subj text;
  v_sid  uuid := nullif(p ->> 'subject_id', '')::uuid;
  v_list jsonb;
  v_res  jsonb;
  v_prob text[];
begin
  perform public.require_perm('automations', 'view');
  if v_id is not null then
    select * into r from public.automations where id = v_id;
    if not found or public.automation_level(v_id) < 1 then
      raise exception 'That automation could not be found.' using errcode = 'P0002';
    end if;
  else
    r.id := gen_random_uuid();
    r.owner_email := v_me;
    r.scope := 'personal';
  end if;
  if p ? 'rule' then
    if v_id is not null and public.automation_level(v_id) < 2 then
      raise exception 'You may not change this automation.' using errcode = '42501';
    end if;
    v := public.automation_clean(p -> 'rule');
    r.name := coalesce(nullif(v ->> 'name', ''), 'New automation');
    r.trigger_key := v ->> 'trigger_key';
    r.trigger_config := v -> 'trigger_config';
    r.match := v ->> 'match';
    r.conditions := v -> 'conditions';
    r.actions := v -> 'actions';
    r.scope := v ->> 'scope';
    r.board_id := (v ->> 'board_id')::uuid;
    v_prob := public.automation_problems(v);
    if v_id is not null and r.owner_email is distinct from v_me and r.owner_email is not null then
      v_prob := v_prob || public.automation_problems_for(r.owner_email, v);
    end if;
    if cardinality(v_prob) > 0 then
      return jsonb_build_object('status', 'problems', 'problems', to_jsonb(v_prob), 'actions', '[]'::jsonb);
    end if;
  end if;
  if r.owner_email is null then
    raise exception 'This automation has no owner. An administrator can give it to another person.' using errcode = '22023';
  end if;
  select t ->> 'subject' into v_subj from jsonb_array_elements(public.automation_defs() -> 'triggers') t where t ->> 'key' = r.trigger_key;
  if v_subj is null then
    raise exception 'Choose what starts the automation (When).' using errcode = '22023';
  end if;
  if v_subj <> 'none' and v_sid is null then
    v_list := public.automation_test_subjects(jsonb_build_object('id', v_id, 'trigger_key', r.trigger_key, 'scope', r.scope, 'board_id', r.board_id));
    v_sid := nullif(v_list -> 0 ->> 'id', '')::uuid;
    if v_sid is null then
      return jsonb_build_object('status', 'nothing', 'message', 'There is nothing yet that this automation could be tested on.', 'actions', '[]'::jsonb);
    end if;
  end if;
  -- a made-up event as if it had just happened to this card / order / …
  e.trigger_key := r.trigger_key;
  e.subject_type := v_subj;
  e.subject_id := v_sid;
  e.actor_email := v_me;
  e.actor_name := public.current_user_name();
  e.chain := '{}';
  e.data := '{}'::jsonb;
  if v_subj = 'card' then
    select board_id into e.board_id from public.board_cards where id = v_sid;
    if r.trigger_key in ('card_moved', 'service_call_status') then
      e.data := jsonb_build_object('from_stage_id', null,
        'to_stage_id', coalesce((select s.id from public.board_stages s where s.board_id = e.board_id and not s.archived
                                   and lower(s.name) = lower(r.trigger_config ->> 'stage_name') limit 1),
                                (select stage_id from public.board_cards where id = v_sid)));
    elsif r.trigger_key = 'label_added' then
      e.data := jsonb_build_object('label', coalesce(nullif(r.trigger_config ->> 'label', ''),
        (select l.name from public.board_card_labels cl join public.board_labels l on l.id = cl.label_id where cl.card_id = v_sid limit 1)));
    elsif r.trigger_key = 'card_assigned' then
      e.data := jsonb_build_object('assignee', v_me, 'assignee_name', public.current_user_name());
    elsif r.trigger_key = 'checklist_completed' then
      e.data := jsonb_build_object('checklist', coalesce((select title from public.board_checklists where card_id = v_sid limit 1), 'Checklist'));
    end if;
  elsif r.trigger_key = 'order_stage_changed' then
    e.data := jsonb_build_object('from_stage', null,
      'to_stage', coalesce(nullif(r.trigger_config ->> 'stage', ''), (select stage from public.orders where id = v_sid)));
  end if;
  v_res := public.automation_run(r, e, true);
  if v_id is not null then
    perform public.automation_log(r, e, 'test', coalesce(v_res ->> 'message',
      case v_res ->> 'status' when 'not_matched' then 'The conditions are not met, so nothing would happen.' end),
      v_res -> 'actions', coalesce(v_res -> 'ctx', '{}'::jsonb), true);
  end if;
  return jsonb_build_object('status', v_res ->> 'status', 'message', v_res ->> 'message', 'actions', v_res -> 'actions',
                            'conditions', v_res -> 'conditions', 'subject', v_res #>> '{ctx,title}', 'link', v_res #>> '{ctx,link}');
end;
$$;

-- ===========================================================================
-- 10b. Templates (examples to start from; admins can add and archive)
-- ===========================================================================
create or replace function public.save_automation_template(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := public.automation_clean(p);
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_admin_area('automations');
  if nullif(v ->> 'name', '') is null or v ->> 'trigger_key' is null then
    raise exception 'Enter a name and choose what starts the automation.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.automation_templates (name, description, trigger_key, trigger_config, match, conditions, actions, sort_order)
    values (v ->> 'name', v ->> 'description', v ->> 'trigger_key', v -> 'trigger_config', v ->> 'match', v -> 'conditions', v -> 'actions',
            coalesce((select max(sort_order) from public.automation_templates), 0) + 1)
    returning id into v_id;
  else
    update public.automation_templates
       set name = v ->> 'name', description = v ->> 'description', trigger_key = v ->> 'trigger_key', trigger_config = v -> 'trigger_config',
           match = v ->> 'match', conditions = v -> 'conditions', actions = v -> 'actions'
     where id = v_id;
  end if;
  perform public.log_admin_action('automation_templates', v_id::text, null, jsonb_build_object('action', 'automation template saved', 'name', v ->> 'name'));
  return v_id;
end;
$$;

create or replace function public.archive_automation_template(p_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('automations');
  update public.automation_templates set archived = p_archived where id = p_id;
  perform public.log_admin_action('automation_templates', p_id::text, null,
    jsonb_build_object('action', case when p_archived then 'automation template archived' else 'automation template restored' end));
end;
$$;

-- The examples. The office department comes from Admin → Production (never by name).
insert into public.automation_templates (key, name, description, trigger_key, trigger_config, conditions, actions, sort_order) values
  ('last_stage_done', 'Card moved to the last stage: mark complete and add label Done',
   'When a card reaches the last stage of its board, it is marked complete and gets the label Done.',
   'card_moved', '{}', '[{"type": "last_stage", "value": true}]',
   '[{"type": "mark_complete"}, {"type": "add_label", "label": "Done", "colour": "#16a34a"}]', 1),
  ('shipped_close_board', 'Order shipped: close its production board',
   'When an order is shipped, its production board is closed (the app also does this by itself; use the same action for other stages, for example Ready to ship).',
   'order_shipped', '{}', '[]', '[{"type": "close_production_board"}]', 2),
  ('overdue_notify_office', 'Payment overdue: notify the office',
   'When a payment is overdue, the office department gets an email notification.',
   'payment_overdue', '{}', '[]',
   jsonb_build_array(jsonb_build_object('type', 'notify', 'channel', 'email',
     'targets', jsonb_build_array(jsonb_build_object('type', 'department',
       'target', coalesce((select value ->> 'office_department_id' from public.app_settings where key = 'production'),
                          (select id::text from public.departments where not archived order by sort_order limit 1)))),
     'title', 'Payment overdue: {title}', 'message', '{customer}: the {title} was due on {due_date}.')), 3),
  ('checklist_next_stage', 'Checklist completed: move the card to the next stage',
   'When every task of a checklist on a card is complete, the card moves on to the next stage.',
   'checklist_completed', '{}', '[]', '[{"type": "move_card", "stage": "next"}]', 4),
  ('overdue_label', 'Due date passed: add label Overdue and notify the people on the card',
   'When a card''s due date has passed, it gets the label Overdue and the people on the card get a phone notification.',
   'card_overdue', '{}', '[]',
   '[{"type": "add_label", "label": "Overdue", "colour": "#dc2626"}, {"type": "notify", "channel": "push", "targets": [{"type": "assignees"}], "title": "Overdue: {title}", "message": "{title} on {board} was due on {due_date}."}]', 5),
  ('confirmed_card', 'Order confirmed: create a card on a board',
   'When an order is confirmed, a card linked to it is created on a board you choose.',
   'order_confirmed', '{}', '[]',
   '[{"type": "create_card", "title": "Order {order_number} – {customer}", "link": true}]', 6),
  ('monday_reminder', 'Every Monday at 8:00: remind me',
   'A weekly in-app reminder to yourself.',
   'schedule', '{"frequency": "weekly", "days": [1], "time": "08:00"}', '[]',
   '[{"type": "notify", "channel": "app", "targets": [{"type": "owner"}], "title": "Weekly reminder", "message": "Review the boards for this week."}]', 7),
  ('time_off_calendar', 'Time off approved: put it on the Calendar',
   'When time off is approved, the days are added to that person''s Calendar (shared with you).',
   'time_off_approved', '{}', '[]',
   '[{"type": "add_calendar_entry", "tech": "person", "when": "subject", "kind": "other", "title": "{person_name}: time off"}]', 8),
  ('final_check_notify', 'Final check signed: notify the owner',
   'When a final check is signed, you get an in-app notification.',
   'final_check_signed', '{}', '[]',
   '[{"type": "notify", "channel": "app", "targets": [{"type": "owner"}], "title": "Final check signed: {title}", "message": "Order {order_number} – {customer}."}]', 9)
on conflict (key) do nothing;

-- ===========================================================================
-- 9c. The minute job (Admin → Automations → Turn On Scheduled Automations)
-- ===========================================================================
create or replace function public.automation_schedule_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb := jsonb_build_object('cron', false, 'running', false);
begin
  perform public.require_admin_area('automations');
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select jsonb_build_object('cron', true, 'running', exists (select 1 from cron.job where jobname = 'automations'),
                 'last_run', (select max(d.start_time) from cron.job_run_details d join cron.job j on j.jobid = d.jobid where j.jobname = 'automations'))$q$
      into v;
  end if;
  return v || jsonb_build_object('settings', public.automation_settings(),
    'owner_removed', (select count(*) from public.automations where paused_reason = 'owner_removed' and not archived));
end;
$$;

create or replace function public.start_automation_schedule()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('automations');
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'Turn on the pg_cron extension first (Supabase → Database → Extensions).' using errcode = '55000';
  end if;
  execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'automations'$q$;
  execute $q$select cron.schedule('automations', '* * * * *', 'select public.automations_tick()')$q$;
  perform public.log_admin_action('app_settings', 'automations', null, jsonb_build_object('action', 'scheduled automations turned on'));
end;
$$;

create or replace function public.stop_automation_schedule()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('automations');
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'automations'$q$;
  end if;
  perform public.log_admin_action('app_settings', 'automations', null, jsonb_build_object('action', 'scheduled automations turned off'));
end;
$$;

-- Start it now when pg_cron is on.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'automations'$q$;
    execute $q$select cron.schedule('automations', '* * * * *', 'select public.automations_tick()')$q$;
  end if;
end;
$$;

-- The admin pages (Admin → Automations) are opened with admin.automations.
create policy "Automation admins can change settings" on public.app_settings for all to authenticated
  using (key = 'automations' and (select public.can_admin('automations')))
  with check (key = 'automations' and (select public.can_admin('automations')));

-- ===========================================================================
-- 11. Access lockdown
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
