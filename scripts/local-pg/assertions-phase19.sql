-- ─────────────────────────────────────────────────────────────────────────
-- Phase 19 — Super Admin, subscriptions, entitlements and support. Runs after Phase 18.
-- Fixtures: Tenant A (owner aaaa…01, outlet 'main'), Tenant B (owner bbbb…02, dddd…02),
-- cashier f111…10 (no settings permission). Operators are granted inside these tests.
-- Every privileged action goes through the same RPCs the app uses, with the actor passed.
-- ─────────────────────────────────────────────────────────────────────────

create temp table if not exists p19_refs (k text primary key, v text);

create or replace function pg_temp.p19(p_key text) returns uuid
language sql stable as $$
  select v::uuid from p19_refs where k = p_key;
$$;

-- True when the statement fails and the error contains the fragment.
create or replace function pg_temp.expect_err19(p_sql text, p_fragment text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return position(p_fragment in sqlerrm) > 0;
end $$;

\echo '── P19.0: every business has a subscription; a new business gets a 14-day GROWTH trial'
do $$
declare
  v_missing integer;
  v_new uuid;
  v_plan text;
  v_status text;
  v_days double precision;
begin
  select count(*) into v_missing
  from public.businesses b
  where not exists (select 1 from platform.business_subscriptions s where s.business_id = b.id);
  if v_missing <> 0 then
    raise exception 'P19.0 FAIL: % businesses have no subscription row', v_missing;
  end if;

  insert into public.businesses (name, slug)
  values ('P19 Trial Test', 'p19-trial-test')
  returning id into v_new;
  insert into p19_refs values ('trial_biz', v_new::text);

  select p.code, s.status, extract(epoch from (s.trial_ends_at - now())) / 86400
    into v_plan, v_status, v_days
  from platform.business_subscriptions s
  join platform.subscription_plans p on p.id = s.plan_id
  where s.business_id = v_new;

  if v_plan <> 'GROWTH' or v_status <> 'trial' or v_days not between 13.9 and 14.1 then
    raise exception 'P19.0 FAIL: new business got plan % status % trial days %', v_plan, v_status, v_days;
  end if;
  raise notice 'OK: a new business gets a 14-day GROWTH trial, and existing businesses have a subscription';
end $$;

\echo '── P19.1: the feature catalogue and plan limits match the agreed placeholders'
do $$
declare
  v_starter_online boolean;
  v_growth_online boolean;
  v_growth_outlets bigint;
  v_enterprise_outlets bigint;
begin
  select pf.included into v_starter_online
  from platform.plan_features pf join platform.subscription_plans p on p.id = pf.plan_id
  where p.code = 'STARTER' and pf.feature_key = 'online_ordering';
  select pf.included into v_growth_online
  from platform.plan_features pf join platform.subscription_plans p on p.id = pf.plan_id
  where p.code = 'GROWTH' and pf.feature_key = 'online_ordering';
  select pf.limit_value into v_growth_outlets
  from platform.plan_features pf join platform.subscription_plans p on p.id = pf.plan_id
  where p.code = 'GROWTH' and pf.feature_key = 'outlets';
  select pf.limit_value into v_enterprise_outlets
  from platform.plan_features pf join platform.subscription_plans p on p.id = pf.plan_id
  where p.code = 'ENTERPRISE' and pf.feature_key = 'outlets';

  if v_starter_online is not false or v_growth_online is not true then
    raise exception 'P19.1 FAIL: online ordering should be off for STARTER and on for GROWTH';
  end if;
  if v_growth_outlets <> 3 or v_enterprise_outlets is not null then
    raise exception 'P19.1 FAIL: GROWTH outlets should be 3 and ENTERPRISE unlimited';
  end if;
  if (select count(*) from platform.feature_catalog where enforced) <> 2 then
    raise exception 'P19.1 FAIL: only integrations and online_ordering are enforced in this phase';
  end if;
  raise notice 'OK: placeholder plan limits are in place; exactly two features are enforced';
end $$;

\echo '── P19.2: operator roles — non-operators get nothing; read_only, support and super_admin scopes'
do $$
declare
  v_owner_a uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_owner_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
begin
  insert into p19_refs values ('owner_a', v_owner_a::text), ('owner_b', v_owner_b::text),
    ('cashier', v_cashier::text), ('biz_a', v_biz_a::text);

  -- Non-operator (the cashier has no platform role yet): no context, every RPC refused.
  if public.admin_operator_context(v_cashier) is not null then
    raise exception 'P19.2 FAIL: non-operator has an operator context';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_businesses_list(%L)', v_cashier),
                              'do not have Super Admin access') then
    raise exception 'P19.2 FAIL: non-operator listed businesses';
  end if;
  if not pg_temp.expect_err19('select public.admin_businesses_list(null)', 'Sign-in required') then
    raise exception 'P19.2 FAIL: null actor accepted';
  end if;

  insert into platform.super_admins (user_id, role) values (v_owner_a, 'super_admin')
  on conflict (user_id) do update set role = 'super_admin', revoked_at = null;
  insert into platform.super_admins (user_id, role) values (v_owner_b, 'support')
  on conflict (user_id) do update set role = 'support', revoked_at = null;
  insert into platform.super_admins (user_id, role) values (v_cashier, 'read_only')
  on conflict (user_id) do update set role = 'read_only', revoked_at = null;

  if public.admin_operator_context(v_owner_b)->'permissions' is distinct from '["view", "support"]'::jsonb then
    raise exception 'P19.2 FAIL: support permissions are wrong: %', public.admin_operator_context(v_owner_b);
  end if;
  if public.admin_operator_context(v_cashier)->'permissions' is distinct from '["view"]'::jsonb then
    raise exception 'P19.2 FAIL: read_only permissions are wrong';
  end if;

  -- read_only can view, but not suspend a business.
  if (public.admin_businesses_list(v_cashier, null, null, 5, 0)->>'total')::int < 2 then
    raise exception 'P19.2 FAIL: read_only cannot view businesses';
  end if;
  if not pg_temp.expect_err19(format(
       'select public.admin_business_set_status(%L,%L,%L,%L)', v_cashier, v_biz_a, 'suspended', 'Test reason'),
       'do not have Super Admin access') then
    raise exception 'P19.2 FAIL: read_only suspended a business';
  end if;
  -- support can view and reply, but cannot change plans.
  if not pg_temp.expect_err19(format(
       'select public.admin_plan_save(%L,%L,%L,%L,true,%L::jsonb,%L)', v_owner_b, 'PILOT', 'Pilot', null, '[]', 'Trying to edit'),
       'do not have Super Admin access') then
    raise exception 'P19.2 FAIL: support edited a plan';
  end if;

  raise notice 'OK: non-operators get no operator context and every RPC refuses them; read_only and support are limited to their permissions';
