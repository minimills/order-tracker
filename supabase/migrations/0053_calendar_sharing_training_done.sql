-- 0053 Calendar for everyone, shared or private entries, Service / Training
-- summary, "Mark Training as Done"
--
-- Paste the whole file into the Supabase SQL Editor and click Run. It is one
-- step; the numbered parts below are only there to read it.
--
-- 1. Calendar settings: the "Service / Training team" (groups and departments)
--    that service and training entries are shared with by default
--    (app_settings key `calendar`, Admin → Calendar). A group "Service /
--    Training Team" is made with the technicians as members (rename or change
--    it in Admin → Groups; like every group it also gets a chat channel).
-- 2. Calendar entries: kinds onsite / travel / training / other, an optional
--    order, a "done" stamp, and visibility: private (only the owner, never
--    admins) or shared with chosen people, groups and departments
--    (calendar_entry_shares). Written only by save_calendar_entry /
--    archive_calendar_entry. Private entries are never written to the
--    activity log. Every person with the Calendar page may keep their own
--    entries (service.calendar.add is no longer used).
-- 3. What the Calendar shows: shared entries appear on the calendars of the
--    people they are shared with; private ones only on the owner's. Training
--    visits, service calls and travel logs need the Service / Training page
--    (or being the technician). Rows gain `done` and `visibility`.
-- 4. Training done: orders.training_done_at / _by / _by_name, written only by
--    mark_training_done (service.training.done), which also completes the
--    chosen board cards linked to the order and the order's calendar entries.
-- 5. Service / Training summary: service_day_summary(from, to).
-- 6. The Calendar is its own page (/calendar) and start page.
-- 7. Access lockdown.

-- ===========================================================================
-- 1. Calendar settings and the Service / Training team
-- ===========================================================================
do $$
declare
  v_group uuid;
begin
  if not exists (select 1 from public.app_settings where key = 'calendar') then
    select id into v_group from public.user_groups
     where lower(btrim(name)) = 'service / training team' and not archived limit 1;
    if v_group is null then
      insert into public.user_groups (name, description)
      values ('Service / Training Team', 'Service and training calendar entries are shared with this group (Admin → Calendar).')
      returning id into v_group;
      insert into public.user_group_members (group_id, user_email)
      select v_group, e from (
        select technician_email as e from public.orders where technician_email is not null
        union select technician_email from public.service_calls where technician_email is not null
        union select tech_email from public.tech_calendar_entries
      ) x
      where exists (select 1 from public.allowed_users a where a.email = x.e)
      on conflict do nothing;
    end if;
    insert into public.app_settings (key, value)
    values ('calendar', jsonb_build_object('service_team', jsonb_build_array(jsonb_build_object('type', 'group', 'target', v_group::text))));
  end if;
end;
$$;

-- Everyone with the Calendar page reads the settings (only the team list).
create or replace function public.calendar_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb := coalesce((select value from public.app_settings where key = 'calendar'), '{}'::jsonb);
begin
  if not public.has_any_perm(array['service.calendar', 'admin.calendar'], 'view') then
    raise exception 'You do not have access to the Calendar.' using errcode = '42501';
  end if;
  -- Only groups and departments that still exist.
  return jsonb_build_object('service_team', coalesce((
    select jsonb_agg(t) from jsonb_array_elements(coalesce(v -> 'service_team', '[]'::jsonb)) t
     where (t ->> 'type' = 'group' and exists (select 1 from public.user_groups g where g.id::text = t ->> 'target' and not g.archived))
        or (t ->> 'type' = 'department' and exists (select 1 from public.departments d where d.id::text = t ->> 'target' and not d.archived))
  ), '[]'::jsonb));
end;
$$;

create or replace function public.set_calendar_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t jsonb;
begin
  perform public.require_admin_area('calendar');
  if jsonb_typeof(p -> 'service_team') <> 'array' then
    raise exception 'Choose the groups and departments of the Service / Training team.' using errcode = '22023';
  end if;
  for t in select * from jsonb_array_elements(p -> 'service_team') loop
    if not ((t ->> 'type' = 'group' and exists (select 1 from public.user_groups g where g.id::text = t ->> 'target'))
            or (t ->> 'type' = 'department' and exists (select 1 from public.departments d where d.id::text = t ->> 'target'))) then
      raise exception 'The team can only hold existing groups and departments.' using errcode = '22023';
    end if;
  end loop;
  insert into public.app_settings (key, value) values ('calendar', jsonb_build_object('service_team', p -> 'service_team'))
  on conflict (key) do update set value = public.app_settings.value || excluded.value;
  perform public.log_admin_action('app_settings', 'calendar', null, jsonb_build_object('action', 'Calendar settings changed'));
