-- 0039 Saved signatures and CE / EU Declarations of Conformity
--  A. Saved signatures: each person may keep ONE signature picture (new
--     versions replace it). Private Storage bucket "user-signatures": only the
--     owner can see, download or use it (admins too are refused). Documents keep
--     their own copy of the signature, plus which version was used.
--  B. EC Declaration of Conformity per machine (Machinery Directive 2006/42/EC
--     Annex II 1.A), ready for the EU Machinery Regulation (EU) 2023/1230.
-- Paste the whole file into the Supabase SQL Editor and click Run.

-- ===========================================================================
-- A1. Saved signatures (metadata; the picture is in Storage)
-- ===========================================================================
create table public.user_signatures (
  id           uuid primary key default gen_random_uuid(),
  user_email   text not null references public.allowed_users (email) on delete cascade on update cascade,
  version      integer not null,
  storage_path text not null,
  width        integer,
  height       integer,
  status       text not null default 'active' check (status in ('active', 'replaced', 'removed')),
  created_at   timestamptz not null default now(),
  ended_at     timestamptz,
  unique (user_email, version)
);
create unique index user_signatures_one_active_idx on public.user_signatures (user_email) where status = 'active';
alter table public.user_signatures enable row level security;
-- Only the owner, never anyone else (no admin exception).
create policy "Own signature" on public.user_signatures
  for select to authenticated using (user_email = (select public.current_user_email()));

-- Private bucket: PNG up to 100 KB, one folder per person (their email).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-signatures', 'user-signatures', false, 102400, array['image/png'])
on conflict (id) do update set public = false, file_size_limit = 102400, allowed_mime_types = array['image/png'];
create policy "Saved signature: owner reads" on storage.objects
  for select to authenticated
  using (bucket_id = 'user-signatures' and (storage.foldername(name))[1] = (select public.current_user_email())
         and (select public.has_perm('settings.signature', 'view')));
create policy "Saved signature: owner uploads" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'user-signatures' and (storage.foldername(name))[1] = (select public.current_user_email())
              and (select public.has_perm('settings.signature', 'edit')));
create policy "Saved signature: owner deletes" on storage.objects
  for delete to authenticated
  using (bucket_id = 'user-signatures' and (storage.foldername(name))[1] = (select public.current_user_email()));

-- Documents keep a copy of a saved signature (up to 100 KB now).
update storage.buckets set file_size_limit = 102400 where id in ('checklist-signatures', 'certificate-signatures');

-- Saves a newly uploaded picture as my signature (the old version is kept as "replaced").
create or replace function public.save_my_signature(p_path text, p_width integer, p_height integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  text := public.current_user_email();
  v_ver integer;
  v_id  uuid;
begin
  perform public.require_perm('settings.signature', 'edit');
  if p_path is null or p_path not like v_me || '/%'
     or not exists (select 1 from storage.objects o where o.bucket_id = 'user-signatures' and o.name = p_path) then
    raise exception 'The signature picture was not uploaded. Please try again.';
  end if;
  update public.user_signatures set status = 'replaced', ended_at = now() where user_email = v_me and status = 'active';
  select coalesce(max(version), 0) + 1 into v_ver from public.user_signatures where user_email = v_me;
  insert into public.user_signatures (user_email, version, storage_path, width, height)
  values (v_me, v_ver, p_path, p_width, p_height)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'version', v_ver);
end;
$$;

-- Removes my signature (documents already signed keep their copy).
create or replace function public.remove_my_signature()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text;
begin
  perform public.require_perm('settings.signature', 'edit');
  update public.user_signatures set status = 'removed', ended_at = now()
   where user_email = public.current_user_email() and status = 'active'
  returning storage_path into v_path;
  return v_path;
end;
$$;

-- Internal: checks that a saved signature is the caller's current one, and that the
-- document's copy is that picture (same size). Returns its version number.
create or replace function public.use_saved_signature(p_saved uuid, p_bucket text, p_path text)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sig  public.user_signatures%rowtype;
  v_a    text;
  v_b    text;
begin
  select * into v_sig from public.user_signatures where id = p_saved;
  if v_sig.id is null or v_sig.user_email <> public.current_user_email() then
    raise exception 'Only the owner can use a saved signature.' using errcode = '42501';
  end if;
  if v_sig.status <> 'active' then
    raise exception 'That saved signature was replaced or removed. Use your current one.' using errcode = '22023';
  end if;
  if not public.has_perm('settings.signature', 'view') then
    raise exception 'You do not have permission to use a saved signature.' using errcode = '42501';
  end if;
  select o.metadata ->> 'size' into v_a from storage.objects o where o.bucket_id = 'user-signatures' and o.name = v_sig.storage_path;
  select o.metadata ->> 'size' into v_b from storage.objects o where o.bucket_id = p_bucket and o.name = p_path;
  if v_a is not null and v_b is not null and v_a <> v_b then
    raise exception 'The signature on the document is not your saved signature. Please try again.' using errcode = '22023';
  end if;
  return v_sig.version;
