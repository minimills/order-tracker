-- 0029: Service (on-site training and commissioning)
--
-- 1. Order fields: training needed, on-site training days, travel days,
--    technician, planned start and end dates.
-- 2. Service log: one entry per day (travel or on site, hours, notes) with the
--    machines worked on and a note per machine. Saved only through
--    save_service_entry() (the phone may retry the same entry: client_id).
-- 3. Document templates (Admin → Templates): the commissioning certificate.
-- 4. Commissioning certificates: a draft per order, edited per certificate,
--    signed by the technician and the customer on screen, then locked.
--    Signatures are small PNGs in the private Storage bucket
--    "certificate-signatures". The PDF is made on demand (never stored).
-- 5. Certificate emails (send-email Edge Function, action "certificate_send")
--    are recorded in certificate_sends and the email log.
--
-- Paste this whole file into the Supabase SQL Editor and click Run.

-- ===========================================================================
-- 1. Order fields
-- ===========================================================================
alter table public.orders
  add column training_needed  boolean not null default false,
  add column training_days    numeric(5,1) check (training_days >= 0),
  add column travel_days      numeric(5,1) check (travel_days >= 0),
  add column technician_email text references public.allowed_users (email) on update cascade on delete set null,
  add column service_start    date,
  add column service_end      date,
  add constraint orders_service_dates_check check (service_start is null or service_end is null or service_end >= service_start);
grant select (training_needed, training_days, travel_days, technician_email, service_start, service_end)
  on public.orders to authenticated;

-- check_field_permissions (copy of the 0022 version) with the service fields.
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
      'split_number',       'orders.new',
      -- service (0029)
      'training_needed',    'order.field.training_needed',
      'training_days',      'order.field.training_days',
      'travel_days',        'order.field.travel_days',
      'technician_email',   'order.field.technician',
      'service_start',      'order.field.service_dates',
      'service_end',        'order.field.service_dates');
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

-- People who can be picked as the technician.
create or replace function public.technician_choices()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.has_any_perm(array['order.field.technician', 'service'])
   order by 2;
$$;

