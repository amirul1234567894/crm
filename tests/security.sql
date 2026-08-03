-- ============================================================================
--  SECURITY TEST SUITE — tenant isolation ar privilege escalation
--
--  Ei file ta protita deploy er age chalabi. Kono "❌" ashle DEPLOY KORBI NA.
--
--  Kivabe chalabi:
--    Supabase → SQL Editor e paste kore Run
--    othoba: psql "$DATABASE_URL" -f tests/security.sql
--
--  ⚠️  Eta TEST DATA banay ar muche dey. Production e chalanor age
--      niche er UUID gulo tor asol user er UUID diye bodle nis,
--      othoba ekta staging database e chalao.
-- ============================================================================

\set ON_ERROR_STOP off
\pset footer off

begin;

-- ----------------------------------------------------------------------------
-- Setup: duita org, tin dhoroner user
-- ----------------------------------------------------------------------------

insert into organizations (name, slug, status) values
  ('Test Alpha', 'zz-test-alpha', 'active'),
  ('Test Beta',  'zz-test-beta',  'active');

insert into org_settings (org_id) select id from organizations where slug like 'zz-test-%';
insert into org_secrets (org_id, meta_access_token)
  select id, 'SECRET_' || slug from organizations where slug like 'zz-test-%';

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'zz-owner-alpha@test.local'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'zz-agent-alpha@test.local'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'zz-owner-beta@test.local');

update profiles set org_id = (select id from organizations where slug='zz-test-alpha'),
  role = 'owner' where id = 'aaaaaaaa-0000-4000-8000-000000000001';
update profiles set org_id = (select id from organizations where slug='zz-test-alpha'),
  role = 'agent' where id = 'aaaaaaaa-0000-4000-8000-000000000002';
update profiles set org_id = (select id from organizations where slug='zz-test-beta'),
  role = 'owner' where id = 'bbbbbbbb-0000-4000-8000-000000000001';

insert into leads (org_id, name, source, channel_uid, status)
  select id, 'Alpha Lead', 'whatsapp', 'zz-alpha-001', 'new'
  from organizations where slug='zz-test-alpha';
insert into leads (org_id, name, source, channel_uid, status)
  select id, 'Beta Lead', 'whatsapp', 'zz-beta-001', 'new'
  from organizations where slug='zz-test-beta';

insert into invoices (org_id, invoice_no, amount, status, due_date)
  select id, 'ZZ-TEST-INV-001', 9999, 'unpaid', current_date
  from organizations where slug='zz-test-alpha';

-- ----------------------------------------------------------------------------
-- Test runner
-- ----------------------------------------------------------------------------

create temp table results (name text, passed boolean, detail text);

-- `set role authenticated` obosthay o test runner ke likhte dite hobe
grant insert, select on results to public;

create or replace function t_blocked(test_name text, sql_text text) returns void
language plpgsql as $$
begin
  execute sql_text;
  insert into results values (test_name, false, 'NOT blocked — statement succeeded');
exception when others then
  insert into results values (test_name, true, sqlerrm);
end $$;

create or replace function t_allowed(test_name text, sql_text text) returns void
language plpgsql as $$
begin
  execute sql_text;
  insert into results values (test_name, true, 'ok');
exception when others then
  insert into results values (test_name, false, 'OVER-BLOCKED: ' || sqlerrm);
end $$;

create or replace function t_count(test_name text, sql_text text, expected int) returns void
language plpgsql as $$
declare n int;
begin
  execute sql_text into n;
  insert into results values (test_name, n = expected,
    format('got %s, expected %s', n, expected));
exception when others then
  insert into results values (test_name, false, 'ERROR: ' || sqlerrm);
end $$;


-- ============================================================================
--  A. TENANT ISOLATION
-- ============================================================================

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';   -- Alpha owner

select t_count('A1 alpha sees only own leads',
  $$select count(*) from leads where name like '%Lead'$$, 1);

select t_count('A2 alpha cannot see beta lead',
  $$select count(*) from leads where name = 'Beta Lead'$$, 0);

select t_count('A3 alpha sees only own org',
  $$select count(*) from organizations where slug like 'zz-test-%'$$, 1);

