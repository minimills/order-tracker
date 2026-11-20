-- 0054 Freight: crating hand-off, incoming shipments; Timesheets: weekday fill
--
-- Paste the whole file into the Supabase SQL Editor and click Run. It is one
-- step; the numbered parts below are only there to read it.
--
-- 1. Crating hand-off: each order has a person assigned to crating
--    (orders.crating_assignee; the first person in Admin → Production
--    Assignments for the Crating stage when the order is made). When every
--    machine that needs a crate is crated and every crate has its plywood
--    sheets, hours, size and weight, the person who arranges shipping
--    (app_settings.freight.shipping_contact, Admin → Freight Settings) is
--    notified (in-app, phone push and email, always) with a link to the
--    freight quote request for that order.
-- 2. Incoming shipments (Freight → Incoming): supplier, costs, taxes,
--    customs, delivery type (dropdown list `incoming_delivery_type`),
--    carrier, tracking, date received, notes, currency and exchange rate.
-- 3. Timesheets: the weekday fill (8:00 a.m. to 4:30 p.m., 30-minute unpaid
--    break) is a payroll setting, and "Fill Weekday Hours for Everyone"
--    (fill_week_for_everyone) fills a week for every employee, skipping
--    approved time off, company days off, approved weeks and every day that
--    already has hours.
-- (The profit and loss summary is worked out in the app from the cost
-- breakdowns people can already read; it needs no database change.)
-- 4. Access lockdown.

-- ===========================================================================
-- 1. Crating hand-off
-- ===========================================================================
alter table public.orders
  add column crating_assignee     text references public.allowed_users (email) on update cascade on delete set null,
  add column crating_ready_at     timestamp with time zone,
  add column crating_notified_at  timestamp with time zone,
  add column crating_notified_to  text;
grant select (crating_assignee, crating_ready_at, crating_notified_at, crating_notified_to) on public.orders to authenticated;

insert into public.notification_kinds (kind, label, description, sort_order, default_modes, required_channels) values
  ('crating_ready', 'Crating information ready for a shipping quote',
   'For the person who arranges shipping: every crate of an order has its sheets, hours, size and weight.', 95,
   '{"app": "on", "push": "on", "email": "instant", "desktop": "on"}', '{app,push,email}'),
  ('crating_assigned', 'Assigned to crating an order', 'You are the person who crates an order.', 96,
   '{"app": "on", "push": "on", "email": "off", "desktop": "on"}', '{}')
on conflict (kind) do nothing;

-- The first person in Admin → Production Assignments for the Crating stage.
create or replace function public.default_crating_assignee()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select a.user_email
    from public.production_assignments a
    join public.production_stage_template t on t.id = a.stage_template_id
   where t.step = 'crating' and not t.archived and a.assignee_type = 'user' and a.user_email is not null
   order by (a.machine_type_id is not null), a.created_at
   limit 1;
$$;

create or replace function public.orders_crating_assignee_default()
returns trigger
language plpgsql
as $$
begin
  if new.crating_assignee is null and coalesce(new.crating, true) then
    new.crating_assignee := public.default_crating_assignee();
  end if;
  return new;
end;
$$;
create trigger orders_crating_assignee_default before insert on public.orders
  for each row execute function public.orders_crating_assignee_default();

-- Only the functions below change the hand-off columns.
create or replace function public.orders_crating_handoff_guard()
returns trigger
language plpgsql
as $$
begin
  if (new.crating_assignee, new.crating_ready_at, new.crating_notified_at, new.crating_notified_to)
       is distinct from (old.crating_assignee, old.crating_ready_at, old.crating_notified_at, old.crating_notified_to)
     and coalesce(current_setting('app.crating_handoff', true), '') <> 'on' then
    raise exception 'Use “Assigned to crating” on the Order page to change this.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger orders_crating_handoff_guard before update on public.orders
  for each row execute function public.orders_crating_handoff_guard();

