-- 0035_company_events.sql
-- Upcoming events on the Notice Board: staff meetings, safety training,
-- inspections, customer or supplier visits, trade shows, team lunches...
--
-- 1. company_events: title, all day or a start (and end) time, or a date
--    range, location, description (rich text), optional colour, the same
--    audience choice as notices (everyone, or people, groups and departments),
--    optional RSVP, and reminders (minutes before; default one day and one hour).
--    People only see the events meant for them. Past events (after their last
--    day) move to the Notice Board Archive.
-- 2. company_event_rsvps: Going / Not going / Maybe. Everyone sees the counts;
--    the organizer sees the list.
-- 3. Reminders are sent by notice_board_tick() (every minute, and when the
--    Notice Board opens) as in-app notifications and phone push. People who
--    answered "Not going" get no reminders.
-- 4. The Tech Calendar shows the events meant for the person looking at it.

-- ===========================================================================
-- 1. Events
-- ===========================================================================
create table public.company_events (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (btrim(title) <> '' and length(title) <= 200),
  -- Rich text; description_text is the plain version (calendar files, search).
  description       text not null default '' check (length(description) <= 20000),
  description_text  text not null default '',
  location          text check (location is null or length(location) <= 300),
  all_day           boolean not null default false,
  -- Timed events: starts_at (and optional ends_at). All-day events: dates only.
  starts_at         timestamptz,
  ends_at           timestamptz,
  -- First and last day (Halifax); filled from the times for timed events.
  start_date        date not null,
  end_date          date not null,
  colour            text check (colour is null or colour in ('blue', 'green', 'amber', 'red', 'purple', 'teal', 'slate')),
  audience_everyone boolean not null default true,
  rsvp_enabled      boolean not null default false,
  -- Reminders, in minutes before the start (all-day events start at 8:00 a.m.).
  remind_minutes    integer[] not null default '{1440,60}',
  organizer_email   text references public.allowed_users (email) on delete set null on update cascade,
  organizer_name    text,
  edited_at         timestamptz,
  archived          boolean not null default false,
  archived_at       timestamptz,
  archived_by       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (all_day or starts_at is not null),
  check (ends_at is null or starts_at is null or ends_at >= starts_at),
  check (end_date >= start_date and end_date - start_date <= 60),
  check (cardinality(remind_minutes) <= 5)
);
create index company_events_dates_idx on public.company_events (archived, start_date, end_date);
alter table public.company_events enable row level security;

create table public.company_event_audience (
  event_id    uuid not null references public.company_events (id) on delete cascade,
  target_type text not null check (target_type in ('user', 'group', 'department')),
  target      text not null,
  primary key (event_id, target_type, target)
);
alter table public.company_event_audience enable row level security;

create table public.company_event_rsvps (
  event_id     uuid not null references public.company_events (id) on delete cascade,
  user_email   text not null references public.allowed_users (email) on delete cascade on update cascade,
  response     text not null check (response in ('going', 'not_going', 'maybe')),
  responded_at timestamptz not null default now(),
  primary key (event_id, user_email)
);
alter table public.company_event_rsvps enable row level security;

-- Dates from the times (Halifax), plain description, safe rich text.
create or replace function public.company_events_fill()
returns trigger
language plpgsql
as $$
begin
  if new.all_day then
    new.starts_at := null;
    new.ends_at := null;
    new.end_date := coalesce(new.end_date, new.start_date);
  else
    new.start_date := (new.starts_at at time zone 'America/Halifax')::date;
    new.end_date := (coalesce(new.ends_at, new.starts_at) at time zone 'America/Halifax')::date;
  end if;
  new.description := coalesce(new.description, '');
  new.description_text := left(public.chat_plain(new.description), 10000);
  new.location := nullif(btrim(coalesce(new.location, '')), '');
  select coalesce(array_agg(distinct m order by m desc), '{}') into new.remind_minutes
    from unnest(coalesce(new.remind_minutes, '{}')) m where m between 5 and 20160;
  return new;
end;
$$;
create trigger company_events_fill before insert or update on public.company_events
  for each row execute function public.company_events_fill();
create trigger company_events_safe_description before insert or update of description on public.company_events
  for each row execute function public.reject_unsafe_notes('description');
