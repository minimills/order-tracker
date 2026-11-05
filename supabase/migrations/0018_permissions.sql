-- 0018_permissions.sql
-- Fine-grained permissions instead of plain admin / staff.
--
-- * Admins (allowed_users.role = 'admin') can still do everything.
-- * Everyone else gets exactly the permissions an admin ticks for them,
--   stored in user_permissions.perms as { "permission.key": "view" | "edit" }.
--   "edit" includes "view". The list of keys lives in the app
--   (src/lib/permissions/catalog.ts); the database checks the keys below.
-- * Shortcuts: department presets (departments.default_permissions, same
--   shape) and named templates (permission_templates).
-- * Every permission change writes one line to activity_log.
--
-- Enforced HERE, in the database (not just hidden on screen):
--   payments ............ payments table + payment_overview (view / edit)
--   order.field.order_total  the order total (column hidden from direct reads)
--   customer.contact .... customer emails and phone (columns hidden from direct reads)
--   order.field.* ....... editing each order field (trigger)
--   orders.new .......... creating orders
--   order.action.* / orders.board.* ... stage changes, shipping, queue moves
--   order.machines.* .... adding, removing, marking machines built
--   crating ............. crates (view / edit)
--   order.tab.activity / admin.activity ... reading the activity history
--   admin.* ............. every Admin page (users, departments, machine
--                         types, dropdowns, records, serials, queue, alerts,
--                         company, import, archive)
--   Changing permissions and making someone an admin: full admins only.

-- ===========================================================================
-- 1. Tables
-- ===========================================================================
create table public.user_permissions (
  user_email text primary key
             references public.allowed_users (email) on delete cascade on update cascade,
  perms      jsonb not null default '{}'::jsonb check (jsonb_typeof(perms) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.user_permissions enable row level security;
-- Changed only through set_user_permissions() (below), which logs every change.
create policy "People see their own, admins see everyone" on public.user_permissions
  for select to authenticated
  using (user_email = (select public.current_user_email()) or (select public.is_admin()));

create table public.permission_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> ''),
  perms      jsonb not null default '{}'::jsonb check (jsonb_typeof(perms) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index permission_templates_name_unique on public.permission_templates (lower(btrim(name)));
alter table public.permission_templates enable row level security;
create trigger permission_templates_updated_at before update on public.permission_templates
  for each row execute function public.set_updated_at();
create trigger log_activity after insert or update or delete on public.permission_templates
  for each row execute function public.log_activity();
create policy "Admins only" on public.permission_templates
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ===========================================================================
-- 2. Permission checks
-- ===========================================================================

-- True for the Supabase dashboard (SQL Editor) and automatic jobs.
create or replace function public.is_service_caller()
returns boolean
language sql
stable
as $$
  select auth.jwt() is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

-- Does the signed-in person have this permission? Admins have everything.
-- p_level 'view' is also true for people who have 'edit'.
create or replace function public.has_perm(p_key text, p_level text default 'view')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_service_caller() then true
    when public.is_admin() then true
    else coalesce((
      select case when p_level = 'edit' then up.perms ->> p_key = 'edit'
                  else up.perms ->> p_key in ('view', 'edit') end
        from public.user_permissions up
        join public.allowed_users a on a.email = up.user_email
       where up.user_email = public.current_user_email()
    ), false)
  end;
$$;

-- True when the person has at least one of these permissions.
create or replace function public.has_any_perm(p_keys text[], p_level text default 'edit')
returns boolean
language sql
stable
as $$
  select exists (select 1 from unnest(p_keys) k where public.has_perm(k, p_level));
$$;

-- Stops with a clear message when the permission is missing.
create or replace function public.require_perm(p_key text, p_level text default 'edit')
returns void
language plpgsql
stable
as $$
begin
  if not public.has_perm(p_key, p_level) then
    raise exception 'You do not have permission to do this (%). Ask an admin.', p_key
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.require_any_perm(p_keys text[], p_level text default 'edit')
returns void
language plpgsql
stable
as $$
begin
  if not public.has_any_perm(p_keys, p_level) then
    raise exception 'You do not have permission to do this (%). Ask an admin.', array_to_string(p_keys, ' or ')
      using errcode = '42501';
  end if;
end;
$$;

-- An Admin page: full admins, or people given that page ("admin.users", …).
create or replace function public.can_admin(p_area text)
returns boolean
language sql
stable
as $$
  select public.has_perm('admin.' || p_area, case when p_area = 'activity' then 'view' else 'edit' end);
$$;

create or replace function public.require_admin_area(p_area text)
returns void
language plpgsql
stable
as $$
begin
  if not public.can_admin(p_area) then
    raise exception 'You do not have permission to use this admin page (admin.%). Ask an admin.', p_area
      using errcode = '42501';
  end if;
end;
$$;

-- My own permissions, for the app to decide what to show.
create or replace function public.my_permissions()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select perms from public.user_permissions where user_email = public.current_user_email()),
    '{}'::jsonb);