-- Where the crating of an order stands (machines needing a crate, crates
-- still missing information, ready / notified).
create or replace function public.crating_handoff_status(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_o        public.orders%rowtype;
  v_needed   integer;
  v_missing  jsonb;
  v_crates   integer;
  v_incomp   jsonb;
  v_contact  text := nullif(btrim((select value ->> 'shipping_contact' from public.app_settings where key = 'freight')), '');
begin
  if not public.has_any_perm(array['crating.handoff', 'freight.quote'], 'view') then
    raise exception 'You do not have access to crating.' using errcode = '42501';
  end if;
  select * into v_o from public.orders where id = p_order;
  if v_o.id is null then raise exception 'That order could not be found.' using errcode = 'P0002'; end if;

  select count(*) into v_needed from public.order_machines m where m.order_id = p_order and not m.archived and m.needs_crate;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'serial', m.serial_number, 'machine', mt.name) order by m.serial_number), '[]')
    into v_missing
    from public.order_machines m left join public.machine_types mt on mt.id = m.machine_type_id
   where m.order_id = p_order and not m.archived and m.needs_crate
     and not exists (select 1 from public.crate_machines cm join public.crates c on c.id = cm.crate_id
                      where cm.machine_id = m.id and not c.archived);
  select count(*) into v_crates from public.crates c where c.order_id = p_order and not c.archived;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id,
           'missing', to_jsonb(array_remove(array[
             case when c.plywood_sheets is null then 'plywood sheets' end,
             case when c.build_hours is null then 'time' end,
             case when c.length_cm is null or c.width_cm is null or c.height_cm is null then 'size' end,
             case when c.weight_kg is null then 'weight' end], null))) order by c.created_at), '[]')
    into v_incomp
    from public.crates c
   where c.order_id = p_order and not c.archived
     and (c.plywood_sheets is null or c.build_hours is null or c.length_cm is null or c.width_cm is null
          or c.height_cm is null or c.weight_kg is null);

  return jsonb_build_object(
    'crating', coalesce(v_o.crating, true),
    'assignee', v_o.crating_assignee,
    'assignee_name', (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = v_o.crating_assignee),
    'machines_needing', v_needed,
    'machines_missing', v_missing,
    'crates', v_crates,
    'crates_incomplete', v_incomp,
    'complete', coalesce(v_o.crating, true) and v_crates > 0 and jsonb_array_length(v_missing) = 0 and jsonb_array_length(v_incomp) = 0,
    'ready_at', v_o.crating_ready_at,
    'notified_at', v_o.crating_notified_at,
    'notified_to_name', (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = v_o.crating_notified_to),
    'shipping_contact_name', (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = v_contact));
end;
$$;

