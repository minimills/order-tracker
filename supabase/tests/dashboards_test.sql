-- Test of migration 0048 (dashboards, templates, sharing, Glass) with two users.
-- NEVER run this on the live database: it adds test people and dashboards.
-- For a scratch copy of the database with every migration applied.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set session_replication_role = replica;
insert into allowed_users (email, name, role) values ('owner@test.ca','Owner Admin','admin'), ('pat@test.ca','Pat Shop','staff'), ('lee@test.ca','Lee Office','staff') on conflict do nothing;
insert into user_departments (user_email, department_id) select 'pat@test.ca', id from departments where name='Assembly Shop';
insert into user_permissions (user_email, perms) values
  ('pat@test.ca','{"dashboard":"view","dashboard.charts.customize":"edit","dashboard.tabs":"edit","dashboard.reset":"edit","dashboard.share":"edit","settings.theme":"edit"}'),
  ('lee@test.ca','{"dashboard":"view"}') on conflict (user_email) do update set perms = excluded.perms;
set session_replication_role = origin;
set role authenticated;

\echo == owner: template for the Assembly Shop, locked
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select save_dashboard_template('{"name":"Production","description":"For the shop","locked":true,"widgets":[{"id":"w1","key":"kpi:in_production"},{"id":"w2","key":"list:my_tasks"}],"layouts":{"lg":[{"i":"w1","x":0,"y":0,"w":3,"h":2},{"i":"w2","x":3,"y":0,"w":6,"h":4}]}}') as tpl \gset
select set_dashboard_template_targets(:'tpl', (select jsonb_agg(jsonb_build_object('type','department','target',id)) from departments where name='Assembly Shop'));

\echo == Pat opens the dashboard: gets the template copy, locked
select set_config('request.jwt.claims','{"email":"pat@test.ca","role":"authenticated"}',false) \g /dev/null
select name, is_default, locked, jsonb_array_length(widgets) from my_dashboards();
\set ON_ERROR_STOP 0
select save_dashboard(jsonb_build_object('id', (select id from dashboards where owner_email='pat@test.ca' limit 1), 'widgets', '[]'::jsonb));
select set_my_preferences('{"theme":"neon"}');
\set ON_ERROR_STOP 1
\echo == Pat makes a second dashboard, sets it default, shares it with Lee
select save_dashboard('{"name":"Money","widgets":[{"id":"a","key":"chart:outstanding","display":"pie"}],"layouts":{"lg":[{"i":"a","x":0,"y":0,"w":6,"h":4}]}}') as money \gset
select set_default_dashboard(:'money');
select duplicate_dashboard(:'money', null) is not null as duplicated;
select name, is_default, locked, sort_order from dashboards order by sort_order;
select 'shared with', share_dashboard(:'money', array['lee@test.ca','owner@test.ca']);
select set_my_preferences('{"theme":"glass","glass_base":"dark"}');
select theme, glass_base from user_preferences where user_email = 'pat@test.ca';
\echo == Lee: sees only own dashboards (the shared copy), cannot change it
select set_config('request.jwt.claims','{"email":"lee@test.ca","role":"authenticated"}',false) \g /dev/null
select name, shared_by_name from my_dashboards();
select 'lee sees pat rows', count(*) from dashboards where owner_email = 'pat@test.ca';
select title from notifications where user_email='lee@test.ca';
\set ON_ERROR_STOP 0
select save_dashboard('{"name":"Mine"}');
select save_dashboard_template('{"name":"x"}');
\set ON_ERROR_STOP 1
\echo == owner unlocks and changes the template, gives it again; Pat resets
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select save_dashboard_template(jsonb_build_object('id', :'tpl', 'name', 'Production', 'locked', false, 'widgets', '[{"id":"w1","key":"kpi:in_production"}]'::jsonb));
select set_config('request.jwt.claims','{"email":"pat@test.ca","role":"authenticated"}',false) \g /dev/null
select name, locked, jsonb_array_length(widgets) from dashboards where template_id = :'tpl';
select save_dashboard(jsonb_build_object('id', (select id from dashboards where template_id = :'tpl'), 'widgets', '[]'::jsonb)) is not null as changed;
select reset_dashboard((select id from dashboards where template_id = :'tpl')) is not null as reset;
select name, jsonb_array_length(widgets) from dashboards where template_id = :'tpl';
select set_config('request.jwt.claims','{"email":"owner@test.ca","role":"authenticated"}',false) \g /dev/null
select 'given to', apply_dashboard_template(:'tpl');
