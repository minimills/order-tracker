-- 0009_board_moves.sql
-- For the Orders board and the Orders list.
-- 1. apply_board_change(): change an order's stage and/or its place on the
--    board in one step, and return every serial number that changed.
-- 2. preview_board_change(): the same, but nothing is saved. Used for the
--    "these serials will change" confirm box.
-- 3. Every move writes one summary line to activity_log (action 'move'),
--    as well as the usual per-field lines.
-- 4. order_summary gets payment status, machine list and serials, so the
--    board and list can show badges and search by serial.

-- ===========================================================================
-- Activity log: allow a 'move' line.
-- ===========================================================================
alter table public.activity_log drop constraint activity_log_action_check;
alter table public.activity_log
  add constraint activity_log_action_check check (action in ('insert', 'update', 'delete', 'move'));

-- Writes one 'move' line. Runs as the database owner because users cannot
-- write to activity_log directly.
create or replace function public.log_board_move(p_order_id uuid, p_changes jsonb)
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
  values (auth.uid(), auth.jwt() ->> 'email', 'orders', p_order_id::text, p_order_id, 'move', p_changes);
end;
$$;

-- ===========================================================================
-- apply_board_change
--   p_order_id   the order being moved
--   p_stage      new stage (null = keep the stage)
--   p_ship_date  actual ship date, used when moving to Shipped (null = today)
--   p_anchor_id  another order on the board to place this one next to
--                (null = keep its place / go to the end of the queue)
--   p_place      'before' or 'after' the anchor
--   p_mark_built true = mark all machines on the order as built (used when
--                shipping: shipped machines keep their serials for good)
-- Returns one row per machine whose serial changed.
-- ===========================================================================
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
  perform public.lock_board();

  select * into v_old from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'That order could not be found.';
  end if;
  if p_stage is not null
     and p_stage not in ('Quote', 'Confirmed', 'In production', 'Ready to ship', 'Shipped', 'Cancelled') then
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
-- preview_board_change: same inputs, nothing is saved.
-- Returns the serial changes and the board numbers before/after as JSON:
--   {"serials": [...], "positions": [{"order": "76", "old": 3, "new": 2}, ...]}
-- ===========================================================================
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

-- ===========================================================================
-- order_summary: add payment status, machines and serials.
-- payment_status: 'Paid', 'Overdue' (a payment is past its due date and not
-- received), 'Due soon' (due within 7 days), 'Open', or 'No total'.
-- ===========================================================================
drop view public.order_summary;
create view public.order_summary
with (security_invoker = true)
as
select
  o.id,
  o.order_number,
  o.split_number,
  o.order_code,
  o.stage,
  o.board_position,
  o.order_date,
  o.customer_id,
  c.name                                         as customer_name,
  c.company                                      as customer_company,
  c.country                                      as customer_country,
  c.state_province                               as customer_state_province,
  o.currency,
  o.order_total,
  o.expected_ship_date,
  o.actual_ship_date,
  o.actual_ship_date - o.expected_ship_date      as delay_days,   -- negative = early
  o.expected_ship_date - (now() at time zone 'America/Halifax')::date as days_until_ship,
  o.voltage,
  o.delivery_equipment,
  o.freight_type,
  o.notes,
  coalesce(m.machines_count, 0)                  as machines_count,
  coalesce(m.machines_ready_count, 0)            as machines_ready_count,
  m.machines_list,
  m.serials,
  dp.amount                                      as down_payment_amount,
  case when o.order_total > 0 and dp.amount is not null
       then round(dp.amount * 100 / o.order_total, 1) end as down_payment_percent,
  coalesce(p.total_paid, 0)                      as total_paid,
  o.order_total - coalesce(p.total_paid, 0)      as amount_outstanding,
  p.next_due_date,
  case
    when o.order_total <= 0                          then 'No total'
    when o.order_total - coalesce(p.total_paid, 0) <= 0 then 'Paid'
    when p.next_due_date < (now() at time zone 'America/Halifax')::date then 'Overdue'
    when p.next_due_date <= (now() at time zone 'America/Halifax')::date + 7 then 'Due soon'
    else 'Open'
  end                                            as payment_status,
  o.archived,
  o.archived_at,
  o.archived_by,
  o.created_at,
  o.updated_at
from public.orders o
join public.customers c on c.id = o.customer_id
left join lateral (
  select count(*)                                     as machines_count,
         count(*) filter (where om.ready)             as machines_ready_count,
         string_agg(om.serial_number, ', ' order by om.serial_number) as serials,
         (select string_agg(t.qty || '× ' || t.name, ', ' order by t.name)
            from (select mt.name, count(*) as qty
                    from public.order_machines x
                    join public.machine_types mt on mt.id = x.machine_type_id
                   where x.order_id = o.id and not x.archived
                   group by mt.name) t)               as machines_list
    from public.order_machines om
   where om.order_id = o.id and not om.archived
) m on true
left join lateral (
  select sum(pp.amount) filter (where pp.received_date is not null)     as total_paid,
         min(pp.due_date) filter (where pp.received_date is null
                                    and pp.amount > 0)                   as next_due_date
    from public.payments pp
   where pp.order_id = o.id
) p on true
left join public.payments dp on dp.order_id = o.id and dp.payment_type = 'Down payment';

-- Access: same rules as before.
revoke all on public.order_summary from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
