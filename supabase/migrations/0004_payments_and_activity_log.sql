-- 0004_payments_and_activity_log.sql
-- 1. Balance amount is always order total - down payment.
-- 2. Every change to every table is written to activity_log (who, what, when).

-- ---------------------------------------------------------------------------
-- Balance = order total - down payment
-- ---------------------------------------------------------------------------
create or replace function public.payments_set_balance_amount()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'balance' then
    select o.order_total - coalesce((
             select p.amount from public.payments p
              where p.order_id = new.order_id and p.kind = 'down_payment'), 0)
      into new.amount
      from public.orders o
     where o.id = new.order_id;
  end if;
  return new;
end;
$$;

create trigger payments_set_balance_amount
  before insert or update on public.payments
  for each row execute function public.payments_set_balance_amount();

-- Recalculate the balance row of one order.
create or replace function public.refresh_balance(p_order_id uuid)
returns void
language sql
as $$
  update public.payments
     set amount = amount   -- the trigger above recalculates it
   where order_id = p_order_id and kind = 'balance';
$$;

create or replace function public.payments_after_down_payment()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'INSERT' and old.kind = 'down_payment' then
    perform public.refresh_balance(old.order_id);
  end if;
  if tg_op <> 'DELETE' and new.kind = 'down_payment' then
    perform public.refresh_balance(new.order_id);
  end if;
  return null;
end;
$$;

create trigger payments_after_down_payment
  after insert or update or delete on public.payments
  for each row execute function public.payments_after_down_payment();

create or replace function public.orders_after_total()
returns trigger
language plpgsql
as $$
begin
  if new.order_total is distinct from old.order_total then
    perform public.refresh_balance(new.id);
  end if;
  return null;
end;
$$;

create trigger orders_after_total
  after update of order_total on public.orders
  for each row execute function public.orders_after_total();

-- ---------------------------------------------------------------------------
-- Activity log
-- Insert: stores the new row. Delete: stores the old row.
-- Update: stores only the fields that changed, as {"field": {"old":..,"new":..}}.
-- user_email is empty when the change came from the Supabase dashboard or an
-- automatic job rather than a signed-in user.
-- Runs as the database owner ("security definer") so users can never write
-- to or edit the log themselves.
-- ---------------------------------------------------------------------------
create or replace function public.log_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_row     jsonb;
  v_changes jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old) - 'updated_at'; end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new) - 'updated_at'; end if;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', v_old -> n.key, 'new', n.value))
      into v_changes
      from jsonb_each(v_new) as n
     where n.value is distinct from (v_old -> n.key);
    if v_changes is null then
      return null;  -- nothing really changed
    end if;
  else
    v_changes := v_row;
  end if;

  insert into public.activity_log (user_id, user_email, table_name, record_id, order_id, action, changes)
  values (
    auth.uid(),
    auth.jwt() ->> 'email',
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'email'),
    case when tg_table_name = 'orders' then (v_row ->> 'id')::uuid
         else (v_row ->> 'order_id')::uuid end,
    lower(tg_op),
    v_changes
  );
  return null;
end;
$$;

create trigger log_activity after insert or update or delete on public.allowed_users
  for each row execute function public.log_activity();
create trigger log_activity after insert or update or delete on public.customers
  for each row execute function public.log_activity();
create trigger log_activity after insert or update or delete on public.machine_types
  for each row execute function public.log_activity();
create trigger log_activity after insert or update or delete on public.orders
  for each row execute function public.log_activity();
create trigger log_activity after insert or update or delete on public.order_machines
  for each row execute function public.log_activity();
create trigger log_activity after insert or update or delete on public.payments
  for each row execute function public.log_activity();