create trigger company_events_updated_at before update on public.company_events
  for each row execute function public.set_updated_at();
create trigger company_events_archived_info before insert or update of archived on public.company_events
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.company_events
  for each row execute function public.log_activity();

-- Is this event for this person? (everyone, or them, their groups or departments)
create or replace function public.event_is_for(p_event uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_events e
     where e.id = p_event
       and (e.audience_everyone
            or exists (select 1 from public.company_event_audience a
                        where a.event_id = e.id
                          and ((a.target_type = 'user' and a.target = lower(p_email))
                               or (a.target_type = 'group' and exists (
                                     select 1 from public.user_group_members m join public.user_groups g on g.id = m.group_id
                                      where m.group_id::text = a.target and m.user_email = lower(p_email) and not g.archived))
                               or (a.target_type = 'department' and exists (
                                     select 1 from public.user_departments d
                                      where d.department_id::text = a.target and d.user_email = lower(p_email)))))));
$$;

-- Everyone an event is for who may see events.
create or replace function public.event_people(p_event uuid)
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.event_is_for(p_event, a.email) and public.perm_of(a.email, 'notices.events')
   order by 2;
$$;

-- The organizer, or a full admin.
create or replace function public.event_can_manage(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or exists (select 1 from public.company_events e where e.id = p_event and e.organizer_email = public.current_user_email());
$$;

-- Can the signed-in person see this event? Its audience; past and cancelled
-- events also need the Archive permission. The organizer always sees it.
create or replace function public.event_visible(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_perm('notices.events', 'view')
     and (public.event_can_manage(p_event)
          or (public.event_is_for(p_event, public.current_user_email())
              and (exists (select 1 from public.company_events e
                            where e.id = p_event and not e.archived and e.end_date >= public.halifax_today())
                   or public.has_perm('notices.archive', 'view'))));
$$;

create policy "Event readers" on public.company_events
  for select to authenticated using ((select public.event_visible(id)));
create policy "Event readers" on public.company_event_audience
  for select to authenticated using ((select public.event_visible(event_id)));
create policy "Own answers" on public.company_event_rsvps
  for select to authenticated using (user_email = (select public.current_user_email()));
-- Every change goes through the functions below.
revoke insert, update, delete on public.company_events, public.company_event_audience, public.company_event_rsvps from authenticated;
revoke all on public.company_events, public.company_event_audience, public.company_event_rsvps from anon;

-- Create or change an event. p: {id?, title, description, location, all_day,
-- starts_at, ends_at, start_date, end_date, colour, everyone,
-- audience: [{type: user|group|department, target}], rsvp_enabled,
-- remind_minutes: [1440, 60]}. Returns the event id.
create or replace function public.save_company_event(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me       text := public.current_user_email();
  v_id       uuid := nullif(p ->> 'id', '')::uuid;
  v_everyone boolean := coalesce((p ->> 'everyone')::boolean, true);
  v_all_day  boolean := coalesce((p ->> 'all_day')::boolean, false);
  v_aud      jsonb;
  v_t        record;
  v_remind   integer[];
begin
  perform public.require_perm('notices.events.post');
  if v_id is not null and not public.event_can_manage(v_id) then
    raise exception 'Only the organizer can change this event.' using errcode = '42501';
  end if;
  if nullif(btrim(p ->> 'title'), '') is null then
    raise exception 'Enter a title.' using errcode = '22023';
  end if;
  if v_all_day and nullif(p ->> 'start_date', '') is null then
    raise exception 'Choose the date.' using errcode = '22023';
  end if;
  if not v_all_day and nullif(p ->> 'starts_at', '') is null then
    raise exception 'Choose the date and start time.' using errcode = '22023';
  end if;
  if v_all_day and nullif(p ->> 'end_date', '') is not null and (p ->> 'end_date')::date < (p ->> 'start_date')::date then
    raise exception 'The last day must be on or after the first day.' using errcode = '22023';
  end if;
  if not v_all_day and nullif(p ->> 'ends_at', '') is not null and (p ->> 'ends_at')::timestamptz < (p ->> 'starts_at')::timestamptz then
    raise exception 'The end time must be after the start time.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(distinct jsonb_build_object('type', a ->> 'type', 'target', btrim(a ->> 'target'))), '[]'::jsonb)
    into v_aud
    from jsonb_array_elements(coalesce(p -> 'audience', '[]'::jsonb)) a
   where not v_everyone and nullif(btrim(a ->> 'target'), '') is not null;
  if not v_everyone and jsonb_array_length(v_aud) = 0 then
    raise exception 'Choose who the event is for: everyone, or at least one person, group or department.' using errcode = '22023';
  end if;
  for v_t in select a ->> 'type' as type, a ->> 'target' as target from jsonb_array_elements(v_aud) a loop
    if v_t.type = 'user' and not exists (select 1 from public.allowed_users where email = lower(v_t.target)) then
      raise exception 'No user with the email %.', v_t.target using errcode = '22023';
    elsif v_t.type = 'group' and not exists (select 1 from public.user_groups where id::text = v_t.target and not archived) then
      raise exception 'One of the chosen groups no longer exists.' using errcode = '22023';
    elsif v_t.type = 'department' and not exists (select 1 from public.departments where id::text = v_t.target and not archived) then
      raise exception 'One of the chosen departments no longer exists.' using errcode = '22023';
    elsif v_t.type not in ('user', 'group', 'department') then
      raise exception 'Unknown audience type %.', v_t.type using errcode = '22023';
    end if;
  end loop;

  select coalesce(array_agg(x::integer), '{}') into v_remind
    from jsonb_array_elements_text(coalesce(p -> 'remind_minutes', '[1440, 60]'::jsonb)) x;

  if v_id is null then
    insert into public.company_events (title, description, location, all_day, starts_at, ends_at, start_date, end_date,
                                       colour, audience_everyone, rsvp_enabled, remind_minutes, organizer_email, organizer_name)
    values (btrim(p ->> 'title'), coalesce(p ->> 'description', ''), p ->> 'location', v_all_day,
            nullif(p ->> 'starts_at', '')::timestamptz, nullif(p ->> 'ends_at', '')::timestamptz,
            coalesce(nullif(p ->> 'start_date', '')::date, public.halifax_today()), nullif(p ->> 'end_date', '')::date,
            nullif(p ->> 'colour', ''), v_everyone, coalesce((p ->> 'rsvp_enabled')::boolean, false), v_remind, v_me,
            coalesce((select nullif(btrim(name), '') from public.allowed_users where email = v_me), v_me))
    returning id into v_id;
  else
    update public.company_events
       set title = btrim(p ->> 'title'),
           description = coalesce(p ->> 'description', ''),
           location = p ->> 'location',
           all_day = v_all_day,
           starts_at = nullif(p ->> 'starts_at', '')::timestamptz,
           ends_at = nullif(p ->> 'ends_at', '')::timestamptz,
           start_date = coalesce(nullif(p ->> 'start_date', '')::date, start_date),
           end_date = nullif(p ->> 'end_date', '')::date,
           colour = nullif(p ->> 'colour', ''),
           audience_everyone = v_everyone,
           rsvp_enabled = coalesce((p ->> 'rsvp_enabled')::boolean, false),
           remind_minutes = v_remind,
           edited_at = now()
     where id = v_id;
    delete from public.company_event_audience where event_id = v_id;
  end if;
  insert into public.company_event_audience (event_id, target_type, target)
  select v_id, a ->> 'type', case when a ->> 'type' = 'user' then lower(a ->> 'target') else a ->> 'target' end
    from jsonb_array_elements(v_aud) a
  on conflict do nothing;
  return v_id;
end;
$$;

-- Cancel (archive) or restore an event: the organizer or a full admin.
create or replace function public.archive_company_event(p_event uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('notices.events.post');
  if not public.event_can_manage(p_event) then
    raise exception 'Only the organizer can cancel this event.' using errcode = '42501';
  end if;
  update public.company_events set archived = p_archived where id = p_event;
end;
$$;

-- Going / Not going / Maybe (null = clear my answer).
create or replace function public.set_event_rsvp(p_event uuid, p_response text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('notices.events.rsvp');
  if not public.event_visible(p_event) or not public.event_is_for(p_event, v_me) then
    raise exception 'That event could not be found.';
  end if;
  if not exists (select 1 from public.company_events
                  where id = p_event and rsvp_enabled and not archived and end_date >= public.halifax_today()) then
    raise exception 'This event does not take answers.' using errcode = '22023';
  end if;
  if p_response is null then
    delete from public.company_event_rsvps where event_id = p_event and user_email = v_me;
  elsif p_response not in ('going', 'not_going', 'maybe') then
    raise exception 'Choose Going, Not going or Maybe.' using errcode = '22023';
  else
    insert into public.company_event_rsvps (event_id, user_email, response) values (p_event, v_me, p_response)
    on conflict (event_id, user_email) do update set response = excluded.response, responded_at = now();
  end if;
end;
$$;

-- The events I can see, with the answer counts and my own answer.
-- p_past = false: not archived and not over; true: over or cancelled (Archive).
create or replace function public.my_company_events(p_past boolean default false)
returns table (id uuid, title text, description text, description_text text, location text, all_day boolean,
               starts_at timestamptz, ends_at timestamptz, start_date date, end_date date, colour text,
               audience_everyone boolean, rsvp_enabled boolean, remind_minutes integer[],
               organizer_email text, organizer_name text, edited_at timestamptz, archived boolean, created_at timestamptz,
               going integer, maybe integer, not_going integer, my_response text, can_manage boolean)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.title, e.description, e.description_text, e.location, e.all_day, e.starts_at, e.ends_at,
         e.start_date, e.end_date, e.colour, e.audience_everyone, e.rsvp_enabled, e.remind_minutes,
         e.organizer_email, e.organizer_name, e.edited_at, e.archived, e.created_at,
         (select count(*)::integer from public.company_event_rsvps r where r.event_id = e.id and r.response = 'going'),
         (select count(*)::integer from public.company_event_rsvps r where r.event_id = e.id and r.response = 'maybe'),
         (select count(*)::integer from public.company_event_rsvps r where r.event_id = e.id and r.response = 'not_going'),
         (select r.response from public.company_event_rsvps r where r.event_id = e.id and r.user_email = public.current_user_email()),
         public.event_can_manage(e.id)
    from public.company_events e
   where public.event_visible(e.id)
     and case when p_past then e.archived or e.end_date < public.halifax_today()
              else not e.archived and e.end_date >= public.halifax_today() end
   order by case when p_past then null else e.start_date end, e.starts_at nulls first,
            case when p_past then e.start_date end desc, e.title
   limit 300;
$$;

-- Who answered (and who hasn't): the organizer or a full admin.
create or replace function public.event_rsvp_list(p_event uuid)
returns table (email text, name text, response text, responded_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.event_can_manage(p_event) then
    raise exception 'Only the organizer can see who answered.' using errcode = '42501';
  end if;
  return query
    select p.email, p.name, r.response, r.responded_at
      from public.event_people(p_event) p
      left join public.company_event_rsvps r on r.event_id = p_event and r.user_email = p.email
     order by case r.response when 'going' then 1 when 'maybe' then 2 when 'not_going' then 3 else 4 end, p.name;
end;
$$;

-- Everyone who can sign in, for the organizer's "who is it for" picker.
create or replace function public.event_people_choices()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.has_perm('notices.events.post', 'edit')
   order by 2;
$$;

-- ===========================================================================
-- 2. Reminders (in-app and phone push)
-- ===========================================================================
insert into public.notification_kinds (kind, label, description, sort_order, default_modes) values
  ('event_reminder', 'Event reminders', 'A reminder before an event on the Notice Board that is meant for you.', 84,
   '{"app": "on", "email": "off", "push": "on"}')
on conflict (kind) do nothing;

-- When the event starts (all-day events: 8:00 a.m. Halifax on the first day).
create or replace function public.event_moment(e public.company_events)
returns timestamptz
language sql
stable
as $$
  select coalesce(e.starts_at, (e.start_date + time '08:00') at time zone 'America/Halifax');
$$;

-- Sends the reminders that are due (once per person, reminder and start time).
create or replace function public.company_events_tick()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  select p.email, 'event_reminder',
         case when m < 1440 then
                case when m >= 60 and m % 60 = 0 then 'In ' || (m / 60) || case when m = 60 then ' hour: ' else ' hours: ' end
                     else 'In ' || m || ' minutes: ' end
              else
                case (public.event_moment(e) at time zone 'America/Halifax')::date - public.halifax_today()
                  when 0 then 'Today: ' when 1 then 'Tomorrow: '
                  else 'On ' || to_char(public.event_moment(e) at time zone 'America/Halifax', 'FMDay') || ': ' end
         end || e.title,
         to_char(public.event_moment(e) at time zone 'America/Halifax',
                 case when e.all_day then 'FMDay, Mon FMDD' else 'FMDay, Mon FMDD, FMHH12:MI AM' end)
           || case when e.all_day and e.end_date > e.start_date then ' to ' || to_char(e.end_date, 'Mon FMDD') else '' end
           || coalesce(' · ' || e.location, ''),
         '/notices?event=' || e.id,
         'event:' || e.id || ':' || m || ':' || extract(epoch from public.event_moment(e))::bigint
    from public.company_events e
    cross join lateral unnest(e.remind_minutes) m
    cross join lateral public.event_people(e.id) p
   where not e.archived
     and e.start_date between public.halifax_today() - 1 and public.halifax_today() + 15
     and public.event_moment(e) > now()
     and now() >= public.event_moment(e) - make_interval(mins => m)
     -- When several reminders are due at once (the event was added or moved late), send only the closest one.
     and not exists (select 1 from unnest(e.remind_minutes) m2
                      where m2 < m and now() >= public.event_moment(e) - make_interval(mins => m2))
     and not exists (select 1 from public.company_event_rsvps r
                      where r.event_id = e.id and r.user_email = p.email and r.response = 'not_going')
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The Notice Board job (every minute, and when the board opens) now also sends event reminders.
create or replace function public.notice_board_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today   date := public.halifax_today();
  v_morning boolean := (now() at time zone 'America/Halifax')::time >= time '07:00';
  v_id      uuid;
  v_notices integer := 0;
  v_notes   integer := 0;
begin
  for v_id in
    select n.id from public.notices n
     where n.announced_at is null and not n.archived and n.priority <> 'normal'
       and n.show_from <= v_today and (n.show_until is null or n.show_until >= v_today)
       and (v_morning or n.show_from < v_today
            or n.created_at >= (v_today::timestamp at time zone 'America/Halifax'))
  loop
    v_notices := v_notices + public.notice_announce(v_id);
  end loop;

  with due as (
    update public.personal_notes
       set reminded_at = now()
     where remind_at <= now() and reminded_at is null
    returning id, owner_email, title, body, checklist
  )
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  select owner_email, 'note_reminder',
         'Reminder: ' || coalesce(nullif(btrim(title), ''), nullif(left(btrim(split_part(body, E'\n', 1)), 80), ''), 'your note'),
         nullif(left(btrim(body), 300), ''),
         '/notices?view=mine&note=' || id, 'note:' || id || ':' || to_char(now(), 'YYYYMMDDHH24MI')
    from due
  on conflict do nothing;
  get diagnostics v_notes = row_count;
  return jsonb_build_object('notices', v_notices, 'reminders', v_notes, 'events', public.company_events_tick());
end;
$$;

-- ===========================================================================
-- 3. The Tech Calendar shows the events meant for the person looking at it
-- ===========================================================================
create or replace function public.calendar_entries(p_from date, p_to date, p_tech text default null)
returns table (source text, source_id text, tech_email text, tech_name text, kind text, start_date date, end_date date,
               title text, customer text, country text, notes text, link text,
               from_phone boolean, start_at timestamptz, location text)
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
  return query
    select * from public.calendar_rows(lower(p_tech), p_from, p_to, true)
    union all
    select 'event'::text, e.id::text, null::text, null::text, 'event'::text, e.start_date, e.end_date,
           e.title, null::text, null::text, e.description_text, '/notices?event=' || e.id,
           false, e.starts_at, e.location
      from public.company_events e
     where not e.archived and e.start_date <= p_to and e.end_date >= p_from
       and (p_tech is null or lower(p_tech) = public.current_user_email())
       and public.has_perm('notices.events', 'view')
       and public.event_is_for(e.id, public.current_user_email())
    order by 6, 14 nulls first, 3, 8;
end;
$$;

-- Access lockdown, as in earlier migrations.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
revoke execute on function public.calendar_rows(text, date, date, boolean) from authenticated;
revoke execute on function public.calendar_feed(text) from authenticated;
grant execute on function public.calendar_feed(text) to service_role;