end;
$$;

-- ===========================================================================
-- A2. Signing with a saved signature: final checks and certificates (technician)
-- ===========================================================================
alter table public.machine_checklists
  add column signature_saved_id uuid,
  add column signature_version integer;
alter table public.service_certificates
  add column tech_signature_saved_id uuid,
  add column tech_signature_version integer;

drop function public.sign_checklist(uuid, text, text);
drop function public.sign_certificate(uuid, text, text, text, date, text);

-- Copy of 0038 with the saved signature (p_saved_signature).
create or replace function public.sign_checklist(p_checklist_id uuid, p_full_name text, p_signature_path text,
                                                 p_saved_signature uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c    record;
  v_open integer;
  v_ver  integer;
begin
  perform public.require_perm('checklist.sign');
  select * into v_c from public.machine_checklists where id = p_checklist_id;
  if v_c.id is null then
    raise exception 'That checklist could not be found.';
  end if;
  if v_c.signed_at is not null then
    raise exception 'This final check is already signed.';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) < 3 then
    raise exception 'Enter your full name to sign.';
  end if;
  select count(*) into v_open from public.machine_checklist_items where checklist_id = p_checklist_id and status = 'open';
  if v_open > 0 then
    raise exception '% item% still need% to be marked complete or not applicable before signing.', v_open, case when v_open = 1 then '' else 's' end, case when v_open = 1 then 's' else '' end;
  end if;
  if p_signature_path is null or p_signature_path not like p_checklist_id::text || '/%'
     or not exists (select 1 from storage.objects o
                     where o.bucket_id = 'checklist-signatures' and o.name = p_signature_path) then
    raise exception 'The signature was not saved. Please sign again.';
  end if;

  if p_saved_signature is not null then
    v_ver := public.use_saved_signature(p_saved_signature, 'checklist-signatures', p_signature_path);
  end if;

  perform set_config('app.system_change', 'on', true);
  update public.machine_checklists
     set signed_name = btrim(p_full_name), signed_at = now(), signed_by = public.current_user_email(),
         signature_path = p_signature_path, signature_saved_id = p_saved_signature, signature_version = v_ver, last_worked_at = now(), last_worked_by_name = public.current_user_name()
   where id = p_checklist_id;
  -- A signed final check means the machine is built (it keeps its serial number from now on).
  update public.order_machines set checklist_done = true, ready = true where id = v_c.machine_id;
end;
$$;

