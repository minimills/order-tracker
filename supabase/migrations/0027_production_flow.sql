-- 0027_production_flow.sql
-- The production flow, built on the boards system (0023).
--
-- Two locations: Fabrication at location 1; sandblasting, powder coating,
-- assembly, the office and shipping at location 2. "Ready for pick up" =
-- parts waiting to be taken from location 1 to location 2.
--
-- 1. Build checklists (Admin → Build checklists): per machine type and step
--    (Fabrication, Sandblasting, Powder coating, Assembly) the parts and tasks.
-- 2. The default production stages (Admin → Production), each with a
--    department and a step; settings in app_settings key "production".
-- 3. One production board per order, made automatically when the order joins
--    the shop queue (Confirmed or later); one "machine" card per machine.
-- 4. Machine cards: deadline of the current stage (from 0022), the stage's build
--    checklist, stage start / finish times (filled in automatically when the
--    card enters / leaves a stage if nobody pressed Start / Finish), Crating
--    skipped for machines that are not crated.
-- 5. Leftover items: moving a machine card on with unfinished items splits them
--    into a "Leftover: …" card in the old stage; they merge back (as done) when
--    all are done or the leftover card catches up with its machine.
-- 6. Real step times feed machine_steps (build-time averages, department delays).
-- 7. Report views (Reports → Build times).

-- ===========================================================================
-- 0. Small helper: run as "the system" (passes the board guards), restoring
--    the previous value afterwards.
-- ===========================================================================
create or replace function public.system_on()
returns text
language sql
as $$
  select set_config('app.system_change', 'on', true);
$$;

-- ===========================================================================
-- 1. Build checklists
-- ===========================================================================
create table public.build_checklist_items (
  id              uuid primary key default gen_random_uuid(),
  machine_type_id uuid not null references public.machine_types (id) on delete cascade,
  step            text not null check (step in ('fabrication', 'sandblasting', 'powder_coating', 'assembly')),
  section         text not null default 'General' check (btrim(section) <> ''),
  item_text       text not null check (btrim(item_text) <> ''),
  sort_order      integer not null default 0,
  archived        boolean not null default false,
  archived_at     timestamptz,
  archived_by     text,
  created_at      timestamptz not null default now()
);
create index build_checklist_items_type_idx on public.build_checklist_items (machine_type_id, step, sort_order);
create trigger build_checklist_items_archived before insert or update of archived on public.build_checklist_items
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.build_checklist_items
  for each row execute function public.log_activity();
alter table public.build_checklist_items enable row level security;
create policy "Allowed users can read" on public.build_checklist_items
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Build checklist editors" on public.build_checklist_items
  for all to authenticated
  using ((select public.can_admin('build_checklists'))) with check ((select public.can_admin('build_checklists')));

-- p_ids = the items of one list (type + step) in their new order.
create or replace function public.reorder_build_checklist(p_ids uuid[])
returns void
language plpgsql
as $$
begin
  perform public.require_admin_area('build_checklists');
  update public.build_checklist_items b set sort_order = x.pos * 10
    from unnest(p_ids) with ordinality as x(id, pos)
   where b.id = x.id;
end;
$$;

-- ===========================================================================
-- 2. Default production stages and settings
-- ===========================================================================
create table public.production_stage_template (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (btrim(name) <> ''),
  -- What the stage means for the app (deadline, build checklist, step times).
  step          text not null default 'other'
                check (step in ('fabrication', 'pickup', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating', 'shipping', 'other')),
  department_id uuid references public.departments (id) on delete set null,
  sort_order    integer not null default 0,
  archived      boolean not null default false,
  archived_at   timestamptz,
  archived_by   text,
  created_at    timestamptz not null default now()
);
create trigger production_stage_template_archived before insert or update of archived on public.production_stage_template
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.production_stage_template
  for each row execute function public.log_activity();
alter table public.production_stage_template enable row level security;
create policy "Allowed users can read" on public.production_stage_template
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Production admins" on public.production_stage_template
  for all to authenticated
  using ((select public.can_admin('production'))) with check ((select public.can_admin('production')));

-- Seed: departments are matched by name once, here; afterwards everything is by id.
insert into public.production_stage_template (name, step, department_id, sort_order)
select v.name, v.step, (select d.id from public.departments d where d.name ilike v.dept and not d.archived order by d.sort_order limit 1), v.ord
  from (values
    ('Fabrication shop',  'fabrication',    'Fabrication%',  1),
    ('Ready for pick up', 'pickup',         'Sandblasting%', 2),
    ('Sandblasting',      'sandblasting',   'Sandblasting%', 3),
    ('Powder coating',    'powder_coating', 'Sandblasting%', 4),
    ('Assembly shop',     'assembly',       'Assembly%',     5),
    ('Final check',       'final_check',    'Assembly%',     6),
    ('Crating',           'crating',        'Shipping%',     7),
    ('Shipping',          'shipping',       'Shipping%',     8)
  ) as v(name, step, dept, ord);

insert into public.app_settings (key, value)
select 'production', jsonb_build_object(
  'office_department_id', (select d.id from public.departments d where d.name ilike 'Office%' and not d.archived order by d.sort_order limit 1),
  'colour', '#0f766e',
  'share_level', 'edit')
on conflict (key) do nothing;

drop policy "Admins can change" on public.app_settings;
create policy "Admins can change" on public.app_settings
  for all to authenticated
  using ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company')))
         or (key = 'stage_labels' and (select public.can_admin('stages')))
         or (key = 'order_defaults' and (select public.can_admin('order_defaults')))
         or (key = 'scheduling' and (select public.can_admin('scheduling')))
         or (key = 'email' and (select public.can_admin('email')))
         or (key = 'production' and (select public.can_admin('production'))))
  with check ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company')))
         or (key = 'stage_labels' and (select public.can_admin('stages')))
         or (key = 'order_defaults' and (select public.can_admin('order_defaults')))
         or (key = 'scheduling' and (select public.can_admin('scheduling')))
         or (key = 'email' and (select public.can_admin('email')))
         or (key = 'production' and (select public.can_admin('production'))));