-- Internal: after crates change, mark the order ready (and notify the
-- shipping contact once each time it becomes ready) or not ready.
create or replace function public.crating_handoff_check(p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o        public.orders%rowtype;
  v_complete boolean;
  v_contact  text := lower(nullif(btrim((select value ->> 'shipping_contact' from public.app_settings where key = 'freight')), ''));
  v_crates   integer;
  v_who      text;
  v_prev     text;
begin
  select * into v_o from public.orders where id = p_order;
  if v_o.id is null then return; end if;
  select count(*) into v_crates from public.crates c where c.order_id = p_order and not c.archived;
  v_complete := coalesce(v_o.crating, true) and not v_o.archived and v_o.stage <> 'Cancelled' and v_crates > 0
    and not exists (select 1 from public.order_machines m
                     where m.order_id = p_order and not m.archived and m.needs_crate
                       and not exists (select 1 from public.crate_machines cm join public.crates c on c.id = cm.crate_id
                                        where cm.machine_id = m.id and not c.archived))
    and not exists (select 1 from public.crates c
                     where c.order_id = p_order and not c.archived
                       and (c.plywood_sheets is null or c.build_hours is null or c.length_cm is null or c.width_cm is null
                            or c.height_cm is null or c.weight_kg is null));
  v_prev := coalesce(current_setting('app.system_change', true), '');
  -- check_field_permissions lets these columns through only as a system change.
  perform set_config('app.crating_handoff', 'on', true);
  perform set_config('app.system_change', 'on', true);
  if not v_complete then
    if v_o.crating_ready_at is not null then
      update public.orders set crating_ready_at = null where id = p_order;
    end if;
  elsif v_o.crating_ready_at is null then
    update public.orders set crating_ready_at = now() where id = p_order;
    if v_contact is not null and exists (select 1 from public.allowed_users a where a.email = v_contact) then
      select string_agg(distinct coalesce(c.crated_by, ''), ', ') into v_who from public.crates c where c.order_id = p_order and not c.archived;
      insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
      values (v_contact, 'crating_ready',
              'Order ' || v_o.order_code || ' is crated: ready for a shipping quote',
              v_crates || ' crate' || case when v_crates = 1 then '' else 's' end || ' with sheets, time, size and weight entered'
                || coalesce(' by ' || nullif(btrim(v_who), ''), '') || '. Open the quote request to send it to a shipping agent.',
              '/freight/quote?order=' || p_order,
              'crating_ready:' || p_order || ':' || to_char(now(), 'YYYYMMDDHH24'))
      on conflict do nothing;
      update public.orders set crating_notified_at = now(), crating_notified_to = v_contact where id = p_order;
    end if;
  end if;
  perform set_config('app.crating_handoff', '', true);
  perform set_config('app.system_change', v_prev, true);
end;
$$;

-- Checked at the end of the transaction, so save_crate's steps (crate, then
-- its machines) are seen together.
create or replace function public.crates_handoff_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order uuid;
begin
  if tg_table_name = 'crates' then
    v_order := coalesce(new.order_id, old.order_id);
  elsif tg_table_name = 'crate_machines' then
    select order_id into v_order from public.crates where id = coalesce(new.crate_id, old.crate_id);
  else
    v_order := coalesce(new.order_id, old.order_id);
  end if;
  if v_order is not null then
    perform public.crating_handoff_check(v_order);
  end if;
  return null;
end;
$$;
create constraint trigger crates_handoff after insert or update or delete on public.crates
  deferrable initially deferred for each row execute function public.crates_handoff_trigger();
create constraint trigger crate_machines_handoff after insert or update or delete on public.crate_machines
  deferrable initially deferred for each row execute function public.crates_handoff_trigger();
create constraint trigger order_machines_handoff after update of needs_crate, archived on public.order_machines
  deferrable initially deferred for each row execute function public.crates_handoff_trigger();

