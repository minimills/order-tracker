-- 0059: machine lifecycle, step 3 of 3 – selling from stock, documents,
-- the machine page and reports.
--
-- 1. Orders and stock: order_add_machine(order, machine, kind) – "stock" moves a
--    company-owned machine onto the order (Reserved, no new serial; it keeps its
--    history in machine_orders), "service" only lists a customer's machine on the
--    order for the record; order_remove_machine; create_order_with_stock.
--    Shipping the order = Sold (owner = the order's customer, warranty starts);
--    cancelling or archiving it puts reserved machines back in stock.
-- 2. The final-check rule skips used machines sold as they are; the machine
--    chips view knows the kind (badges "R" / "Used").
-- 3. Documents: CE data and commissioning certificates use the current (-R)
--    serial and note "Refurbished from <old serial>" when Admin → Machine
--    Lifecycle allows it; machines without an order work too.
-- 4. machine_details(): everything for the Machine page.
-- 5. machine_reports(): buy-backs, refurbishments in progress, time and cost per
--    machine type, profit per refurbished machine, machines by owner and country.
-- 6. Access lockdown.

-- ===========================================================================
-- 1. Orders and stock
-- ===========================================================================
alter table public.machine_orders add column previous_kind text;

create or replace function public.order_add_machine(p_order uuid, p_machine uuid, p_kind text default 'stock')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  m public.order_machines;
begin
  perform public.require_any_perm(array['order.machines.from_stock', 'orders.new.from_stock'], 'edit');
  select * into o from public.orders where id = p_order;
  select * into m from public.order_machines where id = p_machine and not archived;
  if o.id is null then raise exception 'That order could not be found.'; end if;
  if m.id is null then raise exception 'That machine could not be found.'; end if;
  if o.archived or o.stage in ('Shipped', 'Cancelled') then
    raise exception 'Machines cannot be added to a shipped, cancelled or archived order.' using errcode = '22023';
  end if;
  if p_kind = 'service' then
    if exists (select 1 from public.machine_orders where machine_id = p_machine and order_id = p_order and released_at is null) then
      raise exception 'This machine is already on the order.' using errcode = '22023';
    end if;
    insert into public.machine_orders (machine_id, order_id, role) values (p_machine, p_order, 'service');
    return;
  end if;
  if p_kind <> 'stock' then raise exception 'Choose From stock or Customer-owned.' using errcode = '22023'; end if;
  if not public.machine_company_owned(p_machine) or coalesce(m.stock_status, '') not in ('ready_to_sell', 'bought_back') then
    raise exception 'Only machines in stock (Ready to sell or Bought back) can be sold on an order.' using errcode = '22023';
  end if;
  insert into public.machine_orders (machine_id, order_id, role, previous_order_id, previous_status, previous_kind)
  values (p_machine, p_order, 'sale', m.order_id, m.stock_status, m.item_kind);
  perform public.system_on();
  perform set_config('app.machine_moving', 'on', true);
  update public.order_machines
     set order_id = p_order, stock_status = 'reserved',
         item_kind = case when m.item_kind = 'refurbished' then 'refurbished' else 'used' end,
         needs_crate = coalesce(o.crating, true) and needs_crate
   where id = p_machine;
  perform set_config('app.machine_moving', '', true);
  perform set_config('app.system_change', '', true);
end;
$$;

create or replace function public.order_remove_machine(p_order uuid, p_machine uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.machine_orders;
  m public.order_machines;
begin
  perform public.require_any_perm(array['order.machines.from_stock', 'orders.new.from_stock'], 'edit');
  select * into l from public.machine_orders where machine_id = p_machine and order_id = p_order and released_at is null
   and role in ('sale', 'service') order by added_at desc limit 1;
  if l.id is null then raise exception 'That machine is not on this order from stock or for service.' using errcode = '22023'; end if;
  select * into m from public.order_machines where id = p_machine;
  if l.role = 'sale' and m.stock_status <> 'reserved' then
    raise exception 'The machine was already sold on this order.' using errcode = '22023';
  end if;
  perform public.release_order_machine(l.id);
end;
$$;

-- Internal: undo a sale link (back to stock) or a service link.
create or replace function public.release_order_machine(p_link uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.machine_orders;
begin
  select * into l from public.machine_orders where id = p_link;
  update public.machine_orders set released_at = now() where id = p_link;
  if l.role = 'sale' then
    perform public.system_on();
    perform set_config('app.machine_moving', 'on', true);
    update public.order_machines
       set order_id = l.previous_order_id, stock_status = coalesce(l.previous_status, 'ready_to_sell'),
           item_kind = coalesce(l.previous_kind, item_kind)
     where id = l.machine_id and stock_status = 'reserved';
    perform set_config('app.machine_moving', '', true);
    perform set_config('app.system_change', '', true);
  end if;
end;
$$;

-- New order with machines from stock (and customer-owned machines listed for
-- service) in one step. p_extra: [{machine_id, kind: 'stock' | 'service'}]
create or replace function public.create_order_with_stock(p_order jsonb, p_extra jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  x jsonb;
begin
  if jsonb_array_length(coalesce(p_extra, '[]'::jsonb)) > 0 then
    perform public.require_perm('orders.new.from_stock');
  end if;
  v := public.create_order(p_order);
  for x in select value from jsonb_array_elements(coalesce(p_extra, '[]'::jsonb)) loop
    perform public.order_add_machine((v ->> 'id')::uuid, (x ->> 'machine_id')::uuid, coalesce(x ->> 'kind', 'stock'));
  end loop;
  return v;
end;
$$;

-- Shipped = sold; cancelled or archived = back in stock.
create or replace function public.orders_stock_machines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if new.stage = 'Shipped' and old.stage is distinct from 'Shipped' then
    for r in select m.id from public.order_machines m where m.order_id = new.id and m.stock_status = 'reserved' loop
      insert into public.machine_owners (machine_id, customer_id, owned_from, order_id, how, notes)
      values (r.id, new.customer_id, coalesce(new.actual_ship_date, public.halifax_today()), new.id, 'sold_through_us',
              'Sold from stock on order ' || new.order_code);
      perform public.system_on();
      update public.order_machines set stock_status = 'sold', location = 'At the customer' where id = r.id;
    end loop;
  elsif (new.stage = 'Cancelled' and old.stage is distinct from 'Cancelled') or (new.archived and not old.archived) then
    for r in select l.id from public.machine_orders l join public.order_machines m on m.id = l.machine_id
              where l.order_id = new.id and l.released_at is null and l.role = 'sale' and m.stock_status = 'reserved' loop
      perform public.release_order_machine(r.id);
    end loop;
  end if;
  return null;
end;
$$;
create trigger orders_stock_machines after update of stage, archived on public.orders
  for each row execute function public.orders_stock_machines();

-- Machines in stock, for the "From stock" pickers.
create or replace function public.stock_machines()
returns table (machine_id uuid, serial text, model text, code text, machine_type_id uuid, item_kind text, stock_status text,
               condition text, location text, year_built integer, refurb_count integer)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.serial_number, mt.name, mt.code, m.machine_type_id,
         case when m.item_kind = 'refurbished' then 'refurbished' else 'used' end,
         m.stock_status, m.condition, m.location, m.year_built, m.refurb_count
    from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id
   where not m.archived and m.stock_status in ('ready_to_sell', 'bought_back') and public.machine_company_owned(m.id)
     and public.has_any_perm(array['machines.stock', 'orders.new.from_stock', 'order.machines.from_stock'], 'view')
   order by mt.name, m.serial_number;
$$;

-- A customer's machines (current owner), for "Customer-owned, ours to service".
create or replace function public.customer_owned_machines(p_customer uuid)
returns table (machine_id uuid, serial text, model text, item_kind text)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.serial_number, mt.name, m.item_kind
    from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id
   where not m.archived and public.machine_owner_id(m.id) = p_customer and not public.machine_company_owned(m.id)
     and public.has_any_perm(array['orders.new.from_stock', 'order.machines.from_stock'], 'view')
   order by mt.name, m.serial_number;
$$;

-- Machines on an order from stock or for service (Order page).
create or replace function public.order_extra_machines(p_order uuid)
returns table (link_id uuid, role text, machine_id uuid, serial text, model text, item_kind text, stock_status text, owner text)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.role, m.id, m.serial_number, mt.name, m.item_kind, m.stock_status,
         (select coalesce(nullif(btrim(c.company), ''), c.name) from public.customers c where c.id = public.machine_owner_id(m.id))
    from public.machine_orders l
    join public.order_machines m on m.id = l.machine_id
    join public.machine_types mt on mt.id = m.machine_type_id
   where l.order_id = p_order and l.released_at is null and l.role in ('sale', 'service')
     and public.has_perm('order.page', 'view')
   order by l.role, mt.name;
$$;

-- ===========================================================================
-- 2. Final check rule and machine chips
-- ===========================================================================
create or replace function public.checklist_gate_problems(p_order_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(mt.name || coalesce(' ' || om.serial_number, '') order by mt.name, om.serial_number), '{}')
    from public.order_machines om
    join public.machine_types mt on mt.id = om.machine_type_id
    left join public.machine_checklists c on c.machine_id = om.id
   where om.order_id = p_order_id
     and not om.archived
     and om.item_kind <> 'used'          -- used machines are sold as they are
     and (c.id is null or c.signed_at is null)
     and (public.is_allowed_user() or public.is_service_caller());
$$;

create or replace view public.order_machine_status as
 SELECT om.id, om.order_id, om.machine_type_id, mt.name AS machine_type,
    COALESCE(NULLIF(btrim(mt.short_name), ''), mt.name) AS short_name, om.serial_number, om.ready, om.checklist_done,
    COALESCE(mc.crate_count, 0) AS crate_count, om.created_at, cs.status AS checklist_status, cs.total_items AS checklist_total,
    (cs.done_items + cs.na_items) AS checklist_completed, om.needs_crate, om.item_kind
   FROM order_machines om
     JOIN machine_types mt ON mt.id = om.machine_type_id
     LEFT JOIN machine_crating mc ON mc.machine_id = om.id
     LEFT JOIN machine_checklist_status cs ON cs.machine_id = om.id
  WHERE NOT om.archived;

-- ===========================================================================
-- 3. Documents
-- ===========================================================================
-- The "Refurbished from …" note for a machine (null when not refurbished or
-- when Admin → Machine Lifecycle turns it off for that kind of document).
create or replace function public.machine_refurb_note(p_machine uuid, p_doc text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'Refurbished from ' || a.serial
    from public.order_machines m
    join lateral (select serial from public.machine_serial_aliases where machine_id = m.id and reason = 'refurbished'
                   order by replaced_on desc, created_at desc limit 1) a on true
   where m.id = p_machine and m.item_kind = 'refurbished'
     and coalesce((public.machine_lifecycle_settings() -> 'refurb_note' ->> p_doc)::boolean, true);
$$;

create or replace function public.ce_declaration_data(p_machine uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_set     jsonb := coalesce((select value from public.app_settings where key = 'ce'), '{}'::jsonb);
  v_co      jsonb := coalesce((select value from public.app_settings where key = 'company'), '{}'::jsonb);
  v_kind    text  := coalesce(nullif(p ->> 'kind', ''), v_set ->> 'declaration_type', 'ec_2006');
  v_tpl     public.document_templates%rowtype;
  v_m       record;
  v_year    integer;
  v_dirs    text[];
  v_stds    text[];
  v_problem text[] := '{}';
begin
  if not public.has_any_perm(array['ce.issue', 'admin.ce'], 'view') then
    raise exception 'You do not have permission to issue declarations of conformity.' using errcode = '42501';
  end if;
  select om.id, om.serial_number, om.order_id, om.year_built, mt.name as type_name, mt.code, mt.product_description,
         mt.ce_directives, mt.ce_standards, o.order_code, coalesce(om.voltage, o.voltage) as voltage,
         c.name as customer_name, c.company as customer_company,
         (select mc.signed_at from public.machine_checklists mc where mc.machine_id = om.id) as checked_at
    into v_m
    from public.order_machines om
    join public.machine_types mt on mt.id = om.machine_type_id
    left join public.orders o on o.id = om.order_id
    left join public.customers c on c.id = coalesce(o.customer_id, public.machine_owner_id(om.id))
   where om.id = p_machine and not om.archived;
  if v_m.id is null then
    raise exception 'That machine could not be found.';
  end if;
  select * into v_tpl from public.document_templates where key = case v_kind when 'eu_2023' then 'ce_eu' else 'ce_ec' end;

  v_year := coalesce(nullif(p ->> 'year', '')::integer, extract(year from (v_m.checked_at at time zone 'America/Halifax'))::integer,
                     v_m.year_built, extract(year from public.halifax_today())::integer);
  select coalesce(array_agg(case when v_kind = 'eu_2023' and d like '%2006/42/EC%' then 'Machinery Regulation (EU) 2023/1230' else d end
                            order by coalesce((select sort_order from public.option_lists o where o.list_name = 'ce_directive' and o.value = d), 99)), '{}')
    into v_dirs from unnest(coalesce(v_m.ce_directives, '{}')) d;
  select coalesce(array_agg(btrim(s)) filter (where btrim(s) <> ''), '{}') into v_stds
    from regexp_split_to_table(coalesce(v_m.ce_standards, ''), E'\n') s;

  if v_m.serial_number is null then v_problem := v_problem || 'This machine has no serial number yet.'::text; end if;
  if v_m.code is null then v_problem := v_problem || 'The machine type has no code (Admin → Machine Types).'::text; end if;
  if cardinality(v_dirs) = 0 then v_problem := v_problem || 'No directives are chosen for this machine type (Admin → Machine Types).'::text; end if;
  if coalesce(btrim(v_m.product_description), '') = '' then
    v_problem := v_problem || 'The machine type has no product description; its name is used (Admin → Machine Types).'::text;
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'title', coalesce(v_tpl.title, case v_kind when 'eu_2023' then 'EU Declaration of Conformity' else 'EC Declaration of Conformity' end),
    'declaration_html', coalesce(v_tpl.part1, ''),
    'closing_html', coalesce(v_tpl.part2, ''),
    'manufacturer', jsonb_build_object(
      'name', coalesce(v_co ->> 'name', 'Belfast Mini Mills Ltd.'), 'address', v_co ->> 'address', 'phone', v_co ->> 'phone',
      'contact_person', coalesce(nullif(v_co ->> 'contact_person', ''), 'Ankit Luthra'),
      'email', coalesce(nullif(v_co ->> 'office_email', ''), v_co ->> 'email'), 'website', v_co ->> 'website'),
    'authorised_person', coalesce(v_set ->> 'authorised_person', ''),
    'machine', jsonb_build_object(
      'product', coalesce(nullif(btrim(v_m.product_description), ''), v_m.type_name),
      'brand', coalesce(nullif(v_set ->> 'brand', ''), 'Belfast Mini Mills Limited'),
      'model', v_m.code,
      'serial_number', v_m.serial_number,
      -- the serial without the model code ("2073", "2073-R")
      'serial', case when v_m.code is not null and v_m.serial_number ilike v_m.code || '-%'
                     then substr(v_m.serial_number, length(v_m.code) + 2)
                     else regexp_replace(coalesce(v_m.serial_number, ''), '^[A-Za-z]+-', '') end,
      'voltage', v_m.voltage,
      'year', v_year,
      'type_name', v_m.type_name,
      'refurbished_from', public.machine_refurb_note(v_m.id, 'ce')),
    'directives', to_jsonb(v_dirs),
    'standards', to_jsonb(v_stds),
    'notified_body', nullif(btrim(coalesce(v_set ->> 'notified_body', '')), ''),
    'place', coalesce(nullif(btrim(p ->> 'place'), ''), v_set ->> 'place', 'Belfast, PEI, Canada'),
    'date', coalesce(nullif(p ->> 'date', '')::date, public.halifax_today()),
    'signer', coalesce(nullif(btrim(p ->> 'signer'), ''), v_set ->> 'signer', ''),
    'order_id', v_m.order_id,
    'order_code', v_m.order_code,
    'customer_name', v_m.customer_name,
    'customer_company', v_m.customer_company,
    'problems', to_jsonb(v_problem));
end;
$$;

-- Commissioning certificates: each listed machine carries its note.
create or replace function public.service_certificates_refurb_notes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'commissioning' or new.kind is null then
    select coalesce(jsonb_agg(case when x ->> 'machine_id' is not null
                                   then x || jsonb_build_object('note', public.machine_refurb_note((x ->> 'machine_id')::uuid, 'commissioning'))
                                   else x end), '[]'::jsonb)
      into new.machines
      from jsonb_array_elements(coalesce(new.machines, '[]'::jsonb)) x;
  end if;
  return new;
end;
$$;
create trigger service_certificates_refurb_notes before insert on public.service_certificates
  for each row execute function public.service_certificates_refurb_notes();

-- ===========================================================================
-- 4. The Machine page
-- ===========================================================================
create or replace function public.machine_details(p_machine uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_costs boolean := public.has_perm('refurb.costs', 'view');
  v_orig uuid;
begin
  perform public.require_perm('machines', 'view');
  select mo.order_id into v_orig from public.machine_orders mo where mo.machine_id = p_machine and mo.role = 'original'
   order by mo.added_at limit 1;
  select jsonb_build_object(
           'id', m.id, 'serial', m.serial_number, 'machine_type', mt.name, 'machine_type_id', mt.id, 'code', mt.code, 'built', m.ready,
           'archived', m.archived, 'order_id', o.id, 'order_code', o.order_code, 'order_date', o.order_date,
           'stage', o.stage, 'actual_ship_date', o.actual_ship_date,
           'original_order_id', v_orig, 'original_order_code', (select order_code from public.orders where id = v_orig),
           'origin', m.origin, 'year_built', m.year_built, 'year_approx', m.year_approx,
           'voltage', coalesce(m.voltage, o.voltage), 'location', m.location, 'condition', m.condition, 'notes', m.notes,
           'item_kind', m.item_kind, 'stock_status', m.stock_status, 'refurb_count', m.refurb_count,
           'company_owned', public.machine_company_owned(m.id),
           'warranty', public.machine_warranty(m.id),
           'sale_price', case when v_costs then m.sale_price end, 'sale_currency', case when v_costs then m.sale_currency end,
           'sale_exchange_rate', case when v_costs then m.sale_exchange_rate end,
           'added_by_name', m.added_by_name,
           'current_owner', (select jsonb_build_object('id', c.id, 'name', c.name, 'company', c.company, 'country', c.country)
                               from public.customers c where c.id = public.machine_owner_id(m.id)))
    into v
    from public.order_machines m
    left join public.orders o on o.id = m.order_id
    join public.machine_types mt on mt.id = m.machine_type_id
   where m.id = p_machine;
  if v is null then
    raise exception 'That machine could not be found.';
  end if;

  return v || jsonb_build_object(
    'old_serials', (select coalesce(jsonb_agg(jsonb_build_object('serial', a.serial, 'replaced_by', a.replaced_by, 'on', a.replaced_on, 'reason', a.reason)
                                              order by a.replaced_on, a.created_at), '[]'::jsonb)
                      from public.machine_serial_aliases a where a.machine_id = p_machine),
    'refurb_jobs', (select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'number', j.job_number, 'status', j.status,
                                                                 'opened_at', j.opened_at, 'completed_at', j.completed_at,
                                                                 'old_serial', j.old_serial, 'new_serial', j.new_serial, 'board_id', j.board_id)
                                              order by j.job_number), '[]'::jsonb)
                      from public.refurb_jobs j where j.machine_id = p_machine),
    'buybacks', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', b.id, 'date', b.bought_on, 'from', (select coalesce(nullif(btrim(c.company), ''), c.name) from public.customers c where c.id = b.from_customer_id),
                          'price', case when v_costs then b.price end, 'currency', case when v_costs then b.currency end,
                          'condition', b.condition_on_arrival, 'reason', b.reason,
                          'arranged_by', (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = b.arranged_by),
                          'incoming_shipment_id', b.incoming_shipment_id) order by b.bought_on), '[]'::jsonb)
                   from public.machine_buybacks b where b.machine_id = p_machine),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('order_id', l.order_id, 'order_code', o.order_code, 'role', l.role,
                                                            'added_at', l.added_at, 'released_at', l.released_at) order by l.added_at), '[]'::jsonb)
                 from public.machine_orders l join public.orders o on o.id = l.order_id where l.machine_id = p_machine),
    'owners', (
      select coalesce(jsonb_agg(x - 'k' order by x ->> 'k'), '[]'::jsonb) from (
        select jsonb_build_object('k', '0', 'customer_id', c.id, 'name', c.name, 'company', c.company, 'country', c.country,
                                  'from', o.order_date, 'how', 'original', 'order_id', o.id, 'order_code', o.order_code, 'notes', null,
                                  'company_stock', false, 'date_approx', false) x
          from public.orders o join public.customers c on c.id = o.customer_id
         where o.id = v_orig and not exists (select 1 from public.machine_owners where machine_id = p_machine and how = 'original')
        union all
        select jsonb_build_object('k', '1' || mo.owned_from::text || mo.created_at::text,
                                  'customer_id', c.id, 'name', coalesce(c.name, 'Company stock'), 'company', c.company, 'country', c.country,
                                  'from', mo.owned_from, 'how', mo.how, 'order_id', mo.order_id,
                                  'order_code', (select order_code from public.orders where id = mo.order_id), 'notes', mo.notes,
                                  'found_out', mo.found_out, 'company_stock', mo.to_company, 'date_approx', mo.date_approx)
          from public.machine_owners mo left join public.customers c on c.id = mo.customer_id
         where mo.machine_id = p_machine) s),
    'timeline', (
      select coalesce(jsonb_agg(t order by t ->> 'day', t ->> 'at'), '[]'::jsonb) from (
        select jsonb_build_object('day', o.order_date, 'kind', 'order', 'title', 'Ordered on order ' || o.order_code,
                                  'detail', (select coalesce(c.company, c.name) from public.customers c where c.id = o.customer_id),
                                  'link', '/orders/' || o.id) t
          from public.orders o where o.id = v_orig
        union all
        select jsonb_build_object('day', (m.created_at at time zone 'America/Halifax')::date, 'at', m.created_at, 'kind', 'order',
                                  'title', 'Entered as an existing machine' || coalesce(' (built ' || case when m.year_approx then 'about ' else '' end || m.year_built || ')', ''),
                                  'detail', m.added_by_name)
          from public.order_machines m where m.id = p_machine and m.origin = 'existing'
        union all
        select jsonb_build_object('day', s.done_on, 'kind', 'build', 'title', initcap(replace(s.step, '_', ' ')) || ' done', 'detail', s.done_by_name)
          from public.machine_steps s where s.machine_id = p_machine
        union all
        select jsonb_build_object('day', (a.at at time zone 'America/Halifax')::date, 'at', a.at, 'kind', 'built', 'title', 'Marked as built',
                                  'detail', a.user_email)
          from public.activity_log a
         where a.table_name = 'order_machines' and a.record_id = p_machine::text and a.changes -> 'ready' ->> 'new' = 'true'
        union all
        select jsonb_build_object('day', (k.started_at at time zone 'America/Halifax')::date, 'at', k.started_at, 'kind', 'check',
                                  'title', case when k.refurb_job_id is not null then 'Final check after refurbishment started' else 'Final check started' end,
                                  'link', case when k.superseded_at is null then '/checklists/' || p_machine end)
          from public.machine_checklists_all k where k.machine_id = p_machine and k.started_at is not null
        union all
        select jsonb_build_object('day', (k.signed_at at time zone 'America/Halifax')::date, 'at', k.signed_at, 'kind', 'check',
                                  'title', case when k.refurb_job_id is not null then 'Final check after refurbishment signed' else 'Final check signed' end,
                                  'detail', k.signed_name, 'link', case when k.superseded_at is null then '/checklists/' || p_machine end)
          from public.machine_checklists_all k where k.machine_id = p_machine and k.signed_at is not null
        union all
        select jsonb_build_object('day', cr.crated_on, 'kind', 'crate', 'title', 'Crated',
                                  'detail', concat_ws(' · ', cr.crated_by,
                                                      round(cr.length_cm) || ' × ' || round(cr.width_cm) || ' × ' || round(cr.height_cm) || ' cm',
                                                      round(cr.weight_kg) || ' kg'))
          from public.crate_machines cm join public.crates cr on cr.id = cm.crate_id
         where cm.machine_id = p_machine and not cr.archived
        union all
        select jsonb_build_object('day', o.actual_ship_date, 'kind', 'ship', 'title', 'Shipped (order ' || o.order_code || ')',
                                  'detail', o.freight_type, 'link', '/orders/' || o.id)
          from public.machine_orders l join public.orders o on o.id = l.order_id
         where l.machine_id = p_machine and l.role in ('original', 'sale') and o.actual_ship_date is not null
           and (l.role = 'original' or l.released_at is null)
        union all
        select jsonb_build_object('day', (l.added_at at time zone 'America/Halifax')::date, 'at', l.added_at, 'kind', 'order',
                                  'title', case l.role when 'sale' then 'Reserved from stock on order ' else 'Listed for service on order ' end || o.order_code
                                           || case when l.released_at is not null then ' (taken off ' || to_char(l.released_at at time zone 'America/Halifax', 'FMMon FMDD, YYYY') || ')' else '' end,
                                  'detail', l.added_by_name, 'link', '/orders/' || o.id)
          from public.machine_orders l join public.orders o on o.id = l.order_id
         where l.machine_id = p_machine and l.role in ('sale', 'service')
        union all
        select jsonb_build_object('day', mo.owned_from, 'at', mo.created_at, 'kind', 'owner',
                                  'title', case mo.how
                                             when 'original' then 'Original owner: '
                                             when 'private_sale' then 'Private sale to '
                                             when 'sold_through_us' then 'Sold to '
                                             when 'gift' then 'Given to '
                                             when 'inheritance' then 'Inherited by '
                                             when 'restructure' then 'Company change: now '
                                             when 'buy_back' then 'Bought back by the company'
                                             else 'Owner changed to ' end
                                           || case when mo.to_company then case when mo.how = 'buy_back' then '' else 'Company stock' end else coalesce(c.company, c.name) end
                                           || case when mo.date_approx then ' (date approximate)' else '' end,
                                  'detail', nullif(concat_ws(' · ', mo.notes, case when mo.found_out is not null then 'We found out: ' || mo.found_out end), ''),
                                  'link', case when mo.order_id is not null then '/orders/' || mo.order_id end)
          from public.machine_owners mo left join public.customers c on c.id = mo.customer_id where mo.machine_id = p_machine
        union all
        select jsonb_build_object('day', j.opened_at::date, 'at', j.opened_at, 'kind', 'refurb',
                                  'title', 'Refurbishment ' || j.job_number || ' started', 'detail', j.opened_by_name,
                                  'link', '/machines/refurb/' || j.id)
          from public.refurb_jobs j where j.machine_id = p_machine
        union all
        select jsonb_build_object('day', (j.completed_at at time zone 'America/Halifax')::date, 'at', j.completed_at, 'kind', 'refurb',
                                  'title', 'Refurbished as ' || j.new_serial || ' (was ' || j.old_serial || ')', 'detail', j.completed_by_name,
                                  'link', '/machines/refurb/' || j.id)
          from public.refurb_jobs j where j.machine_id = p_machine and j.status = 'completed'
        union all
        select jsonb_build_object('day', (j.cancelled_at at time zone 'America/Halifax')::date, 'at', j.cancelled_at, 'kind', 'refurb',
                                  'title', 'Refurbishment ' || j.job_number || ' cancelled', 'detail', j.cancel_reason,
                                  'link', '/machines/refurb/' || j.id)
          from public.refurb_jobs j where j.machine_id = p_machine and j.status = 'cancelled'
        union all
        select jsonb_build_object('day', e.entry_date, 'kind', 'service',
                                  'title', case when e.service_call_id is not null then 'Service visit' when e.kind = 'travel' then 'Travel day' else 'Training / commissioning day' end,
                                  'detail', nullif(concat_ws(' · ', nullif(sem.notes, ''), nullif(e.notes, '')), ''),
                                  'link', case when e.order_id is not null then '/service/' || e.order_id else '/service/calls/' || e.service_call_id end)
          from public.service_entry_machines sem join public.service_entries e on e.id = sem.entry_id
         where sem.machine_id = p_machine and not e.archived
        union all
        select jsonb_build_object('day', coalesce(sc.planned_start, (bc.created_at at time zone 'America/Halifax')::date), 'kind', 'call',
                                  'title', 'Service call S-' || sc.call_number || ': ' || bc.title, 'link', '/service/calls/' || sc.card_id)
          from public.service_call_machines scm join public.service_calls sc on sc.card_id = scm.card_id
          join public.board_cards bc on bc.id = sc.card_id
         where scm.machine_id = p_machine
        union all
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

-- ===========================================================================
-- 5. Reports
-- ===========================================================================
create or replace function public.machine_reports()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_costs boolean := public.has_perm('refurb.costs', 'view');
begin
  perform public.require_perm('reports.machines', 'view');
  return jsonb_build_object(
    'costs_visible', v_costs,
    'buybacks', (select coalesce(jsonb_agg(jsonb_build_object(
                    'machine_id', b.machine_id, 'date', b.bought_on, 'model', mt.name, 'serial', m.serial_number,
                    'from', (select coalesce(nullif(btrim(c.company), ''), c.name) from public.customers c where c.id = b.from_customer_id),
                    'country', (select c.country from public.customers c where c.id = b.from_customer_id),
                    'price_cad', case when v_costs then b.price_cad end, 'reason', b.reason, 'status', m.stock_status)
                    order by b.bought_on desc), '[]'::jsonb)
                   from public.machine_buybacks b join public.order_machines m on m.id = b.machine_id
                   join public.machine_types mt on mt.id = m.machine_type_id),
    'in_progress', (select coalesce(jsonb_agg(jsonb_build_object(
                       'job_id', j.id, 'machine_id', j.machine_id, 'model', mt.name, 'serial', m.serial_number,
                       'opened_at', j.opened_at, 'days_open', (public.halifax_today() - (j.opened_at at time zone 'America/Halifax')::date),
                       'stage', (select s.name from public.board_cards c join public.board_stages s on s.id = c.stage_id where c.id = j.card_id),
                       'cost_so_far', case when v_costs then (public.refurb_cost_summary(j.id) ->> 'total')::numeric end)
                       order by j.opened_at), '[]'::jsonb)
                      from public.refurb_jobs j join public.order_machines m on m.id = j.machine_id
                      join public.machine_types mt on mt.id = m.machine_type_id where j.status = 'open'),
    'by_type', (select coalesce(jsonb_agg(x order by x ->> 'model'), '[]'::jsonb) from (
                   select jsonb_build_object('model', mt.name, 'completed', count(*),
                            'avg_days', round(avg(extract(epoch from (j.completed_at - j.opened_at)) / 86400)::numeric, 1),
                            'avg_hours', round(avg((select coalesce(sum(hours), 0) from public.refurb_labour(j.id)))::numeric, 1),
                            'avg_cost', case when v_costs then round(avg((public.refurb_cost_summary(j.id) ->> 'total')::numeric), 2) end) x
                     from public.refurb_jobs j join public.order_machines m on m.id = j.machine_id
                     join public.machine_types mt on mt.id = m.machine_type_id
                    where j.status = 'completed' group by mt.name) s),
    'profit', case when v_costs then (select coalesce(jsonb_agg(x order by x ->> 'completed_at' desc), '[]'::jsonb) from (
                   select jsonb_build_object('job_id', j.id, 'machine_id', j.machine_id, 'model', mt.name, 'serial', j.new_serial,
                            'completed_at', j.completed_at, 'status', m.stock_status,
                            'total', (cs ->> 'total')::numeric, 'sale', (cs ->> 'sale')::numeric,
                            'profit', (cs ->> 'profit')::numeric, 'margin_pct', (cs ->> 'margin_pct')::numeric) x
                     from public.refurb_jobs j join public.order_machines m on m.id = j.machine_id
                     join public.machine_types mt on mt.id = m.machine_type_id
                     cross join lateral public.refurb_cost_summary(j.id) cs
                    where j.status = 'completed') s) end,
    'by_owner', (select coalesce(jsonb_agg(x order by (x ->> 'machines')::int desc, x ->> 'owner'), '[]'::jsonb) from (
                   select jsonb_build_object('owner', coalesce(coalesce(nullif(btrim(c.company), ''), c.name), case when public.machine_company_owned(m.id) then 'Company stock' else 'Unknown' end),
                                             'customer_id', c.id, 'country', c.country, 'machines', count(*)) x
                     from public.order_machines m
                     left join public.orders o on o.id = m.order_id
                     left join public.customers c on c.id = public.machine_owner_id(m.id)
                    where not m.archived and (m.order_id is null or (not o.archived and o.stage <> 'Cancelled'))
                    group by c.id, c.company, c.name, c.country, public.machine_company_owned(m.id)) s),
    'by_country', (select coalesce(jsonb_agg(x order by (x ->> 'machines')::int desc), '[]'::jsonb) from (
                     select jsonb_build_object('country', coalesce(c.country, case when public.machine_company_owned(m.id) then 'Company stock' else 'Unknown' end),
                                               'machines', count(*)) x
                       from public.order_machines m
                       left join public.orders o on o.id = m.order_id
                       left join public.customers c on c.id = public.machine_owner_id(m.id)
                      where not m.archived and (m.order_id is null or (not o.archived and o.stage <> 'Cancelled'))
                      group by coalesce(c.country, case when public.machine_company_owned(m.id) then 'Company stock' else 'Unknown' end)) s));
end;
$$;

-- Everything the refurbishment page shows that lives on its board (stages,
-- current stage, checklist progress, final check), without needing board access.
create or replace function public.refurb_job_info(p_job uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
begin
  perform public.require_perm('refurb', 'view');
  select * into j from public.refurb_jobs where id = p_job;
  if j.id is null then raise exception 'That refurbishment could not be found.'; end if;
  return jsonb_build_object(
    'job', to_jsonb(j),
    'machine', (select jsonb_build_object('id', m.id, 'serial', m.serial_number, 'machine_type', mt.name, 'condition', m.condition,
                                          'stock_status', m.stock_status, 'refurb_count', m.refurb_count)
                  from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id where m.id = j.machine_id),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'step', s.step) order by s.sort_order), '[]'::jsonb)
                 from public.board_stages s where s.board_id = j.board_id and not s.archived),
    'current_stage', (select s.name from public.board_cards c join public.board_stages s on s.id = c.stage_id where c.id = j.card_id),
    'checklist', (select jsonb_build_object('total', count(i.*), 'done', count(i.*) filter (where i.finished_at is not null))
                    from public.board_checklists l join public.board_checklist_items i on i.checklist_id = l.id where l.card_id = j.card_id),
    'final_check', (select jsonb_build_object('status', case when c.id is null then 'not_started' when c.signed_at is not null then 'signed' else 'in_progress' end,
                                              'signed_name', c.signed_name, 'signed_at', c.signed_at)
                      from (select 1) x left join public.machine_checklists c on c.machine_id = j.machine_id and c.refurb_job_id = j.id),
    'next_serial', case when j.status = 'open' then public.refurb_next_serial(j.machine_id) end,
    'board_closed', (select closed_at is not null from public.boards where id = j.board_id));
