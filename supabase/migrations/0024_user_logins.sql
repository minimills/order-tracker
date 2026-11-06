-- 0024_user_logins.sql
-- Admin → Users creates real login accounts (Supabase "Allow new users to sign
-- up" stays OFF). The Edge Function `admin-users` (supabase/functions) makes
-- the login with the Supabase admin API, then calls these functions AS THE
-- ADMIN who clicked, so every rule below still applies.
--
-- 1. admin_add_user(): adds a person to the users list with their departments,
--    start page and permissions, all or nothing.
-- 2. admin_remove_user(): takes a person off the users list (their history in
--    the activity log stays; the Edge Function also blocks their login).
-- 3. can_sign_in(): the sign-in page asks this before sending a code, so
--    unknown emails get "This email doesn't have access".
-- 4. admin_auth_user_id(): finds a login account by email (Edge Function only).

-- ===========================================================================
-- 1. Add a person in one step
-- ===========================================================================
create or replace function public.admin_add_user(
  p_email        text,
  p_name         text default null,
  p_role         text default 'staff',
  p_departments  uuid[] default '{}',
  p_start_page   text default null,
  p_perms        jsonb default null,
  p_perms_source text default null)
returns void
language plpgsql
as $$
declare
  v_email text := lower(btrim(p_email));
begin
  perform public.require_admin_area('users');
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a full email address, e.g. name@minimills.net' using errcode = '22023';
  end if;
  if exists (select 1 from public.allowed_users where email = v_email) then
    raise exception '% already has access to the app.', v_email using errcode = '23505';
  end if;
  if coalesce(p_role, 'staff') not in ('admin', 'staff') then
    raise exception 'Unknown role %.', p_role using errcode = '22023';
  end if;
  -- Row security and the role guard apply (only full admins add admins).
  insert into public.allowed_users (email, name, role)
  values (v_email, nullif(btrim(coalesce(p_name, '')), ''), coalesce(p_role, 'staff'));
  if coalesce(cardinality(p_departments), 0) > 0 then
    insert into public.user_departments (user_email, department_id)
    select v_email, d from unnest(p_departments) d;
  end if;
  if nullif(btrim(coalesce(p_start_page, '')), '') is not null then
    perform public.set_start_page(v_email, p_start_page);
  end if;
  -- Permissions: full admins only (set_user_permissions checks).
  if p_perms is not null and p_perms <> '{}'::jsonb and coalesce(p_role, 'staff') = 'staff' then
    perform public.set_user_permissions(v_email, p_perms, coalesce(p_perms_source, 'added with this person'));
  end if;
end;
$$;

-- ===========================================================================
-- 2. Remove a person (history stays)
-- ===========================================================================
create or replace function public.admin_remove_user(p_email text)
returns void
language plpgsql
as $$
declare
  v_email text := lower(btrim(p_email));
begin
  perform public.require_admin_area('users');
  -- Row security, the role guard and "at least one admin" apply.
  delete from public.allowed_users where email = v_email;
  if not found then
    raise exception '% is not on the users list.', v_email using errcode = 'P0002';
  end if;
  perform public.log_admin_action('allowed_users', v_email, null,
    jsonb_build_object('action', 'access removed', 'user', v_email));
end;
$$;

-- ===========================================================================
-- 3. May this email sign in? (asked by the sign-in page, before signing in)
-- ===========================================================================
create or replace function public.can_sign_in(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.allowed_users where email = lower(btrim(p_email)));
$$;

-- ===========================================================================
-- 4. Login account id for an email (the Edge Function only, with the service key)
-- ===========================================================================
create or replace function public.admin_auth_user_id(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(btrim(p_email)) order by created_at limit 1;
$$;

-- Access lockdown, as in earlier migrations, then the exceptions.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
-- The sign-in page runs before anyone is signed in.
grant execute on function public.can_sign_in(text) to anon;
-- Only the Edge Function (service role) may look up login accounts.
revoke execute on function public.admin_auth_user_id(text) from authenticated;
grant execute on function public.admin_auth_user_id(text) to service_role;
