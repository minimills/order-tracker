-- 0010_payments_received.sql
-- For the Order detail page and the Payments page.
-- 1. payments.received_amount: how much has actually come in. A payment can
--    be received in parts; it counts as Paid once the full amount is in.
-- 2. payment_overview view: every payment with its order, customer, what is
--    still to pay, and a status: Paid / Overdue / Due soon (within 7 days) /
--    Upcoming / Nothing due.
-- 3. record_payment_received(): adds a received amount and date in one safe step.
-- 4. order_summary now counts received amounts (so part-payments show).

-- ===========================================================================
-- 1. Received amount
-- ===========================================================================
alter table public.payments
  add column received_amount numeric(12, 2) check (received_amount >= 0);

comment on column public.payments.received_amount is
  'Total received so far for this payment. received_date is the date of the latest receipt.';

-- Payments already marked received were received in full.
update public.payments
   set received_amount = amount
 where received_date is not null and received_amount is null;

-- ===========================================================================
-- 2. payment_overview
-- ===========================================================================
create view public.payment_overview
with (security_invoker = true)
as
select
  p.id,
  p.order_id,
  o.order_number,
  o.split_number,
  o.order_code,
  o.stage,
  o.archived                                     as order_archived,
  o.currency,
  o.customer_id,
  c.name                                         as customer_name,
  c.company                                      as customer_company,
  c.country                                      as customer_country,
  c.emails                                       as customer_emails,
  p.payment_type,
  p.amount,
  coalesce(p.received_amount, 0)                as received_amount,
  greatest(p.amount - coalesce(p.received_amount, 0), 0) as remaining,
  p.due_date,
  p.received_date,
  p.notes,
  p.due_date - (now() at time zone 'America/Halifax')::date as days_until_due,
  case
    when p.amount <= 0                                           then 'Nothing due'
    when p.amount - coalesce(p.received_amount, 0) <= 0          then 'Paid'
    when p.due_date < (now() at time zone 'America/Halifax')::date      then 'Overdue'
    when p.due_date <= (now() at time zone 'America/Halifax')::date + 7 then 'Due soon'
    else 'Upcoming'
  end                                            as status,
  p.created_at
from public.payments p
join public.orders o    on o.id = p.order_id
join public.customers c on c.id = o.customer_id;

-- ===========================================================================
-- 3. record_payment_received(payment, date, amount)
-- Adds the amount to what was already received and sets the date.
-- ===========================================================================
create or replace function public.record_payment_received(
  p_payment_id uuid,
  p_date       date,
  p_amount     numeric
)
returns void
language plpgsql
as $$
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount received (more than 0).';
  end if;
  if p_date is null then
    raise exception 'Enter the date the payment was received.';
  end if;
  update public.payments
     set received_amount = coalesce(received_amount, 0) + round(p_amount, 2),
         received_date   = p_date
   where id = p_payment_id;
  if not found then
    raise exception 'That payment could not be found.';
  end if;
end;
$$;

-- ===========================================================================
-- 4. order_summary: count received amounts
-- ===========================================================================
drop view public.order_summary;
create view public.order_summary
with (security_invoker = true)
as
select
  o.id,
  o.order_number,
  o.split_number,
  o.order_code,
  o.stage,
  o.board_position,
  o.order_date,
  o.customer_id,
  c.name                                         as customer_name,
  c.company                                      as customer_company,
  c.country                                      as customer_country,
  c.state_province                               as customer_state_province,
  o.currency,
  o.order_total,
  o.expected_ship_date,
  o.actual_ship_date,
  o.actual_ship_date - o.expected_ship_date      as delay_days,   -- negative = early
  o.expected_ship_date - (now() at time zone 'America/Halifax')::date as days_until_ship,
  o.voltage,
  o.delivery_equipment,
  o.freight_type,
  o.notes,
  coalesce(m.machines_count, 0)                  as machines_count,
  coalesce(m.machines_ready_count, 0)            as machines_ready_count,
  m.machines_list,
  m.serials,
  dp.amount                                      as down_payment_amount,
  case when o.order_total > 0 and dp.amount is not null
       then round(dp.amount * 100 / o.order_total, 1) end as down_payment_percent,
  coalesce(p.total_paid, 0)                      as total_paid,
  o.order_total - coalesce(p.total_paid, 0)      as amount_outstanding,
  p.next_due_date,
  case
    when o.order_total <= 0                          then 'No total'
    when o.order_total - coalesce(p.total_paid, 0) <= 0 then 'Paid'
    when p.next_due_date < (now() at time zone 'America/Halifax')::date then 'Overdue'
    when p.next_due_date <= (now() at time zone 'America/Halifax')::date + 7 then 'Due soon'
    else 'Open'
  end                                            as payment_status,
  o.archived,
  o.archived_at,
  o.archived_by,
  o.created_at,
  o.updated_at
from public.orders o
join public.customers c on c.id = o.customer_id
left join lateral (
  select count(*)                                     as machines_count,
         count(*) filter (where om.ready)             as machines_ready_count,
         string_agg(om.serial_number, ', ' order by om.serial_number) as serials,
         (select string_agg(t.qty || '× ' || t.name, ', ' order by t.name)
            from (select mt.name, count(*) as qty
                    from public.order_machines x
                    join public.machine_types mt on mt.id = x.machine_type_id
                   where x.order_id = o.id and not x.archived
                   group by mt.name) t)               as machines_list
    from public.order_machines om
   where om.order_id = o.id and not om.archived
) m on true
left join lateral (
  select sum(coalesce(pp.received_amount, 0))                           as total_paid,
         min(pp.due_date) filter (where pp.amount - coalesce(pp.received_amount, 0) > 0) as next_due_date
    from public.payments pp
   where pp.order_id = o.id
) p on true
left join public.payments dp on dp.order_id = o.id and dp.payment_type = 'Down payment';


-- Access: same rules as before.
revoke all on public.order_summary, public.payment_overview from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
