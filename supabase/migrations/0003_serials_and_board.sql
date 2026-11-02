-- 0003_serials_and_board.sql
-- Serial numbers and the shop board ("board number" / queue position).
--
-- Rules (from CLAUDE.md):
-- * Orders in Confirmed / In production / Ready to ship are on the board,
--   numbered 1..N. Quote, Shipped and Cancelled orders are not on the board.
-- * Per machine type, lower board numbers get lower serial numbers.
-- * Machines marked ready (built) keep their serial forever.
-- * Unbuilt machines on Quote or Cancelled orders hand their serial back so
--   it can be reused.
--
-- All board/serial changes take the same lock, so two people moving orders at
-- the same moment cannot mix up the numbering.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_board_stage(p_stage text)
returns boolean
language sql
immutable
as $$
  select p_stage in ('Confirmed', 'In production', 'Ready to ship');
$$;

-- The number at the end of a serial: 'LCR-2072' -> 2072.
create or replace function public.serial_number_part(p_serial text)
returns integer
language sql
immutable
as $$
  select nullif(substring(p_serial from '(\d+)$'), '')::integer;
$$;

-- One lock shared by every board / serial change.
create or replace function public.lock_board()
returns void
language sql
as $$
  select pg_advisory_xact_lock(7605001);
$$;

-- ---------------------------------------------------------------------------
-- next_serial(machine_type_id)
-- Takes the next serial for a type and moves the counter up, in ONE atomic
-- statement. Example: returns 'LCR-2073' and the counter becomes 2074.
-- ---------------------------------------------------------------------------
create or replace function public.next_serial(p_machine_type_id uuid)
returns text
language plpgsql
as $$
declare
  v_serial text;
begin
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
  return v_serial;
end;
$$;

-- ---------------------------------------------------------------------------
-- renumber_board()
-- Gives every order on the board a number 1..N with no gaps, keeping the
-- current order. Orders that just joined the board (no number yet) go last.
-- Orders that left the board lose their number.
-- ---------------------------------------------------------------------------
create or replace function public.renumber_board()
returns void
language plpgsql
as $$
begin
  perform public.lock_board();

  update public.orders
     set board_position = null
   where board_position is not null
     and not public.is_board_stage(stage);

  with ranked as (
    select id,
           row_number() over (order by board_position nulls last, created_at, id) as rn
      from public.orders
     where public.is_board_stage(stage)
  )
  update public.orders o
     set board_position = r.rn
    from ranked r
   where o.id = r.id
     and o.board_position is distinct from r.rn;
end;
$$;

-- ---------------------------------------------------------------------------
-- reassign_serials(machine_type_id, freed_serials)
-- For one machine type: puts the serials of unbuilt machines in board order.
--   1. Collect the serials held by unbuilt machines of this type on the board
--      (plus unbuilt ones on Quote/Cancelled orders, which give theirs back,
--      plus any serials just freed by a deleted machine). Sort them.
--   2. If there are not enough, take new ones with next_serial().
--   3. Hand them out: lowest serial to the lowest board number.
--   4. Unused serials at the very top go back to the counter, so no gap.
-- Built (ready) machines are never touched.
-- Returns the changes made (old serial -> new serial).
-- ---------------------------------------------------------------------------
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
  v_num     integer;
  i         integer;
begin
  perform public.lock_board();

  select mt.code into v_code from public.machine_types mt where mt.id = p_machine_type_id;
  if coalesce(v_code, '') = '' then
    return;  -- no code yet: machines of this type have no serial numbers
  end if;

  -- Machines that should hold a serial, in board order.
  select coalesce(array_agg(m.id order by o.board_position, m.created_at, m.id), '{}')
    into v_targets
    from public.order_machines m
    join public.orders o on o.id = m.order_id
   where m.machine_type_id = p_machine_type_id
     and not m.ready
     and o.board_position is not null;

  -- Serials available to hand out, sorted.
  select coalesce(array_agg(s order by public.serial_number_part(s), s), '{}')
    into v_pool
    from (
      select m.serial_number as s
        from public.order_machines m
        join public.orders o on o.id = m.order_id
       where m.machine_type_id = p_machine_type_id
         and not m.ready
         and m.serial_number is not null
         and (o.board_position is not null or o.stage in ('Quote', 'Cancelled'))
      union
      select f
        from unnest(p_freed_serials) as f
       where f is not null
         and not exists (select 1 from public.order_machines x where x.serial_number = f)
    ) pool;

  -- Top up with brand-new serials if needed, then sort again.
  v_count := cardinality(v_targets);
  if cardinality(v_pool) < v_count then
    for i in 1 .. v_count - cardinality(v_pool) loop
      v_pool := v_pool || public.next_serial(p_machine_type_id);
    end loop;
    select array_agg(s order by public.serial_number_part(s), s) into v_pool from unnest(v_pool) as s;
  end if;

  -- Apply: targets get pool[1..n]; unbuilt machines on Quote/Cancelled orders
  -- give their serial back. "prev" is the row before the change.
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
       and m.serial_number is not null
       and o.board_position is null
       and o.stage in ('Quote', 'Cancelled')
  )
  update public.order_machines m
     set serial_number = mp.new_serial
    from mapping mp
    join public.order_machines prev on prev.id = mp.id
   where m.id = mp.id
     and m.serial_number is distinct from mp.new_serial
  returning m.id, m.order_id, m.machine_type_id, prev.serial_number, m.serial_number;

  -- Leftover serials at the top of the range go back to the counter.
  for i in reverse cardinality(v_pool) .. v_count + 1 loop
    v_num := public.serial_number_part(v_pool[i]);
    exit when exists (select 1 from public.order_machines x where x.serial_number = v_pool[i]);
    update public.machine_types mt
       set next_serial_number = next_serial_number - 1
     where mt.id = p_machine_type_id
       and mt.next_serial_number - 1 = v_num
       and v_num > 0;
    exit when not found;
  end loop;
