-- 0034_notice_board.sql
-- The Notice Board: notices for the whole company or for chosen people,
-- groups and departments, plus everyone's private "My notes".
--
-- 1. Categories: a new dropdown list "notice_category" (Admin → Dropdown lists).
-- 2. Notification types for notices. Important notices always go to the app
--    and phone push; Urgent notices also always go by email (people cannot
--    turn these off), and Urgent phone pushes are sent even in quiet hours.
-- 3. notices (+ notice_audience, notice_reads, notice_reactions,
--    notice_comments). Everything is written through the functions below,
--    which check the permissions ("post to everyone" / "post to my own
--    departments only", Important, Urgent, pin, manage...).
-- 4. personal_notes: each person's own sticky notes. Only that person can
--    read or change them (admins cannot see them either). Never written to
--    the activity log.
-- 5. notice_board_tick(): sends the notifications for scheduled notices when
--    they start showing, and the reminders of personal notes. Runs every
--    minute with the database scheduler (started with Admin → Email → Turn On
--    Automatic Sending); the app also runs it when the Notice Board opens.
-- 6. The Notice Board can be a start page.

-- ===========================================================================
-- 1. Categories (a dropdown list)
-- ===========================================================================
insert into public.option_lists (list_name, value, sort_order)
select 'notice_category', v, n
  from (values ('General', 1), ('Safety', 2), ('Shop', 3), ('Office', 4), ('Shipping', 5), ('Event', 6)) x(v, n)
 where not exists (select 1 from public.option_lists where list_name = 'notice_category');

-- Renaming a dropdown choice renames it everywhere (now also on notices).
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
      else
        null;
    end case;
  end if;
  return null;
end;
$$;

-- ===========================================================================
-- 2. Notification types
-- ===========================================================================
-- Channels a type always uses, whatever the person chose (for example Urgent notices by email).
alter table public.notification_kinds add column required_channels text[] not null default '{}';

create or replace function public.notification_mode(p_email text, p_kind text, p_channel text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not coalesce((select enabled from public.notification_channels where channel = p_channel), false) then 'off'
    when p_channel = any(coalesce((select required_channels from public.notification_kinds where kind = p_kind), '{}'))
      then case p_channel when 'email' then 'instant' else 'on' end
    else coalesce(
      (select mode from public.notification_settings where user_email = p_email and kind = p_kind and channel = p_channel),
      (select default_modes ->> p_channel from public.notification_kinds where kind = p_kind),
      case p_channel when 'app' then 'on' else 'off' end)
  end;
$$;

insert into public.notification_kinds (kind, label, description, sort_order, default_modes, required_channels) values
  ('notice_important', 'Important notices', 'An Important notice is posted on the Notice Board for you. Always shown in the app and sent to your phone.', 80,
   '{"app": "on", "email": "off", "push": "on"}', '{app,push}'),
  ('notice_urgent', 'Urgent notices', 'An Urgent notice is posted on the Notice Board for you. Always shown in the app, sent to your phone (even in quiet hours) and emailed.', 81,
   '{"app": "on", "email": "instant", "push": "on"}', '{app,push,email}'),
  ('notice_comment', 'Comments on my notices', 'Someone comments on a notice you posted.', 82,
   '{"app": "on", "email": "off", "push": "off"}', '{}'),
  ('note_reminder', 'My notes reminders', 'The reminder you set on one of your own notes.', 83,
   '{"app": "on", "email": "off", "push": "on"}', '{}')
on conflict (kind) do nothing;

-- Quiet hours: no phone push, except for Urgent notices.
create or replace function public.notification_deliveries_chat_quiet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n public.notifications%rowtype;
begin
  select * into v_n from public.notifications where id = new.notification_id;
  -- Chat emails wait 30 minutes and go out only if the message is still unread (mark_chat_read skips them).
  if new.channel = 'email' and new.mode = 'instant' and v_n.kind in ('chat_message', 'chat_mention') then
    new.not_before := greatest(coalesce(new.not_before, now()), v_n.created_at + interval '30 minutes');
    new.group_key := new.user_email || '|' || split_part(coalesce(v_n.link, ''), '?', 1);
  end if;
  -- Quiet hours: no phone push (the bell still shows it). Urgent notices always go.
  if new.channel = 'push' and v_n.kind <> 'notice_urgent' and public.in_quiet_hours(new.user_email) then
    new.status := 'skipped';
    new.last_error := 'Quiet hours';
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 3. Notices
-- ===========================================================================
-- Today in Halifax (notices show from / until whole days).
create or replace function public.halifax_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/Halifax')::date;
$$;

-- Does someone else have a permission? (has_perm is for the signed-in person.)
create or replace function public.perm_of(p_email text, p_key text, p_level text default 'view')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select a.role = 'admin'
           or case when p_level = 'edit' then up.perms ->> p_key = 'edit'
                   else up.perms ->> p_key in ('view', 'edit') end
      from public.allowed_users a
      left join public.user_permissions up on up.user_email = a.email
     where a.email = lower(p_email)), false);
