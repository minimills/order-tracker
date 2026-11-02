-- 0007_roles_options_archiving.sql
-- 1. Roles: allowed_users get a role, admin or staff.
--    Staff: add and edit orders, customers, machines and payments.
--    Admin: also delete anything, change machine types, settings and
--    dropdown lists, and manage users.
-- 2. Editable dropdowns: option_lists table. Orders and payments check their
--    values against it instead of fixed lists.
-- 3. Archive instead of delete: archived / archived_at / archived_by on
--    orders, customers, order_machines and machine_types.

-- ===========================================================================
-- Helpers
-- ===========================================================================

-- Email of the signed-in user (empty when run from the Supabase dashboard).
create or replace function public.current_user_email()
returns text
language sql
stable
as $$
  select lower(auth.jwt() ->> 'email');
$$;

-- Fills in archived_at / archived_by when something is archived, and clears
-- them when it is brought back.
create or replace function public.set_archived_info()
returns trigger
language plpgsql
as $$
begin
  if new.archived and (tg_op = 'INSERT' or not old.archived) then
    new.archived_at := now();
    new.archived_by := coalesce(public.current_user_email(), 'database');
  elsif not new.archived then
    new.archived_at := null;
    new.archived_by := null;
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 1. Roles
-- ===========================================================================
alter table public.allowed_users
  add column role text not null default 'staff' check (role in ('admin', 'staff'));

insert into public.allowed_users (email, name, role)
values ('minimillsoffice@gmail.com', 'Office', 'admin')
on conflict (email) do update set role = 'admin';

-- 'admin', 'staff', or null when the signed-in user is not on the list.
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select a.role from public.allowed_users a where a.email = public.current_user_email();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'admin', false);
$$;

-- True for allowed users, and for the database itself (Supabase dashboard,
-- automatic jobs using the service key). Used by functions below that must
-- work for staff even though staff cannot edit those tables directly.
create or replace function public.is_trusted_caller()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.jwt() is null
      or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or public.is_allowed_user();
$$;

-- There must always be at least one admin.
create or replace function public.allowed_users_keep_one_admin()
returns trigger
language plpgsql
as $$
begin
  if old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin')
     and not exists (select 1 from public.allowed_users a
                      where a.role = 'admin' and a.email <> old.email) then
    raise exception 'There must always be at least one admin.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger allowed_users_keep_one_admin
  before update or delete on public.allowed_users
  for each row execute function public.allowed_users_keep_one_admin();

