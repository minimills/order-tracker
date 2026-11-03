-- 0014_import_page.sql
-- For Admin > Import (the import page in the browser).
-- import_sheet(p_orders, p_skipped) replaces import_orders from 0013:
-- * new orders are created; an order number that already exists is UPDATED
--   instead of duplicated;
-- * when updating, empty cells never erase what the app has, "Unknown" never
--   overwrites a known voltage / delivery equipment, built machines stay built
--   and received payments stay received;
-- * machines of an existing order are matched by serial number, otherwise by
--   machine type; unmatched rows are added as new machines;
-- * afterwards each machine type's next serial is set one above the highest
--   imported number, and one summary line goes to activity_log.
-- Everything runs in one transaction: all or nothing. Admins only.
--
-- p_orders: JSON array, in the order new orders should join the board:
-- [{"order_number": 74, "split_number": 1,
--   "customer": {"name": "Taproot", "country": "Canada", "state_province": "NS"},
--   "stage": "Shipped", "currency": "CAD", "order_total": 48300,
--   "expected_ship_date": "2026-07-31", "actual_ship_date": "2026-08-21",
--   "voltage": "120V", "delivery_equipment": "No liftgate", "freight_type": null,
--   "notes": "No liftgate",
--   "machines": [{"machine_type_id": "...", "serial_number": "SKH-0102", "serial_manual": true,
--                 "ready": true, "notes": null, "source_row": 58}],
--   "down_payment": {"amount": 12006.5, "due_date": null, "received_date": "2026-08-10", "received_amount": null},
--   "balance": {"due_date": null, "received_date": null, "received_amount": null},
--   "source_row": 57}, ...]

drop function if exists public.import_orders(jsonb);

create or replace function public.import_sheet(p_orders jsonb, p_skipped integer default 0)
returns jsonb
language plpgsql
as $$
declare
  v_o              jsonb;
  v_m              jsonb;
  v_dp             jsonb;
  v_bal            jsonb;
  v_customer_id    uuid;
  v_order_id       uuid;
  v_old            public.orders%rowtype;
  v_match          uuid;
  v_new_machine    uuid;
  v_used           uuid[];
  v_serial         text;
  v_owner          text;
  v_pay_id         uuid;
  v_stage          text;
  v_orders_new     integer := 0;
  v_orders_upd     integer := 0;
  v_customers      integer := 0;
  v_machines_new   integer := 0;
  v_machines_upd   integer := 0;
  v_payments_new   integer := 0;
  v_payments_upd   integer := 0;
  v_needs_serial   integer := 0;
  v_counters       jsonb;
  v_summary        jsonb;
