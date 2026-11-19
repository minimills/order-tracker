-- 0051:
--   1. The shop board's order (order numbers lowest first or highest first),
--      remembered for each person (set_my_preferences: shop_board_sort).
--   2. machine_list(): every machine for the Machines page (serial, model,
--      customer, order, status), narrowed in the app as people type.
--
-- Paste into the Supabase SQL Editor and run once.

alter table public.user_preferences
  add column if not exists shop_board_sort text not null default 'asc' check (shop_board_sort in ('asc', 'desc'));

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
         shop_board_sort = case when p ? 'shop_board_sort' then p ->> 'shop_board_sort' else shop_board_sort end
   where user_email = v_me;
end;
$$;

-- Every machine that is not archived, for the Machines page (permission
-- machines). Customer = the current owner (after a resale, the new owner).
create or replace function public.machine_list()
returns table (machine_id uuid, serial text, model text, code text, customer text, country text,
               order_id uuid, order_code text, order_number integer, stage text, built boolean, check_signed boolean)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.serial_number, mt.name, mt.code,
         coalesce(nullif(btrim(c.company), ''), c.name), c.country,
         o.id, o.order_code, o.order_number, o.stage, m.ready, coalesce(m.checklist_done, false)
    from public.order_machines m
    join public.orders o on o.id = m.order_id
    join public.machine_types mt on mt.id = m.machine_type_id
    left join public.customers c on c.id = public.machine_owner_id(m.id)
   where public.has_perm('machines', 'view') and not m.archived and not o.archived
   order by o.order_number desc nulls last, m.serial_number nulls last;
$$;

-- Access lockdown (full block, see CLAUDE.md, BOARDS UPGRADE).
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
