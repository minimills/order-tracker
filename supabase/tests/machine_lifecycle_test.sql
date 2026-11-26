-- Test of migrations 0057–0059 (machine lifecycle): one older machine, one
-- private sale, and one buy-back that goes through refurbishment and is sold to
-- a new customer.
-- NEVER run this on the live database: it adds test people, customers, machines and an order.
-- For a scratch copy of the database with every migration applied:
--   psql -d <scratch database> -f supabase/tests/machine_lifecycle_test.sql
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set session_replication_role = replica;
insert into allowed_users (email, name, role) values ('owner@test.ca','Owner Admin','admin'), ('mia@test.ca','Mia Office','staff'), ('sam@test.ca','Sam Shop','staff');
insert into user_permissions (user_email, perms) values
  ('mia@test.ca','{"machines":"view","machines.add_existing":"edit","machines.import":"edit","machines.transfer":"edit","machines.buyback":"edit","machines.stock":"edit","refurb":"edit","refurb.complete":"edit","refurb.costs":"view","orders.new":"edit","order.field.order_total":"edit","service.calls":"view","orders.new.from_stock":"edit","order.page":"view","reports.machines":"view","ce.issue":"edit"}'),
  ('sam@test.ca','{"machines":"view","refurb":"edit","reports.machines":"view"}');
insert into customers (id, name, company, country) values
  ('00000000-0000-0000-0000-0000000000c1','Ann Weaver','Fibre Farm','Canada'),
  ('00000000-0000-0000-0000-0000000000c2','Bob Spinner',null,'United States'),
  ('00000000-0000-0000-0000-0000000000c3','Cara Felt','Felt Works','United Kingdom');
insert into employees (id, user_email, name, pay_type, start_date) values ('00000000-0000-0000-0000-0000000000e1','sam@test.ca','Sam Shop','hourly','2020-01-01');
insert into employee_pay_rates (employee_id, effective_from, pay_type, hourly_rate, reason) values ('00000000-0000-0000-0000-0000000000e1','2020-01-01','hourly',30,'Start');
insert into incoming_shipments (id, supplier, description, shipping_cost, currency, exchange_rate, received_on)
values ('00000000-0000-0000-0000-0000000000f1','Bob Spinner','Picker coming back from Ohio', 900, 'CAD', 1, current_date - 20);
set session_replication_role = origin;
set role authenticated;
select set_config('request.jwt.claims','{"email":"mia@test.ca","role":"authenticated"}',false) \g /dev/null

\echo == 1. Older machine: a Picker built about 2011 for Fibre Farm
select add_existing_machine(jsonb_build_object('machine_type_id',(select id from machine_types where code='PKR'),
  'serial_number','pkr-0815','year_built',2011,'year_approx',true,'voltage','120V','original_customer_id','00000000-0000-0000-0000-0000000000c1',
  'current','same','location','At the customer','condition','Good','notes','Sold before the app')) as m \gset
select 'serial', serial_number, 'origin', origin, 'order', coalesce(order_id::text,'none'), 'built', ready from order_machines where id = :'m';
\set ON_ERROR_STOP 0
select add_existing_machine(jsonb_build_object('machine_type_id',(select id from machine_types where code='PKR'),'serial_number','PKR-0815'));
\set ON_ERROR_STOP 1
select 'import preview', jsonb_pretty(import_existing_machines('[{"serial_number":"PKR-0815","machine_type":"Picker"},{"serial_number":"SSM-0100","machine_type":"Washer","current_owner":"Company"},{"serial_number":"X-1","machine_type":"Nope"}]', false) -> 'rows');

\echo == 2. Private sale: Fibre Farm sold it to Bob (we found out from a service call)
select change_machine_owner(jsonb_build_object('machine_id',:'m','how','private_sale','customer_id','00000000-0000-0000-0000-0000000000c2',
  'date', current_date - 400, 'found_out','He called for a service visit','notes','Bought it at a farm auction')) \g /dev/null
select 'owner now', c.name from customers c where c.id = machine_owner_id(:'m');
reset role;
select 'service list for Bob', count(*) from customer_machines('00000000-0000-0000-0000-0000000000c2') where machine_id = :'m';
set role authenticated;

\echo == 3. Buy-back from Bob, freight in on an incoming shipment
select record_buyback(jsonb_build_object('machine_id',:'m','date',current_date - 30,'price',3000,'currency','USD','exchange_rate',1.35,
  'condition','Needs repair','reason','Upgrading to a larger machine','arranged_by','mia@test.ca',
  'incoming_shipment_id','00000000-0000-0000-0000-0000000000f1')) \g /dev/null
select 'stock', stock_status, 'company owned', machine_company_owned(id), 'owner id', coalesce(machine_owner_id(id)::text,'company') from order_machines where id = :'m';

