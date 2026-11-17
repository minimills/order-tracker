-- 0048 Customizable dashboards and the Glass look
--
-- 1. Glass appearance: user_preferences.theme can be 'glass'; glass_base says
--    whether glass uses light or dark colours (or follows the device).
-- 2. Dashboards: several per person (tabs), each a list of widgets and a layout
--    per screen size (lg / md / sm). Written only through the functions below.
-- 3. Dashboard templates (Admin → Dashboard Templates): built by admins, given
--    to people or departments as their starting dashboards, optionally locked.
--    "Reset to Template" brings a copy back to the template.
-- 4. Sharing a dashboard with others as a copy (notification "dashboard_shared").
-- 5. Live updates: the tables the widgets read are added to Supabase Realtime
--    (row security still decides what each person receives).
-- 6. Access lockdown.

-- ===========================================================================
-- 1. Glass appearance
-- ===========================================================================
alter table public.user_preferences drop constraint user_preferences_theme_check;
alter table public.user_preferences add constraint user_preferences_theme_check check (theme in ('light', 'dark', 'system', 'glass'));
alter table public.user_preferences add column glass_base text not null default 'system' check (glass_base in ('light', 'dark', 'system'));

-- Copy of 0037 + Glass.
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
  if p ? 'desktop_notifications' then
    perform public.require_perm('settings.notifications', 'view');
  end if;
  insert into public.user_preferences (user_email) values (v_me) on conflict (user_email) do nothing;
  update public.user_preferences
     set theme = case when p ? 'theme' then p ->> 'theme' else theme end,
         glass_base = case when p ? 'glass_base' then p ->> 'glass_base' else glass_base end,
         sidebar_collapsed = case when p ? 'sidebar_collapsed' then (p ->> 'sidebar_collapsed')::boolean else sidebar_collapsed end,
         desktop_notifications = case when p ? 'desktop_notifications' then (p ->> 'desktop_notifications')::boolean else desktop_notifications end,
         shop_board_view = case when p ? 'shop_board_view' then p ->> 'shop_board_view' else shop_board_view end
   where user_email = v_me;
end;
$$;

-- ===========================================================================
-- 2 + 3. Templates and dashboards
-- ===========================================================================
create table public.dashboard_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(btrim(name)) between 1 and 60),
  description text,
  -- [{id, type, key, title, settings}] and {lg: [{i, x, y, w, h}], md: [...], sm: [...]}
  widgets     jsonb not null default '[]',
  layouts     jsonb not null default '{}',
  -- people cannot change their copy
  locked      boolean not null default false,
  archived    boolean not null default false,
  created_by  text default public.current_user_email(),
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table public.dashboard_templates enable row level security;
create policy "Template admins" on public.dashboard_templates for select to authenticated using ((select public.can_admin('dashboards')));
revoke insert, update, delete on public.dashboard_templates from authenticated;
revoke all on public.dashboard_templates from anon;

-- Who a template is for: people (user) or departments (department id).
create table public.dashboard_template_targets (
  template_id uuid not null references public.dashboard_templates (id) on delete cascade,
  target_type text not null check (target_type in ('user', 'department')),
  target      text not null,
  primary key (template_id, target_type, target)
);
alter table public.dashboard_template_targets enable row level security;
create policy "Template admins" on public.dashboard_template_targets for select to authenticated using ((select public.can_admin('dashboards')));
revoke insert, update, delete on public.dashboard_template_targets from authenticated;
revoke all on public.dashboard_template_targets from anon;

create table public.dashboards (
  id             uuid primary key default gen_random_uuid(),
  owner_email    text not null references public.allowed_users (email) on update cascade on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 40),
  sort_order     integer not null default 0,
  is_default     boolean not null default false,
  widgets        jsonb not null default '[]',
  layouts        jsonb not null default '{}',
  template_id    uuid references public.dashboard_templates (id) on delete set null,
  locked         boolean not null default false,
  shared_by_name text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index dashboards_owner_idx on public.dashboards (owner_email, sort_order);
create unique index dashboards_one_default on public.dashboards (owner_email) where is_default;
alter table public.dashboards enable row level security;
create policy "Own dashboards" on public.dashboards for select to authenticated using (owner_email = (select public.current_user_email()));
revoke insert, update, delete on public.dashboards from authenticated;
revoke all on public.dashboards from anon;

