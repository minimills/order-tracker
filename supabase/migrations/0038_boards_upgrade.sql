-- 0038 Boards upgrade
--  1. Production progress per machine (stage and %), shown instead of "Not built".
--  2. Final check can start when the machine card reaches the Final check stage;
--     signing the final check marks the machine as built.
--  4. Free-text "Linked to" on cards.
--  5. Pause / Resume on every timer, with a note; times count active time only.
--  6. Sub-tasks on checklist items.
--  7. Labels made from a card; a customer label per card.
--  8. One-click "Mark Complete" on a card.
--  9. Archived boards: only the creator and the people who had access when it
--     was archived can see them.
-- Paste the whole file into the Supabase SQL Editor and click Run.

-- ===========================================================================
-- 1. New columns
-- ===========================================================================
alter table public.board_cards
  add column link_text text check (link_text is null or char_length(link_text) <= 200),
  add column customer_label text check (customer_label is null or char_length(customer_label) <= 200);

alter table public.board_checklist_items
  add column parent_id uuid references public.board_checklist_items (id) on delete cascade;
create index board_checklist_items_parent_idx on public.board_checklist_items (parent_id);

alter table public.boards add column archived_members text[];

-- ===========================================================================
-- 2. Pauses: one row per pause of a card's timer (item_id empty) or a task's.
--    Written only by pause_board_timer() / resume_board_timer() and triggers.
-- ===========================================================================
create table public.board_time_pauses (
  id              uuid primary key default gen_random_uuid(),
  card_id         uuid not null references public.board_cards (id) on delete cascade,
  item_id         uuid references public.board_checklist_items (id) on delete cascade,
  paused_at       timestamptz not null default now(),
  paused_by       text,
  paused_by_name  text,
  note            text check (note is null or char_length(note) <= 500),
  resumed_at      timestamptz,
  resumed_by_name text
);
create index board_time_pauses_card_idx on public.board_time_pauses (card_id, paused_at);
create index board_time_pauses_item_idx on public.board_time_pauses (item_id) where item_id is not null;
create unique index board_time_pauses_open_idx on public.board_time_pauses (card_id, coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid)) where resumed_at is null;
alter table public.board_time_pauses enable row level security;
create policy "Board readers" on public.board_time_pauses
  for select to authenticated
  using ((select public.board_can(public.board_of_card(card_id), 'view')) and (select public.has_perm('boards.card.timing', 'view')));

-- Paused seconds of a timer between two moments (an open pause counts until now).
create or replace function public.board_paused_seconds(p_card uuid, p_item uuid, p_from timestamptz, p_to timestamptz)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(greatest(0, extract(epoch from least(coalesce(p.resumed_at, now()), p_to) - greatest(p.paused_at, p_from)))), 0)::bigint
    from public.board_time_pauses p
   where p.card_id = p_card and p.item_id is not distinct from p_item
     and p_from is not null and p_to is not null and p.paused_at < p_to;
$$;