$$;

create table public.notices (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (btrim(title) <> '' and length(title) <= 200),
  -- Rich text (bold, italic, lists); body_text is the plain version for search and emails.
  body             text not null default '' check (length(body) <= 50000),
  body_text        text not null default '',
  colour           text not null default 'yellow'
                   check (colour in ('yellow', 'blue', 'green', 'pink', 'orange', 'purple', 'white')),
  category         text,
  priority         text not null default 'normal' check (priority in ('normal', 'important', 'urgent')),
  -- true = everyone; false = the people, groups and departments in notice_audience.
  audience_everyone boolean not null default true,
  show_from        date not null default public.halifax_today(),
  show_until       date,
  pinned           boolean not null default false,
  pinned_at        timestamptz,
  pinned_by        text,
  comments_enabled boolean not null default true,
  author_email     text references public.allowed_users (email) on delete set null on update cascade,
  author_name      text,
  edited_at        timestamptz,
  edited_by        text,
  announced_at     timestamptz,
  last_reminded_at timestamptz,
  archived         boolean not null default false,
  archived_at      timestamptz,
  archived_by      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (show_until is null or show_until >= show_from)
);
create index notices_show_idx on public.notices (archived, show_from, show_until);
alter table public.notices enable row level security;

create table public.notice_audience (
  notice_id   uuid not null references public.notices (id) on delete cascade,
  target_type text not null check (target_type in ('user', 'group', 'department')),
  target      text not null,
  primary key (notice_id, target_type, target)
);
create index notice_audience_target_idx on public.notice_audience (target_type, target);
alter table public.notice_audience enable row level security;

create table public.notice_reads (
  notice_id       uuid not null references public.notices (id) on delete cascade,
  user_email      text not null references public.allowed_users (email) on delete cascade on update cascade,
  read_at         timestamptz not null default now(),
  acknowledged_at timestamptz,
  primary key (notice_id, user_email)
);
create index notice_reads_user_idx on public.notice_reads (user_email);
alter table public.notice_reads enable row level security;

create table public.notice_reactions (
  notice_id  uuid not null references public.notices (id) on delete cascade,
  user_email text not null references public.allowed_users (email) on delete cascade on update cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (notice_id, user_email, emoji)
);
alter table public.notice_reactions enable row level security;

create table public.notice_comments (
  id           uuid primary key default gen_random_uuid(),
  notice_id    uuid not null references public.notices (id) on delete cascade,
  author_email text references public.allowed_users (email) on delete set null on update cascade,
  author_name  text,
  body         text not null check (btrim(body) <> '' and length(body) <= 1000),
  created_at   timestamptz not null default now()
);
create index notice_comments_notice_idx on public.notice_comments (notice_id, created_at);
alter table public.notice_comments enable row level security;

-- Category must be in the "notice_category" list; plain text for search; safe rich text.
create or replace function public.notices_fill()
returns trigger
language plpgsql
as $$
begin
  if new.category is not null and btrim(new.category) = '' then
    new.category := null;
  end if;
  if new.category is not null
     and (tg_op = 'INSERT' or new.category is distinct from old.category)
     and not public.is_valid_option('notice_category', new.category) then
    raise exception '"%" is not in the Notice categories list.', new.category;
  end if;
  new.body := coalesce(new.body, '');
  new.body_text := left(public.chat_plain(new.body), 20000);
  return new;
