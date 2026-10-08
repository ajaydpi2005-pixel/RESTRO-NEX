-- RestroNex — Phase 1: Supabase Storage foundation
--
-- Buckets are created idempotently. Object-level policies are intentionally
-- deferred: storage.objects ships with RLS enabled and NO policies, which is
-- deny-all by default. Tenant-scoped object policies (business folders,
-- image limits, roles) are added with the features that need them
-- (menu images in Phase 7, brand assets in Phase 4).

insert into storage.buckets (id, name, public)
values
  ('menu-media', 'menu-media', true),       -- product/menu imagery
  ('business-assets', 'business-assets', false) -- logos, receipts, private docs
on conflict (id) do nothing;
