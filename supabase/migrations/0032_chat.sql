-- 0032: Chat (messaging inside the app, live through Supabase Realtime)
--
-- Conversations: direct messages (two people), group chats (named, picked
-- people), and channels: one per department and one per custom group (kept in
-- step with their members automatically), plus channels an admin makes.
-- People see ONLY conversations they belong to; there is no admin view of
-- direct messages or group chats. Admins manage channels only (Admin → Chat).
-- Messages: rich text, reactions, replies, @mentions (people, departments,
-- groups), edit / delete own (shown as "edited" / "message deleted"), pins,
-- links to orders (#86), machines (serial numbers) and board cards / boards.
-- Notifications: in the app and by phone push (0026); an email only if the
-- message is still unread after 30 minutes. Per conversation: all / mentions
-- only / muted. Quiet hours (no phone push) in Settings → Notifications.
-- Chat messages are NOT written to the activity log (they are private).
--
-- Paste this whole file into the Supabase SQL Editor and click Run.

-- ===========================================================================
-- 1. Tables
-- ===========================================================================
create table public.chat_conversations (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('direct', 'group', 'department', 'user_group', 'channel')),
  name             text,
  -- an admin renamed a department / group channel: the name no longer follows the department
  name_custom      boolean not null default false,
  department_id    uuid references public.departments (id) on delete cascade,
  group_id         uuid references public.user_groups (id) on delete cascade,
  direct_key       text unique,
  created_by       text,
  archived         boolean not null default false,
  archived_at      timestamptz,
  archived_by      text,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  check ((kind = 'direct') = (direct_key is not null)),
  check ((kind = 'department') = (department_id is not null)),
  check ((kind = 'user_group') = (group_id is not null)),
  check (kind = 'direct' or btrim(coalesce(name, '')) <> '')
);
create unique index chat_conversations_department_idx on public.chat_conversations (department_id) where kind = 'department';
create unique index chat_conversations_group_idx on public.chat_conversations (group_id) where kind = 'user_group';
create trigger chat_conversations_archived before insert or update of archived on public.chat_conversations
  for each row execute function public.set_archived_info();

create table public.chat_members (
  conversation_id  uuid not null references public.chat_conversations (id) on delete cascade,
  user_email       text not null references public.allowed_users (email) on update cascade on delete cascade,
  role             text not null default 'member' check (role in ('member', 'owner')),
  -- all / mentions (only @mentions notify) / mute
  notify           text not null default 'all' check (notify in ('all', 'mentions', 'mute')),
  -- taken out of a channel by an admin: stays out even if still in the department / group
  removed          boolean not null default false,
  last_read_at     timestamptz not null default now(),
  joined_at        timestamptz not null default now(),
  primary key (conversation_id, user_email)
);
create index chat_members_user_idx on public.chat_members (user_email) where not removed;

create table public.chat_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.chat_conversations (id) on delete cascade,
  author_email     text,
  author_name      text,
  body             text not null default '',
  body_text        text not null default '',
  reply_to         uuid references public.chat_messages (id) on delete set null,
  -- [{type: user | department | group, key, label}]
  mentions         jsonb not null default '[]'::jsonb,
  -- [{type: order | machine | board | card, id, text, board_id?}]
  links            jsonb not null default '[]'::jsonb,
  edited_at        timestamptz,
  deleted_at       timestamptz,
  pinned_at        timestamptz,
  pinned_by        text,
  created_at       timestamptz not null default now()
);
create index chat_messages_conv_idx on public.chat_messages (conversation_id, created_at desc);
create trigger chat_messages_safe_body before insert or update of body on public.chat_messages
  for each row execute function public.reject_unsafe_notes('body');

-- A small fixed set of reactions (a second approved emoji exception, like country flags).
create table public.chat_reactions (
  message_id  uuid not null references public.chat_messages (id) on delete cascade,
  user_email  text not null references public.allowed_users (email) on update cascade on delete cascade,
  emoji       text not null check (emoji in ('👍', '❤️', '😂', '😮', '🎉', '🙏', '✅')),
  created_at  timestamptz not null default now(),
  primary key (message_id, user_email, emoji)
);

