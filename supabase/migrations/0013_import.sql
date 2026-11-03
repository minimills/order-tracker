-- 0013_import.sql
-- For scripts/import-sheet.ts (bringing in the old Google Sheet).
-- 1. order_machines.needs_serial: a machine imported without a serial number.
--    It is cleared automatically as soon as a serial is filled in.
-- 2. import_orders(p_orders jsonb): saves every imported order, its customer,
--    machines and payments in ONE transaction: all or nothing.
--    Only admins or the service key (used by the import script) may run it.

-- ===========================================================================
-- 1. needs_serial
-- ===========================================================================
alter table public.order_machines
  add column needs_serial boolean not null default false;

comment on column public.order_machines.needs_serial is
  'Imported without a serial number; an admin must set one (Admin > Serial numbers).';

create or replace function public.order_machines_clear_needs_serial()
returns trigger
language plpgsql
as $$
begin
  if new.serial_number is not null then
    new.needs_serial := false;
  end if;
  return new;
end;
$$;

create trigger order_machines_clear_needs_serial
  before insert or update of serial_number on public.order_machines
  for each row execute function public.order_machines_clear_needs_serial();

-- ===========================================================================
-- 2. import_orders
-- Input: a JSON array, in the order the orders should join the board:
-- [{
--   "order_number": 76, "split_number": null,
--   "customer": {"name": "Jane Fibre", "country": "USA"},
--   "stage": "Shipped", "currency": "CAD", "order_total": 48300,
--   "expected_ship_date": "2026-03-01", "actual_ship_date": "2026-03-04",
--   "voltage": "240V", "delivery_equipment": "Liftgate", "freight_type": "LTL",
--   "notes": "liftgate, LTL",
--   "machines": [{"machine_type_id": "...", "serial_number": "SSM-2010", "ready": true,
--                 "serial_manual": false}],
--   "down_payment": {"amount": 14490, "due_date": "...", "received_date": "..."},
--   "balance": {"due_date": "...", "received_date": "..."},
--   "source_row": 12
-- }, ...]
-- Machines with no serial are saved with needs_serial = true and are left
-- alone by the automatic numbering until an admin sets a serial.
-- Afterwards each machine type's next serial number is set to one above the
-- highest imported number (if that is higher than it is now).
-- Returns a summary: {"orders": n, "customers_created": n, "machines": n, ...}.
-- ===========================================================================
create or replace function public.import_orders(p_orders jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_o            jsonb;
  v_m            jsonb;
  v_customer_id  uuid;
  v_order_id     uuid;
  v_serial       text;
  v_orders       integer := 0;
  v_machines     integer := 0;
  v_customers    integer := 0;
  v_needs_serial integer := 0;
  v_counters     jsonb;
begin
  if not (public.is_admin() or auth.jwt() is null or auth.jwt() ->> 'role' = 'service_role') then
    raise exception 'Only admins can import.';
  end if;
  perform public.lock_board();

  for v_o in select value from jsonb_array_elements(p_orders)
  loop
    -- Customer: reuse one with the same name and country, else create it.
    select c.id into v_customer_id
      from public.customers c
     where lower(btrim(c.name)) = lower(btrim(v_o -> 'customer' ->> 'name'))
       and coalesce(lower(btrim(c.country)), '') = coalesce(lower(btrim(v_o -> 'customer' ->> 'country')), '')
     order by c.archived, c.created_at
     limit 1;
    if v_customer_id is null then
      insert into public.customers (name, country)
      values (btrim(v_o -> 'customer' ->> 'name'), nullif(btrim(v_o -> 'customer' ->> 'country'), ''))
      returning id into v_customer_id;
      v_customers := v_customers + 1;
    end if;

    if exists (select 1 from public.orders
                where order_number = (v_o ->> 'order_number')::integer
                  and split_number is not distinct from nullif(v_o ->> 'split_number', '')::integer) then
      raise exception 'Order % (sheet row %) already exists in the database. Nothing was imported.',
        (v_o ->> 'order_number') || coalesce('-' || nullif(v_o ->> 'split_number', ''), ''), v_o ->> 'source_row';
    end if;

    insert into public.orders (
      order_number, split_number, customer_id, stage, currency, order_total,
      expected_ship_date, actual_ship_date, voltage, delivery_equipment, freight_type, notes
    ) values (
      (v_o ->> 'order_number')::integer,
      nullif(v_o ->> 'split_number', '')::integer,
      v_customer_id,
      v_o ->> 'stage',
      coalesce(nullif(v_o ->> 'currency', ''), 'CAD'),
      coalesce(nullif(v_o ->> 'order_total', '')::numeric, 0),
      nullif(v_o ->> 'expected_ship_date', '')::date,
      nullif(v_o ->> 'actual_ship_date', '')::date,
      coalesce(nullif(v_o ->> 'voltage', ''), 'Unknown'),
      coalesce(nullif(v_o ->> 'delivery_equipment', ''), 'Unknown'),
      nullif(v_o ->> 'freight_type', ''),
      nullif(v_o ->> 'notes', '')
    )
    returning id into v_order_id;
    v_orders := v_orders + 1;

    for v_m in select value from jsonb_array_elements(coalesce(v_o -> 'machines', '[]'::jsonb))
    loop
      v_serial := nullif(btrim(v_m ->> 'serial_number'), '');
      if v_serial is not null and exists (select 1 from public.order_machines where serial_number = v_serial) then
        raise exception 'Serial % (sheet row %) is already used. Nothing was imported.', v_serial, v_m ->> 'source_row';
      end if;
      insert into public.order_machines (order_id, machine_type_id, serial_number, serial_manual, ready, needs_serial, notes)
      values (
        v_order_id,
        (v_m ->> 'machine_type_id')::uuid,
        v_serial,
        -- blank: keep it out of automatic numbering for now;
        -- serial_manual = true: keep this serial exactly (--keep-serials)
        v_serial is null or coalesce((v_m ->> 'serial_manual')::boolean, false),
        coalesce((v_m ->> 'ready')::boolean, false),
        v_serial is null,
        nullif(v_m ->> 'notes', '')
      );
      v_machines := v_machines + 1;
      if v_serial is null then
        v_needs_serial := v_needs_serial + 1;
      end if;
    end loop;

    if v_o -> 'down_payment' is not null and v_o -> 'down_payment' <> 'null'::jsonb then
      insert into public.payments (order_id, payment_type, amount, due_date, received_date, received_amount)
      values (
        v_order_id, 'Down payment',
        coalesce(nullif(v_o -> 'down_payment' ->> 'amount', '')::numeric, 0),
        nullif(v_o -> 'down_payment' ->> 'due_date', '')::date,
        nullif(v_o -> 'down_payment' ->> 'received_date', '')::date,
        case when nullif(v_o -> 'down_payment' ->> 'received_date', '') is not null
             then coalesce(nullif(v_o -> 'down_payment' ->> 'amount', '')::numeric, 0) end
      );
    end if;

    if v_o -> 'balance' is not null and v_o -> 'balance' <> 'null'::jsonb then
      -- The balance amount is calculated by the database (total - down payment).
      insert into public.payments (order_id, payment_type, due_date)
      values (v_order_id, 'Balance', nullif(v_o -> 'balance' ->> 'due_date', '')::date);
      if nullif(v_o -> 'balance' ->> 'received_date', '') is not null then
        update public.payments
           set received_date = (v_o -> 'balance' ->> 'received_date')::date,
               received_amount = amount
         where order_id = v_order_id and payment_type = 'Balance';
      end if;
    end if;
  end loop;

  -- Next serial = one above the highest imported number, per machine type.
  with highest as (
    select mt.id, max(public.serial_number_part(m.serial_number)) as top
      from public.machine_types mt
      join public.order_machines m on m.machine_type_id = mt.id
     where coalesce(mt.code, '') <> '' and m.serial_number like mt.code || '-%'
     group by mt.id
  ), changed as (
    update public.machine_types mt
       set next_serial_number = h.top + 1
      from highest h
     where mt.id = h.id and h.top + 1 > mt.next_serial_number
    returning mt.code, mt.next_serial_number
  )
  select coalesce(jsonb_object_agg(code, next_serial_number), '{}'::jsonb) into v_counters from changed;

  perform public.log_admin_action('orders', null, null, jsonb_build_object(
    'action', 'Imported ' || v_orders || ' orders from the Google Sheet',
    'customers_created', v_customers, 'machines', v_machines, 'needs_serial', v_needs_serial,
    'next_serial_numbers', v_counters));

  return jsonb_build_object('orders', v_orders, 'customers_created', v_customers, 'machines', v_machines,
                            'needs_serial', v_needs_serial, 'next_serial_numbers', v_counters);
end;
$$;

-- Access: same rules as before.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.import_orders(jsonb) to service_role;
