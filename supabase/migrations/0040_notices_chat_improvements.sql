-- 0040 Notice Board and Chat improvements
--  Notice Board: one reaction per person per notice; archive for My notes;
--  closure / delay alerts (a banner on every page, sent to everyone by the
--  app, phone push and email, updates notify again).
--  Chat: unsend within 30 seconds; one reaction per person per message;
--  per-person Archive / Hide / Clear chat / Delete for me / Mark unread;
--  swipe settings; who is on approved time off (ready for the time-off step).
-- Paste the whole file into the Supabase SQL Editor and click Run.

-- ===========================================================================
-- 1. Notice reactions: one per person per notice (picking another replaces it)
-- ===========================================================================
-- Keep each person's newest reaction.
delete from public.notice_reactions r
 using public.notice_reactions r2
 where r.notice_id = r2.notice_id and r.user_email = r2.user_email
   and (r.created_at, r.emoji) < (r2.created_at, r2.emoji);
create unique index notice_reactions_one_per_person on public.notice_reactions (notice_id, user_email);

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
  -- The same one again takes it off; another one replaces it.
  if exists (select 1 from public.notice_reactions where notice_id = p_notice and user_email = v_me and emoji = p_emoji) then
    delete from public.notice_reactions where notice_id = p_notice and user_email = v_me;
  else
    delete from public.notice_reactions where notice_id = p_notice and user_email = v_me;
    insert into public.notice_reactions (notice_id, user_email, emoji) values (p_notice, v_me, p_emoji);
  end if;
end;
$$;

-- ===========================================================================
-- 2. My notes: archive (and restore); archived notes send no reminders
-- ===========================================================================
alter table public.personal_notes
  add column archived boolean not null default false,
  add column archived_at timestamptz;
create or replace function public.personal_notes_archived_at()
returns trigger
language plpgsql
as $$
begin
  if new.archived is distinct from old.archived then
    new.archived_at := case when new.archived then now() end;
  end if;
  return new;
end;
$$;
create trigger personal_notes_archived_at before update of archived on public.personal_notes
  for each row execute function public.personal_notes_archived_at();

-- Copy of 0035: archived notes send no reminders.
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
     where remind_at <= now() and reminded_at is null and not archived
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
-- 3. Closure and delay alerts ("Office closed due to weather", "Delayed opening",
--    "Office closed on …"): a banner on every page until ended or past, sent to
--    everyone in the app, by phone push (even in quiet hours) and by email.
-- ===========================================================================
create table public.closure_alerts (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('closed_weather', 'delayed_opening', 'closed_on_date', 'other')),
  title           text not null check (btrim(title) <> '' and length(title) <= 120),
  reason          text check (reason is null or length(reason) <= 2000),
  start_date      date not null,
  end_date        date not null,
  next_update_at  timestamptz,
  update_count    integer not null default 0,
  ended_at        timestamptz,
  ended_by_name   text,
  created_by      text,
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_date >= start_date)
);
create index closure_alerts_active_idx on public.closure_alerts (end_date) where ended_at is null;

-- Every posting and update, newest last (the history under the banner).
create table public.closure_alert_updates (
  id             uuid primary key default gen_random_uuid(),
  alert_id       uuid not null references public.closure_alerts (id) on delete cascade,
  kind           text not null check (kind in ('posted', 'update', 'ended')),
  message        text check (message is null or length(message) <= 2000),
  next_update_at timestamptz,
  created_by     text,
  created_by_name text,
  created_at     timestamptz not null default now()
);
create index closure_alert_updates_alert_idx on public.closure_alert_updates (alert_id, created_at);

alter table public.closure_alerts enable row level security;
alter table public.closure_alert_updates enable row level security;
create policy "Closure alert readers" on public.closure_alerts
  for select to authenticated using ((select public.has_any_perm(array['notices.closures', 'notices.closures.post'], 'view')));
create policy "Closure alert readers" on public.closure_alert_updates
  for select to authenticated using ((select public.has_any_perm(array['notices.closures', 'notices.closures.post'], 'view')));

insert into public.notification_kinds (kind, label, description, sort_order, default_modes, required_channels) values
  ('closure_alert', 'Office closures and delays', 'The office is closed or opens late (for example because of the weather), and every update. Always shown in the app, sent to your phone (even in quiet hours) and emailed.', 79,
   '{"app": "on", "email": "instant", "push": "on"}', '{app,push,email}')
on conflict (kind) do nothing;

