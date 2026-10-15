-- ─────────────────────────────────────────────────────────────────────────
-- Phase 18 — external integrations framework. Runs after Phase 17.
-- Fixtures: Tenant A (owner, printer and WhatsApp connections), Tenant B for isolation,
-- and a cashier who has no settings permission. Every action goes through the same
-- RPCs the app uses, with the actor passed explicitly.
-- ─────────────────────────────────────────────────────────────────────────

create temp table if not exists p18_refs (k text primary key, v text);

create or replace function pg_temp.ref(p_key text) returns uuid
language sql stable as $$
  select v::uuid from p18_refs where k = p_key;
$$;

-- True when the statement fails and the error contains the fragment.
create or replace function pg_temp.expect_err(p_sql text, p_fragment text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return position(p_fragment in sqlerrm) > 0;
end $$;

create or replace function pg_temp.job_status(p_job uuid) returns text
language sql stable as $$
  select status from public.integration_jobs where id = p_job;
$$;

\echo '── P18.0: fixtures (tenant connections, one live with credentials, one demo printer)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid;
  v_wa uuid;
  v_printer uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  insert into p18_refs values ('biz', v_biz::text), ('owner', v_owner::text), ('main', v_main::text);

  -- Live WhatsApp with credentials: not yet tested, so it must not send.
  v_wa := public.integration_account_save(
    v_owner, v_biz, null, 'whatsapp', 'live', false,
    '{"api_version":"v21.0","phone_number_id":"100000000000001"}'::jsonb,
    '{"access_token":"ends wxyz"}'::jsonb,
    'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAA==');
  insert into p18_refs values ('wa', v_wa::text);

  -- Demo printer for the outlet: no credentials, untested.
  v_printer := public.integration_account_save(
    v_owner, v_biz, v_main, 'printer', 'demo', false,
    '{"paper_width_chars":32}'::jsonb, '{}'::jsonb, null);
  insert into p18_refs values ('printer', v_printer::text);

  raise notice 'OK: P18 fixtures ready: live WhatsApp with credentials starts untested; demo printer starts untested and disabled';
end $$;

\echo '── P18.1: provider rules, settings validation and tenant scope'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
  v_other_main uuid;
begin
  -- Swiggy and Zomato have no public API: live is refused (function message and table constraint).
  if not pg_temp.expect_err(format('select public.integration_account_save(%L,%L,null,%L,%L,false,%L,%L,null)',
       v_owner, v_biz, 'swiggy', 'live', '{}', '{}'), 'Live access for this provider needs partner onboarding') then
    raise exception 'FAIL: Swiggy live was accepted';
  end if;
  if not pg_temp.expect_err(format('select public.integration_account_save(%L,%L,null,%L,%L,false,%L,%L,null)',
       v_owner, v_biz, 'zomato', 'live', '{}', '{}'), 'Live access for this provider needs partner onboarding') then
    raise exception 'FAIL: Zomato live was accepted';
  end if;
  if not pg_temp.expect_err(
       'insert into public.integration_accounts (business_id, provider, mode) values (''cccccccc-0000-0000-0000-000000000001'', ''swiggy'', ''live'')',
       'integration_accounts_live_only_where_available') then
    raise exception 'FAIL: table constraint did not block Swiggy live';
  end if;

  if not pg_temp.expect_err(format('select public.integration_account_save(%L,%L,null,%L,%L,false,%L,%L,null)',
       v_owner, v_biz, 'bogus', 'demo', '{}', '{}'), 'Unknown integration') then
    raise exception 'FAIL: unknown provider accepted';
  end if;

  -- Credential-looking keys are refused in settings.
  if not pg_temp.expect_err(format('select public.integration_account_save(%L,%L,null,%L,%L,false,%L,%L,null)',
       v_owner, v_biz, 'sms', 'demo', '{"api_key":"abc"}', '{}'), 'Credentials must be entered in the credentials fields') then
    raise exception 'FAIL: credential key accepted in settings';
  end if;
  if not pg_temp.expect_err(format('select public.integration_account_save(%L,%L,null,%L,%L,false,%L,%L,null)',
       v_owner, v_biz, 'sms', 'demo', '[]', '{}'), 'Settings are invalid') then
    raise exception 'FAIL: non-object settings accepted';
  end if;

  -- An outlet from another tenant cannot be attached.
  select o.id into v_other_main from public.outlets o where o.business_id = 'dddddddd-0000-0000-0000-000000000002' and o.slug = 'main';
  if not pg_temp.expect_err(format('select public.integration_account_save(%L,%L,%L,%L,%L,false,%L,%L,null)',
       v_owner, v_biz, v_other_main, 'printer', 'demo', '{}', '{}'), 'Outlet not found') then
    raise exception 'FAIL: foreign outlet attached to a connection';
  end if;

  -- Scope is unique per provider and outlet.
  if not pg_temp.expect_err(
       format('insert into public.integration_accounts (business_id, outlet_id, provider, mode) values (%L,%L,%L,%L)',
         v_biz, pg_temp.ref('main'), 'printer', 'demo'),
       'duplicate key') then
    raise exception 'FAIL: duplicate printer scope accepted';
  end if;

  -- Saving cannot switch on a connection that has not passed its test.
  perform public.integration_account_save(v_owner, v_biz, null, 'sms', 'demo', true, '{}'::jsonb, '{}'::jsonb, null);
  if (select enabled from public.integration_accounts where business_id = v_biz and provider = 'sms') then
    raise exception 'FAIL: save switched on an untested connection';
  end if;

  -- A demo Swiggy connection is allowed and saving again updates the same row.
  perform public.integration_account_save(v_owner, v_biz, null, 'swiggy', 'demo', false, '{"outlet_code":"DEMO-1"}'::jsonb, '{}'::jsonb, null);
  if (select count(*) from public.integration_accounts where business_id = v_biz and provider = 'swiggy') <> 1 then
    raise exception 'FAIL: saving twice created two Swiggy connections';
  end if;

  raise notice 'OK: Swiggy and Zomato live are refused by function and table; credential-looking settings, non-object settings, unknown providers and foreign outlets are refused; scope is unique; demo Swiggy saves once';
end $$;

\echo '── P18.2: permissions — settings managers only, no cross-tenant access, anonymous refused'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_tenant_b_owner uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_printer uuid := pg_temp.ref('printer');
begin
  if not pg_temp.expect_err(format('select public.integration_account_save(%L,%L,null,%L,%L,false,%L,%L,null)',
       v_cashier, v_biz, 'sms', 'demo', '{}', '{}'), 'do not have permission') then
    raise exception 'FAIL: cashier could save an integration';
  end if;
  if not pg_temp.expect_err(format('select public.integration_account_set_enabled(%L,%L,%L,true)',
       v_cashier, v_biz, v_printer), 'do not have permission') then
    raise exception 'FAIL: cashier could toggle an integration';
  end if;
  if not pg_temp.expect_err(format('select public.integration_test_result(%L,%L,%L,true,null,null,1)',
       v_cashier, v_biz, v_printer), 'do not have permission') then
    raise exception 'FAIL: cashier could record a test result';
  end if;
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_cashier, v_biz, v_printer, 'print.document', 'cashier-key-0001', '{}'), 'do not have permission') then
    raise exception 'FAIL: cashier could queue a job';
  end if;
  if not pg_temp.expect_err(format('select public.integration_account_save(%L,%L,null,%L,%L,false,%L,%L,null)',
       v_tenant_b_owner, v_biz, 'sms', 'demo', '{}', '{}'), 'do not have permission') then
    raise exception 'FAIL: another tenant''s owner could change this tenant';
  end if;
  if not pg_temp.expect_err(format('select public.integration_account_save(null,%L,null,%L,%L,false,%L,%L,null)',
       v_biz, 'sms', 'demo', '{}', '{}'), 'Sign-in required') then
    raise exception 'FAIL: anonymous call accepted';
  end if;
  raise notice 'OK: only owners and managers of the tenant can save, toggle, test or queue; cashiers, other tenants and anonymous callers are refused';