end;
$$;

-- People, groups and departments an entry can be shared with.
create or replace function public.calendar_share_choices()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_any_perm(array['service.calendar', 'admin.calendar'], 'view') then
    raise exception 'You do not have access to the Calendar.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object('email', a.email, 'name', coalesce(nullif(btrim(a.name), ''), a.email)) order by coalesce(nullif(btrim(a.name), ''), a.email))
                          from public.allowed_users a where public.perm_of(a.email, 'service.calendar', 'view')), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.name) from public.user_groups g where not g.archived), '[]'::jsonb),
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.sort_order, d.name) from public.departments d where not d.archived), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 2. Calendar entries: kinds, order, done, visibility and shares
-- ===========================================================================
-- Training done on orders (filled only by mark_training_done, part 4).
alter table public.orders
  add column training_done_at      timestamptz,
  add column training_done_by      text,
  add column training_done_by_name text;
grant select (training_done_at, training_done_by, training_done_by_name) on public.orders to authenticated;

alter table public.tech_calendar_entries drop constraint if exists tech_calendar_entries_kind_check;
alter table public.tech_calendar_entries
  add constraint tech_calendar_entries_kind_check check (kind in ('onsite', 'travel', 'training', 'other')),
  add column visibility   text not null default 'private' check (visibility in ('private', 'shared')),
  add column order_id     uuid references public.orders (id) on delete set null,
  add column done_at      timestamptz,
  add column done_by      text,
  add column done_by_name text;
create index tech_calendar_entries_order_idx on public.tech_calendar_entries (order_id) where order_id is not null;

create table public.calendar_entry_shares (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references public.tech_calendar_entries (id) on delete cascade,
  share_type    text not null check (share_type in ('user', 'group', 'department')),
  user_email    text references public.allowed_users (email) on update cascade on delete cascade,
  group_id      uuid references public.user_groups (id) on delete cascade,
  department_id uuid references public.departments (id) on delete cascade,
  created_at    timestamptz not null default now(),
  check ((share_type = 'user') = (user_email is not null)
     and (share_type = 'group') = (group_id is not null)
     and (share_type = 'department') = (department_id is not null))
);
create unique index calendar_entry_shares_one on public.calendar_entry_shares
  (entry_id, share_type, coalesce(user_email, ''), coalesce(group_id::text, ''), coalesce(department_id::text, ''));
create index calendar_entry_shares_user_idx on public.calendar_entry_shares (user_email) where user_email is not null;

-- Entries made before 0053 were seen by everyone with "every technician's
-- calendar": they become shared with the Service / Training team.
update public.tech_calendar_entries set visibility = 'shared';
insert into public.calendar_entry_shares (entry_id, share_type, group_id, department_id)
select t.id, s ->> 'type',
       case when s ->> 'type' = 'group' then (s ->> 'target')::uuid end,
       case when s ->> 'type' = 'department' then (s ->> 'target')::uuid end
  from public.tech_calendar_entries t
 cross join jsonb_array_elements(coalesce((select value -> 'service_team' from public.app_settings where key = 'calendar'), '[]'::jsonb)) s
on conflict do nothing;

-- Can this person see this entry? Owner always; private = owner only (no
-- admin exception); shared = the people, groups and departments chosen, and
-- whoever made it for the owner.
create or replace function public.calendar_entry_visible(p_entry uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tech_calendar_entries t
     where t.id = p_entry
       and (t.tech_email = lower(p_email)
            or (t.visibility = 'shared'
                and (t.created_by = lower(p_email)
                     or exists (select 1 from public.calendar_entry_shares s
                                 where s.entry_id = t.id
                                   and ((s.share_type = 'user' and s.user_email = lower(p_email))
                                        or (s.share_type = 'group' and exists (
                                              select 1 from public.user_group_members m join public.user_groups g on g.id = m.group_id
                                               where m.group_id = s.group_id and m.user_email = lower(p_email) and not g.archived))
                                        or (s.share_type = 'department' and exists (
                                              select 1 from public.user_departments d
                                               where d.department_id = s.department_id and d.user_email = lower(p_email)))))))));
$$;

