-- Test of migration 0053 (private / shared calendar entries, Calendar without
-- Service / Training, Mark Training as Done, the Service / Training summary).
-- NEVER run this on the live database: it adds test people, orders and boards.
-- For a scratch copy of the database with every migration applied.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set session_replication_role = replica;
insert into allowed_users (email, name, role) values
  ('owner@test.ca','Owner Admin','admin'), ('tech@test.ca','Terry Tech','staff'),
  ('cal@test.ca','Casey Calendar','staff'), ('office@test.ca','Olive Office','staff') on conflict do nothing;
insert into user_permissions (user_email, perms) values
  ('tech@test.ca','{"service":"view","service.calendar":"view","service.calendar.all":"view","service.log":"edit","boards":"view","boards.card.timing":"edit","boards.card.open":"view","service.training.done":"edit","service.summary":"view"}'),
  ('cal@test.ca','{"service.calendar":"view"}'),
  ('office@test.ca','{"service":"view","service.calendar":"view","service.calendar.all":"view","service.calendar.manage":"edit","service.calendar.share":"edit"}')
  on conflict (user_email) do update set perms = excluded.perms;
-- Terry is in the Service / Training team (made by 0053); Olive is not.
insert into user_group_members (group_id, user_email)
select (value -> 'service_team' -> 0 ->> 'target')::uuid, 'tech@test.ca' from app_settings where key = 'calendar' on conflict do nothing;
set session_replication_role = origin;
set role authenticated;

\echo == Terry: a private entry and a travel day (shared with the team by default)
select set_config('request.jwt.claims','{"email":"tech@test.ca","role":"authenticated"}',false) \g /dev/null
select save_calendar_entry('{"kind":"other","title":"Dentist","start_date":"2026-12-01","end_date":"2026-12-01","visibility":"private"}') as private_id \gset
select save_calendar_entry('{"kind":"travel","title":"Fly to Ohio","start_date":"2026-12-02","end_date":"2026-12-03","visibility":"shared"}') as travel_id \gset
select 'travel shares', share_type from calendar_entry_shares where entry_id = :'travel_id';
select 'terry sees', string_agg(title, ', ' order by title) from calendar_entries('2026-12-01','2026-12-31','tech@test.ca') where source = 'manual';

\echo == The admin (all calendars) does not see the private entry
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select 'admin sees (all)', string_agg(title, ', ' order by title) from calendar_entries('2026-12-01','2026-12-31',null) where source = 'manual';
select 'admin table rows', count(*) from tech_calendar_entries where id = :'private_id';
select set_config('test.private', :'private_id', false) \g /dev/null
do $$ begin perform calendar_entry_details(current_setting('test.private')::uuid);
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'admin details refused: %', sqlerrm; end $$;

\echo == Olive (manage, not in the team) cannot see or change Terry travel day
select set_config('request.jwt.claims','{"email":"office@test.ca","role":"authenticated"}',false) \g /dev/null
select 'olive sees terry', count(*) from calendar_entries('2026-12-01','2026-12-31','tech@test.ca') where source = 'manual';
select set_config('test.travel', :'travel_id', false) \g /dev/null
do $$ begin perform save_calendar_entry(jsonb_build_object('id', current_setting('test.travel'), 'title', 'x'));
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'olive change refused: %', sqlerrm; end $$;
\echo == Olive puts an entry on Terry calendar: private is refused, shared works
do $$ begin perform save_calendar_entry('{"tech_email":"tech@test.ca","kind":"onsite","start_date":"2026-12-10","end_date":"2026-12-10","visibility":"private"}');
  raise exception 'should have failed'; exception when invalid_parameter_value then raise notice 'private for someone else refused: %', sqlerrm; end $$;
select save_calendar_entry('{"tech_email":"tech@test.ca","kind":"onsite","title":"Ohio Farm visit","start_date":"2026-12-10","end_date":"2026-12-10","visibility":"shared","shares":[{"type":"user","target":"office@test.ca"}]}') as olive_entry \gset
select 'olive sees her entry for terry', count(*) from calendar_entries('2026-12-01','2026-12-31','tech@test.ca') where source = 'manual';

