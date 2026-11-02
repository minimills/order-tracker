-- 0001_tables.sql
-- Creates all the tables. Row Level Security is switched ON for every table
-- right away (with no rules yet), so nothing is reachable from the website
-- until migration 0006 adds the "allowed users only" rules.

-- ---------------------------------------------------------------------------
-- Small helper: keeps an "updated_at" column current on every edit.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- allowed_users: the email addresses that may sign in and use the app.
-- ---------------------------------------------------------------------------
create table public.allowed_users (
  email      text primary key check (email = lower(email) and email like '%@%'),
  name       text,
  created_at timestamptz not null default now()
);
alter table public.allowed_users enable row level security;

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table public.customers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  company        text,
  emails         text[] not null default '{}',
  phone          text,
  country        text,
  state_province text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index customers_name_idx on public.customers (lower(name));
create index customers_company_idx on public.customers (lower(company));
alter table public.customers enable row level security;
create trigger customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- machine_types: e.g. "Carder - Large" with code LCR.
-- next_serial_number is the number the NEXT machine of this type will get.
-- code is empty (null) for types whose code has not been decided yet;
-- machines of those types get no serial number until a code is filled in.
-- ---------------------------------------------------------------------------
create table public.machine_types (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  code               text unique check (code ~ '^[A-Z0-9]+$'),
  next_serial_number integer not null default 1 check (next_serial_number > 0),
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.machine_types enable row level security;
create trigger machine_types_updated_at before update on public.machine_types
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- orders
-- order_number is the main number (76). split_number is used for a split
-- shipment (76-1, 76-2). order_code is the text shown on screen ("76-1").
-- board_position is the shop board number; it is managed automatically
-- (see migration 0003) – do not edit it by hand, use move_board().
-- ---------------------------------------------------------------------------
create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  order_number       integer not null check (order_number > 0),
  split_number       integer check (split_number > 0),
  order_code         text generated always as
                       (order_number::text || coalesce('-' || split_number::text, '')) stored,
  customer_id        uuid not null references public.customers (id) on delete restrict,
  stage              text not null default 'Quote'
                       check (stage in ('Quote', 'Confirmed', 'In production', 'Ready to ship', 'Shipped', 'Cancelled')),
  board_position     integer check (board_position > 0),
  order_date         date not null default (now() at time zone 'America/Halifax')::date,
  currency           text not null default 'CAD' check (currency in ('CAD', 'USD')),
  order_total        numeric(12, 2) not null default 0 check (order_total >= 0),
  expected_ship_date date,
  actual_ship_date   date,
  voltage            text not null default 'Unknown'
                       check (voltage in ('120V', '240V', 'Unknown')),
  delivery_equipment text not null default 'Unknown'
                       check (delivery_equipment in ('Liftgate', 'No liftgate', 'Forklift', 'Tractor with forks', 'Unknown')),
  freight_type       text check (freight_type in ('LTL', 'FTL', 'LCL', '40'' container', 'Other')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint orders_number_unique unique nulls not distinct (order_number, split_number),
  constraint orders_board_position_unique unique (board_position) deferrable initially deferred
);
create index orders_customer_idx on public.orders (customer_id);
create index orders_stage_idx on public.orders (stage);
alter table public.orders enable row level security;
create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

-- Next order number = highest existing order number + 1.
create or replace function public.next_order_number()
returns integer
language sql
as $$
  select coalesce(max(order_number), 0) + 1 from public.orders;
$$;
alter table public.orders alter column order_number set default public.next_order_number();

-- ---------------------------------------------------------------------------
-- order_machines: the machines in an order.
-- ready = the machine is built. Built machines keep their serial forever.
-- Serial numbers are filled in automatically (see migration 0003).
-- ---------------------------------------------------------------------------
create table public.order_machines (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id) on delete cascade,
  machine_type_id uuid not null references public.machine_types (id) on delete restrict,
  serial_number   text,
  ready           boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- "deferrable" lets serials be swapped between machines in one step
  constraint order_machines_serial_unique unique (serial_number) deferrable initially deferred
);
create index order_machines_order_idx on public.order_machines (order_id);
create index order_machines_type_idx on public.order_machines (machine_type_id);
alter table public.order_machines enable row level security;
create trigger order_machines_updated_at before update on public.order_machines
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- payments: one "down_payment" row, one "balance" row and any number of
-- "extra" rows per order. A payment counts as paid once received_date is set.
-- The balance amount is calculated automatically (order total - down payment).
-- ---------------------------------------------------------------------------
create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  kind          text not null check (kind in ('down_payment', 'balance', 'extra')),
  amount        numeric(12, 2) not null default 0,
  due_date      date,
  received_date date,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index payments_order_idx on public.payments (order_id);
create unique index payments_one_down_payment on public.payments (order_id) where kind = 'down_payment';
create unique index payments_one_balance on public.payments (order_id) where kind = 'balance';
alter table public.payments enable row level security;
create trigger payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- activity_log: every insert / change / delete, with who and when.
-- Filled automatically by triggers (migration 0004). Read-only for users.
-- ---------------------------------------------------------------------------
create table public.activity_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  user_email text,
  table_name text not null,
  record_id  text,
  order_id   uuid,
  action     text not null check (action in ('insert', 'update', 'delete')),
  changes    jsonb not null
);
create index activity_log_at_idx on public.activity_log (at desc);
create index activity_log_order_idx on public.activity_log (order_id, at desc);
create index activity_log_record_idx on public.activity_log (table_name, record_id, at desc);
alter table public.activity_log enable row level security;
