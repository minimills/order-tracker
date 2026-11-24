-- 0056 Languages
--
-- Paste into the Supabase SQL Editor and run it once (after 0055).
--
-- 1. user_preferences.language: the language each person chose in Settings
--    (en-CA, fr-CA, es, ru, de). The app reads it after signing in and on every
--    page load, so the choice follows the person to every device.
--    set_my_preferences(p) accepts "language" (permission settings.language,
--    allowed for everyone by default).
-- 2. customers.preferred_language (default en-CA): emails and PDFs sent to the
--    customer use it. Changing it is checked like the other customer fields
--    (permission customer.language).
-- 3. service_certificates.document_language and the CE settings' language:
--    legal documents stay in English unless another language is chosen for
--    that document.
-- 4. Access lockdown.

-- 1. -------------------------------------------------------------------------
alter table public.user_preferences
  add column if not exists language text check (language is null or language in ('en-CA', 'fr-CA', 'es', 'ru', 'de'));

insert into public.user_permissions (user_email, perms)
select a.email, '{"settings.language": "edit"}'::jsonb from public.allowed_users a
 where not exists (select 1 from public.user_permissions up where up.user_email = a.email)
on conflict (user_email) do nothing;
update public.user_permissions set perms = perms || '{"settings.language": "edit"}'::jsonb where not perms ? 'settings.language';
update public.permission_templates set perms = perms || '{"settings.language": "edit"}'::jsonb where not perms ? 'settings.language';
update public.departments set default_permissions = default_permissions || '{"settings.language": "edit"}'::jsonb
 where default_permissions <> '{}'::jsonb and not default_permissions ? 'settings.language';

-- New people start with it (like "use automations", 0055).
create or replace function public.automations_default_permission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_permissions (user_email, perms)
  values (new.email, '{"automations": "edit", "settings.language": "edit"}'::jsonb)
  on conflict (user_email) do nothing;
  return null;
end;
$$;

-- Copy of 0051 + language.
create or replace function public.set_my_preferences(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  if not public.is_allowed_user() then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  if p ? 'theme' or p ? 'glass_base' then
    perform public.require_perm('settings.theme');
    if p ? 'theme' and p ->> 'theme' not in ('light', 'dark', 'system', 'glass') then
      raise exception 'Choose Light, Dark, System or Glass.' using errcode = '22023';
    end if;
    if p ? 'glass_base' and p ->> 'glass_base' not in ('light', 'dark', 'system') then
      raise exception 'Choose Light, Dark or System for the glass colours.' using errcode = '22023';
    end if;
  end if;
  if p ? 'shop_board_view' and p ->> 'shop_board_view' not in ('rows', 'list', 'cards') then
    raise exception 'Choose Across, List or Cards.' using errcode = '22023';
  end if;
  if p ? 'shop_board_sort' and p ->> 'shop_board_sort' not in ('asc', 'desc') then
    raise exception 'Choose lowest or highest order number first.' using errcode = '22023';
  end if;
  if p ? 'language' then
    perform public.require_perm('settings.language');
    if p ->> 'language' not in ('en-CA', 'fr-CA', 'es', 'ru', 'de') then
      raise exception 'Choose one of the languages in the list.' using errcode = '22023';
    end if;
  end if;
  if p ? 'desktop_notifications' then
    perform public.require_perm('settings.notifications', 'view');
  end if;
  insert into public.user_preferences (user_email) values (v_me) on conflict (user_email) do nothing;
  update public.user_preferences
     set theme = case when p ? 'theme' then p ->> 'theme' else theme end,
         glass_base = case when p ? 'glass_base' then p ->> 'glass_base' else glass_base end,
         sidebar_collapsed = case when p ? 'sidebar_collapsed' then (p ->> 'sidebar_collapsed')::boolean else sidebar_collapsed end,
         desktop_notifications = case when p ? 'desktop_notifications' then (p ->> 'desktop_notifications')::boolean else desktop_notifications end,
         shop_board_view = case when p ? 'shop_board_view' then p ->> 'shop_board_view' else shop_board_view end,
         shop_board_sort = case when p ? 'shop_board_sort' then p ->> 'shop_board_sort' else shop_board_sort end,
         language = case when p ? 'language' then p ->> 'language' else language end
   where user_email = v_me;
end;
$$;

-- 2. -------------------------------------------------------------------------
alter table public.customers
  add column if not exists preferred_language text not null default 'en-CA'
  check (preferred_language in ('en-CA', 'fr-CA', 'es', 'ru', 'de'));
grant select (preferred_language) on public.customers to authenticated;
grant update (preferred_language) on public.customers to authenticated;

create or replace view public.customer_list
with (security_invoker = false)
as
select c.id, c.name, c.company,
       case when (select public.has_perm('customer.contact')) then c.emails else '{}'::text[] end as emails,
       case when (select public.has_perm('customer.contact')) then c.phone end as phone,
       c.country, c.state_province, c.notes, c.archived, c.archived_at, c.archived_by, c.created_at, c.updated_at,
       c.preferred_language
  from public.customers c
 where (select public.is_allowed_user());

-- Copy of the current check (0037 / 0050) + customers.preferred_language.
create or replace function public.check_field_permissions()
 RETURNS trigger
 LANGUAGE plpgsql
AS $$
declare
  v_map  jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'archived_at', 'archived_by', 'order_code',
                          'checklist_done_at', 'checklist_done_by', 'original_ship_date'];
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
      'service_end',        'order.field.service_dates',
      -- 0037
      'quote_number',       'order.field.quote_number',
      'invoice_number',     'order.field.invoice_number',
      -- 0050: will this order be crated?
      'crating',            'order.field.crating');
  elsif tg_table_name = 'order_machines' then
    v_map := jsonb_build_object('ready', 'order.machines.built', 'needs_crate', 'order.machines.crate_flag');
  elsif tg_table_name = 'customers' then
    v_map := jsonb_build_object('emails', 'customer.contact', 'phone', 'customer.contact',
                                'preferred_language', 'customer.language');
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
$$

;

-- 3. -------------------------------------------------------------------------
alter table public.service_certificates
  add column if not exists document_language text not null default 'en-CA'
  check (document_language in ('en-CA', 'fr-CA', 'es', 'ru', 'de'));

-- 4. -------------------------------------------------------------------------
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
