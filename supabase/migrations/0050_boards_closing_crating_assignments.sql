-- 0050: boards upgrade 2.
--
-- Paste into the Supabase SQL Editor and run once. Steps:
--   1. Board numbers, closing and reopening boards (production boards close
--      by themselves when their order is shipped).
--   2. Move or copy a card to another board or stage; move / copy / archive
--      every card of a stage.
--   3. Collapsed stages, remembered per person.
--   4. Checklist tasks: assignee and due date (text and sub-tasks were already
--      editable), every change logged.
--   5. Crating per order ("Will this order be crated?"): the production board
--      has a Crating stage only for crated orders.
--   6. Production assignments: default people per stage (optionally per
--      machine type), applied when a machine card enters a stage.
--   7. Access lockdown.

-- ===========================================================================
-- 1. Board numbers, closing and reopening
-- ===========================================================================
create sequence if not exists public.board_number_seq;

alter table public.boards
  add column if not exists board_number   integer,
  add column if not exists closed_at      timestamptz,
  add column if not exists closed_by      text,
  add column if not exists closed_by_name text,
  -- shipped = closed automatically when the order was shipped; manual = "Close Board"
  add column if not exists close_reason   text check (close_reason is null or close_reason in ('shipped', 'manual'));

-- Every board gets a number (oldest first), new boards the next one.
with numbered as (
  select id, row_number() over (order by created_at, id) as n from public.boards where board_number is null
)
update public.boards b
   set board_number = coalesce((select max(board_number) from public.boards), 0) + numbered.n
  from numbered where b.id = numbered.id;
select setval('public.board_number_seq', greatest(coalesce((select max(board_number) from public.boards), 0), 1));
alter table public.boards alter column board_number set default nextval('public.board_number_seq');
alter table public.boards alter column board_number set not null;
create unique index if not exists boards_board_number_unique on public.boards (board_number);
create index if not exists boards_closed_idx on public.boards (closed_at);

-- Closing fields and numbers are changed only by close_board / reopen_board
-- and the automatic close (system changes).
create or replace function public.boards_close_guard()
returns trigger
language plpgsql
as $$
begin
  if public.is_system_change() then return new; end if;
  if new.board_number is distinct from old.board_number
     or new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by
     or new.closed_by_name is distinct from old.closed_by_name or new.close_reason is distinct from old.close_reason then
    raise exception 'Use Close Board or Reopen Board to change this.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists boards_close_guard on public.boards;
create trigger boards_close_guard before update on public.boards
  for each row execute function public.boards_close_guard();

-- Close a board early ("Close Board"): everything is kept as it is, the board
-- leaves the Boards page and can only be viewed until it is reopened.
create or replace function public.close_board(p_board uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('app.system_change', true), '');
  b      public.boards%rowtype;
begin
  perform public.require_perm('boards.close', 'edit');
  select * into b from public.boards where id = p_board;
  if b.id is null then raise exception 'This board was not found.' using errcode = 'P0002'; end if;
  if public.board_access_live(p_board, public.current_user_email()) < 3 then
    raise exception 'Only people who manage this board can close it.' using errcode = '42501';
  end if;
  if b.closed_at is not null then return; end if;
  perform public.system_on();
  update public.boards set closed_at = now(), closed_by = public.current_user_email(),
         closed_by_name = public.current_user_name(), close_reason = 'manual'
   where id = p_board;
  perform set_config('app.system_change', v_prev, true);
end;
$$;

-- Reopen a closed board with its own number or the next new number.
create or replace function public.reopen_board(p_board uuid, p_new_number boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('app.system_change', true), '');
  b      public.boards%rowtype;
  v_num  integer;
begin
  perform public.require_perm('boards.reopen', 'edit');
  select * into b from public.boards where id = p_board;
  if b.id is null then raise exception 'This board was not found.' using errcode = 'P0002'; end if;
  if public.board_access_live(p_board, public.current_user_email()) < 3 then
    raise exception 'Only people who manage this board can reopen it.' using errcode = '42501';
  end if;
  if b.closed_at is null then return b.board_number; end if;
  v_num := case when p_new_number then nextval('public.board_number_seq')::integer else b.board_number end;
  perform public.system_on();
  update public.boards set closed_at = null, closed_by = null, closed_by_name = null, close_reason = null, board_number = v_num
   where id = p_board;
  perform set_config('app.system_change', v_prev, true);
  return v_num;
end;
$$;

-- Production boards close by themselves when their order is shipped (every
-- machine has left), and open again when the order goes back into the queue.
create or replace function public.orders_production_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('app.system_change', true), '');
begin
  if new.stage is not distinct from old.stage then return null; end if;
  perform public.system_on();
  if new.stage = 'Shipped' then
    update public.boards
       set closed_at = now(), closed_by = public.current_user_email(), closed_by_name = coalesce(public.current_user_name(), 'Automatic'),
           close_reason = 'shipped'
     where order_id = new.id and purpose = 'production' and closed_at is null;
  elsif old.stage = 'Shipped' and public.is_board_stage(new.stage) then
    update public.boards set closed_at = null, closed_by = null, closed_by_name = null, close_reason = null
     where order_id = new.id and purpose = 'production' and close_reason = 'shipped';
  end if;
  perform set_config('app.system_change', v_prev, true);
  return null;
end;
$$;
drop trigger if exists orders_production_close on public.orders;
create trigger orders_production_close after update of stage on public.orders
  for each row execute function public.orders_production_close();

-- Orders shipped before this migration: their production boards are closed now.
do $$
begin
  perform public.system_on();
  update public.boards b
     set closed_at = now(), closed_by_name = 'Automatic', close_reason = 'shipped'
   where b.purpose = 'production' and b.closed_at is null
     and exists (select 1 from public.orders o where o.id = b.order_id and o.stage = 'Shipped');
  perform set_config('app.system_change', '', true);