-- Copy of 0030 with the saved signature for the technician.
create or replace function public.sign_certificate(p_certificate uuid, p_who text, p_name text, p_title text,
                                                   p_date date, p_signature_path text, p_saved_signature uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c   public.service_certificates%rowtype;
  v_ver integer;
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
  -- Customers always draw their signature; the technician may use their saved one.
  if p_saved_signature is not null then
    if p_who <> 'tech' then
      raise exception 'Customers sign by drawing their signature.' using errcode = '22023';
    end if;
    v_ver := public.use_saved_signature(p_saved_signature, 'certificate-signatures', p_signature_path);
  end if;
  perform set_config('app.system_change', 'on', true);
  if p_who = 'tech' then
    update public.service_certificates
       set tech_name = btrim(p_name), tech_sign_date = p_date, tech_signature_path = p_signature_path,
           tech_signature_saved_id = p_saved_signature, tech_signature_version = v_ver,
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


-- Copy of 0029 that also forgets which saved signature was used.
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
    update public.service_certificates set tech_signature_path = null, tech_sign_date = null, tech_signed_at = null, tech_signed_by = null,
           tech_signature_saved_id = null, tech_signature_version = null
     where id = p_certificate;
  else
    update public.service_certificates set customer_name = null, customer_title = null, customer_signature_path = null,
           customer_sign_date = null, customer_signed_at = null, customer_signed_by = null
     where id = p_certificate;
  end if;
end;
$$;

-- ===========================================================================
-- B1. Machine types: product description, directives, harmonised standards
-- ===========================================================================
alter table public.machine_types
  add column product_description text,
  add column ce_directives text[] not null default '{}',
  add column ce_standards text;

-- The directives to choose from: a dropdown list (Admin → Dropdown lists → CE directives).
insert into public.option_lists (list_name, value, sort_order)
select 'ce_directive', v, n
  from (values ('Machinery Directive 2006/42/EC', 1), ('Low Voltage Directive 2014/35/EU', 2), ('EMC Directive 2014/30/EU', 3)) t(v, n)
 where not exists (select 1 from public.option_lists where list_name = 'ce_directive');

-- Every machine starts with the Machinery Directive.
update public.machine_types set ce_directives = array['Machinery Directive 2006/42/EC'] where ce_directives = '{}';

create or replace function public.machine_types_check_directives()
returns trigger
language plpgsql
as $$
declare
  v text;
begin
  foreach v in array coalesce(new.ce_directives, '{}') loop
    if not public.is_valid_option('ce_directive', v) then
      raise exception '“%” is not in the CE directives list (Admin → Dropdown lists).', v using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
create trigger machine_types_check_directives before insert or update of ce_directives on public.machine_types
  for each row execute function public.machine_types_check_directives();

-- Copy of 0034: renaming a CE directive also renames it on the machine types.
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
      else
        null;
    end case;
  end if;
  return null;
end;
$$;

-- ===========================================================================
-- B2. Settings and the two templates
-- ===========================================================================
-- Contact person on the letterhead (Admin → Company Details).
update public.app_settings set value = value || jsonb_build_object('contact_person', 'Ankit Luthra')
 where key = 'company' and coalesce(value ->> 'contact_person', '') = '';
insert into public.app_settings (key, value)
select 'company', jsonb_build_object('name', 'Belfast Mini Mills Ltd.', 'contact_person', 'Ankit Luthra')
 where not exists (select 1 from public.app_settings where key = 'company');

insert into public.app_settings (key, value) values ('ce', jsonb_build_object(
  'declaration_type', 'ec_2006',
  'paper', 'a4',
  'brand', 'Belfast Mini Mills Limited',
  'authorised_person', E'Certification Experts\nAmerlandseweg 7\n3621 ZC Breukelen\nThe Netherlands\nT: +31 (0) 85 007 3210\nprojects@certification-experts.com\nwww.certification-experts.com',
  'place', 'Belfast, PEI, Canada',
  'signer', 'Ankit Luthra – General Manager, Belfast Mini Mills Ltd.',
  'notified_body', '',
  'email_subject', '{title} – Belfast Mini Mills – {customer_company} – {machines}',
  'email_message', E'Dear {customer_name},\n\nPlease find attached the {title} for {machines_long}, order {order_number}.\n\nKind regards,\n{sender_name}\n{company_name}'
)) on conflict (key) do nothing;

-- Admin → Declaration of Conformity saves the settings through this function.
create or replace function public.set_ce_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := coalesce((select value from public.app_settings where key = 'ce'), '{}'::jsonb) || coalesce(p, '{}'::jsonb);
begin
  perform public.require_admin_area('ce');
  if coalesce(v ->> 'declaration_type', '') not in ('ec_2006', 'eu_2023') then
    raise exception 'Choose the declaration type.' using errcode = '22023';
  end if;
  if coalesce(v ->> 'paper', '') not in ('a4', 'letter') then
    raise exception 'Choose the paper size.' using errcode = '22023';
  end if;
  insert into public.app_settings (key, value) values ('ce', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'ce', null, jsonb_build_object('action', 'Declaration of Conformity settings changed'));
end;
$$;

insert into public.document_templates (key, name, title, part1, part2) values
  ('ce_ec', 'EC Declaration of Conformity (Machinery Directive 2006/42/EC)', 'EC Declaration of Conformity',
   '<p>We hereby declare that the machine described above fulfils all the relevant provisions of the following directives:</p>',
   '<p>This declaration of conformity is issued under the sole responsibility of the manufacturer.</p>'),
  ('ce_eu', 'EU Declaration of Conformity (Machinery Regulation (EU) 2023/1230)', 'EU Declaration of Conformity',
   '<p>This declaration of conformity is issued under the sole responsibility of the manufacturer. The machinery described above is in conformity with the relevant Union harmonisation legislation:</p>',
   '')
on conflict (key) do nothing;

-- The CE templates are read by people who issue declarations and edited with Admin → Declaration of Conformity.
drop policy "Template readers" on public.document_templates;
create policy "Template readers" on public.document_templates
  for select to authenticated
  using ((select public.has_any_perm(array['service.certificate', 'admin.templates', 'ce', 'admin.ce'], 'view')));
drop policy "Template editors" on public.document_templates;
create policy "Template editors" on public.document_templates
  for update to authenticated
  using (case when key in ('ce_ec', 'ce_eu') then (select public.can_admin('ce')) else (select public.can_admin('templates')) end)
  with check (case when key in ('ce_ec', 'ce_eu') then (select public.can_admin('ce')) else (select public.can_admin('templates')) end);

-- ===========================================================================
-- B3. Declarations: one row per issued declaration (locked; a new version replaces it)
-- ===========================================================================
create table public.ce_declarations (
  id                 uuid primary key default gen_random_uuid(),
  machine_id         uuid not null references public.order_machines (id) on delete restrict,
  order_id           uuid not null references public.orders (id) on delete restrict,
  number             text not null unique,
  version            integer not null,
  kind               text not null check (kind in ('ec_2006', 'eu_2023')),
  status             text not null default 'issued' check (status in ('issued', 'superseded')),
  replaces           uuid references public.ce_declarations (id),
  data               jsonb not null,
  paper              text not null default 'a4' check (paper in ('a4', 'letter')),
  signature_path     text not null,
  signature_source   text not null check (signature_source in ('saved', 'drawn')),
  signature_saved_id uuid,
  signature_version  integer,
  signed_by          text,
  signed_by_name     text,
  issued_at          timestamptz not null default now(),
  issued_by          text,
  issued_by_name     text,
  superseded_at      timestamptz,
  unique (machine_id, version)
);
create index ce_declarations_order_idx on public.ce_declarations (order_id, issued_at desc);
create index ce_declarations_machine_idx on public.ce_declarations (machine_id, version desc);
alter table public.ce_declarations enable row level security;
-- Read with the "ce" permission; nobody writes directly (issue_ce_declarations only).
create policy "Declaration readers" on public.ce_declarations
  for select to authenticated using ((select public.has_any_perm(array['ce', 'admin.ce'], 'view')));

create table public.ce_declaration_sends (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid references public.orders (id) on delete set null,
  declaration_ids uuid[] not null,
  to_emails       text[] not null default '{}',
  cc_emails       text[] not null default '{}',
  bcc_emails      text[] not null default '{}',
  subject         text,
  combined        boolean not null default false,
  status          text not null check (status in ('sent', 'failed')),
  error           text,
  email_log_id    uuid,
  sent_by         text,
  sent_at         timestamptz not null default now()
);
create index ce_declaration_sends_order_idx on public.ce_declaration_sends (order_id, sent_at desc);
create index ce_declaration_sends_decl_idx on public.ce_declaration_sends using gin (declaration_ids);
alter table public.ce_declaration_sends enable row level security;
create policy "Declaration readers" on public.ce_declaration_sends
  for select to authenticated using ((select public.has_any_perm(array['ce', 'admin.ce'], 'view')));

-- The signature picture on issued declarations (a copy; private).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ce-signatures', 'ce-signatures', false, 102400, array['image/png'])
on conflict (id) do update set public = false, file_size_limit = 102400, allowed_mime_types = array['image/png'];
create policy "CE signatures: read" on storage.objects
  for select to authenticated
  using (bucket_id = 'ce-signatures' and (select public.has_any_perm(array['ce', 'admin.ce'], 'view')));
create policy "CE signatures: upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ce-signatures' and (select public.has_perm('ce.issue', 'edit')));

alter table public.email_log drop constraint email_log_kind_check;
alter table public.email_log add constraint email_log_kind_check
  check (kind in ('notification', 'digest', 'test', 'resend', 'certificate', 'ce_declaration'));

-- Everything one declaration says, worked out from the settings, the template and
-- the machine (also used for the preview). p: {kind, place, date, signer, year}.
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
  select om.id, om.serial_number, om.order_id, mt.name as type_name, mt.code, mt.product_description,
         mt.ce_directives, mt.ce_standards, o.order_code, o.voltage, c.name as customer_name, c.company as customer_company,
         (select mc.signed_at from public.machine_checklists mc where mc.machine_id = om.id) as checked_at
    into v_m
    from public.order_machines om
    join public.machine_types mt on mt.id = om.machine_type_id
    join public.orders o on o.id = om.order_id
    join public.customers c on c.id = o.customer_id
   where om.id = p_machine and not om.archived;
  if v_m.id is null then
    raise exception 'That machine could not be found.';
  end if;
  select * into v_tpl from public.document_templates where key = case v_kind when 'eu_2023' then 'ce_eu' else 'ce_ec' end;

  v_year := coalesce(nullif(p ->> 'year', '')::integer, extract(year from (v_m.checked_at at time zone 'America/Halifax'))::integer,
                     extract(year from public.halifax_today())::integer);
  -- Under the EU Regulation the Machinery Directive is replaced by the Regulation.
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
      'serial', regexp_replace(coalesce(v_m.serial_number, ''), '^.*-', ''),
      'voltage', v_m.voltage,
      'year', v_year,
      'type_name', v_m.type_name),
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

