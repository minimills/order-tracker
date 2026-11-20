-- Test of migration 0054 (crating hand-off, incoming shipments, weekday fill
-- for everyone). NEVER run this on the live database: it adds test people,
-- orders, crates, shipments and hours. For a scratch copy of the database with
-- every migration applied.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set session_replication_role = replica;
insert into allowed_users (email, name, role) values
  ('owner@test.ca','Owner Admin','admin'), ('cr@test.ca','Chris Crater','staff'),
  ('ship@test.ca','Sam Shipping','staff'), ('nob@test.ca','Nora Nobody','staff') on conflict do nothing;
insert into user_permissions (user_email, perms) values
  ('cr@test.ca','{"crating":"edit","crating.handoff":"view"}'),
  ('ship@test.ca','{"freight.quote":"edit","freight.incoming":"edit","crating":"view"}'),
  ('nob@test.ca','{"crating":"view"}')
  on conflict (user_email) do update set perms = excluded.perms;
set session_replication_role = origin;
set role authenticated;

\echo == Admin: Sam arranges shipping; a Crating stage rule makes Chris the default crater
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select set_freight_settings('{"shipping_contact":"ship@test.ca"}');
do $$ begin perform set_freight_settings('{"shipping_contact":"nobody@test.ca"}');
  raise exception 'should have failed'; exception when invalid_parameter_value then raise notice 'unknown contact refused: %', sqlerrm; end $$;
insert into production_assignments (stage_template_id, assignee_type, user_email)
select id, 'user', 'cr@test.ca' from production_stage_template where step = 'crating' limit 1;
select (create_order(jsonb_build_object('new_customer', jsonb_build_object('name','Crate Farm','country','Canada'), 'stage','Confirmed', 'crating', true,
  'machines', jsonb_build_array(
     jsonb_build_object('machine_type_id', (select id from machine_types where not archived order by name limit 1), 'needs_crate', true),
     jsonb_build_object('machine_type_id', (select id from machine_types where not archived order by name limit 1), 'needs_crate', true))))) ->> 'id' as ord \gset
select 'assignee', crating_assignee from orders where id = :'ord';
do $$ begin update public.orders set crating_ready_at = now() where crating_assignee is not null;
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'direct hand-off change refused'; end $$;
\echo == Chris enters one crate for the first machine, without the weight
select set_config('request.jwt.claims','{"email":"cr@test.ca","role":"authenticated"}',false) \g /dev/null
select save_crate(jsonb_build_object('order_id', :'ord', 'machine_ids', jsonb_build_array((select id from order_machines where order_id = :'ord' order by serial_number limit 1)),
  'length_cm', 200, 'width_cm', 120, 'height_cm', 150, 'plywood_sheets', 4, 'build_hours', 3, 'crated_by', 'Chris')) as c1 \gset
select 'status 1', s ->> 'complete', jsonb_array_length(s -> 'machines_missing'), s -> 'crates_incomplete' -> 0 -> 'missing'
  from (select crating_handoff_status(:'ord') s) x;
\echo == Weight added and the second machine crated: complete, Sam is told once
select save_crate(jsonb_build_object('id', :'c1', 'order_id', :'ord', 'machine_ids', jsonb_build_array((select id from order_machines where order_id = :'ord' order by serial_number limit 1)),
  'length_cm', 200, 'width_cm', 120, 'height_cm', 150, 'weight_kg', 640, 'plywood_sheets', 4, 'build_hours', 3, 'crated_by', 'Chris')) \g /dev/null
select save_crate(jsonb_build_object('order_id', :'ord', 'machine_ids', jsonb_build_array((select id from order_machines where order_id = :'ord' order by serial_number offset 1 limit 1)),
  'length_cm', 180, 'width_cm', 110, 'height_cm', 140, 'weight_kg', 510, 'plywood_sheets', 3.5, 'build_hours', 2.5, 'crated_by', 'Chris')) as c2 \gset
select 'status 2', s ->> 'complete', s ->> 'notified_to_name', s ->> 'ready_at' is not null from (select crating_handoff_status(:'ord') s) x;
reset role;
select 'sam notified', kind, title, link like '/freight/quote?order=%' from notifications where user_email = 'ship@test.ca' and kind = 'crating_ready';
select 'deliveries for sam', string_agg(channel, ',' order by channel) from notification_deliveries d join notifications n on n.id = d.notification_id where n.user_email = 'ship@test.ca' and n.kind = 'crating_ready';
set role authenticated;
\echo == Editing a crate again (still complete) does not notify again
select set_config('request.jwt.claims','{"email":"cr@test.ca","role":"authenticated"}',false) \g /dev/null
select save_crate(jsonb_build_object('id', :'c2', 'order_id', :'ord', 'machine_ids', jsonb_build_array((select id from order_machines where order_id = :'ord' order by serial_number offset 1 limit 1)),
  'length_cm', 181, 'width_cm', 110, 'height_cm', 140, 'weight_kg', 510, 'plywood_sheets', 3.5, 'build_hours', 2.5, 'crated_by', 'Chris')) \g /dev/null