end $$;

-- A closed board can be opened (viewed) but not changed until it is reopened.
CREATE OR REPLACE FUNCTION public.board_access_of(p_board uuid, p_email text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when b.id is null then 0
    -- 0050: a closed board can still be opened but not changed (Reopen first).
    when b.closed_at is not null then least(public.board_access_live(p_board, p_email), 1)
    when not b.archived or b.archived_members is null then public.board_access_live(p_board, p_email)
    when p_email is not null and p_email in (b.owner_email, b.created_by) then greatest(public.board_access_live(p_board, p_email), 1)
    when p_email = any (b.archived_members) then greatest(public.board_access_live(p_board, p_email), 1)
    else 0
  end
  from (select 1) one
  left join public.boards b on b.id = p_board;
$function$;

-- Closed boards send no due-soon / overdue messages.
CREATE OR REPLACE FUNCTION public.board_due_notifications()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := (now() at time zone 'America/Halifax')::date;
  v_card  record;
  v_count integer := 0;
begin
  -- Signed-in people (the app) and the automatic job (no login) may run it.
  if not public.is_allowed_user() and not public.is_service_caller() then return 0; end if;
  for v_card in
    select c.id, c.title, c.stage_id, c.due_date, b.name as board_name, b.due_soon_days,
           coalesce((select array_agg(a.user_email) from public.board_card_assignees a where a.card_id = c.id), '{}') as assignees
      from public.board_cards c join public.boards b on b.id = c.board_id
     where not c.archived and not b.archived and b.closed_at is null and c.finished_at is null and c.due_date is not null
       and c.due_date <= v_today + b.due_soon_days
       and exists (select 1 from public.board_notify_rules r where r.board_id = b.id and r.event in ('due_soon', 'overdue'))
  loop
    if v_card.due_date < v_today then
      perform public.board_notify(v_card.id, 'overdue', v_card.stage_id,
        'Overdue · ' || v_card.board_name, v_card.title || ' was due ' || to_char(v_card.due_date, 'Mon FMDD'),
        v_card.assignees, 'overdue:' || v_card.id || ':' || v_card.due_date);
    else
      perform public.board_notify(v_card.id, 'due_soon', v_card.stage_id,
        'Due ' || case when v_card.due_date = v_today then 'today' else to_char(v_card.due_date, 'Mon FMDD') end || ' · ' || v_card.board_name,
        v_card.title, v_card.assignees, 'due_soon:' || v_card.id || ':' || v_card.due_date);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

-- ===========================================================================
-- 2. Move or copy cards to another board or stage
-- ===========================================================================
-- The label with this name on a board (made there when it is missing).
-- Internal: only inside the functions below.
create or replace function public.board_label_for(p_board uuid, p_name text, p_colour text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.board_labels
   where board_id = p_board and lower(btrim(name)) = lower(btrim(p_name)) order by archived, sort_order limit 1;
  if v_id is null then
    insert into public.board_labels (board_id, name, colour, sort_order)
    values (p_board, btrim(p_name), p_colour,
            coalesce((select max(sort_order) from public.board_labels where board_id = p_board), 0) + 1)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- Checks shared by moving and copying: the person can work on the target board
-- and the stage is an open stage of it.
create or replace function public.board_target_check(p_board uuid, p_stage uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
begin
  select * into b from public.boards where id = p_board;
  if b.id is null or public.board_level(p_board) < 2 then
    raise exception 'You cannot add cards to that board. Ask its owner to share it with you (Can work on cards).' using errcode = '42501';
  end if;
  if b.archived or b.closed_at is not null then
    raise exception 'That board is archived or closed. Reopen it first.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.board_stages where id = p_stage and board_id = p_board and not archived) then
    raise exception 'That stage is not on the chosen board.' using errcode = '22023';
  end if;
end;
$$;

-- Puts a card at a place in a stage (null = at the end) and renumbers the stage.
create or replace function public.board_place_card(p_card uuid, p_stage uuid, p_index integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(id order by sort_order, created_at), '{}') into v_ids
    from public.board_cards where stage_id = p_stage and not archived and id <> p_card;
  p_index := greatest(0, least(coalesce(p_index, cardinality(v_ids)), cardinality(v_ids)));
  v_ids := v_ids[1:p_index] || p_card || v_ids[p_index + 1:];
  update public.board_cards c set sort_order = x.pos
    from unnest(v_ids) with ordinality as x(id, pos)
   where c.id = x.id and c.sort_order is distinct from x.pos::integer;
end;
$$;

-- Copy a card to a stage of this or another board. The copy keeps the title,
-- description, due date, links, customer label, labels (by name), checklists
-- with their tasks and sub-tasks (not started), and the people on it who can
-- open the target board. A copy is always an ordinary card (a copy of a
-- machine card keeps the machine as a link). Returns the new card.
create or replace function public.copy_board_card(p_card uuid, p_board uuid, p_stage uuid, p_index integer default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev  text := coalesce(current_setting('app.system_change', true), '');
  c       public.board_cards%rowtype;
  v_new   uuid;
  v_list  record;
  v_nlist uuid;
  v_map   jsonb;
  v_item  record;
  v_nitem uuid;
  v_me    text := public.current_user_email();
begin
  perform public.require_perm('boards.card.copy', 'edit');
  select * into c from public.board_cards where id = p_card;
  if c.id is null or public.board_level(c.board_id) < 1 then
    raise exception 'This card was not found, or you cannot open its board.' using errcode = 'P0002';
  end if;
  perform public.board_target_check(p_board, p_stage);
  perform public.system_on();
  insert into public.board_cards (board_id, stage_id, title, description, due_date, order_id, customer_id, machine_id,
                                  link_text, customer_label, card_kind, created_by, created_by_name)
  values (p_board, p_stage, c.title, c.description, c.due_date, c.order_id, c.customer_id, c.machine_id,
          c.link_text, c.customer_label, 'task', v_me, public.current_user_name())
  returning id into v_new;
  -- Labels (matched by name; made on the target board when missing).
  insert into public.board_card_labels (card_id, label_id)
  select v_new, public.board_label_for(p_board, l.name, l.colour)
    from public.board_card_labels cl join public.board_labels l on l.id = cl.label_id
   where cl.card_id = p_card
  on conflict do nothing;
  -- Checklists, tasks and sub-tasks.
  for v_list in select * from public.board_checklists where card_id = p_card order by sort_order loop
    insert into public.board_checklists (card_id, title, sort_order) values (v_new, v_list.title, v_list.sort_order)
    returning id into v_nlist;
    v_map := '{}'::jsonb;
    for v_item in select * from public.board_checklist_items where checklist_id = v_list.id order by (parent_id is not null), sort_order loop
      insert into public.board_checklist_items (checklist_id, item_text, sort_order, parent_id, due_date, assignee_email)
      values (v_nlist, v_item.item_text, v_item.sort_order, (v_map ->> v_item.parent_id::text)::uuid, v_item.due_date,
              case when public.board_access_of(p_board, v_item.assignee_email) > 0 then v_item.assignee_email end)
      returning id into v_nitem;
      v_map := v_map || jsonb_build_object(v_item.id::text, v_nitem);
    end loop;
  end loop;
  -- The people on the card who can open the target board.
  insert into public.board_card_assignees (card_id, user_email)
  select v_new, a.user_email from public.board_card_assignees a
   where a.card_id = p_card and public.board_access_of(p_board, a.user_email) > 0
  on conflict do nothing;
  perform public.board_place_card(v_new, p_stage, p_index);
  perform public.board_event(v_new, 'copied_from', jsonb_build_object('card', p_card, 'title', c.title,
    'board', (select name from public.boards where id = c.board_id)));
  perform public.board_event(p_card, 'copied_to', jsonb_build_object('card', v_new,
    'board', (select name from public.boards where id = p_board), 'stage', (select name from public.board_stages where id = p_stage)));
  perform set_config('app.system_change', v_prev, true);
  return v_new;
end;
$$;

-- Move a card to a stage of this or another board. Its history, comments,
-- checklists and timers go with it; labels are matched by name on the new
-- board; people who cannot open the new board are taken off it. Machine,
-- leftover and service call cards stay on their own board (copy them instead).
create or replace function public.move_card_to_board(p_card uuid, p_board uuid, p_stage uuid, p_index integer default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('app.system_change', true), '');
  c        public.board_cards%rowtype;
  v_from   text;
  v_labels jsonb;
begin
  perform public.require_perm('boards.card.move', 'edit');
  select * into c from public.board_cards where id = p_card;
  if c.id is null or public.board_level(c.board_id) < 2 then
    raise exception 'You cannot move this card. Ask the board''s owner for "Can work on cards".' using errcode = '42501';
  end if;
  perform public.board_target_check(p_board, p_stage);
  if p_board = c.board_id then
    perform public.move_board_card(p_card, p_stage, p_index);
    return;
  end if;
  perform public.require_perm('boards.card.move_board', 'edit');
  if c.card_kind <> 'task' then
    raise exception '% cards stay on their own board. Use Copy to put a copy on another board.',
      case c.card_kind when 'machine' then 'Machine' when 'leftover' then 'Leftover' else 'Service call' end using errcode = '22023';
  end if;
  if exists (select 1 from public.boards where id = p_board and purpose = 'service') then
    raise exception 'Cards cannot be moved onto the Service Calls board. Use Copy: the copy becomes a new service call.' using errcode = '22023';
  end if;
  select name into v_from from public.boards where id = c.board_id;
  perform public.system_on();
  -- Labels by name on the new board.
  select coalesce(jsonb_agg(jsonb_build_object('name', l.name, 'colour', l.colour)), '[]'::jsonb) into v_labels
    from public.board_card_labels cl join public.board_labels l on l.id = cl.label_id where cl.card_id = p_card;
  delete from public.board_card_labels where card_id = p_card;
  update public.board_cards set board_id = p_board, stage_id = p_stage where id = p_card;
  insert into public.board_card_labels (card_id, label_id)
  select p_card, public.board_label_for(p_board, m ->> 'name', m ->> 'colour') from jsonb_array_elements(v_labels) m
  on conflict do nothing;
  -- Only people who can open the new board stay on the card and its tasks.
  delete from public.board_card_assignees a where a.card_id = p_card and public.board_access_of(p_board, a.user_email) = 0;
  update public.board_checklist_items i set assignee_email = null
   where i.checklist_id in (select id from public.board_checklists where card_id = p_card)
     and i.assignee_email is not null and public.board_access_of(p_board, i.assignee_email) = 0;
  -- Stage-bound checklists (production) become ordinary checklists.
  update public.board_checklists set stage_id = null where card_id = p_card and stage_id is not null;
  perform public.board_place_card(p_card, p_stage, p_index);
  perform public.board_event(p_card, 'moved_board', jsonb_build_object('from', v_from,
    'to', (select name from public.boards where id = p_board), 'stage', (select name from public.board_stages where id = p_stage)));
  perform set_config('app.system_change', v_prev, true);
end;
$$;

-- Stage menu: move or copy every card of a stage to another stage or board.
-- Cards that cannot leave their board (machine, leftover, service call) are
-- skipped when moving to another board. Returns {done, skipped}.
create or replace function public.move_stage_cards(p_stage uuid, p_board uuid, p_target_stage uuid, p_copy boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from    uuid;
  v_card    record;
  v_done    integer := 0;
  v_skipped integer := 0;
begin
  perform public.require_perm('boards.stage.move_all', 'edit');
  select board_id into v_from from public.board_stages where id = p_stage;
  if v_from is null or public.board_level(v_from) < (case when p_copy then 1 else 2 end) then
    raise exception 'This stage was not found, or you cannot change its board.' using errcode = '42501';
  end if;
  if p_stage = p_target_stage then
    raise exception 'Choose another stage.' using errcode = '22023';
  end if;
  perform public.board_target_check(p_board, p_target_stage);
  for v_card in
    select id, card_kind from public.board_cards where stage_id = p_stage and not archived order by sort_order, created_at
  loop
    if p_copy then
      perform public.copy_board_card(v_card.id, p_board, p_target_stage, null);
      v_done := v_done + 1;
    elsif p_board <> v_from and v_card.card_kind <> 'task' then
      v_skipped := v_skipped + 1;
    else
      perform public.move_card_to_board(v_card.id, p_board, p_target_stage, null);
      v_done := v_done + 1;
    end if;
  end loop;
  return jsonb_build_object('done', v_done, 'skipped', v_skipped);
end;
$$;

-- Stage menu: archive every card of a stage (machine cards stay: they follow
-- their machine). Returns {done, skipped}.
create or replace function public.archive_stage_cards(p_stage uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board   uuid;
  v_done    integer;
  v_skipped integer;
begin
  perform public.require_perm('boards.stage.archive_all', 'edit');
  perform public.require_perm('boards.card.archive', 'edit');
  select board_id into v_board from public.board_stages where id = p_stage;
  if v_board is null or public.board_level(v_board) < 2 then
    raise exception 'This stage was not found, or you cannot change its board.' using errcode = '42501';
  end if;
  select count(*) into v_skipped from public.board_cards where stage_id = p_stage and not archived and card_kind in ('machine', 'leftover');
  with a as (
    update public.board_cards set archived = true
     where stage_id = p_stage and not archived and card_kind not in ('machine', 'leftover')
    returning id
  )
  select count(*) into v_done from a;
  return jsonb_build_object('done', v_done, 'skipped', v_skipped);
end;
$$;

-- The open boards a person can put cards on (Move / Copy choices).
create or replace function public.my_editable_boards()
returns table (id uuid, name text, purpose text, board_number integer)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.name, b.purpose, b.board_number
    from public.boards b
   where not b.archived and b.closed_at is null and public.board_level(b.id) >= 2
   order by (b.purpose = 'production') desc, b.name;
$$;

-- ===========================================================================
-- 3. Collapsed stages (per person)
-- ===========================================================================
create table if not exists public.board_collapsed_stages (
  user_email text not null references public.allowed_users (email) on update cascade on delete cascade,
  stage_id   uuid not null references public.board_stages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_email, stage_id)
);
alter table public.board_collapsed_stages enable row level security;
drop policy if exists "Own collapsed stages" on public.board_collapsed_stages;
create policy "Own collapsed stages" on public.board_collapsed_stages
  for all to authenticated
  using (user_email = (select public.current_user_email()))
  with check (user_email = (select public.current_user_email()) and (select public.has_perm('boards.stage.collapse', 'view')));
grant select, insert, delete on public.board_collapsed_stages to authenticated;

-- ===========================================================================
-- 4. Checklist tasks: assignee and due date (text, sub-tasks already editable)
-- ===========================================================================
alter table public.board_checklist_items
  add column if not exists assignee_email text references public.allowed_users (email) on update cascade on delete set null,
  add column if not exists due_date       date,
  -- true when Admin → Production Assignments put the person there
  add column if not exists assigned_auto  boolean not null default false;

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
    new.assigned_auto := false;
    if new.assignee_email is not null then
      perform public.require_perm('boards.task.assign', 'edit');
    end if;
    if new.due_date is not null then
      perform public.require_perm('boards.task.due', 'edit');
    end if;
    if new.sort_order = 0 then
      new.sort_order := coalesce((select max(sort_order) from public.board_checklist_items
                                   where checklist_id = new.checklist_id), 0) + 1;
    end if;
  else
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
    -- 0050: who does it and by when; can change at any time, also while the task's timer runs.
    if new.assignee_email is distinct from old.assignee_email then
      perform public.require_perm('boards.task.assign', 'edit');
      new.assigned_auto := false;
    else
      new.assigned_auto := old.assigned_auto;
    end if;
    if new.due_date is distinct from old.due_date then
      perform public.require_perm('boards.task.due', 'edit');
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
  end if;
  if new.assignee_email is not null
     and public.board_access_of(public.board_of_checklist(new.checklist_id), new.assignee_email) = 0 then
    raise exception 'This person cannot open this board. Share the board with them first.' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- History of a task: started / finished (as before), and now renamed,
-- assigned (the timer stays with the task) and due date.
create or replace function public.board_items_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid := (select card_id from public.board_checklists where id = new.checklist_id);
  v_c    public.board_cards;
  v_name text;
  v_old  text;
  v_was  text;
begin
  if v_card is null then return null; end if;
  if tg_op = 'UPDATE' then
    if new.started_at is distinct from old.started_at and new.started_at is not null then
      perform public.board_event(v_card, 'task_started', jsonb_build_object('task', new.item_text));
    end if;
    if new.finished_at is distinct from old.finished_at then
      perform public.board_event(v_card, case when new.finished_at is null then 'task_reopened' else 'task_done' end,
        jsonb_build_object('task', new.item_text,
          'seconds', case when new.finished_at is not null and new.started_at is not null
                          then extract(epoch from new.finished_at - new.started_at)::bigint end));
    end if;
    if new.item_text is distinct from old.item_text then
      perform public.board_event(v_card, 'task_renamed', jsonb_build_object('old', old.item_text, 'new', new.item_text));
    end if;
    if new.due_date is distinct from old.due_date then
      perform public.board_event(v_card, 'task_due', jsonb_build_object('task', new.item_text, 'old', old.due_date, 'new', new.due_date));
    end if;
  end if;
  v_was := case when tg_op = 'UPDATE' then old.assignee_email end;
  if new.assignee_email is distinct from v_was then
    v_name := (select coalesce(nullif(btrim(name), ''), email) from public.allowed_users where email = new.assignee_email);
    v_old := (select coalesce(nullif(btrim(name), ''), email) from public.allowed_users where email = v_was);
    perform public.board_event(v_card, 'task_assigned', jsonb_build_object('task', new.item_text, 'name', v_name, 'old', v_old,
      'running', new.started_at is not null and new.finished_at is null, 'auto', new.assigned_auto));
    if new.assignee_email is not null then
      select * into v_c from public.board_cards where id = v_card;
      perform public.board_notify(v_card, 'assigned', v_c.stage_id,
        'Task assigned to ' || coalesce(v_name, new.assignee_email) || ' · ' || (select name from public.boards where id = v_c.board_id),
        v_c.title || ': ' || new.item_text, array[new.assignee_email]);
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists board_items_events on public.board_checklist_items;
create trigger board_items_events after insert or update on public.board_checklist_items
  for each row execute function public.board_items_events();

-- ===========================================================================
-- 5. Crating per order ("Will this order be crated?")
-- ===========================================================================
-- Existing orders stay crated (nothing changes for them); the New order form asks.
alter table public.orders add column if not exists crating boolean not null default true;
grant select (crating) on public.orders to authenticated;
grant update (crating) on public.orders to authenticated;

-- Production stages remember the default stage they came from (for Admin →
-- Production Assignments) and whether they were hidden because the order is
-- not crated (so they come back when it is).
alter table public.board_stages
  add column if not exists template_stage_id uuid references public.production_stage_template (id) on delete set null,
  add column if not exists auto_hidden boolean not null default false;
update public.board_stages s
   set template_stage_id = t.id
  from public.production_stage_template t, public.boards b
 where s.template_stage_id is null and b.id = s.board_id and b.purpose = 'production'
   and t.step = s.step and lower(btrim(t.name)) = lower(btrim(s.name));

-- A machine of an order that is not crated never needs a crate.
create or replace function public.order_machines_crating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.needs_crate and not coalesce((select crating from public.orders where id = new.order_id), true) then
    new.needs_crate := false;
  end if;
  return new;
end;
$$;
drop trigger if exists order_machines_zz_crating on public.order_machines;
create trigger order_machines_zz_crating before insert or update of needs_crate on public.order_machines
  for each row execute function public.order_machines_crating();

-- When an order's answer changes: its machines and its production board follow.
--   Not crated: every machine "Crate" off; the Crating stage is hidden (its
--   cards go on to the next stage). Crates already made are kept.
--   Crated: every machine "Crate" on; the Crating stage comes back (made from
--   Admin → Production when the board never had one).
create or replace function public.orders_crating_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev  text := coalesce(current_setting('app.system_change', true), '');
  v_board uuid;
  v_stage record;
  v_next  uuid;
  v_tpl   record;
  v_after integer;
begin
  if new.crating is not distinct from old.crating then return null; end if;
  perform public.system_on();
  update public.order_machines set needs_crate = new.crating where order_id = new.id and not archived and needs_crate is distinct from new.crating;
  select id into v_board from public.boards where order_id = new.id and purpose = 'production';
  if v_board is not null then
    if not new.crating then
      for v_stage in select * from public.board_stages where board_id = v_board and step = 'crating' and not archived loop
        select id into v_next from public.board_stages
         where board_id = v_board and not archived and id <> v_stage.id and sort_order > v_stage.sort_order
         order by sort_order limit 1;
        if v_next is null then
          select id into v_next from public.board_stages
           where board_id = v_board and not archived and id <> v_stage.id order by sort_order desc limit 1;
        end if;
        if v_next is not null then
          update public.board_cards set stage_id = v_next where stage_id = v_stage.id and not archived;
        end if;
        update public.board_stages set archived = true, auto_hidden = true where id = v_stage.id;
      end loop;
    else
      update public.board_stages set archived = false, auto_hidden = false
       where board_id = v_board and step = 'crating' and archived and auto_hidden;
      if not exists (select 1 from public.board_stages where board_id = v_board and step = 'crating' and not archived) then
        select * into v_tpl from public.production_stage_template where step = 'crating' and not archived order by sort_order limit 1;
        if v_tpl.id is not null then
          -- Right after the stage that comes before Crating in Admin → Production (else before Shipping).
          select max(s.sort_order) into v_after from public.board_stages s
            join public.production_stage_template t on t.id = s.template_stage_id
           where s.board_id = v_board and not s.archived and t.sort_order < v_tpl.sort_order;
          if v_after is null then
            select min(sort_order) - 1 into v_after from public.board_stages where board_id = v_board and not archived and step = 'shipping';
          end if;
          v_after := coalesce(v_after, (select max(sort_order) from public.board_stages where board_id = v_board));
          update public.board_stages set sort_order = sort_order + 1 where board_id = v_board and sort_order > v_after;
          insert into public.board_stages (board_id, name, sort_order, step, department_id, template_stage_id)
          values (v_board, v_tpl.name, v_after + 1, 'crating', v_tpl.department_id, v_tpl.id);
        end if;
      end if;
    end if;
  end if;
  perform set_config('app.system_change', v_prev, true);
  return null;
end;
$$;
drop trigger if exists orders_crating_changed on public.orders;
create trigger orders_crating_changed after update of crating on public.orders
  for each row execute function public.orders_crating_changed();

-- Change the answer from the app (Order page, Edit Order). Turning crating off
-- when crates are already recorded needs p_confirm (the crates are kept, only
-- hidden). Returns the number of crates on the order.
create or replace function public.set_order_crating(p_order uuid, p_crating boolean, p_confirm boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crates integer;
begin
  perform public.require_perm('order.field.crating', 'edit');
  if not exists (select 1 from public.orders where id = p_order) then
    raise exception 'That order was not found.' using errcode = 'P0002';
  end if;
  select count(*) into v_crates from public.crates where order_id = p_order and not archived;
  if not p_crating and v_crates > 0 and not p_confirm then
    raise exception 'This order already has % crate%. They are kept, but hidden while the order is not crated.', v_crates, case when v_crates = 1 then '' else 's' end
      using errcode = '22023', hint = 'crates_exist';
  end if;
  update public.orders set crating = p_crating where id = p_order and crating is distinct from p_crating;
  return v_crates;
end;
$$;

-- New orders: create_order saves the answer (p_order.crating, default yes).
CREATE OR REPLACE FUNCTION public.create_order(p_order jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_customer_id uuid := nullif(p_order ->> 'customer_id', '')::uuid;
  v_cust        jsonb := p_order -> 'new_customer';
  v_number      integer := nullif(p_order ->> 'order_number', '')::integer;
  v_split_of    integer := nullif(p_order ->> 'split_of', '')::integer;
  v_split       integer;
  v_total       numeric := coalesce(nullif(p_order ->> 'order_total', '')::numeric, 0);
  v_down        numeric := nullif(p_order ->> 'down_payment_amount', '')::numeric;
  v_order_id    uuid;
  v_code        text;
  v_machine     jsonb;
  v_serial      text;
  v_taken_by    text;
begin
  perform public.require_perm('orders.new');
  -- One order number at a time, so two people saving at once cannot clash.
  perform pg_advisory_xact_lock(7605002);

  -- Customer ---------------------------------------------------------------
  if v_customer_id is null then
    if v_cust is null or coalesce(btrim(v_cust ->> 'name'), '') = '' then
      raise exception 'Please pick a customer or enter the new customer''s name.';
    end if;
    insert into public.customers (name, company, emails, country, state_province)
    values (
      btrim(v_cust ->> 'name'),
      nullif(btrim(v_cust ->> 'company'), ''),
      coalesce((select array_agg(distinct lower(btrim(e)))
                  from jsonb_array_elements_text(coalesce(v_cust -> 'emails', '[]'::jsonb)) as e
                 where btrim(e) <> ''), '{}'),
      nullif(btrim(v_cust ->> 'country'), ''),
      nullif(btrim(v_cust ->> 'state_province'), '')
    )
    returning id into v_customer_id;
  elsif not exists (select 1 from public.customers where id = v_customer_id) then
    raise exception 'That customer could not be found. Please pick the customer again.';
  end if;

  -- Order number -----------------------------------------------------------
  if v_split_of is not null then
    if not exists (select 1 from public.orders where order_number = v_split_of and cancelled_code is null) then
      raise exception 'Order #% does not exist, so this cannot be a split shipment of it.', v_split_of;
    end if;
    -- The original order 76 becomes 76-1; this one becomes 76-2 (or the next free suffix).
    update public.orders set split_number = 1
     where order_number = v_split_of and split_number is null and cancelled_code is null
       and not exists (select 1 from public.orders x where x.order_number = v_split_of and x.split_number = 1 and x.cancelled_code is null);
    select coalesce(max(split_number), 0) + 1 into v_split
      from public.orders where order_number = v_split_of and cancelled_code is null;
    v_number := v_split_of;
  else
    v_number := coalesce(v_number, public.next_order_number());
    if v_number < 1 then
      raise exception 'The order number must be 1 or more.';
    end if;
    if exists (select 1 from public.orders where order_number = v_number and cancelled_code is null) then
      raise exception 'Order number % is already used. The next free number is %.',
        v_number, public.next_order_number();
    end if;
  end if;

  -- Money ------------------------------------------------------------------
  if v_total < 0 then
    raise exception 'The order total cannot be negative.';
  end if;
  if v_down is not null and (v_down < 0 or v_down > v_total) then
    raise exception 'The down payment must be between 0 and the order total.';
  end if;

  -- Order ------------------------------------------------------------------
  insert into public.orders (
    order_number, split_number, customer_id, stage, currency, order_total,
    expected_ship_date, voltage, delivery_equipment, freight_type, notes, crating
  ) values (
    v_number, v_split, v_customer_id,
    coalesce(nullif(p_order ->> 'stage', ''), 'Confirmed'),
    coalesce(nullif(p_order ->> 'currency', ''), 'CAD'),
    v_total,
    nullif(p_order ->> 'expected_ship_date', '')::date,
    coalesce(nullif(p_order ->> 'voltage', ''), 'Unknown'),
    coalesce(nullif(p_order ->> 'delivery_equipment', ''), 'Unknown'),
    nullif(p_order ->> 'freight_type', ''),
    nullif(btrim(p_order ->> 'notes'), ''),
    coalesce(nullif(p_order ->> 'crating', '')::boolean, true)
  )
  returning id, order_code into v_order_id, v_code;

  -- Machines ---------------------------------------------------------------
  -- Hand-typed serials first, so automatic numbering skips them.
  for v_machine in
    select value from jsonb_array_elements(coalesce(p_order -> 'machines', '[]'::jsonb))
     order by (nullif(btrim(value ->> 'serial_number'), '') is null)
  loop
    v_serial := upper(nullif(btrim(v_machine ->> 'serial_number'), ''));
    if v_serial is not null then
      select o.order_code into v_taken_by
        from public.order_machines m join public.orders o on o.id = m.order_id
       where m.serial_number = v_serial;
      if found then
        raise exception 'Serial % is already used (order %).', v_serial, v_taken_by;
      end if;
    end if;
    insert into public.order_machines (order_id, machine_type_id, serial_number, serial_manual, needs_crate)
    values (v_order_id, (v_machine ->> 'machine_type_id')::uuid, v_serial, v_serial is not null,
            coalesce((v_machine ->> 'needs_crate')::boolean, true));
  end loop;

  -- Payments ---------------------------------------------------------------
  if coalesce(v_down, 0) > 0 or nullif(p_order ->> 'down_payment_due_date', '') is not null then
    insert into public.payments (order_id, payment_type, amount, due_date)
    values (v_order_id, 'Down payment', coalesce(v_down, 0),
            nullif(p_order ->> 'down_payment_due_date', '')::date);
  end if;
  if v_total > 0 or nullif(p_order ->> 'balance_due_date', '') is not null then
    -- amount is calculated automatically (total - down payment)
    insert into public.payments (order_id, payment_type, due_date)
    values (v_order_id, 'Balance', nullif(p_order ->> 'balance_due_date', '')::date);
  end if;

  return jsonb_build_object('id', v_order_id, 'order_code', v_code);
end;
$function$;

-- Who may change the answer: order.field.crating.
CREATE OR REPLACE FUNCTION public.check_field_permissions()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_map  jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'archived_at', 'archived_by', 'order_code',
                          'checklist_done_at', 'checklist_done_by', 'original_ship_date'];
  v_old  jsonb;
  v_new  jsonb;
  k      text;
  v_key  text;
begin
  if public.is_admin() or public.is_service_caller() or public.is_system_change()
     or public.can_admin('records') or public.can_admin('import') then
    return new;
  end if;

  if tg_table_name = 'orders' then
    v_map := jsonb_build_object(
      'expected_ship_date', 'order.field.expected_ship_date',
      'actual_ship_date',   'order.field.actual_ship_date',
      'voltage',            'order.field.voltage',
      'delivery_equipment', 'order.field.delivery_equipment',
      'freight_type',       'order.field.freight_type',
      'notes',              'order.field.notes',
      'currency',           'order.field.currency',
      'order_total',        'order.field.order_total',
      -- the automatic 76 -> 76-1 when a split shipment is added
      'split_number',       'orders.new',
      -- service (0029)
      'training_needed',    'order.field.training_needed',
      'training_days',      'order.field.training_days',
      'travel_days',        'order.field.travel_days',
      'technician_email',   'order.field.technician',
      'service_start',      'order.field.service_dates',
      'service_end',        'order.field.service_dates',
      -- 0037
      'quote_number',       'order.field.quote_number',
      'invoice_number',     'order.field.invoice_number',
      -- 0050: will this order be crated?
      'crating',            'order.field.crating');
  elsif tg_table_name = 'order_machines' then
    v_map := jsonb_build_object('ready', 'order.machines.built', 'needs_crate', 'order.machines.crate_flag');
  elsif tg_table_name = 'customers' then
    v_map := jsonb_build_object('emails', 'customer.contact', 'phone', 'customer.contact');
  end if;

  if tg_op = 'INSERT' then
    -- Read the fields through jsonb: each table has different columns (fix: the
    -- 0018 version failed for non-admins adding a customer or a machine).
    v_new := to_jsonb(new);
    if tg_table_name = 'orders' and coalesce((v_new ->> 'order_total')::numeric, 0) <> 0 then
      perform public.require_perm('order.field.order_total', 'edit');
    elsif tg_table_name = 'customers'
          and (coalesce(jsonb_array_length(v_new -> 'emails'), 0) > 0 or nullif(btrim(v_new ->> 'phone'), '') is not null) then
      perform public.require_perm('customer.contact', 'edit');
    end if;
    return new;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  for k in select n.key from jsonb_each(v_new) n where n.value is distinct from v_old -> n.key loop
    continue when k = any (v_skip);
    if k = 'archived' then
      -- archive: the "Remove" machine button; bring back: Admin > Archive
      if tg_table_name = 'order_machines' and new.archived then
        perform public.require_any_perm(array['order.machines.remove', 'admin.archive']);
      else
        perform public.require_admin_area('archive');
      end if;
      continue;
    end if;
    v_key := v_map ->> k;
    if v_key is null then
      raise exception 'You do not have permission to change "%" here. Ask an admin.', k using errcode = '42501';
    end if;
    perform public.require_perm(v_key, 'edit');
  end loop;
  return new;
end;
$function$;

-- Production boards of orders that will not be crated start without the Crating stage; stages remember their default stage.
CREATE OR REPLACE FUNCTION public.create_production_board(p_order uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  insert into public.board_stages (board_id, name, sort_order, step, department_id, template_stage_id)
  select v_board, t.name, row_number() over (order by t.sort_order, t.created_at), t.step, t.department_id, t.id
    from public.production_stage_template t where not t.archived;
  -- 0050: an order that will not be crated has no Crating stage (hidden, comes back when the order is crated).
  if not coalesce((select crating from public.orders where id = p_order), true) then
    update public.board_stages set archived = true, auto_hidden = true where board_id = v_board and step = 'crating';
  end if;
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
$function$;

-- ===========================================================================
-- 6. Production assignments (Admin → Production Assignments)
-- ===========================================================================
-- Default people per production stage, optionally only for one machine type.
-- A rule names a person, or a department (everyone in it is put on the card).
-- When a machine card enters the stage, the card gets these people and the
-- stage's tasks get the person (when the task has nobody yet). Rules for the
-- card's machine type win over the rules for every machine type.
create table if not exists public.production_assignments (
  id                uuid primary key default gen_random_uuid(),
  stage_template_id uuid not null references public.production_stage_template (id) on delete cascade,
  machine_type_id   uuid references public.machine_types (id) on delete cascade,
  assignee_type     text not null check (assignee_type in ('user', 'department')),
  user_email        text references public.allowed_users (email) on update cascade on delete cascade,
  department_id     uuid references public.departments (id) on delete cascade,
  -- card = only on the card; tasks = only the stage's tasks; both
  applies_to        text not null default 'both' check (applies_to in ('card', 'tasks', 'both')),
  created_by        text,
  created_at        timestamptz not null default now(),
  check ((assignee_type = 'user' and user_email is not null and department_id is null)
      or (assignee_type = 'department' and department_id is not null and user_email is null))
);
create unique index if not exists production_assignments_unique
  on public.production_assignments (stage_template_id, coalesce(machine_type_id::text, ''), coalesce(user_email, ''), coalesce(department_id::text, ''));
alter table public.production_assignments enable row level security;
drop policy if exists "Production readers" on public.production_assignments;
create policy "Production readers" on public.production_assignments
  for select to authenticated using ((select public.is_allowed_user()));
drop policy if exists "Production assignment admins" on public.production_assignments;
create policy "Production assignment admins" on public.production_assignments
  for all to authenticated
  using ((select public.can_admin('production_assignments')))
  with check ((select public.can_admin('production_assignments')));
grant select, insert, update, delete on public.production_assignments to authenticated;

create or replace function public.production_assignments_fill()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then new.created_by := public.current_user_email(); end if;
  return new;
end;
$$;
drop trigger if exists production_assignments_fill on public.production_assignments;
create trigger production_assignments_fill before insert on public.production_assignments
  for each row execute function public.production_assignments_fill();

-- Card assignees put there by these rules (replaced when the card moves on;
-- people added by hand stay).
alter table public.board_card_assignees add column if not exists auto boolean not null default false;

-- Internal: put the default people of the card's current stage on a machine card.
create or replace function public.production_assign_defaults(p_card uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev  text := coalesce(current_setting('app.system_change', true), '');
  c       public.board_cards%rowtype;
  v_tpl   uuid;
  v_type  uuid;
  v_typed boolean;
  v_user  text;
begin
  select * into c from public.board_cards where id = p_card;
  if c.id is null or c.card_kind <> 'machine' then return; end if;
  select template_stage_id into v_tpl from public.board_stages where id = c.stage_id;
  select machine_type_id into v_type from public.order_machines where id = c.machine_id;
  perform public.system_on();
  -- The people the previous stage put on the card make way for this stage's.
  delete from public.board_card_assignees where card_id = p_card and auto;
  if v_tpl is not null and exists (select 1 from public.production_assignments where stage_template_id = v_tpl) then
    v_typed := exists (select 1 from public.production_assignments where stage_template_id = v_tpl and machine_type_id = v_type);
    insert into public.board_card_assignees (card_id, user_email, auto)
    select distinct p_card, x.email, true
      from (
        select a.user_email as email from public.production_assignments a
         where a.stage_template_id = v_tpl and a.assignee_type = 'user' and a.applies_to in ('card', 'both')
           and (case when v_typed then a.machine_type_id = v_type else a.machine_type_id is null end)
        union
        select ud.user_email from public.production_assignments a join public.user_departments ud on ud.department_id = a.department_id
         where a.stage_template_id = v_tpl and a.assignee_type = 'department' and a.applies_to in ('card', 'both')
           and (case when v_typed then a.machine_type_id = v_type else a.machine_type_id is null end)
      ) x
     where public.board_access_of(c.board_id, x.email) > 0
    on conflict (card_id, user_email) do nothing;
    select a.user_email into v_user from public.production_assignments a
     where a.stage_template_id = v_tpl and a.assignee_type = 'user' and a.applies_to in ('tasks', 'both')
       and (case when v_typed then a.machine_type_id = v_type else a.machine_type_id is null end)
       and public.board_access_of(c.board_id, a.user_email) > 0
     order by a.created_at limit 1;
    if v_user is not null then
      update public.board_checklist_items i set assignee_email = v_user, assigned_auto = true
       where i.assignee_email is null and i.finished_at is null
         and i.checklist_id in (select id from public.board_checklists where card_id = p_card and stage_id = c.stage_id);
    end if;
  end if;
  perform set_config('app.system_change', v_prev, true);
end;
$$;

-- Admin → Production Assignments → "Apply to Open Boards": the rules are used
-- again on every machine card of the open production boards (people added by
-- hand stay). Returns the number of cards.
create or replace function public.apply_production_assignments()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card  uuid;
  v_count integer := 0;
begin
  perform public.require_admin_area('production_assignments');
  for v_card in
    select c.id from public.board_cards c join public.boards b on b.id = c.board_id
     where b.purpose = 'production' and not b.archived and b.closed_at is null and not c.archived and c.card_kind = 'machine'
  loop
    perform public.production_assign_defaults(v_card);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Entering a stage also puts the stage's default people on the card and its tasks.
CREATE OR REPLACE FUNCTION public.production_card_entered(p_card uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 0050: the default people of this stage (Admin → Production Assignments).
  perform public.production_assign_defaults(p_card);
end;
$function$;

-- ===========================================================================
-- 7. Access lockdown
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
