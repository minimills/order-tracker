-- 0028: Cancelled orders give their number back, and their production board is archived.
--
-- When an order is cancelled it becomes "C-<old number>" (for example C-56) and
-- every later order moves down by one number (57 -> 56, 58 -> 57 ...), so the
-- numbers have no gaps. If the last order is cancelled, its number is used again
-- by the next new order. An order taken out of Cancelled gets the next new number.
-- Orders that were already cancelled before this migration keep their numbers.
--
-- Paste this whole file into the Supabase SQL Editor and click Run.

-- ===========================================================================
-- 1. Columns
-- ===========================================================================
alter table public.orders add column cancelled_code text;
create unique index orders_cancelled_code_idx on public.orders (cancelled_code) where cancelled_code is not null;
grant select (cancelled_code) on public.orders to authenticated;

-- order_code was worked out from order_number + split_number by the database;
-- it is now kept up to date by a trigger, so a cancelled order can show C-56.
alter table public.orders alter column order_code drop expression;

-- Order numbers only have to be unique among orders that are not cancelled.
alter table public.orders drop constraint orders_number_unique;
create unique index orders_number_unique on public.orders (order_number, split_number) nulls not distinct
  where cancelled_code is null;

-- Cancelled orders do not hold on to the highest number.
create or replace function public.next_order_number()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(order_number), 0) + 1 from public.orders where cancelled_code is null;
$$;

-- ===========================================================================
-- 2. Order code, cancelling and bringing back (runs after the other checks)
-- ===========================================================================
create or replace function public.orders_zz_number_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_code text;
  n      integer := 1;
begin
  if tg_op = 'UPDATE' then
    if new.stage = 'Cancelled' and old.stage <> 'Cancelled' and old.cancelled_code is null then
      v_base := 'C-' || old.order_code;
      v_code := v_base;
      while exists (select 1 from public.orders where cancelled_code = v_code and id <> new.id) loop
        n := n + 1;
        v_code := v_base || ' (' || n || ')';
      end loop;
      new.cancelled_code := v_code;
    elsif old.stage = 'Cancelled' and new.stage <> 'Cancelled' and old.cancelled_code is not null then
      -- Brought back: it gets the next new number, like a new order.
      perform pg_advisory_xact_lock(7605002);
      new.cancelled_code := null;
      new.order_number := public.next_order_number();
      new.split_number := null;
    end if;
  end if;
  new.order_code := coalesce(new.cancelled_code, new.order_number::text || coalesce('-' || new.split_number::text, ''));
  return new;
end;
$$;

create trigger orders_zz_number_code before insert or update on public.orders
  for each row execute function public.orders_zz_number_code();

-- Later orders move down by one number when an order is cancelled.
create or replace function public.orders_cancel_renumber()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_moved jsonb;
  v_prev  text := coalesce(current_setting('app.renumbering', true), '');
begin
  if new.cancelled_code is null or old.cancelled_code is not null then
    return null;
  end if;
  -- A split shipment (76-1) whose other part (76-2) is still active keeps 76 in use.
  if exists (select 1 from public.orders o
              where o.order_number = old.order_number and o.cancelled_code is null and o.id <> new.id) then
    return null;
  end if;
  perform public.lock_board();
  perform pg_advisory_xact_lock(7605002);
  perform set_config('app.renumbering', 'on', true);

  select coalesce(jsonb_agg(jsonb_build_object('old', o.order_code,
           'new', (o.order_number - 1)::text || coalesce('-' || o.split_number::text, ''))
           order by o.order_number, o.split_number nulls first), '[]'::jsonb)
    into v_moved
    from public.orders o
   where o.order_number > old.order_number and o.cancelled_code is null;

  -- Two steps so no two orders share a number in between.
  update public.orders set order_number = order_number + 1000000
   where order_number > old.order_number and cancelled_code is null;
  update public.orders set order_number = order_number - 1000001
   where order_number > 1000000 and cancelled_code is null;

  perform set_config('app.renumbering', v_prev, true);

  insert into public.activity_log (user_id, user_email, table_name, record_id, order_id, action, changes)
  values (auth.uid(), auth.jwt() ->> 'email', 'orders', new.id::text, new.id, 'admin',
          jsonb_build_object('action', 'order cancelled: order ' || old.order_code || ' is now ' || new.cancelled_code
                               || case when jsonb_array_length(v_moved) > 0
                                       then '; ' || jsonb_array_length(v_moved) || ' later order(s) moved down by one number'
                                       else '' end,
                             'order_numbers', v_moved));
  return null;
end;
$$;

create trigger orders_cancel_renumber after update of stage on public.orders
  for each row execute function public.orders_cancel_renumber();

-- The moved orders do not each get their own activity line (one summary line instead).
create or replace function public.log_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_row     jsonb;
  v_changes jsonb;
