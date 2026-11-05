-- 0021_start_page_and_safe_notes.sql
-- 1. A start page per person (the page they land on after signing in).
--    Set by admins / people with "admin.users" in Admin → Users, or by the
--    person themselves in Settings with "settings.start_page".
--    If the page isn't allowed for them, the app falls back to their first
--    allowed page.
-- 2. Notes with formatting (bold, italic, lists) are stored as small pieces of
--    HTML. The app cleans them; the database also refuses anything script-like
--    (script/iframe/… tags, on…= handlers, javascript: links).

-- ===========================================================================
-- 1. Start page
-- ===========================================================================
alter table public.user_preferences
  add column start_page text
  check (start_page is null or start_page in
    ('/dashboard', '/board', '/orders', '/orders/new', '/payments', '/crating', '/agent', '/settings', '/admin', '/shop-board'));

-- People who manage users can see everyone's start page.
create policy "User managers can read preferences" on public.user_preferences
  for select to authenticated using ((select public.can_admin('users')));

-- Sets someone's start page (null = their first allowed page). Logged.
create or replace function public.set_start_page(p_email text, p_page text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
  v_page  text := nullif(btrim(coalesce(p_page, '')), '');
  v_old   text;
begin
  if v_email = public.current_user_email() then
    perform public.require_perm('settings.start_page');
  else
    perform public.require_admin_area('users');
  end if;
  if not exists (select 1 from public.allowed_users where email = v_email) then
    raise exception 'No user with the email %.', v_email;
  end if;
  select start_page into v_old from public.user_preferences where user_email = v_email;
  insert into public.user_preferences (user_email, start_page)
  values (v_email, v_page)
  on conflict (user_email) do update set start_page = excluded.start_page;
  if v_old is distinct from v_page then
    perform public.log_admin_action('allowed_users', v_email, null,
      jsonb_build_object('action', 'start page', 'user', v_email, 'old', v_old, 'new', v_page));
  end if;
end;
$$;

-- ===========================================================================
-- 2. Safe notes
-- ===========================================================================
create or replace function public.is_safe_rich_text(p_text text)
returns boolean
language sql
immutable
as $$
  select p_text is null
      or p_text !~* '<\s*/?\s*(script|iframe|object|embed|style|link|meta|base|form|svg|math|img|video|audio|source|frame|frameset|applet|template|textarea|button|select|a)(\s|>|/)'
     and p_text !~* '\son[a-z]+\s*='
     and p_text !~* '(javascript|vbscript)\s*:'
     and p_text !~* 'srcdoc';
$$;

-- Checks the column named in the trigger (e.g. 'notes').
create or replace function public.reject_unsafe_notes()
returns trigger
language plpgsql
as $$
begin
  if not public.is_safe_rich_text(to_jsonb(new) ->> tg_argv[0]) then
    raise exception 'These notes contain something that is not allowed (only bold, italic and lists).'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger orders_safe_notes before insert or update of notes on public.orders
  for each row execute function public.reject_unsafe_notes('notes');
create trigger customers_safe_notes before insert or update of notes on public.customers
  for each row execute function public.reject_unsafe_notes('notes');
create trigger machine_checklists_safe_notes before insert or update of general_notes on public.machine_checklists
  for each row execute function public.reject_unsafe_notes('general_notes');

-- Access lockdown, as in earlier migrations.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
