-- 0057: machine lifecycle, step 1 of 3 – older machines, serial history,
-- ownership changes, stock status and warranty settings.
--
-- A machine is ALWAYS one row in order_machines with a full timeline; nothing
-- is ever deleted.
--
-- 1. order_machines: machines without an order (built before the app), year
--    built, voltage, location, condition, new / used / refurbished, stock status,
--    warranty override. Lifecycle columns change only through the functions.
-- 2. machine_serial_aliases: old serial numbers (a refurbished machine gets
--    <old>-R); every serial, old or new, is unique, and next_serial never
--    hands out an old one again.
-- 3. machine_owners: how the owner changed (original, private sale, sold
--    through us, gift, inheritance, restructure, buy-back), "Company stock"
--    (to_company), approximate dates. machine_owner_id() = the latest owner
--    (null = the company owns it).
-- 4. machine_orders: every order a machine has been on (original order, sold
--    from stock on a later order, listed for service on an order).
-- 5. add_existing_machine(p), import_existing_machines(rows, apply).
-- 6. change_machine_owner(p) (transfer_machine() now calls it).
-- 7. app_settings key machine_lifecycle (warranty months per kind, refurb
--    stages, refurb board sharing, "Refurbished from" note on documents),
--    machine_warranty(machine).
-- 8. machine_list(), customer_machines(), find_machines() for machines without
--    an order and old serials.
-- 9. Access lockdown.

-- ===========================================================================
-- 1. order_machines
-- ===========================================================================
alter table public.order_machines alter column order_id drop not null;
alter table public.order_machines
  add column origin          text not null default 'order' check (origin in ('order', 'existing')),
  add column year_built      integer check (year_built is null or year_built between 1950 and 2100),
  add column year_approx     boolean not null default false,
  add column voltage         text,
  add column location        text check (location is null or char_length(location) <= 200),
  add column condition       text,
  add column item_kind       text not null default 'new' check (item_kind in ('new', 'used', 'refurbished')),
  add column stock_status    text check (stock_status is null or stock_status in ('bought_back', 'in_refurbishment', 'ready_to_sell', 'reserved', 'sold')),
  add column refurb_count    integer not null default 0 check (refurb_count >= 0),
  add column warranty_months integer check (warranty_months is null or warranty_months between 0 and 240),
  add column warranty_start  date,
  add column sale_price      numeric(12, 2) check (sale_price is null or sale_price >= 0),
  add column sale_currency   text check (sale_currency is null or sale_currency in ('CAD', 'USD')),
  add column added_by        text,
  add column added_by_name   text;
-- A machine either comes from an order or was entered as an existing machine.
alter table public.order_machines add constraint order_machines_order_or_existing
  check (order_id is not null or origin = 'existing');

-- Conditions are a dropdown list (Admin → Dropdown lists).
insert into public.option_lists (list_name, value, sort_order) values
  ('machine_condition', 'Like new', 1), ('machine_condition', 'Good', 2), ('machine_condition', 'Fair', 3),
  ('machine_condition', 'Needs repair', 4), ('machine_condition', 'For parts', 5)
on conflict do nothing;

create or replace function public.order_machines_lifecycle_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.condition is not null and not exists (
       select 1 from public.option_lists where list_name = 'machine_condition' and value = new.condition) then
    raise exception 'Choose a condition from the list (Admin → Dropdown lists → Machine condition).' using errcode = '22023';
  end if;
  if new.voltage is not null and not exists (
       select 1 from public.option_lists where list_name = 'voltage' and value = new.voltage) then
    raise exception 'Choose a voltage from the list.' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and not (public.is_system_change() or public.is_service_caller()) then
    if new.order_id is distinct from old.order_id or new.origin is distinct from old.origin
       or new.item_kind is distinct from old.item_kind or new.stock_status is distinct from old.stock_status
       or new.refurb_count is distinct from old.refurb_count then
      raise exception 'Use the machine page to change a machine''s order, stock status or kind.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger order_machines_lifecycle before insert or update on public.order_machines
  for each row execute function public.order_machines_lifecycle_check();