end $$;

\echo '── P19.3: operator grants — email lookup, reasons, self-protection and the last-super-admin guard'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_owner_b uuid := pg_temp.p19('owner_b');
  v_cashier uuid := pg_temp.p19('cashier');
  v_email_b text;
  v_email_cashier text;
  v_result jsonb;
begin
  select email into v_email_b from auth.users where id = v_owner_b;
  select email into v_email_cashier from auth.users where id = v_cashier;

  if not pg_temp.expect_err19(format('select public.admin_operator_grant(%L,%L,%L,%L)',
       v_owner_a, 'nobody-here@example.com', 'support', 'Trying to grant'), 'No account exists') then
    raise exception 'P19.3 FAIL: granting an unknown email was accepted';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_operator_grant(%L,%L,%L,%L)',
       v_owner_a, v_email_b, 'support', 'x'), 'Enter a reason') then
    raise exception 'P19.3 FAIL: a short reason was accepted';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_operator_grant(%L,%L,%L,%L)',
       v_owner_a, (select email from auth.users where id = v_owner_a), 'read_only', 'Self change'),
       'cannot change your own') then
    raise exception 'P19.3 FAIL: an operator changed their own role';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_operator_revoke(%L,%L,%L)',
       v_owner_a, v_owner_a, 'Self revoke'), 'cannot revoke your own') then
    raise exception 'P19.3 FAIL: a super admin revoked themselves';
  end if;
  if not pg_temp.expect_err19('select platform.assert_not_last_super_admin(''aaaaaaaa-0000-0000-0000-000000000001'')',
                              'At least one active Super Admin must remain') then
    raise exception 'P19.3 FAIL: the last super admin could be removed';
  end if;

  -- Revoke the read-only cashier, then grant them back.
  v_result := public.admin_operator_revoke(v_owner_a, v_cashier, 'Read-only access no longer needed');
  if (v_result->>'revoked')::boolean is not true or public.admin_operator_context(v_cashier) is not null then
    raise exception 'P19.3 FAIL: revoke did not take effect';
  end if;
  v_result := public.admin_operator_grant(v_owner_a, v_email_cashier, 'read_only', 'Auditor access restored');
  if v_result->>'role' <> 'read_only' or public.admin_operator_context(v_cashier) is null then
    raise exception 'P19.3 FAIL: grant did not restore access';
  end if;

  if (select count(*) from jsonb_array_elements(public.admin_operator_list(v_owner_a))) < 3 then
    raise exception 'P19.3 FAIL: operator list is missing rows';
  end if;
  raise notice 'OK: grants need an existing account and a reason; nobody can change or revoke their own access; the last super admin cannot be removed';
end $$;

\echo '── P19.4: suspension locks out every staff member at the membership level'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_biz_a uuid := pg_temp.p19('biz_a');
  v_membership uuid;
  v_result jsonb;
  v_active_left integer;
  v_trial_biz uuid := pg_temp.p19('trial_biz');
begin
  select id into v_membership from public.memberships where user_id = v_owner_a and business_id = v_biz_a;

  -- Before: the owner can act on the business.
  perform public.require_business_actor_permission(v_owner_a, v_biz_a, 'settings.manage');

  v_result := public.admin_business_set_status(v_owner_a, v_biz_a, 'suspended', 'Chargeback under review');
  if (v_result->>'memberships_changed')::int < 1 then
    raise exception 'P19.4 FAIL: suspension did not change any memberships';
  end if;
  select count(*) into v_active_left from public.memberships where business_id = v_biz_a and status = 'active';
  if v_active_left <> 0 then
    raise exception 'P19.4 FAIL: % active memberships remain after suspension', v_active_left;
  end if;

  if not pg_temp.expect_err19(format('select public.require_business_actor_permission(%L,%L,%L)',
       v_owner_a, v_biz_a, 'settings.manage'), 'You do not have permission') then
    raise exception 'P19.4 FAIL: the owner still has permission while suspended';
  end if;
  -- Invite acceptance and any direct write hit the same guard.
  if not pg_temp.expect_err19(format(
       'update public.memberships set status = ''active'' where id = %L', v_membership),
       'suspended or closed') then
    raise exception 'P19.4 FAIL: a suspended membership was re-activated directly';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_business_set_status(%L,%L,%L,%L)',
       v_owner_a, v_biz_a, 'suspended', 'Again'), 'already') then
    raise exception 'P19.4 FAIL: suspending twice was accepted';
  end if;
  -- Entitlements stop with the business.
  if (select included from platform.feature_entitlement(v_biz_a, 'integrations')) then
    raise exception 'P19.4 FAIL: a suspended business still has integrations';
  end if;

  -- Restore: only the memberships the suspension changed come back.
  v_result := public.admin_business_set_status(v_owner_a, v_biz_a, 'active', 'Payment received');
  if (select status from public.memberships where id = v_membership) <> 'active' then
    raise exception 'P19.4 FAIL: the owner membership was not restored';
  end if;
  perform public.require_business_actor_permission(v_owner_a, v_biz_a, 'settings.manage');

  -- A closed business cannot be reopened from here.
  update public.businesses set status = 'closed' where id = v_trial_biz;
  if not pg_temp.expect_err19(format('select public.admin_business_set_status(%L,%L,%L,%L)',
       v_owner_a, v_trial_biz, 'active', 'Reopen'), 'closed business') then
    raise exception 'P19.4 FAIL: a closed business was reopened';
  end if;
  update public.businesses set status = 'active' where id = v_trial_biz;

  raise notice 'OK: suspension blocks every staff membership, invite acceptance included; reactivation restores the same rows; closed businesses stay closed';
