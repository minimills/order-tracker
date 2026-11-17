-- 0043 Dashboard charts, customer reminder emails, daily summary, change of
--      sign-in email, welcome email
--
-- 1. Dashboard charts: each person's own charts, admin targets for the gauges,
--    task times by person for the build-speed charts.
-- 2. Email templates: reminder texts, welcome email, From name / address and
--    Reply-to. Reminders sent are kept per order.
-- 3. Daily summary: "Today's Agenda" in the morning and "What I Did Today" at
--    the end of the day, per person, sent through the notification channels.
-- 4. Change of sign-in email (confirmed at both addresses by Supabase).
-- 5. Access lockdown.

-- ===========================================================================
-- 1. Dashboard charts
-- ===========================================================================
-- My charts: [{id, chart, type, range, from, to, options}]
alter table public.user_preferences add column dashboard jsonb;

create or replace function public.set_my_dashboard(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
begin
  perform public.require_perm('dashboard.charts.customize', 'edit');
  if p is not null and (jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 40 or length(p::text) > 20000) then
    raise exception 'A dashboard can hold up to 40 charts.' using errcode = '22023';
  end if;
  insert into public.user_preferences (user_email) values (v_me) on conflict (user_email) do nothing;
  update public.user_preferences set dashboard = p where user_email = v_me;
end;
$$;

-- Targets for the gauges (per chart: green / amber limits and which side is good)
-- and the charts a new dashboard starts with.
insert into public.app_settings (key, value) values ('dashboard_charts', jsonb_build_object(
  'targets', jsonb_build_object(
    'delay_by_month', jsonb_build_object('good', 'low', 'green', 0, 'amber', 7, 'max', 30),
    'delay_by_year', jsonb_build_object('good', 'low', 'green', 0, 'amber', 7, 'max', 30),
    'on_time', jsonb_build_object('good', 'high', 'green', 90, 'amber', 75, 'max', 100),
    'payments_on_time', jsonb_build_object('good', 'high', 'green', 90, 'amber', 75, 'max', 100),
    'department_delays', jsonb_build_object('good', 'low', 'green', 0, 'amber', 3, 'max', 15)),
  'defaults', jsonb_build_array('delay_by_month', 'on_time', 'top_machines', 'by_country')))
on conflict (key) do nothing;

create or replace function public.set_dashboard_chart_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := coalesce((select value from public.app_settings where key = 'dashboard_charts'), '{}'::jsonb) || coalesce(p, '{}'::jsonb);
  t record;
begin
  perform public.require_admin_area('dashboard_charts');
  if jsonb_typeof(v -> 'targets') <> 'object' or jsonb_typeof(v -> 'defaults') <> 'array' then
    raise exception 'The chart settings are not complete.' using errcode = '22023';
  end if;
  for t in select key, value from jsonb_each(v -> 'targets') loop
    if coalesce(t.value ->> 'good', '') not in ('low', 'high')
       or (t.value ->> 'green') is null or (t.value ->> 'amber') is null or coalesce((t.value ->> 'max')::numeric, 0) <= 0 then
      raise exception 'Enter the green and amber limits and the top of the scale for every gauge.' using errcode = '22023';
    end if;
  end loop;
  insert into public.app_settings (key, value) values ('dashboard_charts', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'dashboard_charts', null, jsonb_build_object('action', 'Dashboard chart settings changed'));
end;
$$;

-- Finished tasks and cards with who finished them (active time: pauses left out),
-- for "Build speed by employee" and "Build speed by task".
create or replace function public.chart_task_times(p_from date, p_to date)
returns table (person text, task text, board text, finished_on date, seconds bigint)
language sql
stable
security definer
set search_path = public
as $$
  select x.person, x.task, x.board, x.finished_on, x.seconds
    from (
      select coalesce(nullif(btrim(c.finished_by_name), ''), 'Not recorded') as person, btrim(c.title) as task, b.name as board,
             (c.finished_at at time zone 'America/Halifax')::date as finished_on,
             extract(epoch from c.finished_at - c.started_at)::bigint - public.board_paused_seconds(c.id, null::uuid, c.started_at, c.finished_at) as seconds
        from public.board_cards c join public.boards b on b.id = c.board_id
       where c.started_at is not null and c.finished_at is not null and c.finished_at > c.started_at and c.card_kind <> 'service'
      union all
      select coalesce(nullif(btrim(i.finished_by_name), ''), 'Not recorded'), btrim(i.item_text), b.name,
             (i.finished_at at time zone 'America/Halifax')::date,
             extract(epoch from i.finished_at - i.started_at)::bigint - public.board_paused_seconds(k.id, i.id, i.started_at, i.finished_at)
        from public.board_checklist_items i
        join public.board_checklists l on l.id = i.checklist_id
        join public.board_cards k on k.id = l.card_id
        join public.boards b on b.id = k.board_id
       where i.started_at is not null and i.finished_at is not null and i.finished_at > i.started_at
    ) x
   where public.has_any_perm(array['dashboard.chart.speed_employee', 'dashboard.chart.speed_task'], 'view')
     and x.finished_on between p_from and p_to and x.seconds > 0;
$$;

-- ===========================================================================
-- 2. Email templates: reminders, welcome email, From and Reply-to
-- ===========================================================================
update public.app_settings set value = jsonb_build_object(
  'from_name', '', 'from_address', '', 'reply_to', '',
  'reminders', jsonb_build_object(
    'down_payment_due', jsonb_build_object(
      'name', 'Down payment due',
      'subject', 'Down payment due – Order {order_number} – {company_name}',
      'body', E'Hello {customer_name},\n\nThis is a friendly reminder that the down payment of {amount} for order {order_number} is due on {due_date}.\n\nYour order goes into our production queue once the down payment is received. If you have already sent it, thank you, and please disregard this message.\n\nPlease reply to this email if you have any questions.\n\nThank you,\n{sender_name}\n{company_name}'),
    'balance_due', jsonb_build_object(
      'name', 'Balance due',
      'subject', 'Balance due – Order {order_number} – {company_name}',
      'body', E'Hello {customer_name},\n\nYour order {order_number} is expected to ship on {expected_ship_date}. The balance of {amount} is due on {due_date}, before the shipment leaves.\n\nIf you have already sent it, thank you, and please disregard this message.\n\nPlease reply to this email if you have any questions.\n\nThank you,\n{sender_name}\n{company_name}'),
    'overdue', jsonb_build_object(
      'name', 'Payment overdue',
      'subject', 'Payment overdue – Order {order_number} – {company_name}',
      'body', E'Hello {customer_name},\n\nOur records show that the {payment_type} of {amount} for order {order_number} was due on {due_date}, {days_overdue} days ago, and has not been received yet.\n\nCould you let us know when we can expect it? If you have already sent it, thank you, and please disregard this message.\n\nThank you,\n{sender_name}\n{company_name}'),
    'ship_date_update', jsonb_build_object(
      'name', 'Ship date update',
      'subject', 'Ship date update – Order {order_number} – {company_name}',
      'body', E'Hello {customer_name},\n\nWe would like to update you on order {order_number}. The expected ship date is now {expected_ship_date}.\n\nWe will be in touch again when your shipment is ready to leave. Please reply to this email if you have any questions.\n\nThank you,\n{sender_name}\n{company_name}'),
    'custom', jsonb_build_object(
      'name', 'Custom message',
      'subject', 'Order {order_number} – {company_name}',
      'body', E'Hello {customer_name},\n\n\n\nThank you,\n{sender_name}\n{company_name}')),
  'welcome', jsonb_build_object(
    'subject', 'Welcome to the {company_name} Order Tracker',
    'body', E'Hello {name},\n\nYou can now use the {company_name} Order Tracker.\n\nOpen it here: {portal_url}\n\nHOW TO SIGN IN\n1. Open the link above and enter this email address: {email}\n2. We email you a 6-digit code. Enter the code to sign in. There is no password to remember.\n\nADD IT TO YOUR PHONE HOME SCREEN\niPhone: open the link in Safari, tap the Share button, then "Add to Home Screen".\nAndroid: open the link in Chrome, tap the three dots, then "Add to Home screen" or "Install app".\n\nTURN ON NOTIFICATIONS\nOpen the app from the home screen, go to Settings, then Notifications, and turn on phone notifications. On an iPhone this only works after the app is on the home screen.\n\nWHAT YOU CAN USE\n{features}\n\nIf something is missing or does not work, reply to this email.\n\n{sender_name}\n{company_name}'))
  || value
 where key = 'email_templates';

-- Admin → Email Templates (copy of 0041 + reminders, welcome, From and Reply-to).
create or replace function public.set_email_templates(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := coalesce((select value from public.app_settings where key = 'email_templates'), '{}'::jsonb);
  v jsonb := v_old || coalesce(p, '{}'::jsonb);
  v_key text;
  v_addr text;
  t record;
begin
  perform public.require_admin_area('email_templates');
  foreach v_key in array array['certificate_subject', 'service_report_subject'] loop
    if length(btrim(coalesce(v ->> v_key, ''))) = 0 then
      raise exception 'Enter a subject for each email.' using errcode = '22023';
    end if;
    if length(v ->> v_key) > 300 then
      raise exception 'A subject can have at most 300 characters.' using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array array['certificate_cc', 'service_report_cc'] loop
    for v_addr in select x from regexp_split_to_table(coalesce(v ->> v_key, ''), '[,;\s]+') x where x <> '' loop
      if v_addr <> '{office_email}' and v_addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'Check this CC address: %', v_addr using errcode = '22023';
      end if;
    end loop;
  end loop;
  foreach v_key in array array['from_address', 'reply_to'] loop
    if btrim(coalesce(v ->> v_key, '')) <> '' and btrim(v ->> v_key) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Check this email address: %', v ->> v_key using errcode = '22023';
    end if;
  end loop;
  if length(coalesce(v ->> 'from_name', '')) > 80 then
    raise exception 'The From name can have at most 80 characters.' using errcode = '22023';
  end if;
  -- A reminder that was not sent along keeps its saved text.
  v := jsonb_set(v, '{reminders}', coalesce(v_old -> 'reminders', '{}'::jsonb) || coalesce(p -> 'reminders', '{}'::jsonb));
  for t in select key, value from jsonb_each(v -> 'reminders') loop
    if length(btrim(coalesce(t.value ->> 'subject', ''))) = 0 or length(btrim(coalesce(t.value ->> 'body', ''))) = 0 then
      raise exception 'Every reminder needs a subject and a message.' using errcode = '22023';
    end if;
    if length(t.value ->> 'subject') > 300 or length(t.value ->> 'body') > 8000 then
      raise exception 'A reminder is too long (subject 300, message 8000 characters).' using errcode = '22023';
    end if;
  end loop;
  if length(btrim(coalesce(v #>> '{welcome,subject}', ''))) = 0 or length(btrim(coalesce(v #>> '{welcome,body}', ''))) = 0
     or length(v #>> '{welcome,body}') > 8000 then
    raise exception 'The welcome email needs a subject and a message (at most 8000 characters).' using errcode = '22023';
  end if;
  insert into public.app_settings (key, value) values ('email_templates', v)
  on conflict (key) do update set value = excluded.value;
  perform public.log_admin_action('app_settings', 'email_templates', null, jsonb_build_object('action', 'Email templates changed'));
end;
$$;

-- Reminders sent to customers (written by the send-email function).
create table public.order_reminders (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders (id) on delete cascade,
  payment_id   uuid references public.payments (id) on delete set null,
  template     text not null,
  to_emails    text[] not null,
  cc_emails    text[] not null default '{}',
  bcc_emails   text[] not null default '{}',
  subject      text not null,
  body         text not null,
  status       text not null check (status in ('sent', 'failed')),
  error        text,
  email_log_id uuid references public.email_log (id) on delete set null,
  sent_by      text,
  sent_by_name text,
  sent_at      timestamptz not null default now()
);
create index order_reminders_order_idx on public.order_reminders (order_id, sent_at);
alter table public.order_reminders enable row level security;
create policy "Reminder readers" on public.order_reminders for select to authenticated
  using ((select public.has_any_perm(array['reminders', 'reminders.send'], 'view')));
revoke insert, update, delete on public.order_reminders from authenticated;
revoke all on public.order_reminders from anon;

alter table public.email_log drop constraint email_log_kind_check;
alter table public.email_log add constraint email_log_kind_check
  check (kind in ('notification', 'digest', 'test', 'resend', 'certificate', 'ce_declaration', 'freight_quote', 'reminder', 'welcome'));

-- What a reminder says about the order and one of its payments (the next unpaid
-- one when none is given).
create or replace function public.reminder_data(p_order uuid, p_payment uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o public.orders%rowtype;
  c public.customers%rowtype;
  p public.payments%rowtype;
  v_paid numeric;
  v_today date := public.halifax_today();
begin
  perform public.require_perm('reminders.send', 'edit');
  select * into o from public.orders where id = p_order;
  if o.id is null then raise exception 'That order could not be found.'; end if;
  select * into c from public.customers where id = o.customer_id;
  if p_payment is not null then
    select * into p from public.payments where id = p_payment and order_id = p_order;
  else
    select * into p from public.payments
     where order_id = p_order and amount - coalesce(received_amount, 0) > 0
     order by due_date nulls last, created_at limit 1;
  end if;
  select coalesce(sum(coalesce(received_amount, 0)), 0) into v_paid from public.payments where order_id = p_order;
  return jsonb_build_object(
    'order_id', o.id, 'order_number', o.order_code, 'quote_number', o.quote_number, 'invoice_number', o.invoice_number,
    'currency', o.currency, 'order_total', o.order_total, 'total_paid', v_paid, 'outstanding', greatest(coalesce(o.order_total, 0) - v_paid, 0),
    'expected_ship_date', o.expected_ship_date, 'original_ship_date', o.original_ship_date,
    'customer_name', c.name, 'customer_company', c.company, 'customer_emails', to_jsonb(c.emails),
    'payment_id', p.id, 'payment_type', p.payment_type,
    'amount', case when p.id is not null then p.amount - coalesce(p.received_amount, 0) end,
    'due_date', p.due_date,
    'days_overdue', case when p.due_date is not null and p.due_date < v_today then v_today - p.due_date end,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'payment_type', x.payment_type,
                           'remaining', x.amount - coalesce(x.received_amount, 0), 'due_date', x.due_date) order by x.due_date nulls last, x.created_at)
                            from public.payments x where x.order_id = p_order and x.amount - coalesce(x.received_amount, 0) > 0), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 3. Daily summary
-- ===========================================================================
insert into public.notification_kinds (kind, label, description, sort_order, default_modes) values
  ('daily_agenda', 'Today''s agenda', 'Your morning summary (set it up in Settings → Daily Summary).', 80, '{"app": "on", "push": "off", "email": "instant", "desktop": "off"}'),
  ('daily_recap', 'What I did today', 'Your end-of-day summary (set it up in Settings → Daily Summary).', 81, '{"app": "on", "push": "off", "email": "instant", "desktop": "off"}'),
  ('user_email_change', 'A sign-in email was changed', 'For admins: someone asked to change, or changed, their sign-in email.', 82, '{"app": "on", "push": "off", "email": "instant", "desktop": "on"}')
on conflict (kind) do nothing;

create table public.summary_settings (
  user_email      text primary key references public.allowed_users (email) on update cascade on delete cascade,
  morning_enabled boolean not null default false,
  morning_time    time not null default '07:30',
  morning_items   text[] not null default '{tasks_due,overdue,ship_dates,payments_due,new_orders,notices,events,holidays}',
  evening_enabled boolean not null default false,
  evening_time    time not null default '16:30',
  evening_items   text[] not null default '{board_activity,time_logged,tasks_due,overdue,new_orders}',
  -- the business summary (orders, money, shipments, delays): only with summary.business
  business        boolean not null default false,
  last_morning    date,
  last_evening    date,
  updated_at      timestamptz not null default now()
);
alter table public.summary_settings enable row level security;
create policy "Own summary settings" on public.summary_settings for select to authenticated
  using (user_email = (select public.current_user_email()));
revoke insert, update, delete on public.summary_settings from authenticated;
revoke all on public.summary_settings from anon;

create or replace function public.summary_item_keys()
returns text[]
language sql
immutable
as $$
  select array['tasks_due', 'overdue', 'ship_dates', 'payments_due', 'new_orders', 'notices', 'events', 'holidays', 'board_activity', 'time_logged'];
$$;

create or replace function public.set_my_summary(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
  v_m text[];
  v_e text[];
begin
  perform public.require_perm('settings.daily_summary', 'edit');
  if coalesce((p ->> 'business')::boolean, false) then
    perform public.require_perm('summary.business', 'view');
  end if;
  insert into public.summary_settings (user_email) values (v_me) on conflict (user_email) do nothing;
  if p ? 'morning_items' then
    select coalesce(array_agg(x), '{}') into v_m from jsonb_array_elements_text(p -> 'morning_items') x where x = any (public.summary_item_keys());
  end if;
  if p ? 'evening_items' then
    select coalesce(array_agg(x), '{}') into v_e from jsonb_array_elements_text(p -> 'evening_items') x where x = any (public.summary_item_keys());
  end if;
  update public.summary_settings s set
    morning_enabled = case when p ? 'morning_enabled' then (p ->> 'morning_enabled')::boolean else s.morning_enabled end,
    morning_time = case when p ? 'morning_time' then (p ->> 'morning_time')::time else s.morning_time end,
    morning_items = case when p ? 'morning_items' then v_m else s.morning_items end,
    evening_enabled = case when p ? 'evening_enabled' then (p ->> 'evening_enabled')::boolean else s.evening_enabled end,
    evening_time = case when p ? 'evening_time' then (p ->> 'evening_time')::time else s.evening_time end,
    evening_items = case when p ? 'evening_items' then v_e else s.evening_items end,
    business = case when p ? 'business' then (p ->> 'business')::boolean else s.business end,
    updated_at = now()
   where s.user_email = v_me;
end;
$$;

-- The text of one person's summary. Every part is left out unless that person
-- is allowed to see it. Internal: use send_my_summary / daily_summary_tick.
create or replace function public.build_summary(p_email text, p_kind text, p_day date)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.summary_settings%rowtype;
  v_items text[];
  v_out text[] := '{}';
  v_lines text;
  v_n integer;
  v_n2 integer;
  v_num numeric;
  v_orders boolean := public.perm_of(p_email, 'orders.list') or public.perm_of(p_email, 'orders.board');
  v_boards boolean := public.perm_of(p_email, 'boards');
  -- the business numbers of the morning are yesterday's
  v_ref date := case when p_kind = 'agenda' then p_day - 1 else p_day end;
  v_when text := case when p_kind = 'agenda' then 'yesterday' else 'today' end;
  r record;
begin
  select * into s from public.summary_settings where user_email = p_email;
  v_items := case when p_kind = 'agenda' then coalesce(s.morning_items, '{tasks_due,overdue,ship_dates,payments_due,new_orders,notices,events,holidays}')
                  else coalesce(s.evening_items, '{board_activity,time_logged,tasks_due,overdue,new_orders}') end;

  if 'board_activity' = any (v_items) and v_boards then
    select count(*), count(distinct e.board_id) into v_n, v_n2 from public.board_card_events e
     where e.actor_email = p_email and (e.created_at at time zone 'America/Halifax')::date = p_day;
    select string_agg('  - ' || left(c.title, 80) || ' (' || b.name || ')', E'\n' order by c.finished_at) into v_lines
      from (select * from public.board_cards where finished_by = p_email and (finished_at at time zone 'America/Halifax')::date = p_day
             order by finished_at limit 10) c
      join public.boards b on b.id = c.board_id;
    v_out := v_out || ('MY BOARD ACTIVITY' || E'\n' ||
      case when v_n = 0 then '  Nothing recorded on the boards ' || case when p_kind = 'agenda' then 'yet today.' else 'today.' end
           else '  ' || v_n || case when v_n = 1 then ' change on ' else ' changes on ' end || v_n2 || case when v_n2 = 1 then ' board.' else ' boards.' end end
      || coalesce(E'\n  Cards completed:\n' || v_lines, ''));
  end if;

  if 'time_logged' = any (v_items) and v_boards then
    select coalesce(sum(x.seconds), 0), count(*) into v_num, v_n from (
      select extract(epoch from c.finished_at - c.started_at) - public.board_paused_seconds(c.id, null::uuid, c.started_at, c.finished_at) as seconds
        from public.board_cards c
       where c.finished_by = p_email and c.started_at is not null and (c.finished_at at time zone 'America/Halifax')::date = p_day
      union all
      select extract(epoch from i.finished_at - i.started_at) - public.board_paused_seconds(k.id, i.id, i.started_at, i.finished_at)
        from public.board_checklist_items i
        join public.board_checklists l on l.id = i.checklist_id
        join public.board_cards k on k.id = l.card_id
       where i.finished_by = p_email and i.started_at is not null and (i.finished_at at time zone 'America/Halifax')::date = p_day) x;
    v_out := v_out || ('TIME LOGGED' || E'\n  ' || round(v_num / 3600.0, 1) || ' hours on ' || v_n || case when v_n = 1 then ' finished task or card.' else ' finished tasks and cards.' end);
  end if;

  if 'tasks_due' = any (v_items) and v_boards then
    select count(*), string_agg('  - ' || left(x.title, 80) || ' (' || x.board || ')', E'\n') into v_n, v_lines from (
      select c.title, b.name as board from public.board_card_assignees a
        join public.board_cards c on c.id = a.card_id and not c.archived and c.finished_at is null and c.due_date = p_day
        join public.boards b on b.id = c.board_id and not b.archived
       where a.user_email = p_email and public.board_access_of(b.id, p_email) >= 1
       order by c.title limit 15) x;
    v_out := v_out || ('MY TASKS DUE TODAY' || E'\n' || coalesce(v_lines, '  Nothing is due today.'));
  end if;

  if 'overdue' = any (v_items) and v_boards then
    select count(*), string_agg('  - ' || left(x.title, 80) || ' (' || x.board || ', due ' || to_char(x.due_date, 'Mon FMDD') || ')', E'\n') into v_n, v_lines from (
      select c.title, b.name as board, c.due_date from public.board_card_assignees a
        join public.board_cards c on c.id = a.card_id and not c.archived and c.finished_at is null and c.due_date < p_day
        join public.boards b on b.id = c.board_id and not b.archived
       where a.user_email = p_email and public.board_access_of(b.id, p_email) >= 1
       order by c.due_date limit 15) x;
    v_out := v_out || ('MY OVERDUE ITEMS' || E'\n' || coalesce(v_lines, '  Nothing is overdue.'));
  end if;

  if 'ship_dates' = any (v_items) and v_orders then
    select string_agg('  - Order ' || x.order_code || ' – ' || coalesce(x.company, x.name, '') || ' – ' || to_char(x.expected_ship_date, 'Dy Mon FMDD'), E'\n') into v_lines from (
      select o.order_code, nullif(btrim(c.company), '') as company, c.name, o.expected_ship_date
        from public.orders o left join public.customers c on c.id = o.customer_id
       where not o.archived and o.actual_ship_date is null and o.stage in ('Confirmed', 'In production', 'Ready', 'Ready to ship')
         and o.expected_ship_date between p_day and p_day + 7
       order by o.expected_ship_date, o.order_number limit 15) x;
    select count(*) into v_n from public.orders o
     where not o.archived and o.actual_ship_date is null and o.stage in ('Confirmed', 'In production', 'Ready', 'Ready to ship') and o.expected_ship_date < p_day;
    v_out := v_out || ('SHIP DATES IN THE NEXT 7 DAYS' || E'\n' || coalesce(v_lines, '  No ship dates in the next 7 days.')
      || case when v_n > 0 then E'\n  ' || v_n || case when v_n = 1 then ' order is' else ' orders are' end || ' past the expected ship date.' else '' end);
  end if;

  if 'payments_due' = any (v_items) and public.perm_of(p_email, 'payments') then
    select string_agg('  - Order ' || x.order_code || ' – ' || x.payment_type || ' – ' || x.currency || ' ' || to_char(x.remaining, 'FM999,999,990.00')
                      || ' – ' || case when x.due_date < p_day then 'overdue since ' else 'due ' end || to_char(x.due_date, 'Mon FMDD'), E'\n') into v_lines from (
      select o.order_code, p.payment_type, o.currency, p.amount - coalesce(p.received_amount, 0) as remaining, p.due_date
        from public.payments p join public.orders o on o.id = p.order_id
       where not o.archived and o.stage in ('Confirmed', 'In production', 'Ready', 'Ready to ship', 'Shipped')
         and p.amount - coalesce(p.received_amount, 0) > 0 and p.due_date <= p_day + 7
       order by p.due_date, o.order_number limit 15) x;
    v_out := v_out || ('PAYMENTS DUE (OVERDUE AND THE NEXT 7 DAYS)' || E'\n' || coalesce(v_lines, '  No payments are due.'));
  end if;

  if 'new_orders' = any (v_items) and v_orders then
    select string_agg('  - Order ' || x.order_code || ' – ' || coalesce(x.company, x.name, ''), E'\n') into v_lines from (
      select o.order_code, nullif(btrim(c.company), '') as company, c.name
        from public.orders o left join public.customers c on c.id = o.customer_id
       where not o.archived and o.cancelled_code is null
         and (o.created_at at time zone 'America/Halifax')::date between v_ref and p_day
       order by o.created_at limit 15) x;
    v_out := v_out || ('NEW ORDERS' || E'\n' || coalesce(v_lines, case when p_kind = 'agenda' then '  No new orders since yesterday.' else '  No new orders today.' end));
  end if;

  if 'notices' = any (v_items) and public.perm_of(p_email, 'notices') then
    select string_agg('  - ' || left(x.title, 100), E'\n') into v_lines from (
      select n.title from public.notices n
       where not n.archived and coalesce(n.show_from, p_day) <= p_day and (n.show_until is null or n.show_until >= p_day)
         and public.notice_is_for(n.id, p_email) and n.author_email is distinct from p_email
         and not exists (select 1 from public.notice_reads x where x.notice_id = n.id and x.user_email = p_email)
       order by n.created_at desc limit 10) x;
    v_out := v_out || ('NOTICES NOT READ YET' || E'\n' || coalesce(v_lines, '  No new notices.'));
  end if;

  if 'events' = any (v_items) and public.perm_of(p_email, 'notices.events') then
    select string_agg('  - ' || left(x.title, 100) || ' – ' || x.when_text || coalesce(' – ' || x.location, ''), E'\n') into v_lines from (
      select e.title, nullif(btrim(e.location), '') as location,
             case when e.all_day or e.starts_at is null then to_char(e.start_date, 'Dy Mon FMDD')
                  else to_char(e.starts_at at time zone 'America/Halifax', 'Dy Mon FMDD, FMHH12:MI AM') end as when_text
        from public.company_events e
       where not e.archived and e.start_date <= p_day + 7 and e.end_date >= p_day and public.event_is_for(e.id, p_email)
       order by e.start_date, e.starts_at nulls first limit 10) x;
    v_out := v_out || ('EVENTS IN THE NEXT 7 DAYS' || E'\n' || coalesce(v_lines, '  No events.'));
  end if;

  if 'holidays' = any (v_items) then
    select string_agg('  - ' || h.name || ' – ' || to_char(h.start_date, 'Dy Mon FMDD')
                      || case when h.end_date > h.start_date then ' to ' || to_char(h.end_date, 'Dy Mon FMDD') else '' end, E'\n' order by h.start_date) into v_lines
      from public.company_holidays h where not h.hidden and h.end_date >= p_day and h.start_date <= p_day + 14;
    if v_lines is not null then v_out := v_out || ('HOLIDAYS IN THE NEXT 2 WEEKS' || E'\n' || v_lines); end if;
  end if;

  if coalesce(s.business, false) and public.perm_of(p_email, 'summary.business') then
    v_lines := 'BUSINESS SUMMARY';
    select count(*) into v_n from public.orders o
     where not o.archived and o.cancelled_code is null and (o.created_at at time zone 'America/Halifax')::date = v_ref;
    v_lines := v_lines || E'\n  New orders ' || v_when || ': ' || v_n;
    select count(*) into v_n from public.orders o where not o.archived and o.actual_ship_date = v_ref;
    v_lines := v_lines || E'\n  Shipments ' || v_when || ': ' || v_n;
    select count(*) into v_n from public.orders o
     where not o.archived and o.actual_ship_date is null and o.stage in ('Confirmed', 'In production', 'Ready', 'Ready to ship') and o.expected_ship_date < p_day;
    v_lines := v_lines || E'\n  Orders past the expected ship date: ' || v_n;
    for r in select o.currency, sum(coalesce(p.received_amount, 0)) as amount
               from public.payments p join public.orders o on o.id = p.order_id
              where p.received_date = v_ref and coalesce(p.received_amount, 0) > 0 group by o.currency order by o.currency loop
      v_lines := v_lines || E'\n  Money received ' || v_when || ': ' || r.currency || ' ' || to_char(r.amount, 'FM999,999,990.00');
    end loop;
    if not found then v_lines := v_lines || E'\n  Money received ' || v_when || ': none'; end if;
    for r in select o.currency, sum(p.amount - coalesce(p.received_amount, 0)) as amount
               from public.payments p join public.orders o on o.id = p.order_id
              where not o.archived and o.stage in ('Confirmed', 'In production', 'Ready', 'Ready to ship', 'Shipped')
                and p.amount - coalesce(p.received_amount, 0) > 0 group by o.currency order by o.currency loop
      v_lines := v_lines || E'\n  Money outstanding: ' || r.currency || ' ' || to_char(r.amount, 'FM999,999,990.00');
    end loop;
    v_out := v_out || v_lines;
  end if;

  if cardinality(v_out) = 0 then
    return 'Nothing to report. Choose what to include in Settings → Daily Summary.';
  end if;
  return array_to_string(v_out, E'\n\n');
end;
$$;

-- Puts one summary in a person's notifications (their channel choices apply).
create or replace function public.post_summary(p_email text, p_kind text, p_day date, p_sample boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  values (p_email, case when p_kind = 'agenda' then 'daily_agenda' else 'daily_recap' end,
          case when p_kind = 'agenda' then 'Today''s Agenda – ' else 'What I Did Today – ' end || to_char(p_day, 'Dy, Mon FMDD'),
          left(public.build_summary(p_email, p_kind, p_day), 6000), '/settings?find=daily-summary',
          'summary:' || p_kind || ':' || p_day || case when p_sample then ':' || to_char(now(), 'HH24MISS') else '' end)
  on conflict do nothing;
end;
$$;

-- "Send Me a Sample Now" in Settings.
create or replace function public.send_my_summary(p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_perm('settings.daily_summary', 'edit');
  if p_kind not in ('agenda', 'recap') then raise exception 'Unknown summary.' using errcode = '22023'; end if;
  perform public.post_summary(public.current_user_email(), p_kind, public.halifax_today(), true);
end;
$$;

-- Every 5 minutes (with automatic sending): send the summaries whose time has come.
-- Working days only; a summary switched on after its time starts the next day.
create or replace function public.daily_summary_tick()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamp := now() at time zone 'America/Halifax';
  v_day date := v_now::date;
  v_time time := v_now::time;
  v_n integer := 0;
  r record;
begin
  if not public.is_working_day(v_day) then return 0; end if;
  for r in select s.user_email from public.summary_settings s
            where s.morning_enabled and s.last_morning is distinct from v_day
              and v_time >= s.morning_time and v_time < s.morning_time + interval '2 hours'
              and public.perm_of(s.user_email, 'settings.daily_summary', 'edit') loop
    perform public.post_summary(r.user_email, 'agenda', v_day, false);
    update public.summary_settings set last_morning = v_day where user_email = r.user_email;
    v_n := v_n + 1;
  end loop;
  for r in select s.user_email from public.summary_settings s
            where s.evening_enabled and s.last_evening is distinct from v_day
              and v_time >= s.evening_time and v_time < s.evening_time + interval '2 hours'
              and public.perm_of(s.user_email, 'settings.daily_summary', 'edit') loop
    perform public.post_summary(r.user_email, 'recap', v_day, false);
    update public.summary_settings set last_evening = v_day where user_email = r.user_email;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Automatic sending also runs the daily summaries (copy of 0041 + daily-summary).
create or replace function public.start_email_schedule(p_supabase_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := rtrim(btrim(p_supabase_url), '/') || '/functions/v1/';
begin
  perform public.require_admin_area('email');
  if p_supabase_url !~ '^https://[a-z0-9.-]+$' then
    raise exception 'The Supabase address looks wrong: %', p_supabase_url using errcode = '22023';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Turn on the pg_cron and pg_net extensions first (Supabase → Database → Extensions).' using errcode = '55000';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications', 'calendar-import', 'notice-board', 'daily-summary');
  perform cron.schedule('send-notifications', '* * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "dispatch"}'::jsonb, timeout_milliseconds := 55000)$job$,
    v_base || 'send-email'));
  perform cron.schedule('board-due-notifications', '*/10 * * * *', 'select public.board_due_notifications()');
  perform cron.schedule('calendar-import', '*/5 * * * *', format(
    $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-key', (select key from app_private.dispatch_key)), body := '{"action": "sync_all"}'::jsonb, timeout_milliseconds := 120000)$job$,
    v_base || 'calendar-import'));
  perform cron.schedule('notice-board', '* * * * *', 'select public.notice_board_tick()');
  perform cron.schedule('daily-summary', '*/5 * * * *', 'select public.daily_summary_tick()');
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned on', 'url', v_base));
end;
$$;

create or replace function public.stop_email_schedule()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('email');
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('send-notifications', 'board-due-notifications', 'calendar-import', 'notice-board', 'daily-summary');
  end if;
  perform public.log_admin_action('app_settings', 'email', null, jsonb_build_object('action', 'automatic sending turned off'));
end;
$$;

-- If automatic sending is already on, start the daily summaries now too.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'send-notifications') then
      perform cron.unschedule(jobid) from cron.job where jobname = 'daily-summary';
      perform cron.schedule('daily-summary', '*/5 * * * *', 'select public.daily_summary_tick()');
    end if;
  end if;
end;
$$;

-- ===========================================================================
-- 4. Change of sign-in email
-- ===========================================================================
create table public.email_change_requests (
  id           uuid primary key default gen_random_uuid(),
  old_email    text not null,
  new_email    text not null,
  auth_user_id uuid,
  status       text not null default 'pending' check (status in ('pending', 'applied', 'cancelled')),
  requested_at timestamptz not null default now(),
  applied_at   timestamptz
);
create index email_change_requests_pending_idx on public.email_change_requests (auth_user_id) where status = 'pending';
alter table public.email_change_requests enable row level security;
create policy "Own or user managers" on public.email_change_requests for select to authenticated
  using (old_email = (select public.current_user_email()) or new_email = (select public.current_user_email()) or (select public.can_admin('users')));
revoke insert, update, delete on public.email_change_requests from authenticated;
revoke all on public.email_change_requests from anon;

-- Moves a person to another email everywhere (internal). The linked tables
-- follow by themselves; the few places that hold an email as plain text are
-- changed here.
create or replace function public.rename_user_email(p_old text, p_new text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text := lower(btrim(p_old));
  v_new text := lower(btrim(p_new));
begin
  if v_new !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a full email address.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.allowed_users where email = v_old) then
    raise exception '% is not on the users list.', v_old using errcode = 'P0002';
  end if;
  if exists (select 1 from public.allowed_users where email = v_new) then
    raise exception '% is already used by another person.', v_new using errcode = '23505';
  end if;
  update public.allowed_users set email = v_new where email = v_old;
  update public.board_shares set target = v_new where share_type = 'user' and lower(target) = v_old;
  update public.board_notify_rules set target = v_new where lower(target) = v_old;
  update public.notice_audience set target = v_new where lower(target) = v_old;
  update public.company_event_audience set target = v_new where lower(target) = v_old;
  update public.chat_conversations
     set direct_key = (select string_agg(case when x = v_old then v_new else x end, '|' order by case when x = v_old then v_new else x end)
                         from unnest(string_to_array(direct_key, '|')) x)
   where kind = 'direct' and v_old = any (string_to_array(direct_key, '|'));
  update public.email_change_requests set status = 'cancelled'
   where status = 'pending' and old_email = v_old and lower(new_email) <> v_new;
  -- The saved signature lives in a folder named after the email.
  begin
    update storage.objects set name = v_new || substr(name, length(v_old) + 1)
     where bucket_id = 'user-signatures' and name like v_old || '/%';
    update public.user_signatures set storage_path = v_new || substr(storage_path, length(v_old) + 1)
     where user_email = v_new and storage_path like v_old || '/%';
  exception when others then
    null; -- the signature can be uploaded again in Settings
  end;
end;
$$;

create or replace function public.notify_user_managers(p_title text, p_body text, p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_email, kind, title, body, link, dedupe_key)
  select a.email, 'user_email_change', p_title, p_body, '/admin/users', p_key
    from public.allowed_users a
   where a.role = 'admin' or public.perm_of(a.email, 'admin.users', 'edit')
  on conflict do nothing;
$$;

-- Applies a confirmed change (internal).
create or replace function public.apply_email_change(p_request uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.email_change_requests%rowtype;
begin
  select * into r from public.email_change_requests where id = p_request and status = 'pending' for update;
  if r.id is null then return; end if;
  perform public.rename_user_email(r.old_email, r.new_email);
  update public.email_change_requests set status = 'applied', applied_at = now() where id = r.id;
  insert into public.activity_log (user_email, table_name, record_id, action, changes)
  values (lower(r.new_email), 'allowed_users', lower(r.new_email), 'admin',
          jsonb_build_object('action', 'sign-in email changed (confirmed at both addresses)', 'from', r.old_email, 'to', lower(r.new_email)));
  perform public.notify_user_managers('Sign-in email changed', r.old_email || ' now signs in as ' || lower(r.new_email) || ' (confirmed at both addresses).', 'email-change:applied:' || r.id);
end;
$$;

-- Step 1, in Settings: remember the request and tell the admins. The app then
-- asks Supabase to send the two confirmation emails.
create or replace function public.request_email_change(p_new text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text := public.current_user_email();
  v_new text := lower(btrim(coalesce(p_new, '')));
  v_id uuid;
begin
  perform public.require_perm('settings.change_email', 'edit');
  if v_new !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a full email address.' using errcode = '22023';
  end if;
  if v_new = v_me then
    raise exception 'That is already your sign-in email.' using errcode = '22023';
  end if;
  if exists (select 1 from public.allowed_users where email = v_new) then
    raise exception 'That email is already used by another person.' using errcode = '23505';
  end if;
  update public.email_change_requests set status = 'cancelled' where status = 'pending' and old_email = v_me;
  insert into public.email_change_requests (old_email, new_email, auth_user_id) values (v_me, v_new, auth.uid()) returning id into v_id;
  insert into public.activity_log (user_id, user_email, table_name, record_id, action, changes)
  values (auth.uid(), v_me, 'allowed_users', v_me, 'admin', jsonb_build_object('action', 'asked to change the sign-in email', 'from', v_me, 'to', v_new));
  perform public.notify_user_managers('Sign-in email change requested',
    public.current_user_name() || ' (' || v_me || ') asked to sign in as ' || v_new || '. It applies once both addresses are confirmed.', 'email-change:asked:' || v_id);
end;
$$;

create or replace function public.cancel_my_email_change()
returns void
language sql
security definer
set search_path = public
as $$
  update public.email_change_requests set status = 'cancelled'
   where status = 'pending' and old_email = public.current_user_email();
$$;

-- After both confirmations the person is signed in with the new email: finish the change.
-- (Also done by the trigger on the login table below, when Supabase allows it.)
create or replace function public.apply_my_email_change()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select r.id into v_id from public.email_change_requests r
   where r.status = 'pending' and r.auth_user_id = auth.uid() and lower(r.new_email) = lower(auth.jwt() ->> 'email')
   order by r.requested_at desc limit 1;
  if v_id is null then return false; end if;
  perform public.apply_email_change(v_id);
  return true;
end;
$$;

create or replace function public.auth_email_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select r.id into v_id from public.email_change_requests r
   where r.status = 'pending' and r.auth_user_id = new.id and lower(r.new_email) = lower(new.email)
   order by r.requested_at desc limit 1;
  if v_id is not null then
    begin
      perform public.apply_email_change(v_id);
    exception when others then
      null; -- never block the login change; apply_my_email_change finishes it at the next sign-in
    end;
  end if;
  return new;
end;
$$;
do $$
begin
  drop trigger if exists order_tracker_email_changed on auth.users;
  create trigger order_tracker_email_changed after update of email on auth.users
    for each row when (old.email is distinct from new.email) execute function public.auth_email_changed();
exception when others then
  raise notice 'The trigger on the login table could not be made (%). The change is finished at the next sign-in instead.', sqlerrm;
end;
$$;

-- The sign-in page: an email whose change is confirmed but not finished yet may sign in.
create or replace function public.can_sign_in(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.allowed_users where email = lower(btrim(p_email)))
      or exists (select 1 from public.email_change_requests r join auth.users u on u.id = r.auth_user_id
                  where r.status = 'pending' and lower(r.new_email) = lower(btrim(p_email)) and lower(u.email) = lower(btrim(p_email)));
$$;

-- Admin → Users → Change Email (the admin-users function changes the login).
create or replace function public.admin_change_user_email(p_old text, p_new text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin_area('users');
  perform public.rename_user_email(p_old, p_new);
  perform public.log_admin_action('allowed_users', lower(btrim(p_new)), null,
    jsonb_build_object('action', 'sign-in email changed by an admin', 'from', lower(btrim(p_old)), 'to', lower(btrim(p_new))));
  perform public.notify_user_managers('Sign-in email changed', lower(btrim(p_old)) || ' now signs in as ' || lower(btrim(p_new)) || ' (changed by ' || public.current_user_name() || ').',
    'email-change:admin:' || lower(btrim(p_new)) || ':' || to_char(now(), 'YYYYMMDDHH24MI'));
end;
$$;

-- ===========================================================================
-- 5. Access lockdown
-- ===========================================================================
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
-- Daily summaries and email changes: only through the functions above and the scheduler.
revoke execute on function public.build_summary(text, text, date), public.post_summary(text, text, date, boolean),
  public.daily_summary_tick(), public.rename_user_email(text, text), public.apply_email_change(uuid),
  public.notify_user_managers(text, text, text), public.auth_email_changed() from authenticated;
