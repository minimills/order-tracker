-- Test of migration 0049 (automations) with two users and two example rules.
-- NEVER run this on the live database: it adds test people, boards, orders and automations.
-- For a scratch copy of the database with every migration applied:
--   psql -d <scratch database> -f supabase/tests/automations_test.sql
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set session_replication_role = replica;
insert into allowed_users (email, name, role) values ('owner@test.ca','Owner Admin','admin'), ('pat@test.ca','Pat Shop','staff'), ('lee@test.ca','Lee Office','staff') on conflict do nothing;
insert into user_departments (user_email, department_id) select 'pat@test.ca', id from departments where name='Assembly Shop';
insert into user_groups (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Test Group');
insert into user_group_members (group_id, user_email) values ('00000000-0000-0000-0000-0000000000f1', 'pat@test.ca'), ('00000000-0000-0000-0000-0000000000f1', 'lee@test.ca');
insert into user_departments (user_email, department_id) select 'lee@test.ca', (value ->> 'office_department_id')::uuid from app_settings where key='production';
-- Pat: boards (own board), automations. Lee: orders, shipping, payments, closing boards, automations.
insert into user_permissions (user_email, perms) values
  ('pat@test.ca','{"automations":"edit","boards":"view","boards.create":"edit","boards.card.create":"edit","boards.card.move":"edit","boards.card.labels":"edit","boards.labels.create":"edit","boards.card.complete":"edit","boards.card.edit":"edit"}'),
  ('lee@test.ca','{"automations":"edit","automations.share":"edit","orders.board":"view","order.page":"view","order.action.change_stage":"edit","order.action.mark_shipped":"edit","boards":"view","boards.close":"edit","payments":"view"}')
on conflict (user_email) do update set perms = excluded.perms;
insert into customers (id, name, company, country) values ('00000000-0000-0000-0000-0000000000c1','Ann Weaver','Fibre Farm','Canada');
insert into orders (id, order_number, customer_id, stage, order_date, currency, order_total, voltage, delivery_equipment)
values ('00000000-0000-0000-0000-0000000000a1', 9001, '00000000-0000-0000-0000-0000000000c1', 'Quote', current_date - 40, 'CAD', 25000, 'Unknown', 'Unknown');
update orders set order_code = '9001' where id = '00000000-0000-0000-0000-0000000000a1';
insert into payments (id, order_id, payment_type, amount, due_date) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Down payment', 7500, current_date - 3);
set session_replication_role = origin;
set role authenticated;

\echo == 1. Default permission: a new user starts with "use automations"
reset role;
insert into allowed_users (email, name, role) values ('new@test.ca','New Person','staff');
select 'new user perms', perms from user_permissions where user_email = 'new@test.ca';
set role authenticated;

\echo == 2. Pat: the lists only show what Pat may see and do
select set_config('request.jwt.claims','{"email":"pat@test.ca","role":"authenticated"}',false) \g /dev/null
select create_board('Pat Jobs', null, '#2563eb', null, 'personal') as board \gset
reset role;
insert into board_stages (board_id, name, sort_order) values (:'board','To Do',1), (:'board','Doing',2), (:'board','Done',3);
set role authenticated;
select 'pat triggers', string_agg(t ->> 'key', ',') from jsonb_array_elements(automation_catalog() -> 'triggers') t;
select 'pat has payment triggers', exists (select 1 from jsonb_array_elements(automation_catalog() -> 'triggers') t where t ->> 'group' = 'Payments');
select 'pat actions', string_agg(a ->> 'key', ',') from jsonb_array_elements(automation_catalog() -> 'actions') a;
select 'pat boards', string_agg(b ->> 'name', ',') from jsonb_array_elements(automation_choices() -> 'boards') b;
\echo -- Pat cannot make a payment rule, or move cards on a board Pat cannot open (refused by the database)
\set ON_ERROR_STOP 0
select save_automation('{"name":"Sneaky","trigger_key":"payment_overdue","actions":[{"type":"notify","channel":"app","targets":[{"type":"owner"}]}]}');
select save_automation('{"name":"Sneaky 2","trigger_key":"card_created","actions":[{"type":"archive_card"}]}');
\set ON_ERROR_STOP 1

\echo == 3. Example rule 1 (Pat): card moved to the last stage -> mark complete and add label Done
select save_automation(jsonb_build_object('name','Finish cards in Done','trigger_key','card_moved','enabled',true,
  'conditions', jsonb_build_array(jsonb_build_object('type','board','values',jsonb_build_array(:'board')), '{"type":"last_stage","value":true}'::jsonb),
  'actions','[{"type":"mark_complete"},{"type":"add_label","label":"Done","colour":"#16a34a"}]'::jsonb)) as rule1 \gset
insert into board_cards (board_id, stage_id, title) select :'board', id, 'Paint the frame' from board_stages where board_id = :'board' and name = 'To Do' returning id as card \gset
\echo -- Test first: shows what would happen and changes nothing
select 'test', test_automation(jsonb_build_object('id', :'rule1', 'subject_id', :'card')) -> 'status';
select 'card after test', finished_at is not null, (select count(*) from board_card_labels where card_id = :'card') from board_cards where id = :'card';
\echo -- Move the card to Doing (not the last stage: nothing happens), then to Done
select move_board_card(:'card', (select id from board_stages where board_id = :'board' and name = 'Doing'), 0);
select 'runs after Doing', count(*) from automation_runs where automation_id = :'rule1' and not is_test;
select move_board_card(:'card', (select id from board_stages where board_id = :'board' and name = 'Done'), 0);
select 'card after Done', finished_at is not null, finished_by, (select string_agg(l.name, ',') from board_card_labels cl join board_labels l on l.id = cl.label_id where cl.card_id = :'card') from board_cards where id = :'card';
select 'run log', status, trigger_text, (select string_agg(a ->> 'status' || ': ' || (a ->> 'message'), ' | ') from jsonb_array_elements(actions) a) from automation_runs where automation_id = :'rule1' and not is_test;

\echo == 4. Loop protection: a rule that moves every moved card on again
select save_automation(jsonb_build_object('name','Keep moving','trigger_key','card_moved','enabled',true,
  'conditions', jsonb_build_array(jsonb_build_object('type','board','values',jsonb_build_array(:'board'))),
  'actions','[{"type":"move_card","stage":"next"}]'::jsonb)) as rule_loop \gset
insert into board_cards (board_id, stage_id, title) select :'board', id, 'Loop card' from board_stages where board_id = :'board' and name = 'To Do' returning id as card2 \gset
select move_board_card(:'card2', (select id from board_stages where board_id = :'board' and name = 'To Do'), 5);
update board_cards set title = 'Loop card' where id = :'card2';
select move_board_card(:'card2', (select id from board_stages where board_id = :'board' and name = 'Doing'), 0);
select 'loop card is in', s.name from board_cards c join board_stages s on s.id = c.stage_id where c.id = :'card2';
select 'loop runs', status, left(coalesce(message, (actions -> 0 ->> 'message')), 90) from automation_runs where automation_id = :'rule_loop' order by id;
select set_automation_enabled(:'rule_loop', false);

\echo == 5. Example rule 2 (Lee): order shipped -> close its production board
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select count(*) from apply_board_change('00000000-0000-0000-0000-0000000000a1', 'Confirmed');
select 'production board', name, archived from boards where order_id = '00000000-0000-0000-0000-0000000000a1';
select set_config('request.jwt.claims','{"email":"lee@test.ca","role":"authenticated"}',false) \g /dev/null
select 'lee has payment triggers', exists (select 1 from jsonb_array_elements(automation_catalog() -> 'triggers') t where t ->> 'group' = 'Payments');
select 'lee has card actions', exists (select 1 from jsonb_array_elements(automation_catalog() -> 'actions') t where t ->> 'group' = 'Cards');
select save_automation((select jsonb_build_object('name', name, 'trigger_key', trigger_key, 'actions', actions, 'enabled', true)
                          from automation_templates where key = 'shipped_close_board')) as rule2 \gset
select 'test rule 2', test_automation(jsonb_build_object('id', :'rule2', 'subject_id', '00000000-0000-0000-0000-0000000000a1'))::text;
select 'board still open after test', not archived from boards where order_id = '00000000-0000-0000-0000-0000000000a1';
select count(*) from apply_board_change('00000000-0000-0000-0000-0000000000a1', 'Shipped');
select 'board after shipping (closed)', closed_at is not null, close_reason from boards where order_id = '00000000-0000-0000-0000-0000000000a1';
select 'run log 2', status, actor_name, actions -> 0 ->> 'message' from automation_runs where automation_id = :'rule2' and not is_test;

\echo == 6. Payment overdue -> notify the office (the minute job), Pat is not told (no payments access)
select save_automation((select jsonb_build_object('name', name, 'trigger_key', trigger_key, 'actions', actions, 'enabled', true)
                          from automation_templates where key = 'overdue_notify_office')) as rule3 \gset
reset role;
select 'tick', automations_tick();
select 'tick again (once only)', automations_tick();
select 'office notified', user_email, kind, title from notifications where kind like 'automation_%' and title like 'Payment overdue%';
set role authenticated;

\echo == 7. Sharing: Lee shares rule 2 with Pat (view only, they share a group); Pat sees it, cannot change it
select share_automation(:'rule2', '[{"type":"user","target":"pat@test.ca","can_edit":false}]');
select set_config('request.jwt.claims','{"email":"pat@test.ca","role":"authenticated"}',false) \g /dev/null
select 'pat sees', string_agg((x ->> 'name') || ' (level ' || (x ->> 'level') || ')', ', ' order by x ->> 'name') from jsonb_array_elements(automation_list()) x;
select 'pat sees run log of rule 2', count(*) from automation_runs where automation_id = :'rule2';
\set ON_ERROR_STOP 0
select set_automation_enabled(:'rule2', false);
\set ON_ERROR_STOP 1
select set_config('request.jwt.claims','{"email":"new@test.ca","role":"authenticated"}',false) \g /dev/null
select 'new person sees', jsonb_array_length(automation_list()), (select count(*) from automations);

\echo == 8. The owner loses a permission: that action is skipped, logged, and the owner is told
reset role;
update user_permissions set perms = perms - 'boards.card.labels' where user_email = 'pat@test.ca';
set role authenticated;
select set_config('request.jwt.claims','{"email":"pat@test.ca","role":"authenticated"}',false) \g /dev/null
insert into board_cards (board_id, stage_id, title) select :'board', id, 'Second card' from board_stages where board_id = :'board' and name = 'Doing' returning id as card3 \gset
select move_board_card(:'card3', (select id from board_stages where board_id = :'board' and name = 'Done'), 0);
select 'partial run', status, (select string_agg(a ->> 'status' || ': ' || (a ->> 'message'), ' | ') from jsonb_array_elements(actions) a) from automation_runs where automation_id = :'rule1' and not is_test order by id desc limit 1;
select 'pat told', title, left(body, 80) from notifications where user_email = 'pat@test.ca' and kind = 'automation_problem';

\echo == 9. Limit runs per minute (set to 2): the third run is refused and logged
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select set_automation_settings('{"runs_per_minute_rule": 2}') -> 'runs_per_minute_rule';
select set_config('request.jwt.claims','{"email":"pat@test.ca","role":"authenticated"}',false) \g /dev/null
insert into board_cards (board_id, stage_id, title) select :'board', id, 'Limit card' from board_stages where board_id = :'board' and name = 'Doing' returning id as card4 \gset
select move_board_card(:'card4', (select id from board_stages where board_id = :'board' and name = 'Done'), 0);
select 'limited', status, message from automation_runs where automation_id = :'rule1' and status = 'limited';
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select set_automation_settings('{"runs_per_minute_rule": 20}') -> 'runs_per_minute_rule';

\echo == 10. The owner is removed: their automations are paused and listed for admins
reset role;
delete from allowed_users where email = 'pat@test.ca';
select 'after removal', name, enabled, paused_reason, owner_email is null, removed_owner_email from automations where removed_owner_email = 'pat@test.ca' order by name;
set role authenticated;
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select 'admin sees owner_removed', automation_schedule_status() -> 'owner_removed';
\set ON_ERROR_STOP 0
select set_automation_enabled(:'rule1', true);
\set ON_ERROR_STOP 1
select admin_reassign_automation(:'rule_loop', 'owner@test.ca');
select 'reassigned', owner_email, enabled from automations where id = :'rule_loop';
reset role;