-- The same for the signed-in person (used by the row security below).
create or replace function public.calendar_entry_mine_or_shared(p_entry uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.calendar_entry_visible(p_entry, public.current_user_email());
$$;

drop policy if exists "Calendar readers" on public.tech_calendar_entries;
drop policy if exists "Calendar writers" on public.tech_calendar_entries;
drop policy if exists "Calendar editors" on public.tech_calendar_entries;
create policy "Calendar readers" on public.tech_calendar_entries
  for select to authenticated
  using ((select public.has_perm('service.calendar', 'view')) and public.calendar_entry_mine_or_shared(id));
revoke insert, update, delete on public.tech_calendar_entries from authenticated;

alter table public.calendar_entry_shares enable row level security;
create policy "Shares of entries I can see" on public.calendar_entry_shares
  for select to authenticated
  using ((select public.has_perm('service.calendar', 'view')) and public.calendar_entry_mine_or_shared(entry_id));
revoke insert, update, delete on public.calendar_entry_shares from authenticated, anon;
revoke all on public.calendar_entry_shares from anon;

-- Private entries never reach the activity log.
drop trigger if exists log_activity on public.tech_calendar_entries;
create trigger log_activity_insert after insert on public.tech_calendar_entries
  for each row when (new.visibility = 'shared') execute function public.log_activity();
create trigger log_activity_update after update on public.tech_calendar_entries
  for each row when (old.visibility = 'shared' and new.visibility = 'shared') execute function public.log_activity();
create trigger log_activity_delete after delete on public.tech_calendar_entries
  for each row when (old.visibility = 'shared') execute function public.log_activity();

-- The team's targets as "type:id" text, for comparing share lists.
create or replace function public.calendar_team_keys()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg((t ->> 'type') || ':' || (t ->> 'target') order by 1), '{}')
    from jsonb_array_elements(coalesce((select value -> 'service_team' from public.app_settings where key = 'calendar'), '[]'::jsonb)) t;
$$;

-- May the signed-in person change this entry? Their own, or (Calendar →
-- manage) a shared entry they can see. Private entries: only the owner.
create or replace function public.calendar_entry_editable(p_entry uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tech_calendar_entries t
     where t.id = p_entry and not t.archived
       and (t.tech_email = public.current_user_email()
            or (t.visibility = 'shared' and public.has_perm('service.calendar.manage', 'edit')
                and public.calendar_entry_visible(t.id, public.current_user_email()))));
$$;