end $$;

\echo '── P19.5: membership deactivation — the last active owner is protected'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_biz_a uuid := pg_temp.p19('biz_a');
  v_cashier uuid := pg_temp.p19('cashier');
  v_owner_membership uuid;
  v_cashier_membership uuid;
begin
  select id into v_owner_membership from public.memberships where user_id = v_owner_a and business_id = v_biz_a;
  select id into v_cashier_membership from public.memberships where user_id = v_cashier and business_id = v_biz_a;

  if not pg_temp.expect_err19(format('select public.admin_membership_deactivate(%L,%L,%L)',
       v_owner_a, v_owner_membership, 'Removing the only owner'), 'at least one active owner') then
    raise exception 'P19.5 FAIL: the last active owner was deactivated';
  end if;

  if (public.admin_membership_deactivate(v_owner_a, v_cashier_membership, 'Left the business')->>'status') <> 'deactivated' then
    raise exception 'P19.5 FAIL: staff deactivation did not return deactivated';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_membership_deactivate(%L,%L,%L)',
       v_owner_a, v_cashier_membership, 'Again'), 'already deactivated') then
    raise exception 'P19.5 FAIL: deactivating twice was accepted';
  end if;

  raise notice 'OK: the last active owner cannot be deactivated; deactivation is recorded once';
end $$;

\echo '── P19.6: self-service — a removed member cannot re-activate their own membership'
select set_config('request.jwt.claims', '{"sub": "f1111111-0000-0000-0000-000000000010", "role": "authenticated"}', false);
set role authenticated;
do $$
begin
  begin
    update public.memberships set status = 'active' where user_id = auth.uid();
    raise exception 'P19.6 FAIL: a deactivated member re-activated their membership';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  raise notice 'OK: a deactivated member cannot re-activate their own membership (RLS: status may only become deactivated)';
end $$;

\echo '── P19.7: plans — validation, save, inactive plans cannot be assigned'
do $$
declare
  v_plan jsonb;
  v_features jsonb := '[{"feature_key":"outlets","included":true,"limit_value":2},{"feature_key":"reports","included":true,"limit_value":null}]';
begin
  if not pg_temp.expect_err19(format('select public.admin_plan_save(%L,%L,%L,%L,true,%L::jsonb,%L)',
       pg_temp.p19('owner_a'), 'PILOT', 'Pilot', null, '[{"feature_key":"nope","included":true,"limit_value":null}]', 'Unknown feature'),
       'does not exist') then
    raise exception 'P19.7 FAIL: an unknown feature was accepted';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_plan_save(%L,%L,%L,%L,true,%L::jsonb,%L)',
       pg_temp.p19('owner_a'), 'PILOT', 'Pilot', null,
       '[{"feature_key":"reports","included":true,"limit_value":null},{"feature_key":"reports","included":false,"limit_value":null}]',
       'Duplicate'), 'only once') then
    raise exception 'P19.7 FAIL: a duplicate feature was accepted';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_plan_save(%L,%L,%L,%L,true,%L::jsonb,%L)',
       pg_temp.p19('owner_a'), 'PILOT', 'Pilot', null,
       '[{"feature_key":"reports","included":true,"limit_value":5}]', 'Boolean limit'), 'boolean features have no limit') then
    raise exception 'P19.7 FAIL: a limit on a boolean feature was accepted';
  end if;

  v_plan := public.admin_plan_save(
    pg_temp.p19('owner_a'), 'pilot', 'Pilot', 'Trial pilot for one site', true, v_features, 'Pilot offer agreed'
  );
  if v_plan->>'code' <> 'PILOT' then
    raise exception 'P19.7 FAIL: plan code was not normalised';
  end if;

  -- Plans are listed with the full catalogue, so a missing feature reads as not included.
  if (select count(*) from jsonb_array_elements(public.admin_plans_list(pg_temp.p19('owner_a')))) < 5 then
    raise exception 'P19.7 FAIL: plan list is missing plans';
  end if;

  -- Deactivate the plan: assignment is refused.
  perform public.admin_plan_save(pg_temp.p19('owner_a'), 'PILOT', 'Pilot', 'Trial pilot', false, v_features, 'Pilot closed');
  if not pg_temp.expect_err19(format('select public.admin_subscription_set(%L,%L,%L,%L,null,null,%L)',
       pg_temp.p19('owner_a'), pg_temp.p19('trial_biz'), 'PILOT', 'active', 'Assign inactive'), 'inactive') then
    raise exception 'P19.7 FAIL: an inactive plan was assigned';
  end if;
  raise notice 'OK: plan saves are validated; inactive plans cannot be assigned; plan list covers all four placeholder plans plus new ones';
end $$;

\echo '── P19.8: subscriptions — trial end date rules and operator changes'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_trial_biz uuid := pg_temp.p19('trial_biz');
  v_result jsonb;
  v_status text;
