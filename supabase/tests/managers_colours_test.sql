-- Test of migration 0056: several managers per department (time off goes to all,
-- the first decision settles it), custom colour codes, who reacted to a notice.
-- NEVER run this on the live database: it adds test people, an employee and a notice.
-- For a scratch copy of the database with every migration applied:
--   psql -d <scratch database> -f supabase/tests/managers_colours_test.sql
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set session_replication_role = replica;
insert into allowed_users (email, name, role) values ('owner@test.ca','Owner Admin','admin'), ('ann@test.ca','Ann Manager','staff'), ('bob@test.ca','Bob Manager','staff'), ('tom@test.ca','Tom Test','staff');
insert into user_departments (user_email, department_id) select 'tom@test.ca', id from departments where name='Assembly Shop';
insert into user_permissions (user_email, perms) values
  ('ann@test.ca','{"timesheets.time_off":"view","notices":"view","notices.react":"edit","notices.reactions.who":"view"}'),
  ('bob@test.ca','{"timesheets.time_off":"view","notices":"view"}'),
  ('tom@test.ca','{"timesheets.time_off.request":"edit","notices":"view","notices.react":"edit"}');
set session_replication_role = origin;
set role authenticated;

\echo == owner adds two managers to Assembly Shop and sets Tom up
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
insert into department_managers (department_id, user_email) select id, 'ann@test.ca' from departments where name='Assembly Shop';
insert into department_managers (department_id, user_email) select id, 'BOB@test.ca' from departments where name='Assembly Shop';
select 'first manager kept on departments', manager_email from departments where name='Assembly Shop';
select save_employee(jsonb_build_object('user_email','tom@test.ca','pay_type','hourly','start_date','2024-03-01','department_id',(select id from departments where name='Assembly Shop'))) as emp \gset

\echo == staff cannot add managers
select set_config('request.jwt.claims','{"email":"bob@test.ca","role":"authenticated"}',false) \g /dev/null
\set ON_ERROR_STOP 0
insert into department_managers (department_id, user_email) select id, 'tom@test.ca' from departments where name='Assembly Shop';
\set ON_ERROR_STOP 1

\echo == Tom asks for time off: both managers are told
select set_config('request.jwt.claims','{"email":"tom@test.ca","role":"authenticated"}',false) \g /dev/null
select request_time_off('{"kind":"unpaid","start_date":"2026-12-07","end_date":"2026-12-08"}') as req \gset
reset role;
select 'request notified', string_agg(user_email, ',' order by user_email) from notifications where kind='time_off_request' and link like '%' || :'req';
set role authenticated;

\echo == Ann approves first; Bob is refused and told who decided
select set_config('request.jwt.claims','{"email":"ann@test.ca","role":"authenticated"}',false) \g /dev/null
select 'ann is manager', ts_is_manager_of(:'emp');
select decide_time_off(:'req','approved','Enjoy')->>'days_written';
select set_config('request.jwt.claims','{"email":"bob@test.ca","role":"authenticated"}',false) \g /dev/null
select 'bob is manager', ts_is_manager_of(:'emp');
\set ON_ERROR_STOP 0
select decide_time_off(:'req','declined','No');
\set ON_ERROR_STOP 1
select 'bob sees', status, decided_by_name from time_off_requests where id = :'req';
select 'bob settled note', title from notifications where kind='time_off_settled' and user_email='bob@test.ca';
reset role;
select 'ann settled note (none)', count(*) from notifications where kind='time_off_settled' and user_email='ann@test.ca';
set role authenticated;

\echo == removing a manager moves the first manager along
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
delete from department_managers where user_email='ann@test.ca';
select 'first manager now', manager_email from departments where name='Assembly Shop';

\echo == custom colour codes
reset role;
insert into notices (id, title, body, colour, audience_everyone, author_email) values ('00000000-0000-0000-0000-00000000aa01','Hex note','', '#12ab9c', true, 'owner@test.ca');
\set ON_ERROR_STOP 0
update notices set colour = 'teal' where id='00000000-0000-0000-0000-00000000aa01';
update notices set colour = '#12ab9' where id='00000000-0000-0000-0000-00000000aa01';
set role authenticated;
\set ON_ERROR_STOP 1
select 'notice colour', colour from notices where id='00000000-0000-0000-0000-00000000aa01';

\echo == who reacted
select set_config('request.jwt.claims','{"email":"tom@test.ca","role":"authenticated"}',false) \g /dev/null
select toggle_notice_reaction('00000000-0000-0000-0000-00000000aa01', '👍') \g /dev/null
select 'tom without permission sees', count(*) from notice_reaction_people('00000000-0000-0000-0000-00000000aa01');
select set_config('request.jwt.claims','{"email":"ann@test.ca","role":"authenticated"}',false) \g /dev/null
select toggle_notice_reaction('00000000-0000-0000-0000-00000000aa01', '👍') \g /dev/null
select 'ann sees', emoji, string_agg(name, ', ' order by reacted_at) from notice_reaction_people('00000000-0000-0000-0000-00000000aa01') group by emoji;
