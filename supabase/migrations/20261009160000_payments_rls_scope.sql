-- RestroNex Phase 11 follow-up: scope Phase 10 financial reads.
--
-- Phase 10 policies let ANY active member of a business read payments, receipts,
-- refunds, invoices and payment methods. That included kitchen staff. This
-- migration narrows every financial read policy to the permission that gates it.
--
-- Rules (mirror src/lib/rbac/enforce.ts):
--   * outlet-level rows (payments, receipts, invoices, refunds):
--       the member's role holds the permission AND either
--       - the role is business-scoped (owner, business_admin, inventory_manager,
--         accountant: read-only financial visibility across outlets), or
--       - the member holds a membership_outlets grant for that outlet.
--   * business-level configuration (payment_methods): billing.view.
--   * audit_logs: reports.view (Phase 10, unchanged).
--
-- Kitchen staff hold no billing.view / refunds.view, so they read none of these.
-- Writes are not affected: all money writes already run in SECURITY DEFINER RPCs.

-- ── helpers ─────────────────────────────────────────────────────────────────

create or replace function public.has_outlet_read_permission(p_outlet_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.outlets o
    join public.memberships m
      on m.business_id = o.business_id
     and m.user_id = auth.uid()
     and m.status = 'active'
    join public.roles r
      on r.key = m.role
    left join public.membership_outlets mo
      on mo.membership_id = m.id
     and mo.outlet_id = o.id
    join public.role_permissions rp
      on rp.role_key = m.role
     and rp.permission_key = p_permission
    where o.id = p_outlet_id
      and (r.scope = 'business' or mo.outlet_id is not null)
  );
$$;

revoke all on function public.has_outlet_read_permission(uuid, text) from public, anon;
grant execute on function public.has_outlet_read_permission(uuid, text) to authenticated, service_role;

create or replace function public.has_business_permission(p_business_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp
      on rp.role_key = m.role
     and rp.permission_key = p_permission
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

revoke all on function public.has_business_permission(uuid, text) from public, anon;
grant execute on function public.has_business_permission(uuid, text) to authenticated, service_role;

-- ── policy swaps ────────────────────────────────────────────────────────────

drop policy if exists "payment_methods_select_member" on public.payment_methods;
create policy "payment_methods_select_billing"
  on public.payment_methods for select
  to authenticated
  using (public.has_business_permission(business_id, 'billing.view'));

drop policy if exists "receipts_select_member" on public.receipts;
create policy "receipts_select_billing"
  on public.receipts for select
  to authenticated
  using (public.has_outlet_read_permission(outlet_id, 'billing.view'));

drop policy if exists "payments_select_member" on public.payments;
create policy "payments_select_billing"
  on public.payments for select
  to authenticated
  using (public.has_outlet_read_permission(outlet_id, 'billing.view'));

drop policy if exists "refunds_select_member" on public.refunds;
create policy "refunds_select_refunds"
  on public.refunds for select
  to authenticated
  using (public.has_outlet_read_permission(outlet_id, 'refunds.view'));

drop policy if exists "invoices_select_member" on public.invoices;
create policy "invoices_select_billing"
  on public.invoices for select
  to authenticated
  using (public.has_outlet_read_permission(outlet_id, 'billing.view'));

-- business_document_counters: RLS is enabled with no select policy, so
-- authenticated sessions read nothing. Only SECURITY DEFINER code touches it.