begin
  if tg_table_name = 'orders' and tg_op = 'UPDATE'
     and coalesce(current_setting('app.renumbering', true), '') = 'on' then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old) - 'updated_at'; end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new) - 'updated_at'; end if;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', v_old -> n.key, 'new', n.value))
      into v_changes
      from jsonb_each(v_new) as n
     where n.value is distinct from (v_old -> n.key);
    if v_changes is null then
      return null;  -- nothing really changed
    end if;
  else
    v_changes := v_row;
  end if;

  insert into public.activity_log (user_id, user_email, table_name, record_id, order_id, action, changes)
  values (
    auth.uid(),
    auth.jwt() ->> 'email',
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'email'),
    case when tg_table_name = 'orders' then (v_row ->> 'id')::uuid
         else (v_row ->> 'order_id')::uuid end,
    lower(tg_op),
    v_changes
  );
  return null;
end;
$$;

-- ===========================================================================
-- 3. Production boards: archived with a cancelled or archived order, brought
--    back with it, and renamed when the order number changes
-- ===========================================================================
-- boards_guard (copy of the 0023 version): the app's own routines (archiving or
-- renaming a production board with its order) pass.
create or replace function public.boards_guard()
returns trigger
language plpgsql
as $$
begin
  if public.is_system_change() then
    return new;
  end if;
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

create or replace function public.orders_production_board()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('app.system_change', true), '');
  v_live boolean := public.is_board_stage(new.stage) and not new.archived;
begin
  if tg_op = 'UPDATE' and exists (select 1 from public.boards where order_id = new.id and purpose = 'production') then
    perform public.system_on();
    -- Cancelled or archived: the board is archived too. Back in the queue: restored.
    if (new.stage = 'Cancelled' or new.archived) then
      update public.boards set archived = true where order_id = new.id and purpose = 'production' and not archived;
    elsif v_live then
      update public.boards set archived = false where order_id = new.id and purpose = 'production' and archived;
    end if;
    if new.order_code is distinct from old.order_code then
      update public.boards b
         set name = 'Order ' || new.order_code || coalesce(' · ' || (select c.name from public.customers c where c.id = new.customer_id), ''),
             description = 'Production board for order ' || new.order_code || '.'
       where b.order_id = new.id and b.purpose = 'production';
    end if;
    perform set_config('app.system_change', v_prev, true);
  elsif v_live and not exists (select 1 from public.boards where order_id = new.id and purpose = 'production') then
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

drop trigger orders_production_board on public.orders;
create trigger orders_production_board after insert or update of stage, archived, expected_ship_date, order_number, split_number on public.orders
  for each row execute function public.orders_production_board();

-- Boards of orders already cancelled or archived.
do $$
begin
  perform public.system_on();
  update public.boards b set archived = true
    from public.orders o
   where o.id = b.order_id and b.purpose = 'production' and not b.archived
     and (o.stage = 'Cancelled' or o.archived);
  perform set_config('app.system_change', '', true);
end $$;

-- ===========================================================================
-- 4. New orders: cancelled orders do not block their old number
-- ===========================================================================
-- create_order (copy of the 0022 version): number checks skip cancelled orders.
create or replace function public.create_order(p_order jsonb)
returns jsonb
language plpgsql
as $$
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
    expected_ship_date, voltage, delivery_equipment, freight_type, notes
  ) values (
    v_number, v_split, v_customer_id,
    coalesce(nullif(p_order ->> 'stage', ''), 'Confirmed'),
    coalesce(nullif(p_order ->> 'currency', ''), 'CAD'),
    v_total,
    nullif(p_order ->> 'expected_ship_date', '')::date,
    coalesce(nullif(p_order ->> 'voltage', ''), 'Unknown'),
    coalesce(nullif(p_order ->> 'delivery_equipment', ''), 'Unknown'),
    nullif(p_order ->> 'freight_type', ''),
    nullif(btrim(p_order ->> 'notes'), '')
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
$$;

-- ===========================================================================
-- 5. The move preview also lists order numbers that change
-- ===========================================================================
-- preview_board_change (copy of the 0020 version).
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
  v_codes   jsonb;
begin
  select coalesce(jsonb_object_agg(o.id, o.board_position), '{}') into v_before
    from public.orders o where o.board_position is not null;
  select coalesce(jsonb_object_agg(o.id, o.order_code), '{}') into v_codes from public.orders o;

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
             'order', coalesce(v_codes ->> o.id::text, o.order_code),
             'old', (v_before ->> o.id::text)::integer,
             'new', o.board_position) order by o.board_position nulls last), '[]'::jsonb))
      into v_result
      from public.orders o
     where o.board_position is distinct from (v_before ->> o.id::text)::integer;

    -- Order numbers that change (cancelling moves later orders down by one).
    select v_result || jsonb_build_object('numbers', coalesce(jsonb_agg(jsonb_build_object(
             'old', v_codes ->> o.id::text, 'new', o.order_code)
             order by o.order_number, o.split_number nulls first), '[]'::jsonb))
      into v_result
      from public.orders o
     where o.order_code is distinct from (v_codes ->> o.id::text);

    -- Undo everything done inside this block.
    raise exception using errcode = 'P0999', message = 'preview only';
  exception
    when sqlstate 'P0999' then
      null;
  end;

  return v_result;
end;
$$;

-- Access lockdown, as in earlier migrations.
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