-- App settings (admin-only). Key/value store for later settings screens.
create table public.app_settings (
  key        text primary key,
  value      jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();
create trigger log_activity after insert or update or delete on public.app_settings
  for each row execute function public.log_activity();

-- ===========================================================================
-- 2. Editable dropdowns
-- ===========================================================================
create table public.option_lists (
  id          uuid primary key default gen_random_uuid(),
  list_name   text not null,
  value       text not null check (btrim(value) <> ''),
  sort_order  integer not null default 0,
  -- locked = built in; the app relies on it, so it cannot be renamed,
  -- archived or deleted.
  locked      boolean not null default false,
  archived    boolean not null default false,
  archived_at timestamptz,
  archived_by text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (list_name, value)
);
create index option_lists_list_idx on public.option_lists (list_name, sort_order);
alter table public.option_lists enable row level security;
create trigger option_lists_updated_at before update on public.option_lists
  for each row execute function public.set_updated_at();
create trigger option_lists_archived_info before insert or update of archived on public.option_lists
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.option_lists
  for each row execute function public.log_activity();

insert into public.option_lists (list_name, value, sort_order, locked) values
  ('voltage',            '120V',               1, false),
  ('voltage',            '240V',               2, false),
  ('voltage',            'Unknown',            3, true),
  ('delivery_equipment', 'Liftgate',           1, false),
  ('delivery_equipment', 'No liftgate',        2, false),
  ('delivery_equipment', 'Forklift',           3, false),
  ('delivery_equipment', 'Tractor with forks', 4, false),
  ('delivery_equipment', 'Unknown',            5, true),
  ('freight_type',       'LTL',                1, false),
  ('freight_type',       'FTL',                2, false),
  ('freight_type',       'LCL',                3, false),
  ('freight_type',       '40'' container',     4, false),
  ('freight_type',       'Other',              5, false),
  ('payment_type',       'Down payment',       1, true),
  ('payment_type',       'Balance',            2, true),
  ('payment_type',       'Other',              3, false);

-- Is this a current (not archived) value of that list?
create or replace function public.is_valid_option(p_list text, p_value text)
returns boolean
language sql
stable
as $$
  select exists (select 1 from public.option_lists o
                  where o.list_name = p_list and o.value = p_value and not o.archived);
$$;

-- Built-in values cannot be renamed, archived or deleted.
-- Values still used by orders or payments cannot be deleted (archive them).
create or replace function public.option_lists_protect()
returns trigger
language plpgsql
as $$
begin
  if old.locked and (tg_op = 'DELETE'
                     or new.value is distinct from old.value
                     or new.list_name is distinct from old.list_name
                     or new.archived
                     or not new.locked) then
    raise exception '"%" is built in and cannot be renamed, archived or deleted.', old.value;
  end if;
  if tg_op = 'DELETE' and (
       (old.list_name = 'voltage'            and exists (select 1 from public.orders   where voltage = old.value))
    or (old.list_name = 'delivery_equipment' and exists (select 1 from public.orders   where delivery_equipment = old.value))
    or (old.list_name = 'freight_type'       and exists (select 1 from public.orders   where freight_type = old.value))
    or (old.list_name = 'payment_type'       and exists (select 1 from public.payments where payment_type = old.value))) then
    raise exception '"%" is still used. Archive it instead of deleting it.', old.value;
  end if;
  if tg_op = 'UPDATE' and new.list_name is distinct from old.list_name then
    raise exception 'An option cannot be moved to a different list.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger option_lists_protect
  before update or delete on public.option_lists
  for each row execute function public.option_lists_protect();

-- Renaming an option updates every order / payment that uses it.
create or replace function public.option_lists_rename()
returns trigger
language plpgsql
as $$
begin
  if new.value is distinct from old.value then
    case old.list_name
      when 'voltage' then
        update public.orders set voltage = new.value where voltage = old.value;
      when 'delivery_equipment' then
        update public.orders set delivery_equipment = new.value where delivery_equipment = old.value;
      when 'freight_type' then
        update public.orders set freight_type = new.value where freight_type = old.value;
      when 'payment_type' then
        update public.payments set payment_type = new.value where payment_type = old.value;
      else
        null;
    end case;
  end if;
  return null;
end;
$$;

create trigger option_lists_rename
  after update of value on public.option_lists
  for each row execute function public.option_lists_rename();

-- --- orders: voltage, delivery equipment, freight type ---------------------
alter table public.orders drop constraint orders_voltage_check;
alter table public.orders drop constraint orders_delivery_equipment_check;
alter table public.orders drop constraint orders_freight_type_check;

-- A new or changed value must be a current (not archived) option.
-- Values that were later archived stay valid on the orders that already have them.
create or replace function public.orders_check_options()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT' or new.voltage is distinct from old.voltage)
     and not public.is_valid_option('voltage', new.voltage) then
    raise exception '"%" is not in the Voltage list.', new.voltage;
  end if;
  if (tg_op = 'INSERT' or new.delivery_equipment is distinct from old.delivery_equipment)
     and not public.is_valid_option('delivery_equipment', new.delivery_equipment) then
    raise exception '"%" is not in the Delivery equipment list.', new.delivery_equipment;
  end if;
  if new.freight_type is not null
     and (tg_op = 'INSERT' or new.freight_type is distinct from old.freight_type)
     and not public.is_valid_option('freight_type', new.freight_type) then
    raise exception '"%" is not in the Freight type list.', new.freight_type;
  end if;
  return new;
end;
$$;

create trigger orders_check_options
  before insert or update of voltage, delivery_equipment, freight_type on public.orders
  for each row execute function public.orders_check_options();

-- --- payments: kind -> payment_type ----------------------------------------
-- Old values down_payment / balance / extra become Down payment / Balance / Other.
drop index public.payments_one_down_payment;
drop index public.payments_one_balance;
alter table public.payments drop constraint payments_kind_check;
alter table public.payments rename column kind to payment_type;

create or replace function public.payments_set_balance_amount()
returns trigger
language plpgsql
as $$
begin
  if new.payment_type = 'Balance' then
    select o.order_total - coalesce((
             select p.amount from public.payments p
              where p.order_id = new.order_id and p.payment_type = 'Down payment'), 0)
      into new.amount
      from public.orders o
     where o.id = new.order_id;
  end if;
  return new;
end;
$$;

create or replace function public.refresh_balance(p_order_id uuid)
returns void
language sql
as $$
  update public.payments
     set amount = amount   -- payments_set_balance_amount recalculates it
   where order_id = p_order_id and payment_type = 'Balance';
$$;

create or replace function public.payments_after_down_payment()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'INSERT' and old.payment_type = 'Down payment' then
    perform public.refresh_balance(old.order_id);
  end if;
  if tg_op <> 'DELETE' and new.payment_type = 'Down payment' then
    perform public.refresh_balance(new.order_id);
  end if;
  return null;
end;
$$;

update public.payments
   set payment_type = case payment_type
                        when 'down_payment' then 'Down payment'
                        when 'balance'      then 'Balance'
                        else 'Other'
                      end;

create unique index payments_one_down_payment on public.payments (order_id) where payment_type = 'Down payment';
create unique index payments_one_balance      on public.payments (order_id) where payment_type = 'Balance';

create or replace function public.payments_check_options()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT' or new.payment_type is distinct from old.payment_type)
     and not public.is_valid_option('payment_type', new.payment_type) then
    raise exception '"%" is not in the Payment type list.', new.payment_type;
  end if;
  return new;
end;
$$;

create trigger payments_check_options
  before insert or update of payment_type on public.payments
  for each row execute function public.payments_check_options();

-- ===========================================================================
-- 3. Archive instead of delete
-- ===========================================================================
alter table public.orders
  add column archived    boolean not null default false,
  add column archived_at timestamptz,
  add column archived_by text;
alter table public.customers
  add column archived    boolean not null default false,
  add column archived_at timestamptz,
  add column archived_by text;
alter table public.order_machines
  add column archived    boolean not null default false,
  add column archived_at timestamptz,
  add column archived_by text;
alter table public.machine_types
  add column archived    boolean not null default false,
  add column archived_at timestamptz,
  add column archived_by text;

-- machine_types.active is replaced by archived.
update public.machine_types set archived = not active;
alter table public.machine_types drop column active;

create trigger orders_archived_info before insert or update of archived on public.orders
  for each row execute function public.set_archived_info();
create trigger customers_archived_info before insert or update of archived on public.customers
  for each row execute function public.set_archived_info();
create trigger order_machines_archived_info before insert or update of archived on public.order_machines
  for each row execute function public.set_archived_info();
create trigger machine_types_archived_info before insert or update of archived on public.machine_types
  for each row execute function public.set_archived_info();

-- --- Board and serials now ignore archived orders and machines -------------
-- An archived order leaves the board (like a cancelled one). An archived
-- machine that is not built gives its serial back. Built machines and
-- shipped orders keep their serials.

create or replace function public.renumber_board()
returns void
language plpgsql
as $$
begin
  perform public.lock_board();

  update public.orders
     set board_position = null
   where board_position is not null
     and (archived or not public.is_board_stage(stage));

  with ranked as (
    select id,
           row_number() over (order by board_position nulls last, created_at, id) as rn
      from public.orders
     where public.is_board_stage(stage) and not archived
  )
  update public.orders o
     set board_position = r.rn
    from ranked r
   where o.id = r.id
     and o.board_position is distinct from r.rn;
end;
$$;

create or replace function public.orders_before_stage()
returns trigger
language plpgsql
as $$
declare
  v_on_board  boolean := public.is_board_stage(new.stage) and not new.archived;
  v_was_board boolean := tg_op = 'UPDATE' and public.is_board_stage(old.stage) and not old.archived;
begin
  if not v_on_board or not v_was_board then
    new.board_position := null;  -- off the board, or joining it: renumber_board() puts it last
  end if;

  if new.stage = 'Shipped' and new.actual_ship_date is null
     and (tg_op = 'INSERT' or old.stage is distinct from 'Shipped') then
    new.actual_ship_date := (now() at time zone 'America/Halifax')::date;
  end if;
  return new;
end;
$$;

drop trigger orders_before_stage on public.orders;
create trigger orders_before_stage
  before insert or update of stage, archived on public.orders
  for each row execute function public.orders_before_stage();

drop trigger orders_after_stage on public.orders;
create trigger orders_after_stage
  after insert or delete or update of stage, archived on public.orders
  for each row execute function public.orders_after_stage();

drop trigger order_machines_after_change on public.order_machines;
create trigger order_machines_after_change
  after insert or delete or update of machine_type_id, order_id, ready, archived on public.order_machines
  for each row execute function public.order_machines_after_change();

-- Serial counters live in machine_types, which only admins may edit.
-- These two functions change the counter on behalf of staff, safely.
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

-- Gives the newest serial back to the counter (only if it is the newest one
-- and no machine holds it). Returns true if it was given back.
create or replace function public.give_back_serial(p_machine_type_id uuid, p_serial text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_trusted_caller() then
    raise exception 'Not allowed.';
  end if;
  if exists (select 1 from public.order_machines x where x.serial_number = p_serial) then
    return false;
  end if;
  update public.machine_types mt
     set next_serial_number = next_serial_number - 1
   where mt.id = p_machine_type_id
     and mt.next_serial_number > 1
     and mt.next_serial_number - 1 = public.serial_number_part(p_serial)
     and p_serial = mt.code || '-' || lpad((mt.next_serial_number - 1)::text,
                                          greatest(4, length((mt.next_serial_number - 1)::text)), '0');
  return found;
end;
$$;

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

  -- Machines that should hold a serial, in board order:
  -- not built, not archived, on an order that is on the board.
  select coalesce(array_agg(m.id order by o.board_position, m.created_at, m.id), '{}')
    into v_targets
    from public.order_machines m
    join public.orders o on o.id = m.order_id
   where m.machine_type_id = p_machine_type_id
     and not m.ready
     and not m.archived
     and o.board_position is not null;

  -- Serials to hand out: those held by the machines above, plus those given
  -- back by unbuilt machines that are archived or on a Quote / Cancelled /
  -- archived order (not Shipped), plus serials of just-deleted machines.
  select coalesce(array_agg(s order by public.serial_number_part(s), s), '{}')
    into v_pool
    from (
      select m.serial_number as s
        from public.order_machines m
        join public.orders o on o.id = m.order_id
       where m.machine_type_id = p_machine_type_id
         and not m.ready
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

  -- Leftover serials at the top go back to the counter, so there is no gap.
  for i in reverse cardinality(v_pool) .. v_count + 1 loop
    exit when not public.give_back_serial(p_machine_type_id, v_pool[i]);
  end loop;
end;
$$;

-- order_summary: add archived, count only machines that are not archived.
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
  o.currency,
  o.order_total,
  o.expected_ship_date,
  o.actual_ship_date,
  o.actual_ship_date - o.expected_ship_date      as delay_days,   -- negative = early
  o.voltage,
  o.delivery_equipment,
  o.freight_type,
  o.notes,
  coalesce(m.machines_count, 0)                  as machines_count,
  coalesce(m.machines_ready_count, 0)            as machines_ready_count,
  dp.amount                                      as down_payment_amount,
  case when o.order_total > 0 and dp.amount is not null
       then round(dp.amount * 100 / o.order_total, 1) end as down_payment_percent,
  coalesce(p.total_paid, 0)                      as total_paid,
  o.order_total - coalesce(p.total_paid, 0)      as amount_outstanding,
  o.archived,
  o.archived_at,
  o.archived_by,
  o.created_at,
  o.updated_at
from public.orders o
join public.customers c on c.id = o.customer_id
left join lateral (
  select count(*)                         as machines_count,
         count(*) filter (where om.ready) as machines_ready_count
    from public.order_machines om
   where om.order_id = o.id and not om.archived
) m on true
left join lateral (
  select sum(pp.amount) as total_paid
    from public.payments pp
   where pp.order_id = o.id and pp.received_date is not null
) p on true
left join public.payments dp on dp.order_id = o.id and dp.payment_type = 'Down payment';

-- ===========================================================================
-- Row Level Security by role
-- ===========================================================================

-- Staff and admins: read, add, edit. Admins only: delete.
drop policy "Allowed users can do everything" on public.customers;
drop policy "Allowed users can do everything" on public.orders;
drop policy "Allowed users can do everything" on public.order_machines;
drop policy "Allowed users can do everything" on public.payments;
drop policy "Allowed users can do everything" on public.machine_types;

create policy "Allowed users can read" on public.customers
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Allowed users can add" on public.customers
  for insert to authenticated with check ((select public.is_allowed_user()));
create policy "Allowed users can edit" on public.customers
  for update to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));
create policy "Admins can delete" on public.customers
  for delete to authenticated using ((select public.is_admin()));

create policy "Allowed users can read" on public.orders
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Allowed users can add" on public.orders
  for insert to authenticated with check ((select public.is_allowed_user()));
create policy "Allowed users can edit" on public.orders
  for update to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));
