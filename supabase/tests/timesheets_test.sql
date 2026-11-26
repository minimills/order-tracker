-- Test of the timesheet migrations (0044–0047) with a test hourly employee.
--
-- NEVER run this on the live database: it adds test people, holidays, a board
-- and hours. It is for a scratch copy of the database (a local Postgres with
-- every migration applied, or a separate Supabase test project).
--
-- What it checks: employee setup and pay rates, leave entitlements, a week
-- with a statutory holiday, banking regular and overtime hours, the
-- "Overtime / Regular pay" choice when banked hours used take a week over 44,
-- that the employee cannot see pay or enter hours, manager approval and
-- locking, a time off request (notification, approval, hours written,
-- the card due during the time off moved), who's off, the absence calendar,
-- the import (needs review, duplicates skipped) and the labour cost.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set session_replication_role = replica;
insert into allowed_users (email, name, role) values ('owner@test.ca','Owner Admin','admin'), ('mgr@test.ca','Mary Manager','staff'), ('tom@test.ca','Tom Test','staff'), ('sam@test.ca','Sam Other','staff');
insert into department_managers (department_id, user_email) select id, 'mgr@test.ca' from departments where name='Assembly Shop';
insert into user_departments (user_email, department_id) select 'tom@test.ca', id from departments where name='Assembly Shop';
insert into user_permissions (user_email, perms) values ('mgr@test.ca','{"timesheets":"view","timesheets.absences":"view","dashboard.whos_off":"view","boards":"edit","boards.card.edit":"edit","boards.card.due":"edit","boards.card.assignees":"edit"}'), ('tom@test.ca','{"timesheets.mine":"view","timesheets.time_off.request":"edit","dashboard.whos_off":"view"}');
-- a holiday on Wed Nov 11 2026 (Remembrance Day)
insert into company_holidays (name,start_date,end_date,kind,day_off) values ('Remembrance Day','2026-11-11','2026-11-11','statutory',true);
-- a board card assigned to Tom due Dec 2
insert into boards (id,name,owner_email) values ('00000000-0000-0000-0000-0000000000b1','Shop tasks','mgr@test.ca');
insert into board_stages (id,board_id,name,sort_order) values ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1','To do',1);
insert into board_cards (id,board_id,stage_id,title,due_date) values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','Weld frames','2026-12-02');
insert into board_card_assignees (card_id,user_email) values ('00000000-0000-0000-0000-0000000000d1','tom@test.ca');
set session_replication_role = origin;
set role authenticated;
\echo == owner sets up Tom
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select save_employee(jsonb_build_object('user_email','tom@test.ca','pay_type','hourly','start_date','2024-03-01','department_id',(select id from departments where name='Assembly Shop'))) as emp \gset
select set_pay_rate(:'emp','2024-03-01','hourly',25,null,'Start');
select set_pay_rate(:'emp','2026-01-01','hourly',27,null,'Raise');
select 'entitlement 2026 vacation', leave_entitlement(:'emp','vacation',2026), 'sick', leave_entitlement(:'emp','sick',2026), 'vac 2025', leave_entitlement(:'emp','vacation',2025);
\echo == week Nov 9 (holiday Wed): 4 days x 8 + bank 4 regular
select save_timesheet_week(:'emp','2026-11-09', (select jsonb_agg(jsonb_build_object('work_date', d::date, 'kind','work','start_time','07:00','end_time','15:30','break_minutes',30)) from generate_series('2026-11-09'::date,'2026-11-13','1 day') d where d::date <> '2026-11-11'))->>'worked';
select bank_hours(:'emp','2026-11-12',4,'regular','Wants a long weekend later');
select worked, stat, regular, paid_regular, overtime, credited from timesheet_week_rows('2026-11-09','2026-11-09',:'emp');
\echo == week Nov 16: 5x9 worked + 4 banked used => 49 total; choose Regular pay
\set ON_ERROR_STOP 0
select save_timesheet_week(:'emp','2026-11-16', (select jsonb_agg(jsonb_build_object('work_date', d::date, 'kind','work','hours',9)) from generate_series('2026-11-16'::date,'2026-11-20','1 day') d) || '[{"work_date":"2026-11-21","kind":"banked","hours":4}]');
\set ON_ERROR_STOP 1
select save_timesheet_week(:'emp','2026-11-16', (select jsonb_agg(jsonb_build_object('work_date', d::date, 'kind','work','hours',9)) from generate_series('2026-11-16'::date,'2026-11-20','1 day') d) || '[{"work_date":"2026-11-21","kind":"banked","hours":4}]', 'regular')->>'overtime' as ot_regular_choice;
select worked, banked_used, overtime, regular, ot_choice, ot_choice_by_name from timesheet_week_rows('2026-11-16','2026-11-16',:'emp');
select action, detail->>'choice', detail->>'total', by_name from timesheet_week_events e join timesheet_weeks w on w.id=e.week_id where w.week_start='2026-11-16' and action='ot_choice';
\echo == same week with Overtime choice
select save_timesheet_week(:'emp','2026-11-16', (select jsonb_agg(jsonb_build_object('id', t.id, 'work_date', t.work_date, 'kind', t.kind, 'hours', t.hours)) from time_entries t where t.employee_id=:'emp' and t.work_date between '2026-11-16' and '2026-11-22'), 'overtime')->>'overtime' as ot_overtime_choice;
select bank_hours(:'emp','2026-11-20',2,'overtime','bank OT');
select overtime, paid_overtime, earned_overtime, credited from timesheet_week_rows('2026-11-16','2026-11-16',:'emp');
select 'balance', ts_bank_balance(:'emp');
\echo == Tom: cannot see pay, cannot enter, sees own
select set_config('request.jwt.claims','{"email":"tom@test.ca","role":"authenticated"}',false) \g /dev/null
select 'tom sees rates', count(*) from employee_pay_rates;
\set ON_ERROR_STOP 0
select save_timesheet_week(:'emp','2026-11-23','[]');
select labour_cost_weeks('2026-01-01','2026-12-31');
select approve_timesheet_week(:'emp','2026-11-09');
\set ON_ERROR_STOP 1
select 'my balances', (my_timesheet(2026))->'balances';
\echo == Tom requests vacation Dec 1-3
select request_time_off('{"kind":"vacation","start_date":"2026-12-01","end_date":"2026-12-03","note":"Family visit"}') as req \gset
\echo == manager: notified, approves week, sees affected work, approves request, moves card
select set_config('request.jwt.claims','{"email":"mgr@test.ca","role":"authenticated"}',false) \g /dev/null
select title, body, link from notifications where user_email='mgr@test.ca';
select approve_timesheet_week(:'emp','2026-11-09','Looks right');
\set ON_ERROR_STOP 0
select bank_hours(:'emp','2026-11-10',1,'regular','locked?');
\set ON_ERROR_STOP 1
select 'mgr sees rates', count(*) from employee_pay_rates;
select decide_time_off(:'req','approved','Enjoy');
select item_type, title, start_date, can_reassign, can_move from time_off_affected_work(:'req');
select apply_time_off_changes(:'req', jsonb_build_array(jsonb_build_object('item_type','card','item_id','00000000-0000-0000-0000-0000000000d1','action','move','new_date','2026-12-04')));
select 'card due now', due_date from board_cards where id='00000000-0000-0000-0000-0000000000d1';
select name, kind, back_on from whos_off('2026-12-02');
select name, kind, start_date, end_date, status from absence_calendar('2026-12-01','2026-12-31');
\echo == Tom: decision notification, balances, whos_off without reason
select set_config('request.jwt.claims','{"email":"tom@test.ca","role":"authenticated"}',false) \g /dev/null
select title, body from notifications where user_email='tom@test.ca';
select 'vacation', (my_timesheet(2026))->'balances'->'vacation';
select name, kind from whos_off('2026-12-02');
\echo == owner: import 2025 rows, labour cost
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select import_timesheet_rows('2025 timesheet.xlsx','2025 sheet', jsonb_build_array(
  jsonb_build_object('employee_id',:'emp','work_date','2025-06-02','start_time','07:00','end_time','15:30','break_minutes',30,'import_key','k1'),
  jsonb_build_object('employee_id',:'emp','work_date','2025-06-03','hours',8,'vacation_hours',0,'import_key','k2'),
  jsonb_build_object('employee_id',:'emp','work_date','2025-06-04','hours',7,'needs_review',true,'review_note','Total did not add up','import_key','k3'),
  jsonb_build_object('employee_id',:'emp','work_date','2025-06-05','vacation_hours',8,'import_key','k4')));
select 'again', import_timesheet_rows('2025 timesheet.xlsx','2025 sheet', jsonb_build_array(jsonb_build_object('employee_id',:'emp','work_date','2025-06-02','hours',8,'import_key','k1')));
select week_start, status, worked, vacation, needs_review, imported from timesheet_week_rows('2025-06-02','2025-06-02',:'emp');
select week_start, hourly_rate, rate_assumed, paid_regular, paid_overtime, stat, cost_regular, cost_overtime, cost_stat, cost_vacation, cost_total from labour_cost_weeks('2025-06-01','2026-11-30') where cost_total > 0;