-- Per person: hide online status, quiet hours (no phone push).
create table public.chat_settings (
  user_email     text primary key references public.allowed_users (email) on update cascade on delete cascade,
  hide_status    boolean not null default false,
  quiet_enabled  boolean not null default false,
  quiet_start    time not null default '21:00',
  quiet_end      time not null default '07:00',
  updated_at     timestamptz not null default now()
);

-- ===========================================================================
-- 2. Who may see what (members only, admins included)
-- ===========================================================================
create or replace function public.chat_is_member(p_conv uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_perm('chat', 'view') and exists (
    select 1 from public.chat_members m
     where m.conversation_id = p_conv and m.user_email = public.current_user_email() and not m.removed);
$$;

create or replace function public.chat_can_post(p_conv uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.chat_is_member(p_conv)
     and exists (select 1 from public.chat_conversations c where c.id = p_conv and not c.archived
                  and case when c.kind in ('direct', 'group') then public.has_perm('chat.send', 'edit')
                           else public.has_perm('chat.channels.post', 'edit') end);
$$;

alter table public.chat_conversations enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.chat_settings enable row level security;
create policy "Members only" on public.chat_conversations for select to authenticated using ((select public.chat_is_member(id)));
create policy "Members only" on public.chat_members for select to authenticated using ((select public.chat_is_member(conversation_id)));
create policy "Members only" on public.chat_messages for select to authenticated using ((select public.chat_is_member(conversation_id)));
create policy "Members only" on public.chat_reactions for select to authenticated
  using (exists (select 1 from public.chat_messages m where m.id = message_id and public.chat_is_member(m.conversation_id)));
create policy "Own chat settings" on public.chat_settings for select to authenticated using (user_email = (select public.current_user_email()));
-- Everything else goes through the functions below.
revoke insert, update, delete on public.chat_conversations, public.chat_members, public.chat_messages,
  public.chat_reactions, public.chat_settings from authenticated;

-- People and mention targets for pickers.
create or replace function public.chat_people()
returns table (email text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.email, coalesce(nullif(btrim(a.name), ''), a.email)
    from public.allowed_users a
   where public.has_perm('chat', 'view')
   order by 2;
$$;

create or replace function public.chat_mention_targets()
returns table (type text, key text, label text)
language sql
stable
security definer
set search_path = public
as $$
  select 'department', d.id::text, d.name from public.departments d where not d.archived and public.has_perm('chat', 'view')
  union all
  select 'group', g.id::text, g.name from public.user_groups g where not g.archived and public.has_perm('chat', 'view')
  order by 1, 3;
$$;

-- My departments and groups ("department:<id>", "group:<id>"), to highlight mentions of them.
create or replace function public.chat_my_targets()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select 'department:' || department_id from public.user_departments where user_email = public.current_user_email()
  union all
  select 'group:' || group_id from public.user_group_members where user_email = public.current_user_email();
$$;

-- ===========================================================================
-- 3. Starting conversations
-- ===========================================================================
create or replace function public.start_direct_chat(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   text := public.current_user_email();
  v_them text := lower(btrim(p_email));
  v_key  text;
  v_id   uuid;
begin
  perform public.require_perm('chat.direct', 'edit');
  if v_them = v_me then raise exception 'Choose someone else.'; end if;
  if not exists (select 1 from public.allowed_users where email = v_them) then
    raise exception 'That person could not be found.';
  end if;
  v_key := least(v_me, v_them) || '|' || greatest(v_me, v_them);
  select id into v_id from public.chat_conversations where direct_key = v_key;
  if v_id is null then
    insert into public.chat_conversations (kind, direct_key, created_by) values ('direct', v_key, v_me) returning id into v_id;
    insert into public.chat_members (conversation_id, user_email) values (v_id, v_me), (v_id, v_them);
  end if;
  return v_id;
end;
$$;

create or replace function public.create_group_chat(p_name text, p_emails text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
  v_id uuid;
begin
  perform public.require_perm('chat.groups', 'edit');
  if coalesce(btrim(p_name), '') = '' then raise exception 'Give the group chat a name.'; end if;
  if coalesce(array_length(p_emails, 1), 0) = 0 then raise exception 'Pick at least one person.'; end if;
  insert into public.chat_conversations (kind, name, created_by) values ('group', left(btrim(p_name), 80), v_me) returning id into v_id;
  insert into public.chat_members (conversation_id, user_email, role) values (v_id, v_me, 'owner');
  insert into public.chat_members (conversation_id, user_email)
  select v_id, a.email from public.allowed_users a where a.email = any (select lower(btrim(x)) from unnest(p_emails) x) and a.email <> v_me
  on conflict do nothing;
  return v_id;
end;
$$;

-- Group chats: members rename and add people; the owner removes people.
create or replace function public.update_group_chat(p_conv uuid, p_name text, p_add text[], p_remove text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('chat.groups', 'edit');
  if not exists (select 1 from public.chat_conversations where id = p_conv and kind = 'group') or not public.chat_is_member(p_conv) then
    raise exception 'That group chat could not be found.';
  end if;
  if p_name is not null then
    if btrim(p_name) = '' then raise exception 'Give the group chat a name.'; end if;
    update public.chat_conversations set name = left(btrim(p_name), 80) where id = p_conv;
  end if;
  if coalesce(array_length(p_add, 1), 0) > 0 then
    insert into public.chat_members (conversation_id, user_email)
    select p_conv, a.email from public.allowed_users a where a.email = any (select lower(btrim(x)) from unnest(p_add) x)
    on conflict (conversation_id, user_email) do update set removed = false;
  end if;
  if coalesce(array_length(p_remove, 1), 0) > 0 then
    if not exists (select 1 from public.chat_members where conversation_id = p_conv and user_email = v_me and role = 'owner') then
      raise exception 'Only the person who made the group chat can remove people. Anyone can leave it.';
    end if;
    delete from public.chat_members where conversation_id = p_conv and user_email = any (p_remove) and user_email <> v_me;
  end if;
end;
$$;

create or replace function public.leave_chat(p_conv uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.chat_conversations where id = p_conv and kind = 'group') then
    raise exception 'Only group chats can be left. Channels follow departments and groups.';
  end if;
  delete from public.chat_members where conversation_id = p_conv and user_email = public.current_user_email();
end;
$$;

-- ===========================================================================
-- 4. Department and group channels follow their members
-- ===========================================================================
create or replace function public.chat_sync_department(p_dept uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d  public.departments%rowtype;
  v_id uuid;
begin
  select * into v_d from public.departments where id = p_dept;
  if v_d.id is null then return; end if;
  insert into public.chat_conversations (kind, name, department_id, created_by)
  values ('department', v_d.name, v_d.id, 'automatic')
  on conflict (department_id) where kind = 'department' do nothing;
  select id into v_id from public.chat_conversations where department_id = p_dept and kind = 'department';
  update public.chat_conversations
     set name = case when name_custom then name else v_d.name end, archived = v_d.archived
   where id = v_id and (archived is distinct from v_d.archived or (not name_custom and name is distinct from v_d.name));
  insert into public.chat_members (conversation_id, user_email)
  select v_id, ud.user_email from public.user_departments ud where ud.department_id = p_dept
  on conflict do nothing;
  delete from public.chat_members m
   where m.conversation_id = v_id
     and not exists (select 1 from public.user_departments ud where ud.department_id = p_dept and ud.user_email = m.user_email);
end;
$$;

create or replace function public.chat_sync_user_group(p_group uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_g  public.user_groups%rowtype;
  v_id uuid;
begin
  select * into v_g from public.user_groups where id = p_group;
  if v_g.id is null then return; end if;
  insert into public.chat_conversations (kind, name, group_id, created_by)
  values ('user_group', v_g.name, v_g.id, 'automatic')
  on conflict (group_id) where kind = 'user_group' do nothing;
  select id into v_id from public.chat_conversations where group_id = p_group and kind = 'user_group';
  update public.chat_conversations
     set name = case when name_custom then name else v_g.name end, archived = v_g.archived
   where id = v_id and (archived is distinct from v_g.archived or (not name_custom and name is distinct from v_g.name));
  insert into public.chat_members (conversation_id, user_email)
  select v_id, gm.user_email from public.user_group_members gm where gm.group_id = p_group
  on conflict do nothing;
  delete from public.chat_members m
   where m.conversation_id = v_id
     and not exists (select 1 from public.user_group_members gm where gm.group_id = p_group and gm.user_email = m.user_email);
end;
$$;

create or replace function public.chat_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'departments' then
    perform public.chat_sync_department(coalesce(new.id, old.id));
  elsif tg_table_name = 'user_departments' then
    perform public.chat_sync_department(coalesce(new.department_id, old.department_id));
    if tg_op = 'UPDATE' and new.department_id is distinct from old.department_id then
      perform public.chat_sync_department(old.department_id);
    end if;
  elsif tg_table_name = 'user_groups' then
    perform public.chat_sync_user_group(coalesce(new.id, old.id));
  elsif tg_table_name = 'user_group_members' then
    perform public.chat_sync_user_group(coalesce(new.group_id, old.group_id));
  end if;
  return null;
end;
$$;
create trigger chat_sync after insert or update on public.departments
  for each row execute function public.chat_sync_trigger();
create trigger chat_sync after insert or update or delete on public.user_departments
  for each row execute function public.chat_sync_trigger();
create trigger chat_sync after insert or update on public.user_groups
  for each row execute function public.chat_sync_trigger();
create trigger chat_sync after insert or update or delete on public.user_group_members
  for each row execute function public.chat_sync_trigger();

-- Channels for every department and group there is now.
do $$
declare
  v uuid;
begin
  for v in select id from public.departments loop perform public.chat_sync_department(v); end loop;
  for v in select id from public.user_groups loop perform public.chat_sync_user_group(v); end loop;
end $$;

-- ===========================================================================
-- 5. Messages
-- ===========================================================================
create or replace function public.chat_plain(p_html text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(replace(replace(replace(replace(replace(
           regexp_replace(regexp_replace(coalesce(p_html, ''), '<\s*/?\s*(p|li|ul|ol|br|h2|h3|div|label)\M[^>]*>', ' ', 'gi'), '<[^>]+>', '', 'g'),
           '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '\s+', ' ', 'g'));
$$;

-- Orders (#86), machines (serial numbers), boards and cards the author can open.
create or replace function public.chat_find_links(p_text text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out jsonb := '[]'::jsonb;
  m     text[];
  v_id  uuid;
  r     record;
begin
  for m in select regexp_matches(p_text, '#(\d+(?:-\d+)?)\M', 'g') loop
    select id into v_id from public.orders where order_code = m[1] and cancelled_code is null and not archived;
    if v_id is not null and not v_out @> jsonb_build_array(jsonb_build_object('id', v_id)) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('type', 'order', 'id', v_id, 'text', '#' || m[1]));
    end if;
  end loop;
  for m in select regexp_matches(upper(p_text), '\m([A-Z]{2,6}-\d{3,6})\M', 'g') loop
    select id, order_id into r from public.order_machines where upper(serial_number) = m[1] and not archived limit 1;
    if r.id is not null and not v_out @> jsonb_build_array(jsonb_build_object('id', r.id)) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('type', 'machine', 'id', r.id, 'order_id', r.order_id, 'text', m[1]));
    end if;
  end loop;
  -- Board and card names (whole words, 5 letters or more), only where the author can see them.
  for r in
    select 'board' as type, b.id, b.name as text, b.id as board_id
      from public.boards b
     where not b.archived and length(b.name) >= 5 and public.board_level(b.id) >= 1
       and p_text ~* ('(^|\W)' || regexp_replace(b.name, '([^A-Za-z0-9 ])', '\\\1', 'g') || '($|\W)')
    union all
    select 'card', c.id, c.title, c.board_id
      from public.board_cards c join public.boards b on b.id = c.board_id
     where not c.archived and not b.archived and length(c.title) >= 5 and public.board_level(b.id) >= 1
       and p_text ~* ('(^|\W)' || regexp_replace(c.title, '([^A-Za-z0-9 ])', '\\\1', 'g') || '($|\W)')
     order by 3 desc
     limit 6
  loop
    v_out := v_out || jsonb_build_array(jsonb_build_object('type', r.type, 'id', r.id, 'text', r.text, 'board_id', r.board_id));
  end loop;
  return v_out;
end;
$$;

-- Mentions the sender is allowed to make (people, departments, groups that exist).
create or replace function public.chat_clean_mentions(p jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p, '[]'::jsonb)) x
   where (x ->> 'type' = 'user' and exists (select 1 from public.allowed_users a where a.email = x ->> 'key'))
      or (x ->> 'type' = 'department' and exists (select 1 from public.departments d where d.id::text = x ->> 'key'))
      or (x ->> 'type' = 'group' and exists (select 1 from public.user_groups g where g.id::text = x ->> 'key'));
$$;

-- Is this person mentioned (directly, or through a department or group)?
create or replace function public.chat_mentions_person(p_mentions jsonb, p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(p_mentions, '[]'::jsonb)) x
     where (x ->> 'type' = 'user' and x ->> 'key' = p_email)
        or (x ->> 'type' = 'department' and exists (select 1 from public.user_departments ud where ud.department_id::text = x ->> 'key' and ud.user_email = p_email))
        or (x ->> 'type' = 'group' and exists (select 1 from public.user_group_members gm where gm.group_id::text = x ->> 'key' and gm.user_email = p_email)));
$$;

-- What a conversation is called for one person (a direct message = the other person).
create or replace function public.chat_display_name(p_conv uuid, p_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when c.kind = 'direct' then
           (select coalesce(nullif(btrim(a.name), ''), a.email) from public.chat_members m join public.allowed_users a on a.email = m.user_email
             where m.conversation_id = c.id and m.user_email <> p_email limit 1)
         else c.name end
    from public.chat_conversations c
   where c.id = p_conv
     and exists (select 1 from public.chat_members m where m.conversation_id = c.id and m.user_email = public.current_user_email());
$$;

create or replace function public.post_chat_message(p_conv uuid, p_body text, p_reply_to uuid default null, p_mentions jsonb default '[]'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    text := public.current_user_email();
  v_name  text := public.current_user_name();
  v_text  text := public.chat_plain(p_body);
  v_ments jsonb := public.chat_clean_mentions(p_mentions);
  v_id    uuid;
  v_m     record;
  v_hit   boolean;
  v_kind  text := (select kind from public.chat_conversations where id = p_conv);
  v_conv_name text := (select name from public.chat_conversations where id = p_conv);
begin
  if not public.chat_can_post(p_conv) then
    raise exception 'You cannot write in this conversation.' using errcode = '42501';
  end if;
  if v_text = '' then raise exception 'Type a message first.'; end if;
  if length(p_body) > 20000 then raise exception 'The message is too long.'; end if;
  if p_reply_to is not null and not exists (select 1 from public.chat_messages where id = p_reply_to and conversation_id = p_conv) then
    raise exception 'The message you replied to is not in this conversation.';
  end if;
  insert into public.chat_messages (conversation_id, author_email, author_name, body, body_text, reply_to, mentions, links)
  values (p_conv, v_me, v_name, p_body, v_text, p_reply_to, v_ments, public.chat_find_links(v_text))
  returning id into v_id;
  update public.chat_conversations set last_message_at = now() where id = p_conv;
  update public.chat_members set last_read_at = now() where conversation_id = p_conv and user_email = v_me;

  -- Notify the other members (by their choice for this conversation).
  for v_m in select user_email, notify from public.chat_members where conversation_id = p_conv and not removed and user_email <> v_me loop
    continue when v_m.notify = 'mute';
    v_hit := public.chat_mentions_person(v_ments, v_m.user_email);
    continue when v_m.notify = 'mentions' and not v_hit;
    insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
    values (v_m.user_email, case when v_hit then 'chat_mention' else 'chat_message' end,
            case when v_kind = 'direct' then case when v_hit then v_name || ' mentioned you' else v_name end
                 when v_hit then v_name || ' mentioned you in ' || coalesce(v_conv_name, 'a conversation')
                 else coalesce(v_conv_name, 'Chat') end,
            v_name || ': ' || left(v_text, 160),
            '/chat/' || p_conv || '?m=' || v_id, 'chat:' || v_id)
    on conflict do nothing;
  end loop;
  return v_id;
end;
$$;

create or replace function public.edit_chat_message(p_id uuid, p_body text, p_mentions jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg  public.chat_messages%rowtype;
  v_text text := public.chat_plain(p_body);
begin
  select * into v_msg from public.chat_messages where id = p_id;
  if v_msg.id is null or v_msg.author_email is distinct from public.current_user_email() or v_msg.deleted_at is not null then
    raise exception 'You can only change your own messages.' using errcode = '42501';
  end if;
  if not public.chat_can_post(v_msg.conversation_id) then raise exception 'You cannot write in this conversation.' using errcode = '42501'; end if;
  if v_text = '' then raise exception 'Type a message first, or delete it.'; end if;
  update public.chat_messages
     set body = p_body, body_text = v_text, mentions = public.chat_clean_mentions(p_mentions),
         links = public.chat_find_links(v_text), edited_at = now()
   where id = p_id;
end;
$$;

create or replace function public.delete_chat_message(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chat_messages
     set body = '', body_text = '', mentions = '[]', links = '[]', deleted_at = now(), pinned_at = null, pinned_by = null
   where id = p_id and author_email = public.current_user_email() and deleted_at is null
     and public.chat_is_member(conversation_id);
  if not found then raise exception 'You can only delete your own messages.' using errcode = '42501'; end if;
  delete from public.chat_reactions where message_id = p_id;
  -- Its notifications go too (so the 30-minute email never shows the deleted text).
  delete from public.notifications where dedupe_key = 'chat:' || p_id;
end;
$$;

create or replace function public.pin_chat_message(p_id uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('chat.pin', 'edit');
  update public.chat_messages
     set pinned_at = case when p_pinned then now() end, pinned_by = case when p_pinned then public.current_user_name() end
   where id = p_id and deleted_at is null and public.chat_is_member(conversation_id);
  if not found then raise exception 'That message could not be found.'; end if;
end;
$$;

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
    delete from public.chat_reactions where message_id = p_id and user_email = v_me and emoji = p_emoji;
  else
    insert into public.chat_reactions (message_id, user_email, emoji) values (p_id, v_me, p_emoji);
  end if;
end;
$$;

-- Read: unread count to zero, its notifications read, and no 30-minute email.
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
  update public.chat_members set last_read_at = now() where conversation_id = p_conv and user_email = v_me;
  update public.notification_deliveries d set status = 'skipped', last_error = 'Read in the app'
    from public.notifications n
   where n.id = d.notification_id and n.user_email = v_me and n.kind in ('chat_message', 'chat_mention')
     and n.link like '/chat/' || p_conv || '%' and d.status = 'pending';
  update public.notifications set read_at = now()
   where user_email = v_me and kind in ('chat_message', 'chat_mention') and link like '/chat/' || p_conv || '%' and read_at is null;
end;
$$;

create or replace function public.set_chat_notify(p_conv uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_mode not in ('all', 'mentions', 'mute') then raise exception 'Choose All messages, Mentions only or Muted.'; end if;
  update public.chat_members set notify = p_mode
   where conversation_id = p_conv and user_email = public.current_user_email() and not removed;
  if not found then raise exception 'That conversation could not be found.'; end if;
end;
$$;

-- The conversation list with unread counts and the last message.
create or replace function public.my_chat_conversations()
returns table (id uuid, kind text, name text, other_email text, archived boolean, last_message_at timestamptz,
               last_author text, last_text text, unread integer, mentions integer, notify text, members integer, can_post boolean)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.kind, public.chat_display_name(c.id, me.user_email),
         case when c.kind = 'direct' then (select m2.user_email from public.chat_members m2 where m2.conversation_id = c.id and m2.user_email <> me.user_email limit 1) end,
         c.archived, c.last_message_at,
         lm.author_name, case when lm.deleted_at is not null then 'Message deleted' else left(lm.body_text, 120) end,
         (select count(*)::int from public.chat_messages x
           where x.conversation_id = c.id and x.created_at > me.last_read_at and x.author_email is distinct from me.user_email and x.deleted_at is null),
         (select count(*)::int from public.chat_messages x
           where x.conversation_id = c.id and x.created_at > me.last_read_at and x.author_email is distinct from me.user_email and x.deleted_at is null
             and public.chat_mentions_person(x.mentions, me.user_email)),
         me.notify,
         (select count(*)::int from public.chat_members m3 where m3.conversation_id = c.id and not m3.removed),
         public.chat_can_post(c.id)
    from public.chat_members me
    join public.chat_conversations c on c.id = me.conversation_id
    left join lateral (select * from public.chat_messages x where x.conversation_id = c.id order by x.created_at desc limit 1) lm on true
   where me.user_email = public.current_user_email() and not me.removed and public.has_perm('chat', 'view')
   order by coalesce(c.last_message_at, c.created_at) desc;
$$;

create or replace function public.chat_unread_total()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(case when c.notify = 'mute' then 0 else c.unread end), 0)::int
    from public.my_chat_conversations() c where not c.archived;
$$;

-- Search across my conversations.
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
     and m.body_text ilike '%' || replace(replace(btrim(p_query), '%', '\%'), '_', '\_') || '%'
   order by m.created_at desc
   limit 50;
$$;

-- ===========================================================================
-- 6. My chat settings (status, quiet hours)
-- ===========================================================================
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
end;
$$;

-- Who hides their online status (others never see them as online).
create or replace function public.chat_hidden_people()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select user_email from public.chat_settings where hide_status and public.has_perm('chat', 'view');
$$;

create or replace function public.in_quiet_hours(p_email text, p_at timestamptz default now())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case when s.quiet_start <= s.quiet_end
                then (p_at at time zone 'America/Halifax')::time >= s.quiet_start and (p_at at time zone 'America/Halifax')::time < s.quiet_end
                else (p_at at time zone 'America/Halifax')::time >= s.quiet_start or (p_at at time zone 'America/Halifax')::time < s.quiet_end end
      from public.chat_settings s where s.user_email = p_email and s.quiet_enabled), false);
$$;

-- ===========================================================================
-- 7. Notifications: kinds, 30-minute email, quiet hours
-- ===========================================================================
insert into public.notification_kinds (kind, label, description, sort_order, default_modes) values
  ('chat_message', 'Chat messages', 'A new message in a conversation you belong to. The email is only sent if it is still unread after 30 minutes.', 70, '{"app": "on", "email": "instant", "push": "on"}'),
  ('chat_mention', 'Chat mentions', 'Someone mentions you (or your department or group) in a chat. The email is only sent if it is still unread after 30 minutes.', 75, '{"app": "on", "email": "instant", "push": "on"}')
on conflict (kind) do nothing;

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
  -- Quiet hours: no phone push (the bell still shows it).
  if new.channel = 'push' and public.in_quiet_hours(new.user_email) then
    new.status := 'skipped';
    new.last_error := 'Quiet hours';
  end if;
  return new;
end;
$$;
create trigger notification_deliveries_chat_quiet before insert on public.notification_deliveries
  for each row execute function public.notification_deliveries_chat_quiet();

-- ===========================================================================
-- 8. Admin → Chat: channels only (never direct messages or group chats)
-- ===========================================================================
create or replace function public.admin_chat_channels()
returns table (id uuid, kind text, name text, archived boolean, members integer, removed integer, last_message_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.kind, c.name, c.archived,
         (select count(*)::int from public.chat_members m where m.conversation_id = c.id and not m.removed),
         (select count(*)::int from public.chat_members m where m.conversation_id = c.id and m.removed),
         c.last_message_at
    from public.chat_conversations c
   where c.kind in ('department', 'user_group', 'channel') and public.can_admin('chat')
   order by c.archived, c.kind, c.name;
$$;

create or replace function public.admin_chat_channel_members(p_conv uuid)
returns table (email text, name text, removed boolean)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_email, coalesce(nullif(btrim(a.name), ''), a.email), m.removed
    from public.chat_members m join public.chat_conversations c on c.id = m.conversation_id
    left join public.allowed_users a on a.email = m.user_email
   where m.conversation_id = p_conv and c.kind in ('department', 'user_group', 'channel') and public.can_admin('chat')
   order by 3, 2;
$$;

create or replace function public.admin_create_chat_channel(p_name text, p_emails text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_admin_area('chat');
  if coalesce(btrim(p_name), '') = '' then raise exception 'Give the channel a name.'; end if;
  insert into public.chat_conversations (kind, name, created_by) values ('channel', left(btrim(p_name), 80), public.current_user_email()) returning id into v_id;
  insert into public.chat_members (conversation_id, user_email)
  select v_id, a.email from public.allowed_users a where a.email = any (select lower(btrim(x)) from unnest(p_emails) x)
  on conflict do nothing;
  perform public.log_admin_action('chat_conversations', v_id::text, null, jsonb_build_object('action', 'chat channel created', 'name', btrim(p_name)));
  return v_id;
end;
$$;

-- Rename, archive / restore, add or remove members of a channel.
create or replace function public.admin_update_chat_channel(p_conv uuid, p_name text, p_archived boolean, p_add text[], p_remove text[], p_restore text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.chat_conversations%rowtype;
begin
  perform public.require_admin_area('chat');
  select * into v_c from public.chat_conversations where id = p_conv and kind in ('department', 'user_group', 'channel');
  if v_c.id is null then raise exception 'That channel could not be found.'; end if;
  if p_name is not null and btrim(p_name) <> '' and p_name <> v_c.name then
    update public.chat_conversations set name = left(btrim(p_name), 80), name_custom = kind <> 'channel' where id = p_conv;
  end if;
  if p_archived is not null and p_archived <> v_c.archived then
    update public.chat_conversations set archived = p_archived where id = p_conv;
  end if;
  if coalesce(array_length(p_add, 1), 0) > 0 then
    insert into public.chat_members (conversation_id, user_email)
    select p_conv, a.email from public.allowed_users a where a.email = any (select lower(btrim(x)) from unnest(p_add) x)
    on conflict (conversation_id, user_email) do update set removed = false;
  end if;
  if coalesce(array_length(p_remove, 1), 0) > 0 then
    update public.chat_members set removed = true where conversation_id = p_conv and user_email = any (p_remove);
  end if;
  if coalesce(array_length(p_restore, 1), 0) > 0 then
    update public.chat_members set removed = false where conversation_id = p_conv and user_email = any (p_restore);
  end if;
  perform public.log_admin_action('chat_conversations', p_conv::text, null, jsonb_build_object(
    'action', 'chat channel changed', 'name', coalesce(p_name, v_c.name), 'archived', p_archived,
    'added', p_add, 'removed', p_remove, 'restored', p_restore));
end;
$$;

-- ===========================================================================
-- 9. Live updates (Supabase Realtime), start page
-- ===========================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.chat_messages, public.chat_reactions, public.chat_members, public.chat_conversations;
  end if;
end $$;

-- Typing and online status use private Realtime channels: "chat:<conversation id>"
-- for members only, and "chat-presence" for everyone who may use chat.
create or replace function public.chat_realtime_allowed(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_topic = 'chat-presence' then public.has_perm('chat', 'view')
    when p_topic ~ '^chat:[0-9a-f-]{36}$' then public.chat_is_member(substr(p_topic, 6)::uuid)
    else false end;
$$;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'realtime' and table_name = 'messages') then
    execute $p$create policy "Chat: members receive" on realtime.messages for select to authenticated
             using (public.chat_realtime_allowed(realtime.topic()))$p$;
    execute $p$create policy "Chat: members send" on realtime.messages for insert to authenticated
             with check (public.chat_realtime_allowed(realtime.topic()))$p$;
  end if;
end $$;

alter table public.user_preferences drop constraint user_preferences_start_page_check;
alter table public.user_preferences add constraint user_preferences_start_page_check
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/reports/department-delays',
     '/reports/build-times', '/boards', '/service', '/service/calendar', '/chat', '/agent', '/settings', '/admin', '/shop-board'));

-- Technician preset: chat too.
update public.permission_templates
   set perms = perms || '{"chat": "view", "chat.send": "edit", "chat.members": "view", "chat.direct": "edit", "chat.groups": "edit", "chat.channels.post": "edit", "chat.pin": "edit", "chat.search": "view", "chat.presence": "view", "settings.quiet_hours": "edit", "settings.chat_status": "edit"}'::jsonb
 where lower(btrim(name)) = 'technician';

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