end $$;

\echo '── P18.3: enqueue gate — no send before a passing test; idempotent per key; allow-listed operations'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
  v_printer uuid := pg_temp.ref('printer');
  v_wa uuid := pg_temp.ref('wa');
  v_job uuid;
  v_again uuid;
  n int;
begin
  -- Untested printer refuses work.
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_printer, 'print.document', 'print-test-0001', '{"lines":["hi"]}'), 'Test the connection before sending') then
    raise exception 'FAIL: untested printer accepted a job';
  end if;

  -- Live WhatsApp with credentials is still untested, so it refuses work and cannot be enabled.
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_wa, 'message.send', 'wa-key-0000001', '{"to":"919000000000","body":"hi"}'), 'Test the connection before sending') then
    raise exception 'FAIL: untested WhatsApp accepted a message';
  end if;
  if not pg_temp.expect_err(format('select public.integration_account_set_enabled(%L,%L,%L,true)', v_owner, v_biz, v_wa),
       'Test the connection before turning') then
    raise exception 'FAIL: untested WhatsApp could be enabled';
  end if;

  -- A passing test connects the printer; then it can be enabled and used.
  perform public.integration_test_result(v_owner, v_biz, v_printer, true, null, null, 12);
  perform public.integration_account_set_enabled(v_owner, v_biz, v_printer, true);

  v_job := public.integration_enqueue(v_owner, v_biz, v_printer, 'print.document', 'print-test-0001', '{"lines":["hi"]}'::jsonb);
  v_again := public.integration_enqueue(v_owner, v_biz, v_printer, 'print.document', 'print-test-0001', '{"lines":["changed"]}'::jsonb);
  if v_job is null or v_job <> v_again then
    raise exception 'FAIL: same idempotency key produced a second job';
  end if;
  select count(*) into n from public.integration_jobs where account_id = v_printer and idempotency_key = 'print-test-0001';
  if n <> 1 then
    raise exception 'FAIL: idempotency key stored % rows', n;
  end if;
  insert into p18_refs values ('job_a', v_job::text);

  -- Operations are allow-listed per provider.
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_printer, 'message.send', 'print-key-0002', '{}'), 'not available for this integration') then
    raise exception 'FAIL: printer accepted a messaging operation';
  end if;
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_printer, 'print.document', 'short', '{}'), 'request key is invalid') then
    raise exception 'FAIL: short request key accepted';
  end if;
  if not public.integration_operation_allowed('razorpay', 'payment.create_link')
     or public.integration_operation_allowed('swiggy', 'message.send')
     or public.integration_operation_allowed('printer', 'payment.create_link') then
    raise exception 'FAIL: operation allow-list is wrong';
  end if;

  raise notice 'OK: nothing is sent before a passing test; a live connection with credentials still needs a test; the same key returns the same job; operations are allow-listed per provider';
