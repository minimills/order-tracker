-- 0022_scheduling.sql
-- Defaults for new orders, build times, expected ship dates and department
-- deadlines.
--
-- 1. Settings (app_settings), editable in Admin:
--    'order_defaults' (Admin → Order defaults): currency for Canada / elsewhere,
--      voltage, "Crate?" default, down payment due (days after the order),
--      balance due (days before the expected ship date).
--    'scheduling' (Admin → Scheduling): working days (ISO 1 = Monday … 7),
--      company holidays, buffer days before shipping, machines in one order
--      built one after another (default) or at the same time.
-- 2. machine_types.build_days: default working days per step
--    ({"fabrication": 5, "sandblasting": 1, …}), edited in Admin → Machine types.
-- 3. order_machines.needs_crate ("Crate?" on each machine; only crated
--    machines get a crating deadline). orders.production_started_on (filled
--    when an order first goes into production), orders.schedule_kept
--    (a suggestion someone chose to keep).
-- 4. machine_steps: a department step marked done for a machine (who, when).
--    This is the real build data the averages use.
-- 5. order_deadlines: the PROMISED deadline per machine and step. They only
--    change through accept_schedule() (never silently).
-- 6. deadline_results: recorded when a step is marked done – its deadline at
--    that moment and how many days late it was (Reports → Department delays).
-- 7. machine_type_step_stats: average working days per type and step over the
--    last 5 builds (the app uses it once a step has at least 3 builds).
-- 8. accept_schedule / keep_schedule, and create_order saves "Crate?".

-- ===========================================================================
-- 1. Settings
-- ===========================================================================
insert into public.app_settings (key, value) values
  ('order_defaults', '{"currency_canada": "CAD", "currency_other": "USD", "voltage": "240V", "crate": true, "down_payment_days": 30, "balance_days_before_ship": 90}'),
  ('scheduling', '{"working_days": [1, 2, 3, 4, 5], "holidays": [], "buffer_days": 8, "machines_in_parallel": false}')
on conflict (key) do nothing;

drop policy "Admins can change" on public.app_settings;
create policy "Admins can change" on public.app_settings
  for all to authenticated
  using ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company')))
         or (key = 'stage_labels' and (select public.can_admin('stages')))
         or (key = 'order_defaults' and (select public.can_admin('order_defaults')))
         or (key = 'scheduling' and (select public.can_admin('scheduling'))))
  with check ((select public.is_admin())
         or (key = 'alerts' and (select public.can_admin('alerts')))
         or (key = 'company' and (select public.can_admin('company')))
         or (key = 'stage_labels' and (select public.can_admin('stages')))
         or (key = 'order_defaults' and (select public.can_admin('order_defaults')))
         or (key = 'scheduling' and (select public.can_admin('scheduling'))));

-- Working-day helpers (they read the 'scheduling' settings).
create or replace function public.scheduling_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.app_settings where key = 'scheduling'), '{}'::jsonb);
$$;

create or replace function public.is_working_day(p_day date)
returns boolean
language sql
stable
as $$
  select extract(isodow from p_day)::integer in
           (select jsonb_array_elements_text(coalesce(s -> 'working_days', '[1,2,3,4,5]'::jsonb))::integer)
     and not exists (select 1 from jsonb_array_elements(coalesce(s -> 'holidays', '[]'::jsonb)) h
                      where (h ->> 'date')::date = p_day)
    from (select public.scheduling_settings() as s) x;
$$;

-- Working days after p_from up to and including p_to (0 when p_to <= p_from).
create or replace function public.working_days_between(p_from date, p_to date)
returns integer
language sql
stable
as $$
  select count(*)::integer
    from generate_series(p_from + 1, p_to, interval '1 day') as g(d)
   where p_to > p_from and public.is_working_day(g.d::date);
$$;

-- ===========================================================================
-- 2–3. New columns
-- ===========================================================================
alter table public.machine_types
  add column build_days jsonb not null default '{}'::jsonb check (jsonb_typeof(build_days) = 'object');

alter table public.order_machines
  add column needs_crate boolean not null default true;

alter table public.orders
  add column production_started_on date,
  add column schedule_kept text;
-- Order columns are granted one by one since 0018 (the total is hidden).
grant select (production_started_on, schedule_kept) on public.orders to authenticated;

-- The day an order first went into production (for build-time averages).
create or replace function public.orders_production_started()
returns trigger
language plpgsql
as $$
begin
  if new.production_started_on is null
     and new.stage in ('In production', 'Ready', 'Ready to ship', 'Shipped')
     and (tg_op = 'INSERT' or old.stage in ('Quote', 'Confirmed')) then
    new.production_started_on := (now() at time zone 'America/Halifax')::date;
  end if;
  return new;
end;
$$;
create trigger orders_production_started before insert or update of stage on public.orders
  for each row execute function public.orders_production_started();