-- ===========================================================================
-- 2. Service log
-- ===========================================================================
create table public.service_entries (
  id              uuid primary key default gen_random_uuid(),
  -- made by the phone, so a retry after lost signal never saves the day twice
  client_id       uuid not null unique,
  order_id        uuid not null references public.orders (id) on delete cascade,
  entry_date      date not null,
  kind            text not null check (kind in ('travel', 'onsite')),
  hours           numeric(4,2) check (hours >= 0 and hours <= 24),
  notes           text,
  created_by      text,
  created_by_name text,
  updated_by_name text,
  archived        boolean not null default false,
  archived_at     timestamptz,
  archived_by     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index service_entries_order_idx on public.service_entries (order_id, entry_date);
create trigger service_entries_updated_at before update on public.service_entries
  for each row execute function public.set_updated_at();
create trigger service_entries_archived before insert or update of archived on public.service_entries
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.service_entries
  for each row execute function public.log_activity();

create table public.service_entry_machines (
  entry_id   uuid not null references public.service_entries (id) on delete cascade,
  machine_id uuid not null references public.order_machines (id) on delete cascade,
  notes      text,
  primary key (entry_id, machine_id)
);
create index service_entry_machines_machine_idx on public.service_entry_machines (machine_id);

alter table public.service_entries enable row level security;
alter table public.service_entry_machines enable row level security;
create policy "Service log readers" on public.service_entries
  for select to authenticated using ((select public.has_perm('service.log')));
create policy "Service log readers" on public.service_entry_machines
  for select to authenticated using ((select public.has_perm('service.log')));
revoke insert, update, delete on public.service_entries, public.service_entry_machines from authenticated;

-- Saves one day (new or changed). p_entry = {client_id, order_id, entry_date,
-- kind, hours, notes, machines: [{machine_id, notes}]}.
create or replace function public.save_service_entry(p_entry jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_order  uuid := (p_entry ->> 'order_id')::uuid;
  v_kind   text := coalesce(p_entry ->> 'kind', 'onsite');
  v_hours  numeric := nullif(p_entry ->> 'hours', '')::numeric;
  v_m      jsonb;
begin
  perform public.require_perm('service.log', 'edit');
  if not exists (select 1 from public.orders where id = v_order) then
    raise exception 'That order could not be found.';
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
    insert into public.service_entries (client_id, order_id, entry_date, kind, hours, notes, created_by, created_by_name)
    values ((p_entry ->> 'client_id')::uuid, v_order, (p_entry ->> 'entry_date')::date, v_kind, v_hours,
            nullif(btrim(p_entry ->> 'notes'), ''), public.current_user_email(), public.current_user_name())
    returning id into v_id;
  else
    update public.service_entries
       set entry_date = (p_entry ->> 'entry_date')::date, kind = v_kind, hours = v_hours,
           notes = nullif(btrim(p_entry ->> 'notes'), ''), updated_by_name = public.current_user_name()
     where id = v_id and order_id = v_order;
    delete from public.service_entry_machines where entry_id = v_id;
  end if;

  for v_m in select * from jsonb_array_elements(coalesce(p_entry -> 'machines', '[]'::jsonb)) loop
    if not exists (select 1 from public.order_machines where id = (v_m ->> 'machine_id')::uuid and order_id = v_order) then
      raise exception 'A machine is not on this order.';
    end if;
    insert into public.service_entry_machines (entry_id, machine_id, notes)
    values (v_id, (v_m ->> 'machine_id')::uuid, nullif(btrim(v_m ->> 'notes'), ''))
    on conflict (entry_id, machine_id) do update set notes = excluded.notes;
  end loop;
  return v_id;
end;
$$;

create or replace function public.archive_service_entry(p_entry uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('service.log.archive', 'edit');
  update public.service_entries set archived = true where id = p_entry;
end;
$$;

-- ===========================================================================
-- 3. Document templates (Admin → Templates)
-- ===========================================================================
create table public.document_templates (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique,
  name       text not null,
  title      text not null,
  part1      text not null default '',
  part2      text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text
);
create trigger document_templates_updated_at before update on public.document_templates
  for each row execute function public.set_updated_at();
create trigger document_templates_safe_part1 before insert or update of part1 on public.document_templates
  for each row execute function public.reject_unsafe_notes('part1');
create trigger document_templates_safe_part2 before insert or update of part2 on public.document_templates
  for each row execute function public.reject_unsafe_notes('part2');
create trigger log_activity after insert or update or delete on public.document_templates
  for each row execute function public.log_activity();
alter table public.document_templates enable row level security;
create policy "Template readers" on public.document_templates
  for select to authenticated using ((select public.has_any_perm(array['service.certificate', 'admin.templates'])));
create policy "Template editors" on public.document_templates
  for update to authenticated
  using ((select public.can_admin('templates'))) with check ((select public.can_admin('templates')));

insert into public.document_templates (key, name, title, part1, part2) values (
  'commissioning', 'Commissioning certificate', 'Commissioning Certificate',
  '<p>I, {tech_full_name}, as technical representative of {company_name}, certify that the commissioning of the following equipment has been completed.</p>',
  '<p>Training begins on {start_date}, until {end_date}. Commissioning includes testing and training in safety as well as operation.</p>'
) on conflict (key) do nothing;

-- ===========================================================================
-- 4. Commissioning certificates
-- ===========================================================================
create table public.service_certificates (
  id                       uuid primary key default gen_random_uuid(),
  order_id                 uuid not null references public.orders (id) on delete cascade,
  version                  integer not null default 1,
  status                   text not null default 'draft' check (status in ('draft', 'signed', 'superseded')),
  replaces                 uuid references public.service_certificates (id) on delete set null,
  title                    text not null,
  part1                    text not null default '',
  part2                    text not null default '',
  -- [{key, machine_id (null for a row added by hand), machine, serial, removed}]
  machines                 jsonb not null default '[]'::jsonb,
  start_date               date,
  end_date                 date,
  site_address             text,
  -- order, customer and company as they were when the certificate was made / signed
  info                     jsonb not null default '{}'::jsonb,
  tech_email               text,
  tech_name                text,
  tech_signature_path      text,
  tech_sign_date           date,
  tech_signed_at           timestamptz,
  tech_signed_by           text,
  customer_name            text,
  customer_title           text,
  customer_signature_path  text,
  customer_sign_date       date,
  customer_signed_at       timestamptz,
  customer_signed_by       text,
  locked_at                timestamptz,
  created_by               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index service_certificates_order_idx on public.service_certificates (order_id, version);
create unique index service_certificates_one_draft on public.service_certificates (order_id) where status = 'draft';
create trigger service_certificates_updated_at before update on public.service_certificates
  for each row execute function public.set_updated_at();
create trigger service_certificates_safe_part1 before insert or update of part1 on public.service_certificates
  for each row execute function public.reject_unsafe_notes('part1');
create trigger service_certificates_safe_part2 before insert or update of part2 on public.service_certificates
  for each row execute function public.reject_unsafe_notes('part2');
create trigger log_activity after insert or update or delete on public.service_certificates
  for each row execute function public.log_activity();

-- What people may change on a certificate (the rest only through the functions below).
create or replace function public.service_certificates_guard()
returns trigger
language plpgsql
as $$
declare
  k     text;
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if public.is_system_change() or public.is_service_caller() then
    return new;
  end if;
  if old.locked_at is not null or old.status <> 'draft' then
    raise exception 'This certificate is signed and locked. An admin can create a corrected version.' using errcode = '42501';
  end if;
  for k in select n.key from jsonb_each(v_new) n where n.value is distinct from v_old -> n.key loop
    continue when k = 'updated_at';
    if old.tech_signed_at is not null or old.customer_signed_at is not null then
      raise exception 'The certificate has a signature. Remove the signature first, then change the text.' using errcode = '42501';
    end if;
    if k in ('title', 'part1', 'part2') then
      perform public.require_perm('service.certificate.edit_text', 'edit');
    elsif k = 'machines' then
      perform public.require_perm('service.certificate.machines', 'edit');
    elsif k in ('start_date', 'end_date', 'site_address', 'tech_name') then
      perform public.require_perm('service.certificate.details', 'edit');
    else
      raise exception 'You cannot change "%" on a certificate.', k using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
create trigger service_certificates_guard before update on public.service_certificates
  for each row execute function public.service_certificates_guard();

alter table public.service_certificates enable row level security;
create policy "Certificate readers" on public.service_certificates
  for select to authenticated using ((select public.has_perm('service.certificate')));
create policy "Certificate editors" on public.service_certificates
  for update to authenticated
  using ((select public.has_any_perm(array['service.certificate.edit_text', 'service.certificate.machines', 'service.certificate.details'])))
  with check ((select public.has_any_perm(array['service.certificate.edit_text', 'service.certificate.machines', 'service.certificate.details'])));
revoke insert, delete on public.service_certificates from authenticated;

-- Order, customer and company details printed on the certificate.
create or replace function public.certificate_info(p_order uuid, p_with_company boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'order_number', o.order_code,
           'customer_name', c.name,
           'customer_company', c.company,
           'customer_country', c.country)
         || case when p_with_company
                 then jsonb_build_object('company', coalesce((select value from public.app_settings where key = 'company'), '{}'::jsonb))
                 else '{}'::jsonb end
    from public.orders o left join public.customers c on c.id = o.customer_id
   where o.id = p_order;
$$;

-- Makes a draft from the template (or returns the draft that already exists).
create or replace function public.create_certificate(p_order uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_t     public.document_templates%rowtype;
  v_o     record;
  v_start date;
  v_end   date;
begin
  perform public.require_perm('service.certificate.create', 'edit');
  select id into v_id from public.service_certificates where order_id = p_order and status = 'draft';
  if v_id is not null then return v_id; end if;
  select o.id, o.technician_email, o.service_start, o.service_end, c.state_province, c.country,
         (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = o.technician_email) as tech_name
    into v_o
    from public.orders o left join public.customers c on c.id = o.customer_id where o.id = p_order;
  if v_o.id is null then
    raise exception 'That order could not be found.';
  end if;
  select * into v_t from public.document_templates where key = 'commissioning';
  select min(entry_date), max(entry_date) into v_start, v_end
    from public.service_entries where order_id = p_order and kind = 'onsite' and not archived;

  insert into public.service_certificates (order_id, version, title, part1, part2, machines, start_date, end_date,
                                           site_address, info, tech_email, tech_name, created_by)
  values (p_order,
          coalesce((select max(version) from public.service_certificates where order_id = p_order), 0) + 1,
          coalesce(v_t.title, 'Commissioning Certificate'), coalesce(v_t.part1, ''), coalesce(v_t.part2, ''),
          coalesce((select jsonb_agg(jsonb_build_object('key', m.id, 'machine_id', m.id, 'machine', mt.name,
                                                        'serial', m.serial_number, 'removed', false)
                                     order by mt.name, m.serial_number)
                      from public.order_machines m join public.machine_types mt on mt.id = m.machine_type_id
                     where m.order_id = p_order and not m.archived), '[]'::jsonb),
          coalesce(v_start, v_o.service_start), coalesce(v_end, v_o.service_end),
          nullif(concat_ws(', ', nullif(btrim(v_o.state_province), ''), nullif(btrim(v_o.country), '')), ''),
          public.certificate_info(p_order, false), v_o.technician_email, v_o.tech_name, public.current_user_email())
  returning id into v_id;
  return v_id;
end;
$$;

-- One signature (p_who = 'tech' or 'customer'). Both signed = locked.
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
     set status = 'signed', locked_at = now(), info = public.certificate_info(order_id, true)
   where id = p_certificate and tech_signed_at is not null and customer_signed_at is not null;
end;
$$;

-- Removes one signature again (only before both have signed).
create or replace function public.clear_certificate_signature(p_certificate uuid, p_who text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('service.certificate.sign', 'edit');
  if exists (select 1 from public.service_certificates where id = p_certificate and (status <> 'draft' or locked_at is not null)) then
    raise exception 'This certificate is signed and locked. An admin can create a corrected version.';
  end if;
  perform set_config('app.system_change', 'on', true);
  if p_who = 'tech' then
    update public.service_certificates set tech_signature_path = null, tech_sign_date = null, tech_signed_at = null, tech_signed_by = null
     where id = p_certificate;
  else
    update public.service_certificates set customer_name = null, customer_title = null, customer_signature_path = null,
           customer_sign_date = null, customer_signed_at = null, customer_signed_by = null
     where id = p_certificate;
  end if;
end;
$$;

-- A corrected version of a signed certificate: the old one stays in the history.
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
  if exists (select 1 from public.service_certificates where order_id = v_c.order_id and status = 'draft') then
    raise exception 'This order already has a draft certificate. Open it instead.';
  end if;
  perform set_config('app.system_change', 'on', true);
  update public.service_certificates set status = 'superseded' where id = p_certificate;
  insert into public.service_certificates (order_id, version, replaces, title, part1, part2, machines, start_date, end_date,
                                           site_address, info, tech_email, tech_name, created_by)
  values (v_c.order_id, (select max(version) from public.service_certificates where order_id = v_c.order_id) + 1, v_c.id,
          v_c.title, v_c.part1, v_c.part2, v_c.machines, v_c.start_date, v_c.end_date, v_c.site_address,
          public.certificate_info(v_c.order_id, false), v_c.tech_email, v_c.tech_name, public.current_user_email())
  returning id into v_id;
  return v_id;
end;
$$;

-- Signature pictures (Supabase Storage)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('certificate-signatures', 'certificate-signatures', false, 51200, array['image/png'])
on conflict (id) do update
  set public = false, file_size_limit = 51200, allowed_mime_types = array['image/png'];
create policy "Certificate signatures: read" on storage.objects
  for select to authenticated
  using (bucket_id = 'certificate-signatures' and (select public.has_perm('service.certificate')));
create policy "Certificate signatures: upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'certificate-signatures' and (select public.has_perm('service.certificate.sign', 'edit')));

-- ===========================================================================
-- 5. Certificate emails
-- ===========================================================================
alter table public.email_log drop constraint email_log_kind_check;
alter table public.email_log add constraint email_log_kind_check
  check (kind in ('notification', 'digest', 'test', 'resend', 'certificate'));

create table public.certificate_sends (
  id             uuid primary key default gen_random_uuid(),
  certificate_id uuid not null references public.service_certificates (id) on delete cascade,
  to_emails      text[] not null,
  status         text not null check (status in ('sent', 'failed')),
  error          text,
  email_log_id   uuid references public.email_log (id) on delete set null,
  sent_by        text,
  sent_at        timestamptz not null default now()
);
create index certificate_sends_certificate_idx on public.certificate_sends (certificate_id, sent_at);
alter table public.certificate_sends enable row level security;
create policy "Certificate readers" on public.certificate_sends
  for select to authenticated using ((select public.has_perm('service.certificate')));
revoke insert, update, delete on public.certificate_sends from authenticated;

-- ===========================================================================
-- 6. The Service lists (one row per order that needs training)
-- ===========================================================================
create view public.order_service_info
with (security_invoker = false)
as
select o.id as order_id, o.order_code, o.order_number, o.split_number, o.stage, o.archived,
       c.name as customer_name, c.company as customer_company, c.country as customer_country,
       c.state_province as customer_state_province,
       o.training_needed, o.training_days, o.travel_days, o.technician_email,
       (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = o.technician_email) as technician_name,
       o.service_start, o.service_end,
       s.first_onsite, s.last_onsite, coalesce(s.entries, 0) as entries, coalesce(s.hours, 0) as hours,
       (select sc.status from public.service_certificates sc where sc.order_id = o.id order by sc.version desc limit 1) as certificate_status
  from public.orders o
  left join public.customers c on c.id = o.customer_id
  left join lateral (
    select min(e.entry_date) filter (where e.kind = 'onsite') as first_onsite,
           max(e.entry_date) filter (where e.kind = 'onsite') as last_onsite,
           count(*) as entries, sum(e.hours) as hours
      from public.service_entries e where e.order_id = o.id and not e.archived
  ) s on true
 where public.is_allowed_user();
grant select on public.order_service_info to authenticated;

-- The Service page can be a start page.
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/reports/department-delays',
     '/reports/build-times', '/boards', '/service', '/agent', '/settings', '/admin', '/shop-board'));

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