$$;

-- ===========================================================================
-- 3. Changing permissions (full admins only), always logged
-- ===========================================================================

-- Keeps only well-formed keys with the values 'view' or 'edit'.
create or replace function public.clean_perms(p_perms jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_perms) = 'object' then p_perms else '{}'::jsonb end)
   where key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'
     and value in ('"view"'::jsonb, '"edit"'::jsonb);
$$;

-- What changed between two permission sets: added / removed / changed.
create or replace function public.perms_diff(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'added',   coalesce((select jsonb_object_agg(n.key, n.value) from jsonb_each(p_new) n
                          where not (p_old ? n.key)), '{}'::jsonb),
    'removed', coalesce((select jsonb_object_agg(o.key, o.value) from jsonb_each(p_old) o
                          where not (p_new ? o.key)), '{}'::jsonb),
    'changed', coalesce((select jsonb_object_agg(n.key, jsonb_build_object('old', p_old -> n.key, 'new', n.value))
                           from jsonb_each(p_new) n
                          where p_old ? n.key and p_old -> n.key <> n.value), '{}'::jsonb));
$$;

create or replace function public.require_full_admin()
returns void
language plpgsql
stable
as $$
begin
  if not (public.is_admin() or public.is_service_caller()) then
    raise exception 'Only admins can change permissions.' using errcode = '42501';
  end if;
end;
$$;

