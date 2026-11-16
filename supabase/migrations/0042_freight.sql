-- 0042 Freight (replaces the old Freight Multitool app)
--
-- 1. Freight settings (Admin → Freight Settings) and the shipping agents list.
-- 2. Shipment cost breakdowns: one per shipment, linked to an order. Money is
--    stored in the entered currency AND in CAD (as the old app did).
-- 3. Freight quote request emails that were sent.
-- 4. Details of an order for the breakdown and the quote request.
-- 5. Import of the old Freight Multitool data.
-- 6. "Crating Report" is now "Freight" (/freight); start pages follow.
-- 7. Access lockdown.

-- ===========================================================================
-- 1. Settings and shipping agents
-- ===========================================================================
insert into public.app_settings (key, value) values ('freight', jsonb_build_object(
  'broker_fee', 180,
  'rates', jsonb_build_object(
    'CAD', jsonb_build_object('hourly', 65, 'plywood', 65),
    'USD', jsonb_build_object('hourly', 50, 'plywood', 50)),
  -- insurance = the larger of (cargo value + freight) × uplift × rate_pct % and the minimum
  'insurance', jsonb_build_object('uplift', 1.1, 'rate_pct', 0.5, 'minimum', 50),
  'margin_presets', jsonb_build_array(10, 20, 30),
  'exchange_rate', 1.35,
  'pickup_locations', jsonb_build_array(
    jsonb_build_object('name', 'Belfast Mini Mills Ltd.', 'address', '1820 Garfield Road, Belfast, PE C0A 1A0'),
    jsonb_build_object('name', 'Belfast Mini Mills', 'address', '627 Greek River Rd, Murray River, PE C0A 1W0')),
  -- freight types counted as ocean / air in the insurance summary (the rest is inland)
  'ocean_air_types', jsonb_build_array('LCL', 'FCL', 'Air')))
on conflict (key) do nothing;

create or replace function public.freight_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.app_settings where key = 'freight'), '{}'::jsonb);
$$;

create or replace function public.set_freight_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := public.freight_settings() || coalesce(p, '{}'::jsonb);
  v_cur text;
  v_n numeric;
