import { adminRpc } from "./rpc";
import { requireOperator } from "./session";
import type {
  AdminAuditRow,
  BusinessDetail,
  BusinessRow,
  IntegrationHealth,
  OperatorRow,
  OutletRow,
  OverrideListRow,
  Paged,
  PlanRow,
  PlatformHealth,
  SubscriptionList,
  SupportQueue,
  TenantAuditRow,
  TicketDetail,
  UsageOverview,
  UserDetail,
  UserRow,
} from "./types";

/**
 * Read-only loaders for the Super Admin dashboard. SERVER ONLY.
 *
 * Every loader calls requireOperator(permission) first, then one admin RPC that
 * checks the same permission in SQL. Each figure comes from a live query, and
 * anything not measured is labelled "not measured" in the UI, never zero.
 */

export interface PageArgs {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function loadOverviewHealth(): Promise<PlatformHealth> {
  const op = await requireOperator("view");
  return adminRpc<PlatformHealth>("admin_platform_health", { p_actor: op.userId });
}

export async function measureDatabaseLatency(): Promise<number> {
  const op = await requireOperator("view");
  const started = performance.now();
  await adminRpc<string>("admin_health_ping", { p_actor: op.userId });
  return Math.round(performance.now() - started);
}

export async function loadBusinesses(args: PageArgs): Promise<Paged<BusinessRow>> {
  const op = await requireOperator("view");
  return adminRpc<Paged<BusinessRow>>("admin_businesses_list", {
    p_actor: op.userId,
    p_search: args.search || null,
    p_status: args.status || null,
    p_limit: args.limit ?? 50,
    p_offset: args.offset ?? 0,
  });
}

export async function loadBusinessDetail(businessId: string): Promise<BusinessDetail> {
  const op = await requireOperator("view");
  return adminRpc<BusinessDetail>("admin_business_detail", {
    p_actor: op.userId,
    p_business_id: businessId,
  });
}

export async function loadOutlets(args: PageArgs): Promise<Paged<OutletRow>> {
  const op = await requireOperator("view");
  return adminRpc<Paged<OutletRow>>("admin_outlets_list", {
    p_actor: op.userId,
    p_search: args.search || null,
    p_limit: args.limit ?? 50,
    p_offset: args.offset ?? 0,
  });
}

export async function loadUsers(args: PageArgs): Promise<Paged<UserRow>> {
  const op = await requireOperator("view");
  return adminRpc<Paged<UserRow>>("admin_users_list", {
    p_actor: op.userId,
    p_search: args.search || null,
    p_limit: args.limit ?? 50,
    p_offset: args.offset ?? 0,
  });
}

export async function loadUserDetail(userId: string): Promise<UserDetail> {
  const op = await requireOperator("view");
  return adminRpc<UserDetail>("admin_user_detail", { p_actor: op.userId, p_user_id: userId });
}

export async function loadOperators(): Promise<OperatorRow[]> {
  const op = await requireOperator("view");
  return adminRpc<OperatorRow[]>("admin_operator_list", { p_actor: op.userId });
}

export async function loadPlans(): Promise<PlanRow[]> {
  const op = await requireOperator("view");
  return adminRpc<PlanRow[]>("admin_plans_list", { p_actor: op.userId });
}

export async function loadSubscriptions(args: PageArgs): Promise<SubscriptionList> {
  const op = await requireOperator("view");
  return adminRpc<SubscriptionList>("admin_subscriptions_list", {
    p_actor: op.userId,
    p_status: args.status || null,
    p_limit: args.limit ?? 50,
    p_offset: args.offset ?? 0,
  });
}

export async function loadOverrides(): Promise<OverrideListRow[]> {
  const op = await requireOperator("view");
  return adminRpc<OverrideListRow[]>("admin_overrides_list", { p_actor: op.userId });
}

export async function loadUsage(days: number): Promise<UsageOverview> {
  const op = await requireOperator("view");
  return adminRpc<UsageOverview>("admin_usage_overview", { p_actor: op.userId, p_days: days });
}

export async function loadIntegrationHealth(): Promise<IntegrationHealth> {
  const op = await requireOperator("view");
  return adminRpc<IntegrationHealth>("admin_integration_health", {
    p_actor: op.userId,
    p_limit: 200,
  });
}

export async function loadSupportQueue(args: PageArgs): Promise<SupportQueue> {
  const op = await requireOperator("view");
  return adminRpc<SupportQueue>("admin_support_queue", {
    p_actor: op.userId,
    p_status: args.status || null,
    p_limit: args.limit ?? 50,
    p_offset: args.offset ?? 0,
  });
}

export async function loadSupportTicket(ticketId: string): Promise<TicketDetail> {
  const op = await requireOperator("view");
  return adminRpc<TicketDetail>("admin_support_ticket", {
    p_actor: op.userId,
    p_ticket_id: ticketId,
  });
}

export async function loadAdminAudit(args: {
  businessId?: string;
  limit?: number;
  offset?: number;
}): Promise<Paged<AdminAuditRow>> {
  const op = await requireOperator("view");
  return adminRpc<Paged<AdminAuditRow>>("admin_audit_list", {
    p_actor: op.userId,
    p_business_id: args.businessId || null,
    p_limit: args.limit ?? 50,
    p_offset: args.offset ?? 0,
  });
}

/**
 * Reads a business's tenant audit trail. Per the decision recorded in
 * docs/SUPER_ADMIN.md, these reads are not logged; only changes are.
 */
export async function loadTenantAudit(args: {
  businessId: string;
  prefix?: string;
  limit?: number;
  offset?: number;
}): Promise<Paged<TenantAuditRow>> {
  const op = await requireOperator("view");
  return adminRpc<Paged<TenantAuditRow>>("admin_tenant_audit_list", {
    p_actor: op.userId,
    p_business_id: args.businessId,
    p_action_prefix: args.prefix || null,
    p_limit: args.limit ?? 50,
    p_offset: args.offset ?? 0,
  });
}
