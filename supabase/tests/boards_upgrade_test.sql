-- Test of migration 0050 (moving / copying cards, closing boards, crating per
-- order, production assignments, task assignees). NEVER run this on the live
-- database: it adds test people, orders and boards. For a scratch copy of the
-- database with every migration applied.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set session_replication_role = replica;
insert into allowed_users (email, name, role) values ('owner@test.ca','Owner Admin','admin'), ('pat@test.ca','Pat Shop','staff'), ('lee@test.ca','Lee Office','staff') on conflict do nothing;
insert into user_departments (user_email, department_id) select 'pat@test.ca', id from departments where name='Fabrication Shop' on conflict do nothing;
insert into user_permissions (user_email, perms) values
  ('pat@test.ca','{"boards":"view","boards.create":"edit","boards.manage":"edit","boards.card.edit":"edit","boards.card.history":"view","boards.card.create":"edit","boards.card.open":"view","boards.card.move":"edit","boards.card.move_board":"edit","boards.card.copy":"edit","boards.stage.move_all":"edit","boards.stage.archive_all":"edit","boards.card.archive":"edit","boards.stage.collapse":"view","boards.task.assign":"edit","boards.task.due":"edit","boards.card.checklists":"edit","boards.card.timing":"edit","boards.close":"edit","boards.reopen":"edit"}'),
  ('lee@test.ca','{"boards":"view"}') on conflict (user_email) do update set perms = excluded.perms;
set session_replication_role = origin;
-- Build steps so the Fabrication stage copies a checklist onto machine cards.
insert into build_checklist_items (machine_type_id, step, section, item_text, sort_order)
select id, 'fabrication', 'General', 'Cut the frame', 1 from machine_types where name = 'Washer';
set role authenticated;

\echo == owner: default people for the Fabrication stage (Pat for card + tasks, the Shipping department on the card)
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
insert into production_assignments (stage_template_id, assignee_type, user_email)
select id, 'user', 'pat@test.ca' from production_stage_template where step = 'fabrication';
insert into production_assignments (stage_template_id, assignee_type, department_id, applies_to)
select t.id, 'department', d.id, 'card' from production_stage_template t, departments d where t.step = 'fabrication' and d.name = 'Office';

\echo == owner: new order that will NOT be crated
select (create_order(jsonb_build_object('new_customer', jsonb_build_object('name','Test Farm','country','Canada'), 'stage','Confirmed', 'crating', false,
  'machines', jsonb_build_array(jsonb_build_object('machine_type_id', (select id from machine_types where name='Washer'), 'needs_crate', true))))) ->> 'id' as ord \gset
select 'order crating', crating from orders where id = :'ord';
select 'machine needs crate', needs_crate from order_machines where order_id = :'ord';
select id as pboard from boards where order_id = :'ord' and purpose = 'production' \gset
select 'crating stage', name, archived, auto_hidden from board_stages where board_id = :'pboard' and step = 'crating';
select id as mcard from board_cards where board_id = :'pboard' and card_kind = 'machine' \gset
select 'card stage', s.name from board_cards c join board_stages s on s.id = c.stage_id where c.id = :'mcard';
select 'card assignees', string_agg(user_email || case when auto then ' (auto)' else '' end, ', ' order by user_email) from board_card_assignees where card_id = :'mcard';
select 'task assignee', i.item_text, i.assignee_email, i.assigned_auto from board_checklist_items i join board_checklists l on l.id = i.checklist_id where l.card_id = :'mcard';

\echo == crated later: the Crating stage comes back; off again needs confirming when crates exist
select set_order_crating(:'ord', true);
select 'crating stage', archived from board_stages where board_id = :'pboard' and step = 'crating';
select 'machine needs crate', needs_crate from order_machines where order_id = :'ord';
select save_crate(jsonb_build_object('order_id', :'ord', 'length_cm', 100, 'width_cm', 80, 'height_cm', 90, 'weight_kg', 300,
  'machine_ids', jsonb_build_array((select id from order_machines where order_id = :'ord')))) is not null as crate_saved;
\set ON_ERROR_STOP 0
select set_order_crating(:'ord', false);
\set ON_ERROR_STOP 1
select 'off with confirm, crates kept', set_order_crating(:'ord', false, true);
select 'crating stage', archived, auto_hidden from board_stages where board_id = :'pboard' and step = 'crating';