create or replace function public.pause_board_timer(p_card uuid, p_item uuid default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started  timestamptz;
  v_finished timestamptz;
  v_task     text;
begin
  perform public.require_board(public.board_of_card(p_card), 'edit');
  perform public.require_perm('boards.card.timing');
  if p_item is null then
    select started_at, finished_at, title into v_started, v_finished, v_task from public.board_cards where id = p_card and not archived;
  else
    select i.started_at, i.finished_at, i.item_text into v_started, v_finished, v_task
      from public.board_checklist_items i join public.board_checklists l on l.id = i.checklist_id
     where i.id = p_item and l.card_id = p_card;
  end if;
  if v_task is null then
    raise exception 'That card or task could not be found.';
  end if;
  if v_started is null then
    raise exception 'Press Start before Pause.' using errcode = '22023';
  end if;
  if v_finished is not null then
    raise exception 'This is already finished, so it cannot be paused.' using errcode = '22023';
  end if;
  if exists (select 1 from public.board_time_pauses where card_id = p_card and item_id is not distinct from p_item and resumed_at is null) then
    raise exception 'This timer is already paused.' using errcode = '22023';
  end if;
  insert into public.board_time_pauses (card_id, item_id, paused_by, paused_by_name, note)
  values (p_card, p_item, public.current_user_email(), public.current_user_name(), nullif(btrim(coalesce(p_note, '')), ''));
  perform public.board_event(p_card, 'paused', jsonb_build_object('task', case when p_item is null then null else v_task end,
                                                                  'note', nullif(btrim(coalesce(p_note, '')), '')));
end;
$$;

create or replace function public.resume_board_timer(p_card uuid, p_item uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pause public.board_time_pauses;
  v_task  text;
begin
  perform public.require_board(public.board_of_card(p_card), 'edit');
  perform public.require_perm('boards.card.timing');
  update public.board_time_pauses
     set resumed_at = now(), resumed_by_name = public.current_user_name()
   where card_id = p_card and item_id is not distinct from p_item and resumed_at is null
  returning * into v_pause;
  if v_pause.id is null then
    raise exception 'This timer is not paused.' using errcode = '22023';
  end if;
  if p_item is not null then
    select item_text into v_task from public.board_checklist_items where id = p_item;
  end if;
  perform public.board_event(p_card, 'resumed', jsonb_build_object('task', v_task,
    'seconds', extract(epoch from v_pause.resumed_at - v_pause.paused_at)::bigint));
end;
$$;

-- An open pause ends when the timer finishes, is cleared or the card changes stage.
create or replace function public.board_cards_close_pauses()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage_id is distinct from old.stage_id or new.started_at is distinct from old.started_at
     or (new.finished_at is not null and old.finished_at is null) then
    update public.board_time_pauses
       set resumed_at = coalesce(new.finished_at, now()), resumed_by_name = coalesce(resumed_by_name, public.current_user_name())
     where card_id = new.id and item_id is null and resumed_at is null;
  end if;
  return null;
end;
$$;
create trigger board_cards_close_pauses after update on public.board_cards
  for each row execute function public.board_cards_close_pauses();

create or replace function public.board_items_close_pauses()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.started_at is distinct from old.started_at or (new.finished_at is not null and old.finished_at is null) then
    update public.board_time_pauses
       set resumed_at = coalesce(new.finished_at, now()), resumed_by_name = coalesce(resumed_by_name, public.current_user_name())
     where item_id = new.id and resumed_at is null;
  end if;
  return null;
end;
$$;
create trigger board_items_close_pauses after update on public.board_checklist_items
  for each row execute function public.board_items_close_pauses();

-- Times now count active time only (pauses taken off).
create or replace view public.board_task_times
with (security_invoker = true)
as
select 'card'::text as kind, c.board_id, c.id as source_id, lower(btrim(c.title)) as task_key,
       c.started_at, c.finished_at,
       (extract(epoch from c.finished_at - c.started_at)::bigint - public.board_paused_seconds(c.id, null, c.started_at, c.finished_at)) as seconds
  from public.board_cards c
 where c.started_at is not null and c.finished_at is not null and c.finished_at >= c.started_at
union all
select 'task', k.board_id, i.id, lower(btrim(i.item_text)),
       i.started_at, i.finished_at,
       (extract(epoch from i.finished_at - i.started_at)::bigint - public.board_paused_seconds(k.id, i.id, i.started_at, i.finished_at))
  from public.board_checklist_items i
  join public.board_checklists l on l.id = i.checklist_id
  join public.board_cards k on k.id = l.card_id
 where i.started_at is not null and i.finished_at is not null and i.finished_at >= i.started_at;

create or replace view public.production_step_times
with (security_invoker = false)
as
select t.id, t.step, t.stage_name, m.machine_type_id, mt.name as machine_type, m.serial_number, o.order_code,
       t.started_at, t.finished_at, t.auto_started, t.auto_finished,
       (extract(epoch from (t.finished_at - t.started_at))::bigint - public.board_paused_seconds(t.card_id, null, t.started_at, t.finished_at)) as seconds,
       public.working_days_between((t.started_at at time zone 'America/Halifax')::date - 1,
                                   (t.finished_at at time zone 'America/Halifax')::date) as working_days
  from public.board_card_stage_times t
  join public.order_machines m on m.id = t.machine_id
  join public.machine_types mt on mt.id = m.machine_type_id
  join public.orders o on o.id = m.order_id
 where t.finished_at is not null and t.started_at is not null and t.finished_at >= t.started_at
   and t.step is not null and t.step <> 'other'
   and public.has_perm('reports.build_times', 'view');

create or replace view public.production_task_times
with (security_invoker = false)
as
select i.id, b.machine_type_id, mt.name as machine_type, b.step, b.section, b.item_text, b.id as template_item_id,
       i.started_at, i.finished_at,
       (extract(epoch from (i.finished_at - i.started_at))::bigint
         - public.board_paused_seconds((select l.card_id from public.board_checklists l where l.id = i.checklist_id), i.id, i.started_at, i.finished_at)) as seconds
  from public.board_checklist_items i
  join public.build_checklist_items b on b.id = i.template_item_id
  join public.machine_types mt on mt.id = b.machine_type_id
 where i.started_at is not null and i.finished_at is not null and i.finished_at >= i.started_at
   and public.has_perm('reports.build_times.tasks', 'view');

-- ===========================================================================
-- 3. Labels made from a card (people who can work on the board's cards)
-- ===========================================================================
create or replace function public.add_board_label(p_board uuid, p_name text, p_colour text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_board(p_board, 'edit');
  perform public.require_perm('boards.labels.create');
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'Enter a name for the label.' using errcode = '22023';
  end if;
  if coalesce(p_colour, '') !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'Choose a colour for the label.' using errcode = '22023';
  end if;
  select id into v_id from public.board_labels
   where board_id = p_board and lower(btrim(name)) = lower(btrim(p_name)) and not archived;
  if v_id is not null then
    raise exception 'This board already has a label called “%”.', btrim(p_name) using errcode = '23505';
  end if;
  insert into public.board_labels (board_id, name, colour, sort_order)
  values (p_board, btrim(p_name), p_colour,
          coalesce((select max(sort_order) from public.board_labels where board_id = p_board), 0) + 1)
  returning id into v_id;
  return v_id;
end;
$$;
-- ===========================================================================
-- 4. Guards
-- ===========================================================================
-- Copy of 0027 with free-text links, customer labels and one-click complete.
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
    if (new.order_id is not null or new.customer_id is not null or new.machine_id is not null or new.link_text is not null) then
      perform public.require_perm('boards.card.link');
    end if;
    if new.customer_label is not null then
      perform public.require_perm('boards.card.customer_label');
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
     or new.machine_id is distinct from old.machine_id or new.link_text is distinct from old.link_text then
    perform public.require_perm('boards.card.link');
  end if;
  if new.customer_label is distinct from old.customer_label then
    perform public.require_perm('boards.card.customer_label');
  end if;
  if new.archived is distinct from old.archived then
    perform public.require_perm('boards.card.archive');
  end if;
  -- Start / Finish: stamped here, never taken from the app.
  -- One-click "Mark Complete" (boards.card.complete) may start and finish together,
  -- or mark complete / incomplete; everything else needs boards.card.timing.
  if new.started_at is distinct from old.started_at or new.finished_at is distinct from old.finished_at then
    if (new.started_at is not distinct from old.started_at and new.finished_at is distinct from old.finished_at)
       or (old.started_at is null and new.started_at is not null and new.finished_at is not null) then
      perform public.require_any_perm(array['boards.card.timing', 'boards.card.complete']);
    else
      perform public.require_perm('boards.card.timing');
    end if;
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

-- Copy of 0027 with sub-tasks (parent_id).
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
    if new.parent_id is not null and not exists (
         select 1 from public.board_checklist_items p
          where p.id = new.parent_id and p.checklist_id = new.checklist_id and p.parent_id is null) then
      raise exception 'A sub-task belongs to a task in the same checklist (one level only).' using errcode = '22023';
    end if;
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
  if new.parent_id is distinct from old.parent_id then
    raise exception 'A sub-task cannot move to another task.' using errcode = '22023';
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
-- 5. Final check: start from the production board; signing marks it built.
-- ===========================================================================
-- Copy of 0020 that also allows a machine whose card is in the Final check stage.
create or replace function public.start_checklist(p_machine_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_m  record;
  v_id uuid;
begin
  perform public.require_perm('checklist.start');
  select om.id, om.order_id, om.machine_type_id, om.ready, om.archived
    into v_m from public.order_machines om where om.id = p_machine_id;
  if v_m.id is null or v_m.archived then
    raise exception 'That machine could not be found.';
  end if;
  select id into v_id from public.machine_checklists where machine_id = p_machine_id;
  if v_id is not null then
    return v_id;
  end if;
  -- Built, or its production card has reached the Final check stage.
  if not v_m.ready and not exists (
       select 1 from public.board_cards c
         join public.board_stages s on s.id = c.stage_id
         join public.boards b on b.id = c.board_id
        where c.machine_id = p_machine_id and c.card_kind = 'machine' and not c.archived
          and b.purpose = 'production' and not b.archived and s.step = 'final_check') then
    raise exception 'Mark the machine as built (or move its production card to the Final check stage), then start its final check.';
  end if;

  insert into public.machine_checklists (machine_id, order_id, started_by, started_by_name, last_worked_at, last_worked_by_name)
  values (p_machine_id, v_m.order_id, public.current_user_email(), public.current_user_name(), now(), public.current_user_name())
  returning id into v_id;

  insert into public.machine_checklist_items (checklist_id, template_item_id, section, item_text, sort_order)
  select v_id, t.id, btrim(t.section), btrim(t.item_text),
         row_number() over (order by (t.machine_type_id is not null), t.sort_order, t.created_at)
    from public.checklist_template_items t
   where not t.archived
     and (t.machine_type_id is null or t.machine_type_id = v_m.machine_type_id);
  return v_id;
end;
$$;

-- Copy of 0025 that also marks the machine as built.
create or replace function public.sign_checklist(p_checklist_id uuid, p_full_name text, p_signature_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c    record;
  v_open integer;
begin
  perform public.require_perm('checklist.sign');
  select * into v_c from public.machine_checklists where id = p_checklist_id;
  if v_c.id is null then
    raise exception 'That checklist could not be found.';
  end if;
  if v_c.signed_at is not null then
    raise exception 'This final check is already signed.';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) < 3 then
    raise exception 'Enter your full name to sign.';
  end if;
  select count(*) into v_open from public.machine_checklist_items where checklist_id = p_checklist_id and status = 'open';
  if v_open > 0 then
    raise exception '% item% still need% to be marked complete or not applicable before signing.', v_open, case when v_open = 1 then '' else 's' end, case when v_open = 1 then 's' else '' end;
  end if;
  if p_signature_path is null or p_signature_path not like p_checklist_id::text || '/%'
     or not exists (select 1 from storage.objects o
                     where o.bucket_id = 'checklist-signatures' and o.name = p_signature_path) then
    raise exception 'The signature was not saved. Please sign again.';
  end if;

  perform set_config('app.system_change', 'on', true);
  update public.machine_checklists
     set signed_name = btrim(p_full_name), signed_at = now(), signed_by = public.current_user_email(),
         signature_path = p_signature_path, last_worked_at = now(), last_worked_by_name = public.current_user_name()
   where id = p_checklist_id;
  -- A signed final check means the machine is built (it keeps its serial number from now on).
  update public.order_machines set checklist_done = true, ready = true where id = v_c.machine_id;
end;
$$;

-- ===========================================================================
-- 6. Production progress of each machine: its stage and how far along it is.
--    % = (stages already passed + share of the current stage's checklist
--    items and sub-tasks completed) / number of stages. Crating is left out
--    when the machine is not crated.
-- ===========================================================================
create or replace view public.machine_production_progress
with (security_invoker = false)
as
with cards as (
  select c.id as card_id, c.board_id, c.machine_id, c.stage_id, c.finished_at, m.order_id, m.needs_crate
    from public.board_cards c
    join public.boards b on b.id = c.board_id and b.purpose = 'production' and not b.archived
    join public.order_machines m on m.id = c.machine_id and not m.archived
   where c.card_kind = 'machine' and not c.archived
), stages as (
  select k.card_id, s.id as stage_id, s.name, s.step,
         row_number() over (partition by k.card_id order by s.sort_order, s.created_at) as n,
         count(*) over (partition by k.card_id) as total
    from cards k
    join public.board_stages s on s.board_id = k.board_id and not s.archived
                               and not (s.step = 'crating' and not coalesce(k.needs_crate, false))
), work as (
  select l.card_id, l.stage_id, count(i.id) as total, count(i.finished_at) as done
    from public.board_checklists l
    join public.board_checklist_items i on i.checklist_id = l.id
   where l.stage_id is not null
   group by l.card_id, l.stage_id
)
select k.machine_id, k.order_id, k.card_id, k.board_id, s.stage_id, s.name as stage_name, s.step,
       s.n::integer as stage_number, s.total::integer as stage_count,
       coalesce(w.done, 0)::integer as items_done, coalesce(w.total, 0)::integer as items_total,
       least(100, round(100.0 * ((s.n - 1) + case when k.finished_at is not null then 1
                                                  when coalesce(w.total, 0) = 0 then 0
                                                  else w.done::numeric / w.total end) / s.total))::integer as percent
  from cards k
  join stages s on s.card_id = k.card_id and s.stage_id = k.stage_id
  left join work w on w.card_id = k.card_id and w.stage_id = k.stage_id
 where public.has_perm('order.machines.progress', 'view');

-- ===========================================================================
-- 7. Archived boards: only the creator and the people who could open the
--    board when it was archived (people removed before are left out).
-- ===========================================================================
-- The access rules for a board that is not archived (0023 board_access_of).
create or replace function public.board_access_live(p_board uuid, p_email text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_email is null or not exists (select 1 from public.allowed_users a where a.email = p_email) then 0
    when exists (select 1 from public.allowed_users a where a.email = p_email and a.role = 'admin') then 3
    when exists (select 1 from public.boards b where b.id = p_board and b.owner_email = p_email) then 3
    else coalesce((
      select max(case s.level when 'manage' then 3 when 'edit' then 2 else 1 end)
        from public.board_shares s
       where s.board_id = p_board
         and (s.share_type = 'everyone'
           or (s.share_type = 'user' and s.target = p_email)
           or (s.share_type = 'group' and exists (
                 select 1 from public.user_group_members m join public.user_groups g on g.id = m.group_id
                  where m.group_id::text = s.target and m.user_email = p_email and not g.archived))
           or (s.share_type = 'department' and exists (
                 select 1 from public.user_departments d
                  where d.department_id::text = s.target and d.user_email = p_email)))
    ), 0)
  end;
$$;

create or replace function public.board_access_of(p_board uuid, p_email text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when b.id is null then 0
    when not b.archived or b.archived_members is null then public.board_access_live(p_board, p_email)
    when p_email is not null and p_email in (b.owner_email, b.created_by) then greatest(public.board_access_live(p_board, p_email), 1)
    when p_email = any (b.archived_members) then greatest(public.board_access_live(p_board, p_email), 1)
    else 0
  end
  from (select 1) one
  left join public.boards b on b.id = p_board;
$$;

-- Remembers who could open the board at the moment it is archived.
create or replace function public.boards_archive_members()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.archived and not old.archived then
    new.archived_members := array(select a.email from public.allowed_users a
                                   where public.board_access_live(new.id, a.email) > 0 order by a.email);
  elsif not new.archived then
    new.archived_members := null;
  else
    new.archived_members := old.archived_members;
  end if;
  return new;
end;
$$;
create trigger boards_archive_members before update on public.boards
  for each row execute function public.boards_archive_members();

-- Boards archived before this migration: the people who can open them now.
update public.boards b
   set archived_members = array(select a.email from public.allowed_users a
                                 where public.board_access_live(b.id, a.email) > 0 order by a.email)
 where b.archived and b.archived_members is null;

-- Access lockdown, as in earlier migrations.
revoke all on public.board_time_pauses, public.machine_production_progress from anon;
grant select on public.board_time_pauses, public.machine_production_progress to authenticated;
-- (0033–0037 re-granted the internal helpers below to every signed-in person; this puts the full list back.)
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