\echo == 4. Refurbishment
select open_refurb_job(:'m', '{"before_notes":"Rusty frame, worn belts"}') as job \gset
reset role;
select 'board stages', string_agg(s.name, ' > ' order by s.sort_order) from refurb_jobs j join board_stages s on s.board_id = j.board_id where j.id = :'job';
select 'checklists', count(*) from refurb_jobs j join board_checklists l on l.card_id = j.card_id where j.id = :'job';
set role authenticated;
select 'status', stock_status from order_machines where id = :'m';
select save_refurb_note(jsonb_build_object('job_id',:'job','stage_id',(select s.id from refurb_jobs j join board_stages s on s.board_id=j.board_id where j.id=:'job' and s.name='Disassembly'),'note','Took the drum off; bearings seized')) \g /dev/null
select save_refurb_part(jsonb_build_object('job_id',:'job','part','Drum bearing','quantity',2,'unit_cost',85,'old_part','scrapped','stage_name','Repair / Replace')) \g /dev/null
select save_refurb_cost(jsonb_build_object('job_id',:'job','description','Powder coating of the frame','supplier','Island Coatings','amount',450)) \g /dev/null
\echo   Sam (no cost permission) cannot enter a price or see costs
select set_config('request.jwt.claims','{"email":"sam@test.ca","role":"authenticated"}',false) \g /dev/null
\set ON_ERROR_STOP 0
select save_refurb_part(jsonb_build_object('job_id',:'job','part','Belt','unit_cost',20));
select refurb_cost_summary(:'job');
\set ON_ERROR_STOP 1
select save_refurb_part(jsonb_build_object('job_id',:'job','part','Belt','quantity',1)) \g /dev/null
select 'sam sees parts (no prices)', count(*) from refurb_parts_list(:'job');
select 'sam reads refurb_parts table', count(*) from refurb_parts;
select set_config('request.jwt.claims','{"email":"mia@test.ca","role":"authenticated"}',false) \g /dev/null
\echo   labour: Sam worked 6 hours on the card
reset role;
set session_replication_role = replica;
update board_cards set started_at = now() - interval '7 hours', finished_at = now() - interval '1 hour', finished_by = 'sam@test.ca', finished_by_name = 'Sam Shop'
 where id = (select card_id from refurb_jobs where id = :'job');
set session_replication_role = origin;
set role authenticated;
\echo   completing before the final check is refused
select 'preview', complete_refurb_job(:'job', '{"preview":true}');
select complete_refurb_job(:'job', '{}') ->> 'done' as done_without_check;
\echo   final check after refurbishment (signed directly for the test)
reset role;
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select start_checklist(:'m') as chk \gset
set session_replication_role = replica;
update machine_checklists_all set signed_at = now(), signed_name = 'Owner Admin' where id = :'chk';
set session_replication_role = origin;
select 'checklists kept', count(*), 'current', count(*) filter (where superseded_at is null), 'linked to job', count(*) filter (where refurb_job_id = :'job') from machine_checklists_all where machine_id = :'m';
set role authenticated;
select set_config('request.jwt.claims','{"email":"mia@test.ca","role":"authenticated"}',false) \g /dev/null
select 'complete', complete_refurb_job(:'job', '{"condition_after":"Like new","after_notes":"New bearings, belts, coated frame"}');
select 'machine', serial_number, item_kind, stock_status, condition, refurb_count from order_machines where id = :'m';
select 'old serial finds it', count(*) from find_machines('PKR-0815') where machine_id = :'m';
select 'next refurb would be', refurb_next_serial(:'m');
\echo   the old serial can never be given to another machine
\set ON_ERROR_STOP 0
select add_existing_machine(jsonb_build_object('machine_type_id',(select id from machine_types where code='PKR'),'serial_number','PKR-0815'));
\set ON_ERROR_STOP 1
select set_machine_stock(:'m', '{"sale_price":9500,"sale_currency":"CAD"}') \g /dev/null
select 'cost summary', refurb_cost_summary(:'job');

\echo == 5. Sold from stock to a new customer (Felt Works)
select create_order_with_stock(jsonb_build_object('customer_id','00000000-0000-0000-0000-0000000000c3','order_total',9500,'currency','CAD','crating',true),
                               jsonb_build_array(jsonb_build_object('machine_id',:'m','kind','stock'))) ->> 'id' as ord \gset
select 'on order', o.order_code, m.stock_status, m.item_kind, m.serial_number from order_machines m join orders o on o.id = m.order_id where m.id = :'m';
select 'chips', item_kind, checklist_status from order_machine_status where id = :'m';
select 'gate problems', checklist_gate_problems(:'ord');
reset role;
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
update orders set stage = 'Shipped', actual_ship_date = current_date where id = :'ord';
set role authenticated;
select set_config('request.jwt.claims','{"email":"mia@test.ca","role":"authenticated"}',false) \g /dev/null
select 'after shipping', stock_status, (select c.company from customers c where c.id = machine_owner_id(:'m')) from order_machines where id = :'m';
select 'warranty', machine_warranty(:'m');
select 'CE data', ce_declaration_data(:'m') -> 'machine';
reset role;
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select create_certificate(:'ord') as cert \gset
select 'certificate machine note', machines -> 0 ->> 'serial', machines -> 0 ->> 'note' from service_certificates where id = :'cert';
select set_config('request.jwt.claims','{"email":"mia@test.ca","role":"authenticated"}',false) \g /dev/null
set role authenticated;

\echo == 6. Machine page and reports
select 'owners', jsonb_path_query_array(machine_details(:'m') -> 'owners', '$[*].how');
select 'timeline', jsonb_pretty(jsonb_path_query_array(machine_details(:'m') -> 'timeline', '$[*].title'));
select 'old serials', machine_details(:'m') -> 'old_serials';
select 'report profit', machine_reports() -> 'profit';
select 'report by country', machine_reports() -> 'by_country';
select set_config('request.jwt.claims','{"email":"sam@test.ca","role":"authenticated"}',false) \g /dev/null
select 'sam report costs visible', machine_reports() -> 'costs_visible', machine_reports() -> 'profit';
