import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Super Admin RPC bridge. SERVER ONLY.
 *
 * Every platform read and write goes through a `public.admin_*` function,
 * which only the service role may execute. Each function starts with
 * platform.require_operator(actor, permission), so the database enforces the
 * check even if this layer were bypassed.
 *
 * Error messages are shown only for codes the database uses for user-facing
 * refusals (P0001 business rule, P0002 not found, 42501 access). Anything else
 * is logged by code and replaced with a generic message, so driver or SQL
 * detail never reaches the browser.
 */

export class AdminServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminServiceError";
  }
}

/** The database reports a missing record with P0002. Pages turn it into a 404. */
export class AdminNotFoundError extends AdminServiceError {
  constructor(message: string) {
    super(message);
    this.name = "AdminNotFoundError";
  }
}

const SHOWN_CODES = new Set(["P0001", "P0002", "42501"]);

/** Awaits an admin read and returns 404 for a missing record. Other errors pass through. */
export async function orNotFound<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof AdminNotFoundError) notFound();
    throw error;
  }
}

export async function adminRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    if (error.code === "P0002") throw new AdminNotFoundError(error.message);
    if (SHOWN_CODES.has(error.code ?? "")) {
      throw new AdminServiceError(error.message);
    }
    // Log the function name and code only. Arguments can include reasons and bodies.
    console.error(`[admin] rpc ${name} failed with code ${error.code ?? "unknown"}`);
    throw new AdminServiceError("Something went wrong. Please try again.");
  }
  return data as T;
}

/** Message for an action response. Only our own wording reaches the UI. */
export function adminServiceMessage(error: unknown): string {
  if (error instanceof AdminServiceError) return error.message;
  return "Something went wrong. Please try again.";
}