begin
  if not pg_temp.expect_err19(format('select public.admin_subscription_set(%L,%L,%L,%L,null,null,%L)',
       v_owner_a, v_trial_biz, 'GROWTH', 'trial', 'Trial without end'), 'needs an end date') then
    raise exception 'P19.8 FAIL: a trial without an end date was accepted';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_subscription_set(%L,%L,%L,%L,null,null,%L)',
       v_owner_a, v_trial_biz, 'GROWTH', 'paused', 'Invalid status'), 'valid subscription status') then
    raise exception 'P19.8 FAIL: an invalid status was accepted';
  end if;

  -- Move to STARTER (no integrations, no online ordering) as an active paid subscription.
  v_result := public.admin_subscription_set(
    v_owner_a, v_trial_biz, 'STARTER', 'active', null, now() + interval '30 days', 'Starter plan confirmed'
  );
  select s.status into v_status from platform.business_subscriptions s where s.business_id = v_trial_biz;
  if v_status <> 'active' or v_result->>'plan_code' <> 'STARTER' then
    raise exception 'P19.8 FAIL: subscription did not move to STARTER active';
  end if;
  if (select included from platform.feature_entitlement(v_trial_biz, 'integrations')) then
    raise exception 'P19.8 FAIL: STARTER should not include integrations';
  end if;

  raise notice 'OK: trials need an end date; plan and status changes are applied and entitlements follow';
end $$;

\echo '── P19.9: entitlement enforcement — integrations and online ordering are refused without the feature'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_owner_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_outlet_b uuid;
  v_outlet_a uuid;
begin
  -- Tenant B on STARTER: no integrations.
  perform public.admin_subscription_set(v_owner_a, v_biz_b, 'STARTER', 'active', null, now() + interval '30 days', 'Starter for enforcement test');
  select id into v_outlet_b from public.outlets where business_id = v_biz_b order by created_at limit 1;

  if not pg_temp.expect_err19(format(
       'select public.integration_account_save(%L,%L,null,%L,%L,false,%L::jsonb,%L::jsonb,null)',
       v_owner_b, v_biz_b, 'accounting_export', 'demo', '{}', '{}'),
       'Integrations is not included') then
    raise exception 'P19.9 FAIL: integrations were connected on a plan without them';
  end if;

  -- Online order on the same plan: refused (online, and qr).
  if not pg_temp.expect_err19(format(
       'insert into public.orders (business_id, outlet_id, order_number, client_ref, order_type, channel) values (%L,%L,%s,%L,%L,%L)',
       v_biz_b, v_outlet_b, 9101, 'p19-online-block-1', 'takeaway', 'online'),
       'Online ordering is not included') then
    raise exception 'P19.9 FAIL: an online order was accepted without online ordering';
  end if;
  if not pg_temp.expect_err19(format(
       'insert into public.orders (business_id, outlet_id, order_number, client_ref, order_type, channel) values (%L,%L,%s,%L,%L,%L)',
       v_biz_b, v_outlet_b, 9102, 'p19-qr-block-1', 'dine_in', 'qr'),
       'Online ordering is not included') then
    raise exception 'P19.9 FAIL: a QR order was accepted without online ordering';
  end if;
  -- Walk-in POS orders are not gated by this feature.
  insert into public.orders (business_id, outlet_id, order_number, client_ref, order_type, channel)
  values (v_biz_b, v_outlet_b, 9103, 'p19-pos-ok-0001', 'takeaway', 'pos');

  -- An override can grant it for one business. Clearing the override removes it.
  perform public.admin_entitlement_override_set(v_owner_a, v_biz_b, 'integrations', true, null, 'Pilot integration access');
  if not (select included from platform.feature_entitlement(v_biz_b, 'integrations')) then
    raise exception 'P19.9 FAIL: override did not grant integrations';
  end if;
  perform public.integration_account_save(v_owner_b, v_biz_b, null, 'accounting_export', 'demo', false, '{}'::jsonb, '{}'::jsonb, null);
  perform public.admin_entitlement_override_set(v_owner_a, v_biz_b, 'integrations', null, null, 'Pilot ended');
  if (select source from platform.feature_entitlement(v_biz_b, 'integrations')) <> 'plan' then
    raise exception 'P19.9 FAIL: clearing the override did not fall back to the plan';
  end if;

  -- Restore Tenant B to GROWTH, and Tenant A to GROWTH so later suites see a paid plan.
  perform public.admin_subscription_set(v_owner_a, v_biz_b, 'GROWTH', 'active', null, now() + interval '30 days', 'Restore after enforcement test');
  perform public.admin_subscription_set(v_owner_a, pg_temp.p19('biz_a'), 'GROWTH', 'active', null, now() + interval '30 days', 'Restore after enforcement test');

  -- GROWTH allows online orders again.
  insert into public.orders (
    business_id, outlet_id, order_number, client_ref, order_type, channel,
    intake_status, payment_mode, tracking_token_hash, customer_phone
  )
  select 'cccccccc-0000-0000-0000-000000000001', o.id, 9201, 'p19-online-ok-0001', 'takeaway', 'online',
         'awaiting_acceptance', 'pay_at_counter', 'p19-tracking-hash-0001', '+919000000001'
  from public.outlets o where o.business_id = 'cccccccc-0000-0000-0000-000000000001' order by o.created_at limit 1;
  raise notice 'OK: integrations and online ordering are refused without the feature; overrides grant and clear; GROWTH allows online orders';
end $$;

\echo '── P19.10: overrides — boolean features cannot carry a limit'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
begin
  if not pg_temp.expect_err19(format('select public.admin_entitlement_override_set(%L,%L,%L,%L,%s,%L)',
       v_owner_a, v_biz_b, 'reports', true, 3, 'Limit on boolean'), 'Boolean features cannot have a limit') then
    raise exception 'P19.10 FAIL: a limit on a boolean override was accepted';
  end if;
  if not pg_temp.expect_err19(format('select public.admin_entitlement_override_set(%L,%L,%L,%L,%s,%L)',
       v_owner_a, v_biz_b, 'outlets', true, -1, 'Negative limit'), 'cannot be negative') then
    raise exception 'P19.10 FAIL: a negative limit was accepted';
  end if;
  perform public.admin_entitlement_override_set(v_owner_a, v_biz_b, 'outlets', true, 5, 'Pilot site allowance');
  if (select limit_value from platform.feature_entitlement(v_biz_b, 'outlets')) <> 5 then
    raise exception 'P19.10 FAIL: limit override did not apply';
  end if;
  perform public.admin_entitlement_override_set(v_owner_a, v_biz_b, 'outlets', null, null, 'Allowance ended');
  raise notice 'OK: boolean overrides cannot carry a limit; limit overrides apply and clear';
