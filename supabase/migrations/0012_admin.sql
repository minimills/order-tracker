-- 0012_admin.sql
-- The Admin area. Everything here is checked by the database, so a staff
-- user cannot do these things even by calling the database directly.
-- 1. Tighter reading rules: staff see only their own row in allowed_users,
--    and only order-related lines in activity_log.
-- 2. A guard: only admins (or the app's own board/serial routines) may change
--    board numbers, serial numbers, order numbers or an order's customer.
-- 3. Admin functions: edit a serial, re-sequence serials, set a board
--    number, renumber the board, permanently delete an archived record.
--    Each one checks is_admin() and writes an 'admin' line to activity_log.
-- 4. Company details for printouts (app_settings key 'company').

-- ===========================================================================
-- 1. Reading rules
-- ===========================================================================
drop policy "Allowed users can read" on public.allowed_users;
create policy "Users see themselves, admins see everyone" on public.allowed_users
  for select to authenticated
  using (email = (select public.current_user_email()) or (select public.is_admin()));

drop policy "Allowed users can read" on public.activity_log;
create policy "Admins read all, staff read order history" on public.activity_log
  for select to authenticated
  using ((select public.is_admin()) or (order_id is not null and (select public.is_allowed_user())));

-- ===========================================================================
-- 2. Guard for admin-only fields
-- ===========================================================================

-- The board and serial routines switch this on for the rest of their
-- transaction, so the changes they make are allowed for staff too.
create or replace function public.lock_board()
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(7605001);
  perform set_config('app.system_change', 'on', true);
end;
$$;

create or replace function public.is_system_change()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.system_change', true), '') = 'on';
$$;

-- Named "aa_…" so it runs before the other triggers and sees exactly what
-- the person asked to change.
create or replace function public.guard_admin_fields()
returns trigger
language plpgsql
as $$
begin
  if public.is_admin() or public.is_system_change()
     or auth.jwt() is null or auth.jwt() ->> 'role' = 'service_role' then
    return new;  -- admins, the app's own routines, the Supabase dashboard and automatic jobs
  end if;
  if tg_table_name = 'orders' then
    if new.board_position is distinct from old.board_position then
      raise exception 'Only admins can change a board number by hand. Move the order on the board instead.';
    end if;
    if new.order_number is distinct from old.order_number
       -- the New Order form turns 76 into 76-1 when adding a split shipment
       or (new.split_number is distinct from old.split_number
           and not (old.split_number is null and new.split_number = 1)) then
      raise exception 'Only admins can change an order number.';
    end if;
    if new.customer_id is distinct from old.customer_id then
      raise exception 'Only admins can move an order to a different customer.';
    end if;
  elsif tg_table_name = 'order_machines' then
    if new.serial_number is distinct from old.serial_number
       or new.serial_manual is distinct from old.serial_manual then
      raise exception 'Only admins can change a serial number by hand.';
    end if;
  end if;
  return new;
end;
$$;

create trigger aa_guard_admin_fields before update on public.orders
  for each row execute function public.guard_admin_fields();
create trigger aa_guard_admin_fields before update on public.order_machines
  for each row execute function public.guard_admin_fields();

-- ===========================================================================
-- 3. Admin functions
-- ===========================================================================
alter table public.activity_log drop constraint activity_log_action_check;
alter table public.activity_log
  add constraint activity_log_action_check check (action in ('insert', 'update', 'delete', 'move', 'admin'));

create or replace function public.require_admin()
returns void
language plpgsql
as $$
begin
  if not public.is_admin() and auth.jwt() is not null then
    raise exception 'Only admins can do this.';
  end if;
end;
$$;

-- One summary line in activity_log for an admin action.
create or replace function public.log_admin_action(p_table text, p_record text, p_order_id uuid, p_changes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_trusted_caller() then
    raise exception 'Not allowed.';
  end if;
  insert into public.activity_log (user_id, user_email, table_name, record_id, order_id, action, changes)
  values (auth.uid(), auth.jwt() ->> 'email', p_table, p_record, p_order_id, 'admin', p_changes);
end;
$$;

-- Board numbers and unbuilt serials right now, to compare before/after.
create or replace function public.board_snapshot()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'positions', coalesce((select jsonb_object_agg(o.id, o.board_position) from public.orders o
                            where o.board_position is not null), '{}'::jsonb),
    'serials',   coalesce((select jsonb_object_agg(m.id, m.serial_number) from public.order_machines m), '{}'::jsonb));
$$;

-- What changed since a snapshot: {"positions": [...], "serials": [...]}.
create or replace function public.board_diff(p_before jsonb)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'positions', coalesce((
      select jsonb_agg(jsonb_build_object('order', o.order_code,
                                          'old', (p_before -> 'positions' ->> o.id::text)::integer,
                                          'new', o.board_position)
                       order by o.board_position nulls last, o.order_code)
        from public.orders o
       where o.board_position is distinct from (p_before -> 'positions' ->> o.id::text)::integer), '[]'::jsonb),
    'serials', coalesce((
      select jsonb_agg(jsonb_build_object('order', o.order_code, 'machine_type', mt.name,
                                          'old', p_before -> 'serials' ->> m.id::text,
                                          'new', m.serial_number)
                       order by o.board_position nulls last, o.order_code, mt.name)
        from public.order_machines m
        join public.orders o on o.id = m.order_id
        join public.machine_types mt on mt.id = m.machine_type_id
       where p_before -> 'serials' ? m.id::text
         and (p_before -> 'serials' ->> m.id::text) is distinct from m.serial_number), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- admin_board_change(order, position, apply)
--   order + position: put that order at that board number.
--   order = null:     "Renumber all" – tidy board numbers 1..N and re-check
--                     every unbuilt serial.
--   apply = false:    preview only (nothing is saved).
-- Returns {"positions": [...], "serials": [...]}.
-- ---------------------------------------------------------------------------
create or replace function public.admin_board_change(p_order_id uuid, p_position integer, p_apply boolean)
returns jsonb
language plpgsql
as $$
declare
  v_before jsonb;
  v_result jsonb;
  v_code   text;
begin
  perform public.require_admin();
  perform public.lock_board();
  v_before := public.board_snapshot();
  begin
    if p_order_id is null then
      perform public.renumber_board();
      perform public.reassign_all_serials();
    else
      if p_position is null or p_position < 1 then
        raise exception 'Enter a board number of 1 or more.';
      end if;
      perform public.move_board(p_order_id, p_position);
    end if;
    v_result := public.board_diff(v_before);
    if not p_apply then
      raise exception using errcode = 'P0999', message = 'preview only';
    end if;
  exception
    when sqlstate 'P0999' then null;
  end;

  if p_apply and (jsonb_array_length(v_result -> 'positions') > 0 or jsonb_array_length(v_result -> 'serials') > 0) then
    select order_code into v_code from public.orders where id = p_order_id;
    perform public.log_admin_action('orders', p_order_id::text, p_order_id,
      jsonb_build_object('action', case when p_order_id is null then 'Renumber all board numbers'
                                        else 'Set board number of order ' || v_code || ' to ' || p_position end)
      || v_result);
  end if;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_serial(machine, serial)
-- Sets one serial by hand (it then never moves), or clears it (empty) so the
-- machine gets an automatic serial again. Checked for duplicates.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_serial(p_machine_id uuid, p_serial text)
returns void
language plpgsql
as $$
declare
  v_m      public.order_machines%rowtype;
  v_serial text := upper(nullif(btrim(p_serial), ''));
  v_taken  text;
begin
  perform public.require_admin();
  perform public.lock_board();

  select * into v_m from public.order_machines where id = p_machine_id;
  if not found then
    raise exception 'That machine could not be found.';
  end if;

  if v_serial is not null then
    select o.order_code into v_taken
      from public.order_machines m join public.orders o on o.id = m.order_id
     where m.serial_number = v_serial and m.id <> p_machine_id;
    if found then
      raise exception 'Serial % is already used (order %).', v_serial, v_taken;
    end if;
  end if;

  update public.order_machines
     set serial_number = v_serial,
         serial_manual = v_serial is not null
   where id = p_machine_id;

  -- Let automatic numbering fill in / tidy up around this change.
  perform public.reassign_serials(v_m.machine_type_id,
            case when v_m.serial_number is not null and v_m.serial_number is distinct from v_serial
                 then array[v_m.serial_number] else '{}'::text[] end);

  perform public.log_admin_action('order_machines', p_machine_id::text, v_m.order_id,
    jsonb_build_object('action', 'Serial set by hand',
                       'serial_number', jsonb_build_object('old', v_m.serial_number,
                         'new', (select serial_number from public.order_machines where id = p_machine_id))));
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_resequence_serials(machine type, start number, apply)
-- Gives the unbuilt, automatically numbered machines of one type (on the
-- board, in board order) consecutive serials starting at p_start, then sets
-- the type's next serial number after the highest automatic or built serial
-- in use. Built and hand-typed serials are not touched.
-- Returns one row per machine: old -> new (preview when apply = false).
-- ---------------------------------------------------------------------------
create or replace function public.admin_resequence_serials(p_machine_type_id uuid, p_start integer, p_apply boolean)
returns table (machine_id uuid, order_code text, board_position integer, old_serial text, new_serial text)
language plpgsql
as $$
declare
  v_code     text;
  v_map      jsonb;
  v_conflict text;
  v_next     integer;
begin
  perform public.require_admin();
  perform public.lock_board();

  select mt.code into v_code from public.machine_types mt where mt.id = p_machine_type_id;
  if coalesce(v_code, '') = '' then
    raise exception 'This machine type has no code, so it has no serial numbers.';
  end if;
  if p_start is null or p_start < 1 then
    raise exception 'Enter a starting number of 1 or more.';
  end if;

  -- Old -> new for every machine to renumber, in board order.
  select coalesce(jsonb_agg(jsonb_build_object(
           'machine_id', t.id, 'order_code', t.order_code, 'board_position', t.board_position,
           'old_serial', t.serial_number,
           'new_serial', v_code || '-' || lpad((p_start + t.rn - 1)::text,
                                               greatest(4, length((p_start + t.rn - 1)::text)), '0'))
         order by t.rn), '[]'::jsonb)
    into v_map
    from (select m.id, m.serial_number, o.order_code, o.board_position,
                 row_number() over (order by o.board_position, m.created_at, m.id) as rn
            from public.order_machines m
            join public.orders o on o.id = m.order_id
           where m.machine_type_id = p_machine_type_id
             and not m.ready and not m.serial_manual and not m.archived
             and o.board_position is not null) t;

  -- A new serial must not belong to any other machine.
  select string_agg(x.serial_number || ' (order ' || o.order_code || ')', ', ')
    into v_conflict
    from public.order_machines x
    join public.orders o on o.id = x.order_id
   where x.serial_number in (select e ->> 'new_serial' from jsonb_array_elements(v_map) e)
     and x.id not in (select (e ->> 'machine_id')::uuid from jsonb_array_elements(v_map) e);
  if v_conflict is not null then
    raise exception 'These serials are already used by built or hand-typed machines: %. Choose another starting number.', v_conflict;
  end if;

  if p_apply then
    update public.order_machines m
       set serial_number = r.new_serial
      from jsonb_to_recordset(v_map) as r(machine_id uuid, new_serial text)
     where m.id = r.machine_id and m.serial_number is distinct from r.new_serial;

    select greatest(p_start + jsonb_array_length(v_map),
                    coalesce(max(public.serial_number_part(x.serial_number)) + 1, 1))
      into v_next
      from public.order_machines x
     where x.machine_type_id = p_machine_type_id and x.serial_number like v_code || '-%'
       and not x.serial_manual;  -- odd hand-typed serials don't move the counter
    update public.machine_types set next_serial_number = v_next where id = p_machine_type_id;

    perform public.log_admin_action('machine_types', p_machine_type_id::text, null,
      jsonb_build_object('action', 'Re-sequenced ' || v_code || ' serials from ' || p_start,
                         'next_serial_number', v_next,
                         'serial_changes', (select coalesce(jsonb_agg(jsonb_build_object(
                             'order', e ->> 'order_code', 'old', e ->> 'old_serial', 'new', e ->> 'new_serial')), '[]'::jsonb)
                           from jsonb_array_elements(v_map) e
                          where (e ->> 'old_serial') is distinct from (e ->> 'new_serial'))));
  end if;

  return query
    select r.machine_id, r.order_code, r.board_position, r.old_serial, r.new_serial
      from jsonb_to_recordset(v_map) as r(machine_id uuid, order_code text, board_position integer,
                                          old_serial text, new_serial text);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_delete_record(table, id, confirm)
-- Permanently deletes an ARCHIVED order, customer or machine. p_confirm must
-- be the word DELETE. An order's machines and payments go with it.
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_record(p_table text, p_id uuid, p_confirm text)
returns void
language plpgsql
as $$
declare
  v_label    text;
  v_archived boolean;
  v_order_id uuid;
begin
  perform public.require_admin();
  if p_confirm is distinct from 'DELETE' then
    raise exception 'Type DELETE (in capitals) to confirm.';
  end if;

  if p_table = 'orders' then
    select archived, 'Order ' || order_code into v_archived, v_label from public.orders where id = p_id;
  elsif p_table = 'customers' then
    select archived, 'Customer ' || name into v_archived, v_label from public.customers where id = p_id;
    if exists (select 1 from public.orders where customer_id = p_id) then
      raise exception '% still has orders. Delete those orders first.', v_label;
    end if;
  elsif p_table = 'order_machines' then
    select m.archived, 'Machine ' || coalesce(m.serial_number, '(no serial)') || ' on order ' || o.order_code, m.order_id
      into v_archived, v_label, v_order_id
      from public.order_machines m join public.orders o on o.id = m.order_id where m.id = p_id;
  else
    raise exception 'Only orders, customers and machines can be deleted here.';
  end if;

  if v_archived is null then
    raise exception 'That record could not be found.';
  end if;
  if not v_archived then
    raise exception 'Archive it first. Only archived records can be deleted permanently.';
  end if;

  perform public.log_admin_action(p_table, p_id::text, case when p_table = 'orders' then p_id else v_order_id end,
    jsonb_build_object('action', 'Deleted permanently: ' || v_label));
  execute format('delete from public.%I where id = $1', p_table) using p_id;
end;
$$;

-- ===========================================================================
-- 4. Company details for printouts
-- ===========================================================================
insert into public.app_settings (key, value)
values ('company', '{"name": "Belfast Mini Mills", "address": "", "phone": "", "email": "", "website": "", "logo": null}'::jsonb)
on conflict (key) do nothing;

-- Access: same rules as before.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
