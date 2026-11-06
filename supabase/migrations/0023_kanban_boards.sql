-- 0023_kanban_boards.sql
-- One reusable kanban boards system (personal boards now; production, parts
-- and service boards in later prompts use the same tables).
--
-- 1. Groups of people (Admin → Groups), e.g. Procurement, Techs.
-- 2. Boards, stages (columns), labels; who can open a board (owner, shares,
--    admins) = board_level(). The "boards" permissions still decide which
--    parts of a board each person sees and what they can change.
-- 3. Cards: title, rich-text description, labels, assignees, due date,
--    checklists with tasks, comments, history, link to an order / customer /
--    machine, Start / Finish times (on cards and on tasks).
-- 4. Card history (board_card_events), written by triggers.
-- 5. Notifications: per-board rules (which events notify whom) and one
--    notifications table for the bell (email can be added later: rules have
--    `channels`, notifications have `email_status` / `emailed_at`).
-- 6. Board templates (Admin → Board templates) and creating boards.
-- 7. How long tasks take (board_task_times view).
--
-- Every change is checked here too (row security + triggers), not only on
-- screen.

-- ===========================================================================
-- 1. Groups
-- ===========================================================================
create table public.user_groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (btrim(name) <> ''),
  description  text,
  archived     boolean not null default false,
  archived_at  timestamptz,
  archived_by  text,
  created_at   timestamptz not null default now()
);
create unique index user_groups_name_idx on public.user_groups (lower(btrim(name))) where not archived;
create trigger user_groups_archived before insert or update of archived on public.user_groups
  for each row execute function public.set_archived_info();

create table public.user_group_members (
  group_id    uuid not null references public.user_groups (id) on delete cascade,
  user_email  text not null references public.allowed_users (email) on delete cascade on update cascade,
  created_at  timestamptz not null default now(),
  primary key (group_id, user_email)
);
create index user_group_members_email_idx on public.user_group_members (user_email);

alter table public.user_groups enable row level security;
alter table public.user_group_members enable row level security;
create policy "Allowed users can read" on public.user_groups
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Group admins can change" on public.user_groups
  for all to authenticated using ((select public.can_admin('groups'))) with check ((select public.can_admin('groups')));
create policy "Allowed users can read" on public.user_group_members
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Group admins can change" on public.user_group_members
  for all to authenticated using ((select public.can_admin('groups'))) with check ((select public.can_admin('groups')));

-- ===========================================================================
-- 2. Boards, stages, labels
-- ===========================================================================
create table public.boards (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (btrim(name) <> ''),
  description       text,
  colour            text not null default '#2563eb' check (colour ~ '^#[0-9a-fA-F]{6}$'),
  owner_email       text references public.allowed_users (email) on delete set null on update cascade,
  -- What the board is for: 'personal' now; later prompts add 'production', 'parts', 'service'…
  purpose           text not null default 'personal' check (purpose ~ '^[a-z_]{1,30}$'),
  template_id       uuid,
  -- Ready-made checklists offered on "Add checklist" (copied from the template).
  checklist_presets jsonb not null default '[]'::jsonb check (jsonb_typeof(checklist_presets) = 'array'),
  due_soon_days     integer not null default 2 check (due_soon_days between 0 and 60),
  archived          boolean not null default false,
  archived_at       timestamptz,
  archived_by       text,
  created_at        timestamptz not null default now(),
  created_by        text
);
create index boards_owner_idx on public.boards (owner_email);
create trigger boards_archived before insert or update of archived on public.boards
  for each row execute function public.set_archived_info();

create table public.board_stages (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.boards (id) on delete cascade,
  name        text not null check (btrim(name) <> ''),
  sort_order  integer not null default 0,
  archived    boolean not null default false,
  archived_at timestamptz,
  archived_by text,
  created_at  timestamptz not null default now()
);
create index board_stages_board_idx on public.board_stages (board_id);
create trigger board_stages_archived before insert or update of archived on public.board_stages
  for each row execute function public.set_archived_info();

create table public.board_labels (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.boards (id) on delete cascade,
  name        text not null check (btrim(name) <> ''),
  colour      text not null default '#64748b' check (colour ~ '^#[0-9a-fA-F]{6}$'),
  sort_order  integer not null default 0,
  archived    boolean not null default false,
  archived_at timestamptz,
  archived_by text,
  created_at  timestamptz not null default now()
);
create index board_labels_board_idx on public.board_labels (board_id);
create trigger board_labels_archived before insert or update of archived on public.board_labels
  for each row execute function public.set_archived_info();

-- Who a board is shared with. level: view (see), edit (cards), manage
-- (settings, sharing, notifications). target: email / group id / department id.
create table public.board_shares (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.boards (id) on delete cascade,
  share_type  text not null check (share_type in ('user', 'group', 'department', 'everyone')),
  target      text,
  level       text not null default 'edit' check (level in ('view', 'edit', 'manage')),
  created_at  timestamptz not null default now(),
  created_by  text,
  check ((share_type = 'everyone') = (target is null))
);
create unique index board_shares_unique_idx on public.board_shares (board_id, share_type, coalesce(target, ''));

