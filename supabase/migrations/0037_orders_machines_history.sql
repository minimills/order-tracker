-- 0037_orders_machines_history.sql
-- 1. Quote # and Invoice # on orders.
-- 2. Revised ship dates: the first promised ship date is kept
--    (orders.original_ship_date) when the expected ship date changes; every
--    change is recorded in ship_date_changes (old, new, who, when, reason).
--    Delay is always counted from the original promised date.
-- 3. Order defaults: machines are not crated by default; full payment due 30
--    days after the order date when the ship date is less than 90 days away
--    (both numbers in Admin → Order Defaults).
-- 4. Colours for dropdown choices (voltage chips on the Orders board), set in
--    Admin → Dropdown Lists.
-- 6. The shop board view per person (set_my_preferences: shop_board_view).
-- 5. Machine history: a machine can be resold or transferred to another
--    customer (machine_owners, transfer_machine()); the Machine page shows its
--    whole story (machine_details()).

-- ===========================================================================
-- 1. Quote # and Invoice #
-- ===========================================================================
alter table public.orders
  add column quote_number text check (quote_number is null or length(quote_number) <= 60),
  add column invoice_number text check (invoice_number is null or length(invoice_number) <= 60),
  add column original_ship_date date;
grant select (quote_number, invoice_number, original_ship_date) on public.orders to authenticated;

-- ===========================================================================
-- 2. Revised ship dates
-- ===========================================================================
create table public.ship_date_changes (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id) on delete cascade,
  old_date        date,
  new_date        date,
  changed_by      text,
  changed_by_name text,
  changed_at      timestamptz not null default now(),
  reason          text check (reason is null or length(reason) <= 500)
);
create index ship_date_changes_order_idx on public.ship_date_changes (order_id, changed_at);
alter table public.ship_date_changes enable row level security;
create policy "Allowed users can read" on public.ship_date_changes
  for select to authenticated using ((select public.is_allowed_user()));
revoke insert, update, delete on public.ship_date_changes from authenticated;

-- Keep the first promised date (runs after the permission checks).
create or replace function public.orders_keep_original_ship()
returns trigger
language plpgsql
as $$
begin
  if old.expected_ship_date is not null and new.expected_ship_date is distinct from old.expected_ship_date then
    new.original_ship_date := coalesce(old.original_ship_date, old.expected_ship_date);
  end if;
  return new;
end;
$$;
create trigger orders_original_ship before update of expected_ship_date on public.orders
  for each row execute function public.orders_keep_original_ship();

create or replace function public.orders_record_ship_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  if old.expected_ship_date is not null and new.expected_ship_date is distinct from old.expected_ship_date then
    insert into public.ship_date_changes (order_id, old_date, new_date, changed_by, changed_by_name, reason)
    values (new.id, old.expected_ship_date, new.expected_ship_date, v_me,
            coalesce((select nullif(btrim(name), '') from public.allowed_users where email = v_me), v_me),
            nullif(btrim(current_setting('app.ship_change_reason', true)), ''));
  end if;
  return null;
end;
$$;
create trigger orders_ship_change after update of expected_ship_date on public.orders
  for each row execute function public.orders_record_ship_change();

