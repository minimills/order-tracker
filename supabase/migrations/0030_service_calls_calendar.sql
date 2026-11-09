-- 0030: Service calls, service reports, technician calendar, phone calendar link
--
-- 1. One "Service Calls" board (the boards system, purpose 'service') with the
--    stages Wants service, Scheduled, In progress, Done (editable in the
--    board's settings). Every card on it is a service call (service_calls):
--    customer, machines from that customer's past orders, technician, planned
--    dates. The service day log (service_entries) now also works for calls.
-- 2. Service reports: the same documents as commissioning certificates
--    (service_certificates, kind 'service_report'), from the editable
--    "Service report" template, signed and emailed the same way.
-- 3. Technician calendar: training visits, service calls and travel days are
--    shown automatically; technicians add their own entries
--    (tech_calendar_entries). calendar_entries() reads it.
-- 4. Phone calendar: a private subscription link per technician
--    (calendar_feeds); the Edge Function "calendar-feed" turns it into an
--    iCal (.ics) calendar.
--
-- Paste this whole file into the Supabase SQL Editor and click Run.

-- ===========================================================================
-- 1. Service calls
-- ===========================================================================
alter table public.board_cards drop constraint board_cards_card_kind_check;
alter table public.board_cards add constraint board_cards_card_kind_check
  check (card_kind in ('task', 'machine', 'leftover', 'service'));
create unique index boards_one_service_board on public.boards (purpose) where purpose = 'service';

create table public.service_calls (
  card_id            uuid primary key references public.board_cards (id) on delete cascade,
  call_number        integer generated always as identity unique,
  customer_id        uuid references public.customers (id) on delete set null,
  technician_email   text references public.allowed_users (email) on update cascade on delete set null,
  planned_start      date,
  planned_end        date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (planned_start is null or planned_end is null or planned_end >= planned_start)
);
create trigger service_calls_updated_at before update on public.service_calls
  for each row execute function public.set_updated_at();

create table public.service_call_machines (
  card_id    uuid not null references public.service_calls (card_id) on delete cascade,
  machine_id uuid not null references public.order_machines (id) on delete cascade,
  primary key (card_id, machine_id)
);

alter table public.service_calls enable row level security;
alter table public.service_call_machines enable row level security;
create policy "Service call readers" on public.service_calls
  for select to authenticated using ((select public.has_perm('service.calls')));
create policy "Service call readers" on public.service_call_machines
  for select to authenticated using ((select public.has_perm('service.calls')));
revoke insert, update, delete on public.service_calls, public.service_call_machines from authenticated;

-- The board, made once.
do $$
declare
  v uuid;
begin
  perform public.system_on();
  insert into public.boards (name, description, colour, owner_email, purpose, created_by)
  values ('Service Calls', 'Customers who want service. One card per service call.', '#7c3aed', null, 'service', 'automatic')
  returning id into v;
  insert into public.board_stages (board_id, name, sort_order)
  values (v, 'Wants service', 1), (v, 'Scheduled', 2), (v, 'In progress', 3), (v, 'Done', 4);
  insert into public.board_shares (board_id, share_type, target, level, created_by) values (v, 'everyone', null, 'edit', 'automatic');
  insert into public.board_notify_rules (board_id, event, target_type, created_by)
  values (v, 'assigned', 'assignees', 'automatic'), (v, 'comment', 'assignees', 'automatic'),
         (v, 'due_soon', 'assignees', 'automatic'), (v, 'overdue', 'assignees', 'automatic');
  perform set_config('app.system_change', '', true);
end $$;

-- Every card on the service board is a service call (runs after board_cards_guard).
create or replace function public.board_cards_zzz_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.boards where id = new.board_id and purpose = 'service') then
    new.card_kind := 'service';
  end if;
  return new;
end;
$$;
create trigger board_cards_zzz_service before insert on public.board_cards
  for each row execute function public.board_cards_zzz_service();

create or replace function public.board_cards_service_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.card_kind = 'service' then
    insert into public.service_calls (card_id) values (new.id) on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger board_cards_service_after after insert on public.board_cards
  for each row execute function public.board_cards_service_after();

