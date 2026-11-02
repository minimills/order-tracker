-- 0005_order_summary_view.sql
-- One row per order with the handy calculated numbers.
-- "security_invoker" means the view follows the same access rules as the
-- tables underneath (only allowed users see anything).

create or replace view public.order_summary
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
  o.currency,
  o.order_total,
  o.expected_ship_date,
  o.actual_ship_date,
  o.actual_ship_date - o.expected_ship_date      as delay_days,   -- negative = early
  o.voltage,
  o.delivery_equipment,
  o.freight_type,
  o.notes,
  coalesce(m.machines_count, 0)                  as machines_count,
  coalesce(m.machines_ready_count, 0)            as machines_ready_count,
  dp.amount                                      as down_payment_amount,
  case when o.order_total > 0 and dp.amount is not null
       then round(dp.amount * 100 / o.order_total, 1) end as down_payment_percent,
  coalesce(p.total_paid, 0)                      as total_paid,
  o.order_total - coalesce(p.total_paid, 0)      as amount_outstanding,
  o.created_at,
  o.updated_at
from public.orders o
join public.customers c on c.id = o.customer_id
left join lateral (
  select count(*)                         as machines_count,
         count(*) filter (where om.ready) as machines_ready_count
    from public.order_machines om
   where om.order_id = o.id
) m on true
left join lateral (
  select sum(pp.amount) as total_paid
    from public.payments pp
   where pp.order_id = o.id and pp.received_date is not null
) p on true
left join public.payments dp on dp.order_id = o.id and dp.kind = 'down_payment';