end $$;

\echo '── P18.4: worker claim — lease, backoff schedule, exhaustion and error log'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_printer uuid := pg_temp.ref('printer');
  v_job uuid := pg_temp.ref('job_a');
  v_claim jsonb;
  v_next timestamptz;
  v_delay_s numeric;
  v_attempt integer;
  n int;
begin
  -- First claim takes the job; a second claim sees nothing (the lease holds it).
  v_claim := public.integration_job_claim(10, 120, v_biz);
  if jsonb_array_length(v_claim) <> 1 or (v_claim -> 0 ->> 'job_id')::uuid <> v_job or (v_claim -> 0 ->> 'attempt_no')::int <> 1 then
    raise exception 'FAIL: first claim did not return the queued job at attempt 1: %', v_claim;
  end if;
  if pg_temp.job_status(v_job) <> 'running' then
    raise exception 'FAIL: claimed job is not running';
  end if;
  if jsonb_array_length(public.integration_job_claim(10, 120, v_biz)) <> 0 then
    raise exception 'FAIL: a leased job was claimed twice';
  end if;

  -- Retryable failure: next attempt scheduled with 60 s backoff; not due yet, so not claimable.
  perform public.integration_job_finish(v_job, 'retry', 'timeout', 'Provider timed out.', null, null, 800, null);
  select next_attempt_at into v_next from public.integration_jobs where id = v_job;
  v_delay_s := extract(epoch from (v_next - now()));
  if v_delay_s not between 50 and 70 then
    raise exception 'FAIL: first backoff was % seconds, expected about 60', v_delay_s;
  end if;
  if jsonb_array_length(public.integration_job_claim(10, 120, v_biz)) <> 0 then
    raise exception 'FAIL: a job was claimed before its retry time';
  end if;

  -- Walk the schedule: 2nd try (120 s), 3rd (240 s), 4th (480 s), then the 5th try is the last.
  for v_attempt in 2..4 loop
    update public.integration_jobs set next_attempt_at = now() where id = v_job;   -- make it due
    v_claim := public.integration_job_claim(10, 120, v_biz);
    if (v_claim -> 0 ->> 'attempt_no')::int <> v_attempt then
      raise exception 'FAIL: expected attempt %, got %', v_attempt, v_claim -> 0 ->> 'attempt_no';
    end if;
    perform public.integration_job_finish(v_job, 'retry', 'timeout', 'Provider timed out.', null, null, 800, null);
    select next_attempt_at into v_next from public.integration_jobs where id = v_job;
    v_delay_s := extract(epoch from (v_next - now()));
    if v_delay_s not between (60 * power(2, v_attempt - 1)) - 10 and (60 * power(2, v_attempt - 1)) + 10 then
      raise exception 'FAIL: backoff after attempt % was % seconds', v_attempt, v_delay_s;
    end if;
  end loop;

  update public.integration_jobs set next_attempt_at = now() where id = v_job;
  v_claim := public.integration_job_claim(10, 120, v_biz);
  if (v_claim -> 0 ->> 'attempt_no')::int <> 5 then
    raise exception 'FAIL: expected the fifth attempt';
  end if;
  perform public.integration_job_finish(v_job, 'retry', 'timeout', 'Provider timed out.', null, null, 800, null);
  if pg_temp.job_status(v_job) <> 'dead' then
    raise exception 'FAIL: job was not dead after its fifth failure';
  end if;

  -- One log row per attempt, numbered 1–5, the last one marked exhausted.
  select count(*) into n from public.integration_logs where job_id = v_job;
  if n <> 5 then raise exception 'FAIL: expected 5 log rows, found %', n; end if;
  if (select outcome from public.integration_logs where job_id = v_job and attempt_no = 5) <> 'exhausted' then
    raise exception 'FAIL: final attempt not logged as exhausted';
  end if;
  if (select outcome from public.integration_logs where job_id = v_job and attempt_no = 1) <> 'retry_scheduled' then
    raise exception 'FAIL: first attempt not logged as retry_scheduled';
  end if;

  -- Finishing a job that is no longer running does nothing.
  if public.integration_job_finish(v_job, 'succeeded', null, null, '{}'::jsonb, null, 1, null) <> 'ignored' then
    raise exception 'FAIL: finish on a dead job was not ignored';
  end if;

  raise notice 'OK: the lease stops a double claim; backoff runs 1, 2, 4, 8 minutes; the fifth failure is exhausted and dead; each attempt is logged with its number; a finished job cannot be finished again';
end $$;

\echo '── P18.5: fatal failure flips the connection to error and blocks new work'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
  v_printer uuid := pg_temp.ref('printer');
  v_job uuid;
  v_claim jsonb;
  v_status text;