-- ===========================================================================
-- 4. Steps marked done
-- ===========================================================================
create table public.machine_steps (
  machine_id   uuid not null references public.order_machines (id) on delete cascade,
  step         text not null check (step in ('fabrication', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating')),
  order_id     uuid not null references public.orders (id) on delete cascade,
  done_on      date not null default (now() at time zone 'America/Halifax')::date,
  done_by_name text,
  created_at   timestamptz not null default now(),
  primary key (machine_id, step)
);
create index machine_steps_order_idx on public.machine_steps (order_id);
alter table public.machine_steps enable row level security;

create or replace function public.machine_steps_fill()
returns trigger
language plpgsql
as $$
begin
  select order_id into new.order_id from public.order_machines where id = new.machine_id;
  new.done_by_name := public.current_user_name();
  return new;
end;
$$;
create trigger machine_steps_fill before insert or update on public.machine_steps
  for each row execute function public.machine_steps_fill();
create trigger log_activity after insert or update or delete on public.machine_steps
  for each row execute function public.log_activity();

create policy "Allowed users can read" on public.machine_steps
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Step done: add" on public.machine_steps
  for insert to authenticated with check ((select public.has_perm('schedule.step_done', 'edit')));
create policy "Step done: change" on public.machine_steps
  for update to authenticated
  using ((select public.has_perm('schedule.step_done', 'edit'))) with check ((select public.has_perm('schedule.step_done', 'edit')));
create policy "Step done: undo" on public.machine_steps
  for delete to authenticated using ((select public.has_perm('schedule.step_done', 'edit')));

-- ===========================================================================
-- 5. Promised deadlines
-- ===========================================================================
create table public.order_deadlines (
  order_id    uuid not null references public.orders (id) on delete cascade,
  machine_id  uuid not null references public.order_machines (id) on delete cascade,
  step        text not null check (step in ('fabrication', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating')),
  due_on      date not null,
  accepted_at timestamptz not null default now(),
  primary key (machine_id, step)
);
create index order_deadlines_order_idx on public.order_deadlines (order_id);
alter table public.order_deadlines enable row level security;
create policy "Allowed users can read" on public.order_deadlines
  for select to authenticated using ((select public.is_allowed_user()));
-- Written only by accept_schedule().

-- ===========================================================================
-- 6. Results for the Department delays report
-- ===========================================================================
create table public.deadline_results (
  machine_id  uuid not null references public.order_machines (id) on delete cascade,
  step        text not null,
  order_id    uuid not null references public.orders (id) on delete cascade,
  due_on      date not null,
  done_on     date not null,
  days_late   integer not null,   -- negative = early
  recorded_at timestamptz not null default now(),
  primary key (machine_id, step)
);
alter table public.deadline_results enable row level security;
create policy "Report readers" on public.deadline_results
  for select to authenticated using ((select public.has_perm('reports.department_delays')));

create or replace function public.machine_steps_record_result()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.deadline_results where machine_id = old.machine_id and step = old.step;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into public.deadline_results (machine_id, step, order_id, due_on, done_on, days_late)
    select new.machine_id, new.step, new.order_id, d.due_on, new.done_on, new.done_on - d.due_on
      from public.order_deadlines d
     where d.machine_id = new.machine_id and d.step = new.step;
  end if;
  return null;
end;
$$;
create trigger machine_steps_record_result after insert or update or delete on public.machine_steps
  for each row execute function public.machine_steps_record_result();

-- ===========================================================================
-- 7. Average build time per type and step (last 5 builds)
-- A step's time = working days from the previous step done (or, for the first
-- step done, from the day the order went into production) to the day it was
-- marked done.
-- ===========================================================================
create view public.machine_type_step_stats
with (security_invoker = true)
as
with ordered as (
  select ms.machine_id, ms.step, ms.done_on, om.machine_type_id, o.production_started_on,
         lag(ms.done_on) over (
           partition by ms.machine_id
           order by array_position(array['fabrication', 'sandblasting', 'powder_coating', 'assembly', 'final_check', 'crating'], ms.step)
         ) as previous_done
    from public.machine_steps ms
    join public.order_machines om on om.id = ms.machine_id
    join public.orders o on o.id = om.order_id
),
durations as (
  select machine_type_id, step, done_on,
         case when previous_done is not null then public.working_days_between(previous_done, done_on)
              when production_started_on is not null then public.working_days_between(production_started_on - 1, done_on)
         end as days
    from ordered
),
latest as (
  select *, row_number() over (partition by machine_type_id, step order by done_on desc) as rn
    from durations
   where days is not null and days > 0
)
select machine_type_id, step, count(*)::integer as builds, round(avg(days)::numeric, 1) as avg_days
  from latest
 where rn <= 5
 group by machine_type_id, step;

-- ===========================================================================
-- 8. Accepting / keeping suggested dates
-- ===========================================================================

-- Saves an order's promised ship date and department deadlines.
-- p_deadlines: [{"machine_id": "…", "step": "fabrication", "due_on": "2026-12-01"}, …]
-- The first time (no deadlines yet) people who can create orders may do it;
-- after that it needs "schedule.accept".
create or replace function public.accept_schedule(p_order_id uuid, p_ship_date date, p_deadlines jsonb, p_initial boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old date;
begin
  if p_initial and not exists (select 1 from public.order_deadlines where order_id = p_order_id) then
    perform public.require_any_perm(array['schedule.accept', 'orders.new']);
  else
    perform public.require_perm('schedule.accept');
  end if;
  select expected_ship_date into v_old from public.orders where id = p_order_id;
  if not found then
    raise exception 'That order could not be found.';
  end if;

  perform set_config('app.system_change', 'on', true);
  update public.orders set expected_ship_date = p_ship_date, schedule_kept = null where id = p_order_id;
  delete from public.order_deadlines where order_id = p_order_id;
  insert into public.order_deadlines (order_id, machine_id, step, due_on)
  select p_order_id, om.id, d ->> 'step', (d ->> 'due_on')::date
    from jsonb_array_elements(coalesce(p_deadlines, '[]'::jsonb)) d
    join public.order_machines om on om.id = (d ->> 'machine_id')::uuid and om.order_id = p_order_id
  on conflict (machine_id, step) do update set due_on = excluded.due_on;

  perform public.log_admin_action('orders', p_order_id::text, p_order_id,
    jsonb_build_object('action', case when p_initial then 'schedule set' else 'schedule accepted' end,
                       'old_ship', v_old, 'new_ship', p_ship_date,
                       'deadlines', jsonb_array_length(coalesce(p_deadlines, '[]'::jsonb))));
end;
$$;

-- Keeps the promised dates although new ones were suggested (not asked again
-- until the suggestion changes).
create or replace function public.keep_schedule(p_order_id uuid, p_signature text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('schedule.accept');
  perform set_config('app.system_change', 'on', true);
  update public.orders set schedule_kept = p_signature where id = p_order_id;
  perform public.log_admin_action('orders', p_order_id::text, p_order_id,
    jsonb_build_object('action', 'schedule suggestion kept (promised dates unchanged)'));
end;
$$;

-- create_order (copy of the 0018 version): saves "Crate?" per machine.
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

-- check_field_permissions (copy of the 0020 version) + "Crate?", and a fix:
-- non-admins adding a customer or machine (New order) got "record new has no
-- field order_total".
create or replace function public.check_field_permissions()
returns trigger
language plpgsql
as $$
declare
  v_map  jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'archived_at', 'archived_by', 'order_code',
                          'checklist_done_at', 'checklist_done_by'];
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
    v_map := jsonb_build_object('ready', 'order.machines.built', 'needs_crate', 'order.machines.crate_flag');
  elsif tg_table_name = 'customers' then
    v_map := jsonb_build_object('emails', 'customer.contact', 'phone', 'customer.contact');
  end if;

  if tg_op = 'INSERT' then
    -- Read the fields through jsonb: each table has different columns (fix: the
    -- 0018 version failed for non-admins adding a customer or a machine).
    v_new := to_jsonb(new);
    if tg_table_name = 'orders' and coalesce((v_new ->> 'order_total')::numeric, 0) <> 0 then
      perform public.require_perm('order.field.order_total', 'edit');
    elsif tg_table_name = 'customers'
          and (coalesce(jsonb_array_length(v_new -> 'emails'), 0) > 0 or nullif(btrim(v_new ->> 'phone'), '') is not null) then
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

-- Board chips / scheduling: same as 0020, plus "Crate?" at the end.
create or replace view public.order_machine_status
with (security_invoker = true)
as
select
  om.id,
  om.order_id,
  om.machine_type_id,
  mt.name                                   as machine_type,
  coalesce(nullif(btrim(mt.short_name), ''), mt.name) as short_name,
  om.serial_number,
  om.ready,
  om.checklist_done,
  coalesce(mc.crate_count, 0)               as crate_count,
  om.created_at,
  cs.status                                 as checklist_status,
  cs.total_items                            as checklist_total,
  cs.done_items + cs.na_items               as checklist_completed,
  om.needs_crate
from public.order_machines om
join public.machine_types mt on mt.id = om.machine_type_id
left join public.machine_crating mc on mc.machine_id = om.id
left join public.machine_checklist_status cs on cs.machine_id = om.id
where not om.archived;

-- The new report can be a start page too.
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/reports/department-delays',
     '/agent', '/settings', '/admin', '/shop-board'));

-- Access lockdown, as in earlier migrations.
revoke all on public.machine_steps, public.order_deadlines, public.deadline_results, public.machine_type_step_stats from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