-- Renaming a condition or voltage keeps machines in step.
create or replace function public.option_lists_rename_machine()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.value is distinct from old.value then
    perform public.system_on();
    if new.list_name = 'machine_condition' then
      update public.order_machines set condition = new.value where condition = old.value;
    elsif new.list_name = 'voltage' then
      update public.order_machines set voltage = new.value where voltage = old.value;
    end if;
  end if;
  return null;
end;
$$;
create trigger option_lists_rename_machine after update of value on public.option_lists
  for each row execute function public.option_lists_rename_machine();

-- ===========================================================================
-- 2. Old serial numbers
-- ===========================================================================
create table public.machine_serial_aliases (
  id          uuid primary key default gen_random_uuid(),
  machine_id  uuid not null references public.order_machines (id) on delete cascade,
  serial      text not null unique check (btrim(serial) <> ''),
  replaced_by text not null,
  replaced_on date not null default public.halifax_today(),
  reason      text not null default 'refurbished' check (reason in ('refurbished', 'corrected')),
  created_at  timestamptz not null default now()
);
create index machine_serial_aliases_machine on public.machine_serial_aliases (machine_id);
alter table public.machine_serial_aliases enable row level security;
create policy "Machine page readers" on public.machine_serial_aliases
  for select to authenticated using ((select public.has_perm('machines', 'view')));
grant select on public.machine_serial_aliases to authenticated;
revoke insert, update, delete on public.machine_serial_aliases from authenticated;

-- A serial in use, now or in the past, is never given to another machine.
create or replace function public.order_machines_serial_history_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.serial_number is not null and exists (
       select 1 from public.machine_serial_aliases a where upper(a.serial) = upper(new.serial_number) and a.machine_id <> new.id) then
    raise exception 'Serial % was used before by another machine (it was refurbished and renumbered). Choose another serial.', new.serial_number
      using errcode = '23505';
  end if;
  return new;
end;
$$;
create trigger order_machines_serial_history before insert or update of serial_number on public.order_machines
  for each row execute function public.order_machines_serial_history_check();

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
  loop
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
    exit when not exists (select 1 from public.order_machines x where x.serial_number = v_serial)
          and not exists (select 1 from public.machine_serial_aliases a where upper(a.serial) = upper(v_serial));
  end loop;
  return v_serial;
end;
$$;

-- ===========================================================================
-- 3. Owners
-- ===========================================================================
alter table public.machine_owners alter column customer_id drop not null;
alter table public.machine_owners
  add column to_company  boolean not null default false,
  add column how         text not null default 'transfer'
                         check (how in ('original', 'private_sale', 'sold_through_us', 'gift', 'inheritance', 'restructure',
                                        'buy_back', 'transfer', 'other')),
  add column found_out   text check (found_out is null or char_length(found_out) <= 300),
  add column date_approx boolean not null default false;
alter table public.machine_owners add constraint machine_owners_who check ((customer_id is null) = to_company);

-- The current owner: the latest change, else the original order's customer.
-- Null = the company owns it (bought back, or in stock), or nobody is known.
create or replace function public.machine_owner_id(p_machine uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.machine_owners where machine_id = p_machine)
      then (select customer_id from public.machine_owners where machine_id = p_machine
             order by owned_from desc, created_at desc limit 1)
    else (select o.customer_id from public.order_machines m join public.orders o on o.id = m.order_id where m.id = p_machine)
  end;
$$;

-- Does the company own the machine now?
create or replace function public.machine_company_owned(p_machine uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select to_company from public.machine_owners where machine_id = p_machine
                    order by owned_from desc, created_at desc limit 1), false);
$$;

-- ===========================================================================
-- 4. Orders a machine has been on
-- ===========================================================================
create table public.machine_orders (
  id          uuid primary key default gen_random_uuid(),
  machine_id  uuid not null references public.order_machines (id) on delete cascade,
  order_id    uuid not null references public.orders (id) on delete cascade,
  role        text not null check (role in ('original', 'sale', 'service')),
  added_at    timestamptz not null default now(),
  released_at timestamptz,
  previous_order_id uuid references public.orders (id) on delete set null,
  previous_status   text,
  added_by    text default public.current_user_email(),
  added_by_name text default public.current_user_name()
);
create index machine_orders_machine on public.machine_orders (machine_id);
create index machine_orders_order on public.machine_orders (order_id);
create unique index machine_orders_open_once on public.machine_orders (machine_id, order_id) where released_at is null;
alter table public.machine_orders enable row level security;
create policy "Allowed users read" on public.machine_orders for select to authenticated using ((select public.is_allowed_user()));
grant select on public.machine_orders to authenticated;
revoke insert, update, delete on public.machine_orders from authenticated;