create policy "Admins can delete" on public.orders
  for delete to authenticated using ((select public.is_admin()));

create policy "Allowed users can read" on public.order_machines
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Allowed users can add" on public.order_machines
  for insert to authenticated with check ((select public.is_allowed_user()));
create policy "Allowed users can edit" on public.order_machines
  for update to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));
create policy "Admins can delete" on public.order_machines
  for delete to authenticated using ((select public.is_admin()));

create policy "Allowed users can read" on public.payments
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Allowed users can add" on public.payments
  for insert to authenticated with check ((select public.is_allowed_user()));
create policy "Allowed users can edit" on public.payments
  for update to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));
create policy "Admins can delete" on public.payments
  for delete to authenticated using ((select public.is_admin()));

-- Machine types, dropdown lists, settings: everyone reads, only admins change.
create policy "Allowed users can read" on public.machine_types
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Admins can change" on public.machine_types
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "Allowed users can read" on public.option_lists
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Admins can change" on public.option_lists
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "Allowed users can read" on public.app_settings
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Admins can change" on public.app_settings
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Users: everyone allowed can see the list, only admins can change it.
create policy "Admins can manage users" on public.allowed_users
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Same access lockdown as 0006 for the new tables and functions.
revoke all on public.option_lists, public.app_settings from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