reset role;
select 'notifications for sam', count(*) from notifications where user_email = 'ship@test.ca' and kind = 'crating_ready';
set role authenticated;
\echo == Assigning: Nora (no crating.assign) is refused; the admin assigns Nora, who is told
select set_config('request.jwt.claims','{"email":"nob@test.ca","role":"authenticated"}',false) \g /dev/null
select set_config('test.ord', :'ord', false) \g /dev/null
do $$ begin perform set_crating_assignee(current_setting('test.ord')::uuid, 'nob@test.ca');
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'assign refused for nora'; end $$;
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select set_crating_assignee(:'ord', 'nob@test.ca');
reset role;
select 'nora told', title from notifications where user_email = 'nob@test.ca' and kind = 'crating_assigned';
set role authenticated;

\echo == Incoming shipments
select set_config('request.jwt.claims','{"email":"ship@test.ca","role":"authenticated"}',false) \g /dev/null
select save_incoming_shipment('{"supplier":"Steel Supply","product_cost":"1000","shipping_cost":"200","broker_fees":"50","taxes":"130","customs":"20","currency":"USD","exchange_rate":"1.4","delivery_type":"LTL","received_on":"2026-11-02"}') as inc \gset
select 'incoming', total, total_cad, freight_cad, delivery_type from incoming_shipments where id = :'inc';
do $$ begin perform save_incoming_shipment('{"supplier":"X","delivery_type":"Teleport"}');
  raise exception 'should have failed'; exception when invalid_parameter_value then raise notice 'unknown delivery type refused'; end $$;
select save_incoming_shipment('{"supplier":"Local Parts","product_cost":"80","currency":"CAD","exchange_rate":"9"}') as inc2 \gset
select 'cad rate forced to 1', exchange_rate, total_cad from incoming_shipments where id = :'inc2';
select set_config('request.jwt.claims','{"email":"nob@test.ca","role":"authenticated"}',false) \g /dev/null
select 'nora sees incoming', count(*) from incoming_shipments;
do $$ begin perform save_incoming_shipment('{"supplier":"X"}');
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'nora cannot add'; end $$;
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
update option_lists set value = 'Less than truckload' where list_name = 'incoming_delivery_type' and value = 'LTL';
select 'renamed on shipment', delivery_type from incoming_shipments where id = :'inc';

\echo == Weekday fill for everyone (week of Dec 7, 2026)
select 'fill setting', payroll_settings() ->> 'fill_start', payroll_settings() ->> 'fill_end', payroll_settings() ->> 'fill_break_minutes';
select save_employee(jsonb_build_object('name','Ann Hourly','pay_type','hourly','start_date','2024-01-01')) as ann \gset
select save_employee(jsonb_build_object('name','Ben Off','pay_type','hourly','start_date','2024-01-01')) as ben \gset
select save_employee(jsonb_build_object('name','Cal New','pay_type','hourly','start_date','2026-12-09')) as cal \gset
-- Ann already has Tuesday; Ben is on approved vacation Wed–Fri.
select save_timesheet_week(:'ann', '2026-12-07', '[{"work_date":"2026-12-08","kind":"work","hours":"5"}]'::jsonb) \g /dev/null
reset role;
insert into time_off_requests (employee_id, kind, start_date, end_date, status) values (:'ben', 'vacation', '2026-12-09', '2026-12-11', 'approved');
set role authenticated;
select 'preview', jsonb_pretty(jsonb_build_object('filled', p -> 'filled', 'skipped', (select jsonb_agg(s ->> 'employee' || ' ' || coalesce(s ->> 'date', '') || ' ' || (s ->> 'reason')) from jsonb_array_elements(p -> 'skipped') s)))
  from (select fill_week_for_everyone('2026-12-07', false) p) x;
select 'nothing written by preview', count(*) from time_entries where employee_id in (:'ann', :'ben', :'cal') and work_date >= '2026-12-07' and work_date < '2026-12-14' and start_time = '08:00';
select 'apply', (fill_week_for_everyone('2026-12-07', true) -> 'filled') @> '[]';
select 'ann days', string_agg(to_char(work_date, 'Dy') || ' ' || hours, ', ' order by work_date) from time_entries where employee_id = :'ann' and work_date between '2026-12-07' and '2026-12-13';
select 'ben days', string_agg(to_char(work_date, 'Dy') || ' ' || hours, ', ' order by work_date) from time_entries where employee_id = :'ben' and work_date between '2026-12-07' and '2026-12-13';
select 'cal days', string_agg(to_char(work_date, 'Dy') || ' ' || hours, ', ' order by work_date) from time_entries where employee_id = :'cal' and work_date between '2026-12-07' and '2026-12-13';
select 'second run fills nothing', jsonb_array_length(fill_week_for_everyone('2026-12-07', true) -> 'filled');
select set_config('request.jwt.claims','{"email":"ship@test.ca","role":"authenticated"}',false) \g /dev/null
do $$ begin perform fill_week_for_everyone('2026-12-07', false);
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'fill refused without permission'; end $$;