begin
  perform public.require_admin();
  perform public.lock_board();

  for v_o in select value from jsonb_array_elements(p_orders)
  loop
    -- ---------- Customer ----------
    v_customer_id := null;
    if coalesce(btrim(v_o -> 'customer' ->> 'name'), '') <> '' then
      select c.id into v_customer_id
        from public.customers c
       where lower(btrim(c.name)) = lower(btrim(v_o -> 'customer' ->> 'name'))
         and coalesce(lower(btrim(c.country)), '') = coalesce(lower(btrim(v_o -> 'customer' ->> 'country')), '')
       order by c.archived, c.created_at
       limit 1;
      if v_customer_id is null then
        insert into public.customers (name, country, state_province)
        values (btrim(v_o -> 'customer' ->> 'name'),
                nullif(btrim(v_o -> 'customer' ->> 'country'), ''),
                nullif(btrim(v_o -> 'customer' ->> 'state_province'), ''))
        returning id into v_customer_id;
        v_customers := v_customers + 1;
      end if;
    end if;

    -- ---------- Order: update or create ----------
    select * into v_old from public.orders
     where order_number = (v_o ->> 'order_number')::integer
       and split_number is not distinct from nullif(v_o ->> 'split_number', '')::integer;

    if found then
      v_order_id := v_old.id;
      v_stage := v_o ->> 'stage';
      update public.orders o set
        customer_id        = coalesce(v_customer_id, o.customer_id),
        order_total        = coalesce(nullif(v_o ->> 'order_total', '')::numeric, o.order_total),
        currency           = coalesce(nullif(v_o ->> 'currency', ''), o.currency),
        expected_ship_date = coalesce(nullif(v_o ->> 'expected_ship_date', '')::date, o.expected_ship_date),
        actual_ship_date   = coalesce(nullif(v_o ->> 'actual_ship_date', '')::date, o.actual_ship_date),
        voltage            = case when coalesce(v_o ->> 'voltage', 'Unknown') = 'Unknown' then o.voltage
                                  else v_o ->> 'voltage' end,
        delivery_equipment = case when coalesce(v_o ->> 'delivery_equipment', 'Unknown') = 'Unknown' then o.delivery_equipment
                                  else v_o ->> 'delivery_equipment' end,
        freight_type       = coalesce(nullif(v_o ->> 'freight_type', ''), o.freight_type),
        notes              = coalesce(nullif(v_o ->> 'notes', ''), o.notes),
        archived           = false
      where o.id = v_order_id;
      -- The stage only changes to Shipped or Cancelled (the app knows the rest better).
      if v_stage in ('Shipped', 'Cancelled') and v_old.stage <> v_stage then
        update public.orders set stage = v_stage where id = v_order_id;
      end if;
      v_orders_upd := v_orders_upd + 1;
    else
      if v_customer_id is null then
        raise exception 'Order % (row %) has no customer.', v_o ->> 'order_number', v_o ->> 'source_row';
      end if;
      insert into public.orders (
        order_number, split_number, customer_id, stage, currency, order_total,
        expected_ship_date, actual_ship_date, voltage, delivery_equipment, freight_type, notes
      ) values (
        (v_o ->> 'order_number')::integer,
        nullif(v_o ->> 'split_number', '')::integer,
        v_customer_id,
        coalesce(nullif(v_o ->> 'stage', ''), 'Confirmed'),
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
      v_orders_new := v_orders_new + 1;
    end if;

    -- ---------- Machines ----------
    v_used := '{}';
    for v_m in select value from jsonb_array_elements(coalesce(v_o -> 'machines', '[]'::jsonb))
    loop
      v_serial := nullif(btrim(v_m ->> 'serial_number'), '');
      if v_serial is not null then
        select o.order_code into v_owner
          from public.order_machines x join public.orders o on o.id = x.order_id
         where x.serial_number = v_serial and x.order_id <> v_order_id;
        if found then
          raise exception 'Serial % (row %) is already used by order %. Nothing was imported.', v_serial, v_m ->> 'source_row', v_owner;
        end if;
      end if;

      v_match := null;
      if v_serial is not null then
        select id into v_match from public.order_machines
         where order_id = v_order_id and serial_number = v_serial and not (id = any(v_used));
      end if;
      if v_match is null then
        select id into v_match from public.order_machines
         where order_id = v_order_id
           and machine_type_id = (v_m ->> 'machine_type_id')::uuid
           and not (id = any(v_used))
           and not archived
           and (v_serial is null or serial_number is null)
         order by created_at, id
         limit 1;
      end if;

      if v_match is not null then
        v_used := v_used || v_match;
        update public.order_machines x set
          ready         = x.ready or coalesce((v_m ->> 'ready')::boolean, false),
          notes         = coalesce(nullif(v_m ->> 'notes', ''), x.notes),
          serial_manual = case when x.serial_number is null and v_serial is not null
                               then coalesce((v_m ->> 'serial_manual')::boolean, false) else x.serial_manual end,
          serial_number = coalesce(x.serial_number, v_serial)
        where x.id = v_match;
        v_machines_upd := v_machines_upd + 1;
      else
        insert into public.order_machines (order_id, machine_type_id, serial_number, serial_manual, ready, needs_serial, notes)
        values (
          v_order_id,
          (v_m ->> 'machine_type_id')::uuid,
          v_serial,
          -- blank serial: kept out of automatic numbering until an admin sets one
          v_serial is null or coalesce((v_m ->> 'serial_manual')::boolean, false),
          coalesce((v_m ->> 'ready')::boolean, false),
          v_serial is null,
          nullif(v_m ->> 'notes', '')
        )
        returning id into v_new_machine;
        v_used := v_used || v_new_machine;  -- a machine added now is never matched again
        v_machines_new := v_machines_new + 1;
        if v_serial is null then
          v_needs_serial := v_needs_serial + 1;
        end if;
      end if;
    end loop;

    -- ---------- Payments ----------
    v_dp := v_o -> 'down_payment';
    if v_dp is not null and v_dp <> 'null'::jsonb then
      select id into v_pay_id from public.payments where order_id = v_order_id and payment_type = 'Down payment';
      if found then
        update public.payments p set
          amount          = coalesce(nullif(v_dp ->> 'amount', '')::numeric, p.amount),
          due_date        = coalesce(nullif(v_dp ->> 'due_date', '')::date, p.due_date),
          received_date   = coalesce(nullif(v_dp ->> 'received_date', '')::date, p.received_date),
          received_amount = case
            when nullif(v_dp ->> 'received_date', '') is null and nullif(v_dp ->> 'received_amount', '') is null then p.received_amount
            else coalesce(nullif(p.received_amount, 0), nullif(v_dp ->> 'received_amount', '')::numeric,
                          coalesce(nullif(v_dp ->> 'amount', '')::numeric, p.amount)) end
        where p.id = v_pay_id;
        v_payments_upd := v_payments_upd + 1;
      else
        insert into public.payments (order_id, payment_type, amount, due_date, received_date, received_amount)
        values (
          v_order_id, 'Down payment',
          coalesce(nullif(v_dp ->> 'amount', '')::numeric, 0),
          nullif(v_dp ->> 'due_date', '')::date,
          nullif(v_dp ->> 'received_date', '')::date,
          case when nullif(v_dp ->> 'received_date', '') is not null or nullif(v_dp ->> 'received_amount', '') is not null
               then coalesce(nullif(v_dp ->> 'received_amount', '')::numeric, nullif(v_dp ->> 'amount', '')::numeric, 0) end
        );
        v_payments_new := v_payments_new + 1;
      end if;
    end if;

    v_bal := v_o -> 'balance';
    if v_bal is not null and v_bal <> 'null'::jsonb then
      select id into v_pay_id from public.payments where order_id = v_order_id and payment_type = 'Balance';
      if not found then
        -- The balance amount is calculated by the database (total - down payment).
        insert into public.payments (order_id, payment_type) values (v_order_id, 'Balance')
        returning id into v_pay_id;
        v_payments_new := v_payments_new + 1;
      else
        v_payments_upd := v_payments_upd + 1;
      end if;
      update public.payments p set
        due_date        = coalesce(nullif(v_bal ->> 'due_date', '')::date, p.due_date),
        received_date   = coalesce(nullif(v_bal ->> 'received_date', '')::date, p.received_date),
        received_amount = case
          when nullif(v_bal ->> 'received_date', '') is null and nullif(v_bal ->> 'received_amount', '') is null then p.received_amount
          else coalesce(nullif(p.received_amount, 0), nullif(v_bal ->> 'received_amount', '')::numeric, p.amount) end
      where p.id = v_pay_id;
    end if;
  end loop;

  -- ---------- Next serial = one above the highest imported number ----------
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

  v_summary := jsonb_build_object(
    'orders_created', v_orders_new, 'orders_updated', v_orders_upd, 'customers_created', v_customers,
    'machines_created', v_machines_new, 'machines_updated', v_machines_upd,
    'payments_created', v_payments_new, 'payments_updated', v_payments_upd,
    'needs_serial', v_needs_serial, 'skipped', coalesce(p_skipped, 0),
    'next_serial_numbers', v_counters);

  perform public.log_admin_action('orders', null, null,
    jsonb_build_object('action', 'Imported a spreadsheet: ' || v_orders_new || ' new and ' || v_orders_upd
                                 || ' updated orders, ' || (v_machines_new + v_machines_upd) || ' machines, '
                                 || (v_payments_new + v_payments_upd) || ' payments, ' || coalesce(p_skipped, 0) || ' rows skipped')
    || v_summary);

  return v_summary;
end;
$$;

-- Access: same rules as before.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
