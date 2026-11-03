-- 0016_departments.sql
-- Departments.
-- 1. departments: name, place in the list, archived, and a default permission
--    preset (filled in by a later step; an empty preset means "no defaults").
--    Everyone signed in can read them; only admins change them.
-- 2. user_departments: which departments each person belongs to (any number).
--    Admins manage it; staff can see their own.
-- 3. activity_log.user_departments: the department(s) of the person who made
--    each change, saved at the moment of the change (renaming a department
--    later does not rewrite history).

-- ===========================================================================
-- 1. departments
-- ===========================================================================
create table public.departments (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (btrim(name) <> ''),
  sort_order          integer not null default 0,
  -- Default permissions for people in this department (structure added later).
  default_permissions jsonb not null default '{}'::jsonb,
  archived            boolean not null default false,
  archived_at         timestamptz,
  archived_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index departments_name_unique on public.departments (lower(btrim(name)));
alter table public.departments enable row level security;

create trigger departments_updated_at before update on public.departments
  for each row execute function public.set_updated_at();
create trigger departments_archived_info before insert or update of archived on public.departments
  for each row execute function public.set_archived_info();
create trigger log_activity after insert or update or delete on public.departments
  for each row execute function public.log_activity();

create policy "Allowed users can read" on public.departments
  for select to authenticated using ((select public.is_allowed_user()));
create policy "Admins can change" on public.departments
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

insert into public.departments (name, sort_order) values
  ('Office', 1),
  ('Fabrication Shop', 2),
  ('Assembly Shop', 3),
  ('Sandblasting/Powder Coating', 4),
  ('Shipping', 5);

-- ===========================================================================
-- 2. user_departments
-- ===========================================================================
create table public.user_departments (
  user_email    text not null references public.allowed_users (email) on delete cascade on update cascade,
  department_id uuid not null references public.departments (id) on delete restrict,
  created_at    timestamptz not null default now(),
  primary key (user_email, department_id)
);
create index user_departments_department_idx on public.user_departments (department_id);
alter table public.user_departments enable row level security;

create trigger log_activity after insert or update or delete on public.user_departments
  for each row execute function public.log_activity();

create policy "Admins manage, people see their own" on public.user_departments
  for select to authenticated
  using ((select public.is_admin()) or user_email = (select public.current_user_email()));
create policy "Admins can change" on public.user_departments
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- The departments of the signed-in person (empty for the dashboard / automatic jobs).
create or replace function public.my_departments()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(d.name order by d.sort_order, d.name), '{}')
    from public.user_departments ud
    join public.departments d on d.id = ud.department_id
   where ud.user_email = public.current_user_email();
$$;

-- ===========================================================================
-- 3. activity_log.user_departments
-- ===========================================================================
alter table public.activity_log add column user_departments text[];
create index activity_log_departments_idx on public.activity_log using gin (user_departments);

-- Every new activity line gets the departments of the person making the change.
create or replace function public.activity_log_set_departments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_departments is null and new.user_email is not null then
    select coalesce(array_agg(d.name order by d.sort_order, d.name), '{}')
      into new.user_departments
      from public.user_departments ud
      join public.departments d on d.id = ud.department_id
     where ud.user_email = lower(new.user_email);
  end if;
  return new;
end;
$$;

create trigger activity_log_set_departments before insert on public.activity_log
  for each row execute function public.activity_log_set_departments();

-- Access: same rules as before.
revoke all on public.departments, public.user_departments from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