end;
$$;

-- Runs reassign_serials() for every machine type that has a code.
create or replace function public.reassign_all_serials()
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
  v_type uuid;
begin
  for v_type in
    select mt.id from public.machine_types mt where coalesce(mt.code, '') <> '' order by mt.name
  loop
    return query select * from public.reassign_serials(v_type);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- move_board(order_id, new_position)
-- Moves an order to a new board number. Everyone in between shifts by one.
-- Then serials of unbuilt machines are reassigned to match the new order.
-- Returns the list of serial changes (old -> new). All in one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.move_board(p_order_id uuid, p_new_position integer)
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
  v_old   integer;
  v_new   integer;
  v_count integer;
begin
  perform public.lock_board();
  perform public.renumber_board();  -- make sure numbers are 1..N first

  select o.board_position into v_old from public.orders o where o.id = p_order_id;
  if v_old is null then
    raise exception 'This order is not on the board (only Confirmed, In production and Ready to ship orders are).';
  end if;

  select count(*) into v_count from public.orders o where o.board_position is not null;
  v_new := least(greatest(coalesce(p_new_position, v_old), 1), v_count);

  if v_new <> v_old then
    update public.orders o
       set board_position = case
             when o.id = p_order_id then v_new
             when v_new < v_old then o.board_position + 1   -- moving up: others step down
             else o.board_position - 1                      -- moving down: others step up
           end
     where o.id = p_order_id
        or (v_new < v_old and o.board_position between v_new and v_old - 1)
        or (v_new > v_old and o.board_position between v_old + 1 and v_new);
  end if;

  return query select * from public.reassign_all_serials();
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers: keep the board and serials right automatically.
-- ---------------------------------------------------------------------------

-- Before an order is added or its stage changes:
-- leaving the board -> clear the number; joining the board -> go to the end.
create or replace function public.orders_before_stage()
returns trigger
language plpgsql
as $$
begin
  if not public.is_board_stage(new.stage) then
    new.board_position := null;
  elsif tg_op = 'INSERT' or not public.is_board_stage(old.stage) then
    new.board_position := null;  -- renumber_board() puts it at the end
  end if;

  -- Fill in the actual ship date when an order is marked Shipped.
  if new.stage = 'Shipped' and new.actual_ship_date is null
     and (tg_op = 'INSERT' or old.stage is distinct from 'Shipped') then
    new.actual_ship_date := (now() at time zone 'America/Halifax')::date;
  end if;
  return new;
end;
$$;

create trigger orders_before_stage
  before insert or update of stage on public.orders
  for each row execute function public.orders_before_stage();

-- After an order is added, deleted or its stage changes: renumber the board
-- and reassign serials.
create or replace function public.orders_after_stage()
returns trigger
language plpgsql
as $$
begin
  perform public.renumber_board();
  perform public.reassign_all_serials();
  return null;
end;
$$;

create trigger orders_after_stage
  after insert or delete or update of stage on public.orders
  for each row execute function public.orders_after_stage();

-- If an unbuilt machine changes type, its old serial is released.
create or replace function public.order_machines_before_change()
returns trigger
language plpgsql
as $$
begin
  if not new.ready and new.machine_type_id is distinct from old.machine_type_id then
    new.serial_number := null;
  end if;
  return new;
end;
$$;

create trigger order_machines_before_change
  before update of machine_type_id on public.order_machines
  for each row execute function public.order_machines_before_change();

-- After a machine is added, removed, moved, retyped or marked built/unbuilt:
-- reassign serials for the machine type(s) involved.
create or replace function public.order_machines_after_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.reassign_serials(
      old.machine_type_id,
      case when not old.ready and old.serial_number is not null
           then array[old.serial_number] else '{}'::text[] end);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.reassign_serials(new.machine_type_id);
  end if;
  return null;
end;
$$;

create trigger order_machines_after_change
  after insert or delete or update of machine_type_id, order_id, ready on public.order_machines
  for each row execute function public.order_machines_after_change();