-- Add or change an entry. p: id (change) or nothing (new), tech_email, kind,
-- title, customer_id, customer_text, all_day, starts_at, ends_at, start_date,
-- end_date, notes, order_id, visibility, shares [{type, target}]. On a change
-- only the fields sent are changed (dragging sends the dates and times).
create or replace function public.save_calendar_entry(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     text := public.current_user_email();
  v_old    public.tech_calendar_entries%rowtype;
  v_new    public.tech_calendar_entries%rowtype;
  v_id     uuid;
  v_keys   text[];
  v_shares jsonb;
  s        jsonb;
begin
  perform public.require_perm('service.calendar', 'view');
  if p ? 'id' and nullif(p ->> 'id', '') is not null then
    select * into v_old from public.tech_calendar_entries where id = (p ->> 'id')::uuid;
    if v_old.id is null or not public.calendar_entry_editable(v_old.id) then
      raise exception 'You cannot change this calendar entry.' using errcode = '42501';
    end if;
    v_new := v_old;
  else
    v_new.tech_email := v_me;
    v_new.kind := 'other';
    v_new.all_day := true;
    v_new.visibility := 'private';
    v_new.created_by := v_me;
  end if;

  if p ? 'tech_email' then v_new.tech_email := lower(nullif(btrim(p ->> 'tech_email'), '')); end if;
  if p ? 'kind' then v_new.kind := p ->> 'kind'; end if;
  if p ? 'title' then v_new.title := p ->> 'title'; end if;
  if p ? 'customer_id' then v_new.customer_id := nullif(p ->> 'customer_id', '')::uuid; end if;
  if p ? 'customer_text' then v_new.customer_text := nullif(btrim(p ->> 'customer_text'), ''); end if;
  if p ? 'all_day' then v_new.all_day := coalesce((p ->> 'all_day')::boolean, true); end if;
  if p ? 'starts_at' then v_new.starts_at := nullif(p ->> 'starts_at', '')::timestamptz; end if;
  if p ? 'ends_at' then v_new.ends_at := nullif(p ->> 'ends_at', '')::timestamptz; end if;
  if p ? 'start_date' then v_new.start_date := (p ->> 'start_date')::date; end if;
  if p ? 'end_date' then v_new.end_date := (p ->> 'end_date')::date; end if;
  if p ? 'notes' then v_new.notes := nullif(btrim(p ->> 'notes'), ''); end if;
  if p ? 'order_id' then v_new.order_id := nullif(p ->> 'order_id', '')::uuid; end if;
  if p ? 'visibility' then v_new.visibility := p ->> 'visibility'; end if;

  if v_new.tech_email is null or not exists (select 1 from public.allowed_users a where a.email = v_new.tech_email) then
    raise exception 'Choose whose calendar this entry is on.' using errcode = '22023';
  end if;
  -- Someone else's calendar: Calendar → manage, and never private (they made it for the owner).
  if v_new.tech_email <> v_me and (v_old.id is null or v_new.tech_email is distinct from v_old.tech_email) then
    perform public.require_perm('service.calendar.manage', 'edit');
  end if;
  if v_new.tech_email <> v_me and v_new.visibility = 'private' then
    raise exception 'An entry on someone else''s calendar must be shared, so you can still see it.' using errcode = '22023';
  end if;
  -- Service and training kinds and an order link belong to Service / Training.
  if (v_new.kind <> 'other' and (v_old.id is null or v_new.kind is distinct from v_old.kind))
     or (v_new.order_id is not null and v_new.order_id is distinct from v_old.order_id) then
    if not public.has_perm('service', 'view') then
      raise exception 'Only people with the Service / Training page can add travel, on-site and training entries or link an order.' using errcode = '42501';
    end if;
  end if;
  if v_new.order_id is not null and not exists (select 1 from public.orders o where o.id = v_new.order_id) then
    raise exception 'That order does not exist.' using errcode = '22023';
  end if;
  if v_new.start_date is null or v_new.end_date is null then
    raise exception 'Enter the dates.' using errcode = '22023';
  end if;

  -- Shares: sent ones replace the old ones; a new service entry without any
  -- gets the Service / Training team.
  v_shares := case
    when p ? 'shares' then coalesce(p -> 'shares', '[]'::jsonb)
    when v_old.id is null and v_new.visibility = 'shared' then
      coalesce((select value -> 'service_team' from public.app_settings where key = 'calendar'), '[]'::jsonb)
  end;
  if v_new.visibility = 'private' then
    v_shares := '[]'::jsonb;
  end if;
  if v_shares is not null then
    select coalesce(array_agg((x ->> 'type') || ':' || lower(x ->> 'target') order by 1), '{}') into v_keys
      from jsonb_array_elements(v_shares) x;
    if v_new.visibility = 'shared' and cardinality(v_keys) = 0 then
      raise exception 'Choose who the entry is shared with, or make it private.' using errcode = '22023';
    end if;
    -- Sharing with anyone other than the Service / Training team needs
    -- Calendar → share; the team is always allowed for service and training entries.
    if cardinality(v_keys) > 0
       and not (v_new.kind <> 'other' and v_keys <@ coalesce((select array_agg(lower(k)) from unnest(public.calendar_team_keys()) k), '{}'))
       and not (v_old.id is not null and v_keys = coalesce((
             select array_agg(s2.share_type || ':' || lower(coalesce(s2.user_email, s2.group_id::text, s2.department_id::text)) order by 1)
               from public.calendar_entry_shares s2 where s2.entry_id = v_old.id), '{}')) then
      perform public.require_perm('service.calendar.share', 'edit');
    end if;
  end if;

  if v_old.id is null then
    insert into public.tech_calendar_entries (tech_email, kind, title, customer_id, customer_text, all_day, starts_at, ends_at,
                                              start_date, end_date, notes, order_id, visibility, created_by)
    values (v_new.tech_email, v_new.kind, v_new.title, v_new.customer_id, v_new.customer_text, v_new.all_day, v_new.starts_at, v_new.ends_at,
            v_new.start_date, v_new.end_date, v_new.notes, v_new.order_id, v_new.visibility, v_me)
    returning id into v_id;
  else
    v_id := v_old.id;
    update public.tech_calendar_entries
       set tech_email = v_new.tech_email, kind = v_new.kind, title = v_new.title, customer_id = v_new.customer_id,
           customer_text = v_new.customer_text, all_day = v_new.all_day, starts_at = v_new.starts_at, ends_at = v_new.ends_at,
           start_date = v_new.start_date, end_date = v_new.end_date, notes = v_new.notes, order_id = v_new.order_id,
           visibility = v_new.visibility
     where id = v_id;
  end if;

  if v_shares is not null then
    delete from public.calendar_entry_shares where entry_id = v_id;
    for s in select * from jsonb_array_elements(v_shares) loop
      if s ->> 'type' = 'user' then
        if not exists (select 1 from public.allowed_users a where a.email = lower(s ->> 'target')) then
          raise exception 'One of the people chosen no longer has access.' using errcode = '22023';
        end if;
        insert into public.calendar_entry_shares (entry_id, share_type, user_email) values (v_id, 'user', lower(s ->> 'target')) on conflict do nothing;
      elsif s ->> 'type' = 'group' then
        insert into public.calendar_entry_shares (entry_id, share_type, group_id) values (v_id, 'group', (s ->> 'target')::uuid) on conflict do nothing;
      elsif s ->> 'type' = 'department' then
        insert into public.calendar_entry_shares (entry_id, share_type, department_id) values (v_id, 'department', (s ->> 'target')::uuid) on conflict do nothing;
      else
        raise exception 'Share an entry with people, groups or departments.' using errcode = '22023';
      end if;
    end loop;
  end if;
  return v_id;
end;
$$;

create or replace function public.archive_calendar_entry(p_entry uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('service.calendar', 'view');
  if not public.calendar_entry_editable(p_entry) then
    raise exception 'You cannot change this calendar entry.' using errcode = '42501';
  end if;
  update public.tech_calendar_entries set archived = true where id = p_entry;
end;
$$;

-- One entry with its shares, for the entry window (only when I can see it).
create or replace function public.calendar_entry_details(p_entry uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.tech_calendar_entries%rowtype;
begin
  perform public.require_perm('service.calendar', 'view');
  select * into v from public.tech_calendar_entries where id = p_entry and not archived;
  if v.id is null or not public.calendar_entry_visible(v.id, public.current_user_email()) then
    raise exception 'This calendar entry is not shared with you.' using errcode = '42501';
  end if;
  return to_jsonb(v) || jsonb_build_object(
    'owner_name', (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = v.tech_email),
    'editable', public.calendar_entry_editable(v.id),
    'order_code', (select o.order_code from public.orders o where o.id = v.order_id),
    'shares', coalesce((select jsonb_agg(jsonb_build_object('type', s.share_type,
                                 'target', coalesce(s.user_email, s.group_id::text, s.department_id::text),
                                 'name', coalesce((select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = s.user_email),
                                                  (select g.name from public.user_groups g where g.id = s.group_id),
                                                  (select d.name from public.departments d where d.id = s.department_id))))
                          from public.calendar_entry_shares s where s.entry_id = v.id), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 3. What the Calendar shows
-- ===========================================================================
drop function public.calendar_entries(date, date, text);
drop function public.calendar_feed(text);
drop function public.calendar_rows(text, date, date, boolean);

-- Internal: every row (no visibility check; calendar_entries and calendar_feed filter).
create function public.calendar_rows(p_tech text, p_from date, p_to date, p_with_phone boolean)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text, end_at timestamptz,
               done boolean, visibility text)
language sql
stable
security definer
set search_path = public
as $$
  with rows as (
    select 'training'::text as source, o.id::text as source_id, o.technician_email as tech_email, 'training'::text as kind,
           o.service_start as start_date, coalesce(o.service_end, o.service_start) as end_date,
           'Training – ' || coalesce(c.name, 'customer') || ' (Order ' || o.order_code || ')' as title,
           c.name as customer, c.country, null::text as notes, '/service/' || o.id as link,
           false as from_phone, null::timestamptz as start_at, null::text as location, null::timestamptz as end_at,
           o.training_done_at is not null as done, 'shared'::text as visibility
      from public.orders o left join public.customers c on c.id = o.customer_id
     where o.technician_email is not null and o.service_start is not null and not o.archived and o.stage <> 'Cancelled'
    union all
    select 'service_call', sc.card_id::text, sc.technician_email, 'service',
           sc.planned_start, coalesce(sc.planned_end, sc.planned_start),
           'Service call S-' || sc.call_number || ' – ' || coalesce(cu.name, bc.title),
           cu.name, cu.country, bc.title, '/service/calls/' || sc.card_id,
           false, null, null, null, bc.finished_at is not null, 'shared'
      from public.service_calls sc
      join public.board_cards bc on bc.id = sc.card_id and not bc.archived
      left join public.customers cu on cu.id = sc.customer_id
     where sc.technician_email is not null and sc.planned_start is not null
    union all
    select 'travel_log', e.id::text, e.created_by, 'travel', e.entry_date, e.entry_date,
           'Travel – ' || coalesce(cu.name, 'customer'), cu.name, cu.country, e.notes,
           case when e.order_id is not null then '/service/' || e.order_id else '/service/calls/' || e.service_call_id end,
           false, null, null, null, true, 'shared'
      from public.service_entries e
      left join public.orders o on o.id = e.order_id
      left join public.service_calls sc on sc.card_id = e.service_call_id
      left join public.customers cu on cu.id = coalesce(o.customer_id, sc.customer_id)
     where e.kind = 'travel' and not e.archived and e.created_by is not null
    union all
    select 'manual', t.id::text, t.tech_email, t.kind, t.start_date, t.end_date,
           coalesce(t.title,
             (case t.kind when 'travel' then 'Travel' when 'onsite' then 'On site' when 'training' then 'Training' else 'Calendar entry' end)
             || coalesce(' – ' || coalesce(cu.name, nullif(btrim(t.customer_text), '')), '')),
           coalesce(cu.name, nullif(btrim(t.customer_text), '')), cu.country, t.notes,
           case when t.order_id is not null then '/service/' || t.order_id end,
           false, case when t.all_day then null else t.starts_at end, null, case when t.all_day then null else t.ends_at end,
           t.done_at is not null, t.visibility
      from public.tech_calendar_entries t left join public.customers cu on cu.id = t.customer_id
     where not t.archived
    union all
    -- Read from the technician's own phone calendar ("From phone"); never sent back out.
    select 'phone', p.id::text, p.user_email, p.kind, p.start_date, p.end_date,
           p.title, coalesce(cu.name, cu2.name), coalesce(cu.country, cu2.country), p.description,
           case when p.order_id is not null then '/service/' || p.order_id end,
           true, case when p.all_day then null else p.start_at end, p.location, case when p.all_day then null else p.end_at end,
           false, 'shared'
      from public.tech_phone_events p
      left join public.customers cu on cu.id = p.customer_id
      left join public.orders o on o.id = p.order_id
      left join public.customers cu2 on cu2.id = o.customer_id
     where p_with_phone
  )
  select r.source, r.source_id, r.tech_email,
         (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = r.tech_email),
         r.kind, r.start_date, r.end_date, r.title, r.customer, r.country, r.notes, r.link, r.from_phone, r.start_at, r.location, r.end_at,
         r.done, r.visibility
    from rows r
   where (p_tech is null or r.tech_email = p_tech)
     and r.start_date <= p_to and r.end_date >= p_from
   order by r.start_date, r.start_at nulls first, r.tech_email, r.title;
$$;

-- What the Calendar shows. p_tech = me: my rows plus entries shared with me;
-- someone else (service.calendar.all): their rows, their entries only when
-- shared with me; null (all): everything, entries only when I can see them.
-- Training visits, service calls and travel logs need the Service / Training
-- page, unless I am the technician.
create function public.calendar_entries(p_from date, p_to date, p_tech text default null)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text, end_at timestamptz,
               done boolean, visibility text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me      text := public.current_user_email();
  v_tech    text := lower(p_tech);
  v_service boolean := public.has_perm('service', 'view');
begin
  perform public.require_perm('service.calendar', 'view');
  if v_tech is distinct from v_me then
    perform public.require_perm('service.calendar.all', 'view');
  end if;
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a shorter period.';
  end if;
  return query
    select r.* from public.calendar_rows(null, p_from, p_to, true) r
     where case
             when r.source = 'manual' then
               public.calendar_entry_visible(r.source_id::uuid, v_me)
               and (v_tech is null or r.tech_email = v_tech or v_tech = v_me)
             else (v_tech is null or r.tech_email = v_tech)
           end
       and (r.source not in ('training', 'service_call', 'travel_log') or v_service or r.tech_email = v_me)
    union all
    select 'event'::text, e.id::text, null::text, null::text, 'event'::text, e.start_date, e.end_date,
           e.title, null::text, null::text, e.description_text, '/notices?event=' || e.id,
           false, e.starts_at, e.location, e.ends_at, false, 'shared'::text
      from public.company_events e
     where not e.archived and e.start_date <= p_to and e.end_date >= p_from
       and (v_tech is null or v_tech = v_me)
       and public.has_perm('notices.events', 'view')
       and public.event_is_for(e.id, v_me)
    order by 6, 14 nulls first, 3, 8;
end;
$$;

-- Outgoing phone link (calendar-feed): my rows and entries shared with me,
-- never what came from a phone.
create function public.calendar_feed(p_token text)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text, end_at timestamptz,
               done boolean, visibility text)
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
  return query
    select r.* from public.calendar_rows(null, current_date - 120, current_date + 400, false) r
     where case when r.source = 'manual' then public.calendar_entry_visible(r.source_id::uuid, v_email)
                else r.tech_email = v_email end;
end;
$$;

-- ===========================================================================
-- 4. Training done
-- ===========================================================================
-- (orders.training_done_* were added in part 2.)

-- Only mark_training_done changes these (the table is otherwise editable field by field).
create or replace function public.orders_training_done_guard()
returns trigger
language plpgsql
as $$
begin
  if (new.training_done_at, new.training_done_by, new.training_done_by_name)
       is distinct from (old.training_done_at, old.training_done_by, old.training_done_by_name)
     and coalesce(current_setting('app.training_done', true), '') <> 'on' then
    raise exception 'Use “Mark Training as Done” to change this.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger orders_training_done_guard before update on public.orders
  for each row execute function public.orders_training_done_guard();

-- The Service lists show it (columns added at the end).
create or replace view public.order_service_info
with (security_invoker = false)
as
select o.id as order_id, o.order_code, o.order_number, o.split_number, o.stage, o.archived,
       c.name as customer_name, c.company as customer_company, c.country as customer_country,
       c.state_province as customer_state_province,
       o.training_needed, o.training_days, o.travel_days, o.technician_email,
       (select coalesce(nullif(btrim(a.name), ''), a.email) from public.allowed_users a where a.email = o.technician_email) as technician_name,
       o.service_start, o.service_end,
       s.first_onsite, s.last_onsite, coalesce(s.entries, 0) as entries, coalesce(s.hours, 0) as hours,
       (select sc.status from public.service_certificates sc where sc.order_id = o.id order by sc.version desc limit 1) as certificate_status,
       o.training_done_at, o.training_done_by_name
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

-- What "Mark Training as Done" will complete: open ordinary cards linked to
-- the order on boards I can open (suggested: "training" in the title or a
-- label), and the order's open calendar entries.
create or replace function public.training_done_candidates(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('service.training.done', 'edit');
  return jsonb_build_object(
    'cards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'title', c.title, 'board_id', c.board_id, 'board_name', b.name, 'stage_name', st.name,
               'suggested', c.title ilike '%training%' or exists (
                 select 1 from public.board_card_labels cl join public.board_labels l on l.id = cl.label_id
                  where cl.card_id = c.id and l.name ilike '%training%'),
               'can_complete', public.board_level(c.board_id) >= 2
                               and public.has_any_perm(array['boards.card.timing', 'boards.card.complete'], 'edit'))
             order by c.title)
        from public.board_cards c
        join public.boards b on b.id = c.board_id and not b.archived and b.closed_at is null
        join public.board_stages st on st.id = c.stage_id
       where c.order_id = p_order and not c.archived and c.finished_at is null and c.card_kind = 'task'
         and public.board_level(c.board_id) >= 1), '[]'::jsonb),
    'entries', (select count(*) from public.tech_calendar_entries t
                 where t.order_id = p_order and not t.archived and t.done_at is null));
