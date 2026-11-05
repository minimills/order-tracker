-- 0019_ready_stage_and_machine_chips.sql
-- 1. New stage "Ready" between "In production" and "Ready to ship": the
--    machines are built and being tested. It is a board stage, so orders in
--    Ready keep their place in the shop queue (and their serial order).
-- 2. Stage names shown in the app can be renamed in Admin → Stage names
--    (app_settings key 'stage_labels', e.g. {"Ready": "Ready / testing"}).
--    The stored value stays "Ready", so nothing else changes.
-- 3. Machine chips on the board: an optional short name per machine type,
--    a "final checklist done" tick per machine, and the view
--    order_machine_status (one row per machine: type, serial, built,
--    checklist, number of crates).

-- ===========================================================================
-- 1. The "Ready" stage
-- ===========================================================================
do $$
declare
  v_name text;
begin
  -- The name of the stage check from 0001 (normally orders_stage_check).
  select conname into v_name
    from pg_constraint
   where conrelid = 'public.orders'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%Ready to ship%';
  if v_name is not null then
    execute format('alter table public.orders drop constraint %I', v_name);
  end if;
end;
$$;
alter table public.orders add constraint orders_stage_check
  check (stage in ('Quote', 'Confirmed', 'In production', 'Ready', 'Ready to ship', 'Shipped', 'Cancelled'));

create or replace function public.is_board_stage(p_stage text)
returns boolean
language sql
immutable
as $$
  select p_stage in ('Confirmed', 'In production', 'Ready', 'Ready to ship');
$$;

-- apply_board_change (copy of the 0018 version): accepts the new stage.
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

-- ===========================================================================
-- 2. Stage names (Admin → Stage names)
-- ===========================================================================
drop policy "Admins can change" on public.app_settings;
create policy "Admins can change" on public.app_settings
  for all to authenticated
  using ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company')))
         or (key = 'stage_labels' and (select public.can_admin('stages'))))
  with check ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company')))
         or (key = 'stage_labels' and (select public.can_admin('stages'))));

-- ===========================================================================
-- 3. Machine chips
-- ===========================================================================
-- Short name for chips, e.g. "Carder L" (empty = use the full name).
alter table public.machine_types
  add column short_name text check (short_name is null or char_length(short_name) <= 30);

-- Final checklist done (per machine). Who and when are filled in automatically.
alter table public.order_machines
  add column checklist_done    boolean not null default false,
  add column checklist_done_at timestamptz,
  add column checklist_done_by text;

create or replace function public.order_machines_checklist_info()
returns trigger
language plpgsql
as $$
begin
  if new.checklist_done and (tg_op = 'INSERT' or not old.checklist_done) then
    new.checklist_done_at := now();
    new.checklist_done_by := coalesce(public.current_user_email(), 'database');
  elsif not new.checklist_done then
    new.checklist_done_at := null;
    new.checklist_done_by := null;
  end if;
  return new;
end;
$$;
create trigger order_machines_checklist_info before insert or update of checklist_done on public.order_machines
  for each row execute function public.order_machines_checklist_info();

-- check_field_permissions (copy of the 0018 version): the checklist tick needs
-- "order.machines.checklist" edit.
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
    v_map := jsonb_build_object('ready', 'order.machines.built', 'checklist_done', 'order.machines.checklist');
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

-- One row per (not archived) machine, for the chips on the board.
create view public.order_machine_status
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
  om.created_at
from public.order_machines om
join public.machine_types mt on mt.id = om.machine_type_id
left join public.machine_crating mc on mc.machine_id = om.id
where not om.archived;

-- Access lockdown, as in earlier migrations.
revoke all on public.order_machine_status from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