begin
  perform public.require_admin_area('freight');
  if coalesce((v ->> 'broker_fee')::numeric, -1) < 0 then
    raise exception 'Enter the standard broker fee (0 or more).' using errcode = '22023';
  end if;
  foreach v_cur in array array['CAD', 'USD'] loop
    if coalesce((v #>> array['rates', v_cur, 'hourly'])::numeric, -1) < 0
       or coalesce((v #>> array['rates', v_cur, 'plywood'])::numeric, -1) < 0 then
      raise exception 'Enter the hourly and plywood rates for %.', v_cur using errcode = '22023';
    end if;
  end loop;
  if coalesce((v #>> '{insurance,uplift}')::numeric, 0) < 1 or coalesce((v #>> '{insurance,rate_pct}')::numeric, -1) < 0
     or coalesce((v #>> '{insurance,minimum}')::numeric, -1) < 0 then
    raise exception 'Check the insurance rule: the uplift must be 1 or more, the rate and the minimum 0 or more.' using errcode = '22023';
  end if;
  if coalesce((v ->> 'exchange_rate')::numeric, 0) <= 0 then
    raise exception 'Enter the usual exchange rate (USD to CAD).' using errcode = '22023';
  end if;
  if jsonb_typeof(v -> 'margin_presets') <> 'array' or jsonb_array_length(v -> 'margin_presets') > 6 then
    raise exception 'Enter up to 6 margin buttons.' using errcode = '22023';
  end if;
  for v_n in select x::numeric from jsonb_array_elements_text(v -> 'margin_presets') x loop
    if v_n < 0 or v_n > 500 then raise exception 'A margin button must be between 0 and 500 %%.' using errcode = '22023'; end if;
  end loop;
  if jsonb_typeof(v -> 'pickup_locations') <> 'array' or jsonb_array_length(v -> 'pickup_locations') > 10 then
    raise exception 'Enter up to 10 pick-up locations.' using errcode = '22023';
  end if;
  insert into public.app_settings (key, value) values ('freight', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'freight', null, jsonb_build_object('action', 'Freight settings changed'));
end;
$$;

create table public.freight_agents (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 1 and 80),
  -- the person quote requests are addressed to
  contact_name   text,
  contact_email  text,
  -- insurance worked out by the rule in the freight settings (Livingston)
  auto_insurance boolean not null default false,
  -- the agent books another carrier: ask for the sub-contractor carrier
  sub_contractor boolean not null default false,
  sort_order     integer not null default 0,
  archived       boolean not null default false,
  archived_at    timestamptz,
  archived_by    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index freight_agents_name_unique on public.freight_agents (lower(btrim(name)));
create trigger freight_agents_updated_at before update on public.freight_agents
  for each row execute function public.set_updated_at();
create trigger freight_agents_archived before insert or update of archived on public.freight_agents
  for each row execute function public.set_archived_info();
alter table public.freight_agents enable row level security;
create policy "Freight readers" on public.freight_agents for select to authenticated
  using ((select public.has_any_perm(array['freight.breakdowns', 'freight.quote', 'freight.insurance', 'admin.freight'], 'view')));
create policy "Freight admins add" on public.freight_agents for insert to authenticated
  with check ((select public.can_admin('freight')));
create policy "Freight admins change" on public.freight_agents for update to authenticated
  using ((select public.can_admin('freight'))) with check ((select public.can_admin('freight')));
revoke delete on public.freight_agents from authenticated;
revoke all on public.freight_agents from anon;

insert into public.freight_agents (name, auto_insurance, sub_contractor, sort_order) values
  ('Livingston', true, true, 1), ('FedEx', false, false, 2), ('UPS', false, false, 3), ('Purolator', false, false, 4),
  ('Canada Post', false, false, 5), ('Day & Ross', false, false, 6), ('DHL', false, false, 7);

-- "Add new" in the shipping agent list of a breakdown or a quote request.
create or replace function public.add_freight_agent(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  perform public.require_perm('freight.agents.add', 'edit');
  if length(v_name) = 0 or length(v_name) > 80 then
    raise exception 'Enter the name of the shipping agent.' using errcode = '22023';
  end if;
  select id into v_id from public.freight_agents where lower(btrim(name)) = lower(v_name);
  if v_id is not null then
    update public.freight_agents set archived = false where id = v_id and archived;
    return v_id;
  end if;
  insert into public.freight_agents (name, sort_order)
  values (v_name, coalesce((select max(sort_order) from public.freight_agents), 0) + 1)
  returning id into v_id;
  return v_id;
end;
$$;

-- ===========================================================================
-- 2. Shipment cost breakdowns
-- ===========================================================================
create table public.freight_breakdowns (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid references public.orders (id) on delete set null,
  -- reference details (filled from the order, editable)
  customer_name      text,
  quote_number       text,
  invoice_number     text,
  ship_date          date,
  freight_type       text not null default 'LTL' check (freight_type in ('LTL', 'FTL', 'LCL', 'FCL', 'Air')),
  currency           text not null default 'CAD' check (currency in ('CAD', 'USD')),
  -- USD to CAD; 1 for CAD
  exchange_rate      numeric(12, 6) not null default 1 check (exchange_rate > 0),
  invoice_total      numeric(14, 2) not null default 0,
  -- shipment
  agent_id           uuid references public.freight_agents (id) on delete set null,
  agent_name         text,
  agent_ref          text,
  sub_contractor     text,
  carrier            text,
  tracking_number    text,
  -- costs, in the entered currency
  cargo_value        numeric(14, 2) not null default 0 check (cargo_value >= 0),
  freight            numeric(14, 2) not null default 0 check (freight >= 0),
  insurance          numeric(14, 2) not null default 0 check (insurance >= 0),
  insurance_auto     boolean not null default false,
  broker_fees        numeric(14, 2) not null default 0 check (broker_fees >= 0),
  broker_standard    boolean not null default false,
  hourly_rate        numeric(10, 2) not null default 0 check (hourly_rate >= 0),
  hours              numeric(8, 2) not null default 0 check (hours >= 0),
  plywood_rate       numeric(10, 2) not null default 0 check (plywood_rate >= 0),
  plywood_sheets     numeric(8, 2) not null default 0 check (plywood_sheets >= 0),
  margin_pct         numeric(7, 2) not null default 0 check (margin_pct >= 0),
  -- results (worked out by the trigger)
  handling           numeric(14, 2) not null default 0,
  subtotal           numeric(14, 2) not null default 0,
  freight_subtotal   numeric(14, 2) not null default 0,
  breakdown_total    numeric(14, 2) not null default 0,
  total_with_margin  numeric(14, 2) not null default 0,
  freight_with_margin numeric(14, 2) not null default 0,
  price_difference   numeric(14, 2) not null default 0,
  -- (cargo value + freight) × uplift: the value insured (CIF + 10 %)
  insured_value      numeric(14, 2) not null default 0,
  -- the same money in CAD
  invoice_total_cad      numeric(14, 2) not null default 0,
  cargo_value_cad        numeric(14, 2) not null default 0,
  freight_cad            numeric(14, 2) not null default 0,
  insurance_cad          numeric(14, 2) not null default 0,
  broker_fees_cad        numeric(14, 2) not null default 0,
  handling_cad           numeric(14, 2) not null default 0,
  subtotal_cad           numeric(14, 2) not null default 0,
  freight_subtotal_cad   numeric(14, 2) not null default 0,
  breakdown_total_cad    numeric(14, 2) not null default 0,
  total_with_margin_cad  numeric(14, 2) not null default 0,
  freight_with_margin_cad numeric(14, 2) not null default 0,
  price_difference_cad   numeric(14, 2) not null default 0,
  insured_value_cad      numeric(14, 2) not null default 0,
  notes              text check (notes is null or length(notes) <= 2000),
  source             text not null default 'app' check (source in ('app', 'import')),
  -- one old record is imported once
  import_key         text unique,
  created_by         text,
  created_by_name    text,
  updated_by_name    text,
  archived           boolean not null default false,
  archived_at        timestamptz,
  archived_by        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index freight_breakdowns_order_idx on public.freight_breakdowns (order_id);
create index freight_breakdowns_ship_idx on public.freight_breakdowns (ship_date);
create trigger freight_breakdowns_updated_at before update on public.freight_breakdowns
  for each row execute function public.set_updated_at();
create trigger freight_breakdowns_archived before insert or update of archived on public.freight_breakdowns
  for each row execute function public.set_archived_info();

-- The results and the CAD amounts always follow the entered numbers.
create or replace function public.freight_breakdowns_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ins  jsonb := public.freight_settings() -> 'insurance';
  v_up   numeric := coalesce((v_ins ->> 'uplift')::numeric, 1.1);
  v_rate numeric;
begin
  if new.currency = 'CAD' then new.exchange_rate := 1; end if;
  v_rate := new.exchange_rate;
  if new.agent_id is not null then
    new.agent_name := (select name from public.freight_agents where id = new.agent_id);
  end if;
  if new.insurance_auto then
    new.insurance := greatest(
      round((new.cargo_value + new.freight) * v_up * coalesce((v_ins ->> 'rate_pct')::numeric, 0.5) / 100, 2),
      coalesce((v_ins ->> 'minimum')::numeric, 50));
  end if;
  new.handling := round(new.hours * new.hourly_rate + new.plywood_sheets * new.plywood_rate, 2);
  new.subtotal := new.cargo_value + new.freight + new.insurance + new.broker_fees + new.handling;
  new.freight_subtotal := new.subtotal - new.cargo_value;
  new.breakdown_total := new.subtotal;
  new.total_with_margin := round(new.breakdown_total * (1 + new.margin_pct / 100), 2);
  new.freight_with_margin := round(new.freight_subtotal * (1 + new.margin_pct / 100), 2);
  new.price_difference := new.invoice_total - new.breakdown_total;
  new.insured_value := round((new.cargo_value + new.freight) * v_up, 2);
  new.invoice_total_cad := round(new.invoice_total * v_rate, 2);
  new.cargo_value_cad := round(new.cargo_value * v_rate, 2);
  new.freight_cad := round(new.freight * v_rate, 2);
  new.insurance_cad := round(new.insurance * v_rate, 2);
  new.broker_fees_cad := round(new.broker_fees * v_rate, 2);
  new.handling_cad := round(new.handling * v_rate, 2);
  new.subtotal_cad := round(new.subtotal * v_rate, 2);
  new.freight_subtotal_cad := round(new.freight_subtotal * v_rate, 2);
  new.breakdown_total_cad := round(new.breakdown_total * v_rate, 2);
  new.total_with_margin_cad := round(new.total_with_margin * v_rate, 2);
  new.freight_with_margin_cad := round(new.freight_with_margin * v_rate, 2);
  new.price_difference_cad := round(new.price_difference * v_rate, 2);
  new.insured_value_cad := round(new.insured_value * v_rate, 2);
  return new;
end;
$$;
create trigger freight_breakdowns_fill before insert or update on public.freight_breakdowns
  for each row execute function public.freight_breakdowns_fill();

alter table public.freight_breakdowns enable row level security;
create policy "Freight readers" on public.freight_breakdowns for select to authenticated
  using ((select public.has_any_perm(array['freight.breakdowns', 'freight.insurance'], 'view')));
-- Written only through the functions below.
revoke insert, update, delete on public.freight_breakdowns from authenticated;
revoke all on public.freight_breakdowns from anon;

-- Save a breakdown (new, or a change when p has "id"). Returns its id.
create or replace function public.save_freight_breakdown(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid := nullif(p ->> 'id', '')::uuid;
  v_order uuid := nullif(p ->> 'order_id', '')::uuid;
  v_new   boolean := v_id is null;
  n       public.freight_breakdowns%rowtype;
  t text;
  num numeric;
begin
  perform public.require_perm('freight.breakdowns', 'edit');
  if coalesce(p ->> 'freight_type', '') not in ('LTL', 'FTL', 'LCL', 'FCL', 'Air') then
    raise exception 'Choose the freight type.' using errcode = '22023';
  end if;
  if coalesce(p ->> 'currency', '') not in ('CAD', 'USD') then
    raise exception 'Choose the currency.' using errcode = '22023';
  end if;
  if p ->> 'currency' = 'USD' and coalesce(nullif(p ->> 'exchange_rate', '')::numeric, 0) <= 0 then
    raise exception 'Enter the exchange rate (USD to CAD).' using errcode = '22023';
  end if;
  foreach t in array array['cargo_value', 'freight', 'insurance', 'broker_fees', 'hourly_rate', 'hours', 'plywood_rate', 'plywood_sheets', 'margin_pct'] loop
    num := coalesce(nullif(p ->> t, '')::numeric, 0);
    if num < 0 then raise exception 'Amounts cannot be negative.' using errcode = '22023'; end if;
  end loop;
  if v_order is not null and not exists (select 1 from public.orders where id = v_order) then
    raise exception 'That order could not be found.' using errcode = '22023';
  end if;
  if not v_new then
    select * into n from public.freight_breakdowns where id = v_id for update;
    if n.id is null then raise exception 'That cost breakdown could not be found.'; end if;
  else
    v_id := gen_random_uuid();
  end if;

  n.id := v_id;
  n.order_id := v_order;
  n.customer_name := nullif(btrim(p ->> 'customer_name'), '');
  n.quote_number := nullif(btrim(p ->> 'quote_number'), '');
  n.invoice_number := nullif(btrim(p ->> 'invoice_number'), '');
  n.ship_date := nullif(p ->> 'ship_date', '')::date;
  n.freight_type := p ->> 'freight_type';
  n.currency := p ->> 'currency';
  n.exchange_rate := case when p ->> 'currency' = 'USD' then (p ->> 'exchange_rate')::numeric else 1 end;
  n.invoice_total := coalesce(nullif(p ->> 'invoice_total', '')::numeric, 0);
  n.agent_id := nullif(p ->> 'agent_id', '')::uuid;
  n.agent_name := nullif(btrim(p ->> 'agent_name'), '');
  n.agent_ref := nullif(btrim(p ->> 'agent_ref'), '');
  n.sub_contractor := nullif(btrim(p ->> 'sub_contractor'), '');
  n.carrier := nullif(btrim(p ->> 'carrier'), '');
  n.tracking_number := nullif(btrim(p ->> 'tracking_number'), '');
  n.cargo_value := coalesce(nullif(p ->> 'cargo_value', '')::numeric, 0);
  n.freight := coalesce(nullif(p ->> 'freight', '')::numeric, 0);
  n.insurance := coalesce(nullif(p ->> 'insurance', '')::numeric, 0);
  n.insurance_auto := coalesce((p ->> 'insurance_auto')::boolean, false);
  n.broker_fees := coalesce(nullif(p ->> 'broker_fees', '')::numeric, 0);
  n.broker_standard := coalesce((p ->> 'broker_standard')::boolean, false);
  n.hourly_rate := coalesce(nullif(p ->> 'hourly_rate', '')::numeric, 0);
  n.hours := coalesce(nullif(p ->> 'hours', '')::numeric, 0);
  n.plywood_rate := coalesce(nullif(p ->> 'plywood_rate', '')::numeric, 0);
  n.plywood_sheets := coalesce(nullif(p ->> 'plywood_sheets', '')::numeric, 0);
  n.margin_pct := coalesce(nullif(p ->> 'margin_pct', '')::numeric, 0);
  n.notes := nullif(btrim(p ->> 'notes'), '');
  n.updated_by_name := public.current_user_name();

  if v_new then
    n.source := 'app';
    n.created_by := public.current_user_email();
    n.created_by_name := public.current_user_name();
    n.archived := false;
    n.created_at := now();
    n.updated_at := now();
    insert into public.freight_breakdowns select n.*;
  else
    update public.freight_breakdowns b set
      order_id = n.order_id, customer_name = n.customer_name, quote_number = n.quote_number, invoice_number = n.invoice_number,
      ship_date = n.ship_date, freight_type = n.freight_type, currency = n.currency, exchange_rate = n.exchange_rate,
      invoice_total = n.invoice_total, agent_id = n.agent_id, agent_name = n.agent_name, agent_ref = n.agent_ref,
      sub_contractor = n.sub_contractor, carrier = n.carrier, tracking_number = n.tracking_number,
      cargo_value = n.cargo_value, freight = n.freight, insurance = n.insurance, insurance_auto = n.insurance_auto,
      broker_fees = n.broker_fees, broker_standard = n.broker_standard, hourly_rate = n.hourly_rate, hours = n.hours,
      plywood_rate = n.plywood_rate, plywood_sheets = n.plywood_sheets, margin_pct = n.margin_pct, notes = n.notes,
      updated_by_name = n.updated_by_name
     where b.id = v_id;
  end if;

  select * into n from public.freight_breakdowns where id = v_id;
  insert into public.activity_log (user_email, table_name, record_id, order_id, action, changes)
  values (public.current_user_email(), 'freight_breakdowns', v_id::text, n.order_id, case when v_new then 'insert' else 'update' end,
          jsonb_build_object('agent', n.agent_name, 'freight_type', n.freight_type, 'currency', n.currency,
                             'breakdown_total', n.breakdown_total, 'invoice_number', n.invoice_number));
  return v_id;
end;
$$;

create or replace function public.archive_freight_breakdown(p_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.freight_breakdowns%rowtype;
begin
  perform public.require_perm('freight.breakdowns.archive', 'edit');
  select * into v from public.freight_breakdowns where id = p_id;
  if v.id is null then raise exception 'That cost breakdown could not be found.'; end if;
  update public.freight_breakdowns set archived = coalesce(p_archived, true) where id = p_id;
  insert into public.activity_log (user_email, table_name, record_id, order_id, action, changes)
  values (public.current_user_email(), 'freight_breakdowns', p_id::text, v.order_id, 'update',
          jsonb_build_object('archived', coalesce(p_archived, true), 'invoice_number', v.invoice_number, 'agent', v.agent_name));
end;
$$;

-- ===========================================================================
-- 3. Freight quote requests that were emailed (written by the send-email function)
-- ===========================================================================
create table public.freight_quote_requests (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references public.orders (id) on delete set null,
  agent_id     uuid references public.freight_agents (id) on delete set null,
  agent_name   text,
  to_emails    text[] not null,
  cc_emails    text[] not null default '{}',
  bcc_emails   text[] not null default '{}',
  subject      text not null,
  body         text not null,
  status       text not null check (status in ('sent', 'failed')),
  error        text,
  email_log_id uuid references public.email_log (id) on delete set null,
  sent_by      text,
  sent_at      timestamptz not null default now()
);
create index freight_quote_requests_order_idx on public.freight_quote_requests (order_id, sent_at);
alter table public.freight_quote_requests enable row level security;
create policy "Freight quote readers" on public.freight_quote_requests for select to authenticated
  using ((select public.has_perm('freight.quote', 'view')));
revoke insert, update, delete on public.freight_quote_requests from authenticated;
revoke all on public.freight_quote_requests from anon;

alter table public.email_log drop constraint email_log_kind_check;
alter table public.email_log add constraint email_log_kind_check
  check (kind in ('notification', 'digest', 'test', 'resend', 'certificate', 'ce_declaration', 'freight_quote'));

-- ===========================================================================
-- 4. What a breakdown or a quote request takes from its order
-- ===========================================================================
create or replace function public.freight_order_info(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o public.orders%rowtype;
  c public.customers%rowtype;
  v_contact boolean := public.has_perm('customer.contact', 'view');
  v_crating boolean := public.has_perm('crating', 'view');
begin
  perform public.require_any_perm(array['freight.breakdowns', 'freight.quote'], 'view');
  select * into o from public.orders where id = p_order;
  if o.id is null then raise exception 'That order could not be found.'; end if;
  select * into c from public.customers where id = o.customer_id;
  return jsonb_build_object(
    'order_id', o.id, 'order_code', o.order_code,
    'customer_name', c.name, 'customer_company', c.company, 'country', c.country, 'state_province', c.state_province,
    'customer_phone', case when v_contact then c.phone end,
    'customer_emails', case when v_contact then to_jsonb(c.emails) else '[]'::jsonb end,
    'quote_number', o.quote_number, 'invoice_number', o.invoice_number, 'currency', o.currency,
    'order_total', case when public.has_perm('order.field.order_total', 'view') then o.order_total end,
    'freight_type', o.freight_type, 'delivery_equipment', o.delivery_equipment,
    'actual_ship_date', o.actual_ship_date, 'expected_ship_date', o.expected_ship_date,
    'crating_hours', case when v_crating then (select coalesce(sum(build_hours), 0) from public.crates where order_id = o.id and not archived) end,
    'plywood_sheets', case when v_crating then (select coalesce(sum(plywood_sheets), 0) from public.crates where order_id = o.id and not archived) end,
    'crates', case when v_crating then coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', cr.id, 'length_cm', cr.length_cm, 'width_cm', cr.width_cm, 'height_cm', cr.height_cm, 'weight_kg', cr.weight_kg,
                 'contents', (select string_agg(mt.name, ', ' order by mt.name)
                                from public.crate_machines cm
                                join public.order_machines m on m.id = cm.machine_id
                                join public.machine_types mt on mt.id = m.machine_type_id
                               where cm.crate_id = cr.id))
               order by cr.crated_on, cr.created_at)
          from public.crates cr where cr.order_id = o.id and not cr.archived), '[]'::jsonb)
      else '[]'::jsonb end);
end;
$$;

-- ===========================================================================
-- 5. Import of the old Freight Multitool sheet (amounts in CAD, as it saved them)
-- ===========================================================================
-- p_rows: [{timestamp, shipDate, customerName, quoteNumber, invoiceNumber, refNumber, carrier, subContractor,
--           enteredCurrency, exchangeRate, freightType, invoiceTotal, cargoValue, freight, insurance, brokerFees,
--           hourlyRate, hours, plywoodRate, plywoodSheets, marginPct, order_id (chosen in the preview, optional)}]
create or replace function public.import_freight_breakdowns(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  v_key text;
  v_order uuid;
  v_agent uuid;
  v_name text;
  v_cur text;
  v_fx numeric;
  v_type text;
  v_imported integer := 0;
  v_skipped integer := 0;
  v_matched integer := 0;
  m numeric;
begin
  perform public.require_perm('freight.breakdowns.import', 'edit');
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Nothing to import.' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_key := 'multitool|' || coalesce(r ->> 'timestamp', '') || '|' || coalesce(r ->> 'invoiceNumber', '') || '|' || coalesce(r ->> 'customerName', '');
    if exists (select 1 from public.freight_breakdowns where import_key = v_key) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    -- The order: chosen in the preview, else one order with that invoice #, else one with that quote #.
    v_order := nullif(r ->> 'order_id', '')::uuid;
    if v_order is not null and not exists (select 1 from public.orders where id = v_order) then v_order := null; end if;
    if v_order is null and nullif(btrim(r ->> 'invoiceNumber'), '') is not null then
      select min(id::text)::uuid into v_order from public.orders
       where not archived and lower(btrim(invoice_number)) = lower(btrim(r ->> 'invoiceNumber')) having count(*) = 1;
    end if;
    if v_order is null and nullif(btrim(r ->> 'quoteNumber'), '') is not null then
      select min(id::text)::uuid into v_order from public.orders
       where not archived and lower(btrim(quote_number)) = lower(btrim(r ->> 'quoteNumber')) having count(*) = 1;
    end if;
    if v_order is not null then v_matched := v_matched + 1; end if;

    v_name := nullif(btrim(r ->> 'carrier'), '');
    v_agent := null;
    if v_name is not null then
      select id into v_agent from public.freight_agents where lower(btrim(name)) = lower(v_name);
      if v_agent is null then
        insert into public.freight_agents (name, sort_order)
        values (left(v_name, 80), coalesce((select max(sort_order) from public.freight_agents), 0) + 1) returning id into v_agent;
      end if;
    end if;

    -- The sheet holds CAD. A USD record goes back to USD with its own rate, so both stay right.
    v_cur := case when upper(coalesce(r ->> 'enteredCurrency', '')) = 'USD' then 'USD' else 'CAD' end;
    v_fx := coalesce(nullif(r ->> 'exchangeRate', '')::numeric, 0);
    if v_cur = 'USD' and v_fx <= 0 then v_cur := 'CAD'; end if;
    m := case when v_cur = 'USD' then v_fx else 1 end;
    v_type := case upper(coalesce(r ->> 'freightType', ''))
                when 'FTL' then 'FTL' when 'LCL' then 'LCL' when 'FCL' then 'FCL' when 'AIR' then 'Air' else 'LTL' end;

    insert into public.freight_breakdowns (
      order_id, customer_name, quote_number, invoice_number, ship_date, freight_type, currency, exchange_rate, invoice_total,
      agent_id, agent_name, agent_ref, sub_contractor, cargo_value, freight, insurance, insurance_auto, broker_fees,
      hourly_rate, hours, plywood_rate, plywood_sheets, margin_pct, source, import_key, created_by, created_by_name, created_at)
    values (
      v_order, nullif(btrim(r ->> 'customerName'), ''), nullif(btrim(r ->> 'quoteNumber'), ''), nullif(btrim(r ->> 'invoiceNumber'), ''),
      nullif(left(r ->> 'shipDate', 10), '')::date, v_type, v_cur, m,
      round(coalesce(nullif(r ->> 'invoiceTotal', '')::numeric, 0) / m, 2),
      v_agent, v_name, nullif(btrim(coalesce(nullif(r ->> 'refNumber', ''), r ->> 'livingstonRef')), ''), nullif(btrim(r ->> 'subContractor'), ''),
      round(greatest(coalesce(nullif(r ->> 'cargoValue', '')::numeric, 0), 0) / m, 2),
      round(greatest(coalesce(nullif(r ->> 'freight', '')::numeric, 0), 0) / m, 2),
      round(greatest(coalesce(nullif(r ->> 'insurance', '')::numeric, 0), 0) / m, 2), false,
      round(greatest(coalesce(nullif(r ->> 'brokerFees', '')::numeric, 0), 0) / m, 2),
      round(greatest(coalesce(nullif(r ->> 'hourlyRate', '')::numeric, 0), 0) / m, 2),
      greatest(coalesce(nullif(r ->> 'hours', '')::numeric, 0), 0),
      round(greatest(coalesce(nullif(r ->> 'plywoodRate', '')::numeric, 0), 0) / m, 2),
      greatest(coalesce(nullif(r ->> 'plywoodSheets', '')::numeric, 0), 0),
      greatest(coalesce(nullif(r ->> 'marginPct', '')::numeric, 0), 0),
      'import', v_key, public.current_user_email(), public.current_user_name(),
      coalesce(nullif(r ->> 'timestamp', '')::timestamptz, now()));
    v_imported := v_imported + 1;
  end loop;
  perform public.log_admin_action('freight_breakdowns', 'import', null,
    jsonb_build_object('action', 'Freight Multitool data imported', 'imported', v_imported, 'skipped', v_skipped, 'matched', v_matched));
  return jsonb_build_object('imported', v_imported, 'skipped', v_skipped, 'matched', v_matched);
end;
$$;

-- ===========================================================================
-- 6. "Crating Report" is now "Freight" (/freight)
-- ===========================================================================
alter table public.user_preferences drop constraint user_preferences_start_page_check;
update public.user_preferences set start_page = '/freight' where start_page = '/crating';
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/freight', '/reports/department-delays',
     '/reports/build-times', '/machines', '/boards', '/notices', '/service', '/service/calendar', '/chat', '/agent', '/settings', '/admin', '/shop-board'));

-- ===========================================================================
-- 7. Access lockdown
-- ===========================================================================
-- Full lockdown block (see CLAUDE.md, BOARDS UPGRADE).
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
grant execute on function public.admin_auth_user_id(text) to service_role;
revoke execute on function public.check_dispatch_key(text) from authenticated;
grant execute on function public.check_dispatch_key(text) to service_role;
-- Internal helpers: only through the triggers above.
revoke execute on function public.system_on(), public.production_split_leftovers(uuid, uuid),
  public.production_merge_leftover(uuid, text), public.production_card_entered(uuid),
  public.production_refresh_due(uuid, uuid) from authenticated;
-- Internals: only through the functions above / the Edge Function.
revoke execute on function public.calendar_rows(text, date, date, boolean) from authenticated;
revoke execute on function public.calendar_feed(text) from authenticated;
grant execute on function public.calendar_feed(text) to service_role;
revoke execute on function public.apply_phone_events(text, text, jsonb, text) from authenticated;
grant execute on function public.apply_phone_events(text, text, jsonb, text) to service_role;
revoke execute on function public.calendar_imports_due(text) from authenticated;
grant execute on function public.calendar_imports_due(text) to service_role;
-- Chat internals.
revoke execute on function public.chat_sync_department(uuid), public.chat_sync_user_group(uuid), public.chat_find_links(text),
  public.in_quiet_hours(text, timestamptz) from authenticated;
-- Saved signatures are only checked inside the signing functions.
revoke execute on function public.use_saved_signature(uuid, text, text) from authenticated;
-- Closure alert notifications are only sent by the functions above.
revoke execute on function public.closure_alert_notify(uuid, text, text) from authenticated;