\echo == Pat: a personal board; copy the machine card there, move it back refused, task assignee while running
select set_config('request.jwt.claims','{"email":"pat@test.ca","role":"authenticated"}',false) \g /dev/null
select 'pat sees production board', board_level(:'pboard');
select create_board('Pat jobs', null, '#2563eb', null, 'personal') as pb \gset
insert into board_stages (board_id, name, sort_order) values (:'pb', 'To do', 1), (:'pb', 'Done', 2);
select id as todo from board_stages where board_id = :'pb' and name = 'To do' \gset
select id as done from board_stages where board_id = :'pb' and name = 'Done' \gset
select copy_board_card(:'mcard', :'pb', :'todo') as copy \gset
select 'copy', title, card_kind, machine_id is not null as keeps_machine_link from board_cards where id = :'copy';
select 'copy tasks', count(*) from board_checklist_items i join board_checklists l on l.id = i.checklist_id where l.card_id = :'copy';
\set ON_ERROR_STOP 0
select move_card_to_board(:'mcard', :'pb', :'todo');
\set ON_ERROR_STOP 1
insert into board_cards (board_id, stage_id, title) values (:'pb', :'todo', 'Order bolts') returning id as task \gset
insert into board_checklists (card_id, title) values (:'task', 'Steps') returning id as list \gset
insert into board_checklist_items (checklist_id, item_text) values (:'list', 'Call supplier') returning id as item \gset
update board_checklist_items set started_at = now() where id = :'item';
update board_checklist_items set assignee_email = 'owner@test.ca', due_date = current_date + 3, item_text = 'Call the supplier' where id = :'item';
select 'task after change', item_text, assignee_email, started_at is not null as still_running from board_checklist_items where id = :'item';
select 'task history', string_agg(kind, ', ' order by id) from board_card_events where card_id = :'task';
\set ON_ERROR_STOP 0
update board_checklist_items set assignee_email = 'lee@test.ca' where id = :'item';
\set ON_ERROR_STOP 1
\echo == Pat: move the task card to another stage, collapse a stage, move / copy / archive all
select move_card_to_board(:'task', :'pb', :'done');
insert into board_collapsed_stages (user_email, stage_id) values ('pat@test.ca', :'done');
select 'collapsed', count(*) from board_collapsed_stages;
select 'copy all', move_stage_cards(:'done', :'pb', :'todo', true);
select 'move all', move_stage_cards(:'todo', :'pb', :'done', false);
select 'archive all', archive_stage_cards(:'done');
select 'left on board', count(*) from board_cards where board_id = :'pb' and not archived;

\echo == owner: a second personal board; move a card across boards keeps its history
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select create_board('Office jobs', null, '#2563eb', null, 'personal') as ob \gset
insert into board_stages (board_id, name, sort_order) values (:'ob', 'Inbox', 1);
select id as inbox from board_stages where board_id = :'ob' \gset
insert into board_labels (board_id, name, colour) values (:'ob', 'Urgent', '#dc2626') returning id as lbl \gset
insert into board_cards (board_id, stage_id, title) values (:'ob', :'inbox', 'Quote follow-up') returning id as oc \gset
insert into board_card_labels (card_id, label_id) values (:'oc', :'lbl');
insert into board_shares (board_id, share_type, target, level) values (:'ob', 'user', 'lee@test.ca', 'view');
insert into board_card_assignees (card_id, user_email) values (:'oc', 'lee@test.ca');
insert into board_shares (board_id, share_type, target, level) values (:'pb', 'user', 'owner@test.ca', 'edit') on conflict do nothing;
select move_card_to_board(:'oc', :'pb', :'todo');
select 'moved card', board_id = :'pb' as on_pats_board, (select string_agg(l.name, ',') from board_card_labels cl join board_labels l on l.id = cl.label_id where cl.card_id = :'oc') as labels,
       (select count(*) from board_card_assignees where card_id = :'oc') as people from board_cards where id = :'oc';
select 'history kept', string_agg(kind, ', ' order by id) from board_card_events where card_id = :'oc';

\echo == closing: shipping the order closes its board; closed boards are read-only; reopen with a new number
update orders set stage = 'Shipped', actual_ship_date = current_date where id = :'ord';
select board_number as old_number from boards where id = :'pboard' \gset
select 'closed', closed_at is not null, close_reason from boards where id = :'pboard';
select set_config('request.jwt.claims','{"email":"pat@test.ca","role":"authenticated"}',false) \g /dev/null
select 'pat level on closed board', board_level(:'pboard');
select close_board(:'pb');
select 'pat board closed', close_reason from boards where id = :'pb';
\set ON_ERROR_STOP 0
insert into board_cards (board_id, stage_id, title) values (:'pb', :'todo', 'Not allowed');
update boards set closed_at = null where id = :'pb';
\set ON_ERROR_STOP 1
select 'reopened, same number', reopen_board(:'pb', false) = (select board_number from boards where id = :'pb');
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select 'reopened, new number', reopen_board(:'pboard', true) > :'old_number'::int;
select 'apply assignments to open boards', apply_production_assignments() >= 0;
\echo == Lee may not copy or move
select set_config('request.jwt.claims','{"email":"lee@test.ca","role":"authenticated"}',false) \g /dev/null
\set ON_ERROR_STOP 0
select copy_board_card(:'oc', :'pb', :'todo');
select set_order_crating(:'ord', true);
\set ON_ERROR_STOP 1
\echo == done
