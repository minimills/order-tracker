-- 0049: rich text everywhere, sending from each person's own mailbox,
-- business summary for administrators only.
--
-- 1. Rich text: links, underline and strikethrough are allowed in notes; more
--    long-text columns get the safe-notes trigger; notifications always get
--    plain text (a note's HTML is turned into lines).
-- 2. Sending mailboxes: each person can connect their own SMTP mailbox
--    (Settings → Email). The password is kept encrypted in Supabase Vault and
--    is never returned to the app; only the send-email Edge Function (service
--    role) reads it.
-- 3. The business summary in the daily summary is for administrators only.
-- 4. Access lockdown (full block of 0048 + the new internals).
--
-- Paste into the Supabase SQL Editor and run once.

-- ===========================================================================
-- 1. Rich text
-- ===========================================================================

-- Links are allowed now (web, email and phone addresses only); everything
-- script-like is still refused.
create or replace function public.is_safe_rich_text(p_text text)
returns boolean
language sql
immutable
as $$
  select p_text is null
      or p_text !~* '<\s*/?\s*(script|iframe|object|embed|style|link|meta|base|form|svg|math|img|video|audio|source|frame|frameset|applet|template|textarea|button|select)(\s|>|/)'
     and p_text !~* '\son[a-z]+\s*='
     and p_text !~* '(javascript|vbscript)\s*:'
     and p_text !~* 'srcdoc'
     and p_text !~* 'href\s*=\s*["'']?\s*(?![\s"'']|https?:|mailto:|tel:)';
$$;

create or replace function public.reject_unsafe_notes()
returns trigger
language plpgsql
as $$
begin
  if not public.is_safe_rich_text(to_jsonb(new) ->> tg_argv[0]) then
    raise exception 'This text contains something that is not allowed (only formatting, lists and web, email or phone links).'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

-- Plain text of a note (lines; list items start with "- "). Also copes with a
-- note cut off in the middle of a tag.
create or replace function public.rich_to_plain(p_text text)
returns text
language sql
immutable
as $$
  select case when p_text is null then null else
    btrim(regexp_replace(
      replace(replace(replace(replace(replace(replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(regexp_replace(p_text, '</p>\s*</li>', '</li>', 'gi'), '<li[^>]*>', '- ', 'gi'),
            '<(br|/p|/li|/h[1-6]|/div)[^>]*>', E'\n', 'gi'),
          '<[^>]*>?', '', 'g'),
        '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
      E'\n{3,}', E'\n\n', 'g'), E' \n')
  end;
$$;

-- Card comments, personal notes and the service day log are rich text now.
alter table public.board_comments drop constraint if exists board_comments_body_check;
alter table public.board_comments add constraint board_comments_body_check check (btrim(body) <> '' and length(body) <= 20000);
alter table public.personal_notes drop constraint if exists personal_notes_body_check;
alter table public.personal_notes add constraint personal_notes_body_check check (length(body) <= 20000);

drop trigger if exists board_comments_safe_notes on public.board_comments;
create trigger board_comments_safe_notes before insert or update of body on public.board_comments
  for each row execute function public.reject_unsafe_notes('body');
drop trigger if exists personal_notes_safe_notes on public.personal_notes;
create trigger personal_notes_safe_notes before insert or update of body on public.personal_notes
  for each row execute function public.reject_unsafe_notes('body');
drop trigger if exists service_entries_safe_notes on public.service_entries;
create trigger service_entries_safe_notes before insert or update of notes on public.service_entries
  for each row execute function public.reject_unsafe_notes('notes');
drop trigger if exists service_entry_machines_safe_notes on public.service_entry_machines;
create trigger service_entry_machines_safe_notes before insert or update of notes on public.service_entry_machines
  for each row execute function public.reject_unsafe_notes('notes');

-- Notifications (bell, phone, email) always carry plain text, whatever made them.
create or replace function public.notifications_plain_text()
returns trigger
language plpgsql
as $$
begin
  if new.body ~ '<[a-zA-Z/]' then new.body := left(public.rich_to_plain(new.body), 1000); end if;
  if new.title ~ '<[a-zA-Z/]' then new.title := left(public.rich_to_plain(new.title), 300); end if;
  return new;
end;
$$;
drop trigger if exists notifications_aa_plain_text on public.notifications;
create trigger notifications_aa_plain_text before insert on public.notifications
  for each row execute function public.notifications_plain_text();

-- ===========================================================================
-- 2. Sending mailboxes (Settings → Email)
-- ===========================================================================
create extension if not exists supabase_vault;

create table if not exists public.user_mailboxes (
  user_email      text primary key references public.allowed_users (email) on update cascade on delete cascade,
  from_address    text not null check (from_address ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  from_name       text check (from_name is null or length(from_name) <= 80),
  smtp_host       text not null check (smtp_host ~* '^[a-z0-9.-]+$' and length(smtp_host) <= 255),
  smtp_port       integer not null default 465 check (smtp_port between 1 and 65535),
  -- ssl = SSL / TLS from the start (port 465); starttls = plain connection upgraded (port 587)
  smtp_security   text not null default 'ssl' check (smtp_security in ('ssl', 'starttls')),
  smtp_username   text not null check (btrim(smtp_username) <> '' and length(smtp_username) <= 255),
  -- The password lives in Supabase Vault (vault.secrets); only its id is kept here.
  secret_id       uuid,
  save_sent       boolean not null default true,
  imap_host       text check (imap_host is null or (imap_host ~* '^[a-z0-9.-]+$' and length(imap_host) <= 255)),
  imap_port       integer not null default 993 check (imap_port between 1 and 65535),
  status          text not null default 'untested' check (status in ('untested', 'ok', 'error')),
  last_tested_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- The email log keeps which address each email went out from.
alter table public.email_log add column if not exists from_email text;

-- No policies: nobody reads or writes the table directly, only the functions below.
alter table public.user_mailboxes enable row level security;
revoke all on public.user_mailboxes from anon, authenticated;

-- My mailbox settings, without the password (has_password says whether one is saved).
create or replace function public.my_mailbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m public.user_mailboxes%rowtype;
begin
  perform public.require_perm('settings.mailbox', 'view');
  select * into m from public.user_mailboxes where user_email = public.current_user_email();
  if not found then return null; end if;
  return jsonb_build_object(
    'from_address', m.from_address, 'from_name', m.from_name, 'smtp_host', m.smtp_host, 'smtp_port', m.smtp_port,
    'smtp_security', m.smtp_security, 'smtp_username', m.smtp_username, 'has_password', m.secret_id is not null,
    'save_sent', m.save_sent, 'imap_host', m.imap_host, 'imap_port', m.imap_port, 'status', m.status,
    'last_tested_at', m.last_tested_at, 'last_error', m.last_error, 'updated_at', m.updated_at);
end;
$$;

-- Connect or change my sending mailbox. The password is only sent when it is
-- typed (empty = keep the saved one) and is stored encrypted in Vault.
create or replace function public.save_my_mailbox(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     text := public.current_user_email();
  v_old    public.user_mailboxes%rowtype;
  v_pw     text := nullif(p ->> 'password', '');
  v_secret uuid;
  v_host   text := lower(btrim(coalesce(p ->> 'smtp_host', '')));
  v_imap   text := nullif(lower(btrim(coalesce(p ->> 'imap_host', ''))), '');
  v_port   integer := coalesce(nullif(p ->> 'smtp_port', '')::integer, 465);
  v_sec    text := coalesce(nullif(p ->> 'smtp_security', ''), case when v_port = 587 then 'starttls' else 'ssl' end);
begin
  perform public.require_perm('settings.mailbox', 'edit');
  if v_me is null then raise exception 'Please sign in again.'; end if;
  if v_host = '' or v_host !~* '^[a-z0-9.-]+$' then
    raise exception 'Enter the outgoing mail server, for example mail.minimills.net.' using errcode = '22023';
  end if;
  if v_host ~* '^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)' or v_imap ~* '^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)' then
    raise exception 'Use the mail server''s public name, not a local address.' using errcode = '22023';
  end if;
  if coalesce(p ->> 'from_address', '') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter your full email address.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p ->> 'smtp_username', '')), '') is null then
    raise exception 'Enter the user name of the mailbox (usually your email address).' using errcode = '22023';
  end if;
  if v_pw is not null and length(v_pw) > 500 then
    raise exception 'The password is too long.' using errcode = '22023';
  end if;

  select * into v_old from public.user_mailboxes where user_email = v_me;
  v_secret := v_old.secret_id;
  if v_pw is not null then
    if v_secret is not null and exists (select 1 from vault.secrets where id = v_secret) then
      perform vault.update_secret(v_secret, v_pw);
    else
      v_secret := vault.create_secret(v_pw, 'mailbox:' || v_me || ':' || gen_random_uuid(), 'Sending mailbox password (Settings → Email)');
    end if;
  elsif v_secret is null then
    raise exception 'Enter the password of the mailbox.' using errcode = '22023';
  end if;

  insert into public.user_mailboxes as m (user_email, from_address, from_name, smtp_host, smtp_port, smtp_security, smtp_username,
                                         secret_id, save_sent, imap_host, imap_port, status, last_error, updated_at)
  values (v_me, lower(btrim(p ->> 'from_address')), nullif(btrim(replace(replace(coalesce(p ->> 'from_name', ''), '"', ''), '<', '')), ''),
          v_host, v_port, v_sec, btrim(p ->> 'smtp_username'), v_secret,
          coalesce((p ->> 'save_sent')::boolean, true), v_imap, coalesce(nullif(p ->> 'imap_port', '')::integer, 993),
          'untested', null, now())
  on conflict (user_email) do update set
    from_address = excluded.from_address, from_name = excluded.from_name, smtp_host = excluded.smtp_host,
    smtp_port = excluded.smtp_port, smtp_security = excluded.smtp_security, smtp_username = excluded.smtp_username,
    secret_id = excluded.secret_id, save_sent = excluded.save_sent, imap_host = excluded.imap_host,
    imap_port = excluded.imap_port, status = 'untested', last_error = null, updated_at = now();

  -- One line in the history, never the password.
  insert into public.activity_log (user_email, table_name, record_id, action, changes)
  values (v_me, 'user_mailboxes', v_me, case when v_old.user_email is null then 'insert' else 'update' end,
          jsonb_build_object('from_address', lower(btrim(p ->> 'from_address')), 'smtp_host', v_host, 'password_changed', v_pw is not null));
end;
$$;

-- Disconnect my mailbox: the saved password is deleted from Vault.
create or replace function public.remove_my_mailbox()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     text := public.current_user_email();
  v_secret uuid;
begin
  perform public.require_perm('settings.mailbox', 'edit');
  select secret_id into v_secret from public.user_mailboxes where user_email = v_me;
  if not found then return; end if;
  delete from public.user_mailboxes where user_email = v_me;
  if v_secret is not null then delete from vault.secrets where id = v_secret; end if;
  insert into public.activity_log (user_email, table_name, record_id, action, changes)
  values (v_me, 'user_mailboxes', v_me, 'delete', '{}'::jsonb);
end;
$$;

-- Internal (service role only, used by the send-email Edge Function): the
-- mailbox a person sends from, with the password.
create or replace function public.mailbox_for_sending(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'from_address', m.from_address,
    'from_name', coalesce(m.from_name, nullif(btrim(a.name), ''), m.from_address),
    'smtp_host', m.smtp_host, 'smtp_port', m.smtp_port, 'smtp_security', m.smtp_security, 'smtp_username', m.smtp_username,
    'password', s.decrypted_secret, 'save_sent', m.save_sent, 'imap_host', coalesce(m.imap_host, m.smtp_host), 'imap_port', m.imap_port,
    'status', m.status)
    from public.user_mailboxes m
    join public.allowed_users a on a.email = m.user_email
    left join vault.decrypted_secrets s on s.id = m.secret_id
   where m.user_email = lower(p_email) and s.decrypted_secret is not null;
$$;

-- Internal (service role only): the result of the last send or test.
create or replace function public.set_mailbox_status(p_email text, p_ok boolean, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.user_mailboxes
     set status = case when p_ok then 'ok' else 'error' end,
         last_tested_at = now(),
         last_error = case when p_ok then null else left(p_error, 500) end
   where user_email = lower(p_email);
$$;

-- ===========================================================================
-- 3. Business summary: administrators only
-- ===========================================================================
create or replace function public.set_my_summary(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
  v_m text[];
  v_e text[];
begin
  perform public.require_perm('settings.daily_summary', 'edit');
  if coalesce((p ->> 'business')::boolean, false) and not public.is_admin() then
    raise exception 'The business summary is available to administrators only.' using errcode = '42501';
  end if;
  insert into public.summary_settings (user_email) values (v_me) on conflict (user_email) do nothing;
  if p ? 'morning_items' then
    select coalesce(array_agg(x), '{}') into v_m from jsonb_array_elements_text(p -> 'morning_items') x where x = any (public.summary_item_keys());
  end if;
  if p ? 'evening_items' then
    select coalesce(array_agg(x), '{}') into v_e from jsonb_array_elements_text(p -> 'evening_items') x where x = any (public.summary_item_keys());
  end if;
  update public.summary_settings s set
    morning_enabled = case when p ? 'morning_enabled' then (p ->> 'morning_enabled')::boolean else s.morning_enabled end,
    morning_time = case when p ? 'morning_time' then (p ->> 'morning_time')::time else s.morning_time end,
    morning_items = case when p ? 'morning_items' then v_m else s.morning_items end,
    evening_enabled = case when p ? 'evening_enabled' then (p ->> 'evening_enabled')::boolean else s.evening_enabled end,
    evening_time = case when p ? 'evening_time' then (p ->> 'evening_time')::time else s.evening_time end,
    evening_items = case when p ? 'evening_items' then v_e else s.evening_items end,
    business = case when p ? 'business' then (p ->> 'business')::boolean else s.business end,
    updated_at = now()
   where s.user_email = v_me;
end;
$$;

-- Never on for someone who is not an administrator (also when an admin becomes a user).
create or replace function public.summary_business_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.business and not exists (select 1 from public.allowed_users where email = new.user_email and role = 'admin') then
    new.business := false;
  end if;
  return new;
end;
$$;
drop trigger if exists summary_settings_business_admin_only on public.summary_settings;
create trigger summary_settings_business_admin_only before insert or update on public.summary_settings
  for each row execute function public.summary_business_admin_only();

create or replace function public.allowed_users_summary_business()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role <> 'admin' then
    update public.summary_settings set business = false where user_email = new.email and business;
  end if;
  return null;
end;
$$;
drop trigger if exists allowed_users_summary_business on public.allowed_users;
create trigger allowed_users_summary_business after update of role on public.allowed_users
  for each row execute function public.allowed_users_summary_business();

-- The old "business summary" permission is gone (build_summary's perm_of check
-- is then true for administrators only).
update public.summary_settings s set business = false
 where s.business and not exists (select 1 from public.allowed_users a where a.email = s.user_email and a.role = 'admin');
update public.user_permissions set perms = perms - 'summary.business' where perms ? 'summary.business';
update public.departments set default_permissions = default_permissions - 'summary.business' where default_permissions ? 'summary.business';
update public.permission_templates set perms = perms - 'summary.business' where perms ? 'summary.business';

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
