/**
 * RestroNex tenancy module — the single authority for "who may touch what".
 *
 * Database layer (RLS) filters every query; this module resolves tenant and
 * outlet selections server-side so no client-supplied id is ever trusted.
 */
export * from "@/lib/tenancy/directory";
export * from "@/lib/tenancy/errors";
export * from "@/lib/tenancy/schemas";
export { getTenantDirectory, resolveTenantSelection } from "@/lib/tenancy/service";