end;
$$;
create trigger notices_fill before insert or update on public.notices
  for each row execute function public.notices_fill();
create trigger notices_safe_body before insert or update of body on public.notices
  for each row execute function public.reject_unsafe_notes('body');
create trigger notices_updated_at before update on public.notices
  for each row execute function public.set_updated_at();
create trigger notices_archived_info before insert or update of archived on public.notices
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.notices
  for each row execute function public.log_activity();

-- Is this notice for this person? (everyone, or them, their groups or departments)
create or replace function public.notice_is_for(p_notice uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.notices n
     where n.id = p_notice
       and (n.audience_everyone
            or exists (select 1 from public.notice_audience a
                        where a.notice_id = n.id
                          and ((a.target_type = 'user' and a.target = lower(p_email))
                               or (a.target_type = 'group' and exists (
                                     select 1 from public.user_group_members m join public.user_groups g on g.id = m.group_id
                                      where m.group_id::text = a.target and m.user_email = lower(p_email) and not g.archived))
                               or (a.target_type = 'department' and exists (
                                     select 1 from public.user_departments d
                                      where d.department_id::text = a.target and d.user_email = lower(p_email)))))));
$$;

-- Everyone a notice is for who may open the Notice Board.
create or replace function public.notice_people(p_notice uuid)
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.notice_is_for(p_notice, a.email) and public.perm_of(a.email, 'notices')
   order by 2;
$$;

-- Showing today (not archived, between "show from" and "show until").
create or replace function public.notice_is_live(p_notice uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.notices n
                  where n.id = p_notice and not n.archived
                    and n.show_from <= public.halifax_today()
                    and (n.show_until is null or n.show_until >= public.halifax_today()));
$$;