insert into public.machine_orders (machine_id, order_id, role, added_at, added_by, added_by_name)
select m.id, m.order_id, 'original', m.created_at, null, null from public.order_machines m where m.order_id is not null;

create or replace function public.order_machines_track_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_id is not null and coalesce(current_setting('app.machine_moving', true), '') <> 'on' then
    insert into public.machine_orders (machine_id, order_id, role) values (new.id, new.order_id, 'original')
    on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger order_machines_track_order after insert on public.order_machines
  for each row execute function public.order_machines_track_order();

-- ===========================================================================
-- 7. Settings (warranty, refurbishment, documents)
-- ===========================================================================
insert into public.app_settings (key, value) values ('machine_lifecycle', jsonb_build_object(
  'warranty', jsonb_build_object('new', 12, 'refurbished', 6, 'used', 0),
  'refurb_stages', jsonb_build_array(
    jsonb_build_object('name', 'Assessment', 'step', 'other'),
    jsonb_build_object('name', 'Disassembly', 'step', 'other'),
    jsonb_build_object('name', 'Repair / Replace', 'step', 'other'),
    jsonb_build_object('name', 'Sandblasting', 'step', 'sandblasting'),
    jsonb_build_object('name', 'Powder coating', 'step', 'powder_coating'),
    jsonb_build_object('name', 'Assembly', 'step', 'assembly'),
    jsonb_build_object('name', 'Testing / Final check', 'step', 'final_check')),
  'refurb_share_level', 'edit',
  'refurb_note', jsonb_build_object('ce', true, 'commissioning', true)))
on conflict (key) do nothing;

create or replace function public.machine_lifecycle_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.app_settings where key = 'machine_lifecycle'), '{}'::jsonb)
   where public.is_allowed_user() or public.is_service_caller();
$$;

create or replace function public.set_machine_lifecycle_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := public.machine_lifecycle_settings();
  s jsonb;
  k text;
begin
  perform public.require_admin_area('machine_lifecycle');
  if p ? 'warranty' then
    foreach k in array array['new', 'refurbished', 'used'] loop
      if not (p -> 'warranty' ? k) or jsonb_typeof(p -> 'warranty' -> k) <> 'number'
         or (p -> 'warranty' ->> k)::numeric not between 0 and 240 then
        raise exception 'Enter the warranty in months (0 to 240) for new, refurbished and used machines.' using errcode = '22023';
      end if;
    end loop;
    v := v || jsonb_build_object('warranty', p -> 'warranty');
  end if;
  if p ? 'refurb_stages' then
    if jsonb_typeof(p -> 'refurb_stages') <> 'array' or jsonb_array_length(p -> 'refurb_stages') = 0 then
      raise exception 'Keep at least one refurbishment stage.' using errcode = '22023';
    end if;
    for s in select value from jsonb_array_elements(p -> 'refurb_stages') loop
      if coalesce(btrim(s ->> 'name'), '') = '' then
        raise exception 'Every refurbishment stage needs a name.' using errcode = '22023';
      end if;
      if coalesce(s ->> 'step', 'other') not in ('other', 'sandblasting', 'powder_coating', 'assembly', 'final_check') then
        raise exception 'Unknown kind of stage: %.', s ->> 'step' using errcode = '22023';
      end if;
    end loop;
    v := v || jsonb_build_object('refurb_stages', p -> 'refurb_stages');
  end if;
  if p ? 'refurb_share_level' then
    if p ->> 'refurb_share_level' not in ('none', 'view', 'edit') then
      raise exception 'Choose who can open refurbishment boards.' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('refurb_share_level', p ->> 'refurb_share_level');
  end if;
  if p ? 'refurb_note' then
    v := v || jsonb_build_object('refurb_note', jsonb_build_object(
      'ce', coalesce((p -> 'refurb_note' ->> 'ce')::boolean, true),
      'commissioning', coalesce((p -> 'refurb_note' ->> 'commissioning')::boolean, true)));
  end if;
  insert into public.app_settings (key, value) values ('machine_lifecycle', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'machine_lifecycle', null, p);
  return v;
