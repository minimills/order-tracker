-- 0020_final_checklists.sql
-- Final checklist for each machine, done while the order is in "Ready"
-- (built, being tested).
--
-- 1. checklist_template_items: the templates. machine_type_id empty = the
--    general list for every machine; otherwise extra items for that type.
--    Edited in Admin → Checklists ("admin.checklists").
-- 2. machine_checklists + machine_checklist_items: one checklist per machine,
--    COPIED from the templates when it is started (later template edits do
--    not change it). Every tick, N/A and note saves straight away, with who
--    and when. Signed = locked; "checklist.unlock" can unlock (logged).
-- 3. Functions: start_checklist, add_checklist_item (one-off item),
--    sign_checklist, unlock_checklist, reorder_checklist_template.
-- 4. View machine_checklist_status: per machine, not started / in progress
--    (done + N/A of total, last worked on by whom and when) / signed.
-- 5. Signatures: small PNG files in the private Storage bucket
--    "checklist-signatures" (max 50 KB).
-- 6. An order can't move to Ready to ship (or Shipped) until every machine's
--    checklist is signed. People with "checklist.override" can move it anyway
--    with a reason (apply_board_change_override), which is logged.
-- 7. order_machines.checklist_done (the board chips) is now set only by
--    signing / unlocking.

-- ===========================================================================
-- Helper: the signed-in person's name (or email) for "who ticked it".
-- ===========================================================================
create or replace function public.current_user_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select nullif(btrim(a.name), '') from public.allowed_users a where a.email = public.current_user_email()),
    public.current_user_email(),
    'database');
$$;