-- Sends one closure alert (or an update) to everyone who can sign in.
create or replace function public.closure_alert_notify(p_alert uuid, p_heading text, p_message text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  a   public.closure_alerts%rowtype;
  v_n integer;
  v_when text;
begin
  select * into a from public.closure_alerts where id = p_alert;
  v_when := case when a.start_date = a.end_date then to_char(a.start_date, 'FMDay, Mon FMDD')
                 else to_char(a.start_date, 'Mon FMDD') || ' – ' || to_char(a.end_date, 'Mon FMDD') end;
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  select u.email, 'closure_alert', p_heading || a.title,
         concat_ws(E'\n', nullif(btrim(coalesce(p_message, '')), ''), 'Date: ' || v_when,
                   case when a.next_update_at is not null
                        then 'Next update: ' || to_char(a.next_update_at at time zone 'America/Halifax', 'Mon FMDD, FMHH12:MI AM') end),
         '/notices?closure=' || a.id, 'closure:' || a.id || ':' || a.update_count
    from public.allowed_users u
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Post a new alert, or an update to one (p.id). p: {id?, kind, title, reason, start_date,
-- end_date, next_update_at, message}. Every posting notifies everyone again.
create or replace function public.save_closure_alert(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid := nullif(p ->> 'id', '')::uuid;
  v_start date := coalesce(nullif(p ->> 'start_date', '')::date, public.halifax_today());
  v_end   date := coalesce(nullif(p ->> 'end_date', '')::date, nullif(p ->> 'start_date', '')::date, public.halifax_today());
  v_next  timestamptz := nullif(p ->> 'next_update_at', '')::timestamptz;
  v_msg   text := nullif(btrim(coalesce(p ->> 'message', '')), '');
  v_old   public.closure_alerts%rowtype;
begin
  perform public.require_perm('notices.closures.post', 'edit');
  if coalesce(p ->> 'kind', '') not in ('closed_weather', 'delayed_opening', 'closed_on_date', 'other') then
    raise exception 'Choose what kind of alert this is.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p ->> 'title', '')), '') is null then
    raise exception 'Enter a title, for example “Office closed due to weather”.' using errcode = '22023';
  end if;
  if v_end < v_start then
    raise exception 'The last affected date cannot be before the first.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.closure_alerts (kind, title, reason, start_date, end_date, next_update_at, created_by, created_by_name)
    values (p ->> 'kind', btrim(p ->> 'title'), nullif(btrim(coalesce(p ->> 'reason', '')), ''), v_start, v_end, v_next,
            public.current_user_email(), public.current_user_name())
    returning id into v_id;
    insert into public.closure_alert_updates (alert_id, kind, message, next_update_at, created_by, created_by_name)
    values (v_id, 'posted', coalesce(v_msg, nullif(btrim(coalesce(p ->> 'reason', '')), '')), v_next, public.current_user_email(), public.current_user_name());
    perform public.closure_alert_notify(v_id, '', coalesce(v_msg, nullif(btrim(coalesce(p ->> 'reason', '')), '')));
  else
    select * into v_old from public.closure_alerts where id = v_id for update;
    if v_old.id is null then raise exception 'That alert could not be found.'; end if;
    if v_old.ended_at is not null then raise exception 'This alert has ended. Post a new one instead.' using errcode = '22023'; end if;
    update public.closure_alerts
       set kind = p ->> 'kind', title = btrim(p ->> 'title'), reason = nullif(btrim(coalesce(p ->> 'reason', '')), ''),
           start_date = v_start, end_date = v_end, next_update_at = v_next, update_count = update_count + 1, updated_at = now()
     where id = v_id;
    insert into public.closure_alert_updates (alert_id, kind, message, next_update_at, created_by, created_by_name)
    values (v_id, 'update', v_msg, v_next, public.current_user_email(), public.current_user_name());
    perform public.closure_alert_notify(v_id, 'Update: ', v_msg);
  end if;
  return v_id;
end;
$$;

-- End an alert (the banner goes away). A message is sent to everyone only when one is written.
create or replace function public.end_closure_alert(p_alert uuid, p_message text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg text := nullif(btrim(coalesce(p_message, '')), '');
begin
  perform public.require_perm('notices.closures.post', 'edit');
  update public.closure_alerts
     set ended_at = now(), ended_by_name = public.current_user_name(), next_update_at = null,
         update_count = update_count + 1, updated_at = now()
   where id = p_alert and ended_at is null;
  if not found then raise exception 'That alert could not be found or has already ended.'; end if;
  insert into public.closure_alert_updates (alert_id, kind, message, created_by, created_by_name)
  values (p_alert, 'ended', v_msg, public.current_user_email(), public.current_user_name());
  if v_msg is not null then
    perform public.closure_alert_notify(p_alert, 'Ended: ', v_msg);
  end if;
end;
$$;

-- The alerts to show in the banner: not ended and not past (Halifax dates).
create or replace function public.active_closure_alerts()
returns table (id uuid, kind text, title text, reason text, start_date date, end_date date, next_update_at timestamptz,
               updated_at timestamptz, last_message text, created_by_name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.kind, a.title, a.reason, a.start_date, a.end_date, a.next_update_at, a.updated_at,
         (select u.message from public.closure_alert_updates u where u.alert_id = a.id and u.message is not null
           order by u.created_at desc limit 1),
         a.created_by_name
    from public.closure_alerts a
   where a.ended_at is null and a.end_date >= public.halifax_today()
     and public.has_any_perm(array['notices.closures', 'notices.closures.post'], 'view')
   order by a.start_date, a.created_at;
$$;

-- Copy of 0034: closure alerts are pushed even in quiet hours.
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
  -- Quiet hours: no phone push (the bell still shows it). Urgent notices and closure alerts always go.
  if new.channel = 'push' and v_n.kind not in ('notice_urgent', 'closure_alert') and public.in_quiet_hours(new.user_email) then
    new.status := 'skipped';
    new.last_error := 'Quiet hours';
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 4. Chat reactions: one per person per message (picking another replaces it)
-- ===========================================================================
delete from public.chat_reactions r
 using public.chat_reactions r2
 where r.message_id = r2.message_id and r.user_email = r2.user_email
   and (r.created_at, r.emoji) < (r2.created_at, r2.emoji);
create unique index chat_reactions_one_per_person on public.chat_reactions (message_id, user_email);

create or replace function public.toggle_chat_reaction(p_id uuid, p_emoji text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('chat.send', 'edit');
  if not exists (select 1 from public.chat_messages where id = p_id and deleted_at is null and public.chat_is_member(conversation_id)) then
    raise exception 'That message could not be found.';
  end if;
  if exists (select 1 from public.chat_reactions where message_id = p_id and user_email = v_me and emoji = p_emoji) then
    delete from public.chat_reactions where message_id = p_id and user_email = v_me;
  else
    delete from public.chat_reactions where message_id = p_id and user_email = v_me;
    insert into public.chat_reactions (message_id, user_email, emoji) values (p_id, v_me, p_emoji);
  end if;
end;
$$;

-- ===========================================================================
-- 5. Unsend: within 30 seconds the author can take a message back completely
--    (no "Message deleted" line, its notifications go too).
-- ===========================================================================
create or replace function public.unsend_chat_message(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_m public.chat_messages%rowtype;
begin
  perform public.require_perm('chat.unsend', 'edit');
  select * into v_m from public.chat_messages where id = p_id;
  if v_m.id is null or v_m.author_email is distinct from public.current_user_email() or not public.chat_is_member(v_m.conversation_id) then
    raise exception 'You can only unsend your own messages.' using errcode = '42501';
  end if;
  -- 30 seconds, plus a few seconds for a slow connection.
  if v_m.created_at < now() - interval '35 seconds' then
    raise exception 'A message can only be unsent within 30 seconds. Use Delete instead.' using errcode = '22023';
  end if;
  delete from public.notifications where dedupe_key = 'chat:' || p_id;
  delete from public.chat_messages where id = p_id;
  update public.chat_conversations c
     set last_message_at = (select max(x.created_at) from public.chat_messages x where x.conversation_id = c.id)
   where c.id = v_m.conversation_id;
end;
$$;

-- ===========================================================================
-- 6. My own view of a conversation: Archive, Hide, Clear chat, Delete for me,
--    Mark unread. Nobody else is affected.
-- ===========================================================================
alter table public.chat_members
  add column my_archived_at timestamptz,
  add column hidden_at      timestamptz,
  -- messages up to this moment are no longer shown to me (Clear chat / Delete for me)
  add column cleared_at     timestamptz,
  -- Delete for me: the conversation leaves my list until a newer message arrives
  add column deleted_at     timestamptz,
  add column marked_unread  boolean not null default false;

-- When my history starts (Clear chat / Delete for me).
create or replace function public.chat_cleared_at(p_conv uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select m.cleared_at from public.chat_members m
   where m.conversation_id = p_conv and m.user_email = public.current_user_email();
$$;

drop policy "Members only" on public.chat_messages;
create policy "Members only" on public.chat_messages for select to authenticated
  using ((select public.chat_is_member(conversation_id)) and created_at > coalesce(public.chat_cleared_at(conversation_id), '-infinity'::timestamptz));

create or replace function public.set_chat_state(p_conv uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('chat.list_actions', 'edit');
  if not public.chat_is_member(p_conv) then
    raise exception 'That conversation could not be found.';
  end if;
  if p_action not in ('archive', 'unarchive', 'hide', 'unhide', 'clear', 'delete', 'unread', 'read') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  update public.chat_members m set
    -- Delete for me also takes it out of Archived / Hidden, so a new message brings it back to the normal list.
    my_archived_at = case p_action when 'archive' then now() when 'unarchive' then null when 'delete' then null else m.my_archived_at end,
    hidden_at      = case p_action when 'hide' then now() when 'unhide' then null when 'delete' then null else m.hidden_at end,
    cleared_at     = case when p_action in ('clear', 'delete') then now() else m.cleared_at end,
    deleted_at     = case when p_action = 'delete' then now() else m.deleted_at end,
    marked_unread  = case p_action when 'unread' then true when 'read' then false when 'clear' then false when 'delete' then false else m.marked_unread end,
    last_read_at   = case when p_action in ('read', 'clear', 'delete') then now() else m.last_read_at end
   where m.conversation_id = p_conv and m.user_email = v_me;
  if p_action in ('read', 'clear', 'delete') then
    update public.notification_deliveries d set status = 'skipped', last_error = 'Read in the app'
      from public.notifications n
     where n.id = d.notification_id and n.user_email = v_me and n.kind in ('chat_message', 'chat_mention')
       and n.link like '/chat/' || p_conv || '%' and d.status = 'pending';
    update public.notifications set read_at = now()
     where user_email = v_me and kind in ('chat_message', 'chat_mention') and link like '/chat/' || p_conv || '%' and read_at is null;
  end if;
end;
$$;

-- Reading a conversation also clears "Mark unread" (copy of 0032).
create or replace function public.mark_chat_read(p_conv uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  if not public.chat_is_member(p_conv) then return; end if;
  update public.chat_members set last_read_at = now(), marked_unread = false where conversation_id = p_conv and user_email = v_me;
  update public.notification_deliveries d set status = 'skipped', last_error = 'Read in the app'
    from public.notifications n
   where n.id = d.notification_id and n.user_email = v_me and n.kind in ('chat_message', 'chat_mention')
     and n.link like '/chat/' || p_conv || '%' and d.status = 'pending';
  update public.notifications set read_at = now()
   where user_email = v_me and kind in ('chat_message', 'chat_mention') and link like '/chat/' || p_conv || '%' and read_at is null;
end;
$$;

-- The conversation list (copy of 0032 + my own archive / hide / clear / delete / unread).
drop function public.chat_unread_total();
drop function public.my_chat_conversations();
create function public.my_chat_conversations()
returns table (id uuid, kind text, name text, other_email text, archived boolean, last_message_at timestamptz,
               last_author text, last_text text, unread integer, mentions integer, notify text, members integer, can_post boolean,
               my_archived boolean, hidden boolean, marked_unread boolean, created_by text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.kind, public.chat_display_name(c.id, me.user_email),
         case when c.kind = 'direct' then (select m2.user_email from public.chat_members m2 where m2.conversation_id = c.id and m2.user_email <> me.user_email limit 1) end,
         c.archived, lm.created_at,
         lm.author_name, case when lm.deleted_at is not null then 'Message deleted' else left(lm.body_text, 120) end,
         greatest(
           (select count(*)::int from public.chat_messages x
             where x.conversation_id = c.id and x.created_at > greatest(me.last_read_at, coalesce(me.cleared_at, '-infinity'))
               and x.author_email is distinct from me.user_email and x.deleted_at is null),
           case when me.marked_unread then 1 else 0 end),
         (select count(*)::int from public.chat_messages x
           where x.conversation_id = c.id and x.created_at > greatest(me.last_read_at, coalesce(me.cleared_at, '-infinity'))
             and x.author_email is distinct from me.user_email and x.deleted_at is null
             and public.chat_mentions_person(x.mentions, me.user_email)),
         me.notify,
         (select count(*)::int from public.chat_members m3 where m3.conversation_id = c.id and not m3.removed),
         public.chat_can_post(c.id),
         me.my_archived_at is not null, me.hidden_at is not null, me.marked_unread,
         c.created_by, c.created_at
    from public.chat_members me
    join public.chat_conversations c on c.id = me.conversation_id
    left join lateral (select * from public.chat_messages x
                        where x.conversation_id = c.id and x.created_at > coalesce(me.cleared_at, '-infinity')
                        order by x.created_at desc limit 1) lm on true
   where me.user_email = public.current_user_email() and not me.removed and public.has_perm('chat', 'view')
     -- Delete for me: gone from my list until someone writes again.
     and (me.deleted_at is null or c.last_message_at > me.deleted_at)
   order by coalesce(lm.created_at, c.created_at) desc;
$$;

create function public.chat_unread_total()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(case when c.notify = 'mute' then 0 else c.unread end), 0)::int
    from public.my_chat_conversations() c where not c.archived and not c.my_archived and not c.hidden;
$$;

-- Search leaves out what I cleared (copy of 0032).
create or replace function public.search_chat(p_query text)
returns table (id uuid, conversation_id uuid, conversation_name text, author_name text, body_text text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.conversation_id, public.chat_display_name(m.conversation_id, public.current_user_email()),
         m.author_name, left(m.body_text, 300), m.created_at
    from public.chat_messages m
    join public.chat_members me on me.conversation_id = m.conversation_id and me.user_email = public.current_user_email() and not me.removed
   where public.has_perm('chat.search', 'view') and m.deleted_at is null and length(btrim(coalesce(p_query, ''))) >= 2
     and m.created_at > coalesce(me.cleared_at, '-infinity')
     and m.body_text ilike '%' || replace(replace(btrim(p_query), '%', '\%'), '_', '\_') || '%'
   order by m.created_at desc
   limit 50;
$$;

-- ===========================================================================
-- 7. Swipe actions (phone): my choice for left and right
-- ===========================================================================
alter table public.chat_settings
  add column swipe_left  text not null default 'archive' check (swipe_left in ('archive', 'delete', 'clear', 'read_toggle', 'hide')),
  add column swipe_right text not null default 'delete' check (swipe_right in ('archive', 'delete', 'clear', 'read_toggle', 'hide'));

-- Copy of 0032 + the swipe choices.
create or replace function public.set_my_chat_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  insert into public.chat_settings (user_email) values (v_me) on conflict do nothing;
  if p ? 'hide_status' then
    perform public.require_perm('settings.chat_status', 'edit');
    update public.chat_settings set hide_status = (p ->> 'hide_status')::boolean, updated_at = now() where user_email = v_me;
  end if;
  if p ? 'quiet_enabled' or p ? 'quiet_start' or p ? 'quiet_end' then
    perform public.require_perm('settings.quiet_hours', 'edit');
    update public.chat_settings
       set quiet_enabled = coalesce((p ->> 'quiet_enabled')::boolean, quiet_enabled),
           quiet_start = coalesce((p ->> 'quiet_start')::time, quiet_start),
           quiet_end = coalesce((p ->> 'quiet_end')::time, quiet_end),
           updated_at = now()
     where user_email = v_me;
  end if;
  if p ? 'swipe_left' or p ? 'swipe_right' then
    perform public.require_perm('settings.chat_swipe', 'edit');
    update public.chat_settings
       set swipe_left = coalesce(p ->> 'swipe_left', swipe_left), swipe_right = coalesce(p ->> 'swipe_right', swipe_right), updated_at = now()
     where user_email = v_me;
  end if;
end;
$$;

-- ===========================================================================
-- 8. Approved time off in a conversation ("Sam is on vacation and may not read
--    this until Mon, Dec 1"). Ready for the time-off step: it reads the table
--    public.time_off_requests (user_email, kind vacation / sick / banked,
--    start_date, end_date, status 'approved') once that step creates it;
--    until then it returns nothing.
-- ===========================================================================
create or replace function public.chat_time_off(p_conv uuid)
returns table (email text, name text, kind text, return_date date)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.chat_is_member(p_conv) or not public.has_perm('chat.time_off', 'view') then
    return;
  end if;
  if to_regclass('public.time_off_requests') is null then
    return;
  end if;
  return query execute $q$
    select t.user_email::text, coalesce(a.name, t.user_email)::text, t.kind::text,
           (select min(d)::date from generate_series(t.end_date + 1, t.end_date + 40, interval '1 day') d
             where public.is_working_day(d::date))
      from public.time_off_requests t
      join public.chat_members m on m.user_email = t.user_email and m.conversation_id = $1 and not m.removed
      left join public.allowed_users a on a.email = t.user_email
     where t.status = 'approved' and public.halifax_today() between t.start_date and t.end_date
       and t.user_email <> public.current_user_email()
     order by 2
     limit 5 $q$ using p_conv;
end;
$$;

-- ===========================================================================
-- 9. Access lockdown
-- ===========================================================================
revoke all on public.closure_alerts, public.closure_alert_updates from anon;
grant select on public.closure_alerts, public.closure_alert_updates to authenticated;
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
-- Closure alert notifications are only sent by the functions above.
revoke execute on function public.closure_alert_notify(uuid, text, text) from authenticated;
