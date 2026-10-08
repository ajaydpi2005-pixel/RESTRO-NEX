-- RestroNex — development seed
--
-- Platform configuration only. No demo tenants, users or orders: fake
-- business data is prohibited by the master spec (§42). Plan entitlements
-- and limits are configured when subscriptions ship (Phase 20).

insert into platform.subscription_plans (code, name, description)
values
  ('STARTER', 'Starter', 'For a single outlet getting started with professional operations.'),
  ('GROWTH', 'Growth', 'For busy independent restaurants that live on their POS.'),
  ('SCALE', 'Scale', 'For multi-outlet groups that need consolidated control.'),
  ('ENTERPRISE', 'Enterprise', 'For chains and restaurant groups with custom requirements.')
on conflict (code) do update
  set name = excluded.name,
      description = excluded.description;
