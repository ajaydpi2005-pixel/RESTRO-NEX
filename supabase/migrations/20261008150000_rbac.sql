-- RestroNex — Phase 5: RBAC + permission system
--
-- Spec §11 (roles + granular permissions, server-side enforcement), §29
-- (staff management), §39 (roles / permissions / role_permissions entities).
--
-- Design:
--  * roles / permissions / role_permissions form the queryable, auditable
--    catalogue. Application code (src/lib/rbac) mirrors the catalogue and is
--    the enforcement authority on hot paths; a live E2E check keeps the two
--    in sync.
--  * Catalogue tables are read-only for API roles (RLS SELECT-only policies
--    plus explicit REVOKE of writes). The service role seeds/manages them.
--  * Outlet assignment already lives in membership_outlets (Phase 2).

-- ── roles ───────────────────────────────────────────────────────────────────

create table public.roles (
  key text primary key,
  label text not null,
  rank integer not null unique
    constraint roles_rank_positive check (rank > 0),
  scope text not null default 'business'
    constraint roles_scope_allowed check (scope in ('business', 'outlet')),
  description text
);

-- Rank encodes the assignment hierarchy: a staff manager may only assign
-- roles strictly below their own rank, and never 'owner'.
insert into public.roles (key, label, rank, scope, description) values
  ('owner',             'Owner',            100, 'business', 'Full control of the business, including subscriptions and ownership.'),
  ('business_admin',    'Admin',             90, 'business', 'Runs the business day to day; everything except subscription management.'),
  ('outlet_manager',    'Outlet Manager',    70, 'outlet',   'Runs assigned outlets: operations, menu, customers, staff visibility.'),
  ('inventory_manager', 'Inventory Manager', 60, 'business', 'Stock, purchasing and recipe-level inventory control.'),
  ('accountant',        'Accountant',        55, 'business', 'Read-only financial visibility: billing, refunds, reports, subscriptions.'),
  ('cashier',           'Cashier',           50, 'outlet',   'Takes orders and bills; applies discounts at the counter.'),
  ('waiter',            'Waiter',            40, 'outlet',   'Order taking and table-side service. No financial administration.'),
  ('kitchen_staff',     'Kitchen Staff',     30, 'outlet',   'Sees incoming orders and the menu. Nothing else.');

-- ── permissions ─────────────────────────────────────────────────────────────

create table public.permissions (
  key text primary key
    constraint permissions_key_format check (key ~ '^[a-z_]+\.[a-z_]+$'),
  domain text not null,
  action text not null,
  description text not null,
  unique (domain, action)
);

insert into public.permissions (key, domain, action, description) values
  ('orders.view',          'orders',        'view',     'See orders and their status.'),
  ('orders.manage',        'orders',        'manage',   'Create, edit, cancel and complete orders.'),
  ('billing.view',         'billing',       'view',     'See bills and payment records.'),
  ('billing.manage',       'billing',       'manage',   'Settle, edit and re-issue bills.'),
  ('discounts.apply',      'discounts',     'apply',    'Apply configured discounts while selling.'),
  ('discounts.manage',     'discounts',     'manage',   'Create and edit discount definitions.'),
  ('refunds.view',         'refunds',       'view',     'See refund records.'),
  ('refunds.process',      'refunds',       'process',  'Process refunds on settled bills.'),
  ('refunds.manage',       'refunds',       'manage',   'Configure refund policy and overrides.'),
  ('menu.view',            'menu',          'view',     'See menu items, prices and availability.'),
  ('menu.manage',          'menu',          'manage',   'Create and edit menus, categories, products and prices.'),
  ('inventory.view',       'inventory',     'view',     'See stock levels and movements.'),
  ('inventory.manage',     'inventory',     'manage',   'Adjust stock, transfers and counts.'),
  ('purchasing.view',      'purchasing',    'view',     'See purchase orders and supplier records.'),
  ('purchasing.manage',    'purchasing',    'manage',   'Raise and approve purchase orders.'),
  ('customers.view',       'customers',     'view',     'See customer profiles and history.'),
  ('customers.manage',     'customers',     'manage',   'Create and edit customer profiles.'),
  ('reports.view',         'reports',       'view',     'See sales, product and performance reports.'),
  ('staff.view',           'staff',         'view',     'See the staff roster and assignments.'),
  ('staff.manage',         'staff',         'manage',   'Add staff, assign roles and outlets, activate/deactivate.'),
  ('settings.view',        'settings',      'view',     'See business settings.'),
  ('settings.manage',      'settings',      'manage',   'Edit business profile, tax and preferences.'),
  ('outlets.view',         'outlets',       'view',     'See outlet details.'),
  ('outlets.manage',       'outlets',       'manage',   'Create, edit and activate outlets.'),
  ('subscriptions.view',   'subscriptions', 'view',     'See the current plan and billing status.'),
  ('subscriptions.manage', 'subscriptions', 'manage',   'Change plans and payment methods.');