end $$;

\echo '── P19.11: support — tenant tickets, operator replies, notes hidden from tenants'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_owner_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_cashier uuid := pg_temp.p19('cashier');
  v_biz_a uuid := pg_temp.p19('biz_a');
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_ticket uuid;
  v_status text;
  v_tenant_view text;
  v_i integer;
begin
  if not pg_temp.expect_err19(format('select public.support_ticket_open(%L,%L,%L,%L)',
       v_cashier, v_biz_a, 'Cashier ticket', 'Should be refused'), 'do not have permission') then
    raise exception 'P19.11 FAIL: a member without settings.manage opened a ticket';
  end if;

  v_ticket := (public.support_ticket_open(v_owner_a, v_biz_a, 'Printer offline', 'Kitchen printer stopped printing')->>'id')::uuid;
  insert into p19_refs values ('ticket', v_ticket::text);

  -- Ten open tickets per business; the eleventh is refused.
  for v_i in 1..9 loop
    perform public.support_ticket_open(v_owner_a, v_biz_a, 'Bulk test ' || v_i, 'Filler ticket ' || v_i);
  end loop;
  if not pg_temp.expect_err19(format('select public.support_ticket_open(%L,%L,%L,%L)',
       v_owner_a, v_biz_a, 'Eleventh', 'Too many'), 'open tickets') then
    raise exception 'P19.11 FAIL: the open ticket limit was not enforced';
  end if;

  -- Operator (read_only) cannot reply; support can, and can add notes.
  if not pg_temp.expect_err19(format('select public.admin_support_reply(%L,%L,%L)',
       v_cashier, v_ticket, 'Read-only reply'), 'do not have Super Admin access') then
    raise exception 'P19.11 FAIL: a read_only operator replied to a ticket';
  end if;
  perform public.admin_support_note(v_owner_b, v_ticket, 'Customer uses an old printer; check the agent version');
  perform public.admin_support_reply(v_owner_b, v_ticket, 'Please restart the print agent and tell us the error');
  select status into v_status from platform.support_tickets where id = v_ticket;
  if v_status <> 'waiting_customer' then
    raise exception 'P19.11 FAIL: operator reply did not move the ticket to waiting_customer';
  end if;

  -- The tenant sees the reply, never the note, and never another tenant's ticket.
  v_tenant_view := public.support_tickets_list(v_owner_a, v_biz_a)::text;
  if position('Please restart the print agent' in v_tenant_view) = 0 then
    raise exception 'P19.11 FAIL: tenant cannot see the operator reply';
  end if;
  if position('old printer' in v_tenant_view) > 0 or position('"note"' in v_tenant_view) > 0 then
    raise exception 'P19.11 FAIL: an internal note leaked to the tenant';
  end if;
  if not pg_temp.expect_err19(format('select public.support_ticket_reply(%L,%L,%L,%L)',
       v_owner_b, v_biz_b, v_ticket, 'Cross-tenant reply'), 'Ticket not found') then
    raise exception 'P19.11 FAIL: a tenant replied to another tenant''s ticket';
  end if;

  -- Tenant reply reopens it; resolve and assign by an operator.
  perform public.support_ticket_reply(v_owner_a, v_biz_a, v_ticket, 'Restarted the agent; error says connection refused');
  select status into v_status from platform.support_tickets where id = v_ticket;
  if v_status <> 'open' then
    raise exception 'P19.11 FAIL: tenant reply did not reopen the ticket';
  end if;
  perform public.admin_support_update(v_owner_b, v_ticket, 'resolved', 'urgent', true);
  if (select resolved_at is null or assigned_to is distinct from v_owner_b from platform.support_tickets where id = v_ticket) then
    raise exception 'P19.11 FAIL: resolve and assign did not persist';
  end if;
  if (select count(*) from jsonb_array_elements(public.admin_support_ticket(v_owner_b, v_ticket)->'messages') m
        where m->>'author_side' = 'note') <> 1 then
    raise exception 'P19.11 FAIL: operator view should show the internal note';
  end if;
  if (public.admin_support_queue(v_owner_b, null, 50, 0)->'counts'->>'resolved')::int < 1 then
    raise exception 'P19.11 FAIL: queue counts are wrong';
  end if;

  raise notice 'OK: tenants open and reply to tickets within settings.manage; operator notes stay hidden; ticket limits and cross-tenant refusals hold';
end $$;

\echo '── P19.12: suspended tenants cannot open support tickets'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_biz_a uuid := pg_temp.p19('biz_a');
begin
  perform public.admin_business_set_status(v_owner_a, v_biz_a, 'suspended', 'Suspension check');
  if not pg_temp.expect_err19(format('select public.support_ticket_open(%L,%L,%L,%L)',
       v_owner_a, v_biz_a, 'Blocked', 'Suspended tenant'), 'do not have permission') then
    raise exception 'P19.12 FAIL: a suspended tenant opened a ticket';
  end if;
  perform public.admin_business_set_status(v_owner_a, v_biz_a, 'active', 'Suspension check cleared');
  raise notice 'OK: a suspended tenant cannot open support tickets';
end $$;

\echo '── P19.13: audit — every change is recorded, the trail is append-only, tenant audit is readable'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_biz_a uuid := pg_temp.p19('biz_a');
  v_missing text;
  v_rows jsonb;
  v_bad integer;