-- Replaces a person's permissions. p_source says where the ticks came from
-- ("template Shop floor", "copied from anna@…", "department Shipping"…).
-- Returns the change.
create or replace function public.set_user_permissions(p_email text, p_perms jsonb, p_source text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
  v_old   jsonb;
  v_new   jsonb := public.clean_perms(p_perms);
  v_diff  jsonb;
begin
  perform public.require_full_admin();
  if not exists (select 1 from public.allowed_users where email = v_email) then
    raise exception 'No user with the email %.', v_email;
  end if;
  select perms into v_old from public.user_permissions where user_email = v_email;
  v_old := coalesce(v_old, '{}'::jsonb);
  v_diff := public.perms_diff(v_old, v_new);
  if v_diff = '{"added": {}, "removed": {}, "changed": {}}'::jsonb then
    return v_diff;  -- nothing changed
  end if;

  insert into public.user_permissions (user_email, perms, updated_at, updated_by)
  values (v_email, v_new, now(), coalesce(public.current_user_email(), 'database'))
  on conflict (user_email) do update
    set perms = excluded.perms, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  insert into public.activity_log (user_id, user_email, table_name, record_id, order_id, action, changes)
  values (auth.uid(), auth.jwt() ->> 'email', 'user_permissions', v_email, null, 'admin',
          jsonb_build_object('action', 'permissions', 'user', v_email, 'source', p_source) || v_diff);
  return v_diff;
end;
$$;

-- Saves a department's preset (the ticks new people in it can start from).
create or replace function public.set_department_permissions(p_department_id uuid, p_perms jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old  jsonb;
  v_name text;
  v_new  jsonb := public.clean_perms(p_perms);
  v_diff jsonb;
begin
  perform public.require_full_admin();
  select default_permissions, name into v_old, v_name from public.departments where id = p_department_id;
  if v_name is null then
    raise exception 'That department could not be found.';
  end if;
  v_diff := public.perms_diff(coalesce(v_old, '{}'::jsonb), v_new);
  -- The departments table's own activity trigger logs the change.
  update public.departments set default_permissions = v_new where id = p_department_id;
  return v_diff;
end;
$$;

-- Saves (adds or replaces) a named template.
create or replace function public.save_permission_template(p_name text, p_perms jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_full_admin();
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'Give the template a name.';
  end if;
  update public.permission_templates
     set perms = public.clean_perms(p_perms)
   where lower(btrim(name)) = lower(btrim(p_name))
  returning id into v_id;
  if v_id is null then
    insert into public.permission_templates (name, perms)
    values (btrim(p_name), public.clean_perms(p_perms))
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- Only full admins can make someone an admin, change a role, or remove an admin
-- (people given "admin.users" can add and edit everyone else).
create or replace function public.allowed_users_guard_role()
returns trigger
language plpgsql
as $$
begin
  if public.is_admin() or public.is_service_caller() then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' and new.role = 'admin' then
    raise exception 'Only admins can make someone an admin.' using errcode = '42501';
  elsif tg_op = 'UPDATE' and new.role is distinct from old.role then
    raise exception 'Only admins can change someone''s role.' using errcode = '42501';
  elsif tg_op = 'DELETE' and old.role = 'admin' then
    raise exception 'Only admins can remove an admin.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger allowed_users_guard_role before insert or update or delete on public.allowed_users
  for each row execute function public.allowed_users_guard_role();

-- ===========================================================================
-- 4. Who may change what, field by field (orders, machines, customers)
-- ===========================================================================

-- The guard from 0012, now also letting people with "admin.records" through.
create or replace function public.guard_admin_fields()
returns trigger
language plpgsql
as $$
begin
  if public.is_admin() or public.is_system_change() or public.is_service_caller()
     or public.can_admin('records') or public.can_admin('import') then
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

-- Checks each changed column against its permission. Columns not listed can
-- only be changed by admins, "admin.records", or the app's own routines.
create or replace function public.check_field_permissions()
returns trigger
language plpgsql
as $$
declare
  v_map  jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'archived_at', 'archived_by', 'order_code'];
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
    v_map := jsonb_build_object('ready', 'order.machines.built');
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

create trigger ab_check_field_permissions before insert or update on public.orders
  for each row execute function public.check_field_permissions();
create trigger ab_check_field_permissions before insert or update on public.order_machines
  for each row execute function public.check_field_permissions();
create trigger ab_check_field_permissions before insert or update on public.customers
  for each row execute function public.check_field_permissions();

-- Checks for stage changes and queue moves (called by apply_board_change).
create or replace function public.check_board_change(p_order_id uuid, p_stage text, p_anchor_id uuid)
returns void
language plpgsql
stable
as $$
declare
  v_stage text;
begin
  select stage into v_stage from public.orders where id = p_order_id;
  if p_stage is not null and p_stage is distinct from v_stage then
    if p_stage = 'Shipped' then
      perform public.require_any_perm(array['order.action.mark_shipped', 'order.action.change_stage', 'orders.board.change_stage']);
    else
      perform public.require_any_perm(array['order.action.change_stage', 'orders.board.change_stage']);
    end if;
  elsif p_anchor_id is not null then
    perform public.require_any_perm(array['orders.board.reorder', 'orders.board.change_stage']);
  end if;
end;
$$;

-- ===========================================================================
-- 5. Hide money and contact columns from direct reads
-- Nobody (admins included) reads orders.order_total, customers.emails or
-- customers.phone straight from the tables any more; the app reads them from
-- order_summary, payment_overview and customer_list, which blank them out for
-- people without the permission. Writing them is still checked by the
-- triggers above.
-- ===========================================================================
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'orders' and column_name <> 'order_total';
  execute 'revoke select on public.orders from authenticated';
  execute format('grant select (%s) on public.orders to authenticated', v_cols);

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'customers' and column_name not in ('emails', 'phone');
  execute 'revoke select on public.customers from authenticated';
  execute format('grant select (%s) on public.customers to authenticated', v_cols);
end;
$$;

-- Internal helpers that read the order total run as the database owner.
alter function public.payments_set_balance_amount() security definer set search_path = public;
alter function public.refresh_balance(uuid) security definer set search_path = public;

-- ===========================================================================
-- 6. Secure views (run as the owner, filter rows and blank out what the
--    person may not see)
-- ===========================================================================

-- Customers, with emails / phone only for people with "customer.contact".
create view public.customer_list
with (security_invoker = false)
as
select
  c.id,
  c.name,
  c.company,
  case when (select public.has_perm('customer.contact')) then c.emails else '{}'::text[] end as emails,
  case when (select public.has_perm('customer.contact')) then c.phone end                   as phone,
  c.country,
  c.state_province,
  c.notes,
  c.archived,
  c.archived_at,
  c.archived_by,
  c.created_at,
  c.updated_at
from public.customers c
where (select public.is_allowed_user());

-- order_summary: same columns as before; money only with the permissions.
create or replace view public.order_summary
with (security_invoker = false)
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
  case when (select public.has_perm('order.field.order_total')) then o.order_total end::numeric(12, 2) as order_total,
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
  case when (select public.has_perm('payments')) then dp.amount end::numeric(12, 2) as down_payment_amount,
  case when (select public.has_perm('payments')) and (select public.has_perm('order.field.order_total'))
            and o.order_total > 0 and dp.amount is not null
       then round(dp.amount * 100 / o.order_total, 1) end as down_payment_percent,
  case when (select public.has_perm('payments')) then coalesce(p.total_paid, 0) end as total_paid,
  case when (select public.has_perm('payments')) and (select public.has_perm('order.field.order_total'))
       then o.order_total - coalesce(p.total_paid, 0) end as amount_outstanding,
  case when (select public.has_perm('payments')) then p.next_due_date end as next_due_date,
  case when not (select public.has_perm('payments')) then null
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
  select sum(coalesce(pp.received_amount, 0))                           as total_paid,
         min(pp.due_date) filter (where pp.amount - coalesce(pp.received_amount, 0) > 0) as next_due_date
    from public.payments pp
   where pp.order_id = o.id
) p on true
left join public.payments dp on dp.order_id = o.id and dp.payment_type = 'Down payment'
where (select public.is_allowed_user()) or public.is_service_caller();

-- payment_overview: only for people with "payments"; emails only with "customer.contact".
create or replace view public.payment_overview
with (security_invoker = false)
as
select
  p.id,
  p.order_id,
  o.order_number,
  o.split_number,
  o.order_code,
  o.stage,
  o.archived                                     as order_archived,
  o.currency,
  o.customer_id,
  c.name                                         as customer_name,
  c.company                                      as customer_company,
  c.country                                      as customer_country,
  case when (select public.has_perm('customer.contact')) then c.emails else '{}'::text[] end as customer_emails,
  p.payment_type,
  p.amount,
  coalesce(p.received_amount, 0)                as received_amount,
  greatest(p.amount - coalesce(p.received_amount, 0), 0) as remaining,
  p.due_date,
  p.received_date,
  p.notes,
  p.due_date - (now() at time zone 'America/Halifax')::date as days_until_due,
  case
    when p.amount <= 0                                           then 'Nothing due'
    when p.amount - coalesce(p.received_amount, 0) <= 0          then 'Paid'
    when p.due_date < (now() at time zone 'America/Halifax')::date      then 'Overdue'
    when p.due_date <= (now() at time zone 'America/Halifax')::date + 7 then 'Due soon'
    else 'Upcoming'
  end                                            as status,
  p.created_at
from public.payments p
join public.orders o    on o.id = p.order_id
join public.customers c on c.id = o.customer_id
where ((select public.is_allowed_user()) and (select public.has_perm('payments')))
   or public.is_service_caller();

-- Activity history: order lines for people with the order's Activity tab,
-- everything for "admin.activity"; payment lines only with "payments",
-- crate lines only with "crating", and order totals removed without
-- "order.field.order_total".
create view public.activity_feed
with (security_invoker = false)
as
select
  l.id,
  l.at,
  l.user_email,
  l.user_departments,
  l.table_name,
  l.record_id,
  l.order_id,
  l.action,
  case
    when l.table_name = 'customers' and not (select public.has_perm('customer.contact'))
      then l.changes - 'emails' - 'phone'
    when not (select public.has_perm('order.field.order_total'))
      then l.changes - 'order_total'
    else l.changes
  end as changes
from public.activity_log l
where (select public.is_allowed_user())
  and ((select public.can_admin('activity'))
       or (l.order_id is not null and (select public.has_perm('order.tab.activity'))))
  and (l.table_name <> 'payments' or (select public.has_perm('payments')))
  and (l.table_name not in ('crates', 'crate_machines') or (select public.has_perm('crating')));

-- Nobody reads the raw log any more; the app reads activity_feed.
drop policy "Admins read all, staff read order history" on public.activity_log;
revoke select on public.activity_log from authenticated;

-- ===========================================================================
-- 7. Table rules (Row Level Security)
-- ===========================================================================

-- orders
drop policy "Allowed users can add" on public.orders;
drop policy "Admins can delete" on public.orders;
create policy "Allowed to create orders" on public.orders
  for insert to authenticated
  with check ((select public.has_any_perm(array['orders.new', 'admin.records', 'admin.import'])));
create policy "Admins can delete" on public.orders
  for delete to authenticated using ((select public.can_admin('archive')));

-- customers
drop policy "Allowed users can add" on public.customers;
drop policy "Allowed users can edit" on public.customers;
drop policy "Admins can delete" on public.customers;
create policy "Allowed to add customers" on public.customers
  for insert to authenticated
  with check ((select public.has_any_perm(array['orders.new', 'admin.records', 'admin.import'])));
create policy "Allowed to edit customers" on public.customers
  for update to authenticated
  using ((select public.has_any_perm(array['admin.records', 'admin.archive', 'admin.import', 'customer.contact'])))
  with check ((select public.has_any_perm(array['admin.records', 'admin.archive', 'admin.import', 'customer.contact'])));
create policy "Admins can delete" on public.customers
  for delete to authenticated using ((select public.can_admin('archive')));

-- order_machines
drop policy "Allowed users can add" on public.order_machines;
drop policy "Admins can delete" on public.order_machines;
create policy "Allowed to add machines" on public.order_machines
  for insert to authenticated
  with check ((select public.has_any_perm(array['orders.new', 'order.machines.add', 'admin.records', 'admin.import'])));
create policy "Admins can delete" on public.order_machines
  for delete to authenticated using ((select public.can_admin('archive')));

-- payments: nothing at all without "payments"
drop policy "Allowed users can read" on public.payments;
drop policy "Allowed users can add" on public.payments;
drop policy "Allowed users can edit" on public.payments;
drop policy "Admins can delete" on public.payments;
create policy "Payments: view" on public.payments
  for select to authenticated using ((select public.has_perm('payments', 'view')));
create policy "Payments: add" on public.payments
  for insert to authenticated with check ((select public.has_perm('payments', 'edit')));
create policy "Payments: edit" on public.payments
  for update to authenticated
  using ((select public.has_perm('payments', 'edit'))) with check ((select public.has_perm('payments', 'edit')));
create policy "Payments: delete" on public.payments
  for delete to authenticated
  using ((select public.has_perm('payments', 'edit')) and (select public.has_perm('payments.action.delete', 'edit')));

-- crates
drop policy "Allowed users can read" on public.crates;
drop policy "Allowed users can add" on public.crates;
drop policy "Allowed users can edit" on public.crates;
drop policy "Admins can delete" on public.crates;
create policy "Crating: view" on public.crates
  for select to authenticated using ((select public.has_perm('crating', 'view')));
create policy "Crating: add" on public.crates
  for insert to authenticated with check ((select public.has_perm('crating', 'edit')));
create policy "Crating: edit" on public.crates
  for update to authenticated
  using ((select public.has_perm('crating', 'edit'))) with check ((select public.has_perm('crating', 'edit')));
create policy "Admins can delete" on public.crates
  for delete to authenticated using ((select public.can_admin('archive')));

drop policy "Allowed users can do everything" on public.crate_machines;
create policy "Crating: view" on public.crate_machines
  for select to authenticated using ((select public.has_perm('crating', 'view')));
create policy "Crating: add" on public.crate_machines
  for insert to authenticated with check ((select public.has_perm('crating', 'edit')));
create policy "Crating: remove" on public.crate_machines
  for delete to authenticated using ((select public.has_perm('crating', 'edit')));

-- Admin pages
drop policy "Admins can change" on public.machine_types;
create policy "Admins can change" on public.machine_types
  for all to authenticated
  using ((select public.can_admin('machine_types'))) with check ((select public.can_admin('machine_types')));

drop policy "Admins can change" on public.option_lists;
create policy "Admins can change" on public.option_lists
  for all to authenticated
  using ((select public.can_admin('dropdowns'))) with check ((select public.can_admin('dropdowns')));

drop policy "Admins can change" on public.app_settings;
create policy "Admins can change" on public.app_settings
  for all to authenticated
  using ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company'))))
  with check ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company'))));

drop policy "Admins can change" on public.departments;
create policy "Admins can change" on public.departments
  for all to authenticated
  using ((select public.can_admin('departments'))) with check ((select public.can_admin('departments')));

drop policy "Users see themselves, admins see everyone" on public.allowed_users;
drop policy "Admins can manage users" on public.allowed_users;
create policy "Users see themselves, user managers see everyone" on public.allowed_users
  for select to authenticated
  using (email = (select public.current_user_email())
         or (select public.can_admin('users'))
         or (select public.can_admin('activity')));
create policy "User managers can change users" on public.allowed_users
  for all to authenticated
  using ((select public.can_admin('users'))) with check ((select public.can_admin('users')));

drop policy "Admins manage, people see their own" on public.user_departments;
drop policy "Admins can change" on public.user_departments;
create policy "User managers see all, people see their own" on public.user_departments
  for select to authenticated
  using ((select public.can_admin('users')) or user_email = (select public.current_user_email()));
create policy "User managers can change" on public.user_departments
  for all to authenticated
  using ((select public.can_admin('users'))) with check ((select public.can_admin('users')));

-- ===========================================================================
-- 8. Checks inside the app's routines (copies of the latest versions with
--    one permission line added at the top)
-- ===========================================================================
-- create_order (from 0008_create_order.sql): needs "orders.new"
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