-- A widget list and layouts of a sensible size (internal).
create or replace function public.dashboard_check(p_widgets jsonb, p_layouts jsonb)
returns void
language plpgsql
immutable
as $$
begin
  if jsonb_typeof(coalesce(p_widgets, '[]')) <> 'array' or jsonb_array_length(coalesce(p_widgets, '[]')) > 60 then
    raise exception 'A dashboard can hold up to 60 widgets.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_layouts, '{}')) <> 'object' then
    raise exception 'The dashboard layout could not be read. Refresh the page and try again.' using errcode = '22023';
  end if;
  if length(coalesce(p_widgets, '[]')::text) + length(coalesce(p_layouts, '{}')::text) > 200000 then
    raise exception 'This dashboard is too large to save. Remove some widgets or shorten the notes.' using errcode = '22023';
  end if;
end;
$$;

-- The people a template is for (directly or through a department), internal.
create or replace function public.dashboard_template_people(p_template uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select t.target from public.dashboard_template_targets t
    join public.allowed_users a on a.email = t.target
   where t.template_id = p_template and t.target_type = 'user'
  union
  select ud.user_email from public.dashboard_template_targets t
    join public.user_departments ud on ud.department_id::text = t.target
   where t.template_id = p_template and t.target_type = 'department';
$$;

-- Gives one person a fresh copy of a template (replacing an earlier copy), internal.
create or replace function public.dashboard_copy_template(p_template uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.dashboard_templates;
  v_id uuid;
  v_sort integer;
  v_default boolean;
begin
  select * into t from public.dashboard_templates where id = p_template and not archived;
  if t.id is null then return null; end if;
  select d.sort_order, d.is_default into v_sort, v_default from public.dashboards d
   where d.owner_email = p_email and d.template_id = p_template order by d.sort_order limit 1;
  delete from public.dashboards where owner_email = p_email and template_id = p_template;
  v_default := coalesce(v_default, not exists (select 1 from public.dashboards where owner_email = p_email and is_default));
  insert into public.dashboards (owner_email, name, sort_order, is_default, widgets, layouts, template_id, locked)
  values (p_email, left(t.name, 40),
          coalesce(v_sort, (select coalesce(max(sort_order), 0) + 1 from public.dashboards where owner_email = p_email)),
          v_default, t.widgets, t.layouts, t.id, t.locked)
  returning id into v_id;
  return v_id;
end;
$$;

-- My dashboards. Someone without any gets the templates meant for them first.
create or replace function public.my_dashboards()
returns setof public.dashboards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
  r record;
begin
  perform public.require_perm('dashboard', 'view');
  if not exists (select 1 from public.dashboards where owner_email = v_me) then
    for r in
      select t.id from public.dashboard_templates t
       where not t.archived and v_me in (select public.dashboard_template_people(t.id))
       order by (exists (select 1 from public.dashboard_template_targets x where x.template_id = t.id and x.target_type = 'user' and x.target = v_me)) desc, t.name
    loop
      perform public.dashboard_copy_template(r.id, v_me);
    end loop;
  end if;
  return query select * from public.dashboards where owner_email = v_me order by sort_order, created_at;
end;
$$;

-- Create (no id) or change one of my dashboards: {id?, name?, widgets?, layouts?}.
create or replace function public.save_dashboard(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  d public.dashboards;
begin
  perform public.require_perm('dashboard.charts.customize', 'edit');
  perform public.dashboard_check(p -> 'widgets', p -> 'layouts');
  if p ? 'name' and length(btrim(coalesce(p ->> 'name', ''))) not between 1 and 40 then
    raise exception 'Give the dashboard a name of up to 40 characters.' using errcode = '22023';
  end if;
  if v_id is null then
    if exists (select 1 from public.dashboards where owner_email = v_me) then
      perform public.require_perm('dashboard.tabs', 'edit');
    end if;
    if (select count(*) from public.dashboards where owner_email = v_me) >= 12 then
      raise exception 'You can have up to 12 dashboards. Delete one first.' using errcode = '22023';
    end if;
    insert into public.dashboards (owner_email, name, sort_order, is_default, widgets, layouts)
    values (v_me, btrim(coalesce(p ->> 'name', 'Overview')),
            (select coalesce(max(sort_order), 0) + 1 from public.dashboards where owner_email = v_me),
            not exists (select 1 from public.dashboards where owner_email = v_me and is_default),
            coalesce(p -> 'widgets', '[]'), coalesce(p -> 'layouts', '{}'))
    returning id into v_id;
    return v_id;
  end if;
  select * into d from public.dashboards where id = v_id and owner_email = v_me for update;
  if d.id is null then raise exception 'That dashboard could not be found.' using errcode = 'P0002'; end if;
  if d.locked then raise exception 'This dashboard is locked by an admin and cannot be changed.' using errcode = 'P0001'; end if;
  if p ? 'name' and btrim(p ->> 'name') is distinct from d.name then perform public.require_perm('dashboard.tabs', 'edit'); end if;
  update public.dashboards set
    name = case when p ? 'name' then btrim(p ->> 'name') else name end,
    widgets = case when p ? 'widgets' then p -> 'widgets' else widgets end,
    layouts = case when p ? 'layouts' then p -> 'layouts' else layouts end,
    updated_at = now()
   where id = v_id;
  return v_id;
end;
$$;

-- Tabs: duplicate, delete, default, order.
create or replace function public.duplicate_dashboard(p_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.dashboards;
begin
  perform public.require_perm('dashboard.tabs', 'edit');
  select * into d from public.dashboards where id = p_id and owner_email = public.current_user_email();
  if d.id is null then raise exception 'That dashboard could not be found.' using errcode = 'P0002'; end if;
  return public.save_dashboard(jsonb_build_object('name', coalesce(nullif(btrim(p_name), ''), left(d.name || ' (copy)', 40)), 'widgets', d.widgets, 'layouts', d.layouts));
end;
$$;

create or replace function public.delete_dashboard(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
  d public.dashboards;
begin
  perform public.require_perm('dashboard.tabs', 'edit');
  select * into d from public.dashboards where id = p_id and owner_email = v_me;
  if d.id is null then raise exception 'That dashboard could not be found.' using errcode = 'P0002'; end if;
  if d.locked then raise exception 'This dashboard is locked by an admin and cannot be deleted.' using errcode = 'P0001'; end if;
  delete from public.dashboards where id = p_id;
  if d.is_default then
    update public.dashboards set is_default = true
     where id = (select id from public.dashboards where owner_email = v_me order by sort_order limit 1);
  end if;
end;
$$;

create or replace function public.set_default_dashboard(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('dashboard.tabs', 'edit');
  if not exists (select 1 from public.dashboards where id = p_id and owner_email = v_me) then
    raise exception 'That dashboard could not be found.' using errcode = 'P0002';
  end if;
  update public.dashboards set is_default = false where owner_email = v_me and is_default and id <> p_id;
  update public.dashboards set is_default = true where id = p_id;
end;
$$;

create or replace function public.reorder_dashboards(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('dashboard.tabs', 'edit');
  update public.dashboards d set sort_order = x.n
    from unnest(p_ids) with ordinality x(id, n)
   where d.id = x.id and d.owner_email = public.current_user_email();
end;
$$;

-- Back to the template this dashboard came from (also for locked ones).
create or replace function public.reset_dashboard(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.dashboards;
begin
  perform public.require_perm('dashboard.reset', 'edit');
  select * into d from public.dashboards where id = p_id and owner_email = public.current_user_email();
  if d.id is null then raise exception 'That dashboard could not be found.' using errcode = 'P0002'; end if;
  if d.template_id is null or not exists (select 1 from public.dashboard_templates where id = d.template_id and not archived) then
    raise exception 'This dashboard did not come from a template.' using errcode = 'P0001';
  end if;
  return public.dashboard_copy_template(d.template_id, d.owner_email);
end;
$$;

-- ===========================================================================
-- 4. Sharing a copy
-- ===========================================================================
insert into public.notification_kinds (kind, label, description, sort_order, default_modes) values
  ('dashboard_shared', 'A dashboard was shared with you', 'Someone gave you a copy of their dashboard.', 95, '{"app": "on", "push": "off", "email": "off", "desktop": "off"}')
on conflict (kind) do nothing;

-- People to share with (anyone who can open the dashboard).
create or replace function public.dashboard_share_people()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a
   where public.has_perm('dashboard.share', 'edit') and a.email <> public.current_user_email()
     and public.perm_of(a.email, 'dashboard', 'view')
   order by 2;
$$;

-- Each person gets their own copy (widgets they may not see stay hidden for them).
create or replace function public.share_dashboard(p_id uuid, p_emails text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.dashboards;
  v_to text;
  v_new uuid;
  v_n integer := 0;
  v_from text := public.current_user_name();
begin
  perform public.require_perm('dashboard.share', 'edit');
  select * into d from public.dashboards where id = p_id and owner_email = public.current_user_email();
  if d.id is null then raise exception 'That dashboard could not be found.' using errcode = 'P0002'; end if;
  foreach v_to in array coalesce(p_emails, '{}') loop
    v_to := lower(btrim(v_to));
    continue when v_to = d.owner_email or not public.perm_of(v_to, 'dashboard', 'view');
    if (select count(*) from public.dashboards where owner_email = v_to) >= 12 then continue; end if;
    insert into public.dashboards (owner_email, name, sort_order, is_default, widgets, layouts, shared_by_name)
    values (v_to, left(d.name || ' (from ' || coalesce(v_from, 'a colleague') || ')', 40),
            (select coalesce(max(sort_order), 0) + 1 from public.dashboards where owner_email = v_to),
            false, d.widgets, d.layouts, v_from)
    returning id into v_new;
    insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
    values (v_to, 'dashboard_shared', coalesce(v_from, 'A colleague') || ' shared a dashboard with you',
            'A copy of “' || d.name || '” was added to your dashboards.', '/dashboard?tab=' || v_new, 'dashboard_shared:' || v_new);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 3. Templates (Admin → Dashboard Templates)
-- ===========================================================================
create or replace function public.save_dashboard_template(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_admin_area('dashboards');
  perform public.dashboard_check(p -> 'widgets', p -> 'layouts');
  if length(btrim(coalesce(p ->> 'name', ''))) not between 1 and 60 then
    raise exception 'Give the template a name of up to 60 characters.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.dashboard_templates (name, description, widgets, layouts, locked)
    values (btrim(p ->> 'name'), nullif(btrim(p ->> 'description'), ''), coalesce(p -> 'widgets', '[]'), coalesce(p -> 'layouts', '{}'),
            coalesce((p ->> 'locked')::boolean, false))
    returning id into v_id;
  else
    update public.dashboard_templates t set
      name = btrim(p ->> 'name'),
      description = case when p ? 'description' then nullif(btrim(p ->> 'description'), '') else t.description end,
      widgets = case when p ? 'widgets' then p -> 'widgets' else t.widgets end,
      layouts = case when p ? 'layouts' then p -> 'layouts' else t.layouts end,
      locked = case when p ? 'locked' then (p ->> 'locked')::boolean else t.locked end,
      archived = case when p ? 'archived' then (p ->> 'archived')::boolean else t.archived end,
      updated_by = public.current_user_email(), updated_at = now()
     where t.id = v_id;
    if not found then raise exception 'That template could not be found.' using errcode = 'P0002'; end if;
    -- The lock follows the template on every copy straight away.
    update public.dashboards set locked = (select locked from public.dashboard_templates where id = v_id) where template_id = v_id;
  end if;
  perform public.log_admin_action('dashboard_templates', v_id::text, null, jsonb_build_object('action', 'dashboard template saved', 'name', btrim(p ->> 'name')));
  return v_id;
end;
$$;

-- People to give a template to (Admin → Dashboard Templates).
create or replace function public.dashboard_template_people_choices()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a
   where public.can_admin('dashboards')
   order by 2;
$$;

-- targets: [{type: 'user' | 'department', target}]
create or replace function public.set_dashboard_template_targets(p_template uuid, p_targets jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('dashboards');
  delete from public.dashboard_template_targets where template_id = p_template;
  insert into public.dashboard_template_targets (template_id, target_type, target)
  select distinct p_template, x ->> 'type', case when x ->> 'type' = 'user' then lower(x ->> 'target') else x ->> 'target' end
    from jsonb_array_elements(coalesce(p_targets, '[]')) x
   where x ->> 'type' in ('user', 'department') and coalesce(x ->> 'target', '') <> '';
  perform public.log_admin_action('dashboard_templates', p_template::text, null, jsonb_build_object('action', 'dashboard template assigned', 'targets', jsonb_array_length(coalesce(p_targets, '[]'))));
end;
$$;

-- Gives (or gives again) the template to everyone it is for, replacing their copy. Returns how many people.
create or replace function public.apply_dashboard_template(p_template uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_n integer := 0;
begin
  perform public.require_admin_area('dashboards');
  for v_email in select public.dashboard_template_people(p_template) loop
    if public.perm_of(v_email, 'dashboard', 'view') and public.dashboard_copy_template(p_template, v_email) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  perform public.log_admin_action('dashboard_templates', p_template::text, null, jsonb_build_object('action', 'dashboard template given to people', 'people', v_n));
  return v_n;
end;
$$;

-- ===========================================================================
-- 5. Live updates
-- ===========================================================================
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['orders', 'payments', 'order_machines', 'board_cards', 'notices', 'crates', 'time_off_requests', 'company_events'] loop
      if to_regclass('public.' || t) is not null and not exists (
           select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
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
