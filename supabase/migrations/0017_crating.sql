-- 0017_crating.sql
-- Crating: the crates each machine ships in, so we build up data over time
-- (sizes, weights, plywood and hours per machine type).
--
-- 1. user_preferences: each person's choice of units (Imperial or Metric).
-- 2. crates: one row per physical crate. Everything is stored in METRIC
--    (cm, kg); the app converts for display. Archived instead of deleted.
-- 3. crate_machines: which machines are in which crate. A crate can hold
--    several machines of the same order (so its weight and plywood are
--    counted once), and a machine can need several crates.
-- 4. save_crate() / uncrate_machine(): save a crate and its machines in one step.
-- 5. Views: machine_crating (is each machine crated?) and crate_report
--    (one row per crate with order, customer and contents).

-- ===========================================================================
-- 1. user_preferences
-- ===========================================================================
create table public.user_preferences (
  user_email text primary key default public.current_user_email()
             references public.allowed_users (email) on delete cascade on update cascade,
  units      text not null default 'imperial' check (units in ('imperial', 'metric')),
  updated_at timestamptz not null default now()
);
alter table public.user_preferences enable row level security;
create trigger user_preferences_updated_at before update on public.user_preferences
  for each row execute function public.set_updated_at();

create policy "People manage their own preferences" on public.user_preferences
  for all to authenticated
  using (user_email = (select public.current_user_email()) and (select public.is_allowed_user()))
  with check (user_email = (select public.current_user_email()) and (select public.is_allowed_user()));

-- Save my units choice ('imperial' or 'metric').
create or replace function public.set_my_units(p_units text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_units not in ('imperial', 'metric') then
    raise exception 'Units must be imperial or metric.';
  end if;
  insert into public.user_preferences (user_email, units)
  values (public.current_user_email(), p_units)
  on conflict (user_email) do update set units = excluded.units;
end;
$$;

-- ===========================================================================
-- 2. crates (all sizes in cm, weights in kg)
-- ===========================================================================
create table public.crates (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders (id) on delete cascade,
  length_cm      numeric(9, 3) check (length_cm > 0),
  width_cm       numeric(9, 3) check (width_cm > 0),
  height_cm      numeric(9, 3) check (height_cm > 0),
  weight_kg      numeric(10, 3) check (weight_kg > 0),
  plywood_sheets numeric(6, 2) check (plywood_sheets >= 0),
  build_hours    numeric(6, 2) check (build_hours >= 0),
  crated_on      date not null default (now() at time zone 'America/Halifax')::date,
  crated_by      text,
  notes          text,
  archived       boolean not null default false,
  archived_at    timestamptz,
  archived_by    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index crates_order_idx on public.crates (order_id);
create index crates_crated_on_idx on public.crates (crated_on);
alter table public.crates enable row level security;

create trigger crates_updated_at before update on public.crates
  for each row execute function public.set_updated_at();
create trigger crates_archived_info before insert or update of archived on public.crates
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.crates
  for each row execute function public.log_activity();

-- Staff and admins: read, add, edit (and archive). Admins only: delete.
create policy "Allowed users can read" on public.crates
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Allowed users can add" on public.crates
  for insert to authenticated with check ((select public.is_allowed_user()));
create policy "Allowed users can edit" on public.crates
  for update to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));
create policy "Admins can delete" on public.crates
  for delete to authenticated using ((select public.is_admin()));

-- ===========================================================================
-- 3. crate_machines: which machines are in which crate
-- ===========================================================================
create table public.crate_machines (
  crate_id   uuid not null references public.crates (id) on delete cascade,
  machine_id uuid not null references public.order_machines (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (crate_id, machine_id)
);
create index crate_machines_machine_idx on public.crate_machines (machine_id);
alter table public.crate_machines enable row level security;

-- These are just links (the crate itself is archived, never lost), so
-- staff may add and remove them.
create policy "Allowed users can do everything" on public.crate_machines
  for all to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));

-- ===========================================================================
-- 4. save_crate / uncrate_machine
-- ===========================================================================

-- Adds a new crate (no "id") or updates one, and sets which machines are in it.
-- p_crate: { id?, order_id, machine_ids: [uuid…], length_cm, width_cm,
--            height_cm, weight_kg, plywood_sheets, build_hours, crated_on,
--            crated_by, notes }. Empty values are saved as empty.
-- Returns the crate's id.
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

-- "Not crated" for one machine: crates holding only this machine are archived;
-- shared crates keep their other machines and just lose this one.
-- Returns how many crates were archived.
create or replace function public.uncrate_machine(p_machine_id uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_archived integer;
begin
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

-- ===========================================================================
-- 5. Views
-- ===========================================================================

-- One row per (not archived) machine: how many crates it is in.
create view public.machine_crating
with (security_invoker = true)
as
select
  om.id       as machine_id,
  om.order_id,
  count(c.id)::integer as crate_count
from public.order_machines om
left join public.crate_machines cm on cm.machine_id = om.id
left join public.crates c on c.id = cm.crate_id and not c.archived and c.order_id = om.order_id
where not om.archived
group by om.id, om.order_id;

-- One row per (not archived) crate, with its order, customer and contents.
-- machine_types lists one name per machine in the crate (a crate with two
-- pickers lists "Picker" twice).
create view public.crate_report
with (security_invoker = true)
as
select
  c.id,
  c.order_id,
  o.order_code,
  o.order_number,
  o.split_number,
  o.stage,
  cu.name    as customer_name,
  cu.company as customer_company,
  cu.country as customer_country,
  c.length_cm,
  c.width_cm,
  c.height_cm,
  c.weight_kg,
  c.plywood_sheets,
  c.build_hours,
  c.crated_on,
  c.crated_by,
  c.notes,
  c.created_at,
  coalesce(m.machine_ids, '{}')      as machine_ids,
  coalesce(m.machine_type_ids, '{}') as machine_type_ids,
  coalesce(m.machine_types, '{}')    as machine_types,
  coalesce(m.serials, '{}')          as serials
from public.crates c
join public.orders o on o.id = c.order_id
join public.customers cu on cu.id = o.customer_id
left join lateral (
  select
    array_agg(om.id              order by mt.name, om.serial_number) as machine_ids,
    array_agg(om.machine_type_id order by mt.name, om.serial_number) as machine_type_ids,
    array_agg(mt.name            order by mt.name, om.serial_number) as machine_types,
    array_agg(om.serial_number   order by mt.name, om.serial_number)
      filter (where om.serial_number is not null)                    as serials
  from public.crate_machines cm
  join public.order_machines om on om.id = cm.machine_id and om.order_id = c.order_id and not om.archived
  join public.machine_types mt on mt.id = om.machine_type_id
  where cm.crate_id = c.id
) m on true
where not c.archived
  and not o.archived;

-- Same access lockdown as before for the new tables, views and functions.
revoke all on public.user_preferences, public.crates, public.crate_machines,
              public.machine_crating, public.crate_report from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