-- apply_board_change (from 0009_board_moves.sql): stage changes / shipping / queue moves need their permission; runs as the owner because it reads whole order rows
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

-- change_order_machines (from 0015_change_order_machines.sql): adding / removing machines need their permission
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
  if coalesce(jsonb_array_length(p_add), 0) > 0 then perform public.require_perm('order.machines.add'); end if;
  if coalesce(cardinality(p_remove), 0) > 0 then perform public.require_perm('order.machines.remove'); end if;
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

-- record_payment_received (from 0010_payments_received.sql): needs "payments.action.mark_received" (and "payments" edit, by the table rules)
create or replace function public.record_payment_received(
  p_payment_id uuid,
  p_date       date,
  p_amount     numeric
)
returns void
language plpgsql
as $$
begin
  perform public.require_perm('payments.action.mark_received');
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount received (more than 0).';
  end if;
  if p_date is null then
    raise exception 'Enter the date the payment was received.';
  end if;
  update public.payments
     set received_amount = coalesce(received_amount, 0) + round(p_amount, 2),
         received_date   = p_date
   where id = p_payment_id;
  if not found then
    raise exception 'That payment could not be found.';
  end if;
end;
$$;

-- save_crate (from 0017_crating.sql): needs "crating" edit
create or replace function public.save_crate(p_crate jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id       uuid := nullif(p_crate ->> 'id', '')::uuid;
  v_order    uuid := nullif(p_crate ->> 'order_id', '')::uuid;
  v_machines uuid[];
  v_bad      integer;
begin
  perform public.require_perm('crating');
  if v_order is null then
    raise exception 'The order is missing.';
  end if;

  select coalesce(array_agg(distinct x::uuid), '{}')
    into v_machines
    from jsonb_array_elements_text(coalesce(p_crate -> 'machine_ids', '[]'::jsonb)) as x;
  if cardinality(v_machines) = 0 then
    raise exception 'Pick at least one machine for this crate.';
  end if;

  select count(*) into v_bad
    from unnest(v_machines) as m(id)
   where not exists (
     select 1 from public.order_machines om
      where om.id = m.id and om.order_id = v_order and not om.archived
   );
  if v_bad > 0 then
    raise exception 'All machines in a crate must be on the same order.';
  end if;

  if v_id is null then
    insert into public.crates (order_id, length_cm, width_cm, height_cm, weight_kg,
                               plywood_sheets, build_hours, crated_on, crated_by, notes)
    values (
      v_order,
      (p_crate ->> 'length_cm')::numeric,
      (p_crate ->> 'width_cm')::numeric,
      (p_crate ->> 'height_cm')::numeric,
      (p_crate ->> 'weight_kg')::numeric,
      (p_crate ->> 'plywood_sheets')::numeric,
      (p_crate ->> 'build_hours')::numeric,
      coalesce(nullif(p_crate ->> 'crated_on', '')::date, (now() at time zone 'America/Halifax')::date),
      nullif(btrim(p_crate ->> 'crated_by'), ''),
      nullif(btrim(p_crate ->> 'notes'), '')
    )
    returning id into v_id;
  else
    update public.crates set
      length_cm      = (p_crate ->> 'length_cm')::numeric,
      width_cm       = (p_crate ->> 'width_cm')::numeric,
      height_cm      = (p_crate ->> 'height_cm')::numeric,
      weight_kg      = (p_crate ->> 'weight_kg')::numeric,
      plywood_sheets = (p_crate ->> 'plywood_sheets')::numeric,
      build_hours    = (p_crate ->> 'build_hours')::numeric,
      crated_on      = coalesce(nullif(p_crate ->> 'crated_on', '')::date, crated_on),
      crated_by      = nullif(btrim(p_crate ->> 'crated_by'), ''),
      notes          = nullif(btrim(p_crate ->> 'notes'), '')
     where id = v_id and order_id = v_order and not archived;
    if not found then
      raise exception 'This crate could not be found. Someone may have removed it; refresh the page.';
    end if;
  end if;

  delete from public.crate_machines
   where crate_id = v_id and machine_id <> all (v_machines);
  insert into public.crate_machines (crate_id, machine_id)
  select v_id, m from unnest(v_machines) as m
  on conflict do nothing;

  return v_id;
end;
$$;

-- uncrate_machine (from 0017_crating.sql): needs "crating" edit
create or replace function public.uncrate_machine(p_machine_id uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_archived integer;
begin
  perform public.require_perm('crating');
  update public.crates c
     set archived = true
   where not c.archived
     and exists (select 1 from public.crate_machines cm
                  where cm.crate_id = c.id and cm.machine_id = p_machine_id)
     and not exists (select 1 from public.crate_machines cm
                       join public.order_machines om on om.id = cm.machine_id
                      where cm.crate_id = c.id
                        and cm.machine_id <> p_machine_id
                        and om.order_id = c.order_id
                        and not om.archived);
  get diagnostics v_archived = row_count;

  -- Archived crates keep their links (history); shared ones drop this machine.
  delete from public.crate_machines cm
   using public.crates c
   where c.id = cm.crate_id and cm.machine_id = p_machine_id and not c.archived;

  return v_archived;
end;
$$;

-- admin_board_change (from 0012_admin.sql): admins or "admin.board"
create or replace function public.admin_board_change(p_order_id uuid, p_position integer, p_apply boolean)
returns jsonb
language plpgsql
as $$
declare
  v_before jsonb;
  v_result jsonb;
  v_code   text;
begin
  perform public.require_admin_area('board');
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

-- admin_set_serial (from 0012_admin.sql): admins or "admin.serials"
create or replace function public.admin_set_serial(p_machine_id uuid, p_serial text)
returns void
language plpgsql
as $$
declare
  v_m      public.order_machines%rowtype;
  v_serial text := upper(nullif(btrim(p_serial), ''));
  v_taken  text;
begin
  perform public.require_admin_area('serials');
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

-- admin_resequence_serials (from 0012_admin.sql): admins or "admin.serials"
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
  perform public.require_admin_area('serials');
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

-- admin_delete_record (from 0012_admin.sql): admins or "admin.archive"
create or replace function public.admin_delete_record(p_table text, p_id uuid, p_confirm text)
returns void
language plpgsql
as $$
declare
  v_label    text;
  v_archived boolean;
  v_order_id uuid;
begin
  perform public.require_admin_area('archive');
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

-- import_sheet (from 0014_import_page.sql): admins or "admin.import"; runs as the owner because it reads the hidden order total and emails
create or replace function public.import_sheet(p_orders jsonb, p_skipped integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
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
  perform public.require_admin_area('import');
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

-- ===========================================================================
-- Access lockdown, as in earlier migrations
-- ===========================================================================
revoke all on public.user_permissions, public.permission_templates,
              public.customer_list, public.activity_feed from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
