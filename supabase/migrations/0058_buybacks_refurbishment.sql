-- 0058: machine lifecycle, step 2 of 3 – buy-backs and refurbishment.
--
-- 1. machine_buybacks + record_buyback(p): the machine moves to Company stock
--    with status "Bought back"; freight in links to incoming_shipments.
-- 2. set_machine_stock(machine, p): status (Bought back / Ready to sell),
--    location, condition, sale price.
-- 3. Final checks per refurbishment: machine_checklists becomes a view of the
--    current checklists over machine_checklists_all; a refurbishment marks the
--    previous checklist superseded (kept, still on the timeline).
-- 4. Refurbishment jobs: refurb_jobs (one open job per machine, its own board
--    with purpose 'refurb' and the stages from Admin → Machine Lifecycle),
--    refurb_notes (work done per stage), refurb_parts, refurb_costs,
--    refurb_checklist_items (template per machine type and stage).
-- 5. open_refurb_job, save_refurb_note / part / cost, archive_refurb_item,
--    set_refurb_conditions, complete_refurb_job (new serial <old>-R, -R2 …,
--    the old serial kept as an alias), cancel_refurb_job.
-- 6. refurb_cost_summary(job): buy-back + parts + labour (hours from the board's
--    timers; cost with pay rates only with payroll.pay) + outside costs +
--    freight in = total; sale price → profit and margin (refurb.costs).
-- 7. Access lockdown.

-- ===========================================================================
-- 1. Buy-backs
-- ===========================================================================
alter table public.order_machines add column sale_exchange_rate numeric(10, 4) not null default 1 check (sale_exchange_rate > 0);

create table public.machine_buybacks (
  id                   uuid primary key default gen_random_uuid(),
  machine_id           uuid not null references public.order_machines (id) on delete cascade,
  from_customer_id     uuid references public.customers (id),
  bought_on            date not null,
  price                numeric(12, 2) not null default 0 check (price >= 0),
  currency             text not null default 'CAD' check (currency in ('CAD', 'USD')),
  exchange_rate        numeric(10, 4) not null default 1 check (exchange_rate > 0),
  price_cad            numeric(12, 2) generated always as (round(price * exchange_rate, 2)) stored,
  condition_on_arrival text,
  reason               text check (reason is null or char_length(reason) <= 1000),
  arranged_by          text references public.allowed_users (email) on update cascade on delete set null,
  incoming_shipment_id uuid references public.incoming_shipments (id) on delete set null,
  notes                text check (notes is null or char_length(notes) <= 2000),
  created_by           text default public.current_user_email(),
  created_by_name      text default public.current_user_name(),
  created_at           timestamptz not null default now()
);
create index machine_buybacks_machine on public.machine_buybacks (machine_id, bought_on);
alter table public.machine_buybacks enable row level security;
-- Prices only with "See refurbishment costs"; the rest of the machine page reads through machine_details().
create policy "Refurb cost readers" on public.machine_buybacks for select to authenticated
  using ((select public.has_perm('refurb.costs', 'view')) or (select public.has_perm('machines.buyback', 'view')));
grant select on public.machine_buybacks to authenticated;
revoke insert, update, delete on public.machine_buybacks from authenticated;
create trigger log_activity after insert or update or delete on public.machine_buybacks
  for each row execute function public.log_activity();