-- The reason for the change just made (by me, in the last 10 minutes).
create or replace function public.set_ship_change_reason(p_order uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_allowed_user() then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  update public.ship_date_changes
     set reason = nullif(left(btrim(p_reason), 500), '')
   where id = (select id from public.ship_date_changes
                where order_id = p_order and changed_by = public.current_user_email()
                  and changed_at > now() - interval '10 minutes'
                order by changed_at desc limit 1);
end;
$$;

-- Delay from the original promised date; quote / invoice / revisions on the summary.
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
  -- Delay is always counted from the ORIGINAL promised date (0037); negative = early.
  o.actual_ship_date - coalesce(o.original_ship_date, o.expected_ship_date) as delay_days,
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
  o.updated_at,
  -- 0037: quote / invoice numbers and revised ship dates
  o.quote_number,
  o.invoice_number,
  coalesce(o.original_ship_date, o.expected_ship_date) as original_ship_date,
  (select count(*)::integer from public.ship_date_changes sc where sc.order_id = o.id) as ship_date_revisions
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


-- New editable columns in the permission check.
create or replace function public.check_field_permissions()
returns trigger
language plpgsql
as $$
declare
  v_map  jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'archived_at', 'archived_by', 'order_code',
                          'checklist_done_at', 'checklist_done_by', 'original_ship_date'];
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
      'split_number',       'orders.new',
      -- service (0029)
      'training_needed',    'order.field.training_needed',
      'training_days',      'order.field.training_days',
      'travel_days',        'order.field.travel_days',
      'technician_email',   'order.field.technician',
      'service_start',      'order.field.service_dates',
      'service_end',        'order.field.service_dates',
      -- 0037
      'quote_number',       'order.field.quote_number',
      'invoice_number',     'order.field.invoice_number');
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


-- ===========================================================================
-- 3. Order defaults
-- ===========================================================================
alter table public.order_machines alter column needs_crate set default false;
insert into public.app_settings (key, value) values ('order_defaults', '{}'::jsonb) on conflict (key) do nothing;
update public.app_settings
   set value = value || jsonb_build_object('crate', false)
                     || jsonb_build_object('full_payment_within_days', coalesce(value -> 'full_payment_within_days', '90'::jsonb),
                                           'full_payment_due_days', coalesce(value -> 'full_payment_due_days', '30'::jsonb))
 where key = 'order_defaults';

-- ===========================================================================
-- 4. Colours for dropdown choices
-- ===========================================================================
alter table public.option_lists add column colour text check (colour is null or colour ~ '^#[0-9a-fA-F]{6}$');
update public.option_lists set colour = case value when '120V' then '#2a78d6' when '240V' then '#d97706' else '#dc2626' end
 where list_name = 'voltage' and colour is null;

-- ===========================================================================
-- 5. Machine history (resale / transfer)
-- ===========================================================================
create table public.machine_owners (
  id          uuid primary key default gen_random_uuid(),
  machine_id  uuid not null references public.order_machines (id) on delete cascade,
  customer_id uuid not null references public.customers (id),
  owned_from  date not null,
  order_id    uuid references public.orders (id) on delete set null,
  notes       text check (notes is null or length(notes) <= 2000),
  created_by  text default public.current_user_email(),
  created_at  timestamptz not null default now()
);
create index machine_owners_machine_idx on public.machine_owners (machine_id, owned_from);
create index machine_owners_customer_idx on public.machine_owners (customer_id);
alter table public.machine_owners enable row level security;
create policy "Machine page readers" on public.machine_owners
  for select to authenticated using ((select public.has_perm('machines')));
revoke insert, update, delete on public.machine_owners from authenticated;
create trigger log_activity after insert or update or delete on public.machine_owners
  for each row execute function public.log_activity();

-- The customer who owns a machine now (the last transfer, else the order's customer).
create or replace function public.machine_owner_id(p_machine uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select customer_id from public.machine_owners where machine_id = p_machine order by owned_from desc, created_at desc limit 1),
    (select o.customer_id from public.order_machines m join public.orders o on o.id = m.order_id where m.id = p_machine));
$$;