end;
$$;

-- Warranty of one machine: kind, months, start and end (null end = no warranty).
-- Start: the machine's own start date, else the ship date of the order it was
-- last sold on.
create or replace function public.machine_warranty(p_machine uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m public.order_machines;
  v_months integer;
  v_start date;
begin
  select * into m from public.order_machines where id = p_machine;
  if m.id is null then return null; end if;
  v_months := coalesce(m.warranty_months,
                       (public.machine_lifecycle_settings() -> 'warranty' ->> m.item_kind)::integer, 0);
  v_start := coalesce(m.warranty_start, (select o.actual_ship_date from public.orders o where o.id = m.order_id));
  return jsonb_build_object(
    'kind', m.item_kind, 'months', v_months, 'start', v_start,
    'end', case when v_months > 0 and v_start is not null then (v_start + make_interval(months => v_months))::date end,
    'custom', m.warranty_months is not null or m.warranty_start is not null);
end;
$$;

-- ===========================================================================
-- 5. Older machines (built before the app)
-- ===========================================================================
-- p: {machine_type_id, serial_number, year_built, year_approx, voltage,
--     original_customer_id, original_date, current: 'same' | 'company' | customer id,
--     current_since, location, condition, notes, item_kind (new | used | refurbished),
--     warranty_months, warranty_start}
create or replace function public.add_existing_machine(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type    uuid := nullif(p ->> 'machine_type_id', '')::uuid;
  v_serial  text := upper(nullif(btrim(p ->> 'serial_number'), ''));
  v_year    integer := nullif(p ->> 'year_built', '')::integer;
  v_orig    uuid := nullif(p ->> 'original_customer_id', '')::uuid;
  v_current text := coalesce(nullif(p ->> 'current', ''), 'same');
  v_since   date := nullif(p ->> 'current_since', '')::date;
  v_from    date;
  v_id      uuid;
begin
  perform public.require_perm('machines.add_existing');
  if v_type is null or not exists (select 1 from public.machine_types where id = v_type) then
    raise exception 'Choose the machine type.' using errcode = '22023';
  end if;
  if v_serial is null then
    raise exception 'Enter the serial number.' using errcode = '22023';
  end if;
  if exists (select 1 from public.order_machines where upper(serial_number) = v_serial) then
    raise exception 'Serial % is already in the app.', v_serial using errcode = '23505';
  end if;
  if exists (select 1 from public.machine_serial_aliases where upper(serial) = v_serial) then
    raise exception 'Serial % was used before by a machine that was refurbished and renumbered.', v_serial using errcode = '23505';
  end if;
  if v_orig is not null and not exists (select 1 from public.customers where id = v_orig) then
    raise exception 'That customer could not be found.';
  end if;
  v_from := coalesce(nullif(p ->> 'original_date', '')::date, make_date(coalesce(v_year, extract(year from public.halifax_today())::integer), 1, 1));

  perform public.system_on();
  insert into public.order_machines (order_id, machine_type_id, serial_number, serial_manual, ready, checklist_done, needs_crate,
                                     origin, year_built, year_approx, voltage, location, condition, notes, item_kind,
                                     stock_status, warranty_months, warranty_start, added_by, added_by_name)
  values (null, v_type, v_serial, true, true, false, false, 'existing', v_year, coalesce((p ->> 'year_approx')::boolean, false),
          nullif(p ->> 'voltage', ''), nullif(btrim(p ->> 'location'), ''), nullif(p ->> 'condition', ''),
          nullif(btrim(p ->> 'notes'), ''), coalesce(nullif(p ->> 'item_kind', ''), 'new'),
          case when v_current = 'company' then 'ready_to_sell' end,
          nullif(p ->> 'warranty_months', '')::integer, nullif(p ->> 'warranty_start', '')::date,
          public.current_user_email(), public.current_user_name())
  returning id into v_id;

  if v_orig is not null then
    insert into public.machine_owners (machine_id, customer_id, owned_from, how, date_approx, notes)
    values (v_id, v_orig, v_from, 'original', nullif(p ->> 'original_date', '') is null, 'Entered as an existing machine');
  end if;
  if v_current = 'company' then
    insert into public.machine_owners (machine_id, customer_id, to_company, owned_from, how, date_approx, notes)
    values (v_id, null, true, coalesce(v_since, public.halifax_today()), 'other', v_since is null, 'Company stock when entered');
  elsif v_current <> 'same' then
    if not exists (select 1 from public.customers where id = v_current::uuid) then
      raise exception 'The current owner could not be found.';
    end if;
    if v_current::uuid is distinct from v_orig then
      insert into public.machine_owners (machine_id, customer_id, owned_from, how, date_approx, notes)
      values (v_id, v_current::uuid, coalesce(v_since, greatest(v_from, public.halifax_today())), 'transfer', v_since is null,
              'Owner when entered');
    end if;
  end if;
  perform set_config('app.system_change', '', true);
  return v_id;
end;
$$;

-- Bulk import: rows [{serial_number, machine_type (name or code), year_built,
-- year_approx, voltage, original_customer (name / company), current_owner
-- (name / company, or "Company"), location, condition, notes}]. With apply =
-- false nothing is saved: each row comes back with its matches and problems.
create or replace function public.import_existing_machines(p_rows jsonb, p_apply boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r       jsonb;
  i       integer := 0;
  v_out   jsonb := '[]'::jsonb;
  v_type  uuid;
  v_orig  uuid;
  v_cur   text;
  v_prob  text[];
  v_seen  text[] := '{}';
  v_serial text;
  v_ok    integer := 0;
  v_name  text;
begin
  perform public.require_perm('machines.import');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2000 machines at a time.' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_prob := '{}';
    v_serial := upper(nullif(btrim(r ->> 'serial_number'), ''));
    select id into v_type from public.machine_types t
     where not t.archived and (lower(t.name) = lower(btrim(r ->> 'machine_type')) or lower(coalesce(t.code, '')) = lower(btrim(r ->> 'machine_type'))
                               or t.id::text = r ->> 'machine_type_id')
     order by (t.id::text = r ->> 'machine_type_id') desc limit 1;
    v_name := nullif(btrim(r ->> 'original_customer'), '');
    v_orig := case when nullif(r ->> 'original_customer_id', '') is not null then (r ->> 'original_customer_id')::uuid
                   else (select c.id from public.customers c where not c.archived and v_name is not null
                          and (lower(c.name) = lower(v_name) or lower(coalesce(c.company, '')) = lower(v_name)) limit 1) end;
    v_name := nullif(btrim(r ->> 'current_owner'), '');
    v_cur := case when nullif(r ->> 'current_owner_id', '') is not null then r ->> 'current_owner_id'
                  when v_name is null then 'same'
                  when lower(v_name) in ('company', 'company stock', 'us', 'stock') then 'company'
                  else (select c.id::text from public.customers c where not c.archived
                         and (lower(c.name) = lower(v_name) or lower(coalesce(c.company, '')) = lower(v_name)) limit 1) end;
    if v_serial is null then v_prob := v_prob || 'No serial number.'::text; end if;
    if v_type is null then v_prob := v_prob || ('Unknown machine type "' || coalesce(r ->> 'machine_type', '') || '".'); end if;
    if v_serial = any (v_seen) then v_prob := v_prob || 'This serial is in the file twice.'::text; end if;
    if exists (select 1 from public.order_machines where upper(serial_number) = v_serial)
       or exists (select 1 from public.machine_serial_aliases where upper(serial) = v_serial) then
      v_prob := v_prob || 'This serial is already in the app.'::text;
    end if;
    if nullif(btrim(r ->> 'original_customer'), '') is not null and v_orig is null then
      v_prob := v_prob || ('Original customer "' || (r ->> 'original_customer') || '" not found.');
    end if;
    if v_cur is null then v_prob := v_prob || ('Current owner "' || (r ->> 'current_owner') || '" not found.'); end if;
    if nullif(r ->> 'year_built', '') is not null and (r ->> 'year_built') !~ '^\d{4}$' then
      v_prob := v_prob || 'The year built is not a year.'::text;
    end if;
    if nullif(r ->> 'condition', '') is not null and not exists (select 1 from public.option_lists where list_name = 'machine_condition' and value = r ->> 'condition') then
      v_prob := v_prob || ('Unknown condition "' || (r ->> 'condition') || '".');
    end if;
    if nullif(r ->> 'voltage', '') is not null and not exists (select 1 from public.option_lists where list_name = 'voltage' and value = r ->> 'voltage') then
      v_prob := v_prob || ('Unknown voltage "' || (r ->> 'voltage') || '".');
    end if;
    v_seen := v_seen || v_serial;
    if p_apply and cardinality(v_prob) = 0 then
      perform public.add_existing_machine(jsonb_build_object(
        'machine_type_id', v_type, 'serial_number', v_serial, 'year_built', nullif(r ->> 'year_built', ''),
        'year_approx', coalesce((r ->> 'year_approx')::boolean, false), 'voltage', nullif(r ->> 'voltage', ''),
        'original_customer_id', v_orig, 'current', v_cur, 'location', r ->> 'location',
        'condition', nullif(r ->> 'condition', ''), 'notes', r ->> 'notes', 'item_kind', 'new'));
      v_ok := v_ok + 1;
    end if;
    v_out := v_out || jsonb_build_object('row', i, 'serial', v_serial, 'machine_type_id', v_type,
                                         'original_customer_id', v_orig, 'current', v_cur, 'problems', to_jsonb(v_prob));
  end loop;
  if p_apply then
    perform public.log_admin_action('order_machines', 'import', null, jsonb_build_object('imported', v_ok, 'rows', i));
  end if;
  return jsonb_build_object('rows', v_out, 'imported', v_ok);
end;
$$;

-- ===========================================================================
-- 6. Ownership changes
-- ===========================================================================
-- p: {machine_id, how (private_sale | sold_through_us | gift | inheritance |
--     restructure | other), customer_id | new_customer {...}, date, date_approx,
--     found_out, notes, order_id (required for sold_through_us)}
create or replace function public.change_machine_owner(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_machine  uuid := (p ->> 'machine_id')::uuid;
  v_how      text := coalesce(nullif(p ->> 'how', ''), 'private_sale');
  v_customer uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_new      jsonb := p -> 'new_customer';
  v_date     date := coalesce(nullif(p ->> 'date', '')::date, public.halifax_today());
  v_order    uuid := nullif(p ->> 'order_id', '')::uuid;
  v_first    date;
  v_id       uuid;
begin
  perform public.require_perm('machines.transfer');
  if v_how not in ('private_sale', 'sold_through_us', 'gift', 'inheritance', 'restructure', 'transfer', 'other') then
    raise exception 'Choose how the owner changed.' using errcode = '22023';
  end if;
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
  select least((select o.order_date from public.machine_orders mo join public.orders o on o.id = mo.order_id
                 where mo.machine_id = v_machine and mo.role = 'original' limit 1),
               (select min(owned_from) from public.machine_owners where machine_id = v_machine))
    into v_first;
  if v_date < v_first then
    raise exception 'The date cannot be before the machine''s first owner (%).', to_char(v_first, 'FMMon FMDD, YYYY') using errcode = '22023';
  end if;
  if v_customer = public.machine_owner_id(v_machine) and not public.machine_company_owned(v_machine) then
    raise exception 'That customer already owns this machine.' using errcode = '22023';
  end if;
  if v_how = 'sold_through_us' and v_order is null then
    raise exception 'Choose the order the machine was sold on.' using errcode = '22023';
  end if;
  if v_order is not null and not exists (select 1 from public.orders where id = v_order) then
    raise exception 'That order could not be found.';
  end if;
  insert into public.machine_owners (machine_id, customer_id, owned_from, order_id, notes, how, found_out, date_approx)
  values (v_machine, v_customer, v_date, v_order, nullif(btrim(p ->> 'notes'), ''), v_how,
          nullif(btrim(p ->> 'found_out'), ''), coalesce((p ->> 'date_approx')::boolean, false))
  returning id into v_id;
  -- A machine that leaves the company is no longer stock.
  perform public.system_on();
  update public.order_machines set stock_status = case when stock_status is not null then 'sold' end
   where id = v_machine and stock_status is not null and stock_status <> 'sold';
  perform set_config('app.system_change', '', true);
  return v_id;
end;
$$;

-- The 9S function keeps working (Transfer / Resold).
create or replace function public.transfer_machine(p jsonb)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.change_machine_owner(p || jsonb_build_object('how', case when nullif(p ->> 'order_id', '') is not null then 'sold_through_us' else 'transfer' end));
$$;

-- ===========================================================================
-- 8. Lists and look-ups
-- ===========================================================================
drop function if exists public.machine_list();
create or replace function public.machine_list()
returns table (machine_id uuid, serial text, model text, code text, customer text, country text,
               order_id uuid, order_code text, order_number integer, stage text, built boolean, check_signed boolean,
               origin text, item_kind text, stock_status text, condition text, location text, company_owned boolean,
               old_serials text, year_built integer, machine_type_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.serial_number, mt.name, mt.code,
         coalesce(nullif(btrim(c.company), ''), c.name), c.country,
         o.id, o.order_code, o.order_number, o.stage, m.ready, coalesce(m.checklist_done, false),
         m.origin, m.item_kind, m.stock_status, m.condition, m.location, public.machine_company_owned(m.id),
         (select string_agg(a.serial, ' ') from public.machine_serial_aliases a where a.machine_id = m.id),
         m.year_built, m.machine_type_id
    from public.order_machines m
    left join public.orders o on o.id = m.order_id
    join public.machine_types mt on mt.id = m.machine_type_id
    left join public.customers c on c.id = public.machine_owner_id(m.id)
   where public.has_perm('machines', 'view') and not m.archived and not coalesce(o.archived, false)
   order by o.order_number desc nulls last, m.serial_number nulls last;
$$;

create or replace function public.customer_machines(p_customer uuid)
returns table (machine_id uuid, machine text, serial text, order_id uuid, order_code text, order_date date)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, mt.name, m.serial_number, o.id, o.order_code, o.order_date
    from public.order_machines m
    left join public.orders o on o.id = m.order_id
    join public.machine_types mt on mt.id = m.machine_type_id
   where not m.archived
     and public.machine_owner_id(m.id) = p_customer
     and public.has_perm('service.calls')
   order by o.order_date desc nulls last, o.order_code, mt.name, m.serial_number;
$$;

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
    left join public.orders o on o.id = m.order_id
    join public.machine_types mt on mt.id = m.machine_type_id
   where public.has_perm('machines')
     and length(btrim(coalesce(p_query, ''))) >= 2
     and (m.serial_number ilike '%' || btrim(p_query) || '%' or mt.name ilike '%' || btrim(p_query) || '%'
          or exists (select 1 from public.machine_serial_aliases a where a.machine_id = m.id and a.serial ilike '%' || btrim(p_query) || '%'))
   order by m.serial_number nulls last
   limit 30;
$$;

-- Edit the details of a machine (year, voltage, location, condition, notes, warranty).
create or replace function public.save_machine_details(p_machine uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_any_perm(array['machines.add_existing', 'machines.stock'], 'edit');
  if not exists (select 1 from public.order_machines where id = p_machine) then
    raise exception 'That machine could not be found.';
  end if;
  update public.order_machines set
    year_built = case when p ? 'year_built' then nullif(p ->> 'year_built', '')::integer else year_built end,
    year_approx = case when p ? 'year_approx' then coalesce((p ->> 'year_approx')::boolean, false) else year_approx end,
    voltage = case when p ? 'voltage' then nullif(p ->> 'voltage', '') else voltage end,
    location = case when p ? 'location' then nullif(btrim(p ->> 'location'), '') else location end,
    condition = case when p ? 'condition' then nullif(p ->> 'condition', '') else condition end,
    warranty_months = case when p ? 'warranty_months' then nullif(p ->> 'warranty_months', '')::integer else warranty_months end,
    warranty_start = case when p ? 'warranty_start' then nullif(p ->> 'warranty_start', '')::date else warranty_start end
  where id = p_machine;
end;
$$;

-- ===========================================================================
-- 9. Access lockdown
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