-- The poster, or someone allowed to manage every notice.
create or replace function public.notice_can_manage(p_notice uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_perm('notices.manage', 'edit')
      or exists (select 1 from public.notices n where n.id = p_notice and n.author_email = public.current_user_email());
$$;

-- Can the signed-in person see this notice? Its audience sees it once it is
-- showing; expired and archived notices need the Archive permission. The
-- poster and notice managers (admins too) see their scheduled ones as well.
create or replace function public.notice_visible(p_notice uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_perm('notices', 'view')
     and (public.notice_can_manage(p_notice)
          or (public.notice_is_for(p_notice, public.current_user_email())
              and exists (select 1 from public.notices n where n.id = p_notice and n.show_from <= public.halifax_today())
              and (public.notice_is_live(p_notice) or public.has_perm('notices.archive', 'view'))));
$$;

create policy "Notice readers" on public.notices
  for select to authenticated using ((select public.notice_visible(id)));
create policy "Notice readers" on public.notice_audience
  for select to authenticated using ((select public.notice_visible(notice_id)));
create policy "Own reads" on public.notice_reads
  for select to authenticated using (user_email = (select public.current_user_email()));
create policy "Notice readers" on public.notice_reactions
  for select to authenticated using ((select public.notice_visible(notice_id)));
create policy "Notice readers" on public.notice_comments
  for select to authenticated
  using ((select public.has_perm('notices.comments', 'view')) and (select public.notice_visible(notice_id)));
-- Every change goes through the functions below.
revoke insert, update, delete on public.notices, public.notice_audience, public.notice_reads,
  public.notice_reactions, public.notice_comments from authenticated;

-- Sends the Important / Urgent notification to everyone the notice is for (not
-- the poster). Safe to run again: each person gets it once per notice and priority.
create or replace function public.notice_announce(p_notice uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n   public.notices%rowtype;
  v_n integer;
begin
  select * into n from public.notices where id = p_notice;
  if not found or n.priority = 'normal' or not public.notice_is_live(p_notice) then
    return 0;
  end if;
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  select p.email, 'notice_' || n.priority,
         case n.priority when 'urgent' then 'Urgent notice: ' else 'Important notice: ' end || n.title,
         nullif(left(n.body_text, 400), '') || case when length(n.body_text) > 400 then '…' else '' end,
         '/notices?notice=' || n.id, 'notice:' || n.id || ':' || n.priority
    from public.notice_people(p_notice) p
   where p.email is distinct from n.author_email
     and not exists (select 1 from public.notice_reads r
                      where r.notice_id = n.id and r.user_email = p.email and r.acknowledged_at is not null)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  update public.notices set announced_at = coalesce(announced_at, now()) where id = p_notice;
  return v_n;
end;
$$;

-- Create or change a notice. p: {id?, title, body, colour, category, priority,
-- everyone, audience: [{type: user|group|department, target}], show_from,
-- show_until, comments_enabled, pinned}. Returns the notice id.
create or replace function public.save_notice(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me        text := public.current_user_email();
  v_id        uuid := nullif(p ->> 'id', '')::uuid;
  v_old       public.notices%rowtype;
  v_everyone  boolean := coalesce((p ->> 'everyone')::boolean, true);
  v_priority  text := coalesce(nullif(p ->> 'priority', ''), 'normal');
  v_pinned    boolean := coalesce((p ->> 'pinned')::boolean, false);
  v_from      date := coalesce(nullif(p ->> 'show_from', '')::date, public.halifax_today());
  v_until     date := nullif(p ->> 'show_until', '')::date;
  v_aud       jsonb;
  v_old_aud   jsonb;
  v_aud_new   boolean;
  v_t         record;
begin
  if not public.is_allowed_user() then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  if v_priority not in ('normal', 'important', 'urgent') then
    raise exception 'Choose Normal, Important or Urgent.' using errcode = '22023';
  end if;
  if v_until is not null and v_until < v_from then
    raise exception 'The "show until" date must be on or after the "show from" date.' using errcode = '22023';
  end if;

  -- The audience, cleaned up and sorted (to see whether it changed).
  select coalesce(jsonb_agg(distinct jsonb_build_object('type', a ->> 'type', 'target', btrim(a ->> 'target'))), '[]'::jsonb)
    into v_aud
    from jsonb_array_elements(coalesce(p -> 'audience', '[]'::jsonb)) a
   where not v_everyone and nullif(btrim(a ->> 'target'), '') is not null;
  if not v_everyone and jsonb_array_length(v_aud) = 0 then
    raise exception 'Choose who the notice is for: everyone, or at least one person, group or department.' using errcode = '22023';
  end if;

  if v_id is null then
    perform public.require_any_perm(array['notices.post.everyone', 'notices.post.department']);
    v_aud_new := true;
  else
    select * into v_old from public.notices where id = v_id for update;
    if not found then
      raise exception 'That notice could not be found.';
    end if;
    if not public.has_perm('notices.manage', 'edit') then
      if v_old.author_email is distinct from v_me then
        raise exception 'Only the person who posted this notice can change it.' using errcode = '42501';
      end if;
      perform public.require_any_perm(array['notices.post.everyone', 'notices.post.department']);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('type', target_type, 'target', target)), '[]'::jsonb)
      into v_old_aud from public.notice_audience where notice_id = v_id;
    v_aud_new := v_everyone is distinct from v_old.audience_everyone
                 or not (v_aud @> v_old_aud and v_old_aud @> v_aud);
  end if;

  -- Who it is for: everyone, people and groups need "post to everyone";
  -- "post to my own departments" allows only the poster's own departments.
  if v_aud_new then
    if v_everyone then
      perform public.require_perm('notices.post.everyone');
    end if;
    for v_t in select a ->> 'type' as type, a ->> 'target' as target from jsonb_array_elements(v_aud) a loop
      if v_t.type = 'user' then
        if not exists (select 1 from public.allowed_users where email = lower(v_t.target)) then
          raise exception 'No user with the email %.', v_t.target using errcode = '22023';
        end if;
        perform public.require_perm('notices.post.everyone');
      elsif v_t.type = 'group' then
        if not exists (select 1 from public.user_groups where id::text = v_t.target and not archived) then
          raise exception 'One of the chosen groups no longer exists.' using errcode = '22023';
        end if;
        perform public.require_perm('notices.post.everyone');
      elsif v_t.type = 'department' then
        if not exists (select 1 from public.departments where id::text = v_t.target and not archived) then
          raise exception 'One of the chosen departments no longer exists.' using errcode = '22023';
        end if;
        if not public.has_perm('notices.post.everyone', 'edit')
           and not exists (select 1 from public.user_departments d
                            where d.department_id::text = v_t.target and d.user_email = v_me) then
          raise exception 'You can only post to your own departments.' using errcode = '42501';
        end if;
      else
        raise exception 'Unknown audience type %.', v_t.type using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_priority <> coalesce(v_old.priority, 'normal') and v_priority <> 'normal' then
    perform public.require_perm('notices.priority.' || v_priority);
  end if;
  if v_pinned is distinct from coalesce(v_old.pinned, false) then
    perform public.require_perm('notices.pin');
  end if;

  if v_id is null then
    insert into public.notices (title, body, colour, category, priority, audience_everyone, show_from, show_until,
                                pinned, pinned_at, pinned_by, comments_enabled, author_email, author_name)
    values (btrim(p ->> 'title'), coalesce(p ->> 'body', ''), coalesce(nullif(p ->> 'colour', ''), 'yellow'),
            nullif(btrim(p ->> 'category'), ''), v_priority, v_everyone, v_from, v_until,
            v_pinned, case when v_pinned then now() end, case when v_pinned then v_me end,
            coalesce((p ->> 'comments_enabled')::boolean, true), v_me,
            coalesce((select nullif(btrim(name), '') from public.allowed_users where email = v_me), v_me))
    returning id into v_id;
  else
    update public.notices
       set title = btrim(p ->> 'title'),
           body = coalesce(p ->> 'body', ''),
           colour = coalesce(nullif(p ->> 'colour', ''), 'yellow'),
           category = nullif(btrim(p ->> 'category'), ''),
           priority = v_priority,
           audience_everyone = v_everyone,
           show_from = v_from,
           show_until = v_until,
           pinned = v_pinned,
           pinned_at = case when v_pinned and not v_old.pinned then now() when v_pinned then pinned_at end,
           pinned_by = case when v_pinned and not v_old.pinned then v_me when v_pinned then pinned_by end,
           comments_enabled = coalesce((p ->> 'comments_enabled')::boolean, true),
           -- Starting again later sends the notification again when it shows.
           announced_at = case when v_from > public.halifax_today() then null else announced_at end
     where id = v_id;
    if (v_old.title, v_old.body, v_old.priority, v_old.category, v_old.show_from, v_old.show_until, v_old.audience_everyone)
       is distinct from (btrim(p ->> 'title'), coalesce(p ->> 'body', ''), v_priority, nullif(btrim(p ->> 'category'), ''),
                         v_from, v_until, v_everyone) or v_aud_new then
      update public.notices set edited_at = now(),
             edited_by = coalesce((select nullif(btrim(name), '') from public.allowed_users where email = v_me), v_me)
       where id = v_id;
    end if;
    delete from public.notice_audience where notice_id = v_id;
  end if;

  insert into public.notice_audience (notice_id, target_type, target)
  select v_id, a ->> 'type', case when a ->> 'type' = 'user' then lower(a ->> 'target') else a ->> 'target' end
    from jsonb_array_elements(v_aud) a
  on conflict do nothing;

  -- Showing now: send the Important / Urgent notification (new people only).
  perform public.notice_announce(v_id);
  return v_id;
end;
$$;

-- Archive (or restore) a notice: the poster or a notice manager.
create or replace function public.archive_notice(p_notice uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.notice_can_manage(p_notice) then
    raise exception 'Only the person who posted this notice can archive it.' using errcode = '42501';
  end if;
  if not public.has_perm('notices.manage', 'edit') then
    perform public.require_any_perm(array['notices.post.everyone', 'notices.post.department']);
  end if;
  update public.notices set archived = p_archived where id = p_notice;
  if not p_archived then
    perform public.notice_announce(p_notice);
  end if;
end;
$$;

create or replace function public.pin_notice(p_notice uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('notices.pin');
  if not public.notice_can_manage(p_notice) then
    raise exception 'Only the person who posted this notice can pin it.' using errcode = '42501';
  end if;
  update public.notices
     set pinned = p_pinned,
         pinned_at = case when p_pinned then now() end,
         pinned_by = case when p_pinned then public.current_user_email() end
   where id = p_notice;
end;
$$;

-- The board was opened: these notices are no longer "new" for me.
create or replace function public.mark_notices_read(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_perm('notices', 'view') then
    return;
  end if;
  insert into public.notice_reads (notice_id, user_email)
  select id, public.current_user_email() from unnest(p_ids) id
   where public.notice_visible(id)
  on conflict do nothing;
end;
$$;

create or replace function public.acknowledge_notice(p_notice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('notices.acknowledge');
  if not public.notice_visible(p_notice) or not public.notice_is_for(p_notice, v_me) then
    raise exception 'That notice could not be found.';
  end if;
  if not exists (select 1 from public.notices where id = p_notice and priority in ('important', 'urgent')) then
    raise exception 'Only Important and Urgent notices are acknowledged.' using errcode = '22023';
  end if;
  insert into public.notice_reads (notice_id, user_email, acknowledged_at)
  values (p_notice, v_me, now())
  on conflict (notice_id, user_email) do update set acknowledged_at = coalesce(public.notice_reads.acknowledged_at, now());
  -- Its notifications in the bell are read too.
  update public.notifications set read_at = coalesce(read_at, now())
   where user_email = v_me and link = '/notices?notice=' || p_notice;
end;
$$;

-- Who has and hasn't acknowledged (or read) a notice: the poster and notice managers.
create or replace function public.notice_ack_status(p_notice uuid)
returns table (email text, name text, read_at timestamptz, acknowledged_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_perm('notices.acks', 'view');
  if not public.notice_can_manage(p_notice) then
    raise exception 'Only the person who posted this notice can see who has read it.' using errcode = '42501';
  end if;
  return query
    select p.email, p.name, r.read_at, r.acknowledged_at
      from public.notice_people(p_notice) p
      left join public.notice_reads r on r.notice_id = p_notice and r.user_email = p.email
     where p.email is distinct from (select author_email from public.notices where id = p_notice)
     order by r.acknowledged_at nulls first, p.name;
end;
$$;

-- "Remind the Rest": everyone who hasn't acknowledged gets the notification
-- again (at most once every 10 minutes). Returns how many people.
create or replace function public.remind_notice(p_notice uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n   public.notices%rowtype;
  v_n integer;
begin
  perform public.require_perm('notices.acks', 'edit');
  if not public.notice_can_manage(p_notice) then
    raise exception 'Only the person who posted this notice can send reminders.' using errcode = '42501';
  end if;
  select * into n from public.notices where id = p_notice;
  if n.priority = 'normal' then
    raise exception 'Reminders are for Important and Urgent notices.' using errcode = '22023';
  end if;
  if not public.notice_is_live(p_notice) then
    raise exception 'This notice is not showing on the board, so no reminder was sent.' using errcode = '22023';
  end if;
  if n.last_reminded_at > now() - interval '10 minutes' then
    raise exception 'A reminder was sent less than 10 minutes ago. Try again later.' using errcode = '22023';
  end if;
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  select p.email, 'notice_' || n.priority, 'Reminder: please acknowledge "' || n.title || '"',
         nullif(left(n.body_text, 400), ''), '/notices?notice=' || n.id,
         'notice-remind:' || n.id || ':' || to_char(now(), 'YYYYMMDDHH24MI')
    from public.notice_people(p_notice) p
   where p.email is distinct from n.author_email
     and not exists (select 1 from public.notice_reads r
                      where r.notice_id = n.id and r.user_email = p.email and r.acknowledged_at is not null)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  update public.notices set last_reminded_at = now() where id = p_notice;
  return v_n;
end;
$$;

-- The approved reaction set (the same as chat: REACTIONS in src/lib/chat.ts).
create or replace function public.toggle_notice_reaction(p_notice uuid, p_emoji text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('notices.react');
  if p_emoji not in ('👍', '❤️', '😂', '😮', '🎉', '🙏', '✅') then
    raise exception 'That reaction is not available.' using errcode = '22023';
  end if;
  if not public.notice_visible(p_notice) then
    raise exception 'That notice could not be found.';
  end if;
  if exists (select 1 from public.notice_reactions where notice_id = p_notice and user_email = v_me and emoji = p_emoji) then
    delete from public.notice_reactions where notice_id = p_notice and user_email = v_me and emoji = p_emoji;
  else
    insert into public.notice_reactions (notice_id, user_email, emoji) values (p_notice, v_me, p_emoji);
  end if;
end;
$$;

create or replace function public.post_notice_comment(p_notice uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   text := public.current_user_email();
  v_name text := coalesce((select nullif(btrim(name), '') from public.allowed_users where email = v_me), v_me);
  n      public.notices%rowtype;
  v_id   uuid;
begin
  perform public.require_perm('notices.comments', 'edit');
  if not public.notice_visible(p_notice) then
    raise exception 'That notice could not be found.';
  end if;
  select * into n from public.notices where id = p_notice;
  if not n.comments_enabled then
    raise exception 'Comments are turned off for this notice.' using errcode = '22023';
  end if;
  if nullif(btrim(p_body), '') is null then
    raise exception 'Write a comment first.' using errcode = '22023';
  end if;
  insert into public.notice_comments (notice_id, author_email, author_name, body)
  values (p_notice, v_me, v_name, left(btrim(p_body), 1000))
  returning id into v_id;
  if n.author_email is not null and n.author_email <> v_me then
    insert into public.notifications (user_email, kind, title, body, link)
    values (n.author_email, 'notice_comment', v_name || ' commented on "' || n.title || '"',
            left(btrim(p_body), 300), '/notices?notice=' || n.id);
  end if;
  return v_id;
end;
$$;

-- Your own comment, or any comment on your notice (notice managers: any).
create or replace function public.delete_notice_comment(p_comment uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.notice_comments%rowtype;
begin
  select * into c from public.notice_comments where id = p_comment;
  if not found then return; end if;
  if c.author_email is distinct from public.current_user_email() and not public.notice_can_manage(c.notice_id) then
    raise exception 'You can only delete your own comments.' using errcode = '42501';
  end if;
  delete from public.notice_comments where id = p_comment;
end;
$$;

-- For the menu: notices showing for me that I haven't seen yet (not my own).
create or replace function public.notice_unread_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case when not public.has_perm('notices', 'view') then 0 else (
    select count(*)::integer from public.notices n
     where not n.archived and n.show_from <= public.halifax_today()
       and (n.show_until is null or n.show_until >= public.halifax_today())
       and n.author_email is distinct from public.current_user_email()
       and public.notice_is_for(n.id, public.current_user_email())
       and not exists (select 1 from public.notice_reads r where r.notice_id = n.id and r.user_email = public.current_user_email()))
  end;
$$;

-- Urgent notices showing for me that I haven't acknowledged (the red banner).
create or replace function public.my_urgent_notices()
returns table (id uuid, title text, author_name text, show_from date)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.title, n.author_name, n.show_from
    from public.notices n
   where public.has_perm('notices', 'view')
     and n.priority = 'urgent' and not n.archived
     and n.show_from <= public.halifax_today()
     and (n.show_until is null or n.show_until >= public.halifax_today())
     and n.author_email is distinct from public.current_user_email()
     and public.notice_is_for(n.id, public.current_user_email())
     and not exists (select 1 from public.notice_reads r
                      where r.notice_id = n.id and r.user_email = public.current_user_email() and r.acknowledged_at is not null)
   order by n.created_at desc;
$$;

-- Everyone who can sign in, for the "who is it for" picker.
create or replace function public.notice_people_choices()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.has_perm('notices.post.everyone', 'edit')
   order by 2;
$$;

-- ===========================================================================
-- 4. Personal notes (private: only the owner, never admins)
-- ===========================================================================
create table public.personal_notes (
  id          uuid primary key default gen_random_uuid(),
  owner_email text not null default public.current_user_email()
              references public.allowed_users (email) on delete cascade on update cascade,
  title       text not null default '' check (length(title) <= 120),
  body        text not null default '' check (length(body) <= 5000),
  colour      text not null default 'yellow'
              check (colour in ('yellow', 'blue', 'green', 'pink', 'orange', 'purple', 'white')),
  -- [{"id": "…", "text": "…", "done": false}]
  checklist   jsonb not null default '[]'::jsonb
              check (jsonb_typeof(checklist) = 'array' and jsonb_array_length(checklist) <= 50),
  -- Place on the board: x = % of the width, y = pixels from the top; z = which is on top.
  pos_x       numeric(6, 2) not null default 0 check (pos_x between 0 and 100),
  pos_y       integer not null default 0 check (pos_y between 0 and 20000),
  z           integer not null default 0,
  remind_at   timestamptz,
  reminded_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index personal_notes_owner_idx on public.personal_notes (owner_email);
create index personal_notes_remind_idx on public.personal_notes (remind_at) where reminded_at is null and remind_at is not null;
alter table public.personal_notes enable row level security;

create or replace function public.personal_notes_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    new.owner_email := old.owner_email;
    if new.remind_at is distinct from old.remind_at then
      new.reminded_at := null;
    end if;
  else
    new.owner_email := public.current_user_email();
    new.reminded_at := null;
  end if;
  return new;
end;
$$;
create trigger personal_notes_guard before insert or update on public.personal_notes
  for each row execute function public.personal_notes_guard();
create trigger personal_notes_updated_at before update on public.personal_notes
  for each row execute function public.set_updated_at();

-- Only the owner (with the "My notes" permission). No exception for admins.
create policy "Own notes only" on public.personal_notes
  for all to authenticated
  using (owner_email = (select public.current_user_email()) and (select public.has_perm('notices.my_notes', 'edit')))
  with check (owner_email = (select public.current_user_email()) and (select public.has_perm('notices.my_notes', 'edit')));
revoke all on public.personal_notes from anon;

-- ===========================================================================
-- 5. Scheduled notices and note reminders
-- ===========================================================================
-- Sends the notifications of Important / Urgent notices that start showing
-- today (scheduled ones wait until 7:00 in the morning, Halifax time), and the
-- reminders of personal notes that are due. Safe to run any number of times.
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
  return jsonb_build_object('notices', v_notices, 'reminders', v_notes);
end;
$$;

-- Automatic sending (Admin → Email) now also runs the Notice Board every minute.
create or replace function public.start_email_schedule(p_supabase_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := rtrim(btrim(p_supabase_url), '/') || '/functions/v1/';
begin
  perform public.require_admin_area('email');
  if p_supabase_url !~ '^https://[a-z0-9.-]+$' then
    raise exception 'The Supabase address looks wrong: %', p_supabase_url using errcode = '22023';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Turn on the pg_cron and pg_net extensions first (Supabase → Database → Extensions).' using errcode = '55000';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications', 'calendar-import', 'notice-board');
  perform cron.schedule('send-notifications', '* * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "dispatch"}'::jsonb, timeout_milliseconds := 55000)$job$,
    v_base || 'send-email'));
  perform cron.schedule('board-due-notifications', '*/10 * * * *', 'select public.board_due_notifications()');
  perform cron.schedule('calendar-import', '*/15 * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "sync_all"}'::jsonb, timeout_milliseconds := 120000)$job$,
    v_base || 'calendar-import'));
  perform cron.schedule('notice-board', '* * * * *', 'select public.notice_board_tick()');
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned on', 'url', v_base));
end;
$$;

create or replace function public.stop_email_schedule()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('email');
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications', 'calendar-import', 'notice-board');
  end if;
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned off'));
end;
$$;

-- If automatic sending is already on, start the Notice Board job now too.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'send-notifications') then
      perform cron.unschedule(jobid) from cron.job where jobname = 'notice-board';
      perform cron.schedule('notice-board', '* * * * *', 'select public.notice_board_tick()');
    end if;
  end if;
end $$;

-- ===========================================================================
-- 6. Start page
-- ===========================================================================
alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/reports/department-delays',
     '/reports/build-times', '/boards', '/notices', '/service', '/service/calendar', '/chat', '/agent', '/settings', '/admin', '/shop-board'));

-- Access lockdown, as in earlier migrations.
revoke all on public.notices, public.notice_audience, public.notice_reads, public.notice_reactions,
  public.notice_comments from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