-- p: {machine_id, customer_id | new_customer {name, company, country, state_province, emails[]},
--     date, notes, order_id}
create or replace function public.transfer_machine(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_machine  uuid := (p ->> 'machine_id')::uuid;
  v_customer uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_new      jsonb := p -> 'new_customer';
  v_date     date := coalesce(nullif(p ->> 'date', '')::date, public.halifax_today());
  v_order    uuid := nullif(p ->> 'order_id', '')::uuid;
  v_id       uuid;
begin
  perform public.require_perm('machines.transfer');
  if not exists (select 1 from public.order_machines where id = v_machine and not archived) then
    raise exception 'That machine could not be found.';
  end if;
  if v_customer is null then
    if v_new is null or nullif(btrim(v_new ->> 'name'), '') is null then
      raise exception 'Choose the new owner or enter their name.' using errcode = '22023';
    end if;
    perform public.require_perm('orders.new.customer.new');
    insert into public.customers (name, company, country, state_province, emails)
    values (btrim(v_new ->> 'name'), nullif(btrim(v_new ->> 'company'), ''), nullif(btrim(v_new ->> 'country'), ''),
            nullif(btrim(v_new ->> 'state_province'), ''),
            coalesce((select array_agg(lower(btrim(e))) from jsonb_array_elements_text(coalesce(v_new -> 'emails', '[]'::jsonb)) e
                       where btrim(e) <> ''), '{}'))
    returning id into v_customer;
  elsif not exists (select 1 from public.customers where id = v_customer) then
    raise exception 'That customer could not be found.';
  end if;
  if v_date < (select o.order_date from public.order_machines m join public.orders o on o.id = m.order_id where m.id = v_machine) then
    raise exception 'The transfer date cannot be before the machine''s original order date.' using errcode = '22023';
  end if;
  if v_customer = public.machine_owner_id(v_machine) then
    raise exception 'That customer already owns this machine.' using errcode = '22023';
  end if;
  if v_order is not null and not exists (select 1 from public.orders where id = v_order) then
    raise exception 'That order could not be found.';
  end if;
  insert into public.machine_owners (machine_id, customer_id, owned_from, order_id, notes)
  values (v_machine, v_customer, v_date, v_order, nullif(btrim(p ->> 'notes'), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- Service calls: a customer's machines now include machines they bought second hand
-- (and leave out the ones they sold).
create or replace function public.customer_machines(p_customer uuid)
returns table (machine_id uuid, machine text, serial text, order_id uuid, order_code text, order_date date)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, mt.name, m.serial_number, o.id, o.order_code, o.order_date
    from public.order_machines m
    join public.orders o on o.id = m.order_id
    join public.machine_types mt on mt.id = m.machine_type_id
   where not m.archived
     and public.machine_owner_id(m.id) = p_customer
     and public.has_perm('service.calls')
   order by o.order_date desc, o.order_code, mt.name, m.serial_number;
$$;

-- Find machines by serial number or type (Machine page search).
create or replace function public.find_machines(p_query text)
returns table (machine_id uuid, serial text, machine text, order_code text, owner text)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.serial_number, mt.name, o.order_code,
         (select coalesce(c.company, c.name) from public.customers c where c.id = public.machine_owner_id(m.id))
    from public.order_machines m
    join public.orders o on o.id = m.order_id
    join public.machine_types mt on mt.id = m.machine_type_id
   where public.has_perm('machines')
     and length(btrim(coalesce(p_query, ''))) >= 2
     and (m.serial_number ilike '%' || btrim(p_query) || '%' or mt.name ilike '%' || btrim(p_query) || '%')
   order by m.serial_number nulls last
   limit 30;
$$;

-- Everything about one machine: details, owners and the timeline.
create or replace function public.machine_details(p_machine uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  perform public.require_perm('machines', 'view');
  select jsonb_build_object(
           'id', m.id, 'serial', m.serial_number, 'machine_type', mt.name, 'code', mt.code, 'built', m.ready,
           'archived', m.archived, 'order_id', o.id, 'order_code', o.order_code, 'order_date', o.order_date,
           'stage', o.stage, 'actual_ship_date', o.actual_ship_date,
           'current_owner', (select jsonb_build_object('id', c.id, 'name', c.name, 'company', c.company, 'country', c.country)
                               from public.customers c where c.id = public.machine_owner_id(m.id)))
    into v
    from public.order_machines m
    join public.orders o on o.id = m.order_id
    join public.machine_types mt on mt.id = m.machine_type_id
   where m.id = p_machine;
  if v is null then
    raise exception 'That machine could not be found.';
  end if;

  return v || jsonb_build_object(
    'owners', (
      select coalesce(jsonb_agg(x - 'k' order by x ->> 'k'), '[]'::jsonb) from (
        select jsonb_build_object('k', '0', 'customer_id', c.id, 'name', c.name, 'company', c.company, 'country', c.country,
                                  'from', o.order_date, 'how', 'Original order', 'order_id', o.id, 'order_code', o.order_code, 'notes', null) x
          from public.order_machines m join public.orders o on o.id = m.order_id join public.customers c on c.id = o.customer_id
         where m.id = p_machine
        union all
        select jsonb_build_object('k', '1' || mo.owned_from::text || mo.created_at::text,
                                  'customer_id', c.id, 'name', c.name, 'company', c.company, 'country', c.country,
                                  'from', mo.owned_from, 'how', 'Transfer / resold', 'order_id', mo.order_id,
                                  'order_code', (select order_code from public.orders where id = mo.order_id), 'notes', mo.notes)
          from public.machine_owners mo join public.customers c on c.id = mo.customer_id
         where mo.machine_id = p_machine) s),
    'timeline', (
      select coalesce(jsonb_agg(t order by t ->> 'day', t ->> 'at'), '[]'::jsonb) from (
        -- ordered
        select jsonb_build_object('day', o.order_date, 'kind', 'order', 'title', 'Ordered on order ' || o.order_code,
                                  'detail', (select coalesce(c.company, c.name) from public.customers c where c.id = o.customer_id),
                                  'link', '/orders/' || o.id) t
          from public.order_machines m join public.orders o on o.id = m.order_id where m.id = p_machine
        union all
        -- build steps
        select jsonb_build_object('day', s.done_on, 'kind', 'build', 'title', initcap(replace(s.step, '_', ' ')) || ' done',
                                  'detail', s.done_by_name)
          from public.machine_steps s where s.machine_id = p_machine
        union all
        -- marked as built
        select jsonb_build_object('day', (a.at at time zone 'America/Halifax')::date, 'at', a.at, 'kind', 'built', 'title', 'Marked as built',
                                  'detail', a.user_email)
          from public.activity_log a
         where a.table_name = 'order_machines' and a.record_id = p_machine::text and a.changes -> 'ready' ->> 'new' = 'true'
        union all
        -- final check
        select jsonb_build_object('day', (k.started_at at time zone 'America/Halifax')::date, 'at', k.started_at, 'kind', 'check',
                                  'title', 'Final check started', 'link', '/checklists/' || p_machine)
          from public.machine_checklists k where k.machine_id = p_machine and k.started_at is not null
        union all
        select jsonb_build_object('day', (k.signed_at at time zone 'America/Halifax')::date, 'at', k.signed_at, 'kind', 'check',
                                  'title', 'Final check signed', 'detail', k.signed_name, 'link', '/checklists/' || p_machine)
          from public.machine_checklists k where k.machine_id = p_machine and k.signed_at is not null
        union all
        -- crating
        select jsonb_build_object('day', cr.crated_on, 'kind', 'crate', 'title', 'Crated',
                                  'detail', concat_ws(' · ', cr.crated_by,
                                                      round(cr.length_cm) || ' × ' || round(cr.width_cm) || ' × ' || round(cr.height_cm) || ' cm',
                                                      round(cr.weight_kg) || ' kg'))
          from public.crate_machines cm join public.crates cr on cr.id = cm.crate_id
         where cm.machine_id = p_machine and not cr.archived
        union all
        -- shipped
        select jsonb_build_object('day', o.actual_ship_date, 'kind', 'ship', 'title', 'Shipped (order ' || o.order_code || ')',
                                  'detail', o.freight_type, 'link', '/orders/' || o.id)
          from public.order_machines m join public.orders o on o.id = m.order_id
         where m.id = p_machine and o.actual_ship_date is not null
        union all
        -- owners after the first
        select jsonb_build_object('day', mo.owned_from, 'kind', 'owner', 'title', 'Transferred / resold to ' || coalesce(c.company, c.name),
                                  'detail', mo.notes, 'link', case when mo.order_id is not null then '/orders/' || mo.order_id end)
          from public.machine_owners mo join public.customers c on c.id = mo.customer_id where mo.machine_id = p_machine
        union all
        -- training / commissioning days and service visits on the machine
        select jsonb_build_object('day', e.entry_date, 'kind', 'service',
                                  'title', case when e.service_call_id is not null then 'Service visit' when e.kind = 'travel' then 'Travel day' else 'Training / commissioning day' end,
                                  'detail', nullif(concat_ws(' · ', nullif(sem.notes, ''), nullif(e.notes, '')), ''),
                                  'link', case when e.order_id is not null then '/service/' || e.order_id else '/service/calls/' || e.service_call_id end)
          from public.service_entry_machines sem join public.service_entries e on e.id = sem.entry_id
         where sem.machine_id = p_machine and not e.archived
        union all
        -- service calls
        select jsonb_build_object('day', coalesce(sc.planned_start, (bc.created_at at time zone 'America/Halifax')::date), 'kind', 'call',
                                  'title', 'Service call S-' || sc.call_number || ': ' || bc.title, 'link', '/service/calls/' || sc.card_id)
          from public.service_call_machines scm join public.service_calls sc on sc.card_id = scm.card_id
          join public.board_cards bc on bc.id = sc.card_id
         where scm.machine_id = p_machine
        union all
        -- certificates and service reports that list the machine
        select jsonb_build_object('day', coalesce((sc2.locked_at at time zone 'America/Halifax')::date, sc2.end_date, (sc2.created_at at time zone 'America/Halifax')::date),
                                  'kind', 'certificate',
                                  'title', case when sc2.kind = 'service_report' then 'Service report' else 'Commissioning certificate' end
                                           || case sc2.status when 'signed' then ' signed' when 'draft' then ' (draft)' else ' (replaced)' end,
                                  'link', '/service/certificates/' || sc2.id)
          from public.service_certificates sc2
         where exists (select 1 from jsonb_array_elements(sc2.machines) x where x ->> 'machine_id' = p_machine::text and not coalesce((x ->> 'removed')::boolean, false))
      ) s where t ->> 'day' is not null));
end;
$$;

-- The shop board view (across, list or cards), remembered per person.
alter table public.user_preferences add column shop_board_view text not null default 'rows' check (shop_board_view in ('rows', 'list', 'cards'));
create or replace function public.set_my_preferences(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  if not public.is_allowed_user() then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  if p ? 'theme' then
    perform public.require_perm('settings.theme');
    if p ->> 'theme' not in ('light', 'dark', 'system') then
      raise exception 'Choose Light, Dark or System.' using errcode = '22023';
    end if;
  end if;
  if p ? 'shop_board_view' and p ->> 'shop_board_view' not in ('rows', 'list', 'cards') then
    raise exception 'Choose Across, List or Cards.' using errcode = '22023';
  end if;
  if p ? 'desktop_notifications' then
    perform public.require_perm('settings.notifications', 'view');
  end if;
  insert into public.user_preferences (user_email) values (v_me) on conflict (user_email) do nothing;
  update public.user_preferences
     set theme = case when p ? 'theme' then p ->> 'theme' else theme end,
         sidebar_collapsed = case when p ? 'sidebar_collapsed' then (p ->> 'sidebar_collapsed')::boolean else sidebar_collapsed end,
         desktop_notifications = case when p ? 'desktop_notifications' then (p ->> 'desktop_notifications')::boolean else desktop_notifications end,
         shop_board_view = case when p ? 'shop_board_view' then p ->> 'shop_board_view' else shop_board_view end
   where user_email = v_me;
end;
$$;

-- The Machine page can be a start page.
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/reports/department-delays',
     '/reports/build-times', '/machines', '/boards', '/notices', '/service', '/service/calendar', '/chat', '/agent', '/settings', '/admin', '/shop-board'));

-- Access lockdown, as in earlier migrations.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
revoke execute on function public.calendar_rows(text, date, date, boolean) from authenticated;
revoke execute on function public.calendar_feed(text) from authenticated;
grant execute on function public.calendar_feed(text) to service_role;