begin
  select string_agg(a, ', ') into v_missing
  from unnest(array[
    'admin.business_status_changed', 'admin.membership_deactivated', 'admin.operator_granted',
    'admin.operator_revoked', 'admin.plan_saved', 'admin.subscription_changed',
    'admin.override_changed', 'admin.support_replied', 'admin.support_noted', 'admin.support_updated'
  ]) a
  where not exists (select 1 from platform.admin_audit_logs l where l.action = a);
  if v_missing is not null then
    raise exception 'P19.13 FAIL: no audit rows for: %', v_missing;
  end if;

  select count(*) into v_bad from platform.admin_audit_logs where char_length(reason) < 3;
  if v_bad <> 0 then raise exception 'P19.13 FAIL: % audit rows without a usable reason', v_bad; end if;

  if not pg_temp.expect_err19('update platform.admin_audit_logs set reason = ''tampered'' where true',
                              'append-only') then
    raise exception 'P19.13 FAIL: audit rows can be updated';
  end if;
  if not pg_temp.expect_err19('delete from platform.admin_audit_logs where true', 'append-only') then
    raise exception 'P19.13 FAIL: audit rows can be deleted';
  end if;

  v_rows := public.admin_audit_list(v_owner_a, v_biz_a, 50, 0);
  if (select count(*) from jsonb_array_elements(v_rows->'rows') r where r->>'business_id' <> v_biz_a::text) > 0 then
    raise exception 'P19.13 FAIL: business filter leaked other businesses';
  end if;

  if not pg_temp.expect_err19(format('select public.admin_tenant_audit_list(%L,%L,null,50,0)', v_owner_a, null::uuid),
       'Choose a business') then
    raise exception 'P19.13 FAIL: tenant audit read accepted no business';
  end if;
  v_rows := public.admin_tenant_audit_list(v_owner_a, v_biz_a, 'orders.', 50, 0);
  if (select count(*) from jsonb_array_elements(v_rows->'rows') r where left(r->>'action', 7) <> 'orders.') > 0 then
    raise exception 'P19.13 FAIL: action prefix filter returned other actions';
  end if;

  raise notice 'OK: each operator change writes an audit row; the trail rejects updates and deletes; tenant audit is readable by prefix';
end $$;

\echo '── P19.14: usage, platform health and integration health are real queries'
do $$
declare
  v_owner_a uuid := pg_temp.p19('owner_a');
  v_usage jsonb;
  v_health jsonb;
  v_integrations jsonb;
begin
  v_usage := public.admin_usage_overview(v_owner_a, 30);
  if (v_usage->'totals'->>'businesses')::int < 2 then raise exception 'P19.14 FAIL: business total is wrong'; end if;
  if (v_usage->'totals'->>'orders')::int < 2 then raise exception 'P19.14 FAIL: order total does not match the orders inserted'; end if;
  if jsonb_typeof(v_usage->'totals'->'payments_captured_minor_by_currency') <> 'array' then
    raise exception 'P19.14 FAIL: payments by currency is not an array';
  end if;
  if (select count(*) from jsonb_array_elements(v_usage->'businesses')) < 2 then
    raise exception 'P19.14 FAIL: per-business usage is missing rows';
  end if;

  v_health := public.admin_platform_health(v_owner_a);
  if (v_health->'businesses'->>'active')::int < 2 then raise exception 'P19.14 FAIL: active business count is wrong'; end if;
  if v_health->'subscriptions' is null or v_health->'integrations' is null or v_health->'agents' is null then
    raise exception 'P19.14 FAIL: health is missing sections';
  end if;

  v_integrations := public.admin_integration_health(v_owner_a, 100);
  if (select count(*) from jsonb_array_elements(v_integrations->'accounts')) < 1 then
    raise exception 'P19.14 FAIL: integration health lists no accounts';
  end if;
  if public.admin_health_ping(v_owner_a) is null then raise exception 'P19.14 FAIL: no ping'; end if;

  raise notice 'OK: usage, health and integration health come from live queries and match the rows created in this suite';
end $$;

\echo '── P19.15: grants — tenant roles cannot reach the platform schema or its RPCs'
do $$
declare
  r record;
  v_leaks integer := 0;
begin
  for r in
    select p.oid, p.proname, n.nspname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and (p.proname like 'admin\_%' or p.proname like 'support\_%'))
       or n.nspname = 'platform'
  loop
    if has_function_privilege('authenticated', r.oid, 'EXECUTE')
       or has_function_privilege('anon', r.oid, 'EXECUTE') then
      v_leaks := v_leaks + 1;
      raise notice 'leak: %.% is executable by a tenant role', r.nspname, r.proname;
    end if;
  end loop;
  if v_leaks > 0 then raise exception 'P19.15 FAIL: % functions are executable by tenant roles', v_leaks; end if;

  for r in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'admin\_%'
  loop
    if not has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'P19.15 FAIL: service role cannot execute %', r.proname;
    end if;
  end loop;

  set role authenticated;
  begin
    perform 1 from platform.business_subscriptions;
    raise exception 'P19.15 FAIL: authenticated read platform.business_subscriptions';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from platform.admin_audit_logs;
    raise exception 'P19.15 FAIL: authenticated read the admin audit trail';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'OK: no tenant role can execute an admin or support RPC, and the platform schema is unreadable to them';
end $$;

\echo '── P19.16: suspended business — support tickets and entitlements stop; restore is complete'
do $$
declare
  v_biz_a uuid := pg_temp.p19('biz_a');
begin
  if (select count(*) from public.memberships where business_id = v_biz_a and status = 'suspended') <> 0 then
    raise exception 'P19.16 FAIL: a suspended membership was left behind after restore';
  end if;
  if not (select included from platform.feature_entitlement(v_biz_a, 'integrations')) then
    raise exception 'P19.16 FAIL: Tenant A should have integrations after restore';
  end if;
  raise notice 'OK: restore leaves no suspended memberships behind and Tenant A is entitled again';