-- ===========================================================================
-- 1. Templates
-- ===========================================================================
create table public.checklist_template_items (
  id              uuid primary key default gen_random_uuid(),
  machine_type_id uuid references public.machine_types (id) on delete cascade,  -- empty = every machine
  section         text not null check (btrim(section) <> ''),
  item_text       text not null check (btrim(item_text) <> ''),
  sort_order      integer not null default 0,
  archived        boolean not null default false,
  archived_at     timestamptz,
  archived_by     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index checklist_template_items_type_idx on public.checklist_template_items (machine_type_id, sort_order);
alter table public.checklist_template_items enable row level security;
create trigger checklist_template_items_updated_at before update on public.checklist_template_items
  for each row execute function public.set_updated_at();
create trigger checklist_template_items_archived_info before insert or update of archived on public.checklist_template_items
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.checklist_template_items
  for each row execute function public.log_activity();

create policy "Checklist users and template editors can read" on public.checklist_template_items
  for select to authenticated
  using ((select public.has_perm('checklist')) or (select public.can_admin('checklists')));
create policy "Template editors can change" on public.checklist_template_items
  for all to authenticated
  using ((select public.can_admin('checklists'))) with check ((select public.can_admin('checklists')));

-- Saves a new order for a list of template items (first id = top).
create or replace function public.reorder_checklist_template(p_ids uuid[])
returns void
language plpgsql
set search_path = public
as $$
begin
  perform public.require_admin_area('checklists');
  update public.checklist_template_items t
     set sort_order = x.pos * 10
    from unnest(p_ids) with ordinality as x(id, pos)
   where t.id = x.id;
end;
$$;

-- ===========================================================================
-- 2. Checklists per machine
-- ===========================================================================
create table public.machine_checklists (
  id                  uuid primary key default gen_random_uuid(),
  machine_id          uuid not null unique references public.order_machines (id) on delete cascade,
  order_id            uuid not null references public.orders (id) on delete cascade,
  started_at          timestamptz not null default now(),
  started_by          text,
  started_by_name     text,
  general_notes       text,
  last_worked_at      timestamptz,
  last_worked_by_name text,
  signed_name         text,      -- the full name typed by the person signing
  signed_at           timestamptz,
  signed_by           text,      -- the email of the account that signed
  signature_path      text,      -- file in the "checklist-signatures" bucket
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index machine_checklists_order_idx on public.machine_checklists (order_id);
alter table public.machine_checklists enable row level security;
create trigger machine_checklists_updated_at before update on public.machine_checklists
  for each row execute function public.set_updated_at();
create trigger log_activity after insert or update or delete on public.machine_checklists
  for each row execute function public.log_activity();

create table public.machine_checklist_items (
  id               uuid primary key default gen_random_uuid(),
  checklist_id     uuid not null references public.machine_checklists (id) on delete cascade,
  template_item_id uuid references public.checklist_template_items (id) on delete set null,
  section          text not null,
  item_text        text not null,
  sort_order       integer not null,
  is_one_off       boolean not null default false,
  added_by_name    text,
  status           text not null default 'open' check (status in ('open', 'done', 'na')),
  status_by_name   text,
  status_at        timestamptz,
  notes            text,
  notes_by_name    text,
  notes_at         timestamptz,
  updated_at       timestamptz not null default now()
);
create index machine_checklist_items_checklist_idx on public.machine_checklist_items (checklist_id, sort_order);
alter table public.machine_checklist_items enable row level security;

-- Reading needs "checklist"; ticking, N/A and notes need "checklist.tick".
-- Starting, one-off items, signing and unlocking go through the functions below.
create policy "Final checks: view" on public.machine_checklists
  for select to authenticated using ((select public.has_perm('checklist')));
create policy "Final checks: general notes" on public.machine_checklists
  for update to authenticated
  using ((select public.has_perm('checklist.tick', 'edit'))) with check ((select public.has_perm('checklist.tick', 'edit')));
create policy "Final checks: view" on public.machine_checklist_items
  for select to authenticated using ((select public.has_perm('checklist')));
create policy "Final checks: tick" on public.machine_checklist_items
  for update to authenticated
  using ((select public.has_perm('checklist.tick', 'edit'))) with check ((select public.has_perm('checklist.tick', 'edit')));

-- People may only change status (done / N/A / open) and notes of an item, and
-- not once the checklist is signed. Who and when are filled in here.
create or replace function public.checklist_items_guard()
returns trigger
language plpgsql
as $$
begin
  if public.is_system_change() then
    return new;
  end if;
  if exists (select 1 from public.machine_checklists c where c.id = old.checklist_id and c.signed_at is not null) then
    raise exception 'This final check is signed and locked. Ask an admin to unlock it.' using errcode = '42501';
  end if;
  if new.checklist_id is distinct from old.checklist_id or new.section is distinct from old.section
     or new.item_text is distinct from old.item_text or new.sort_order is distinct from old.sort_order
     or new.template_item_id is distinct from old.template_item_id or new.is_one_off is distinct from old.is_one_off
     or new.added_by_name is distinct from old.added_by_name then
    raise exception 'Only the tick, N/A and notes of a checklist item can be changed.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if new.status = 'open' then
      new.status_by_name := null;
      new.status_at := null;
    else
      new.status_by_name := public.current_user_name();
      new.status_at := now();
    end if;
  else
    new.status_by_name := old.status_by_name;
    new.status_at := old.status_at;
  end if;
  if new.notes is distinct from old.notes then
    new.notes := nullif(btrim(new.notes), '');
    new.notes_by_name := public.current_user_name();
    new.notes_at := now();
  else
    new.notes_by_name := old.notes_by_name;
    new.notes_at := old.notes_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger checklist_items_guard before update on public.machine_checklist_items
  for each row execute function public.checklist_items_guard();

-- "Last worked on by … on …" after every tick or note.
create or replace function public.checklist_items_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.machine_checklists
     set last_worked_at = now(), last_worked_by_name = public.current_user_name()
   where id = new.checklist_id;
  return null;
end;
$$;
create trigger checklist_items_touch after update on public.machine_checklist_items
  for each row execute function public.checklist_items_touch();

-- People may only change the general notes (and "last worked on") of a
-- checklist, and not once it is signed.
create or replace function public.machine_checklists_guard()
returns trigger
language plpgsql
as $$
begin
  if public.is_system_change() then
    return new;
  end if;
  if old.signed_at is not null then
    raise exception 'This final check is signed and locked. Ask an admin to unlock it.' using errcode = '42501';
  end if;
  if new.machine_id is distinct from old.machine_id or new.order_id is distinct from old.order_id
     or new.started_at is distinct from old.started_at or new.started_by is distinct from old.started_by
     or new.started_by_name is distinct from old.started_by_name
     or new.signed_name is distinct from old.signed_name or new.signed_at is distinct from old.signed_at
     or new.signed_by is distinct from old.signed_by or new.signature_path is distinct from old.signature_path then
    raise exception 'Use the Sign and Unlock buttons to change the sign-off.' using errcode = '42501';
  end if;
  if new.general_notes is distinct from old.general_notes then
    new.general_notes := nullif(btrim(new.general_notes), '');
    new.last_worked_at := now();
    new.last_worked_by_name := public.current_user_name();
  end if;
  return new;
end;
$$;
create trigger machine_checklists_guard before update on public.machine_checklists
  for each row execute function public.machine_checklists_guard();

-- ===========================================================================
-- 3. Functions
-- ===========================================================================

-- Starts a machine's final check (or returns the one already started).
-- The items are copied from the current templates: the general list first,
-- then the extra items for the machine's type.
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
  if not v_m.ready then
    raise exception 'Mark the machine as built first, then start its final check.';
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

-- Adds a one-off item to one machine's checklist.
create or replace function public.add_checklist_item(p_checklist_id uuid, p_section text, p_text text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_perm('checklist.add_item');
  if btrim(coalesce(p_text, '')) = '' then
    raise exception 'Type the item.';
  end if;
  if not exists (select 1 from public.machine_checklists where id = p_checklist_id) then
    raise exception 'That checklist could not be found.';
  end if;
  if exists (select 1 from public.machine_checklists where id = p_checklist_id and signed_at is not null) then
    raise exception 'This final check is signed and locked. Ask an admin to unlock it.';
  end if;
  insert into public.machine_checklist_items (checklist_id, section, item_text, sort_order, is_one_off, added_by_name)
  select p_checklist_id, coalesce(nullif(btrim(p_section), ''), 'Other'), btrim(p_text),
         coalesce(max(sort_order), 0) + 1, true, public.current_user_name()
    from public.machine_checklist_items where checklist_id = p_checklist_id
  returning id into v_id;
  -- Log it on the order's history (one line).
  perform public.log_admin_action('machine_checklists', p_checklist_id::text,
    (select order_id from public.machine_checklists where id = p_checklist_id),
    jsonb_build_object('action', 'final check: one-off item added', 'section', p_section, 'item', btrim(p_text)));
  return v_id;
end;
$$;

-- Signs a final check: every item must be ticked or N/A. Locks it, and marks
-- the machine's final check done (board chips).
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
    raise exception 'Type your full name to sign.';
  end if;
  select count(*) into v_open from public.machine_checklist_items where checklist_id = p_checklist_id and status = 'open';
  if v_open > 0 then
    raise exception '% item% still to tick or mark N/A before signing.', v_open, case when v_open = 1 then ' is' else 's are' end;
  end if;
  if p_signature_path is null or p_signature_path not like p_checklist_id::text || '/%'
     or not exists (select 1 from storage.objects o
                     where o.bucket_id = 'checklist-signatures' and o.name = p_signature_path) then
    raise exception 'The signature was not saved. Sign again.';
  end if;

  perform set_config('app.system_change', 'on', true);
  update public.machine_checklists
     set signed_name = btrim(p_full_name), signed_at = now(), signed_by = public.current_user_email(),
         signature_path = p_signature_path, last_worked_at = now(), last_worked_by_name = public.current_user_name()
   where id = p_checklist_id;
  update public.order_machines set checklist_done = true where id = v_c.machine_id;
end;
$$;

-- Unlocks a signed final check (with a reason, logged). The old signature
-- file is kept.
create or replace function public.unlock_checklist(p_checklist_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c record;
begin
  perform public.require_perm('checklist.unlock');
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Give a reason for unlocking.';
  end if;
  select c.*, om.serial_number into v_c
    from public.machine_checklists c join public.order_machines om on om.id = c.machine_id
   where c.id = p_checklist_id;
  if v_c.id is null then
    raise exception 'That checklist could not be found.';
  end if;
  if v_c.signed_at is null then
    raise exception 'This final check is not signed.';
  end if;
  perform public.log_admin_action('machine_checklists', p_checklist_id::text, v_c.order_id,
    jsonb_build_object('action', 'final check unlocked', 'reason', btrim(p_reason), 'serial', v_c.serial_number,
                       'signed_name', v_c.signed_name, 'signed_at', v_c.signed_at, 'signature_path', v_c.signature_path));
  perform set_config('app.system_change', 'on', true);
  update public.machine_checklists
     set signed_name = null, signed_at = null, signed_by = null, signature_path = null
   where id = p_checklist_id;
  update public.order_machines set checklist_done = false where id = v_c.machine_id;
end;
$$;

-- ===========================================================================
-- 4. Status per machine
-- ===========================================================================
create view public.machine_checklist_status
with (security_invoker = true)
as
select
  om.id                 as machine_id,
  om.order_id,
  om.serial_number,
  mt.name               as machine_type,
  om.ready,
  c.id                  as checklist_id,
  c.started_at,
  c.started_by_name,
  c.last_worked_at,
  c.last_worked_by_name,
  c.signed_at,
  c.signed_name,
  coalesce(i.total, 0)  as total_items,
  coalesce(i.done, 0)   as done_items,
  coalesce(i.na, 0)     as na_items,
  case when c.id is null then 'not_started'
       when c.signed_at is not null then 'signed'
       else 'in_progress' end as status
from public.order_machines om
join public.machine_types mt on mt.id = om.machine_type_id
left join public.machine_checklists c on c.machine_id = om.id
left join lateral (
  select count(*) as total,
         count(*) filter (where x.status = 'done') as done,
         count(*) filter (where x.status = 'na') as na
    from public.machine_checklist_items x
   where x.checklist_id = c.id
) i on true
where not om.archived;

-- Board chips: same as 0019, plus the final check's progress at the end.
create or replace view public.order_machine_status
with (security_invoker = true)
as
select
  om.id,
  om.order_id,
  om.machine_type_id,
  mt.name                                   as machine_type,
  coalesce(nullif(btrim(mt.short_name), ''), mt.name) as short_name,
  om.serial_number,
  om.ready,
  om.checklist_done,
  coalesce(mc.crate_count, 0)               as crate_count,
  om.created_at,
  cs.status                                 as checklist_status,
  cs.total_items                            as checklist_total,
  cs.done_items + cs.na_items               as checklist_completed
from public.order_machines om
join public.machine_types mt on mt.id = om.machine_type_id
left join public.machine_crating mc on mc.machine_id = om.id
left join public.machine_checklist_status cs on cs.machine_id = om.id
where not om.archived;

-- ===========================================================================
-- 5. Signature pictures (Supabase Storage)
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('checklist-signatures', 'checklist-signatures', false, 51200, array['image/png'])
on conflict (id) do update
  set public = false, file_size_limit = 51200, allowed_mime_types = array['image/png'];

create policy "Final check signatures: read" on storage.objects
  for select to authenticated
  using (bucket_id = 'checklist-signatures' and (select public.has_perm('checklist')));
create policy "Final check signatures: upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'checklist-signatures' and (select public.has_perm('checklist.sign', 'edit')));

-- ===========================================================================
-- 6. No Ready to ship without signed final checks
-- ===========================================================================

-- Machines on the order whose final check is not signed ("Carder - Large LCR-2072").
create or replace function public.checklist_gate_problems(p_order_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(mt.name || coalesce(' ' || om.serial_number, '') order by mt.name, om.serial_number), '{}')
    from public.order_machines om
    join public.machine_types mt on mt.id = om.machine_type_id
    left join public.machine_checklists c on c.machine_id = om.id
   where om.order_id = p_order_id
     and not om.archived
     and (c.id is null or c.signed_at is null)
     and (public.is_allowed_user() or public.is_service_caller());
$$;

-- Called by apply_board_change: moving into Ready to ship (or straight to
-- Shipped) needs every machine's final check signed, unless overridden.
create or replace function public.check_checklist_gate(p_order_id uuid, p_stage text)
returns void
language plpgsql
stable
set search_path = public
as $$
declare
  v_stage    text;
  v_problems text[];
begin
  if p_stage is null or p_stage not in ('Ready to ship', 'Shipped') then
    return;
  end if;
  if coalesce(current_setting('app.checklist_gate_off', true), '') = 'on'
     or coalesce(current_setting('app.checklist_override', true), '') <> '' then
    return;
  end if;
  select stage into v_stage from public.orders where id = p_order_id;
  if v_stage in ('Ready to ship', 'Shipped') then
    return;
  end if;
  v_problems := public.checklist_gate_problems(p_order_id);
  if cardinality(v_problems) > 0 then
    raise exception 'Final check not signed yet for: %. Sign them first (or ask an admin to override).',
      array_to_string(v_problems, ', ');
  end if;
end;
$$;

-- apply_board_change (copy of the 0019 version) + the final-check rule.
create or replace function public.apply_board_change(
  p_order_id  uuid,
  p_stage     text default null,
  p_ship_date date default null,
  p_anchor_id uuid default null,
  p_place     text default 'before',
  p_mark_built boolean default false
)
returns table (
  machine_id   uuid,
  order_id     uuid,
  order_code   text,
  machine_type text,
  old_serial   text,
  new_serial   text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before   jsonb;
  v_old      public.orders%rowtype;
  v_new      public.orders%rowtype;
  v_anchor   integer;
  v_current  integer;
  v_target   integer;
  v_changes  jsonb;
begin
  perform public.check_board_change(p_order_id, p_stage, p_anchor_id);
  perform public.check_checklist_gate(p_order_id, p_stage);
  perform public.lock_board();

  select * into v_old from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'That order could not be found.';
  end if;
  if p_stage is not null
     and p_stage not in ('Quote', 'Confirmed', 'In production', 'Ready', 'Ready to ship', 'Shipped', 'Cancelled') then
    raise exception '"%" is not a stage.', p_stage;
  end if;
  if p_place not in ('before', 'after') then
    raise exception 'p_place must be before or after.';
  end if;

  -- Serials of all unbuilt machines before the change.
  select coalesce(jsonb_object_agg(m.id, m.serial_number), '{}') into v_before
    from public.order_machines m where not m.ready;

  -- 0. Mark machines built (they then keep their serials forever).
  if p_mark_built then
    update public.order_machines m set ready = true
     where m.order_id = p_order_id and not m.ready and not m.archived;
  end if;

  -- 1. Stage
  if p_stage is not null and p_stage <> v_old.stage then
    update public.orders o
       set stage = p_stage,
           actual_ship_date = case
             when p_stage = 'Shipped' then coalesce(p_ship_date, o.actual_ship_date,
                                                    (now() at time zone 'America/Halifax')::date)
             when v_old.stage = 'Shipped' then null   -- taken back off Shipped
             else o.actual_ship_date end
     where o.id = p_order_id;
  elsif p_stage = 'Shipped' and p_ship_date is not null then
    update public.orders o set actual_ship_date = p_ship_date where o.id = p_order_id;
  end if;

  -- 2. Place on the board, next to the anchor order.
  if p_anchor_id is not null and p_anchor_id <> p_order_id then
    select o.board_position into v_current from public.orders o where o.id = p_order_id;
    select o.board_position into v_anchor  from public.orders o where o.id = p_anchor_id;
    if v_current is not null and v_anchor is not null then
      if p_place = 'before' then
        v_target := case when v_anchor < v_current then v_anchor else v_anchor - 1 end;
      else
        v_target := case when v_anchor < v_current then v_anchor + 1 else v_anchor end;
      end if;
      if v_target <> v_current then
        perform public.move_board(p_order_id, v_target);
      end if;
    end if;
  end if;

  -- 3. Make sure everything is tidy (also covers stage-only changes).
  perform public.renumber_board();
  perform public.reassign_all_serials();

  select * into v_new from public.orders o where o.id = p_order_id;

  -- 4. Collect the serial changes.
  select coalesce(jsonb_agg(jsonb_build_object(
           'order', x.order_code, 'machine_type', x.type_name,
           'old', x.old_serial, 'new', x.new_serial) order by x.type_name, x.new_serial), '[]')
    into v_changes
    from (
      select o.order_code, mt.name as type_name,
             v_before ->> m.id::text as old_serial, m.serial_number as new_serial
        from public.order_machines m
        join public.orders o on o.id = m.order_id
        join public.machine_types mt on mt.id = m.machine_type_id
       where v_before ? m.id::text
         and (v_before ->> m.id::text) is distinct from m.serial_number
    ) x;

  -- 5. One summary line in the activity log.
  if v_new.stage is distinct from v_old.stage
     or v_new.board_position is distinct from v_old.board_position
     or v_new.actual_ship_date is distinct from v_old.actual_ship_date
     or jsonb_array_length(v_changes) > 0 then
    perform public.log_board_move(p_order_id, jsonb_build_object(
      'order', v_old.order_code,
      'stage', jsonb_build_object('old', v_old.stage, 'new', v_new.stage),
      'board_position', jsonb_build_object('old', v_old.board_position, 'new', v_new.board_position),
      'actual_ship_date', jsonb_build_object('old', v_old.actual_ship_date, 'new', v_new.actual_ship_date),
      'serial_changes', v_changes));
  end if;

  return query
    select m.id, o.id, o.order_code, mt.name, v_before ->> m.id::text, m.serial_number
      from public.order_machines m
      join public.orders o on o.id = m.order_id
      join public.machine_types mt on mt.id = m.machine_type_id
     where v_before ? m.id::text
       and (v_before ->> m.id::text) is distinct from m.serial_number
     order by o.board_position nulls last, o.order_code, mt.name, m.serial_number;
end;
$$;

-- preview_board_change (copy of the 0009 version): previews ignore the rule.
create or replace function public.preview_board_change(
  p_order_id  uuid,
  p_stage     text default null,
  p_ship_date date default null,
  p_anchor_id uuid default null,
  p_place     text default 'before',
  p_mark_built boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_before  jsonb;
  v_result  jsonb;
begin
  select coalesce(jsonb_object_agg(o.id, o.board_position), '{}') into v_before
    from public.orders o where o.board_position is not null;

  begin
    -- The final-check rule is checked when the move is saved, not in the preview
    -- (undone with everything else at the end of this block).
    perform set_config('app.checklist_gate_off', 'on', true);
    select jsonb_build_object(
             'serials', coalesce(jsonb_agg(jsonb_build_object(
                          'order', c.order_code, 'machine_type', c.machine_type,
                          'old', c.old_serial, 'new', c.new_serial)), '[]'::jsonb))
      into v_result
      from public.apply_board_change(p_order_id, p_stage, p_ship_date, p_anchor_id, p_place, p_mark_built) c;

    select v_result || jsonb_build_object('positions', coalesce(jsonb_agg(jsonb_build_object(
             'order', o.order_code,
             'old', (v_before ->> o.id::text)::integer,
             'new', o.board_position) order by o.board_position nulls last), '[]'::jsonb))
      into v_result
      from public.orders o
     where o.board_position is distinct from (v_before ->> o.id::text)::integer;

    -- Undo everything done inside this block.
    raise exception using errcode = 'P0999', message = 'preview only';
  exception
    when sqlstate 'P0999' then
      null;
  end;

  return v_result;
end;
$$;

-- Moves an order although some final checks are not signed, with a reason.
create or replace function public.apply_board_change_override(
  p_order_id  uuid,
  p_stage     text,
  p_reason    text,
  p_ship_date date default null,
  p_anchor_id uuid default null,
  p_place     text default 'before',
  p_mark_built boolean default false
)
returns table (
  machine_id   uuid,
  order_id     uuid,
  order_code   text,
  machine_type text,
  old_serial   text,
  new_serial   text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('checklist.override');
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Give a reason for moving on without signed final checks.';
  end if;
  perform public.log_admin_action('orders', p_order_id::text, p_order_id,
    jsonb_build_object('action', 'final check rule overridden', 'stage', p_stage, 'reason', btrim(p_reason),
                       'not_signed', to_jsonb(public.checklist_gate_problems(p_order_id))));
  perform set_config('app.checklist_override', btrim(p_reason), true);
  return query
    select * from public.apply_board_change(p_order_id, p_stage, p_ship_date, p_anchor_id, p_place, p_mark_built);
end;
$$;

-- ===========================================================================
-- 7. checklist_done is set by signing / unlocking only
-- ===========================================================================
-- check_field_permissions (copy of the 0019 version) without checklist_done:
-- only admins / "admin.records" or the sign / unlock functions change it.
create or replace function public.check_field_permissions()
returns trigger
language plpgsql
as $$
declare
  v_map  jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'archived_at', 'archived_by', 'order_code',
                          'checklist_done_at', 'checklist_done_by'];
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
      'split_number',       'orders.new');
  elsif tg_table_name = 'order_machines' then
    v_map := jsonb_build_object('ready', 'order.machines.built');
  elsif tg_table_name = 'customers' then
    v_map := jsonb_build_object('emails', 'customer.contact', 'phone', 'customer.contact');
  end if;

  if tg_op = 'INSERT' then
    if tg_table_name = 'orders' and coalesce(new.order_total, 0) <> 0 then
      perform public.require_perm('order.field.order_total', 'edit');
    elsif tg_table_name = 'customers'
          and (cardinality(coalesce(new.emails, '{}')) > 0 or nullif(btrim(new.phone), '') is not null) then
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
$$;

-- Access lockdown, as in earlier migrations.
revoke all on public.checklist_template_items, public.machine_checklists, public.machine_checklist_items,
              public.machine_checklist_status, public.order_machine_status from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