begin
  v_job := public.integration_enqueue(v_owner, v_biz, v_printer, 'print.document', 'print-test-0002', '{"lines":["two"]}'::jsonb);
  v_claim := public.integration_job_claim(10, 120, v_biz);
  if (v_claim -> 0 ->> 'job_id')::uuid <> v_job then
    raise exception 'FAIL: second job was not claimed';
  end if;
  perform public.integration_job_finish(v_job, 'failed', 'auth', 'Credentials were rejected.', null, null, 40, 'error');

  if pg_temp.job_status(v_job) <> 'dead' then raise exception 'FAIL: fatal job not dead'; end if;
  select status into v_status from public.integration_accounts where id = v_printer;
  if v_status <> 'error' then raise exception 'FAIL: account status after fatal auth error was %', v_status; end if;
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_printer, 'print.document', 'print-test-0003', '{}'), 'Test the connection before sending') then
    raise exception 'FAIL: a connection in error still accepted work';
  end if;
  if (select outcome from public.integration_logs where job_id = v_job) <> 'failed' then
    raise exception 'FAIL: fatal failure not logged as failed';
  end if;

  raise notice 'OK: a fatal failure kills the job, logs it, marks the connection error, and refuses new work until a test passes';
end $$;

\echo '── P18.6: retry a dead job (settings managers only), then succeed and reconnect'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_printer uuid := pg_temp.ref('printer');
  v_job uuid;
  v_claim jsonb;
  v_max integer;
  v_status text;
begin
  select id into v_job from public.integration_jobs where account_id = v_printer and idempotency_key = 'print-test-0002';

  if not pg_temp.expect_err(format('select public.integration_job_retry(%L,%L,%L)', v_cashier, v_biz, v_job), 'do not have permission') then
    raise exception 'FAIL: cashier could retry a job';
  end if;

  -- The printer is in error, so the owner re-tests first. The test passes and reconnects it.
  perform public.integration_test_result(v_owner, v_biz, v_printer, true, null, null, 9);
  if (select status from public.integration_accounts where id = v_printer) <> 'connected' then
    raise exception 'FAIL: passing test did not reconnect the printer';
  end if;

  perform public.integration_job_retry(v_owner, v_biz, v_job);
  select max_attempts into v_max from public.integration_jobs where id = v_job;
  if pg_temp.job_status(v_job) <> 'pending' or v_max <> 4 then
    raise exception 'FAIL: retry did not requeue with three more tries (max=%)', v_max;
  end if;
  if not pg_temp.expect_err(format('select public.integration_job_retry(%L,%L,%L)', v_owner, v_biz, v_job), 'Only failed jobs can be retried') then
    raise exception 'FAIL: a pending job could be retried';
  end if;

  update public.integration_jobs set next_attempt_at = now() where id = v_job;
  v_claim := public.integration_job_claim(10, 120, v_biz);
  perform public.integration_job_finish(v_job, 'succeeded', null, null, '{"simulated":false,"provider_ref":"msg_1"}'::jsonb, null, 300, null);
  if pg_temp.job_status(v_job) <> 'succeeded' then raise exception 'FAIL: retried job did not succeed'; end if;
  if (select last_success_at from public.integration_accounts where id = v_printer) is null then
    raise exception 'FAIL: success did not record last_success_at';
  end if;
  if (select outcome from public.integration_logs where job_id = v_job and attempt_no = (v_claim -> 0 ->> 'attempt_no')::int) <> 'succeeded' then
    raise exception 'FAIL: the successful retry is not in the log';
  end if;
  select status into v_status from public.integration_accounts where id = v_printer;
  if v_status <> 'connected' then raise exception 'FAIL: success left the connection in %', v_status; end if;

  raise notice 'OK: a dead job can be retried by a settings manager only; the retry gets three more tries and the success is logged';
end $$;

\echo '── P18.7: lease recovery — a crashed worker''s job is reclaimed, or dead when out of tries'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
  v_printer uuid := pg_temp.ref('printer');
  v_job uuid;
  v_claim jsonb;
begin
  v_job := public.integration_enqueue(v_owner, v_biz, v_printer, 'print.document', 'print-test-0004', '{"lines":["lease"]}'::jsonb);
  v_claim := public.integration_job_claim(10, 120, v_biz);
  -- Simulate a worker that died: the lease has expired.
  update public.integration_jobs set locked_until = now() - interval '1 second' where id = v_job;
  v_claim := public.integration_job_claim(10, 120, v_biz);
  if (v_claim -> 0 ->> 'job_id')::uuid <> v_job or (v_claim -> 0 ->> 'attempt_no')::int <> 2 then
    raise exception 'FAIL: expired lease was not reclaimed as attempt 2';
  end if;

  -- Expired lease with no tries left: the job is dead, not run again.
  update public.integration_jobs set locked_until = now() - interval '1 second', attempts = max_attempts where id = v_job;
  v_claim := public.integration_job_claim(10, 120, v_biz);
  if jsonb_array_length(v_claim) <> 0 then raise exception 'FAIL: out-of-tries job was run again'; end if;
  if pg_temp.job_status(v_job) <> 'dead' then raise exception 'FAIL: out-of-tries job not dead'; end if;
  if (select last_error_code from public.integration_jobs where id = v_job) <> 'lease_expired' then
    raise exception 'FAIL: dead job did not record the lease expiry';
  end if;

  if not pg_temp.expect_err(format('select public.integration_job_claim(%s, 120, null)', 0), 'Claim limit must be between 1 and 50') then
    raise exception 'FAIL: zero claim limit accepted';
  end if;
  if not pg_temp.expect_err(format('select public.integration_job_claim(%s, 5, null)', 5), 'Lease must be between 30 and 900') then
    raise exception 'FAIL: five second lease accepted';
  end if;

  raise notice 'OK: an expired lease is reclaimed as the next attempt; a job out of tries is marked dead instead of being run again; claim limits are enforced';