-- Who crates this order (crating.assign); they are told in the app.
create or replace function public.set_crating_assignee(p_order uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(nullif(btrim(p_email), ''));
  v_o     public.orders%rowtype;
  v_prev  text;
begin
  perform public.require_perm('crating.assign', 'edit');
  select * into v_o from public.orders where id = p_order;
  if v_o.id is null then raise exception 'That order could not be found.' using errcode = 'P0002'; end if;
  if v_email is not null and not exists (select 1 from public.allowed_users a where a.email = v_email) then
    raise exception 'That person does not have access to the app.' using errcode = '22023';
  end if;
  v_prev := coalesce(current_setting('app.system_change', true), '');
  -- check_field_permissions lets these columns through only as a system change.
  perform set_config('app.crating_handoff', 'on', true);
  perform set_config('app.system_change', 'on', true);
  update public.orders set crating_assignee = v_email where id = p_order;
  perform set_config('app.crating_handoff', '', true);
  perform set_config('app.system_change', v_prev, true);
  if v_email is not null and v_email is distinct from v_o.crating_assignee and v_email <> public.current_user_email() then
    insert into public.notifications (user_email, kind, title, body, link)
    values (v_email, 'crating_assigned', 'You are crating order ' || v_o.order_code,
            public.current_user_name() || ' assigned you. Enter each crate''s plywood sheets, time, size and weight on the order.',
            '/orders/' || p_order);
  end if;
end;
$$;

-- People who may crate (for the picker): everyone with the crating permission.
create or replace function public.crating_people()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.has_any_perm(array['crating', 'crating.assign', 'admin.freight'], 'view')
     and public.perm_of(a.email, 'crating', 'view')
   order by 2;
$$;

-- People who may arrange shipping (Admin → Freight Settings picker).
create or replace function public.shipping_contact_choices()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.can_admin('freight')
     and public.perm_of(a.email, 'freight.quote', 'view')
   order by 2;
$$;

-- Freight settings: the shipping contact must be a person with access.
create or replace function public.freight_settings_check_contact()
returns trigger
language plpgsql
as $$
declare
  v text := lower(nullif(btrim(new.value ->> 'shipping_contact'), ''));
begin
  if new.key = 'freight' and v is not null and not exists (select 1 from public.allowed_users a where a.email = v) then
    raise exception 'The person who arranges shipping must have access to the app.' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger app_settings_freight_contact before insert or update on public.app_settings
  for each row when (new.key = 'freight') execute function public.freight_settings_check_contact();

-- ===========================================================================
-- 2. Incoming shipments
-- ===========================================================================
insert into public.option_lists (list_name, value, sort_order) values
  ('incoming_delivery_type', 'Courier', 1), ('incoming_delivery_type', 'LTL', 2), ('incoming_delivery_type', 'FTL', 3),
  ('incoming_delivery_type', 'LCL', 4), ('incoming_delivery_type', 'FCL', 5), ('incoming_delivery_type', 'Air', 6),
  ('incoming_delivery_type', 'Pick-up', 7), ('incoming_delivery_type', 'Other', 8)
on conflict do nothing;

create table public.incoming_shipments (
  id              uuid primary key default gen_random_uuid(),
  supplier        text not null check (length(btrim(supplier)) between 1 and 200),
  description     text check (length(description) <= 500),
  reference       text check (length(reference) <= 100),
  product_cost    numeric(14, 2) not null default 0 check (product_cost >= 0),
  shipping_cost   numeric(14, 2) not null default 0 check (shipping_cost >= 0),
  broker_fees     numeric(14, 2) not null default 0 check (broker_fees >= 0),
  taxes           numeric(14, 2) not null default 0 check (taxes >= 0),
  customs         numeric(14, 2) not null default 0 check (customs >= 0),
  delivery_type   text,
  carrier         text check (length(carrier) <= 120),
  tracking_number text check (length(tracking_number) <= 120),
  received_on     date,
  notes           text check (length(notes) <= 4000),
  currency        text not null default 'CAD' check (currency in ('CAD', 'USD')),
  exchange_rate   numeric(12, 6) not null default 1 check (exchange_rate > 0),
  total           numeric(14, 2) generated always as (product_cost + shipping_cost + broker_fees + taxes + customs) stored,
  total_cad       numeric(14, 2) generated always as (round((product_cost + shipping_cost + broker_fees + taxes + customs) * exchange_rate, 2)) stored,
  freight_cad     numeric(14, 2) generated always as (round((shipping_cost + broker_fees + taxes + customs) * exchange_rate, 2)) stored,
  created_by      text default public.current_user_email(),
  created_by_name text default public.current_user_name(),
  archived        boolean not null default false,
  archived_at     timestamptz,
  archived_by     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index incoming_shipments_received_idx on public.incoming_shipments (received_on desc);
create trigger incoming_shipments_updated_at before update on public.incoming_shipments
  for each row execute function public.set_updated_at();
create trigger incoming_shipments_archived before insert or update of archived on public.incoming_shipments
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.incoming_shipments
  for each row execute function public.log_activity();

-- Delivery type from the dropdown list; CAD is always rate 1.
create or replace function public.incoming_shipments_fill()
returns trigger
language plpgsql
as $$
begin
  new.supplier := btrim(new.supplier);
  new.delivery_type := nullif(btrim(new.delivery_type), '');
  if new.currency = 'CAD' then new.exchange_rate := 1; end if;
  if new.delivery_type is not null and (tg_op = 'INSERT' or new.delivery_type is distinct from old.delivery_type)
     and not exists (select 1 from public.option_lists o where o.list_name = 'incoming_delivery_type' and o.value = new.delivery_type and not o.archived) then
    raise exception 'Choose a type of delivery from the list (Admin → Dropdown Lists).' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger incoming_shipments_fill before insert or update on public.incoming_shipments
  for each row execute function public.incoming_shipments_fill();

alter table public.incoming_shipments enable row level security;
create policy "Incoming shipments readers" on public.incoming_shipments
  for select to authenticated using ((select public.has_perm('freight.incoming', 'view')));
revoke insert, update, delete on public.incoming_shipments from authenticated;
revoke all on public.incoming_shipments from anon;

create or replace function public.save_incoming_shipment(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  n    text;
begin
  perform public.require_perm('freight.incoming', 'edit');
  if nullif(btrim(p ->> 'supplier'), '') is null then
    raise exception 'Enter the supplier.' using errcode = '22023';
  end if;
  foreach n in array array['product_cost', 'shipping_cost', 'broker_fees', 'taxes', 'customs'] loop
    if coalesce(nullif(p ->> n, '')::numeric, 0) < 0 then
      raise exception 'Amounts cannot be negative.' using errcode = '22023';
    end if;
  end loop;
  if v_id is null then
    insert into public.incoming_shipments (supplier, description, reference, product_cost, shipping_cost, broker_fees, taxes, customs,
                                           delivery_type, carrier, tracking_number, received_on, notes, currency, exchange_rate)
    values (p ->> 'supplier', nullif(btrim(p ->> 'description'), ''), nullif(btrim(p ->> 'reference'), ''),
            coalesce(nullif(p ->> 'product_cost', '')::numeric, 0), coalesce(nullif(p ->> 'shipping_cost', '')::numeric, 0),
            coalesce(nullif(p ->> 'broker_fees', '')::numeric, 0), coalesce(nullif(p ->> 'taxes', '')::numeric, 0),
            coalesce(nullif(p ->> 'customs', '')::numeric, 0),
            p ->> 'delivery_type', nullif(btrim(p ->> 'carrier'), ''), nullif(btrim(p ->> 'tracking_number'), ''),
            nullif(p ->> 'received_on', '')::date, nullif(btrim(p ->> 'notes'), ''),
            coalesce(nullif(p ->> 'currency', ''), 'CAD'), coalesce(nullif(p ->> 'exchange_rate', '')::numeric, 1))
    returning id into v_id;
  else
    update public.incoming_shipments set
      supplier = p ->> 'supplier', description = nullif(btrim(p ->> 'description'), ''), reference = nullif(btrim(p ->> 'reference'), ''),
      product_cost = coalesce(nullif(p ->> 'product_cost', '')::numeric, 0), shipping_cost = coalesce(nullif(p ->> 'shipping_cost', '')::numeric, 0),
      broker_fees = coalesce(nullif(p ->> 'broker_fees', '')::numeric, 0), taxes = coalesce(nullif(p ->> 'taxes', '')::numeric, 0),
      customs = coalesce(nullif(p ->> 'customs', '')::numeric, 0),
      delivery_type = p ->> 'delivery_type', carrier = nullif(btrim(p ->> 'carrier'), ''), tracking_number = nullif(btrim(p ->> 'tracking_number'), ''),
      received_on = nullif(p ->> 'received_on', '')::date, notes = nullif(btrim(p ->> 'notes'), ''),
      currency = coalesce(nullif(p ->> 'currency', ''), 'CAD'), exchange_rate = coalesce(nullif(p ->> 'exchange_rate', '')::numeric, 1)
     where id = v_id;
    if not found then raise exception 'That shipment could not be found.' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.archive_incoming_shipment(p_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('freight.incoming', 'edit');
  update public.incoming_shipments set archived = p_archived where id = p_id;
end;
$$;

-- Renaming a delivery type in Admin → Dropdown Lists renames it on every shipment.
create or replace function public.option_lists_rename()
returns trigger
language plpgsql
security definer
set search_path = public
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
      when 'notice_category' then
        update public.notices set category = new.value where category = old.value;
      when 'ce_directive' then
        update public.machine_types set ce_directives = array_replace(ce_directives, old.value, new.value)
         where old.value = any (ce_directives);
      when 'incoming_delivery_type' then
        update public.incoming_shipments set delivery_type = new.value where delivery_type = old.value;
      else
        null;
    end case;
  end if;
  return null;
end;
$$;

-- ===========================================================================
-- 3. Timesheets: weekday fill
-- ===========================================================================
-- The fill times are payroll settings (Admin → Payroll Settings).
create or replace function public.payroll_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'week_start', 1, 'overtime_weekly_hours', 44, 'overtime_rate', 1.5, 'banked_overtime_credit', 1.5,
    'hours_per_day', 8,
    'vacation_tiers', '[{"after_years": 1, "days": 10}, {"after_years": 5, "days": 15}]'::jsonb,
    'sick_tiers', '[{"after_years": 1, "days": 3}]'::jsonb,
    'stat_min_days_employed', 30, 'paid_holiday_kinds', '["statutory"]'::jsonb, 'employer_cost_pct', 0,
    'fill_start', '08:00', 'fill_end', '16:30', 'fill_break_minutes', 30,
    'pei_minimum', jsonb_build_object('overtime_weekly_hours', 44,
      'vacation_tiers', '[{"after_years": 1, "days": 10}, {"after_years": 5, "days": 15}]'::jsonb,
      'sick_tiers', '[{"after_years": 1, "days": 1}, {"after_years": 2, "days": 2}, {"after_years": 3, "days": 3}]'::jsonb))
    || coalesce((select value from public.app_settings where key = 'payroll'), '{}'::jsonb)
   where public.is_trusted_caller();
$$;

create or replace function public.set_payroll_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := public.payroll_settings() || coalesce(p, '{}'::jsonb);
  t jsonb;
  v_paid numeric;
begin
  perform public.require_admin_area('payroll');
  if (v ->> 'week_start')::int not between 1 and 7 then raise exception 'The week must start on a day from Monday to Sunday.' using errcode = '22023'; end if;
  if (v ->> 'overtime_weekly_hours')::numeric not between 1 and 80 then raise exception 'The overtime threshold must be between 1 and 80 hours.' using errcode = '22023'; end if;
  if (v ->> 'overtime_rate')::numeric not between 1 and 3 then raise exception 'The overtime rate must be between 1 and 3 times the hourly rate.' using errcode = '22023'; end if;
  if (v ->> 'banked_overtime_credit')::numeric not between 1 and 3 then raise exception 'Banked overtime must count between 1 and 3 times the hours.' using errcode = '22023'; end if;
  if (v ->> 'hours_per_day')::numeric not between 1 and 24 then raise exception 'A day must be between 1 and 24 hours.' using errcode = '22023'; end if;
  if (v ->> 'employer_cost_pct')::numeric not between 0 and 100 then raise exception 'Employer costs must be between 0 and 100 %%.' using errcode = '22023'; end if;
  for t in select x from jsonb_array_elements(coalesce(v -> 'vacation_tiers', '[]') || coalesce(v -> 'sick_tiers', '[]')) x loop
    if (t ->> 'after_years')::numeric < 0 or (t ->> 'days')::numeric < 0 then
      raise exception 'Years of service and days cannot be negative.' using errcode = '22023';
    end if;
  end loop;
  -- Weekday fill: a start before the end, a break shorter than the day.
  begin
    v_paid := extract(epoch from ((v ->> 'fill_end')::time - (v ->> 'fill_start')::time)) / 60 - (v ->> 'fill_break_minutes')::int;
  exception when others then
    raise exception 'Enter the weekday fill as a start time, an end time and the unpaid break in minutes.' using errcode = '22023';
  end;
  if (v ->> 'fill_break_minutes')::int < 0 or v_paid <= 0 then
    raise exception 'The weekday fill must end after it starts, with a break shorter than the day.' using errcode = '22023';
  end if;
  insert into public.app_settings (key, value) values ('payroll', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'payroll', null, jsonb_build_object('action', 'payroll settings changed'));
end;
$$;

-- Fill the weekdays of one pay week for every current employee with the
-- weekday fill times. Never touches a day that already has hours; skips
-- approved (locked) weeks, approved time off, company days off and days
-- before the start or after the end of employment. p_apply = false only
-- reports what would happen.
create or replace function public.fill_week_for_everyone(p_week_start date, p_apply boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws      date := public.ts_week_start(p_week_start);
  v_set     jsonb := public.payroll_settings();
  v_start   time := (v_set ->> 'fill_start')::time;
  v_end     time := (v_set ->> 'fill_end')::time;
  v_break   int := (v_set ->> 'fill_break_minutes')::int;
  v_hours   numeric := round((extract(epoch from (v_end - v_start)) / 3600 - v_break / 60.0)::numeric, 2);
  e         record;
  d         date;
  v_week    public.timesheet_weeks%rowtype;
  v_days    date[];
  v_filled  jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_reason  text;
begin
  perform public.require_perm('timesheets.enter', 'edit');
  perform public.require_perm('timesheets.fill_all', 'edit');
  for e in select * from public.employees where not archived
              and (start_date is null or start_date <= v_ws + 4) and (end_date is null or end_date >= v_ws)
            order by name loop
    select * into v_week from public.timesheet_weeks w where w.employee_id = e.id and w.week_start = v_ws;
    if v_week.status = 'approved' then
      v_skipped := v_skipped || jsonb_build_object('employee', e.name, 'employee_id', e.id, 'date', null, 'reason', 'week approved and locked');
      continue;
    end if;
    v_days := '{}';
    for d in select generate_series(v_ws, v_ws + 6, interval '1 day')::date loop
      if extract(isodow from d) > 5 then continue; end if;
      v_reason := case
        when e.start_date is not null and d < e.start_date then 'before the start of employment'
        when e.end_date is not null and d > e.end_date then 'after the end of employment'
        when exists (select 1 from public.time_entries t where t.employee_id = e.id and t.work_date = d) then 'already has hours'
        when exists (select 1 from public.time_off_requests r where r.employee_id = e.id and r.status = 'approved'
                      and d between r.start_date and r.end_date) then 'approved time off'
        when exists (select 1 from public.holiday_off_dates(d, d)) then 'company day off'
      end;
      if v_reason is not null then
        v_skipped := v_skipped || jsonb_build_object('employee', e.name, 'employee_id', e.id, 'date', d, 'reason', v_reason);
      else
        v_days := v_days || d;
      end if;
    end loop;
    if cardinality(v_days) > 0 then
      v_filled := v_filled || jsonb_build_object('employee', e.name, 'employee_id', e.id, 'days', to_jsonb(v_days),
                                                 'hours', v_hours * cardinality(v_days));
      if p_apply then
        insert into public.time_entries (employee_id, work_date, kind, start_time, end_time, break_minutes, notes)
        select e.id, x, 'work', v_start, v_end, v_break, null from unnest(v_days) x;
        perform public.ts_log(public.ts_week_id(e.id, v_ws), 'entered',
          jsonb_build_object('filled_for_everyone', true, 'days', cardinality(v_days), 'hours', v_hours * cardinality(v_days)), null);
      end if;
    end if;
  end loop;
  return jsonb_build_object('week_start', v_ws, 'start', to_char(v_start, 'HH24:MI'), 'end', to_char(v_end, 'HH24:MI'),
                            'break_minutes', v_break, 'hours_per_day', v_hours, 'filled', v_filled, 'skipped', v_skipped,
                            'applied', p_apply);
end;
$$;

-- ===========================================================================
-- 4. Access lockdown
-- ===========================================================================
-- Full lockdown block (see CLAUDE.md, BOARDS UPGRADE).
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
grant execute on function public.admin_auth_user_id(text) to service_role;
revoke execute on function public.check_dispatch_key(text) from authenticated;
grant execute on function public.check_dispatch_key(text) to service_role;
revoke execute on function public.system_on(), public.production_split_leftovers(uuid, uuid),
  public.production_merge_leftover(uuid, text), public.production_card_entered(uuid),
  public.production_refresh_due(uuid, uuid) from authenticated;
revoke execute on function public.calendar_rows(text, date, date, boolean) from authenticated;
revoke execute on function public.calendar_feed(text) from authenticated;
grant execute on function public.calendar_feed(text) to service_role;
revoke execute on function public.apply_phone_events(text, text, jsonb, text) from authenticated;
grant execute on function public.apply_phone_events(text, text, jsonb, text) to service_role;
revoke execute on function public.calendar_imports_due(text) from authenticated;
grant execute on function public.calendar_imports_due(text) to service_role;
revoke execute on function public.chat_sync_department(uuid), public.chat_sync_user_group(uuid), public.chat_find_links(text),
  public.in_quiet_hours(text, timestamptz) from authenticated;
revoke execute on function public.use_saved_signature(uuid, text, text) from authenticated;
revoke execute on function public.closure_alert_notify(uuid, text, text) from authenticated;
revoke execute on function public.build_summary(text, text, date), public.post_summary(text, text, date, boolean),
  public.daily_summary_tick(), public.rename_user_email(text, text), public.apply_email_change(uuid),
  public.notify_user_managers(text, text, text), public.auth_email_changed() from authenticated;
-- Timesheets internals: only inside the functions above.
revoke execute on function public.pay_rate_on(uuid, date), public.ts_managers_of(uuid),
  public.ts_week_id(uuid, date), public.ts_log(uuid, text, jsonb, text) from authenticated;
-- Dashboards internals: only inside the functions above.
revoke execute on function public.dashboard_template_people(uuid), public.dashboard_copy_template(uuid, text) from authenticated;
-- Sending mailboxes: the password is only ever read by the send-email Edge Function.
revoke execute on function public.mailbox_for_sending(text), public.set_mailbox_status(text, boolean, text) from authenticated;
grant execute on function public.mailbox_for_sending(text), public.set_mailbox_status(text, boolean, text) to service_role;
revoke execute on function public.summary_business_admin_only(), public.allowed_users_summary_business(),
  public.notifications_plain_text() from authenticated;

-- Boards upgrade 2 internals: only inside the functions above.
revoke execute on function public.board_label_for(uuid, text, text), public.board_place_card(uuid, uuid, integer),
  public.board_target_check(uuid, uuid), public.production_assign_defaults(uuid),
  public.orders_production_close(), public.orders_crating_changed(), public.order_machines_crating() from authenticated;
-- Calendar internals: only inside the functions above.
revoke execute on function public.calendar_entry_visible(uuid, text), public.calendar_team_keys(),
  public.orders_training_done_guard() from authenticated;
-- (system_on() stays revoked above; mark_training_done uses it as the owner.)
-- Crating hand-off internals: only through the triggers and functions above.
revoke execute on function public.crating_handoff_check(uuid), public.crates_handoff_trigger(),
  public.orders_crating_assignee_default(), public.orders_crating_handoff_guard(),
  public.freight_settings_check_contact() from authenticated;
-- (default_crating_assignee stays callable: the order trigger runs as the person; it only reads Production Assignments, which everyone may read.)
