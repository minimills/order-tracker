-- 0006_security.sql
-- Row Level Security: only signed-in users whose email is in allowed_users
-- can read or write anything. Everyone else (including people who are not
-- signed in) sees nothing.

-- True when the signed-in user's email is in allowed_users.
-- "security definer" lets it look at allowed_users without being blocked
-- by allowed_users' own rules.
create or replace function public.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_users a
     where a.email = lower(auth.jwt() ->> 'email')
  );
$$;

-- Make sure RLS is on everywhere (it already is from 0001; this is a safety net).
alter table public.allowed_users  enable row level security;
alter table public.customers      enable row level security;
alter table public.machine_types  enable row level security;
alter table public.orders         enable row level security;
alter table public.order_machines enable row level security;
alter table public.payments       enable row level security;
alter table public.activity_log   enable row level security;

-- Full read/write for allowed users.
create policy "Allowed users can do everything" on public.customers
  for all to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));

create policy "Allowed users can do everything" on public.machine_types
  for all to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));

create policy "Allowed users can do everything" on public.orders
  for all to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));

create policy "Allowed users can do everything" on public.order_machines
  for all to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));

create policy "Allowed users can do everything" on public.payments
  for all to authenticated
  using ((select public.is_allowed_user())) with check ((select public.is_allowed_user()));

-- Read-only for allowed users. The log is written only by the database itself;
-- the allowed-users list is managed in the Supabase SQL Editor.
create policy "Allowed users can read" on public.activity_log
  for select to authenticated
  using ((select public.is_allowed_user()));

create policy "Allowed users can read" on public.allowed_users
  for select to authenticated
  using ((select public.is_allowed_user()));

-- People who are not signed in get no access at all.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Functions: only signed-in users may call them (the rules above still apply
-- inside, so a signed-in user who is not allowed cannot change anything).
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