-- ---------------------------------------------------------------------------
-- Access: 0 = none, 1 = view, 2 = edit, 3 = manage.
-- ---------------------------------------------------------------------------
create or replace function public.board_access_of(p_board uuid, p_email text)
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

-- The signed-in person's access to a board (needs the "boards" permission).
create or replace function public.board_level(p_board uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_service_caller() then 3
    when not public.has_perm('boards', 'view') then 0
    else public.board_access_of(p_board, public.current_user_email())
  end;
$$;

create or replace function public.board_can(p_board uuid, p_level text)
returns boolean
language sql
stable
as $$
  select public.board_level(p_board) >= case p_level when 'manage' then 3 when 'edit' then 2 else 1 end;
$$;

create or replace function public.require_board(p_board uuid, p_level text)
returns void
language plpgsql
stable
as $$
begin
  if not public.board_can(p_board, p_level) then
    raise exception 'You do not have % access to this board. Ask its owner to share it with you.',
      case p_level when 'manage' then 'manage' when 'edit' then 'edit' else 'view' end
      using errcode = '42501';
  end if;
end;
$$;

-- ===========================================================================
-- 3. Cards and what belongs to them
-- ===========================================================================
create table public.board_cards (
  id               uuid primary key default gen_random_uuid(),
  board_id         uuid not null references public.boards (id) on delete cascade,
  stage_id         uuid not null references public.board_stages (id),
  title            text not null check (btrim(title) <> ''),
  description      text,
  due_date         date,
  sort_order       integer not null default 0,
  order_id         uuid references public.orders (id) on delete set null,
  customer_id      uuid references public.customers (id) on delete set null,
  machine_id       uuid references public.order_machines (id) on delete set null,
  started_at       timestamptz,
  started_by       text,
  started_by_name  text,
  finished_at      timestamptz,
  finished_by      text,
  finished_by_name text,
  archived         boolean not null default false,
  archived_at      timestamptz,
  archived_by      text,
  created_at       timestamptz not null default now(),
  created_by       text,
  created_by_name  text,
  updated_at       timestamptz not null default now()
);
create index board_cards_board_idx on public.board_cards (board_id);
create index board_cards_stage_idx on public.board_cards (stage_id, sort_order);
create index board_cards_due_idx on public.board_cards (due_date) where not archived and finished_at is null;
create trigger board_cards_archived before insert or update of archived on public.board_cards
  for each row execute function public.set_archived_info();
create trigger board_cards_safe_description before insert or update of description on public.board_cards
  for each row execute function public.reject_unsafe_notes('description');

create table public.board_card_labels (
  card_id   uuid not null references public.board_cards (id) on delete cascade,
  label_id  uuid not null references public.board_labels (id) on delete cascade,
  primary key (card_id, label_id)
);
create table public.board_card_assignees (
  card_id     uuid not null references public.board_cards (id) on delete cascade,
  user_email  text not null references public.allowed_users (email) on delete cascade on update cascade,
  created_at  timestamptz not null default now(),
  primary key (card_id, user_email)
);
create index board_card_assignees_email_idx on public.board_card_assignees (user_email);

create table public.board_checklists (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references public.board_cards (id) on delete cascade,
  title       text not null check (btrim(title) <> ''),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index board_checklists_card_idx on public.board_checklists (card_id);

-- A task is done when it has finished_at (ticking it = Finish).
create table public.board_checklist_items (
  id               uuid primary key default gen_random_uuid(),
  checklist_id     uuid not null references public.board_checklists (id) on delete cascade,
  item_text        text not null check (btrim(item_text) <> ''),
  sort_order       integer not null default 0,
  started_at       timestamptz,
  started_by       text,
  started_by_name  text,
  finished_at      timestamptz,
  finished_by      text,
  finished_by_name text,
  created_at       timestamptz not null default now()
);
create index board_checklist_items_list_idx on public.board_checklist_items (checklist_id);

create table public.board_comments (
  id           uuid primary key default gen_random_uuid(),
  card_id      uuid not null references public.board_cards (id) on delete cascade,
  body         text not null check (btrim(body) <> '' and length(body) <= 5000),
  author_email text,
  author_name  text,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz
);
create index board_comments_card_idx on public.board_comments (card_id, created_at);

-- Which board a card / checklist belongs to (for row security, no recursion).
create or replace function public.board_of_card(p_card uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select board_id from public.board_cards where id = p_card;
$$;
create or replace function public.board_of_checklist(p_checklist uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select c.board_id from public.board_checklists l join public.board_cards c on c.id = l.card_id where l.id = p_checklist;
$$;

-- ---------------------------------------------------------------------------
-- Card rules: who may change what (on top of board access).
-- ---------------------------------------------------------------------------
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
  if tg_op = 'INSERT' then
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
create trigger board_cards_guard before insert or update on public.board_cards
  for each row execute function public.board_cards_guard();

create or replace function public.board_items_guard()
returns trigger
language plpgsql
as $$
declare
  v_me   text := public.current_user_email();
  v_name text := public.current_user_name();
begin
  if tg_op = 'INSERT' then
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
    -- Ticking a task done = Finish (checklists); Finish after Start = timing.
    perform public.require_any_perm(array['boards.card.checklists', 'boards.card.timing']);
    if new.finished_at is null then new.finished_by := null; new.finished_by_name := null;
    else new.finished_at := now(); new.finished_by := v_me; new.finished_by_name := v_name; end if;
  else
    new.finished_by := old.finished_by; new.finished_by_name := old.finished_by_name;
  end if;
  return new;
end;
$$;
create trigger board_items_guard before insert or update on public.board_checklist_items
  for each row execute function public.board_items_guard();

create or replace function public.board_comments_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.author_email := public.current_user_email();
    new.author_name := public.current_user_name();
    new.created_at := now();
    new.edited_at := null;
  else
    if old.author_email is distinct from public.current_user_email() then
      raise exception 'You can only change your own comments.' using errcode = '42501';
    end if;
    new.author_email := old.author_email; new.author_name := old.author_name;
    new.created_at := old.created_at; new.card_id := old.card_id;
    new.edited_at := now();
  end if;
  return new;
end;
$$;
create trigger board_comments_guard before insert or update on public.board_comments
  for each row execute function public.board_comments_guard();

-- Assignees must be able to open the board.
create or replace function public.board_assignees_check()
returns trigger
language plpgsql
as $$
begin
  if public.board_access_of(public.board_of_card(new.card_id), new.user_email) = 0 then
    raise exception 'This person cannot open this board. Share the board with them first.' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger board_assignees_check before insert on public.board_card_assignees
  for each row execute function public.board_assignees_check();

-- A stage with cards in it cannot be archived.
create or replace function public.board_stages_guard()
returns trigger
language plpgsql
as $$
begin
  if new.board_id <> old.board_id then
    raise exception 'A stage cannot move to another board.' using errcode = '22023';
  end if;
  if new.archived and not old.archived
     and exists (select 1 from public.board_cards c where c.stage_id = new.id and not c.archived) then
    raise exception 'Move or archive the cards in "%" first.', old.name using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger board_stages_guard before update on public.board_stages
  for each row execute function public.board_stages_guard();

-- Only admins hand a board to someone else; nobody changes who made it.
create or replace function public.boards_guard()
returns trigger
language plpgsql
as $$
begin
  if new.owner_email is distinct from old.owner_email and not public.is_admin() and not public.is_service_caller() then
    raise exception 'Only an admin can change who owns a board.' using errcode = '42501';
  end if;
  if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'Who made a board cannot be changed.' using errcode = '42501';
  end if;
  if new.archived is distinct from old.archived then
    perform public.require_perm('boards.archive');
  end if;
  if new.name is distinct from old.name or new.description is distinct from old.description
     or new.colour is distinct from old.colour or new.due_soon_days is distinct from old.due_soon_days
     or new.checklist_presets is distinct from old.checklist_presets then
    perform public.require_perm('boards.manage');
  end if;
  if new.purpose is distinct from old.purpose and not public.is_admin() and not public.is_service_caller() then
    raise exception 'Only an admin can change what a board is for.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger boards_guard before update on public.boards
  for each row execute function public.boards_guard();

-- ---------------------------------------------------------------------------
-- Row security
-- ---------------------------------------------------------------------------
alter table public.boards enable row level security;
alter table public.board_stages enable row level security;
alter table public.board_labels enable row level security;
alter table public.board_shares enable row level security;
alter table public.board_cards enable row level security;
alter table public.board_card_labels enable row level security;
alter table public.board_card_assignees enable row level security;
alter table public.board_checklists enable row level security;
alter table public.board_checklist_items enable row level security;
alter table public.board_comments enable row level security;

-- Boards: made with create_board(); changed by people who manage them.
create policy "Board readers" on public.boards
  for select to authenticated using ((select public.board_can(id, 'view')));
create policy "Board managers" on public.boards
  for update to authenticated
  using ((select public.board_can(id, 'manage')) and (select public.has_any_perm(array['boards.manage', 'boards.archive'])))
  with check ((select public.board_can(id, 'manage')));

create policy "Board readers" on public.board_stages
  for select to authenticated using ((select public.board_can(board_id, 'view')));
create policy "Board managers" on public.board_stages
  for all to authenticated
  using ((select public.board_can(board_id, 'manage')) and (select public.has_perm('boards.manage', 'edit')))
  with check ((select public.board_can(board_id, 'manage')) and (select public.has_perm('boards.manage', 'edit')));

create policy "Board readers" on public.board_labels
  for select to authenticated using ((select public.board_can(board_id, 'view')));
create policy "Board managers" on public.board_labels
  for all to authenticated
  using ((select public.board_can(board_id, 'manage')) and (select public.has_perm('boards.manage', 'edit')))
  with check ((select public.board_can(board_id, 'manage')) and (select public.has_perm('boards.manage', 'edit')));

create policy "Board readers" on public.board_shares
  for select to authenticated using ((select public.board_can(board_id, 'view')));
create policy "Board sharers" on public.board_shares
  for all to authenticated
  using ((select public.board_can(board_id, 'manage')) and (select public.has_perm('boards.share', 'edit')))
  with check ((select public.board_can(board_id, 'manage')) and (select public.has_perm('boards.share', 'edit')));

create policy "Board readers" on public.board_cards
  for select to authenticated using ((select public.board_can(board_id, 'view')));
create policy "Card makers" on public.board_cards
  for insert to authenticated
  with check ((select public.board_can(board_id, 'edit')) and (select public.has_perm('boards.card.create', 'edit')));
-- Which columns may change is checked by board_cards_guard().
create policy "Card editors" on public.board_cards
  for update to authenticated
  using ((select public.board_can(board_id, 'edit'))) with check ((select public.board_can(board_id, 'edit')));

create policy "Board readers" on public.board_card_labels
  for select to authenticated using ((select public.board_can(public.board_of_card(card_id), 'view')));
create policy "Label editors" on public.board_card_labels
  for all to authenticated
  using ((select public.board_can(public.board_of_card(card_id), 'edit')) and (select public.has_perm('boards.card.labels', 'edit')))
  with check ((select public.board_can(public.board_of_card(card_id), 'edit')) and (select public.has_perm('boards.card.labels', 'edit'))
              and exists (select 1 from public.board_labels l where l.id = label_id and l.board_id = public.board_of_card(card_id)));

create policy "Board readers" on public.board_card_assignees
  for select to authenticated using ((select public.board_can(public.board_of_card(card_id), 'view')));
create policy "Assignee editors" on public.board_card_assignees
  for all to authenticated
  using ((select public.board_can(public.board_of_card(card_id), 'edit')) and (select public.has_perm('boards.card.assignees', 'edit')))
  with check ((select public.board_can(public.board_of_card(card_id), 'edit')) and (select public.has_perm('boards.card.assignees', 'edit')));

create policy "Board readers" on public.board_checklists
  for select to authenticated using ((select public.board_can(public.board_of_card(card_id), 'view')));
create policy "Checklist editors" on public.board_checklists
  for all to authenticated
  using ((select public.board_can(public.board_of_card(card_id), 'edit')) and (select public.has_perm('boards.card.checklists', 'edit')))
  with check ((select public.board_can(public.board_of_card(card_id), 'edit')) and (select public.has_perm('boards.card.checklists', 'edit')));

create policy "Board readers" on public.board_checklist_items
  for select to authenticated using ((select public.board_can(public.board_of_checklist(checklist_id), 'view')));
create policy "Task makers" on public.board_checklist_items
  for insert to authenticated
  with check ((select public.board_can(public.board_of_checklist(checklist_id), 'edit')) and (select public.has_perm('boards.card.checklists', 'edit')));
-- Which columns may change is checked by board_items_guard().
create policy "Task editors" on public.board_checklist_items
  for update to authenticated
  using ((select public.board_can(public.board_of_checklist(checklist_id), 'edit')))
  with check ((select public.board_can(public.board_of_checklist(checklist_id), 'edit')));
create policy "Task removers" on public.board_checklist_items
  for delete to authenticated
  using ((select public.board_can(public.board_of_checklist(checklist_id), 'edit')) and (select public.has_perm('boards.card.checklists', 'edit')));

-- Comments: anyone who can open the board and has the comments permission.
create policy "Comment readers" on public.board_comments
  for select to authenticated
  using ((select public.board_can(public.board_of_card(card_id), 'view')) and (select public.has_perm('boards.card.comments', 'view')));
create policy "Comment writers" on public.board_comments
  for insert to authenticated
  with check ((select public.board_can(public.board_of_card(card_id), 'view')) and (select public.has_perm('boards.card.comments', 'edit')));
create policy "Own comments" on public.board_comments
  for update to authenticated
  using (author_email = (select public.current_user_email()) and (select public.has_perm('boards.card.comments', 'edit')))
  with check (author_email = (select public.current_user_email()));
create policy "Own comments: delete" on public.board_comments
  for delete to authenticated
  using (author_email = (select public.current_user_email()) and (select public.has_perm('boards.card.comments', 'edit')));

-- ---------------------------------------------------------------------------
-- Moving cards and stages (renumbers the stage; checked like any update).
-- ---------------------------------------------------------------------------
create or replace function public.move_board_card(p_card uuid, p_stage uuid, p_index integer)
returns void
language plpgsql
as $$
declare
  v_board uuid;
  v_ids   uuid[];
begin
  perform public.require_perm('boards.card.move');
  select board_id into v_board from public.board_cards where id = p_card;
  if v_board is null then
    raise exception 'This card was not found.' using errcode = 'P0002';
  end if;
  perform public.require_board(v_board, 'edit');
  if not exists (select 1 from public.board_stages where id = p_stage and board_id = v_board and not archived) then
    raise exception 'That stage is not on this board.' using errcode = '22023';
  end if;
  select coalesce(array_agg(id order by sort_order, created_at), '{}') into v_ids
    from public.board_cards where stage_id = p_stage and not archived and id <> p_card;
  p_index := greatest(0, least(coalesce(p_index, cardinality(v_ids)), cardinality(v_ids)));
  v_ids := v_ids[1:p_index] || p_card || v_ids[p_index + 1:];
  update public.board_cards c
     set stage_id = p_stage, sort_order = x.pos
    from unnest(v_ids) with ordinality as x(id, pos)
   where c.id = x.id and (c.stage_id is distinct from p_stage or c.sort_order is distinct from x.pos::integer);
end;
$$;

-- p_ids = the board's stages in their new order (first = left).
create or replace function public.reorder_board_stages(p_board uuid, p_ids uuid[])
returns void
language plpgsql
as $$
begin
  perform public.require_perm('boards.manage');
  perform public.require_board(p_board, 'manage');
  update public.board_stages s set sort_order = x.pos
    from unnest(p_ids) with ordinality as x(id, pos)
   where s.id = x.id and s.board_id = p_board;
end;
$$;

-- ===========================================================================
-- 4. Card history
-- ===========================================================================
create table public.board_card_events (
  id          bigint generated always as identity primary key,
  card_id     uuid not null references public.board_cards (id) on delete cascade,
  board_id    uuid not null references public.boards (id) on delete cascade,
  kind        text not null,
  details     jsonb not null default '{}'::jsonb,
  actor_email text,
  actor_name  text,
  created_at  timestamptz not null default now()
);
create index board_card_events_card_idx on public.board_card_events (card_id, created_at);
alter table public.board_card_events enable row level security;
create policy "History readers" on public.board_card_events
  for select to authenticated
  using ((select public.board_can(board_id, 'view')) and (select public.has_perm('boards.card.history', 'view')));

create or replace function public.board_event(p_card uuid, p_kind text, p_details jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.board_card_events (card_id, board_id, kind, details, actor_email, actor_name)
  select p_card, c.board_id, p_kind, coalesce(p_details, '{}'::jsonb), public.current_user_email(), public.current_user_name()
    from public.board_cards c where c.id = p_card;
$$;

-- ===========================================================================
-- 5. Notifications
-- ===========================================================================
-- One row per message for one person. The bell shows them. Email (next
-- prompt) will send the rows whose rule asked for email (email_status).
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_email   text not null references public.allowed_users (email) on delete cascade on update cascade,
  kind         text not null,
  title        text not null,
  body         text,
  link         text,
  board_id     uuid references public.boards (id) on delete cascade,
  card_id      uuid references public.board_cards (id) on delete cascade,
  dedupe_key   text,
  email_status text check (email_status in ('pending', 'sent', 'failed')),
  emailed_at   timestamptz,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index notifications_user_idx on public.notifications (user_email, created_at desc);
create unique index notifications_dedupe_idx on public.notifications (user_email, dedupe_key) where dedupe_key is not null;
alter table public.notifications enable row level security;
create policy "Own notifications" on public.notifications
  for select to authenticated using (user_email = (select public.current_user_email()));
-- Written only by the functions below.

create table public.board_notify_rules (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.boards (id) on delete cascade,
  event       text not null check (event in ('card_created', 'card_moved', 'assigned', 'due_soon', 'overdue', 'comment')),
  stage_id    uuid references public.board_stages (id) on delete cascade,  -- card_moved: only into this stage (empty = any)
  target_type text not null check (target_type in ('user', 'group', 'department', 'everyone', 'assignees')),
  target      text,
  channels    text[] not null default '{app}' check (channels <@ array['app', 'email']),
  created_at  timestamptz not null default now(),
  created_by  text,
  check ((target_type in ('everyone', 'assignees')) = (target is null))
);
create index board_notify_rules_board_idx on public.board_notify_rules (board_id, event);
alter table public.board_notify_rules enable row level security;
create policy "Board readers" on public.board_notify_rules
  for select to authenticated
  using ((select public.board_can(board_id, 'view')) and (select public.has_perm('boards.notifications', 'view')));
create policy "Notification managers" on public.board_notify_rules
  for all to authenticated
  using ((select public.board_can(board_id, 'manage')) and (select public.has_perm('boards.notifications', 'edit')))
  with check ((select public.board_can(board_id, 'manage')) and (select public.has_perm('boards.notifications', 'edit')));

-- Sends a board event to everyone its rules name (who can open the board),
-- never to the person who did it. p_assignees = who "assignees" means here.
create or replace function public.board_notify(
  p_card uuid, p_event text, p_stage uuid, p_title text, p_body text, p_assignees text[], p_dedupe text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board uuid;
  v_me    text := public.current_user_email();
begin
  select board_id into v_board from public.board_cards where id = p_card;
  if v_board is null then return; end if;
  insert into public.notifications (user_email, kind, title, body, link, board_id, card_id, dedupe_key, email_status)
  select r.email, 'board_' || p_event, p_title, p_body,
         '/boards/' || v_board || '?card=' || p_card, v_board, p_card,
         case when p_dedupe is null then null else p_dedupe end,
         case when bool_or(r.email_wanted) then 'pending' end
    from (
      select x.email, 'email' = any(n.channels) as email_wanted
        from public.board_notify_rules n
        cross join lateral (
          select n.target as email where n.target_type = 'user'
          union select m.user_email from public.user_group_members m join public.user_groups g on g.id = m.group_id
                 where n.target_type = 'group' and m.group_id::text = n.target and not g.archived
          union select d.user_email from public.user_departments d
                 where n.target_type = 'department' and d.department_id::text = n.target
          union select a.email from public.allowed_users a where n.target_type = 'everyone'
          union select unnest(coalesce(p_assignees, '{}')) where n.target_type = 'assignees'
        ) x
       where n.board_id = v_board and n.event = p_event
         and (n.stage_id is null or n.stage_id = p_stage)
    ) r
   where r.email is not null
     and r.email is distinct from v_me
     and public.board_access_of(v_board, r.email) > 0
   group by r.email
  on conflict do nothing;
end;
$$;

-- History + notifications for card changes.
create or replace function public.board_cards_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board  text;
  v_assign text[];
  v_from   text;
  v_to     text;
begin
  select name into v_board from public.boards where id = new.board_id;
  select coalesce(array_agg(user_email), '{}') into v_assign from public.board_card_assignees where card_id = new.id;
  if tg_op = 'INSERT' then
    select name into v_to from public.board_stages where id = new.stage_id;
    perform public.board_event(new.id, 'created', jsonb_build_object('title', new.title, 'stage', v_to));
    perform public.board_notify(new.id, 'card_created', new.stage_id,
      'New card in ' || v_board, new.title || ' (' || v_to || ')', v_assign);
    return null;
  end if;
  if new.stage_id is distinct from old.stage_id then
    select name into v_from from public.board_stages where id = old.stage_id;
    select name into v_to from public.board_stages where id = new.stage_id;
    perform public.board_event(new.id, 'moved', jsonb_build_object('from', v_from, 'to', v_to));
    perform public.board_notify(new.id, 'card_moved', new.stage_id,
      'Card moved to ' || v_to || ' · ' || v_board, new.title, v_assign);
  end if;
  if new.title is distinct from old.title then
    perform public.board_event(new.id, 'renamed', jsonb_build_object('old', old.title, 'new', new.title));
  end if;
  if new.description is distinct from old.description then
    perform public.board_event(new.id, 'description', '{}'::jsonb);
  end if;
  if new.due_date is distinct from old.due_date then
    perform public.board_event(new.id, 'due', jsonb_build_object('old', old.due_date, 'new', new.due_date));
  end if;
  if new.order_id is distinct from old.order_id or new.customer_id is distinct from old.customer_id
     or new.machine_id is distinct from old.machine_id then
    perform public.board_event(new.id, 'linked', jsonb_build_object(
      'order', (select order_code from public.orders where id = new.order_id),
      'customer', (select name from public.customers where id = new.customer_id),
      'machine', (select serial_number from public.order_machines where id = new.machine_id)));
  end if;
  if new.started_at is distinct from old.started_at then
    perform public.board_event(new.id, case when new.started_at is null then 'timing_reset' else 'started' end, '{}'::jsonb);
  end if;
  if new.finished_at is distinct from old.finished_at and new.finished_at is not null then
    perform public.board_event(new.id, 'finished', jsonb_build_object('seconds', extract(epoch from new.finished_at - new.started_at)::bigint));
  end if;
  if new.archived is distinct from old.archived then
    perform public.board_event(new.id, case when new.archived then 'archived' else 'restored' end, '{}'::jsonb);
  end if;
  return null;
end;
$$;
create trigger board_cards_events after insert or update on public.board_cards
  for each row execute function public.board_cards_events();

create or replace function public.board_assignees_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.board_card_assignees := case when tg_op = 'DELETE' then old else new end;
  v_name  text := coalesce((select nullif(btrim(name), '') from public.allowed_users where email = v_row.user_email), v_row.user_email);
  v_card  public.board_cards;
begin
  select * into v_card from public.board_cards where id = v_row.card_id;
  if v_card.id is null then return null; end if;
  perform public.board_event(v_row.card_id, case when tg_op = 'DELETE' then 'unassigned' else 'assigned' end,
    jsonb_build_object('email', v_row.user_email, 'name', v_name));
  if tg_op = 'INSERT' then
    perform public.board_notify(v_row.card_id, 'assigned', v_card.stage_id,
      'Card assigned to ' || v_name || ' · ' || (select name from public.boards where id = v_card.board_id),
      v_card.title, array[v_row.user_email]);
  end if;
  return null;
end;
$$;
create trigger board_assignees_events after insert or delete on public.board_card_assignees
  for each row execute function public.board_assignees_events();

create or replace function public.board_labels_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.board_card_labels := case when tg_op = 'DELETE' then old else new end;
begin
  if not exists (select 1 from public.board_cards where id = v_row.card_id) then return null; end if;
  perform public.board_event(v_row.card_id, case when tg_op = 'DELETE' then 'label_removed' else 'label_added' end,
    jsonb_build_object('name', (select name from public.board_labels where id = v_row.label_id)));
  return null;
end;
$$;
create trigger board_labels_events after insert or delete on public.board_card_labels
  for each row execute function public.board_labels_events();

create or replace function public.board_checklists_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.board_checklists := case when tg_op = 'DELETE' then old else new end;
begin
  if not exists (select 1 from public.board_cards where id = v_row.card_id) then return null; end if;
  perform public.board_event(v_row.card_id, case when tg_op = 'DELETE' then 'checklist_removed' else 'checklist_added' end,
    jsonb_build_object('title', v_row.title));
  return null;
end;
$$;
create trigger board_checklists_events after insert or delete on public.board_checklists
  for each row execute function public.board_checklists_events();

create or replace function public.board_items_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid := (select card_id from public.board_checklists where id = new.checklist_id);
begin
  if v_card is null then return null; end if;
  if new.started_at is distinct from old.started_at and new.started_at is not null then
    perform public.board_event(v_card, 'task_started', jsonb_build_object('task', new.item_text));
  end if;
  if new.finished_at is distinct from old.finished_at then
    perform public.board_event(v_card, case when new.finished_at is null then 'task_reopened' else 'task_done' end,
      jsonb_build_object('task', new.item_text,
        'seconds', case when new.finished_at is not null and new.started_at is not null
                        then extract(epoch from new.finished_at - new.started_at)::bigint end));
  end if;
  return null;
end;
$$;
create trigger board_items_events after update on public.board_checklist_items
  for each row execute function public.board_items_events();

create or replace function public.board_comments_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card   public.board_cards;
  v_assign text[];
begin
  select * into v_card from public.board_cards where id = new.card_id;
  select coalesce(array_agg(user_email), '{}') into v_assign from public.board_card_assignees where card_id = new.card_id;
  perform public.board_event(new.card_id, 'comment', jsonb_build_object('excerpt', left(new.body, 120)));
  perform public.board_notify(new.card_id, 'comment', v_card.stage_id,
    new.author_name || ' commented · ' || (select name from public.boards where id = v_card.board_id),
    v_card.title || ': ' || left(new.body, 140), v_assign);
  return null;
end;
$$;
create trigger board_comments_events after insert on public.board_comments
  for each row execute function public.board_comments_events();

-- Due soon / overdue: run by the app every few minutes (and later by a
-- scheduled job). Sends each message once per card and due date.
create or replace function public.board_due_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'America/Halifax')::date;
  v_card  record;
  v_count integer := 0;
begin
  if not public.is_allowed_user() then return 0; end if;
  for v_card in
    select c.id, c.title, c.stage_id, c.due_date, b.name as board_name, b.due_soon_days,
           coalesce((select array_agg(a.user_email) from public.board_card_assignees a where a.card_id = c.id), '{}') as assignees
      from public.board_cards c join public.boards b on b.id = c.board_id
     where not c.archived and not b.archived and c.finished_at is null and c.due_date is not null
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
$$;

-- Bell: mark as read (all when p_ids is empty).
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications set read_at = now()
   where user_email = public.current_user_email() and read_at is null
     and (p_ids is null or id = any(p_ids));
$$;

-- ===========================================================================
-- 6. Templates and making boards
-- ===========================================================================
create table public.board_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (btrim(name) <> ''),
  description text,
  colour      text not null default '#2563eb' check (colour ~ '^#[0-9a-fA-F]{6}$'),
  stages      jsonb not null default '[]'::jsonb check (jsonb_typeof(stages) = 'array'),      -- ["To do", …]
  labels      jsonb not null default '[]'::jsonb check (jsonb_typeof(labels) = 'array'),      -- [{name, colour}]
  checklists  jsonb not null default '[]'::jsonb check (jsonb_typeof(checklists) = 'array'),  -- [{title, items: [text]}]
  archived    boolean not null default false,
  archived_at timestamptz,
  archived_by text,
  created_at  timestamptz not null default now(),
  created_by  text
);
create trigger board_templates_archived before insert or update of archived on public.board_templates
  for each row execute function public.set_archived_info();
alter table public.board_templates enable row level security;
create policy "Allowed users can read" on public.board_templates
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Template admins" on public.board_templates
  for all to authenticated
  using ((select public.can_admin('board_templates'))) with check ((select public.can_admin('board_templates')));

alter table public.boards add constraint boards_template_fk
  foreign key (template_id) references public.board_templates (id) on delete set null;

insert into public.board_templates (name, description, colour, stages, labels, checklists, created_by) values
  ('To do / Doing / Done', 'A simple board for your own work.', '#2563eb',
   '["To do", "Doing", "Done"]',
   '[{"name": "Urgent", "colour": "#dc2626"}, {"name": "Waiting", "colour": "#d97706"}, {"name": "Idea", "colour": "#2563eb"}]',
   '[]', 'database');

-- Makes a board (from a template, or empty). The maker owns it.
create or replace function public.create_board(
  p_name text, p_description text default null, p_colour text default null,
  p_template uuid default null, p_purpose text default 'personal')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id  uuid;
  v_tpl public.board_templates;
  v_me  text := public.current_user_email();
begin
  perform public.require_perm('boards', 'view');
  perform public.require_perm('boards.create');
  if p_purpose <> 'personal' and not public.is_admin() then
    raise exception 'Only an admin can make this kind of board.' using errcode = '42501';
  end if;
  if p_template is not null then
    select * into v_tpl from public.board_templates where id = p_template and not archived;
    if v_tpl.id is null then
      raise exception 'That template was not found.' using errcode = 'P0002';
    end if;
  end if;
  insert into public.boards (name, description, colour, owner_email, purpose, template_id, checklist_presets, created_by)
  values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''),
          coalesce(p_colour, v_tpl.colour, '#2563eb'), v_me, p_purpose, v_tpl.id,
          coalesce(v_tpl.checklists, '[]'::jsonb), v_me)
  returning id into v_id;
  insert into public.board_stages (board_id, name, sort_order)
  select v_id, btrim(s.value #>> '{}'), s.ord
    from jsonb_array_elements(coalesce(v_tpl.stages, '[]'::jsonb)) with ordinality s(value, ord)
   where btrim(s.value #>> '{}') <> '';
  insert into public.board_labels (board_id, name, colour, sort_order)
  select v_id, btrim(l.value ->> 'name'), coalesce(l.value ->> 'colour', '#64748b'), l.ord
    from jsonb_array_elements(coalesce(v_tpl.labels, '[]'::jsonb)) with ordinality l(value, ord)
   where btrim(coalesce(l.value ->> 'name', '')) <> '';
  -- Sensible defaults: tell the people on a card about it.
  insert into public.board_notify_rules (board_id, event, target_type, created_by)
  values (v_id, 'assigned', 'assignees', v_me), (v_id, 'comment', 'assignees', v_me),
         (v_id, 'due_soon', 'assignees', v_me), (v_id, 'overdue', 'assignees', v_me);
  return v_id;
end;
$$;

-- Admin → Board templates: save a board's stages, labels and checklists.
create or replace function public.save_board_as_template(p_board uuid, p_name text, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_b  public.boards;
begin
  perform public.require_admin_area('board_templates');
  perform public.require_board(p_board, 'view');
  select * into v_b from public.boards where id = p_board;
  insert into public.board_templates (name, description, colour, stages, labels, checklists, created_by)
  values (
    btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), v_b.colour,
    coalesce((select jsonb_agg(name order by sort_order, created_at) from public.board_stages
               where board_id = p_board and not archived), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('name', name, 'colour', colour) order by sort_order, created_at)
                from public.board_labels where board_id = p_board and not archived), '[]'::jsonb),
    -- The board's ready-made checklists, then each different checklist used on its cards.
    (select coalesce(jsonb_agg(x.value order by x.src, x.ord), '[]'::jsonb) from (
       select distinct on (lower(btrim(value ->> 'title'))) value, src, ord from (
         select p.value, 0 as src, p.ord from jsonb_array_elements(v_b.checklist_presets) with ordinality p(value, ord)
         union all
         select jsonb_build_object('title', l.title,
                  'items', coalesce((select jsonb_agg(i.item_text order by i.sort_order) from public.board_checklist_items i
                                      where i.checklist_id = l.id), '[]'::jsonb)),
                1, row_number() over (order by c.created_at, l.sort_order)
           from public.board_checklists l join public.board_cards c on c.id = l.card_id
          where c.board_id = p_board and not c.archived
       ) all_lists
       order by lower(btrim(value ->> 'title')), src, ord
     ) x),
    public.current_user_email())
  returning id into v_id;
  perform public.log_admin_action('board_templates', v_id::text, null,
    jsonb_build_object('action', 'board saved as template', 'name', btrim(p_name)));
  return v_id;
end;
$$;

-- People who can open a board (for assignees and "notify a person").
create or replace function public.board_people(p_board uuid)
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.board_can(p_board, 'view') and public.board_access_of(p_board, a.email) > 0
   order by 2;
$$;

-- Everyone who can sign in, for the Share / Notifications / Groups pickers.
create or replace function public.people_choices()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.has_any_perm(array['boards.share', 'boards.notifications', 'admin.groups'])
   order by 2;
$$;

-- ===========================================================================
-- 7. How long tasks take
-- ===========================================================================
create view public.board_task_times
with (security_invoker = true)
as
select 'card'::text as kind, c.board_id, c.id as source_id, lower(btrim(c.title)) as task_key,
       c.started_at, c.finished_at, extract(epoch from c.finished_at - c.started_at)::bigint as seconds
  from public.board_cards c
 where c.started_at is not null and c.finished_at is not null and c.finished_at >= c.started_at
union all
select 'task', k.board_id, i.id, lower(btrim(i.item_text)),
       i.started_at, i.finished_at, extract(epoch from i.finished_at - i.started_at)::bigint
  from public.board_checklist_items i
  join public.board_checklists l on l.id = i.checklist_id
  join public.board_cards k on k.id = l.card_id
 where i.started_at is not null and i.finished_at is not null and i.finished_at >= i.started_at;

-- Admin changes to groups and templates show in Admin → Activity.
create trigger log_activity after insert or update or delete on public.user_groups
  for each row execute function public.log_activity();
create trigger log_activity after insert or delete on public.user_group_members
  for each row execute function public.log_activity();
create trigger log_activity after insert or update or delete on public.board_templates
  for each row execute function public.log_activity();

-- ===========================================================================
-- The boards page can be a start page.
-- ===========================================================================
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/reports/department-delays',
     '/boards', '/agent', '/settings', '/admin', '/shop-board'));

-- Access lockdown, as in earlier migrations.
revoke all on public.user_groups, public.user_group_members, public.boards, public.board_stages, public.board_labels,
  public.board_shares, public.board_cards, public.board_card_labels, public.board_card_assignees, public.board_checklists,
  public.board_checklist_items, public.board_comments, public.board_card_events, public.notifications,
  public.board_notify_rules, public.board_templates, public.board_task_times from anon;
revoke insert, update, delete on public.board_card_events, public.notifications from authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