end;
$$;

-- ===========================================================================
-- 6. Access lockdown
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
-- Automations internals: the engine, running as another person, and checks about other people.
revoke execute on function public.automation_become(text), public.automation_restore(jsonb),
  public.automation_context(public.automation_events, public.automations), public.automation_order_ctx(uuid), public.automation_card_ctx(uuid),
  public.automation_action(jsonb, jsonb, public.automations), public.automation_try(jsonb, jsonb, public.automations),
  public.automation_run(public.automations, public.automation_events, boolean),
  public.automation_log(public.automations, public.automation_events, text, text, jsonb, jsonb, boolean),
  public.automation_process_event(bigint), public.automation_emit(text, text, uuid, uuid, jsonb, uuid),
  public.automations_tick(), public.automation_tell_owner(public.automations, text),
  public.automation_recipients(jsonb, jsonb, text), public.automation_can_message(text, text),
  public.automation_can_message_target(text, text, text), public.automation_visible_to(jsonb, text),
  public.automation_problems_for(text, jsonb), public.automation_condition(jsonb, jsonb),
  public.automation_level_of(uuid, text) from authenticated;
-- 0056 internals: only through the triggers.
revoke execute on function public.department_managers_fill(), public.department_managers_after() from authenticated;
-- 0057 internals: only through the triggers.
revoke execute on function public.order_machines_lifecycle_check(), public.option_lists_rename_machine(),
  public.order_machines_serial_history_check(), public.order_machines_track_order() from authenticated;
-- 0058 internals.
revoke execute on function public.machine_checklists_refurb_link(), public.refurb_job_open(uuid) from authenticated;
-- 0059 internals.
revoke execute on function public.release_order_machine(uuid), public.orders_stock_machines(),
  public.service_certificates_refurb_notes() from authenticated;
