/**
 * Response shapes of the admin_* RPCs (see supabase/migrations/20261017100000_super_admin.sql).
 * Keep these in step with the SQL. Every number in the dashboard is one of these fields.
 */

export interface Paged<T> {
  total: number;
  rows: T[];
}

export type BusinessStatus = "active" | "suspended" | "closed";
export type SubscriptionStatus = "trial" | "active" | "past_due" | "cancelled";
export type TicketStatus = "open" | "waiting_customer" | "resolved";
export type TicketPriority = "normal" | "urgent";

export interface BusinessRow {
  id: string;
  name: string;
  slug: string;
  status: BusinessStatus;
  created_at: string;
  subscription_status: SubscriptionStatus | null;
  trial_ends_at: string | null;
  plan_code: string | null;
  outlet_count: number;
  active_staff: number;
}

export interface OutletRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  currency_code: string;
  timezone: string;
  created_at?: string;
  business_id?: string;
  business_name?: string;
  business_status?: BusinessStatus;
}

export interface MemberRow {
  membership_id: string;
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  status: string;
  created_at: string;
}

export interface EntitlementRow {
  feature_key: string;
  label: string;
  kind: "boolean" | "limit";
  unit: string | null;
  enforced: boolean;
  included: boolean;
  limit_value: number | null;
  source: "override" | "plan" | "none";
}

export interface OverrideRow {
  feature_key: string;
  included: boolean | null;
  limit_value: number | null;
  reason: string;
  updated_at: string;
}

export interface UsageRow {
  since: string;
  outlets: number;
  active_staff: number;
  orders: number;
  channel_orders: number;
  last_order_at: string | null;
  payments_captured: number;
  payments_captured_minor_by_currency: { currency_code: string; minor: number }[];
  integration_jobs: number;
  integration_jobs_dead: number;
  customers_all_time: number;
  open_support_tickets: number;
}

export interface BusinessDetail {
  business: {
    id: string;
    name: string;
    slug: string;
    status: BusinessStatus;
    created_at: string;
    updated_at: string;
  };
  subscription: {
    plan_code: string;
    plan_name: string;
    status: SubscriptionStatus;
    trial_ends_at: string | null;
    current_period_ends_at: string | null;
    last_change_reason: string | null;
    updated_at: string;
  } | null;
  outlets: OutletRow[];
  members: MemberRow[];
  entitlements: EntitlementRow[];
  overrides: (OverrideRow & { feature_key: string })[];
  usage_30d: UsageRow;
}

export interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  active_memberships: number;
  operator_role: string | null;
}

export interface UserDetail {
  user: {
    id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
    full_name: string | null;
    phone: string | null;
  };
  operator: { role: string; revoked: boolean } | null;
  memberships: {
    membership_id: string;
    business_id: string;
    business_name: string;
    role: string;
    status: string;
    created_at: string;
  }[];
}

export interface OperatorRow {
  user_id: string;
  email: string | null;
  role: "super_admin" | "support" | "read_only";
  granted_at: string;
  revoked_at: string | null;
}

export interface PlanFeature {
  feature_key: string;
  label: string;
  kind: "boolean" | "limit";
  unit: string | null;
  enforced: boolean;
  included: boolean;
  limit_value: number | null;
}

export interface PlanRow {
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  businesses: number;
  features: PlanFeature[];
}

export interface SubscriptionRow {
  business_id: string;
  business_name: string;
  business_status: BusinessStatus;
  plan_code: string;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_ends_at: string | null;
  last_change_reason: string | null;
  updated_at: string;
  trial_ending_soon: boolean;
}

export interface SubscriptionList extends Paged<SubscriptionRow> {
  counts: {
    trial: number;
    active: number;
    past_due: number;
    cancelled: number;
    businesses_without_subscription: number;
  };
}

export interface OverrideListRow {
  business_id: string;
  business_name: string;
  feature_key: string;
  label: string;
  included: boolean | null;
  limit_value: number | null;
  reason: string;
  updated_at: string;
}

export interface UsageOverview {
  window_days: number;
  since: string;
  measured_at: string;
  totals: {
    businesses: number;
    outlets: number;
    active_staff: number;
    orders: number;
    channel_orders: number;
    payments_captured: number;
    payments_captured_minor_by_currency: { currency_code: string; minor: number }[];
    integration_jobs: number;
    customers_all_time: number;
  };
  businesses: {
    id: string;
    name: string;
    status: BusinessStatus;
    usage: UsageRow;
    outlets_limit: number | null;
    staff_limit: number | null;
  }[];
}

export interface PlatformHealth {
  measured_at: string;
  businesses: { active: number; suspended: number; closed: number };
  subscriptions: {
    trial: number;
    active: number;
    past_due: number;
    cancelled: number;
    trial_ending_7d: number;
  };
  integrations: {
    accounts_total: number;
    accounts_in_error: number;
    accounts_live_enabled: number;
    accounts_demo_enabled: number;
    jobs_pending: number;
    jobs_running: number;
    jobs_dead: number;
    oldest_due_job_seconds: number | null;
    attempts_failed_24h: number;
    attempts_retry_scheduled_24h: number;
  };
  webhooks: {
    last_received_at: string | null;
    received_24h: number;
    failed_24h: number;
  };
  agents: { registered: number; online_5m: number; revoked: number };
  support: { open: number; waiting_customer: number; urgent_unresolved: number };
  admin_actions_24h: number;
  tenant_audit_events_24h: number;
}

export interface AccountHealthRow {
  id: string;
  business_id: string;
  business_name: string;
  outlet_id: string | null;
  outlet_name: string | null;
  provider: string;
  mode: "demo" | "live";
  enabled: boolean;
  status: "not_configured" | "untested" | "connected" | "error";
  last_tested_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  pending_jobs: number;
  dead_jobs: number;
  failed_attempts_24h: number;
}

export interface AgentHealthRow {
  id: string;
  business_id: string;
  business_name: string;
  outlet_id: string | null;
  outlet_name: string | null;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  state: "online" | "offline" | "revoked";
}

export interface IntegrationHealth {
  accounts: AccountHealthRow[];
  agents: AgentHealthRow[];
}

export interface TicketRow {
  id: string;
  business_id: string;
  business_name: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigned_to: string | null;
  last_message_at: string;
  created_at: string;
  message_count: number;
}

export interface SupportQueue extends Paged<TicketRow> {
  counts: {
    open: number;
    waiting_customer: number;
    resolved: number;
    urgent_unresolved: number;
  };
}

export interface TicketDetail {
  ticket: {
    id: string;
    business_id: string;
    business_name: string;
    subject: string;
    status: TicketStatus;
    priority: TicketPriority;
    assigned_to: string | null;
    assigned_email: string | null;
    opened_by_email: string | null;
    created_at: string;
    last_message_at: string;
    resolved_at: string | null;
  };
  messages: {
    id: string;
    author_side: "business" | "support" | "note";
    author_email: string | null;
    body: string;
    created_at: string;
  }[];
}

export interface AdminAuditRow {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  business_id: string | null;
  reason: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

export interface TenantAuditRow {
  id: string;
  created_at: string;
  action: string;
  target_type: string;
  target_id: string | null;
  outlet_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

export interface TenantSupportTicket {
  id: string;
  subject: string;
  status: TicketStatus;
  created_at: string;
  last_message_at: string;
  messages: { id: string; author_side: "business" | "support"; body: string; created_at: string }[];
}
