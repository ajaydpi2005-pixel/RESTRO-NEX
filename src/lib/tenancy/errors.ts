/**
 * Tenancy error model.
 *
 * Every server-side tenant/outlet resolution failure maps to one of these
 * codes so future phases (auth middleware, server actions, UI) can react
 * consistently. Errors never leak internal identifiers or query details.
 */
export const TENANCY_ERROR_CODES = [
  "unauthenticated",
  "no-membership",
  "invalid-input",
  "ambiguous-business",
  "unknown-business",
  "ambiguous-outlet",
  "unknown-outlet",
  "outlet-not-accessible",
  "supabase-not-configured",
] as const;

export type TenancyErrorCode = (typeof TENANCY_ERROR_CODES)[number];

export class TenancyError extends Error {
  readonly code: TenancyErrorCode;

  constructor(code: TenancyErrorCode, message: string) {
    super(message);
    this.name = "TenancyError";
    this.code = code;
  }
}

export function isTenancyError(error: unknown): error is TenancyError {
  return error instanceof TenancyError;
}