-- ── role → permission matrix ────────────────────────────────────────────────
--
-- Mirrors src/lib/rbac/permissions.ts (authoritative for enforcement).

create table public.role_permissions (
  role_key text not null references public.roles (key) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,
  primary key (role_key, permission_key)
);

insert into public.role_permissions (role_key, permission_key)
select r.key, p.key
from public.roles r
cross join public.permissions p
where r.key = 'owner';

insert into public.role_permissions (role_key, permission_key)
select 'business_admin', key from public.permissions
where key <> 'subscriptions.manage';

insert into public.role_permissions (role_key, permission_key) values
  -- outlet manager: operational control of their outlets
  ('outlet_manager', 'orders.view'), ('outlet_manager', 'orders.manage'),
  ('outlet_manager', 'billing.view'), ('outlet_manager', 'billing.manage'),
  ('outlet_manager', 'discounts.apply'), ('outlet_manager', 'discounts.manage'),
  ('outlet_manager', 'refunds.view'), ('outlet_manager', 'refunds.process'), ('outlet_manager', 'refunds.manage'),
  ('outlet_manager', 'menu.view'), ('outlet_manager', 'menu.manage'),
  ('outlet_manager', 'customers.view'), ('outlet_manager', 'customers.manage'),
  ('outlet_manager', 'reports.view'),
  ('outlet_manager', 'staff.view'),
  ('outlet_manager', 'inventory.view'),
  ('outlet_manager', 'settings.view'), ('outlet_manager', 'outlets.view'),
  -- cashier: sell, bill, apply discounts — nothing financial-administrative
  ('cashier', 'orders.view'), ('cashier', 'orders.manage'),
  ('cashier', 'billing.view'), ('cashier', 'billing.manage'),
  ('cashier', 'discounts.apply'),
  ('cashier', 'menu.view'), ('cashier', 'customers.view'),
  -- waiter: order taking + bill requests only (spec §19)
  ('waiter', 'orders.view'), ('waiter', 'orders.manage'),
  ('waiter', 'billing.view'), ('waiter', 'menu.view'), ('waiter', 'customers.view'),
  -- kitchen staff: incoming orders and the menu
  ('kitchen_staff', 'orders.view'), ('kitchen_staff', 'menu.view'),
  -- inventory manager: stock + purchasing
  ('inventory_manager', 'inventory.view'), ('inventory_manager', 'inventory.manage'),
  ('inventory_manager', 'purchasing.view'), ('inventory_manager', 'purchasing.manage'),
  ('inventory_manager', 'menu.view'), ('inventory_manager', 'reports.view'),
  -- accountant: read-only financial visibility
  ('accountant', 'billing.view'), ('accountant', 'refunds.view'),
  ('accountant', 'reports.view'), ('accountant', 'customers.view'),
  ('accountant', 'subscriptions.view');

-- ── lock the catalogue down ─────────────────────────────────────────────────

alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;

create policy "roles_select" on public.roles for select to authenticated using (true);
create policy "permissions_select" on public.permissions for select to authenticated using (true);
create policy "role_permissions_select" on public.role_permissions for select to authenticated using (true);

-- Defence in depth: even if a permissive policy ever appeared, API roles
-- must never write the RBAC catalogue.
revoke insert, update, delete on public.roles from anon, authenticated;
revoke insert, update, delete on public.permissions from anon, authenticated;
revoke insert, update, delete on public.role_permissions from anon, authenticated;

comment on table public.role_permissions is
  'Role→permission catalogue. Enforcement mirrors src/lib/rbac/permissions.ts; writes are service-role only.';