end $$;

\echo '── P18.8: inbound webhooks — claimed once, replays harmless, altered payloads flagged'
do $$
declare
  v_wa uuid := pg_temp.ref('wa');
  v_r text;
  v_mode text;
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
begin
  v_r := public.integration_webhook_claim(v_wa, 'wamid.TEST0001', 'messages', repeat('a', 64), '{"kind":"message"}'::jsonb);
  if v_r <> 'new' then raise exception 'FAIL: first delivery was %', v_r; end if;
  v_r := public.integration_webhook_claim(v_wa, 'wamid.TEST0001', 'messages', repeat('a', 64), '{}'::jsonb);
  if v_r <> 'duplicate' then raise exception 'FAIL: replay was %', v_r; end if;
  v_r := public.integration_webhook_claim(v_wa, 'wamid.TEST0001', 'messages', repeat('b', 64), '{}'::jsonb);
  if v_r <> 'mismatch' then raise exception 'FAIL: altered payload was %', v_r; end if;

  if not pg_temp.expect_err(format('select public.integration_webhook_claim(%L,%L,%L,%L,%L)', v_wa, 'evt-2', 'x', 'not-a-digest', '{}'), 'Payload digest is invalid') then
    raise exception 'FAIL: malformed digest accepted';
  end if;
  if not pg_temp.expect_err(format('select public.integration_webhook_claim(%L,%L,%L,%L,%L)', '11111111-2222-4333-8444-555555555555', 'evt-3', 'x', repeat('c', 64), '{}'), 'Integration not found') then
    raise exception 'FAIL: unknown account accepted a webhook';
  end if;

  select mode into v_mode from public.webhook_events where account_id = v_wa and event_id = 'wamid.TEST0001';
  if v_mode <> 'live' then raise exception 'FAIL: receipt mode was %', v_mode; end if;
  if (select count(*) from public.webhook_events where account_id = v_wa and event_id = 'wamid.TEST0001') <> 1 then
    raise exception 'FAIL: webhook event stored more than once';
  end if;

  raise notice 'OK: webhook receipts are claimed once; replays are duplicates; altered payloads under the same id are mismatches; malformed digests and unknown accounts are refused';
end $$;

\echo '── P18.9: connection tests — a failed test turns the integration off'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
  v_printer uuid := pg_temp.ref('printer');
  v_enabled boolean;
  v_status text;
begin
  perform public.integration_test_result(v_owner, v_biz, v_printer, false, 'auth', 'Printer did not answer.', 5000);
  select enabled, status into v_enabled, v_status from public.integration_accounts where id = v_printer;
  if v_enabled or v_status <> 'error' then
    raise exception 'FAIL: failed test left enabled=% status=%', v_enabled, v_status;
  end if;
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_printer, 'print.document', 'print-test-0005', '{}'), 'Test the connection before sending') then
    raise exception 'FAIL: disabled integration accepted work';
  end if;

  perform public.integration_test_result(v_owner, v_biz, v_printer, true, null, null, 20);
  perform public.integration_account_set_enabled(v_owner, v_biz, v_printer, true);
  perform public.integration_account_set_enabled(v_owner, v_biz, v_printer, false);
  select enabled into v_enabled from public.integration_accounts where id = v_printer;
  if v_enabled then raise exception 'FAIL: disable did not stick'; end if;
  if (select count(*) from public.integration_logs where account_id = v_printer and operation = 'connection.test') < 3 then
    raise exception 'FAIL: connection tests are not all logged';
  end if;

  raise notice 'OK: a failed connection test disables the integration and logs the failure; a passing test reconnects it; enable and disable are audited';
end $$;

\echo '── P18.10: grants, RLS and secrets — no client role can read or write integration data'
do $$
declare
  v_t text;
  v_f text;
  v_tables text[] := array['integration_accounts', 'integration_secrets', 'integration_jobs', 'integration_logs', 'webhook_events', 'integration_agents'];
  v_fns text[] := array[
    'integration_account_save(uuid, uuid, uuid, text, text, boolean, jsonb, jsonb, text)',
    'integration_account_set_enabled(uuid, uuid, uuid, boolean)',
    'integration_test_result(uuid, uuid, uuid, boolean, text, text, integer)',
    'integration_enqueue(uuid, uuid, uuid, text, text, jsonb)',
    'integration_job_claim(integer, integer, uuid)',
    'integration_job_finish(uuid, text, text, text, jsonb, integer, integer, text)',
    'integration_job_retry(uuid, uuid, uuid)',
    'integration_webhook_claim(uuid, text, text, text, jsonb)',
    'integration_runtime_load(uuid)',
    'integration_panel_load(uuid, uuid)',
    'integration_agent_register(uuid, uuid, uuid, text, text)',
    'integration_agent_revoke(uuid, uuid, uuid)',
    'integration_agent_claim(text, integer, integer)',
    'integration_agent_report(text, uuid, text, text, text, integer)'];
  v_rls boolean;