-- p: {machine_id, date, price, currency, exchange_rate, condition, reason,
--     arranged_by, incoming_shipment_id, location, notes}
create or replace function public.record_buyback(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_machine uuid := (p ->> 'machine_id')::uuid;
  v_date    date := coalesce(nullif(p ->> 'date', '')::date, public.halifax_today());
  v_from    uuid;
  v_id      uuid;
  v_cur     text := coalesce(nullif(p ->> 'currency', ''), 'CAD');
begin
  perform public.require_perm('machines.buyback');
  if not exists (select 1 from public.order_machines where id = v_machine and not archived) then
    raise exception 'That machine could not be found.';
  end if;
  if public.machine_company_owned(v_machine) then
    raise exception 'The company already owns this machine.' using errcode = '22023';
  end if;
  if exists (select 1 from public.refurb_jobs where machine_id = v_machine and status = 'open') then
    raise exception 'This machine is being refurbished.' using errcode = '22023';
  end if;
  if nullif(p ->> 'condition', '') is not null and not exists (
       select 1 from public.option_lists where list_name = 'machine_condition' and value = p ->> 'condition') then
    raise exception 'Choose a condition from the list.' using errcode = '22023';
  end if;
  if nullif(p ->> 'incoming_shipment_id', '') is not null and not exists (
       select 1 from public.incoming_shipments where id = (p ->> 'incoming_shipment_id')::uuid) then
    raise exception 'That incoming shipment could not be found.';
  end if;
  v_from := public.machine_owner_id(v_machine);
  insert into public.machine_buybacks (machine_id, from_customer_id, bought_on, price, currency, exchange_rate, condition_on_arrival,
                                       reason, arranged_by, incoming_shipment_id, notes)
  values (v_machine, v_from, v_date, coalesce(nullif(p ->> 'price', '')::numeric, 0), v_cur,
          case when v_cur = 'CAD' then 1 else coalesce(nullif(p ->> 'exchange_rate', '')::numeric,
                                                       (select (value ->> 'exchange_rate')::numeric from public.app_settings where key = 'freight'), 1) end,
          nullif(p ->> 'condition', ''), nullif(btrim(p ->> 'reason'), ''), nullif(lower(btrim(p ->> 'arranged_by')), ''),
          nullif(p ->> 'incoming_shipment_id', '')::uuid, nullif(btrim(p ->> 'notes'), ''))
  returning id into v_id;
  insert into public.machine_owners (machine_id, customer_id, to_company, owned_from, how, notes)
  values (v_machine, null, true, v_date, 'buy_back', nullif(btrim(p ->> 'reason'), ''));
  perform public.system_on();
  update public.order_machines
     set stock_status = 'bought_back',
         condition = coalesce(nullif(p ->> 'condition', ''), condition),
         location = coalesce(nullif(btrim(p ->> 'location'), ''), location, 'Company stock'),
         sale_price = null, sale_currency = null
   where id = v_machine;
  perform set_config('app.system_change', '', true);
  return v_id;
end;
$$;

-- ===========================================================================
-- 2. Stock
-- ===========================================================================
-- p: {status ('bought_back' | 'ready_to_sell'), location, condition,
--     sale_price, sale_currency, sale_exchange_rate}
create or replace function public.set_machine_stock(p_machine uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.order_machines;
begin
  perform public.require_perm('machines.stock');
  select * into m from public.order_machines where id = p_machine;
  if m.id is null then raise exception 'That machine could not be found.'; end if;
  if p ? 'status' then
    if not public.machine_company_owned(p_machine) then
      raise exception 'Only machines the company owns are stock.' using errcode = '22023';
    end if;
    if p ->> 'status' not in ('bought_back', 'ready_to_sell') or m.stock_status in ('reserved', 'in_refurbishment') then
      raise exception 'A reserved machine or one in refurbishment changes status by itself.' using errcode = '22023';
    end if;
  end if;
  if (p ? 'sale_price') then
    perform public.require_perm('refurb.costs', 'view');
  end if;
  perform public.system_on();
  update public.order_machines set
    stock_status = case when p ? 'status' then p ->> 'status' else stock_status end,
    location = case when p ? 'location' then nullif(btrim(p ->> 'location'), '') else location end,
    condition = case when p ? 'condition' then nullif(p ->> 'condition', '') else condition end,
    sale_price = case when p ? 'sale_price' then nullif(p ->> 'sale_price', '')::numeric else sale_price end,
    sale_currency = case when p ? 'sale_price' then coalesce(nullif(p ->> 'sale_currency', ''), 'CAD') else sale_currency end,
    sale_exchange_rate = case when p ? 'sale_price' then
                           case when coalesce(nullif(p ->> 'sale_currency', ''), 'CAD') = 'CAD' then 1
                                else coalesce(nullif(p ->> 'sale_exchange_rate', '')::numeric, (select (value ->> 'exchange_rate')::numeric from public.app_settings where key = 'freight'), 1) end
                         else sale_exchange_rate end
  where id = p_machine;
  perform set_config('app.system_change', '', true);
end;
$$;

-- ===========================================================================
-- 3. Final checks per refurbishment
-- ===========================================================================
drop view if exists public.order_machine_status;
drop view if exists public.machine_checklist_status;
alter table public.machine_checklists rename to machine_checklists_all;
alter table public.machine_checklists_all alter column order_id drop not null;
alter table public.machine_checklists_all
  add column superseded_at timestamptz,
  add column refurb_job_id uuid;
alter table public.machine_checklists_all drop constraint machine_checklists_machine_id_key;
create unique index machine_checklists_current on public.machine_checklists_all (machine_id) where superseded_at is null;

create view public.machine_checklists with (security_invoker = true) as
  select * from public.machine_checklists_all where superseded_at is null;
grant select, insert, update, delete on public.machine_checklists to authenticated;
grant select, insert, update, delete on public.machine_checklists to service_role;

create view public.machine_checklist_status as
 SELECT om.id AS machine_id, om.order_id, om.serial_number, mt.name AS machine_type, om.ready,
    c.id AS checklist_id, c.started_at, c.started_by_name, c.last_worked_at, c.last_worked_by_name, c.signed_at, c.signed_name,
    COALESCE(i.total, (0)::bigint) AS total_items, COALESCE(i.done, (0)::bigint) AS done_items, COALESCE(i.na, (0)::bigint) AS na_items,
    CASE WHEN (c.id IS NULL) THEN 'not_started'::text WHEN (c.signed_at IS NOT NULL) THEN 'signed'::text ELSE 'in_progress'::text END AS status
   FROM order_machines om
     JOIN machine_types mt ON mt.id = om.machine_type_id
     LEFT JOIN machine_checklists c ON c.machine_id = om.id
     LEFT JOIN LATERAL (SELECT count(*) AS total, count(*) FILTER (WHERE x.status = 'done') AS done, count(*) FILTER (WHERE x.status = 'na') AS na
                          FROM machine_checklist_items x WHERE x.checklist_id = c.id) i ON true
  WHERE NOT om.archived;
grant select on public.machine_checklist_status to authenticated;

-- (order_machine_status is recreated in 0059 with the machine's kind.)
create view public.order_machine_status as
 SELECT om.id, om.order_id, om.machine_type_id, mt.name AS machine_type,
    COALESCE(NULLIF(btrim(mt.short_name), ''), mt.name) AS short_name, om.serial_number, om.ready, om.checklist_done,
    COALESCE(mc.crate_count, 0) AS crate_count, om.created_at, cs.status AS checklist_status, cs.total_items AS checklist_total,
    (cs.done_items + cs.na_items) AS checklist_completed, om.needs_crate
   FROM order_machines om
     JOIN machine_types mt ON mt.id = om.machine_type_id
     LEFT JOIN machine_crating mc ON mc.machine_id = om.id
     LEFT JOIN machine_checklist_status cs ON cs.machine_id = om.id
  WHERE NOT om.archived;
grant select on public.order_machine_status to authenticated;

-- ===========================================================================
-- 4. Refurbishment tables
-- ===========================================================================
create table public.refurb_jobs (
  id               uuid primary key default gen_random_uuid(),
  machine_id       uuid not null references public.order_machines (id) on delete cascade,
  job_number       integer not null,
  status           text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  board_id         uuid references public.boards (id) on delete set null,
  card_id          uuid references public.board_cards (id) on delete set null,
  buyback_id       uuid references public.machine_buybacks (id) on delete set null,
  old_serial       text,
  new_serial       text,
  condition_before text,
  condition_after  text,
  before_notes     text check (before_notes is null or char_length(before_notes) <= 4000),
  after_notes      text check (after_notes is null or char_length(after_notes) <= 4000),
  opened_at        timestamptz not null default now(),
  opened_by        text default public.current_user_email(),
  opened_by_name   text default public.current_user_name(),
  completed_at     timestamptz,
  completed_by_name text,
  cancelled_at     timestamptz,
  cancel_reason    text,
  unique (machine_id, job_number)
);
create unique index refurb_jobs_one_open on public.refurb_jobs (machine_id) where status = 'open';
alter table public.machine_checklists_all add constraint machine_checklists_refurb_fk
  foreign key (refurb_job_id) references public.refurb_jobs (id) on delete set null;

create table public.refurb_notes (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.refurb_jobs (id) on delete cascade,
  stage_id    uuid references public.board_stages (id) on delete set null,
  stage_name  text,
  work_date   date not null default public.halifax_today(),
  note        text not null check (btrim(note) <> '' and char_length(note) <= 4000),
  by_name     text default public.current_user_name(),
  by_email    text default public.current_user_email(),
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
create table public.refurb_parts (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.refurb_jobs (id) on delete cascade,
  part        text not null check (btrim(part) <> '' and char_length(part) <= 300),
  quantity    numeric(10, 2) not null default 1 check (quantity > 0),
  unit_cost   numeric(12, 2) not null default 0 check (unit_cost >= 0),
  cost        numeric(12, 2) generated always as (round(quantity * unit_cost, 2)) stored,
  old_part    text not null default 'scrapped' check (old_part in ('kept', 'scrapped', 'returned')),
  stage_name  text,
  notes       text check (notes is null or char_length(notes) <= 1000),
  by_name     text default public.current_user_name(),
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
create table public.refurb_costs (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.refurb_jobs (id) on delete cascade,
  description text not null check (btrim(description) <> '' and char_length(description) <= 300),
  supplier    text check (supplier is null or char_length(supplier) <= 200),
  amount      numeric(12, 2) not null check (amount >= 0),
  cost_date   date not null default public.halifax_today(),
  notes       text check (notes is null or char_length(notes) <= 1000),
  by_name     text default public.current_user_name(),
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
create table public.refurb_checklist_items (
  id              uuid primary key default gen_random_uuid(),
  machine_type_id uuid references public.machine_types (id) on delete cascade,
  stage           text not null check (btrim(stage) <> ''),
  item_text       text not null check (btrim(item_text) <> '' and char_length(item_text) <= 500),
  sort_order      integer not null default 0,
  archived        boolean not null default false,
  created_at      timestamptz not null default now()
);
insert into public.refurb_checklist_items (machine_type_id, stage, item_text, sort_order) values
  (null, 'Assessment', 'Photograph the machine as it arrived', 1),
  (null, 'Assessment', 'List damaged and worn parts', 2),
  (null, 'Disassembly', 'Label and bag fasteners', 1),
  (null, 'Repair / Replace', 'Replace bearings and belts as needed', 1),
  (null, 'Assembly', 'Check alignment and tension', 1),
  (null, 'Testing / Final check', 'Run the machine for one hour under load', 1);

alter table public.refurb_jobs enable row level security;
alter table public.refurb_notes enable row level security;
alter table public.refurb_parts enable row level security;
alter table public.refurb_costs enable row level security;
alter table public.refurb_checklist_items enable row level security;
create policy "Refurbishment readers" on public.refurb_jobs for select to authenticated using ((select public.has_perm('refurb', 'view')));
create policy "Refurbishment readers" on public.refurb_notes for select to authenticated using ((select public.has_perm('refurb', 'view')));
-- Parts and outside costs carry money: only with "See refurbishment costs".
create policy "Refurbishment cost readers" on public.refurb_parts for select to authenticated using ((select public.has_perm('refurb.costs', 'view')));
create policy "Refurbishment cost readers" on public.refurb_costs for select to authenticated using ((select public.has_perm('refurb.costs', 'view')));
create policy "Everyone signed in reads" on public.refurb_checklist_items for select to authenticated using ((select public.is_allowed_user()));
create policy "Admins write" on public.refurb_checklist_items for all to authenticated
  using ((select public.can_admin('machine_lifecycle'))) with check ((select public.can_admin('machine_lifecycle')));
grant select on public.refurb_jobs, public.refurb_notes, public.refurb_parts, public.refurb_costs to authenticated;
grant select, insert, update, delete on public.refurb_checklist_items to authenticated;
revoke insert, update, delete on public.refurb_jobs, public.refurb_notes, public.refurb_parts, public.refurb_costs from authenticated;
create trigger log_activity after insert or update or delete on public.refurb_jobs for each row execute function public.log_activity();
create trigger log_activity after insert or update or delete on public.refurb_parts for each row execute function public.log_activity();
create trigger log_activity after insert or update or delete on public.refurb_costs for each row execute function public.log_activity();

-- Parts list without prices, for people who may see the job but not its costs.
create or replace function public.refurb_parts_list(p_job uuid)
returns table (id uuid, part text, quantity numeric, old_part text, stage_name text, notes text, by_name text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.part, r.quantity, r.old_part, r.stage_name, r.notes, r.by_name, r.created_at
    from public.refurb_parts r
   where r.job_id = p_job and not r.archived and public.has_perm('refurb', 'view')
   order by r.created_at;
$$;

-- ===========================================================================
-- 5. Refurbishment functions
-- ===========================================================================
create or replace function public.open_refurb_job(p_machine uuid, p jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  m        record;
  v_set    jsonb := public.machine_lifecycle_settings();
  v_job    uuid;
  v_n      integer;
  v_board  uuid;
  v_card   uuid;
  v_stage  uuid;
  v_first  uuid;
  v_check  uuid;
  s        jsonb;
  i        integer := 0;
  v_level  text := coalesce(v_set ->> 'refurb_share_level', 'edit');
begin
  perform public.require_perm('refurb');
  select om.*, mt.name as type_name into m
    from public.order_machines om join public.machine_types mt on mt.id = om.machine_type_id
   where om.id = p_machine and not om.archived;
  if m.id is null then raise exception 'That machine could not be found.'; end if;
  if not public.machine_company_owned(p_machine) then
    raise exception 'Only a machine the company owns (bought back or in stock) can be refurbished.' using errcode = '22023';
  end if;
  if m.stock_status = 'reserved' then
    raise exception 'This machine is reserved on an order. Take it off the order first.' using errcode = '22023';
  end if;
  if exists (select 1 from public.refurb_jobs where machine_id = p_machine and status = 'open') then
    raise exception 'This machine already has an open refurbishment.' using errcode = '22023';
  end if;
  select coalesce(max(job_number), 0) + 1 into v_n from public.refurb_jobs where machine_id = p_machine;

  perform public.system_on();
  insert into public.boards (name, description, colour, owner_email, purpose, created_by)
  values ('Refurbish ' || m.type_name || coalesce(' ' || m.serial_number, '') || case when v_n > 1 then ' (' || v_n || ')' else '' end,
          'Refurbishment of ' || m.type_name || coalesce(' ' || m.serial_number, '') || '.', '#7c3aed',
          public.current_user_email(), 'refurb', public.current_user_email())
  returning id into v_board;
  for s in select value from jsonb_array_elements(coalesce(v_set -> 'refurb_stages', '[]'::jsonb)) loop
    i := i + 1;
    insert into public.board_stages (board_id, name, sort_order, step)
    values (v_board, btrim(s ->> 'name'), i, coalesce(nullif(s ->> 'step', ''), 'other'))
    returning id into v_stage;
    if v_first is null then v_first := v_stage; end if;
  end loop;
  if v_level in ('view', 'edit') then
    insert into public.board_shares (board_id, share_type, target, level) values (v_board, 'everyone', null, v_level);
  end if;
  insert into public.board_cards (board_id, stage_id, title, card_kind, machine_id, order_id, created_by, created_by_name, description)
  values (v_board, v_first, 'Refurbish ' || m.type_name || coalesce(' ' || m.serial_number, ''), 'task', p_machine, null,
          public.current_user_email(), public.current_user_name(), nullif(btrim(p ->> 'notes'), ''))
  returning id into v_card;
  -- The refurbishment checklist: one list per stage (general items, then the machine type's).
  for v_stage in select id from public.board_stages where board_id = v_board order by sort_order loop
    if exists (select 1 from public.refurb_checklist_items t join public.board_stages bs on bs.id = v_stage
                where not t.archived and lower(btrim(t.stage)) = lower(btrim(bs.name))
                  and (t.machine_type_id is null or t.machine_type_id = m.machine_type_id)) then
      insert into public.board_checklists (card_id, title, sort_order, stage_id)
      select v_card, bs.name, bs.sort_order, bs.id from public.board_stages bs where bs.id = v_stage
      returning id into v_check;
      insert into public.board_checklist_items (checklist_id, item_text, sort_order)
      select v_check, btrim(t.item_text), row_number() over (order by (t.machine_type_id is not null), t.sort_order, t.created_at)
        from public.refurb_checklist_items t join public.board_stages bs on bs.id = v_stage
       where not t.archived and lower(btrim(t.stage)) = lower(btrim(bs.name))
         and (t.machine_type_id is null or t.machine_type_id = m.machine_type_id);
    end if;
  end loop;

  insert into public.refurb_jobs (machine_id, job_number, board_id, card_id, buyback_id, old_serial, condition_before, before_notes)
  values (p_machine, v_n, v_board, v_card,
          (select id from public.machine_buybacks where machine_id = p_machine order by bought_on desc, created_at desc limit 1),
          m.serial_number, m.condition, nullif(btrim(p ->> 'before_notes'), ''))
  returning id into v_job;
  -- The earlier final check stays on the timeline; the refurbished machine gets a new one.
  update public.machine_checklists_all set superseded_at = now() where machine_id = p_machine and superseded_at is null;
  update public.order_machines set stock_status = 'in_refurbishment', checklist_done = false where id = p_machine;
  perform set_config('app.system_change', '', true);
  return v_job;
end;
$$;

-- A new final check started during a refurbishment belongs to that job.
create or replace function public.machine_checklists_refurb_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.refurb_job_id is null then
    new.refurb_job_id := (select id from public.refurb_jobs where machine_id = new.machine_id and status = 'open');
  end if;
  return new;
end;
$$;
create trigger machine_checklists_refurb_link before insert on public.machine_checklists_all
  for each row execute function public.machine_checklists_refurb_link();

create or replace function public.refurb_job_open(p_job uuid)
returns public.refurb_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
begin
  select * into j from public.refurb_jobs where id = p_job;
  if j.id is null then raise exception 'That refurbishment could not be found.'; end if;
  if j.status <> 'open' then raise exception 'This refurbishment is %.', j.status using errcode = '55000'; end if;
  return j;
end;
$$;

-- Work done in a stage. p: {job_id, id?, stage_id, work_date, note}
create or replace function public.save_refurb_note(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_perm('refurb');
  j := public.refurb_job_open((p ->> 'job_id')::uuid);
  if v_id is null then
    insert into public.refurb_notes (job_id, stage_id, stage_name, work_date, note)
    values (j.id, nullif(p ->> 'stage_id', '')::uuid,
            (select name from public.board_stages where id = nullif(p ->> 'stage_id', '')::uuid and board_id = j.board_id),
            coalesce(nullif(p ->> 'work_date', '')::date, public.halifax_today()), btrim(p ->> 'note'))
    returning id into v_id;
  else
    update public.refurb_notes set note = btrim(p ->> 'note'),
           work_date = coalesce(nullif(p ->> 'work_date', '')::date, work_date)
     where id = v_id and job_id = j.id;
  end if;
  return v_id;
end;
$$;

-- p: {job_id, id?, part, quantity, unit_cost, old_part, stage_name, notes}
create or replace function public.save_refurb_part(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_cost numeric := coalesce(nullif(p ->> 'unit_cost', '')::numeric, 0);
begin
  perform public.require_perm('refurb');
  j := public.refurb_job_open((p ->> 'job_id')::uuid);
  -- Entering a price needs "See refurbishment costs"; others record parts at no price.
  if v_cost <> 0 and not public.has_perm('refurb.costs', 'view') then
    raise exception 'Only people who may see refurbishment costs can enter prices.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.refurb_parts (job_id, part, quantity, unit_cost, old_part, stage_name, notes)
    values (j.id, btrim(p ->> 'part'), coalesce(nullif(p ->> 'quantity', '')::numeric, 1), v_cost,
            coalesce(nullif(p ->> 'old_part', ''), 'scrapped'), nullif(btrim(p ->> 'stage_name'), ''), nullif(btrim(p ->> 'notes'), ''))
    returning id into v_id;
  else
    update public.refurb_parts set part = btrim(p ->> 'part'), quantity = coalesce(nullif(p ->> 'quantity', '')::numeric, quantity),
           unit_cost = case when public.has_perm('refurb.costs', 'view') then v_cost else unit_cost end,
           old_part = coalesce(nullif(p ->> 'old_part', ''), old_part), stage_name = nullif(btrim(p ->> 'stage_name'), ''),
           notes = nullif(btrim(p ->> 'notes'), '')
     where id = v_id and job_id = j.id;
  end if;
  return v_id;
end;
$$;

-- p: {job_id, id?, description, supplier, amount, cost_date, notes}
create or replace function public.save_refurb_cost(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_perm('refurb');
  perform public.require_perm('refurb.costs', 'view');
  j := public.refurb_job_open((p ->> 'job_id')::uuid);
  if v_id is null then
    insert into public.refurb_costs (job_id, description, supplier, amount, cost_date, notes)
    values (j.id, btrim(p ->> 'description'), nullif(btrim(p ->> 'supplier'), ''), coalesce(nullif(p ->> 'amount', '')::numeric, 0),
            coalesce(nullif(p ->> 'cost_date', '')::date, public.halifax_today()), nullif(btrim(p ->> 'notes'), ''))
    returning id into v_id;
  else
    update public.refurb_costs set description = btrim(p ->> 'description'), supplier = nullif(btrim(p ->> 'supplier'), ''),
           amount = coalesce(nullif(p ->> 'amount', '')::numeric, amount),
           cost_date = coalesce(nullif(p ->> 'cost_date', '')::date, cost_date), notes = nullif(btrim(p ->> 'notes'), '')
     where id = v_id and job_id = j.id;
  end if;
  return v_id;
end;
$$;

-- Archive (or restore) a note, part or outside cost. p_kind: note | part | cost
create or replace function public.archive_refurb_item(p_kind text, p_id uuid, p_archived boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('refurb');
  if p_kind = 'note' then
    update public.refurb_notes set archived = p_archived where id = p_id
       and job_id in (select id from public.refurb_jobs where status = 'open');
  elsif p_kind = 'part' then
    update public.refurb_parts set archived = p_archived where id = p_id
       and job_id in (select id from public.refurb_jobs where status = 'open');
  elsif p_kind = 'cost' then
    perform public.require_perm('refurb.costs', 'view');
    update public.refurb_costs set archived = p_archived where id = p_id
       and job_id in (select id from public.refurb_jobs where status = 'open');
  else
    raise exception 'Unknown kind.' using errcode = '22023';
  end if;
  if not found then raise exception 'That entry could not be found on an open refurbishment.'; end if;
end;
$$;

-- p: {condition_before, condition_after, before_notes, after_notes}
create or replace function public.set_refurb_conditions(p_job uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
begin
  perform public.require_perm('refurb');
  j := public.refurb_job_open(p_job);
  if (nullif(p ->> 'condition_before', '') is not null and not exists (select 1 from public.option_lists where list_name = 'machine_condition' and value = p ->> 'condition_before'))
     or (nullif(p ->> 'condition_after', '') is not null and not exists (select 1 from public.option_lists where list_name = 'machine_condition' and value = p ->> 'condition_after')) then
    raise exception 'Choose a condition from the list.' using errcode = '22023';
  end if;
  update public.refurb_jobs set
    condition_before = case when p ? 'condition_before' then nullif(p ->> 'condition_before', '') else condition_before end,
    condition_after = case when p ? 'condition_after' then nullif(p ->> 'condition_after', '') else condition_after end,
    before_notes = case when p ? 'before_notes' then nullif(btrim(p ->> 'before_notes'), '') else before_notes end,
    after_notes = case when p ? 'after_notes' then nullif(btrim(p ->> 'after_notes'), '') else after_notes end
  where id = j.id;
end;
$$;

-- The serial the machine gets when this refurbishment is completed:
-- <serial without -R…>-R, then -R2, -R3 …
create or replace function public.refurb_next_serial(p_machine uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m public.order_machines;
  v_base text;
  v_n integer;
  v_serial text;
begin
  select * into m from public.order_machines where id = p_machine;
  v_base := regexp_replace(coalesce(m.serial_number, ''), '-R\d*$', '');
  v_n := m.refurb_count + 1;
  loop
    v_serial := v_base || '-R' || case when v_n = 1 then '' else v_n::text end;
    exit when not exists (select 1 from public.order_machines where upper(serial_number) = upper(v_serial) and id <> p_machine)
          and not exists (select 1 from public.machine_serial_aliases where upper(serial) = upper(v_serial));
    v_n := v_n + 1;
  end loop;
  return v_serial;
end;
$$;

-- Complete: the final check must be signed. The machine gets its new serial
-- (the old one stays searchable), becomes "refurbished" and Ready to sell.
-- p: {condition_after, after_notes, preview}
create or replace function public.complete_refurb_job(p_job uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
  m public.order_machines;
  v_new text;
  v_problems text[] := '{}';
begin
  perform public.require_perm('refurb.complete');
  j := public.refurb_job_open(p_job);
  select * into m from public.order_machines where id = j.machine_id;
  if m.serial_number is null then v_problems := v_problems || 'The machine has no serial number.'::text; end if;
  if not exists (select 1 from public.machine_checklists where machine_id = m.id and signed_at is not null) then
    v_problems := v_problems || 'Sign the final check first (Testing / Final check stage).'::text;
  end if;
  v_new := public.refurb_next_serial(m.id);
  if coalesce((p ->> 'preview')::boolean, false) or cardinality(v_problems) > 0 then
    return jsonb_build_object('old_serial', m.serial_number, 'new_serial', v_new, 'problems', to_jsonb(v_problems), 'done', false);
  end if;
  if nullif(p ->> 'condition_after', '') is not null and not exists (
       select 1 from public.option_lists where list_name = 'machine_condition' and value = p ->> 'condition_after') then
    raise exception 'Choose a condition from the list.' using errcode = '22023';
  end if;

  perform public.system_on();
  perform public.lock_board();
  insert into public.machine_serial_aliases (machine_id, serial, replaced_by, reason)
  values (m.id, m.serial_number, v_new, 'refurbished');
  update public.order_machines
     set serial_number = v_new, serial_manual = true, item_kind = 'refurbished', refurb_count = refurb_count + 1,
         stock_status = 'ready_to_sell', condition = coalesce(nullif(p ->> 'condition_after', ''), j.condition_after, condition),
         warranty_months = null, warranty_start = null
   where id = m.id;
  update public.refurb_jobs
     set status = 'completed', completed_at = now(), completed_by_name = public.current_user_name(), new_serial = v_new,
         condition_after = coalesce(nullif(p ->> 'condition_after', ''), condition_after),
         after_notes = coalesce(nullif(btrim(p ->> 'after_notes'), ''), after_notes)
   where id = j.id;
  update public.boards set closed_at = now(), closed_by = public.current_user_email(), closed_by_name = public.current_user_name(),
         close_reason = 'manual'
   where id = j.board_id and closed_at is null;
  perform set_config('app.system_change', '', true);
  return jsonb_build_object('old_serial', m.serial_number, 'new_serial', v_new, 'problems', '[]'::jsonb, 'done', true);
end;
$$;

create or replace function public.cancel_refurb_job(p_job uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
begin
  perform public.require_perm('refurb.complete');
  j := public.refurb_job_open(p_job);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Give a reason for cancelling.' using errcode = '22023';
  end if;
  perform public.system_on();
  update public.refurb_jobs set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason) where id = j.id;
  update public.order_machines set stock_status = 'bought_back' where id = j.machine_id and stock_status = 'in_refurbishment';
  update public.boards set closed_at = now(), closed_by = public.current_user_email(), closed_by_name = public.current_user_name(),
         close_reason = 'manual'
   where id = j.board_id and closed_at is null;
  perform set_config('app.system_change', '', true);
end;
$$;

-- ===========================================================================
-- 6. Cost summary
-- ===========================================================================
create or replace function public.refurb_labour(p_job uuid)
returns table (person text, person_name text, hours numeric, cost numeric, rate_known boolean)
language sql
stable
security definer
set search_path = public
as $$
  with j as (select * from public.refurb_jobs where id = p_job),
  t as (
    select c.finished_by who, c.finished_by_name who_name, c.started_at, c.finished_at,
           (extract(epoch from (c.finished_at - c.started_at)) - public.board_paused_seconds(c.id, null, c.started_at, c.finished_at)) / 3600.0 h
      from public.board_cards c, j
     where c.board_id = j.board_id and c.started_at is not null and c.finished_at is not null
    union all
    select i.finished_by, i.finished_by_name, i.started_at, i.finished_at,
           (extract(epoch from (i.finished_at - i.started_at)) - public.board_paused_seconds(k.id, i.id, i.started_at, i.finished_at)) / 3600.0
      from public.board_checklist_items i
      join public.board_checklists l on l.id = i.checklist_id
      join public.board_cards k on k.id = l.card_id, j
     where k.board_id = j.board_id and i.started_at is not null and i.finished_at is not null),
  priced as (
    select t.who, t.who_name, greatest(t.h, 0) h,
           (select case when r.pay_type = 'hourly' then r.hourly_rate else r.annual_salary / 2080 end
              from public.employees e, lateral public.pay_rate_on(e.id, (t.finished_at at time zone 'America/Halifax')::date) r
             where e.user_email = t.who limit 1) rate
      from t)
  select who, max(who_name), round(sum(h), 2),
         case when public.has_perm('payroll.pay', 'view') then round(sum(h * coalesce(rate, 0)), 2) end,
         bool_and(rate is not null)
    from priced
   where public.has_perm('refurb.costs', 'view')
   group by who;
$$;

create or replace function public.refurb_cost_summary(p_job uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  j public.refurb_jobs;
  m public.order_machines;
  b public.machine_buybacks;
  v_parts numeric;
  v_costs numeric;
  v_freight numeric;
  v_hours numeric;
  v_labour numeric;
  v_total numeric;
  v_sale numeric;
  v_pay boolean := public.has_perm('payroll.pay', 'view');
begin
  perform public.require_perm('refurb.costs', 'view');
  select * into j from public.refurb_jobs where id = p_job;
  if j.id is null then raise exception 'That refurbishment could not be found.'; end if;
  select * into m from public.order_machines where id = j.machine_id;
  select * into b from public.machine_buybacks where id = j.buyback_id;
  select coalesce(sum(cost), 0) into v_parts from public.refurb_parts where job_id = j.id and not archived;
  select coalesce(sum(amount), 0) into v_costs from public.refurb_costs where job_id = j.id and not archived;
  select coalesce(s.total_cad, 0) into v_freight from public.incoming_shipments s where s.id = b.incoming_shipment_id and not s.archived;
  select coalesce(sum(hours), 0), sum(cost) into v_hours, v_labour from public.refurb_labour(j.id);
  v_total := coalesce(b.price_cad, 0) + v_parts + v_costs + coalesce(v_freight, 0) + coalesce(v_labour, 0);
  v_sale := case when m.sale_price is not null then round(m.sale_price * m.sale_exchange_rate, 2) end;
  return jsonb_build_object(
    'currency', 'CAD',
    'buyback', coalesce(b.price_cad, 0), 'buyback_original', b.price, 'buyback_currency', b.currency,
    'parts', v_parts, 'outside', v_costs, 'freight_in', coalesce(v_freight, 0),
    'labour_hours', v_hours, 'labour_cost', case when v_pay then coalesce(v_labour, 0) end, 'labour_included', v_pay,
    'total', v_total,
    'sale', v_sale, 'sale_original', m.sale_price, 'sale_currency', m.sale_currency,
    'profit', case when v_sale is not null then v_sale - v_total end,
    'margin_pct', case when coalesce(v_sale, 0) > 0 then round((v_sale - v_total) / v_sale * 100, 1) end);
end;
$$;

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