-- New service call from the Service page (no board permissions needed).
create or replace function public.create_service_call(p_title text, p_customer uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board uuid := (select id from public.boards where purpose = 'service');
  v_stage uuid;
  v_card  uuid;
  v_prev  text := coalesce(current_setting('app.system_change', true), '');
begin
  perform public.require_perm('service.calls.create', 'edit');
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'Describe the problem in a few words.';
  end if;
  select id into v_stage from public.board_stages where board_id = v_board and not archived order by sort_order limit 1;
  if v_stage is null then raise exception 'The Service Calls board has no stages. Add one in the board settings.'; end if;
  perform public.system_on();
  insert into public.board_cards (board_id, stage_id, title, customer_id, created_by, created_by_name)
  values (v_board, v_stage, btrim(p_title), p_customer, public.current_user_email(), public.current_user_name())
  returning id into v_card;
  update public.service_calls set customer_id = p_customer where card_id = v_card;
  perform set_config('app.system_change', v_prev, true);
  return v_card;
end;
$$;

-- Customer, technician, planned dates, machines. p = {customer_id, technician_email,
-- planned_start, planned_end, machines: [machine ids]} (only the keys given change).
create or replace function public.update_service_call(p_card uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c    public.service_calls%rowtype;
  v_prev text := coalesce(current_setting('app.system_change', true), '');
  v_m    text;
begin
  perform public.require_perm('service.calls.edit', 'edit');
  select * into v_c from public.service_calls where card_id = p_card for update;
  if v_c.card_id is null then raise exception 'That service call could not be found.'; end if;
  if p ? 'customer_id' then v_c.customer_id := nullif(p ->> 'customer_id', '')::uuid; end if;
  if p ? 'technician_email' then v_c.technician_email := nullif(lower(btrim(p ->> 'technician_email')), ''); end if;
  if p ? 'planned_start' then v_c.planned_start := nullif(p ->> 'planned_start', '')::date; end if;
  if p ? 'planned_end' then v_c.planned_end := nullif(p ->> 'planned_end', '')::date; end if;
  if v_c.planned_start is not null and v_c.planned_end is not null and v_c.planned_end < v_c.planned_start then
    raise exception 'The end date must be on or after the start date.';
  end if;
  update public.service_calls
     set customer_id = v_c.customer_id, technician_email = v_c.technician_email,
         planned_start = v_c.planned_start, planned_end = v_c.planned_end
   where card_id = p_card;
  if p ? 'machines' then
    delete from public.service_call_machines where card_id = p_card;
    for v_m in select jsonb_array_elements_text(p -> 'machines') loop
      if not exists (select 1 from public.order_machines m join public.orders o on o.id = m.order_id
                      where m.id = v_m::uuid and o.customer_id = v_c.customer_id) then
        raise exception 'A machine is not from this customer''s orders.';
      end if;
      insert into public.service_call_machines (card_id, machine_id) values (p_card, v_m::uuid) on conflict do nothing;
    end loop;
  elsif p ? 'customer_id' then
    -- another customer: drop machines that are not theirs
    delete from public.service_call_machines s
     where s.card_id = p_card
       and not exists (select 1 from public.order_machines m join public.orders o on o.id = m.order_id
                        where m.id = s.machine_id and o.customer_id = v_c.customer_id);
  end if;
  -- The card follows: customer link and due date (planned start).
  perform public.system_on();
  update public.board_cards set customer_id = v_c.customer_id, due_date = v_c.planned_start where id = p_card;
  perform set_config('app.system_change', v_prev, true);
end;
$$;

-- The machines of a customer's past orders (for picking).
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
   where o.customer_id = p_customer and not m.archived
     and public.has_perm('service.calls')
   order by o.order_date desc, o.order_code, mt.name, m.serial_number;
$$;

-- ===========================================================================
-- 2. Service log and documents for service calls
-- ===========================================================================
alter table public.service_entries alter column order_id drop not null;
alter table public.service_entries add column service_call_id uuid references public.service_calls (card_id) on delete cascade;
alter table public.service_entries add constraint service_entries_one_subject check (num_nonnulls(order_id, service_call_id) = 1);
create index service_entries_call_idx on public.service_entries (service_call_id, entry_date);

-- save_service_entry (0029) for an order or a service call.
create or replace function public.save_service_entry(p_entry jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_order  uuid := nullif(p_entry ->> 'order_id', '')::uuid;
  v_call   uuid := nullif(p_entry ->> 'service_call_id', '')::uuid;
  v_kind   text := coalesce(p_entry ->> 'kind', 'onsite');
  v_hours  numeric := nullif(p_entry ->> 'hours', '')::numeric;
  v_m      jsonb;
begin
  perform public.require_perm('service.log', 'edit');
  if num_nonnulls(v_order, v_call) <> 1 then
    raise exception 'Choose the order or the service call.';
  end if;
  if v_order is not null and not exists (select 1 from public.orders where id = v_order) then
    raise exception 'That order could not be found.';
  end if;
  if v_call is not null and not exists (select 1 from public.service_calls where card_id = v_call) then
    raise exception 'That service call could not be found.';
  end if;
  if nullif(p_entry ->> 'entry_date', '') is null then
    raise exception 'Enter the date.';
  end if;
  if v_kind not in ('travel', 'onsite') then
    raise exception 'Choose travel day or on-site day.';
  end if;
  if v_hours is not null and (v_hours < 0 or v_hours > 24) then
    raise exception 'Hours must be between 0 and 24.';
  end if;

  select id into v_id from public.service_entries where client_id = (p_entry ->> 'client_id')::uuid;
  if v_id is null then
    insert into public.service_entries (client_id, order_id, service_call_id, entry_date, kind, hours, notes, created_by, created_by_name)
    values ((p_entry ->> 'client_id')::uuid, v_order, v_call, (p_entry ->> 'entry_date')::date, v_kind, v_hours,
            nullif(btrim(p_entry ->> 'notes'), ''), public.current_user_email(), public.current_user_name())
    returning id into v_id;
  else
    update public.service_entries
       set entry_date = (p_entry ->> 'entry_date')::date, kind = v_kind, hours = v_hours,
           notes = nullif(btrim(p_entry ->> 'notes'), ''), updated_by_name = public.current_user_name()
     where id = v_id;
    delete from public.service_entry_machines where entry_id = v_id;
  end if;

  for v_m in select * from jsonb_array_elements(coalesce(p_entry -> 'machines', '[]'::jsonb)) loop
    if v_order is not null and not exists (select 1 from public.order_machines where id = (v_m ->> 'machine_id')::uuid and order_id = v_order) then
      raise exception 'A machine is not on this order.';
    end if;
    if v_call is not null and not exists (select 1 from public.service_call_machines where machine_id = (v_m ->> 'machine_id')::uuid and card_id = v_call) then
      raise exception 'A machine is not on this service call.';
    end if;
    insert into public.service_entry_machines (entry_id, machine_id, notes)
    values (v_id, (v_m ->> 'machine_id')::uuid, nullif(btrim(v_m ->> 'notes'), ''))
    on conflict (entry_id, machine_id) do update set notes = excluded.notes;
  end loop;
  return v_id;
end;
$$;

-- Service reports are service_certificates of kind 'service_report' on a call.
alter table public.service_certificates add column kind text not null default 'commissioning'
  check (kind in ('commissioning', 'service_report'));
alter table public.service_certificates add column service_call_id uuid references public.service_calls (card_id) on delete cascade;
alter table public.service_certificates alter column order_id drop not null;
alter table public.service_certificates add constraint service_certificates_one_subject check (num_nonnulls(order_id, service_call_id) = 1);
create unique index service_certificates_one_call_draft on public.service_certificates (service_call_id) where status = 'draft';
create index service_certificates_call_idx on public.service_certificates (service_call_id, version);

insert into public.document_templates (key, name, title, part1, part2) values (
  'service_report', 'Service report', 'Service Report',
  '<p>I, {tech_full_name}, as technical representative of {company_name}, attended {customer_company} for service call {order_number} and worked on the following equipment.</p>',
  '<h3>Work carried out</h3><p>Service visit from {start_date} until {end_date}.</p><p>The customer confirms that the work described above has been completed.</p>'
) on conflict (key) do nothing;

-- Order or service call details printed on a document.
create or replace function public.document_info(p_order uuid, p_call uuid, p_with_company boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_order is not null then public.certificate_info(p_order, p_with_company)
    else (select jsonb_build_object(
                   'order_number', 'S-' || sc.call_number,
                   'reference', 'Service call S-' || sc.call_number,
                   'customer_name', c.name,
                   'customer_company', c.company,
                   'customer_country', c.country)
                 || case when p_with_company
                         then jsonb_build_object('company', coalesce((select value from public.app_settings where key = 'company'), '{}'::jsonb))
                         else '{}'::jsonb end
            from public.service_calls sc left join public.customers c on c.id = sc.customer_id
           where sc.card_id = p_call)
  end;
$$;

-- A draft service report for a call (or the draft that already exists).
create or replace function public.create_service_report(p_card uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_t     public.document_templates%rowtype;
  v_c     record;
  v_start date;
  v_end   date;
begin
  perform public.require_perm('service.certificate.create', 'edit');
  select id into v_id from public.service_certificates where service_call_id = p_card and status = 'draft';
  if v_id is not null then return v_id; end if;
  select sc.card_id, sc.technician_email, sc.planned_start, sc.planned_end, c.state_province, c.country,
         (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = sc.technician_email) as tech_name
    into v_c
    from public.service_calls sc left join public.customers c on c.id = sc.customer_id where sc.card_id = p_card;
  if v_c.card_id is null then raise exception 'That service call could not be found.'; end if;
  select * into v_t from public.document_templates where key = 'service_report';
  select min(entry_date), max(entry_date) into v_start, v_end
    from public.service_entries where service_call_id = p_card and kind = 'onsite' and not archived;
  insert into public.service_certificates (service_call_id, kind, version, title, part1, part2, machines, start_date, end_date,
                                           site_address, info, tech_email, tech_name, created_by)
  values (p_card, 'service_report',
          coalesce((select max(version) from public.service_certificates where service_call_id = p_card), 0) + 1,
          coalesce(v_t.title, 'Service Report'), coalesce(v_t.part1, ''), coalesce(v_t.part2, ''),
          coalesce((select jsonb_agg(jsonb_build_object('key', m.id, 'machine_id', m.id, 'machine', mt.name,
                                                        'serial', m.serial_number, 'removed', false)
                                     order by mt.name, m.serial_number)
                      from public.service_call_machines x
                      join public.order_machines m on m.id = x.machine_id
                      join public.machine_types mt on mt.id = m.machine_type_id
                     where x.card_id = p_card), '[]'::jsonb),
          coalesce(v_start, v_c.planned_start), coalesce(v_end, v_c.planned_end),
          nullif(concat_ws(', ', nullif(btrim(v_c.state_province), ''), nullif(btrim(v_c.country), '')), ''),
          public.document_info(null, p_card, false), v_c.technician_email, v_c.tech_name, public.current_user_email())
  returning id into v_id;
  return v_id;
end;
$$;

-- sign_certificate (copy of the 0029 version): the details of a call are kept too.
create or replace function public.sign_certificate(p_certificate uuid, p_who text, p_name text, p_title text,
                                                   p_date date, p_signature_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.service_certificates%rowtype;
begin
  perform public.require_perm('service.certificate.sign', 'edit');
  select * into v_c from public.service_certificates where id = p_certificate for update;
  if v_c.id is null then raise exception 'That certificate could not be found.'; end if;
  if v_c.status <> 'draft' or v_c.locked_at is not null then
    raise exception 'This certificate is already signed and locked.';
  end if;
  if p_who not in ('tech', 'customer') then raise exception 'Choose who is signing.'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Enter the printed name.'; end if;
  if p_date is null then raise exception 'Enter the date.'; end if;
  if p_signature_path is null or p_signature_path not like p_certificate::text || '/%'
     or not exists (select 1 from storage.objects o where o.bucket_id = 'certificate-signatures' and o.name = p_signature_path) then
    raise exception 'The signature was not saved. Sign again.';
  end if;
  perform set_config('app.system_change', 'on', true);
  if p_who = 'tech' then
    update public.service_certificates
       set tech_name = btrim(p_name), tech_sign_date = p_date, tech_signature_path = p_signature_path,
           tech_signed_at = now(), tech_signed_by = public.current_user_email()
     where id = p_certificate;
  else
    update public.service_certificates
       set customer_name = btrim(p_name), customer_title = nullif(btrim(p_title), ''), customer_sign_date = p_date,
           customer_signature_path = p_signature_path, customer_signed_at = now(), customer_signed_by = public.current_user_email()
     where id = p_certificate;
  end if;
  update public.service_certificates
     set status = 'signed', locked_at = now(), info = public.document_info(order_id, service_call_id, true)
   where id = p_certificate and tech_signed_at is not null and customer_signed_at is not null;
end;
$$;

-- correct_certificate (copy of the 0029 version): also for service reports.
create or replace function public.correct_certificate(p_certificate uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c  public.service_certificates%rowtype;
  v_id uuid;
begin
  perform public.require_perm('service.certificate.correct', 'edit');
  select * into v_c from public.service_certificates where id = p_certificate for update;
  if v_c.id is null then raise exception 'That certificate could not be found.'; end if;
  if v_c.status <> 'signed' then raise exception 'Only a signed certificate can be corrected.'; end if;
  if exists (select 1 from public.service_certificates where status = 'draft'
              and (order_id = v_c.order_id or service_call_id = v_c.service_call_id)) then
    raise exception 'This order already has a draft certificate. Open it instead.';
  end if;
  perform set_config('app.system_change', 'on', true);
  update public.service_certificates set status = 'superseded' where id = p_certificate;
  insert into public.service_certificates (order_id, service_call_id, kind, version, replaces, title, part1, part2, machines,
                                           start_date, end_date, site_address, info, tech_email, tech_name, created_by)
  values (v_c.order_id, v_c.service_call_id, v_c.kind,
          (select max(version) from public.service_certificates
            where order_id = v_c.order_id or service_call_id = v_c.service_call_id) + 1, v_c.id,
          v_c.title, v_c.part1, v_c.part2, v_c.machines, v_c.start_date, v_c.end_date, v_c.site_address,
          public.document_info(v_c.order_id, v_c.service_call_id, false), v_c.tech_email, v_c.tech_name, public.current_user_email())
  returning id into v_id;
  return v_id;
end;
$$;

-- One row per service call (Service page, board cards, calendar).
create view public.service_call_info
with (security_invoker = false)
as
select sc.card_id, sc.call_number, 'S-' || sc.call_number as call_code,
       c.board_id, c.title, c.description, c.archived, c.created_at,
       st.id as stage_id, st.name as stage_name, st.sort_order as stage_order,
       st.sort_order = (select max(s2.sort_order) from public.board_stages s2 where s2.board_id = c.board_id and not s2.archived) as done,
       sc.customer_id, cu.name as customer_name, cu.company as customer_company, cu.country as customer_country,
       cu.state_province as customer_state_province,
       sc.technician_email,
       (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = sc.technician_email) as technician_name,
       sc.planned_start, sc.planned_end,
       coalesce((select jsonb_agg(jsonb_build_object('machine_id', m.id, 'machine', mt.name, 'serial', m.serial_number, 'order_code', o.order_code)
                                  order by mt.name, m.serial_number)
                   from public.service_call_machines x
                   join public.order_machines m on m.id = x.machine_id
                   join public.machine_types mt on mt.id = m.machine_type_id
                   join public.orders o on o.id = m.order_id
                  where x.card_id = sc.card_id), '[]'::jsonb) as machines,
       (select count(*) from public.service_entries e where e.service_call_id = sc.card_id and not e.archived) as entries,
       (select coalesce(sum(e.hours), 0) from public.service_entries e where e.service_call_id = sc.card_id and not e.archived) as hours,
       (select d.status from public.service_certificates d where d.service_call_id = sc.card_id order by d.version desc limit 1) as report_status
  from public.service_calls sc
  join public.board_cards c on c.id = sc.card_id
  join public.board_stages st on st.id = c.stage_id
  left join public.customers cu on cu.id = sc.customer_id
 where public.has_perm('service.calls');
grant select on public.service_call_info to authenticated;

-- ===========================================================================
-- 3. Technician calendar
-- ===========================================================================
create table public.tech_calendar_entries (
  id            uuid primary key default gen_random_uuid(),
  tech_email    text not null references public.allowed_users (email) on update cascade on delete cascade,
  kind          text not null check (kind in ('onsite', 'travel')),
  customer_id   uuid references public.customers (id) on delete set null,
  customer_text text,
  start_date    date not null,
  end_date      date not null,
  notes         text,
  created_by    text default public.current_user_email(),
  archived      boolean not null default false,
  archived_at   timestamptz,
  archived_by   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_date >= start_date)
);
create index tech_calendar_entries_tech_idx on public.tech_calendar_entries (tech_email, start_date);
create trigger tech_calendar_entries_updated_at before update on public.tech_calendar_entries
  for each row execute function public.set_updated_at();
create trigger tech_calendar_entries_archived before insert or update of archived on public.tech_calendar_entries
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.tech_calendar_entries
  for each row execute function public.log_activity();
alter table public.tech_calendar_entries enable row level security;
create policy "Calendar readers" on public.tech_calendar_entries
  for select to authenticated
  using ((select public.has_perm('service.calendar'))
         and (tech_email = (select public.current_user_email()) or (select public.has_perm('service.calendar.all'))));
create policy "Calendar writers" on public.tech_calendar_entries
  for insert to authenticated
  with check ((tech_email = (select public.current_user_email()) and (select public.has_perm('service.calendar.add', 'edit')))
              or (select public.has_perm('service.calendar.manage', 'edit')));
create policy "Calendar editors" on public.tech_calendar_entries
  for update to authenticated
  using ((tech_email = (select public.current_user_email()) and (select public.has_perm('service.calendar.add', 'edit')))
         or (select public.has_perm('service.calendar.manage', 'edit')))
  with check ((tech_email = (select public.current_user_email()) and (select public.has_perm('service.calendar.add', 'edit')))
              or (select public.has_perm('service.calendar.manage', 'edit')));
revoke delete on public.tech_calendar_entries from authenticated;

-- Everything on the calendar: training visits, service calls, logged travel days,
-- and the technicians' own entries. Internal (use calendar_entries / calendar_feed).
create or replace function public.calendar_rows(p_tech text, p_from date, p_to date)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text)
language sql
stable
security definer
set search_path = public
as $$
  with rows as (
    select 'training'::text as source, o.id::text as source_id, o.technician_email as tech_email, 'training'::text as kind,
           o.service_start as start_date, coalesce(o.service_end, o.service_start) as end_date,
           'Training – ' || coalesce(c.name, 'customer') || ' (Order ' || o.order_code || ')' as title,
           c.name as customer, c.country, null::text as notes, '/service/' || o.id as link
      from public.orders o left join public.customers c on c.id = o.customer_id
     where o.technician_email is not null and o.service_start is not null and not o.archived and o.stage <> 'Cancelled'
    union all
    select 'service_call', sc.card_id::text, sc.technician_email, 'service',
           sc.planned_start, coalesce(sc.planned_end, sc.planned_start),
           'Service call S-' || sc.call_number || ' – ' || coalesce(cu.name, bc.title),
           cu.name, cu.country, bc.title, '/service/calls/' || sc.card_id
      from public.service_calls sc
      join public.board_cards bc on bc.id = sc.card_id and not bc.archived
      left join public.customers cu on cu.id = sc.customer_id
     where sc.technician_email is not null and sc.planned_start is not null
    union all
    select 'travel_log', e.id::text, e.created_by, 'travel', e.entry_date, e.entry_date,
           'Travel – ' || coalesce(cu.name, 'customer'), cu.name, cu.country, e.notes,
           case when e.order_id is not null then '/service/' || e.order_id else '/service/calls/' || e.service_call_id end
      from public.service_entries e
      left join public.orders o on o.id = e.order_id
      left join public.service_calls sc on sc.card_id = e.service_call_id
      left join public.customers cu on cu.id = coalesce(o.customer_id, sc.customer_id)
     where e.kind = 'travel' and not e.archived and e.created_by is not null
    union all
    select 'manual', t.id::text, t.tech_email, t.kind, t.start_date, t.end_date,
           (case when t.kind = 'travel' then 'Travel' else 'On site' end) || coalesce(' – ' || coalesce(cu.name, nullif(btrim(t.customer_text), '')), ''),
           coalesce(cu.name, nullif(btrim(t.customer_text), '')), cu.country, t.notes, null::text
      from public.tech_calendar_entries t left join public.customers cu on cu.id = t.customer_id
     where not t.archived
  )
  select r.source, r.source_id, r.tech_email,
         (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = r.tech_email),
         r.kind, r.start_date, r.end_date, r.title, r.customer, r.country, r.notes, r.link
    from rows r
   where (p_tech is null or r.tech_email = p_tech)
     and r.start_date <= p_to and r.end_date >= p_from
   order by r.start_date, r.tech_email, r.title;
$$;

-- The calendar on screen: one technician (own, or anyone with "all"), or everyone (null).
create or replace function public.calendar_entries(p_from date, p_to date, p_tech text default null)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_perm('service.calendar', 'view');
  if p_tech is distinct from public.current_user_email() then
    perform public.require_perm('service.calendar.all', 'view');
  end if;
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a shorter period.';
  end if;
  return query select * from public.calendar_rows(lower(p_tech), p_from, p_to);
end;
$$;

-- ===========================================================================
-- 4. Phone calendar subscription link (iCal)
-- ===========================================================================
create table public.calendar_feeds (
  user_email   text primary key references public.allowed_users (email) on update cascade on delete cascade,
  token        text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.calendar_feeds enable row level security;
create policy "Own calendar link" on public.calendar_feeds
  for select to authenticated using (user_email = (select public.current_user_email()));
revoke insert, update, delete on public.calendar_feeds from authenticated;

create or replace function public.new_calendar_token()
returns text
language sql
volatile
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- My private link's token (made the first time).
create or replace function public.my_calendar_feed()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  perform public.require_perm('service.calendar.sync', 'edit');
  insert into public.calendar_feeds (user_email, token) values (public.current_user_email(), public.new_calendar_token())
  on conflict (user_email) do nothing;
  select token into v_token from public.calendar_feeds where user_email = public.current_user_email();
  return v_token;
end;
$$;

-- A new link: the old one stops working at once.
create or replace function public.reset_my_calendar_feed()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := public.new_calendar_token();
begin
  perform public.require_perm('service.calendar.sync', 'edit');
  insert into public.calendar_feeds (user_email, token) values (public.current_user_email(), v_token)
  on conflict (user_email) do update set token = excluded.token, created_at = now(), last_used_at = null;
  insert into public.activity_log (user_id, user_email, table_name, record_id, action, changes)
  values (auth.uid(), auth.jwt() ->> 'email', 'calendar_feeds', public.current_user_email(), 'update',
          jsonb_build_object('action', 'phone calendar link reset'));
  return v_token;
end;
$$;

-- For the calendar-feed Edge Function only (service role): the entries behind a link.
create or replace function public.calendar_feed(p_token text)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select user_email into v_email from public.calendar_feeds f
   where f.token = p_token and length(p_token) >= 32
     and exists (select 1 from public.allowed_users a where a.email = f.user_email);
  if v_email is null then return; end if;
  update public.calendar_feeds set last_used_at = now() where user_email = v_email;
  return query select * from public.calendar_rows(v_email, current_date - 120, current_date + 400);
end;
$$;

-- ===========================================================================
-- Fixes to 0029: "see" permissions are checked at the view level
-- (has_any_perm checks the edit level unless told otherwise).
-- ===========================================================================
create or replace function public.technician_choices()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.has_any_perm(array['order.field.technician', 'service', 'service.calendar'], 'view')
   order by 2;
$$;

drop policy "Template readers" on public.document_templates;
create policy "Template readers" on public.document_templates
  for select to authenticated using ((select public.has_any_perm(array['service.certificate', 'admin.templates'], 'view')));

-- ===========================================================================
-- 5. Start page, Technician permission preset
-- ===========================================================================
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/reports/department-delays',
     '/reports/build-times', '/boards', '/service', '/service/calendar', '/agent', '/settings', '/admin', '/shop-board'));

insert into public.permission_templates (name, perms)
select 'Technician', jsonb_build_object(
  'service', 'view', 'service.filters', 'view', 'service.list.in_progress', 'view', 'service.list.upcoming', 'view',
  'service.list.completed', 'view', 'service.log', 'edit', 'service.log.by_machine', 'view', 'service.photos', 'view',
  'service.certificate', 'view', 'service.certificate.create', 'edit', 'service.certificate.edit_text', 'edit',
  'service.certificate.machines', 'edit', 'service.certificate.details', 'edit', 'service.certificate.sign', 'edit',
  'service.certificate.pdf', 'view', 'service.certificate.email', 'edit',
  'service.calls', 'view', 'service.calls.create', 'edit', 'service.calls.edit', 'edit',
  'service.calendar', 'view', 'service.calendar.navigate', 'view', 'service.calendar.add', 'edit', 'service.calendar.sync', 'edit',
  'boards', 'view', 'boards.card.open', 'view', 'boards.card.move', 'edit', 'boards.card.description', 'view',
  'boards.card.edit', 'edit', 'boards.card.comments', 'edit', 'boards.card.due', 'view',
  'notifications.bell', 'view', 'serial.copy', 'view')
 where not exists (select 1 from public.permission_templates where lower(btrim(name)) = 'technician');

-- Access lockdown, as in earlier migrations.
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

-- Calendar internals: only through the functions above.
revoke execute on function public.calendar_rows(text, date, date) from authenticated;
revoke execute on function public.calendar_feed(text) from authenticated;
grant execute on function public.calendar_feed(text) to service_role;