-- Issues declarations (one per machine): numbered DoC-<model>-<serial>-<year>-v<version>,
-- locked; an earlier version of the same machine is marked superseded and kept.
-- p: {place, date, signer, year, signature_path, saved_signature}
create or replace function public.issue_ce_declarations(p_machines uuid[], p jsonb)
returns setof public.ce_declarations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set   jsonb := coalesce((select value from public.app_settings where key = 'ce'), '{}'::jsonb);
  v_path  text := p ->> 'signature_path';
  v_saved uuid := nullif(p ->> 'saved_signature', '')::uuid;
  v_ver   integer;
  v_mid   uuid;
  v_data  jsonb;
  v_prev  public.ce_declarations%rowtype;
  v_row   public.ce_declarations%rowtype;
  v_n     integer;
begin
  perform public.require_perm('ce.issue', 'edit');
  if coalesce(cardinality(p_machines), 0) = 0 then
    raise exception 'Choose at least one machine.' using errcode = '22023';
  end if;
  if v_path is null or not exists (select 1 from storage.objects o where o.bucket_id = 'ce-signatures' and o.name = v_path) then
    raise exception 'The signature was not saved. Please sign again.' using errcode = '22023';
  end if;
  if v_saved is not null then
    v_ver := public.use_saved_signature(v_saved, 'ce-signatures', v_path);
  end if;
  if coalesce(btrim(p ->> 'signer'), btrim(v_set ->> 'signer'), '') = '' then
    raise exception 'Enter the name and title of the person signing.' using errcode = '22023';
  end if;

  foreach v_mid in array p_machines loop
    v_data := public.ce_declaration_data(v_mid, p);
    if v_data #>> '{machine,serial_number}' is null then
      raise exception 'A machine has no serial number yet, so no declaration can be issued for it.' using errcode = '22023';
    end if;
    if v_data #>> '{machine,model}' is null then
      raise exception 'The % has no machine code (Admin → Machine Types).', v_data #>> '{machine,type_name}' using errcode = '22023';
    end if;
    if jsonb_array_length(v_data -> 'directives') = 0 then
      raise exception 'No directives are chosen for the % (Admin → Machine Types).', v_data #>> '{machine,type_name}' using errcode = '22023';
    end if;
    select * into v_prev from public.ce_declarations where machine_id = v_mid and status = 'issued' for update;
    select coalesce(max(version), 0) + 1 into v_n from public.ce_declarations where machine_id = v_mid;
    if v_prev.id is not null then
      update public.ce_declarations set status = 'superseded', superseded_at = now() where id = v_prev.id;
    end if;
    insert into public.ce_declarations (machine_id, order_id, number, version, kind, replaces, data, paper, signature_path,
                                        signature_source, signature_saved_id, signature_version, signed_by, signed_by_name,
                                        issued_by, issued_by_name)
    values (v_mid, (v_data ->> 'order_id')::uuid,
            format('DoC-%s-%s-%s-v%s', v_data #>> '{machine,model}', v_data #>> '{machine,serial}',
                   extract(year from (v_data ->> 'date')::date), v_n),
            v_n, v_data ->> 'kind', v_prev.id, v_data - 'problems',
            coalesce(nullif(p ->> 'paper', ''), v_set ->> 'paper', 'a4'), v_path,
            case when v_saved is null then 'drawn' else 'saved' end, v_saved, v_ver,
            public.current_user_email(), public.current_user_name(), public.current_user_email(), public.current_user_name())
    returning * into v_row;
    insert into public.activity_log (user_email, table_name, record_id, order_id, action, changes)
    values (public.current_user_email(), 'ce_declarations', v_row.id::text, v_row.order_id, 'insert',
            jsonb_build_object('number', v_row.number, 'serial', v_data #>> '{machine,serial_number}',
                               'replaces', v_prev.number, 'title', v_data ->> 'title'));
    return next v_row;
  end loop;
end;
$$;

-- ===========================================================================
-- C. Start page / lockdown
-- ===========================================================================
revoke all on public.user_signatures, public.ce_declarations, public.ce_declaration_sends from anon;
grant select on public.user_signatures, public.ce_declarations, public.ce_declaration_sends to authenticated;
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
