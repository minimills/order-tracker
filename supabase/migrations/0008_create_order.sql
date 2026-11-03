-- 0008_create_order.sql
-- For the New Order form and Settings > Machine types.
-- 1. Hand-typed ("manual") serials: they stay on their machine and are never
--    reshuffled by the board.
-- 2. next_serial() skips any number that is already taken (for example by a
--    hand-typed serial), so it can never hand out a duplicate.
-- 3. create_order(): saves customer, order, machines and payments in ONE
--    step. Either everything is saved or nothing is.
-- 4. machine_type_usage view: how many machines and the highest serial number
--    used per machine type (shown in Settings > Machine types).

-- ===========================================================================
-- 1. Manual serials
-- ===========================================================================
alter table public.order_machines
  add column serial_manual boolean not null default false;

comment on column public.order_machines.serial_manual is
  'True when the serial was typed by hand. Such serials are never reassigned.';

-- Same as 0007, but machines with a hand-typed serial are left alone
-- (like built machines).
create or replace function public.reassign_serials(
  p_machine_type_id uuid,
  p_freed_serials   text[] default '{}'
)
returns table (
  machine_id      uuid,
  order_id        uuid,
  machine_type_id uuid,
  old_serial      text,
  new_serial      text
)
language plpgsql
as $$
declare
  v_code    text;
  v_targets uuid[];
  v_pool    text[];
  v_count   integer;
  i         integer;
begin
  perform public.lock_board();

  select mt.code into v_code from public.machine_types mt where mt.id = p_machine_type_id;
  if coalesce(v_code, '') = '' then
    return;
  end if;

  select coalesce(array_agg(m.id order by o.board_position, m.created_at, m.id), '{}')
    into v_targets
    from public.order_machines m
    join public.orders o on o.id = m.order_id
   where m.machine_type_id = p_machine_type_id
     and not m.ready
     and not m.serial_manual
     and not m.archived
     and o.board_position is not null;

  select coalesce(array_agg(s order by public.serial_number_part(s), s), '{}')
    into v_pool
    from (
      select m.serial_number as s
        from public.order_machines m
        join public.orders o on o.id = m.order_id
       where m.machine_type_id = p_machine_type_id
         and not m.ready
         and not m.serial_manual
         and m.serial_number is not null
         and (   (o.board_position is not null and not m.archived)
              or (o.stage <> 'Shipped'
                  and (m.archived or o.archived or o.stage in ('Quote', 'Cancelled'))))
      union
      select f
        from unnest(p_freed_serials) as f
       where f is not null
         and not exists (select 1 from public.order_machines x where x.serial_number = f)
    ) pool;

  v_count := cardinality(v_targets);
  if cardinality(v_pool) < v_count then
    for i in 1 .. v_count - cardinality(v_pool) loop
      v_pool := v_pool || public.next_serial(p_machine_type_id);
    end loop;
    select array_agg(s order by public.serial_number_part(s), s) into v_pool from unnest(v_pool) as s;
  end if;

  return query
  with mapping as (
    select t.id, p.s as new_serial
      from unnest(v_targets) with ordinality as t(id, n)
      join unnest(v_pool)    with ordinality as p(s, n) on p.n = t.n
    union all
    select m.id, null::text
      from public.order_machines m
      join public.orders o on o.id = m.order_id
     where m.machine_type_id = p_machine_type_id
       and not m.ready
       and not m.serial_manual
       and m.serial_number is not null
       and o.stage <> 'Shipped'
       and (m.archived or o.archived or o.stage in ('Quote', 'Cancelled'))
  )
  update public.order_machines m
     set serial_number = mp.new_serial
    from mapping mp
    join public.order_machines prev on prev.id = mp.id
   where m.id = mp.id
     and m.serial_number is distinct from mp.new_serial
  returning m.id, m.order_id, m.machine_type_id, prev.serial_number, m.serial_number;

  for i in reverse cardinality(v_pool) .. v_count + 1 loop
    exit when not public.give_back_serial(p_machine_type_id, v_pool[i]);
  end loop;
end;
$$;

-- ===========================================================================
-- 2. next_serial() skips numbers that are already taken
-- ===========================================================================
create or replace function public.next_serial(p_machine_type_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_serial text;
begin
  if not public.is_trusted_caller() then
    raise exception 'Not allowed.';
  end if;

  loop
    update public.machine_types
       set next_serial_number = next_serial_number + 1
     where id = p_machine_type_id
       and coalesce(code, '') <> ''
    returning code || '-' || lpad((next_serial_number - 1)::text,
                                  greatest(4, length((next_serial_number - 1)::text)), '0')
      into v_serial;

    if v_serial is null then
      raise exception 'Machine type % does not exist or has no code yet', p_machine_type_id;
    end if;
    exit when not exists (select 1 from public.order_machines x where x.serial_number = v_serial);
  end loop;
  return v_serial;
end;
$$;

-- ===========================================================================
-- 3. create_order(p_order jsonb)
-- Input (JSON):
--   customer_id            existing customer, OR
--   new_customer           {name, company, emails[], country, state_province}
--   order_number           optional; next free number if empty
--   split_of               optional; order number this is a split shipment of
--   stage                  Quote / Confirmed / In production / Ready to ship
--   currency, order_total, expected_ship_date, voltage, delivery_equipment,
--   freight_type, notes
--   machines               [{machine_type_id, serial_number (optional, typed by hand)}]
--   down_payment_amount, down_payment_due_date, balance_due_date
-- Returns {id, order_code}.
-- Runs with the caller's rights, so the normal access rules apply.
-- ===========================================================================
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
    if not exists (select 1 from public.orders where order_number = v_split_of) then
      raise exception 'Order #% does not exist, so this cannot be a split shipment of it.', v_split_of;
    end if;
    -- The original order 76 becomes 76-1; this one becomes 76-2 (or the next free suffix).
    update public.orders set split_number = 1
     where order_number = v_split_of and split_number is null
       and not exists (select 1 from public.orders x where x.order_number = v_split_of and x.split_number = 1);
    select coalesce(max(split_number), 0) + 1 into v_split
      from public.orders where order_number = v_split_of;
    v_number := v_split_of;
  else
    v_number := coalesce(v_number, public.next_order_number());
    if v_number < 1 then
      raise exception 'The order number must be 1 or more.';
    end if;
    if exists (select 1 from public.orders where order_number = v_number) then
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
    insert into public.order_machines (order_id, machine_type_id, serial_number, serial_manual)
    values (v_order_id, (v_machine ->> 'machine_type_id')::uuid, v_serial, v_serial is not null);
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
-- 4. machine_type_usage view
-- ===========================================================================
create or replace view public.machine_type_usage
with (security_invoker = true)
as
select
  mt.id                                                   as machine_type_id,
  count(m.id)                                             as machines_count,
  max(public.serial_number_part(m.serial_number))
    filter (where m.serial_number like mt.code || '-%')   as highest_serial_number
from public.machine_types mt
left join public.order_machines m on m.machine_type_id = mt.id
group by mt.id;

-- Access: same rules as before.
revoke all on public.machine_type_usage from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