end $$;

-- P19.17 helper: describes the missing keys of one JSON object (empty string when complete).
create or replace function pg_temp.shape_gap(p_label text, p_obj jsonb, p_keys text[]) returns text
language plpgsql as $$
declare
  v_missing text[];
begin
  if p_obj is null or jsonb_typeof(p_obj) <> 'object' then
    return p_label || ' is not an object; ';
  end if;
  select coalesce(array_agg(k), '{}') into v_missing from unnest(p_keys) k where not (p_obj ? k);
  if cardinality(v_missing) > 0 then
    return p_label || ' is missing ' || array_to_string(v_missing, ',') || '; ';
  end if;
  return '';
end $$;

\echo '── P19.17: RPC response shapes — every key the dashboard reads is present'
do $$
declare
  v_op uuid := (select user_id from platform.super_admins where revoked_at is null and role = 'super_admin' order by granted_at limit 1);
  v_owner_a uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz uuid := pg_temp.p19('biz_a');
  v_bad text := '';
  v_j jsonb;
  v_ticket uuid;
  v_usage_keys text[] := array['since','outlets','active_staff','orders','channel_orders','last_order_at','payments_captured','payments_captured_minor_by_currency','integration_jobs','integration_jobs_dead','customers_all_time','open_support_tickets'];