end;
$$;

-- Mark training as done (who and when), complete the chosen cards (only where
-- I may complete cards on that board; others are reported as skipped) and the
-- order's calendar entries. p_done = false takes the mark off again (cards and
-- entries stay complete; reopen cards on their board).
create or replace function public.mark_training_done(p_order uuid, p_done boolean, p_cards uuid[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      text := public.current_user_email();
  v_name    text := public.current_user_name();
  v_order   public.orders%rowtype;
  v_card    public.board_cards%rowtype;
  v_done    integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_entries integer := 0;
begin
  perform public.require_perm('service.training.done', 'edit');
  select * into v_order from public.orders where id = p_order;
  if v_order.id is null or v_order.archived or v_order.stage = 'Cancelled' then
    raise exception 'This order cannot be changed.' using errcode = '22023';
  end if;
  if not (v_order.training_needed or v_order.technician_email is not null or v_order.service_start is not null) then
    raise exception 'This order has no on-site training.' using errcode = '22023';
  end if;
  perform set_config('app.training_done', 'on', true);

  -- Only these three columns change; the field check (check_field_permissions)
  -- is passed as a system change for this one update, then switched off again.
  perform public.system_on();
  if not p_done then
    update public.orders set training_done_at = null, training_done_by = null, training_done_by_name = null where id = p_order;
  elsif v_order.training_done_at is null then
    update public.orders set training_done_at = now(), training_done_by = v_me, training_done_by_name = v_name where id = p_order;
  end if;
  perform set_config('app.system_change', '', true);
  perform set_config('app.training_done', '', true);
  if not p_done then
    return jsonb_build_object('done', false);
  end if;

  update public.tech_calendar_entries
     set done_at = now(), done_by = v_me, done_by_name = v_name
   where order_id = p_order and not archived and done_at is null;
  get diagnostics v_entries = row_count;

  for v_card in select * from public.board_cards where id = any(coalesce(p_cards, '{}')) loop
    if v_card.order_id is distinct from p_order or v_card.archived or v_card.finished_at is not null or v_card.card_kind <> 'task' then
      v_skipped := v_skipped || jsonb_build_object('title', v_card.title, 'reason', 'not an open card of this order');
    elsif public.board_level(v_card.board_id) < 2
          or not public.has_any_perm(array['boards.card.timing', 'boards.card.complete'], 'edit')
          or exists (select 1 from public.boards b where b.id = v_card.board_id and (b.closed_at is not null or b.archived)) then
      v_skipped := v_skipped || jsonb_build_object('title', v_card.title, 'reason', 'you cannot complete cards on that board');
    else
      -- The card guard stamps who and when.
      update public.board_cards set started_at = coalesce(started_at, now()), finished_at = now() where id = v_card.id;
      v_done := v_done + 1;
    end if;
  end loop;
  return jsonb_build_object('done', true, 'cards_done', v_done, 'cards_skipped', v_skipped, 'entries_done', v_entries);
end;
$$;

-- ===========================================================================
-- 5. Service / Training summary
-- ===========================================================================
-- Days in the period: "so far" = logged in the day log up to today;
-- "scheduled" = planned from tomorrow to the end of the period.
--   Travel: logged travel days (one per person and day) / planned travel days
--     (calendar entries of kind travel, plus the travel days of training
--     visits that start later in the period).
--   On-site training: logged on-site days on orders (one per order and day) /
--     days of training visits not marked done.
--   Service calls: logged on-site days on calls (one per call and day) / days
--     planned on calls that are not done.
create or replace function public.service_day_summary(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'America/Halifax')::date;
  v_last  date;
  v_next  date;
  v_res   jsonb;
begin
  perform public.require_perm('service.summary', 'view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a period of up to ten years.' using errcode = '22023';
  end if;
  v_last := least(p_to, v_today);
  v_next := greatest(p_from, v_today + 1);
  select jsonb_build_object(
    'today', v_today,
    'travel_done', (select count(distinct (e.created_by, e.entry_date)) from public.service_entries e
                     where e.kind = 'travel' and not e.archived and e.entry_date between p_from and v_last),
    'travel_scheduled',
      (select count(*) from public.tech_calendar_entries t
        cross join lateral generate_series(greatest(t.start_date, v_next), least(t.end_date, p_to), interval '1 day') d
        where t.kind = 'travel' and not t.archived and t.done_at is null and t.visibility = 'shared')
      + (select coalesce(sum(coalesce(o.travel_days, 0)), 0) from public.orders o
          where not o.archived and o.stage <> 'Cancelled' and o.training_done_at is null
            and o.service_start between v_next and p_to),
    'training_done', (select count(distinct (e.order_id, e.entry_date)) from public.service_entries e
                       where e.kind = 'onsite' and not e.archived and e.order_id is not null and e.entry_date between p_from and v_last),
    'training_scheduled', (select count(*) from public.orders o
        cross join lateral generate_series(greatest(o.service_start, v_next), least(coalesce(o.service_end, o.service_start), p_to), interval '1 day') d
        where not o.archived and o.stage <> 'Cancelled' and o.training_done_at is null and o.service_start is not null),
    'training_unscheduled', (select count(*) from public.orders o
        where not o.archived and o.stage <> 'Cancelled' and o.training_needed and o.training_done_at is null and o.service_start is null),
    'calls_done', (select count(distinct (e.service_call_id, e.entry_date)) from public.service_entries e
                    where e.kind = 'onsite' and not e.archived and e.service_call_id is not null and e.entry_date between p_from and v_last),
    'calls_scheduled', (select count(*) from public.service_calls sc
        join public.board_cards bc on bc.id = sc.card_id and not bc.archived and bc.finished_at is null
        cross join lateral generate_series(greatest(sc.planned_start, v_next), least(coalesce(sc.planned_end, sc.planned_start), p_to), interval '1 day') d
        where sc.planned_start is not null)
  ) into v_res;
  return v_res;
end;
$$;

-- ===========================================================================
-- 6. The Calendar is its own page
-- ===========================================================================
alter table public.user_preferences drop constraint user_preferences_start_page_check;
update public.user_preferences set start_page = '/calendar' where start_page = '/service/calendar';
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/freight', '/reports/department-delays',
     '/reports/build-times', '/machines', '/boards', '/notices', '/service', '/calendar', '/chat', '/agent', '/settings', '/admin', '/shop-board',
     '/timesheets', '/my-timesheet', '/time-off'));

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