-- ===========================================================================
-- 3. Board columns for production
-- ===========================================================================
alter table public.boards add column order_id uuid references public.orders (id) on delete cascade;
create unique index boards_production_order_idx on public.boards (order_id) where purpose = 'production';

alter table public.board_stages
  add column step text check (step in ('fabrication', 'pickup', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating', 'shipping', 'other')),
  add column department_id uuid references public.departments (id) on delete set null;

alter table public.board_cards
  add column card_kind text not null default 'task' check (card_kind in ('task', 'machine', 'leftover')),
  add column leftover_of uuid references public.board_cards (id) on delete cascade;
create index board_cards_machine_idx on public.board_cards (machine_id) where card_kind = 'machine';
create index board_cards_leftover_idx on public.board_cards (leftover_of) where leftover_of is not null;

alter table public.board_checklists
  add column stage_id uuid references public.board_stages (id) on delete set null,
  -- Leftover checklists: the machine card's checklist the items go back to.
  add column merge_into uuid references public.board_checklists (id) on delete set null;

alter table public.board_checklist_items
  add column template_item_id uuid references public.build_checklist_items (id) on delete set null;

alter table public.machine_steps add column started_on date;

-- Stage start / finish per card and stage visit.
create table public.board_card_stage_times (
  id              uuid primary key default gen_random_uuid(),
  card_id         uuid not null references public.board_cards (id) on delete cascade,
  board_id        uuid not null references public.boards (id) on delete cascade,
  stage_id        uuid references public.board_stages (id) on delete set null,
  stage_name      text not null,
  step            text,
  machine_id      uuid references public.order_machines (id) on delete set null,
  entered_at      timestamptz not null default now(),
  left_at         timestamptz,
  started_at      timestamptz,
  started_by_name text,
  finished_at     timestamptz,
  finished_by_name text,
  auto_started    boolean not null default false,
  auto_finished   boolean not null default false
);
create index board_card_stage_times_card_idx on public.board_card_stage_times (card_id, entered_at);
create index board_card_stage_times_step_idx on public.board_card_stage_times (step, finished_at);
alter table public.board_card_stage_times enable row level security;
create policy "Board readers" on public.board_card_stage_times
  for select to authenticated
  using ((select public.board_can(board_id, 'view')) and (select public.has_perm('production.stage_times', 'view')));
-- Written only by the triggers below.

-- ===========================================================================
-- 4. Guards: the system (these triggers) may change anything; people may not
--    change what kind a card is. (Copies of 0023 with the system pass added.)
-- ===========================================================================
create or replace function public.board_cards_guard()
returns trigger
language plpgsql
as $$
declare
  v_me   text := public.current_user_email();
  v_name text := public.current_user_name();
begin
  if not exists (select 1 from public.board_stages s where s.id = new.stage_id and s.board_id = new.board_id) then
    raise exception 'That stage is not on this board.' using errcode = '22023';
  end if;
  if public.is_system_change() then
    if tg_op = 'INSERT' and new.sort_order = 0 then
      new.sort_order := coalesce((select max(sort_order) from public.board_cards
                                   where stage_id = new.stage_id and not archived), 0) + 1;
    end if;
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.card_kind := 'task';
    new.leftover_of := null;
    new.created_by := v_me;
    new.created_by_name := v_name;
    new.started_by := null; new.started_by_name := null;
    new.finished_by := null; new.finished_by_name := null;
    if new.started_at is not null then new.started_at := now(); new.started_by := v_me; new.started_by_name := v_name; end if;
    if new.finished_at is not null then new.finished_at := null; end if;
    if new.sort_order = 0 then
      new.sort_order := coalesce((select max(sort_order) from public.board_cards
                                   where stage_id = new.stage_id and not archived), 0) + 1;
    end if;
    if (new.order_id is not null or new.customer_id is not null or new.machine_id is not null) then
      perform public.require_perm('boards.card.link');
    end if;
    return new;
  end if;

  if new.board_id <> old.board_id then
    raise exception 'A card cannot move to another board.' using errcode = '22023';
  end if;
  if new.card_kind is distinct from old.card_kind or new.leftover_of is distinct from old.leftover_of then
    raise exception 'The kind of a card cannot be changed.' using errcode = '42501';
  end if;
  if old.card_kind = 'machine' and new.machine_id is distinct from old.machine_id then
    raise exception 'A machine card stays linked to its machine.' using errcode = '42501';
  end if;
  if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or new.created_by_name is distinct from old.created_by_name then
    raise exception 'Who made a card cannot be changed.' using errcode = '42501';
  end if;
  if new.stage_id is distinct from old.stage_id or new.sort_order is distinct from old.sort_order then
    perform public.require_perm('boards.card.move');
  end if;
  if new.title is distinct from old.title or new.description is distinct from old.description
     or new.due_date is distinct from old.due_date then
    perform public.require_perm('boards.card.edit');
  end if;
  if new.order_id is distinct from old.order_id or new.customer_id is distinct from old.customer_id
     or new.machine_id is distinct from old.machine_id then
    perform public.require_perm('boards.card.link');
  end if;
  if new.archived is distinct from old.archived then
    perform public.require_perm('boards.card.archive');
  end if;
  -- Start / Finish: stamped here, never taken from the app.
  if new.started_at is distinct from old.started_at or new.finished_at is distinct from old.finished_at then
    perform public.require_perm('boards.card.timing');
  end if;
  if new.started_at is distinct from old.started_at then
    if new.started_at is null then
      new.started_by := null; new.started_by_name := null;
    else
      new.started_at := now(); new.started_by := v_me; new.started_by_name := v_name;
    end if;
  else
    new.started_by := old.started_by; new.started_by_name := old.started_by_name;
  end if;
  if new.finished_at is distinct from old.finished_at then
    if new.finished_at is null then
      new.finished_by := null; new.finished_by_name := null;
    else
      new.finished_at := now(); new.finished_by := v_me; new.finished_by_name := v_name;
      if new.started_at is null then
        raise exception 'Press Start before Finish (so the time can be measured).' using errcode = '22023';
      end if;
    end if;
  else
    new.finished_by := old.finished_by; new.finished_by_name := old.finished_by_name;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.board_items_guard()
returns trigger
language plpgsql
as $$
declare
  v_me   text := public.current_user_email();
  v_name text := public.current_user_name();
begin
  if public.is_system_change() then
    if tg_op = 'INSERT' and new.sort_order = 0 then
      new.sort_order := coalesce((select max(sort_order) from public.board_checklist_items
                                   where checklist_id = new.checklist_id), 0) + 1;
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.template_item_id := null;
    new.started_by := null; new.started_by_name := null; new.started_at := null;
    new.finished_by := null; new.finished_by_name := null; new.finished_at := null;
    if new.sort_order = 0 then
      new.sort_order := coalesce((select max(sort_order) from public.board_checklist_items
                                   where checklist_id = new.checklist_id), 0) + 1;
    end if;
    return new;
  end if;
  if new.checklist_id <> old.checklist_id then
    raise exception 'A task cannot move to another checklist.' using errcode = '22023';
  end if;
  if new.template_item_id is distinct from old.template_item_id then
    raise exception 'The build checklist link of a task cannot be changed.' using errcode = '42501';
  end if;
  if new.item_text is distinct from old.item_text or new.sort_order is distinct from old.sort_order then
    perform public.require_perm('boards.card.checklists');
  end if;
  if new.started_at is distinct from old.started_at then
    perform public.require_perm('boards.card.timing');
    if new.started_at is null then new.started_by := null; new.started_by_name := null;
    else new.started_at := now(); new.started_by := v_me; new.started_by_name := v_name; end if;
  else
    new.started_by := old.started_by; new.started_by_name := old.started_by_name;
  end if;
  if new.finished_at is distinct from old.finished_at then
    -- Marking a task complete = Finish (checklists); Finish after Start = timing.
    perform public.require_any_perm(array['boards.card.checklists', 'boards.card.timing']);
    if new.finished_at is null then new.finished_by := null; new.finished_by_name := null;
    else new.finished_at := now(); new.finished_by := v_me; new.finished_by_name := v_name; end if;
  else
    new.finished_by := old.finished_by; new.finished_by_name := old.finished_by_name;
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 5. Production helpers
-- ===========================================================================
-- The deadline of a machine for a stage step (0022 deadlines; ship date for Shipping;
-- "Ready for pick up" = the Fabrication deadline).
create or replace function public.production_due_date(p_machine uuid, p_step text)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_step in ('fabrication', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating') then
      (select due_on from public.order_deadlines where machine_id = p_machine and step = p_step)
    when p_step = 'pickup' then
      (select due_on from public.order_deadlines where machine_id = p_machine and step = 'fabrication')
    when p_step = 'shipping' then
      (select o.expected_ship_date from public.order_machines m join public.orders o on o.id = m.order_id where m.id = p_machine)
  end;
$$;

-- "Carder - Large LCR-2072"
create or replace function public.production_machine_label(p_machine uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(t.name, 'Machine') || ' ' || coalesce(m.serial_number, '(no serial yet)')
    from public.order_machines m left join public.machine_types t on t.id = m.machine_type_id
   where m.id = p_machine;
$$;

-- Where a machine card starts: after the last step the machine has already done.
create or replace function public.production_start_stage(p_board uuid, p_machine uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  with m as (
    select om.ready, om.checklist_done, om.needs_crate,
           coalesce((select crate_count from public.machine_crating c where c.machine_id = om.id), 0) as crates,
           (select max(array_position(array['fabrication', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating'], s.step))
              from public.machine_steps s where s.machine_id = om.id) as last_step
      from public.order_machines om where om.id = p_machine
  ),
  target as (
    select case
      when m.crates > 0 then 'shipping'
      when m.checklist_done then case when m.needs_crate then 'crating' else 'shipping' end
      when m.ready then 'final_check'
      when m.last_step is not null then
        (array['pickup', 'powder_coating', 'assembly', 'final_check', 'crating', 'shipping'])[m.last_step]
      else null
    end as step
      from m
  )
  select coalesce(
    (select s.id from public.board_stages s, target t where s.board_id = p_board and not s.archived and s.step = t.step order by s.sort_order limit 1),
    (select s.id from public.board_stages s where s.board_id = p_board and not s.archived order by s.sort_order limit 1));
$$;

-- A card arrives in a stage: stage time row and, for a build step, the build checklist.
create or replace function public.production_card_entered(p_card uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card  public.board_cards;
  v_stage public.board_stages;
  v_type  uuid;
  v_list  uuid;
  v_prev  text := coalesce(current_setting('app.system_change', true), '');
begin
  select * into v_card from public.board_cards where id = p_card;
  select * into v_stage from public.board_stages where id = v_card.stage_id;
  insert into public.board_card_stage_times (card_id, board_id, stage_id, stage_name, step, machine_id)
  values (v_card.id, v_card.board_id, v_stage.id, v_stage.name, v_stage.step, v_card.machine_id);
  if v_stage.step in ('fabrication', 'sandblasting', 'powder_coating', 'assembly')
     and not exists (select 1 from public.board_checklists where card_id = v_card.id and stage_id = v_stage.id) then
    select machine_type_id into v_type from public.order_machines where id = v_card.machine_id;
    if exists (select 1 from public.build_checklist_items where machine_type_id = v_type and step = v_stage.step and not archived) then
      perform public.system_on();
      insert into public.board_checklists (card_id, title, stage_id, sort_order)
      values (v_card.id, v_stage.name || ' checklist', v_stage.id,
              coalesce((select max(sort_order) from public.board_checklists where card_id = v_card.id), 0) + 1)
      returning id into v_list;
      insert into public.board_checklist_items (checklist_id, item_text, sort_order, template_item_id)
      select v_list, case when b.section <> 'General' then b.section || ': ' || b.item_text else b.item_text end,
             row_number() over (order by b.sort_order, b.created_at), b.id
        from public.build_checklist_items b
       where b.machine_type_id = v_type and b.step = v_stage.step and not b.archived;
      perform set_config('app.system_change', v_prev, true);
    end if;
  end if;
end;
$$;

-- Unfinished items of a stage's checklists go to a "Leftover" card in that stage.
create or replace function public.production_split_leftovers(p_card uuid, p_stage uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card     public.board_cards;
  v_stage    public.board_stages;
  v_list     public.board_checklists;
  v_left     uuid;
  v_new_list uuid;
  v_count    integer;
  v_total    integer := 0;
  v_prev     text := coalesce(current_setting('app.system_change', true), '');
begin
  select * into v_card from public.board_cards where id = p_card;
  select * into v_stage from public.board_stages where id = p_stage;
  perform public.system_on();
  for v_list in select * from public.board_checklists where card_id = p_card and stage_id = p_stage order by sort_order loop
    select count(*) into v_count from public.board_checklist_items where checklist_id = v_list.id and finished_at is null;
    continue when v_count = 0;
    if v_left is null then
      select id into v_left from public.board_cards
       where leftover_of = p_card and stage_id = p_stage and card_kind = 'leftover' and not archived limit 1;
      if v_left is null then
        insert into public.board_cards (board_id, stage_id, title, card_kind, leftover_of, machine_id, order_id, due_date, created_by, created_by_name)
        values (v_card.board_id, p_stage, 'Leftover: ' || v_card.title || ' – ' || v_stage.name, 'leftover', p_card,
                v_card.machine_id, v_card.order_id, public.production_due_date(v_card.machine_id, v_stage.step),
                public.current_user_email(), public.current_user_name())
        returning id into v_left;
        perform public.board_event(v_left, 'leftover_created', jsonb_build_object('machine', v_card.title, 'stage', v_stage.name));
      end if;
    end if;
    insert into public.board_checklists (card_id, title, stage_id, merge_into, sort_order)
    values (v_left, v_list.title, p_stage, v_list.id, v_list.sort_order)
    returning id into v_new_list;
    update public.board_checklist_items set checklist_id = v_new_list where checklist_id = v_list.id and finished_at is null;
    v_total := v_total + v_count;
  end loop;
  if v_left is not null then
    perform public.board_event(p_card, 'leftover_split', jsonb_build_object('stage', v_stage.name, 'count', v_total));
  end if;
  perform set_config('app.system_change', v_prev, true);
end;
$$;

-- Leftover items go back to their machine card, marked done; the leftover card is archived.
create or replace function public.production_merge_leftover(p_leftover uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left    public.board_cards;
  v_list    public.board_checklists;
  v_target  uuid;
  v_count   integer := 0;
  v_n       integer;
  v_prev    text := coalesce(current_setting('app.system_change', true), '');
begin
  select * into v_left from public.board_cards where id = p_leftover;
  if v_left.id is null or v_left.card_kind <> 'leftover' or v_left.archived then return; end if;
  perform set_config('app.production_merging', 'on', true);
  perform public.system_on();
  for v_list in select * from public.board_checklists where card_id = p_leftover loop
    v_target := v_list.merge_into;
    if v_target is null or not exists (select 1 from public.board_checklists where id = v_target) then
      insert into public.board_checklists (card_id, title, stage_id)
      values (v_left.leftover_of, v_list.title, v_list.stage_id) returning id into v_target;
    end if;
    update public.board_checklist_items
       set finished_at = coalesce(finished_at, now()),
           finished_by_name = coalesce(finished_by_name, public.current_user_name()),
           checklist_id = v_target
     where checklist_id = v_list.id;
    get diagnostics v_n = row_count;
    v_count := v_count + v_n;
    delete from public.board_checklists where id = v_list.id;
  end loop;
  update public.board_cards set archived = true where id = p_leftover;
  perform public.board_event(v_left.leftover_of, 'leftover_merged', jsonb_build_object('count', v_count, 'reason', p_reason, 'title', v_left.title));
  perform public.board_event(p_leftover, 'leftover_merged', jsonb_build_object('count', v_count, 'reason', p_reason, 'title', v_left.title));
  perform set_config('app.system_change', v_prev, true);
  perform set_config('app.production_merging', 'off', true);
end;
$$;

-- ===========================================================================
-- 6. Card triggers for production boards
-- ===========================================================================
-- BEFORE (runs after board_cards_guard: names sort alphabetically): Crating
-- skipped when not crated, deadline of the new stage, Start / Finish reset.
create or replace function public.board_cards_zz_production()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stage public.board_stages;
  v_next  uuid;
begin
  if new.card_kind <> 'machine' then return new; end if;
  if tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id then return new; end if;
  select * into v_stage from public.board_stages where id = new.stage_id;
  if v_stage.step = 'crating'
     and not coalesce((select needs_crate from public.order_machines where id = new.machine_id), true) then
    select id into v_next from public.board_stages
     where board_id = new.board_id and not archived and sort_order > v_stage.sort_order
     order by sort_order limit 1;
    if v_next is not null then
      new.stage_id := v_next;
      select * into v_stage from public.board_stages where id = v_next;
    end if;
  end if;
  new.due_date := public.production_due_date(new.machine_id, v_stage.step);
  if tg_op = 'UPDATE' then
    new.started_at := null; new.started_by := null; new.started_by_name := null;
    new.finished_at := null; new.finished_by := null; new.finished_by_name := null;
  end if;
  return new;
end;
$$;
create trigger board_cards_zz_production before insert or update on public.board_cards
  for each row execute function public.board_cards_zz_production();

-- AFTER: stage times, step results, leftovers, build checklist of the new stage.
create or replace function public.board_cards_zz_production_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old   public.board_stages;
  v_new   public.board_stages;
  v_mach  public.board_cards;
  v_start timestamptz;
  v_end   timestamptz := now();
begin
  if new.card_kind = 'machine' then
    if tg_op = 'INSERT' then
      perform public.production_card_entered(new.id);
      return null;
    end if;
    if new.stage_id is distinct from old.stage_id then
      select * into v_old from public.board_stages where id = old.stage_id;
      select * into v_new from public.board_stages where id = new.stage_id;
      -- Close the old stage: missing start = when it arrived; missing finish = now.
      select coalesce(old.started_at, entered_at) into v_start
        from public.board_card_stage_times where card_id = new.id and left_at is null order by entered_at desc limit 1;
      update public.board_card_stage_times
         set left_at = v_end,
             started_at = coalesce(old.started_at, entered_at),
             started_by_name = coalesce(old.started_by_name, started_by_name),
             auto_started = old.started_at is null,
             finished_at = coalesce(old.finished_at, v_end),
             finished_by_name = coalesce(old.finished_by_name, finished_by_name),
             auto_finished = old.finished_at is null
       where card_id = new.id and left_at is null;
      if v_new.sort_order > v_old.sort_order then
        -- Real step times for averages and department delays.
        if v_old.step in ('fabrication', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating') then
          insert into public.machine_steps (machine_id, step, done_on, started_on)
          values (new.machine_id, v_old.step, (coalesce(old.finished_at, v_end) at time zone 'America/Halifax')::date,
                  (coalesce(v_start, v_end) at time zone 'America/Halifax')::date)
          on conflict (machine_id, step) do update set done_on = excluded.done_on, started_on = excluded.started_on;
        end if;
        perform public.production_split_leftovers(new.id, old.stage_id);
      end if;
      perform public.production_card_entered(new.id);
      perform public.board_event(new.id, 'stage_time', jsonb_build_object('stage', v_old.name,
        'auto_started', old.started_at is null, 'auto_finished', old.finished_at is null));
    elsif new.started_at is distinct from old.started_at or new.finished_at is distinct from old.finished_at then
      -- Start / Finish pressed in the current stage.
      update public.board_card_stage_times
         set started_at = new.started_at, started_by_name = new.started_by_name,
             finished_at = new.finished_at, finished_by_name = new.finished_by_name,
             auto_started = false, auto_finished = false
       where card_id = new.id and left_at is null;
    end if;
    return null;
  end if;

  if new.card_kind = 'leftover' and tg_op = 'UPDATE' and new.stage_id is distinct from old.stage_id and not new.archived then
    -- Dragged forward to its machine's stage or beyond: merge back.
    select * into v_mach from public.board_cards where id = new.leftover_of;
    if (select sort_order from public.board_stages where id = new.stage_id)
       >= (select sort_order from public.board_stages where id = v_mach.stage_id) then
      perform public.production_merge_leftover(new.id, 'moved to its machine''s stage');
    end if;
  end if;
  return null;
end;
$$;
create trigger board_cards_zz_production_after after insert or update on public.board_cards
  for each row execute function public.board_cards_zz_production_after();

-- All leftover items done: merge back.
create or replace function public.board_items_leftover_done()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid;
begin
  if coalesce(current_setting('app.production_merging', true), '') = 'on' then return null; end if;
  if new.finished_at is null or old.finished_at is not null then return null; end if;
  select l.card_id into v_card from public.board_checklists l join public.board_cards c on c.id = l.card_id
   where l.id = new.checklist_id and c.card_kind = 'leftover' and not c.archived;
  if v_card is null then return null; end if;
  if not exists (select 1 from public.board_checklist_items i join public.board_checklists l on l.id = i.checklist_id
                  where l.card_id = v_card and i.finished_at is null) then
    perform public.production_merge_leftover(v_card, 'all leftover items done');
  end if;
  return null;
end;
$$;
create trigger board_items_leftover_done after update of finished_at on public.board_checklist_items
  for each row execute function public.board_items_leftover_done();

-- ===========================================================================
-- 7. Making production boards
-- ===========================================================================
create or replace function public.create_production_board(p_order uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board    uuid;
  v_order    record;
  v_settings jsonb := coalesce((select value from public.app_settings where key = 'production'), '{}'::jsonb);
  v_office   text := v_settings ->> 'office_department_id';
  v_level    text := coalesce(v_settings ->> 'share_level', 'edit');
  v_machine  record;
  v_prev     text := coalesce(current_setting('app.system_change', true), '');
begin
  if not public.is_system_change() and not public.is_service_caller() then
    perform public.require_perm('production.create_board');
  end if;
  select id into v_board from public.boards where order_id = p_order and purpose = 'production';
  if v_board is not null then return v_board; end if;
  select o.id, o.order_code, c.name as customer into v_order
    from public.orders o left join public.customers c on c.id = o.customer_id where o.id = p_order;
  if v_order.id is null then
    raise exception 'That order was not found.' using errcode = 'P0002';
  end if;
  perform public.system_on();
  insert into public.boards (name, description, colour, owner_email, purpose, order_id, created_by)
  values ('Order ' || v_order.order_code || coalesce(' · ' || v_order.customer, ''),
          'Production board for order ' || v_order.order_code || '.',
          coalesce(v_settings ->> 'colour', '#0f766e'), null, 'production', p_order, coalesce(public.current_user_email(), 'automatic'))
  returning id into v_board;
  insert into public.board_stages (board_id, name, sort_order, step, department_id)
  select v_board, t.name, row_number() over (order by t.sort_order, t.created_at), t.step, t.department_id
    from public.production_stage_template t where not t.archived;
  -- Shared with every department that has a stage; the office manages the board.
  insert into public.board_shares (board_id, share_type, target, level, created_by)
  select distinct v_board, 'department', d::text, v_level, 'automatic'
    from (select department_id as d from public.board_stages where board_id = v_board and department_id is not null) x
   where d::text is distinct from v_office
  on conflict do nothing;
  if v_office is not null and exists (select 1 from public.departments where id::text = v_office) then
    insert into public.board_shares (board_id, share_type, target, level, created_by)
    values (v_board, 'department', v_office, 'manage', 'automatic') on conflict do nothing;
  end if;
  -- Default notifications: the department of a stage when a card arrives there;
  -- the office when a deadline is missed; the people on a card.
  insert into public.board_notify_rules (board_id, event, stage_id, target_type, target, created_by)
  select v_board, 'card_moved', s.id, 'department', s.department_id::text, 'automatic'
    from public.board_stages s where s.board_id = v_board and s.department_id is not null;
  if v_office is not null then
    insert into public.board_notify_rules (board_id, event, target_type, target, created_by)
    values (v_board, 'overdue', 'department', v_office, 'automatic');
  end if;
  insert into public.board_notify_rules (board_id, event, target_type, created_by)
  values (v_board, 'assigned', 'assignees', 'automatic'), (v_board, 'comment', 'assignees', 'automatic');
  -- One card per machine.
  for v_machine in
    select id, order_id from public.order_machines where order_id = p_order and not archived order by serial_number nulls last, created_at
  loop
    insert into public.board_cards (board_id, stage_id, title, card_kind, machine_id, order_id, created_by, created_by_name)
    values (v_board, public.production_start_stage(v_board, v_machine.id), public.production_machine_label(v_machine.id),
            'machine', v_machine.id, p_order, 'automatic', 'Automatic');
  end loop;
  perform set_config('app.system_change', v_prev, true);
  return v_board;
end;
$$;

-- Orders joining the shop queue get their production board.
create or replace function public.orders_production_board()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('app.system_change', true), '');
begin
  if public.is_board_stage(new.stage) and not new.archived
     and not exists (select 1 from public.boards where order_id = new.id and purpose = 'production') then
    perform public.system_on();
    perform public.create_production_board(new.id);
    perform set_config('app.system_change', v_prev, true);
  end if;
  -- New ship date: Shipping deadlines on the machine cards follow.
  if tg_op = 'UPDATE' and new.expected_ship_date is distinct from old.expected_ship_date then
    perform public.production_refresh_due(new.id, null);
  end if;
  return null;
end;
$$;

-- Machine cards follow deadline and ship date changes.
create or replace function public.production_refresh_due(p_order uuid, p_machine uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('app.system_change', true), '');
begin
  perform public.system_on();
  update public.board_cards c
     set due_date = public.production_due_date(c.machine_id, s.step)
    from public.board_stages s
   where s.id = c.stage_id and c.card_kind = 'machine' and not c.archived
     and (p_machine is null or c.machine_id = p_machine)
     and (p_order is null or c.order_id = p_order)
     and c.due_date is distinct from public.production_due_date(c.machine_id, s.step);
  perform set_config('app.system_change', v_prev, true);
end;
$$;

create trigger orders_production_board after insert or update of stage, archived, expected_ship_date on public.orders
  for each row execute function public.orders_production_board();

create or replace function public.order_deadlines_production()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.production_refresh_due(null, coalesce(new.machine_id, old.machine_id));
  return null;
end;
$$;
create trigger order_deadlines_production after insert or update or delete on public.order_deadlines
  for each row execute function public.order_deadlines_production();

-- Machines added to / removed from an order, or given a new serial.
create or replace function public.order_machines_production()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board uuid;
  v_prev  text := coalesce(current_setting('app.system_change', true), '');
begin
  select id into v_board from public.boards where order_id = new.order_id and purpose = 'production';
  if v_board is null then return null; end if;
  perform public.system_on();
  if tg_op = 'INSERT' and not new.archived then
    insert into public.board_cards (board_id, stage_id, title, card_kind, machine_id, order_id, created_by, created_by_name)
    values (v_board, public.production_start_stage(v_board, new.id), public.production_machine_label(new.id),
            'machine', new.id, new.order_id, 'automatic', 'Automatic');
  elsif tg_op = 'UPDATE' then
    if new.archived and not old.archived then
      update public.board_cards set archived = true where machine_id = new.id and not archived;
    elsif new.serial_number is distinct from old.serial_number or new.machine_type_id is distinct from old.machine_type_id then
      update public.board_cards set title = public.production_machine_label(new.id) where machine_id = new.id and card_kind = 'machine';
    end if;
  end if;
  perform set_config('app.system_change', v_prev, true);
  return null;
end;
$$;
create trigger order_machines_production after insert or update of archived, serial_number, machine_type_id on public.order_machines
  for each row execute function public.order_machines_production();

-- ===========================================================================
-- 8. Build-time averages use the real start of a step when it is known
-- ===========================================================================
create or replace view public.machine_type_step_stats
with (security_invoker = true)
as
with ordered as (
  select ms.machine_id, ms.step, ms.done_on, ms.started_on, om.machine_type_id, o.production_started_on,
         lag(ms.done_on) over (
           partition by ms.machine_id
           order by array_position(array['fabrication', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating'], ms.step)
         ) as previous_done
    from public.machine_steps ms
    join public.order_machines om on om.id = ms.machine_id
    join public.orders o on o.id = om.order_id
),
durations as (
  select machine_type_id, step, done_on,
         case when started_on is not null then greatest(public.working_days_between(started_on - 1, done_on), 1)
              when previous_done is not null then public.working_days_between(previous_done, done_on)
              when production_started_on is not null then public.working_days_between(production_started_on - 1, done_on)
         end as days
    from ordered
),
latest as (
  select *, row_number() over (partition by machine_type_id, step order by done_on desc) as rn
    from durations
   where days is not null and days > 0
)
select machine_type_id, step, count(*)::integer as builds, round(avg(days)::numeric, 1) as avg_days
  from latest
 where rn <= 5
 group by machine_type_id, step;

-- ===========================================================================
-- 9. Report views (Reports → Build times), only for people with the report
-- ===========================================================================
create view public.production_step_times
with (security_invoker = false)
as
select t.id, t.step, t.stage_name, m.machine_type_id, mt.name as machine_type, m.serial_number, o.order_code,
       t.started_at, t.finished_at, t.auto_started, t.auto_finished,
       extract(epoch from (t.finished_at - t.started_at))::bigint as seconds,
       public.working_days_between((t.started_at at time zone 'America/Halifax')::date - 1,
                                   (t.finished_at at time zone 'America/Halifax')::date) as working_days
  from public.board_card_stage_times t
  join public.order_machines m on m.id = t.machine_id
  join public.machine_types mt on mt.id = m.machine_type_id
  join public.orders o on o.id = m.order_id
 where t.finished_at is not null and t.started_at is not null and t.finished_at >= t.started_at
   and t.step is not null and t.step <> 'other'
   and public.has_perm('reports.build_times', 'view');

create view public.production_task_times
with (security_invoker = false)
as
select i.id, b.machine_type_id, mt.name as machine_type, b.step, b.section, b.item_text, b.id as template_item_id,
       i.started_at, i.finished_at, extract(epoch from (i.finished_at - i.started_at))::bigint as seconds
  from public.board_checklist_items i
  join public.build_checklist_items b on b.id = i.template_item_id
  join public.machine_types mt on mt.id = b.machine_type_id
 where i.started_at is not null and i.finished_at is not null and i.finished_at >= i.started_at
   and public.has_perm('reports.build_times.tasks', 'view');

-- ===========================================================================
-- 10. Production boards for orders already in the shop queue
-- ===========================================================================
do $$
declare
  v_order uuid;
begin
  perform public.system_on();
  for v_order in select id from public.orders where public.is_board_stage(stage) and not archived order by board_position loop
    perform public.create_production_board(v_order);
  end loop;
  perform set_config('app.system_change', '', true);
end $$;

-- The reports page can be a start page.
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/reports/department-delays',
     '/reports/build-times', '/boards', '/agent', '/settings', '/admin', '/shop-board'));

-- Access lockdown, as in earlier migrations, then the exceptions.
revoke all on public.build_checklist_items, public.production_stage_template, public.board_card_stage_times,
  public.production_step_times, public.production_task_times from anon;
revoke insert, update, delete on public.board_card_stage_times from authenticated;
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