begin
  if v_op is null then raise exception 'P19.17 FAIL: no super_admin operator exists to call the RPCs'; end if;

  v_j := public.admin_operator_context(v_op);
  v_bad := v_bad || pg_temp.shape_gap('operator_context', v_j, array['role','permissions']);

  v_j := public.admin_businesses_list(v_op, null, null, 50, 0);
  v_bad := v_bad || pg_temp.shape_gap('businesses.total', v_j, array['total','rows']);
  v_bad := v_bad || pg_temp.shape_gap('businesses.rows[0]', v_j->'rows'->0,
    array['id','name','slug','status','created_at','subscription_status','trial_ends_at','plan_code','outlet_count','active_staff']);

  v_j := public.admin_business_detail(v_op, v_biz);
  v_bad := v_bad || pg_temp.shape_gap('business_detail', v_j,
    array['business','subscription','outlets','members','entitlements','overrides','usage_30d']);
  v_bad := v_bad || pg_temp.shape_gap('business_detail.business', v_j->'business', array['id','name','slug','status','created_at','updated_at']);
  v_bad := v_bad || pg_temp.shape_gap('business_detail.usage_30d', v_j->'usage_30d', v_usage_keys);
  v_bad := v_bad || pg_temp.shape_gap('business_detail.outlets[0]', v_j->'outlets'->0, array['id','name','slug','status','currency_code','timezone']);
  v_bad := v_bad || pg_temp.shape_gap('business_detail.members[0]', v_j->'members'->0, array['membership_id','user_id','email','full_name','role','status','created_at']);
  v_bad := v_bad || pg_temp.shape_gap('business_detail.entitlements[0]', v_j->'entitlements'->0,
    array['feature_key','label','kind','unit','enforced','included','limit_value','source']);

  v_j := public.admin_outlets_list(v_op, null, 50, 0);
  v_bad := v_bad || pg_temp.shape_gap('outlets.rows[0]', v_j->'rows'->0,
    array['id','name','slug','status','currency_code','timezone','business_id','business_name','business_status']);

  v_j := public.admin_users_list(v_op, null, 50, 0);
  v_bad := v_bad || pg_temp.shape_gap('users.rows[0]', v_j->'rows'->0,
    array['id','email','full_name','created_at','last_sign_in_at','active_memberships','operator_role']);

  v_j := public.admin_user_detail(v_op, v_owner_a);
  v_bad := v_bad || pg_temp.shape_gap('user_detail', v_j, array['user','operator','memberships']);
  v_bad := v_bad || pg_temp.shape_gap('user_detail.user', v_j->'user', array['id','email','created_at','last_sign_in_at','full_name','phone']);
  v_bad := v_bad || pg_temp.shape_gap('user_detail.memberships[0]', v_j->'memberships'->0,
    array['membership_id','business_id','business_name','role','status','created_at']);

  v_j := public.admin_operator_list(v_op);
  v_bad := v_bad || pg_temp.shape_gap('operator_list[0]', v_j->0, array['user_id','email','role','granted_at','revoked_at']);

  v_j := public.admin_plans_list(v_op);
  v_bad := v_bad || pg_temp.shape_gap('plans[0]', v_j->0, array['code','name','description','is_active','businesses','features']);
  v_bad := v_bad || pg_temp.shape_gap('plans[0].features[0]', v_j->0->'features'->0,
    array['feature_key','label','kind','unit','enforced','included','limit_value']);

  v_j := public.admin_subscriptions_list(v_op, null, 50, 0);
  v_bad := v_bad || pg_temp.shape_gap('subscriptions', v_j, array['total','counts','rows']);
  v_bad := v_bad || pg_temp.shape_gap('subscriptions.counts', v_j->'counts',
    array['trial','active','past_due','cancelled','businesses_without_subscription']);
  v_bad := v_bad || pg_temp.shape_gap('subscriptions.rows[0]', v_j->'rows'->0,
    array['business_id','business_name','business_status','plan_code','status','trial_ends_at','current_period_ends_at','last_change_reason','updated_at','trial_ending_soon']);

  v_j := public.admin_overrides_list(v_op);
  if jsonb_array_length(v_j) > 0 then
    v_bad := v_bad || pg_temp.shape_gap('overrides[0]', v_j->0,
      array['business_id','business_name','feature_key','label','included','limit_value','reason','updated_at']);
  end if;

  v_j := public.admin_usage_overview(v_op, 30);
  v_bad := v_bad || pg_temp.shape_gap('usage', v_j, array['window_days','since','measured_at','totals','businesses']);
  v_bad := v_bad || pg_temp.shape_gap('usage.totals', v_j->'totals',
    array['businesses','outlets','active_staff','orders','channel_orders','payments_captured','payments_captured_minor_by_currency','integration_jobs','customers_all_time']);
  v_bad := v_bad || pg_temp.shape_gap('usage.businesses[0]', v_j->'businesses'->0, array['id','name','status','usage','outlets_limit','staff_limit']);
  v_bad := v_bad || pg_temp.shape_gap('usage.businesses[0].usage', v_j->'businesses'->0->'usage', v_usage_keys);

  v_j := public.admin_platform_health(v_op);
  v_bad := v_bad || pg_temp.shape_gap('health', v_j,
    array['measured_at','businesses','subscriptions','integrations','webhooks','agents','support','admin_actions_24h','tenant_audit_events_24h']);
  v_bad := v_bad || pg_temp.shape_gap('health.businesses', v_j->'businesses', array['active','suspended','closed']);
  v_bad := v_bad || pg_temp.shape_gap('health.subscriptions', v_j->'subscriptions', array['trial','active','past_due','cancelled','trial_ending_7d']);
  v_bad := v_bad || pg_temp.shape_gap('health.integrations', v_j->'integrations',
    array['accounts_total','accounts_in_error','accounts_live_enabled','accounts_demo_enabled','jobs_pending','jobs_running','jobs_dead','oldest_due_job_seconds','attempts_failed_24h','attempts_retry_scheduled_24h']);
  v_bad := v_bad || pg_temp.shape_gap('health.webhooks', v_j->'webhooks', array['last_received_at','received_24h','failed_24h']);
  v_bad := v_bad || pg_temp.shape_gap('health.agents', v_j->'agents', array['registered','online_5m','revoked']);
  v_bad := v_bad || pg_temp.shape_gap('health.support', v_j->'support', array['open','waiting_customer','urgent_unresolved']);

  v_j := public.admin_integration_health(v_op, 200);
  v_bad := v_bad || pg_temp.shape_gap('integration_health', v_j, array['accounts','agents']);
  if jsonb_array_length(v_j->'accounts') > 0 then
    v_bad := v_bad || pg_temp.shape_gap('integration_health.accounts[0]', v_j->'accounts'->0,
      array['id','business_id','business_name','outlet_id','outlet_name','provider','mode','enabled','status','last_tested_at','last_success_at','last_error','pending_jobs','dead_jobs','failed_attempts_24h']);
  end if;

  v_j := public.admin_support_queue(v_op, null, 50, 0);
  v_bad := v_bad || pg_temp.shape_gap('support_queue', v_j, array['total','counts','rows']);
  v_bad := v_bad || pg_temp.shape_gap('support_queue.counts', v_j->'counts', array['open','waiting_customer','resolved','urgent_unresolved']);
  v_bad := v_bad || pg_temp.shape_gap('support_queue.rows[0]', v_j->'rows'->0,
    array['id','business_id','business_name','subject','status','priority','assigned_to','last_message_at','created_at','message_count']);

  v_ticket := (v_j->'rows'->0->>'id')::uuid;
  v_j := public.admin_support_ticket(v_op, v_ticket);
  v_bad := v_bad || pg_temp.shape_gap('support_ticket', v_j, array['ticket','messages']);
  v_bad := v_bad || pg_temp.shape_gap('support_ticket.ticket', v_j->'ticket',
    array['id','business_id','business_name','subject','status','priority','assigned_to','assigned_email','opened_by_email','created_at','last_message_at','resolved_at']);
  v_bad := v_bad || pg_temp.shape_gap('support_ticket.messages[0]', v_j->'messages'->0, array['id','author_side','author_email','body','created_at']);

  v_j := public.admin_audit_list(v_op, null, 50, 0);
  v_bad := v_bad || pg_temp.shape_gap('audit', v_j, array['total','rows']);
  v_bad := v_bad || pg_temp.shape_gap('audit.rows[0]', v_j->'rows'->0,
    array['id','created_at','actor_user_id','actor_email','actor_role','action','target_type','target_id','business_id','reason','before_state','after_state']);

  v_j := public.admin_tenant_audit_list(v_op, v_biz, null, 50, 0);
  v_bad := v_bad || pg_temp.shape_gap('tenant_audit', v_j, array['total','rows']);
  if jsonb_array_length(v_j->'rows') > 0 then
    v_bad := v_bad || pg_temp.shape_gap('tenant_audit.rows[0]', v_j->'rows'->0,
      array['id','created_at','action','target_type','target_id','outlet_id','actor_user_id','actor_email','before_state','after_state']);
  end if;

  -- Tenant side: the business sees its own messages and never an internal note.
  v_j := public.support_tickets_list(v_owner_a, v_biz);
  if jsonb_typeof(v_j) <> 'array' then
    v_bad := v_bad || 'support_tickets_list is not an array; ';
  elsif jsonb_array_length(v_j) > 0 then
    v_bad := v_bad || pg_temp.shape_gap('support_tickets_list[0]', v_j->0, array['id','subject','status','created_at','last_message_at','messages']);
    v_bad := v_bad || pg_temp.shape_gap('support_tickets_list[0].messages[0]', v_j->0->'messages'->0, array['id','author_side','body','created_at']);
    if exists (
      select 1 from jsonb_array_elements(v_j) t, jsonb_array_elements(t->'messages') m
      where m->>'author_side' = 'note'
    ) then
      v_bad := v_bad || 'support_tickets_list exposed an internal note; ';
    end if;
  end if;

  if v_bad <> '' then
    raise exception 'P19.17 FAIL: %', v_bad;
  end if;
  raise notice 'OK: every RPC returns the keys the dashboard and the tenant support panel read; no internal note reaches a business';
end $$;
