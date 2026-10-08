-- RestroNex — Phase 1: access-path indexes
--
-- Unique constraints already create indexes on businesses.slug,
-- outlets(business_id, slug), memberships(user_id, business_id),
-- user_profiles.email and platform plan codes. The following cover the
-- remaining hot lookups for tenancy resolution and platform queries.

create index if not exists outlets_business_id_idx
  on public.outlets (business_id);

create index if not exists outlets_business_status_idx
  on public.outlets (business_id, status);

create index if not exists memberships_business_id_idx
  on public.memberships (business_id);

create index if not exists memberships_business_status_idx
  on public.memberships (business_id, status);

create index if not exists plan_features_plan_id_idx
  on platform.plan_features (plan_id);
