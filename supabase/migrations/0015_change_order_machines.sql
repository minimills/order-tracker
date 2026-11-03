-- 0015_change_order_machines.sql
-- Add machines to an existing order, or remove them, from the order page.
-- Adding or removing an unbuilt machine can shift the serials of other
-- orders (lower place in the shop queue = lower serial), so this always
-- runs as a preview first and shows every serial that will change.
--
-- change_order_machines(order, add, remove, apply)
--   p_add:    [{"machine_type_id": "...", "serial_number": null | "LCR-2090"}]
--             serial_number = a serial typed by hand (kept fixed; checked
--             for duplicates); null = automatic serial.
--   p_remove: ids of machines to take off the order. They are ARCHIVED
--             (an admin can bring them back or delete them in Admin > Archive).
--             An unbuilt machine gives its serial back.
--   p_apply:  false = preview only (nothing is saved).
-- Returns {"added": [{"machine_type": "...", "serial": "..."}],
--          "removed": [{"machine_type": "...", "serial": "..."}],
--          "serials": [{"order", "machine_type", "old", "new"}]}  (other machines whose serial changes)
-- Staff and admins can use it (the same people who can edit orders).

create or replace function public.change_order_machines(
  p_order_id uuid,
  p_add      jsonb,
  p_remove   uuid[],
  p_apply    boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_before  jsonb;
  v_result  jsonb;
  v_m       jsonb;
  v_serial  text;
  v_taken   text;
  v_new_ids uuid[] := '{}';
  v_id      uuid;
  v_removed jsonb;
begin
  if not public.is_allowed_user() and auth.jwt() is not null then
    raise exception 'Not allowed.';
  end if;
  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'That order could not be found.';
  end if;
  if coalesce(jsonb_array_length(p_add), 0) = 0 and coalesce(cardinality(p_remove), 0) = 0 then
    raise exception 'Choose a machine to add or remove.';
  end if;
  if exists (select 1 from unnest(coalesce(p_remove, '{}')) r(id)
              where not exists (select 1 from public.order_machines m where m.id = r.id and m.order_id = p_order_id and not m.archived)) then
    raise exception 'One of the machines to remove is not on this order.';
  end if;

  perform public.lock_board();
  v_before := public.board_snapshot();

  -- What is being removed (described before it changes).
  select coalesce(jsonb_agg(jsonb_build_object('machine_type', mt.name, 'serial', m.serial_number, 'built', m.ready)
                            order by mt.name, m.serial_number), '[]'::jsonb)
    into v_removed
    from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id
   where m.id = any(coalesce(p_remove, '{}'));

  begin
    -- Remove (archive) first, so their serials can be reused by new machines.
    if coalesce(cardinality(p_remove), 0) > 0 then
      update public.order_machines set archived = true where id = any(p_remove);
    end if;

    -- Hand-typed serials first, so automatic numbering skips them.
    for v_m in
      select value from jsonb_array_elements(coalesce(p_add, '[]'::jsonb))
       order by (nullif(btrim(value ->> 'serial_number'), '') is null)
    loop
      if not exists (select 1 from public.machine_types t
                      where t.id = (v_m ->> 'machine_type_id')::uuid and not t.archived) then
        raise exception 'Choose a machine type for every new machine.';
      end if;
      v_serial := upper(nullif(btrim(v_m ->> 'serial_number'), ''));
      if v_serial is not null then
        select o.order_code into v_taken
          from public.order_machines x join public.orders o on o.id = x.order_id
         where x.serial_number = v_serial;
        if found then
          raise exception 'Serial % is already used (order %).', v_serial, v_taken;
        end if;
      end if;
      insert into public.order_machines (order_id, machine_type_id, serial_number, serial_manual)
      values (p_order_id, (v_m ->> 'machine_type_id')::uuid, v_serial, v_serial is not null)
      returning id into v_id;
      v_new_ids := v_new_ids || v_id;
    end loop;

    v_result := jsonb_build_object(
      'added', (select coalesce(jsonb_agg(jsonb_build_object('machine_type', mt.name, 'serial', m.serial_number)
                                          order by mt.name, m.serial_number), '[]'::jsonb)
                  from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id
                 where m.id = any(v_new_ids)),
      'removed', v_removed,
      'serials', (select coalesce(jsonb_agg(jsonb_build_object(
                                    'order', o.order_code, 'machine_type', mt.name,
                                    'old', v_before -> 'serials' ->> m.id::text, 'new', m.serial_number)
                                  order by o.board_position nulls last, o.order_code, mt.name), '[]'::jsonb)
                    from public.order_machines m
                    join public.orders o on o.id = m.order_id
                    join public.machine_types mt on mt.id = m.machine_type_id
                   where v_before -> 'serials' ? m.id::text
                     and (v_before -> 'serials' ->> m.id::text) is distinct from m.serial_number
                     and not (m.id = any(coalesce(p_remove, '{}')))));

    if not p_apply then
      raise exception using errcode = 'P0999', message = 'preview only';
    end if;
  exception
    when sqlstate 'P0999' then null;
  end;

  return v_result;
end;
$$;

-- Access: same rules as before.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