\echo == Casey (Calendar only): own entries, no service kinds, sharing needs permission
select set_config('request.jwt.claims','{"email":"cal@test.ca","role":"authenticated"}',false) \g /dev/null
select save_calendar_entry('{"kind":"other","title":"Supplier call","start_date":"2026-12-04","end_date":"2026-12-04","all_day":false,"starts_at":"2026-12-04T14:00:00Z","ends_at":"2026-12-04T15:00:00Z"}') as cal_id \gset
do $$ begin perform save_calendar_entry('{"kind":"travel","start_date":"2026-12-05","end_date":"2026-12-05"}');
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'travel refused: %', sqlerrm; end $$;
do $$ begin perform save_calendar_entry('{"kind":"other","title":"Lunch","start_date":"2026-12-06","end_date":"2026-12-06","visibility":"shared","shares":[{"type":"user","target":"tech@test.ca"}]}');
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'share refused: %', sqlerrm; end $$;
do $$ begin perform calendar_entries('2026-12-01','2026-12-31',null);
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'all calendars refused: %', sqlerrm; end $$;
select 'casey sees', string_agg(title, ', ') from calendar_entries('2026-12-01','2026-12-31','cal@test.ca');
reset role;
set session_replication_role = replica;
update user_permissions set perms = perms || '{"service.calendar.share":"edit"}' where user_email = 'cal@test.ca';
set session_replication_role = origin;
set role authenticated;
select save_calendar_entry('{"kind":"other","title":"Lunch with Terry","start_date":"2026-12-06","end_date":"2026-12-06","visibility":"shared","shares":[{"type":"user","target":"tech@test.ca"}]}') as lunch_id \gset
select set_config('request.jwt.claims','{"email":"tech@test.ca","role":"authenticated"}',false) \g /dev/null
select 'terry sees casey''s shared lunch', count(*) from calendar_entries('2026-12-01','2026-12-31','tech@test.ca') where source_id = :'lunch_id';
select 'terry cannot see casey''s own call', count(*) from calendar_entries('2026-12-01','2026-12-31','tech@test.ca') where title = 'Supplier call';
select set_config('test.lunch', :'lunch_id', false) \g /dev/null
do $$ begin perform archive_calendar_entry(current_setting('test.lunch')::uuid);
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'terry archive of casey''s entry refused'; end $$;
do $$ begin update public.tech_calendar_entries set title = 'hack';
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'direct update refused'; end $$;

\echo == Activity log: private entries are not logged
reset role;
select 'activity private', count(*) from activity_log where table_name = 'tech_calendar_entries' and record_id in (:'private_id', :'cal_id');
select 'activity shared', count(*) from activity_log where table_name = 'tech_calendar_entries' and record_id = :'travel_id';

\echo == Training order, a card linked to it, an entry linked to it
set role authenticated;
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select (create_order(jsonb_build_object('new_customer', jsonb_build_object('name','Ohio Farm','country','United States'), 'stage','Confirmed', 'crating', false,
  'machines', jsonb_build_array(jsonb_build_object('machine_type_id', (select id from machine_types where not archived limit 1)))))) ->> 'id' as ord \gset
update orders set training_needed = true, technician_email = 'tech@test.ca', service_start = '2026-12-14', service_end = '2026-12-16', travel_days = 2 where id = :'ord';
select create_board('Training jobs', null, '#2563eb', null, 'personal') as tb \gset
insert into board_stages (board_id, name, sort_order) values (:'tb', 'To do', 1);
insert into board_shares (board_id, share_type, target, level) values (:'tb', 'user', 'tech@test.ca', 'edit');
insert into board_cards (board_id, stage_id, title, order_id) values (:'tb', (select id from board_stages where board_id = :'tb'), 'Training at Ohio Farm', :'ord') returning id as tcard \gset
select set_config('request.jwt.claims','{"email":"tech@test.ca","role":"authenticated"}',false) \g /dev/null
select save_calendar_entry(jsonb_build_object('kind','training','title','Training day 1','start_date','2026-12-14','end_date','2026-12-14','visibility','shared','order_id', :'ord')) as tentry \gset
do $$ begin update public.orders set training_done_at = now() where training_needed;
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'direct training_done change refused'; end $$;
select 'candidates', training_done_candidates(:'ord') -> 'cards' -> 0 ->> 'title', training_done_candidates(:'ord') -> 'cards' -> 0 ->> 'suggested', training_done_candidates(:'ord') ->> 'entries';
select 'summary before', service_day_summary('2026-01-01','2026-12-31');
select 'mark done', mark_training_done(:'ord', true, array[:'tcard']::uuid[]);
select 'order', training_done_by_name is not null, training_done_at is not null from orders where id = :'ord';
select 'card', finished_by, finished_at is not null from board_cards where id = :'tcard';
select 'entry done', done_at is not null, done_by from tech_calendar_entries where id = :'tentry';
select 'calendar training row done', done from calendar_entries('2026-12-01','2026-12-31','tech@test.ca') where source = 'training';
select 'service info', training_done_by_name from order_service_info where order_id = :'ord';
select 'summary after', service_day_summary('2026-01-01','2026-12-31');
select 'undo', mark_training_done(:'ord', false);
select 'order after undo', training_done_at is null from orders where id = :'ord';

\echo == Casey has no Service / Training: training visits are not on her calendar
select set_config('request.jwt.claims','{"email":"cal@test.ca","role":"authenticated"}',false) \g /dev/null
do $$ begin perform service_day_summary('2026-01-01','2026-12-31');
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'summary refused for casey'; end $$;
do $$ begin perform mark_training_done((select id from public.orders limit 1), true);
  raise exception 'should have failed'; exception when insufficient_privilege then raise notice 'training done refused for casey'; end $$;

\echo == Phone link: Terry feed has his own and shared entries, not Casey own call
reset role;
insert into calendar_feeds (user_email, token) values ('tech@test.ca', repeat('a', 40)) on conflict (user_email) do update set token = excluded.token;
select 'feed', string_agg(title, ', ' order by title) from calendar_feed(repeat('a', 40)) where source = 'manual';