select t_count('A4 nobody can read secrets from the browser',
  $$select count(*) from org_secrets$$, 0);

select t_blocked('A5 alpha cannot insert into beta org',
  $$insert into leads (org_id, name, source, channel_uid)
    values ((select id from organizations where slug='zz-test-beta'),
            'HACK','whatsapp','zz-hack-1')$$);

select t_blocked('A6 alpha cannot move a lead to beta',
  $$update leads set org_id=(select id from organizations where slug='zz-test-beta')
    where name='Alpha Lead'$$);

select t_count('A7 alpha cannot suspend beta',
  $$with u as (update organizations set status='suspended'
      where slug='zz-test-beta' returning 1) select count(*) from u$$, 0);

reset role;

-- ============================================================================
--  B. PRIVILEGE ESCALATION
-- ============================================================================

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';   -- Alpha AGENT

select t_blocked('B1 agent cannot become superadmin',
  $$update profiles set is_superadmin=true where id=auth.uid()$$);

select t_blocked('B2 agent cannot become owner',
  $$update profiles set role='owner' where id=auth.uid()$$);

select t_blocked('B3 agent cannot jump workspace',
  $$update profiles set org_id=(select id from organizations where slug='zz-test-beta')
    where id=auth.uid()$$);

select t_count('B4 agent cannot write org settings',
  $$with u as (update org_settings set auto_reply_text='HACKED-BY-AGENT'
      where org_id = current_org_id() returning 1)
    select count(*) from u$$, 0);

select t_count('B5 agent cannot read access token',
  $$select count(*) from org_secrets$$, 0);

select t_allowed('B6 agent CAN update a lead status',
  $$update leads set status='contacted' where name='Alpha Lead'$$);

reset role;

-- ============================================================================
--  C. BILLING INTEGRITY
-- ============================================================================

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';   -- Alpha owner

select t_blocked('C1 client cannot mark own invoice paid',
  $$update invoices set status='paid' where invoice_no='ZZ-TEST-INV-001'$$);

select t_blocked('C2 client cannot change invoice amount',
  $$update invoices set amount=1 where invoice_no='ZZ-TEST-INV-001'$$);

select t_blocked('C3 client cannot change due date',
  $$update invoices set due_date=current_date+365 where invoice_no='ZZ-TEST-INV-001'$$);

select t_blocked('C4 client cannot create an invoice',
  $$insert into invoices (org_id, invoice_no, amount, status)
    values (current_org_id(),'ZZ-FAKE-001',1,'paid')$$);

select t_allowed('C5 client CAN submit a payment reference',
  $$update invoices set status='submitted', txn_ref='TEST123',
      payment_method='bkash', submitted_at=now()
    where invoice_no='ZZ-TEST-INV-001'$$);

select t_count('C6 invoice amount is unchanged',
  $$select amount::int from invoices where invoice_no='ZZ-TEST-INV-001'$$, 9999);

reset role;

-- ============================================================================
--  D. AUDIT TRAIL
-- ============================================================================

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';

select t_allowed('D1 client can write to the audit log',
  $$insert into activity_log (org_id, actor, action, entity)
    values (current_org_id(), auth.uid(), 'zz_test', 'lead')$$);

select t_count('D2 client cannot delete audit entries',
  $$with d as (delete from activity_log where action='zz_test' returning 1)
    select count(*) from d$$, 0);

select t_count('D3 client cannot edit audit entries',
  $$with u as (update activity_log set action='tampered'
      where action='zz_test' returning 1) select count(*) from u$$, 0);

reset role;

-- ============================================================================
--  RESULTS
-- ============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
select
  case when passed then '✅' else '❌' end as ok,
  name as test,
  case when passed then '' else detail end as detail
from results order by name;

\echo ''
select
  count(*) filter (where passed)     as passed,
  count(*) filter (where not passed) as failed,
  case when count(*) filter (where not passed) = 0
       then '✅ ALL CLEAR — safe to deploy'
       else '❌ DO NOT DEPLOY' end   as verdict
from results;
\echo '════════════════════════════════════════════════════════════'

-- Test data muche felo
rollback;