begin
  foreach v_t in array v_tables loop
    select relrowsecurity into v_rls from pg_class where oid = ('public.' || v_t)::regclass;
    if not v_rls then raise exception 'FAIL: RLS is off on %', v_t; end if;
    if has_table_privilege('authenticated', 'public.' || v_t, 'select')
       or has_table_privilege('authenticated', 'public.' || v_t, 'insert')
       or has_table_privilege('anon', 'public.' || v_t, 'select') then
      raise exception 'FAIL: a client role can reach %', v_t;
    end if;
  end loop;

  foreach v_f in array v_fns loop
    if has_function_privilege('authenticated', 'public.' || v_f, 'execute')
       or has_function_privilege('anon', 'public.' || v_f, 'execute') then
      raise exception 'FAIL: a client role can execute %', v_f;
    end if;
    if not has_function_privilege('service_role', 'public.' || v_f, 'execute') then
      raise exception 'FAIL: service role cannot execute %', v_f;
    end if;
  end loop;

  -- The runtime loader returns ciphertext only for an account that has credentials.
  if public.integration_runtime_load(pg_temp.ref('wa')) ->> 'ciphertext' not like 'v1:%' then
    raise exception 'FAIL: runtime load did not return the stored ciphertext';
  end if;
  if public.integration_runtime_load(pg_temp.ref('printer')) ->> 'ciphertext' is not null then
    raise exception 'FAIL: runtime load returned ciphertext for an account with none';
  end if;
  if not pg_temp.expect_err(format('select public.integration_runtime_load(%L)', '11111111-2222-4333-8444-555555555555'), 'Integration not found') then
    raise exception 'FAIL: runtime load accepted an unknown account';
  end if;

  -- The settings panel is permission-checked in the database and never returns ciphertext.
  if not pg_temp.expect_err(format('select public.integration_panel_load(%L,%L)', 'f1111111-0000-0000-0000-000000000010', pg_temp.ref('biz')), 'do not have permission') then
    raise exception 'FAIL: cashier could read the integration panel';
  end if;
  if jsonb_array_length(public.integration_panel_load(pg_temp.ref('owner'), pg_temp.ref('biz')) -> 'accounts') < 3 then
    raise exception 'FAIL: owner panel is missing connections';
  end if;
  if public.integration_panel_load(pg_temp.ref('owner'), pg_temp.ref('biz'))::text like '%v1:%' then
    raise exception 'FAIL: panel returned ciphertext';
  end if;

  -- The stored credential is ciphertext, and no audit row or setting holds any part of it.
  if (select count(*) from public.audit_logs where after_state::text like '%AAAAAAAAAAAAAAAA%'
       or before_state::text like '%AAAAAAAAAAAAAAAA%' or metadata::text like '%AAAAAAAAAAAAAAAA%') <> 0 then
    raise exception 'FAIL: ciphertext leaked into the audit trail';
  end if;
  if (select count(*) from public.integration_accounts where config::text ~* '(secret|token|password|api_key)') <> 0 then
    raise exception 'FAIL: a credential-looking key is stored in settings';
  end if;

  raise notice 'OK: integration tables are RLS-protected with no client grants; every integration RPC is service-only; the credential ciphertext never reaches the audit trail or settings';
end $$;

\echo '── P18.11: audit trail covers configuration, credentials, enablement and retries'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_action text;
  v_missing text := '';
begin
  foreach v_action in array array['integration.saved', 'integration.credentials_saved', 'integration.enabled', 'integration.disabled', 'integration.job_retried'] loop
    if not exists (select 1 from public.audit_logs where business_id = v_biz and action = v_action) then
      v_missing := v_missing || ' ' || v_action;
    end if;
  end loop;
  if v_missing <> '' then raise exception 'FAIL: audit rows missing for:%', v_missing; end if;

  raise notice 'OK: saving settings, storing credentials, enabling, disabling and retrying are all audited, with no credential values in the trail';
end $$;

\echo '── P18.12: print agents — outlet-scoped, token-hashed, live printers run through the agent'
do $$
declare
  v_biz uuid := pg_temp.ref('biz');
  v_owner uuid := pg_temp.ref('owner');
  v_main uuid := pg_temp.ref('main');
  v_printer uuid := pg_temp.ref('printer');
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_owner_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_outlet_b uuid;
  v_tok_a text := 'ragt_' || repeat('A', 43);
  v_tok_b text := 'ragt_' || repeat('B', 43);
  v_tok_c text := 'ragt_' || repeat('C', 43);
  v_agent_a uuid;
  v_agent_b uuid;
  v_agent_c uuid;
  v_job_test uuid;
  v_job_print uuid;
  v_claim jsonb;
  v_status text;
