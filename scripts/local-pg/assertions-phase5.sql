-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 5 assertions: RBAC catalogue + enforcement surface.
-- Runs after Phase 1/2 fixtures (alice owns Tenant A, bob owns Tenant B).
-- ─────────────────────────────────────────────────────────────────────────

\echo '── P5.1: catalogue completeness'
do $$
declare
  v_roles int; v_perms int; v_owner int;
begin
  select count(*) into v_roles from public.roles;
  select count(*) into v_perms from public.permissions;
  select count(*) into v_owner from public.role_permissions where role_key = 'owner';

  if v_roles <> 8 then
    raise exception 'expected 8 roles, found %', v_roles;
  end if;
  if v_perms <> 26 then
    raise exception 'expected 26 permissions, found %', v_perms;
  end if;
  if v_owner <> v_perms then
    raise exception 'owner must hold every permission (%, %) ', v_owner, v_perms;
  end if;
  -- all 13 domains represented
  if (select count(distinct domain) from public.permissions) <> 13 then
    raise exception 'expected 13 permission domains';
  end if;
  raise notice 'OK: 8 roles, 26 permissions across 13 domains, owner holds all';
end $$;

\echo '── P5.2: matrix spot checks (mirrors src/lib/rbac/permissions.ts)'
do $$
begin
  if not exists (select 1 from public.role_permissions where role_key = 'business_admin' and permission_key = 'subscriptions.view') then
    raise exception 'business_admin missing subscriptions.view';
  end if;
  if exists (select 1 from public.role_permissions where role_key = 'business_admin' and permission_key = 'subscriptions.manage') then
    raise exception 'business_admin must NOT hold subscriptions.manage';
  end if;
  if exists (select 1 from public.role_permissions where role_key = 'waiter' and permission_key in ('discounts.apply','refunds.process','billing.manage','reports.view')) then
    raise exception 'waiter holds a financial-administration permission';
  end if;
  if not exists (select 1 from public.role_permissions where role_key = 'cashier' and permission_key = 'discounts.apply') then
    raise exception 'cashier missing discounts.apply';
  end if;
  if exists (select 1 from public.role_permissions where role_key = 'accountant' and permission_key not like '%.view') then
    raise exception 'accountant holds a non-view permission';
  end if;
  raise notice 'OK: matrix spot checks pass';
end $$;

\echo '── P5.3: catalogue is read-only for API roles'
do $$
begin
  set role authenticated;
  begin
    insert into public.role_permissions (role_key, permission_key) values ('waiter', 'staff.manage');
    raise exception 'authenticated role inserted into role_permissions';
  exception when insufficient_privilege then
    raise notice 'OK: role_permissions INSERT denied for authenticated';
  end;
  begin
    update public.roles set rank = 999 where key = 'waiter';
    raise exception 'authenticated role updated roles';
  exception when insufficient_privilege then
    raise notice 'OK: roles UPDATE denied for authenticated';
  end;
  begin
    delete from public.permissions where key = 'orders.view';
    raise exception 'authenticated role deleted a permission';
  exception when insufficient_privilege then
    raise notice 'OK: permissions DELETE denied for authenticated';
  end;
  -- SELECT is allowed (catalogue introspection)
  if (select count(*) from public.role_permissions) = 0 then
    raise exception 'authenticated role cannot read the catalogue';
  end if;
  reset role;
exception when others then
  reset role;
  raise;
end $$;

\echo '── P5.4: outlet grants gate has_outlet_access'
do $$
declare
  v_membership uuid;
  v_main uuid;
  v_branch uuid := 'ffffffff-0000-0000-0000-0000000000a2';
begin
  -- resolve fixture ids dynamically (outlet uuids are generated)
  select o.id into v_main
  from public.outlets o
  where o.business_id = 'cccccccc-0000-0000-0000-000000000001' and o.slug = 'main';

  -- carol (waiter in Tenant A) exists from Phase 2 fixtures; ensure no
  -- leftover grants from earlier assertion suites
  select m.id into v_membership
  from public.memberships m
  where m.user_id = 'eeeeeeee-0000-0000-0000-000000000003'
    and m.business_id = 'cccccccc-0000-0000-0000-000000000001';
  delete from public.membership_outlets where membership_id = v_membership;

  -- before any grant: waiter cannot operate Tenant A's "main" outlet
  set role authenticated;
  set request.jwt.claims = '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}';
  if public.has_outlet_access(v_main) then
    raise exception 'waiter has outlet access without a grant';
  end if;
  reset role;

  -- grant the outlet explicitly
  insert into public.membership_outlets (membership_id, outlet_id)
  values (v_membership, v_main);

  set role authenticated;
  set request.jwt.claims = '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}';
  if not public.has_outlet_access(v_main) then
    raise exception 'waiter lost outlet access after explicit grant';
  end if;
  -- ...but still not the OTHER outlet
  if public.has_outlet_access(v_branch) then
    raise exception 'grant leaked to an unassigned outlet';
  end if;
  reset role;

  delete from public.membership_outlets where membership_id = v_membership;
  raise notice 'OK: outlet grants gate access per outlet, no leakage';
exception when others then
  reset role;
  raise;
end $$;

\echo '── P5.5: membership identity still immutable (escalation guard)'
do $$
begin
  set role authenticated;
  set request.jwt.claims = '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}';
  begin
    update public.memberships
    set role = 'owner'
    where user_id = 'eeeeeeee-0000-0000-0000-000000000003'
      and business_id = 'cccccccc-0000-0000-0000-000000000001';
    raise exception 'self-escalation to owner succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: self-escalation to owner still blocked by identity trigger';
  end;
  reset role;
exception when others then
  reset role;
  raise;
end $$;

\echo ''
\echo '✅ PHASE 5 RBAC ASSERTIONS COMPLETE'