begin
  select id into v_outlet_b from public.outlets where business_id = v_biz_b order by created_at limit 1;

  -- A cashier and a foreign owner cannot register or revoke agents.
  if not pg_temp.expect_err(format('select public.integration_agent_register(%L,%L,%L,%L,%L)',
       'f1111111-0000-0000-0000-000000000010', v_biz, v_main, 'Kitchen', encode(sha256(convert_to(v_tok_a,'UTF8')),'hex')),
       'do not have permission') then
    raise exception 'FAIL: cashier registered a print agent';
  end if;
  if not pg_temp.expect_err(format('select public.integration_agent_register(%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_outlet_b, 'Wrong outlet', encode(sha256(convert_to(v_tok_a,'UTF8')),'hex')),
       'Outlet not found') then
    raise exception 'FAIL: an agent was registered for another tenant''s outlet';
  end if;
  if not pg_temp.expect_err(format('select public.integration_agent_register(%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_main, 'Bad hash', 'not-a-hash'), 'token is invalid') then
    raise exception 'FAIL: a malformed token hash was accepted';
  end if;

  -- Register agents: A and B for the main outlet, C for tenant B's outlet.
  v_agent_a := public.integration_agent_register(v_owner, v_biz, v_main, 'Kitchen PC', encode(sha256(convert_to(v_tok_a,'UTF8')),'hex'));
  v_agent_b := public.integration_agent_register(v_owner, v_biz, v_main, 'Counter PC', encode(sha256(convert_to(v_tok_b,'UTF8')),'hex'));
  v_agent_c := public.integration_agent_register(v_owner_b, v_biz_b, v_outlet_b, 'Other tenant PC', encode(sha256(convert_to(v_tok_c,'UTF8')),'hex'));
  insert into p18_refs values ('agent_a', v_agent_a::text), ('agent_b', v_agent_b::text), ('agent_c', v_agent_c::text),
                              ('tok_a', v_tok_a), ('tok_b', v_tok_b), ('tok_c', v_tok_c);

  if (select count(*) from public.integration_agents where token_hash ~ '^[0-9a-f]{64}$') < 3 then
    raise exception 'FAIL: agents were not stored with a token hash';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'integration_agents'
             and column_name in ('token', 'token_plain', 'secret')) then
    raise exception 'FAIL: integration_agents has a column that could hold a plain token';
  end if;
  if public.integration_panel_load(v_owner, v_biz)::text like '%token_hash%' then
    raise exception 'FAIL: the panel exposed a token hash';
  end if;
  if jsonb_array_length(public.integration_panel_load(v_owner, v_biz) -> 'agents') < 2 then
    raise exception 'FAIL: the panel does not list the agents';
  end if;

  -- Live printer: the existing main-outlet printer switches to live. Live needs no credentials,
  -- so it starts untested and off, like any other connection.
  perform public.integration_account_save(v_owner, v_biz, v_main, 'printer', 'live', false,
    '{"host":"192.168.1.50","paper_width_chars":32}'::jsonb, '{}'::jsonb, null);
  select status into v_status from public.integration_accounts where id = v_printer;
  if v_status <> 'untested' or (select enabled from public.integration_accounts where id = v_printer) then
    raise exception 'FAIL: a live printer did not start untested and off (status %)', v_status;
  end if;

  -- Before a passing test, only the connection test may be queued for a live printer.
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_owner, v_biz, v_printer, 'print.document', 'untested-print-1', '{"lines":[{"text":"x"}]}'),
       'Test the connection before sending') then
    raise exception 'FAIL: an untested live printer accepted a print job';
  end if;
  if not pg_temp.expect_err(format('select public.integration_enqueue(%L,%L,%L,%L,%L,%L)',
       v_owner, v_biz, pg_temp.ref('wa'), 'connection.test', 'test-whatsapp-1', '{}'),
       'not available for this integration') then
    raise exception 'FAIL: a connection test was queued for a non-printer integration';
  end if;

  -- The test job runs on an agent, never on the server worker.
  v_job_test := public.integration_enqueue(v_owner, v_biz, v_printer, 'connection.test', 'test-live-printer-1', '{}'::jsonb);
  insert into p18_refs values ('job_test', v_job_test::text);
  if (select executor from public.integration_jobs where id = v_job_test) <> 'agent' then
    raise exception 'FAIL: a live printer job was not routed to the agent';
  end if;

  v_claim := public.integration_job_claim(10, 120, v_biz);
  if v_claim::text like '%' || v_job_test::text || '%' then
    raise exception 'FAIL: the server worker claimed an agent job';
  end if;

  -- Agents of other tenants see nothing. A wrong token is refused.
  if public.integration_agent_claim(encode(sha256(convert_to(v_tok_c,'UTF8')),'hex'), 10, 120)::text like '%' || v_job_test::text || '%' then
    raise exception 'FAIL: another tenant''s agent claimed this outlet''s job';
  end if;
  if not pg_temp.expect_err(format('select public.integration_agent_claim(%L,%s,%s)',
       encode(sha256(convert_to('ragt_' || repeat('Z', 43),'UTF8')),'hex'), 10, 120), 'Agent not recognised') then
    raise exception 'FAIL: an unknown token claimed jobs';
  end if;

  -- Agent B claims the job. Agent A cannot report on a job B holds.
  v_claim := public.integration_agent_claim(encode(sha256(convert_to(v_tok_b,'UTF8')),'hex'), 10, 120);
  if v_claim::text not like '%' || v_job_test::text || '%' then
    raise exception 'FAIL: the outlet agent did not receive the connection test';
  end if;
  if (select locked_by from public.integration_jobs where id = v_job_test) <> v_agent_b then
    raise exception 'FAIL: the job lease is not held by the claiming agent';
  end if;
  if not pg_temp.expect_err(format('select public.integration_agent_report(%L,%L,%L,%L,%L,%s)',
       encode(sha256(convert_to(v_tok_a,'UTF8')),'hex'), v_job_test, 'succeeded', null, null, 5),
       'not claimed by this agent') then
    raise exception 'FAIL: a different agent reported on a job it did not hold';
  end if;

  -- The holder reports success: the job succeeds, and the printer is connected and tested.
  perform public.integration_agent_report(encode(sha256(convert_to(v_tok_b,'UTF8')),'hex'), v_job_test, 'succeeded', null, null, 5);
  if pg_temp.job_status(v_job_test) <> 'succeeded' then
    raise exception 'FAIL: a successful connection test did not finish the job';
  end if;
  select status into v_status from public.integration_accounts where id = v_printer;
  if v_status <> 'connected' or (select last_tested_at from public.integration_accounts where id = v_printer) is null then
    raise exception 'FAIL: a passing agent test did not connect the printer (status %)', v_status;
  end if;

  -- Now the printer can be turned on, and a print job goes to the agent.
  perform public.integration_account_set_enabled(v_owner, v_biz, v_printer, true);
  v_job_print := public.integration_enqueue(v_owner, v_biz, v_printer, 'print.document', 'print-agent-1',
    '{"lines":[{"text":"Table 4","bold":true,"center":true}]}'::jsonb);
  insert into p18_refs values ('job_print', v_job_print::text);
  if (select executor from public.integration_jobs where id = v_job_print) <> 'agent' then
    raise exception 'FAIL: a live print job was not routed to the agent';
  end if;

  -- Agent A claims it and the printer rejects it as blocked: the job is dead and the account is in error.
  v_claim := public.integration_agent_claim(encode(sha256(convert_to(v_tok_a,'UTF8')),'hex'), 10, 120);
  if v_claim::text not like '%' || v_job_print::text || '%' or v_claim::text not like '%Table 4%' then
    raise exception 'FAIL: the agent did not receive the print job with its lines';
  end if;
  perform public.integration_agent_report(encode(sha256(convert_to(v_tok_a,'UTF8')),'hex'), v_job_print, 'failed', 'blocked_address', 'That printer address is a loopback address.', 3);
  if pg_temp.job_status(v_job_print) <> 'dead' then
    raise exception 'FAIL: a blocked print did not end the job';
  end if;
  select status into v_status from public.integration_accounts where id = v_printer;
  if v_status <> 'error' then
    raise exception 'FAIL: a blocked print did not mark the printer in error (status %)', v_status;
  end if;

  -- Revoking an agent stops its token at once, for claims and for reports.
  if not pg_temp.expect_err(format('select public.integration_agent_revoke(%L,%L,%L)',
       'f1111111-0000-0000-0000-000000000010', v_biz, v_agent_a), 'do not have permission') then
    raise exception 'FAIL: cashier revoked an agent';
  end if;
  if not pg_temp.expect_err(format('select public.integration_agent_revoke(%L,%L,%L)',
       v_owner_b, v_biz_b, v_agent_a), 'Agent not found') then
    raise exception 'FAIL: a foreign owner revoked an agent';
  end if;
  perform public.integration_agent_revoke(v_owner, v_biz, v_agent_a);
  perform public.integration_agent_revoke(v_owner, v_biz, v_agent_a); -- idempotent
  if not pg_temp.expect_err(format('select public.integration_agent_claim(%L,%s,%s)',
       encode(sha256(convert_to(v_tok_a,'UTF8')),'hex'), 10, 120), 'Agent not recognised') then
    raise exception 'FAIL: a revoked agent still claims jobs';
  end if;
  if not pg_temp.expect_err(format('select public.integration_agent_report(%L,%L,%L,%L,%L,%s)',
       encode(sha256(convert_to(v_tok_a,'UTF8')),'hex'), v_job_print, 'succeeded', null, null, 1),
       'Agent not recognised') then
    raise exception 'FAIL: a revoked agent still reports';
  end if;
  if (select revoked_at from public.integration_agents where id = v_agent_a) is null then
    raise exception 'FAIL: revocation was not recorded';
  end if;

  if (select count(*) from public.audit_logs where business_id = v_biz
       and action in ('integration.agent_registered', 'integration.agent_revoked')) < 3 then
    raise exception 'FAIL: agent registration and revocation are not audited';
  end if;

  raise notice 'OK: print agents are outlet-scoped and token-hashed; live printers test and print only through an agent; the server worker never claims agent jobs; a passing test connects the printer; revoked tokens stop at once';
end $$;
