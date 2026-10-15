"use server";

import { revalidatePath } from "next/cache";
import { getSessionUserId, permissionErrorMessage, requirePermission } from "@/lib/rbac/enforce";
import { randomToken } from "@/modules/online/security";
import {
  IntegrationServiceError,
  loadRuntimeAccount,
  readCredentials,
  rpc,
  saveAccount,
} from "./service";
import { defaultAdapters, type AdapterResult } from "./adapters";
import { generateAgentToken, hashAgentToken as hashAgentTokenFor } from "./agent";
import { printerHostSaveError } from "./printer-guard";
import {
  accountActionSchema,
  agentRegisterSchema,
  agentRevokeSchema,
  enabledSchema,
  jobRetrySchema,
  PRINT_TEST_LINES,
  printTestSchema,
  saveSchema,
  validateSave,
} from "./schemas";
import { CredentialDecryptError, CryptoConfigError } from "./crypto";
import type { z } from "zod";

/**
 * Phase 18 — staff actions for the integrations settings page.
 *
 * Security model (same as Phase 17):
 *  • The actor is the session user. Form input never supplies it.
 *  • Each action checks settings.manage in TypeScript for a fast answer, and the database
 *    checks it again and checks the tenant and outlet. The database is the authority.
 *  • Credentials are encrypted before they reach the database, and they are never returned.
 *  • Error messages are our own wording or a generic fallback. Nothing from the adapter
 *    or the database is shown raw.
 */

export type ActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: string };

const GENERIC = "Something went wrong. Please try again.";
const SIGN_IN_AGAIN = "Please sign in again.";

function zodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the highlighted fields.";
}

function errorMessage(error: unknown): string {
  if (error instanceof IntegrationServiceError) return error.message;
  if (error instanceof CryptoConfigError)
    return "Integration encryption is not configured on the server.";
  if (error instanceof CredentialDecryptError) {
    return "The stored credentials cannot be read. Re-enter every credential field and save again.";
  }
  return GENERIC;
}

async function actor(): Promise<{ userId: string } | { error: string }> {
  const userId = await getSessionUserId();
  return userId ? { userId } : { error: SIGN_IN_AGAIN };
}

function revalidate() {
  revalidatePath("/settings/integrations");
}

export async function saveIntegrationAction(
  input: unknown,
): Promise<ActionResult<{ accountId: string }>> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const who = await actor();
  if ("error" in who) return { ok: false, error: who.error };

  const rule = validateSave(parsed.data);
  if (rule) return { ok: false, error: rule };
  if (parsed.data.provider === "printer" && parsed.data.mode === "live") {
    const hostError = printerHostSaveError(String(parsed.data.config.host ?? ""));
    if (hostError) return { ok: false, error: hostError };
  }

  try {
    await requirePermission({ businessId: parsed.data.businessId, permission: "settings.manage" });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  const d = parsed.data;
  try {
    // Existing credentials are read first, so a partial update does not erase the others.
    let existingCiphertext: string | null = null;
    let existingCredentials: Record<string, string> = {};
    if (d.accountId) {
      const current = await loadRuntimeAccount(d.accountId);
      // Only reuse credentials from the exact same scope (provider and outlet).
      const sameScope =
        current !== null &&
        current.provider === d.provider &&
        (current.outlet_id ?? null) === (d.outletId ?? null);
      if (current && current.business_id === d.businessId && sameScope) {
        existingCiphertext = current.ciphertext;
        existingCredentials = current.ciphertext ? readCredentials(current) : {};
      }
    }

    const newCredentials = Object.fromEntries(
      Object.entries(d.credentials).filter(([, v]) => v.trim() !== ""),
    ) as Record<string, string>;

    const accountId = await saveAccount({
      actor: who.userId,
      businessId: d.businessId,
      outletId: d.outletId ?? null,
      provider: d.provider,
      mode: d.mode,
      enabled: d.enabled,
      config: d.config,
      newCredentials,
      existingCiphertext,
      existingCredentials,
    });
    revalidate();
    return { ok: true, accountId };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function setIntegrationEnabledAction(input: unknown): Promise<ActionResult> {
  const parsed = enabledSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const who = await actor();
  if ("error" in who) return { ok: false, error: who.error };
  try {
    await requirePermission({ businessId: parsed.data.businessId, permission: "settings.manage" });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }
  try {
    await rpc("integration_account_set_enabled", {
      p_actor: who.userId,
      p_business_id: parsed.data.businessId,
      p_account_id: parsed.data.accountId,
      p_enabled: parsed.data.enabled,
    });
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Runs the provider's connection test now and records the result. A DEMO test makes no
 * network call. A live test would do so, and no live test is available in this build.
 */
export async function testIntegrationAction(
  input: unknown,
): Promise<ActionResult<{ message: string }>> {
  const parsed = accountActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const who = await actor();
  if ("error" in who) return { ok: false, error: who.error };
  try {
    await requirePermission({ businessId: parsed.data.businessId, permission: "settings.manage" });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }

  try {
    const account = await loadRuntimeAccount(parsed.data.accountId);
    if (!account || account.business_id !== parsed.data.businessId) {
      return { ok: false, error: "That connection was not found." };
    }

    // A live printer is tested by its print agent. The result arrives from the agent's
    // report, so nothing is recorded here.
    if (account.provider === "printer" && account.mode === "live") {
      await rpc<string>("integration_enqueue", {
        p_actor: who.userId,
        p_business_id: parsed.data.businessId,
        p_account_id: parsed.data.accountId,
        p_operation: "connection.test",
        p_idempotency_key: `test-${randomToken(12)}`,
        p_payload: {},
      });
      revalidate();
      return {
        ok: true,
        message:
          "Test queued. The print agent for this outlet will check the printer shortly. Keep the agent running.",
      };
    }

    const started = Date.now();
    let outcome: AdapterResult;
    try {
      const adapter = defaultAdapters.get(account.provider, account.mode);
      if (!adapter) {
        outcome = {
          ok: false,
          retryable: false,
          fatal: true,
          code: "no_adapter",
          message: "This integration has no live path. Use DEMO mode.",
        };
      } else {
        outcome = await adapter.test({
          accountId: account.account_id,
          config: account.config,
          credentials: readCredentials(account),
        });
      }
    } catch {
      outcome = {
        ok: false,
        retryable: false,
        fatal: true,
        code: "adapter_error",
        message: "The connection test failed unexpectedly.",
      };
    }
    const duration = Math.max(0, Date.now() - started);

    await rpc("integration_test_result", {
      p_actor: who.userId,
      p_business_id: parsed.data.businessId,
      p_account_id: parsed.data.accountId,
      p_ok: outcome.ok,
      p_error_code: outcome.ok ? null : outcome.code.slice(0, 60),
      p_error_message: outcome.ok ? null : outcome.message.slice(0, 500),
      p_duration_ms: duration,
    });
    revalidate();

    if (outcome.ok) {
      return {
        ok: true,
        message:
          account.mode === "demo"
            ? "DEMO connection ok. Nothing was sent to the provider."
            : "Connection ok.",
      };
    }
    return { ok: false, error: outcome.message };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Queues a one-page test print. A scheduler must call the worker route to send it. */
export async function queuePrintTestAction(
  input: unknown,
): Promise<ActionResult<{ jobId: string }>> {
  const parsed = printTestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const who = await actor();
  if ("error" in who) return { ok: false, error: who.error };
  try {
    await requirePermission({ businessId: parsed.data.businessId, permission: "settings.manage" });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }
  try {
    const account = await loadRuntimeAccount(parsed.data.accountId);
    if (
      !account ||
      account.business_id !== parsed.data.businessId ||
      account.provider !== "printer"
    ) {
      return { ok: false, error: "That printer was not found." };
    }
    const jobId = await rpc<string>("integration_enqueue", {
      p_actor: who.userId,
      p_business_id: parsed.data.businessId,
      p_account_id: parsed.data.accountId,
      p_operation: "print.document",
      p_idempotency_key: `test-${randomToken(12)}`,
      p_payload: {
        lines: PRINT_TEST_LINES.map((text, i) => ({ text, bold: i === 0, center: true })),
      },
    });
    revalidate();
    return { ok: true, jobId };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function retryIntegrationJobAction(input: unknown): Promise<ActionResult> {
  const parsed = jobRetrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const who = await actor();
  if ("error" in who) return { ok: false, error: who.error };
  try {
    await rpc("integration_job_retry", {
      p_actor: who.userId,
      p_business_id: parsed.data.businessId,
      p_job_id: parsed.data.jobId,
    });
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Registers an on-site print agent for an outlet. The token is returned once, here, and
 * is not stored: only its hash reaches the database.
 */
export async function registerPrintAgentAction(
  input: unknown,
): Promise<ActionResult<{ agentId: string; token: string }>> {
  const parsed = agentRegisterSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const who = await actor();
  if ("error" in who) return { ok: false, error: who.error };
  try {
    await requirePermission({ businessId: parsed.data.businessId, permission: "settings.manage" });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }
  const token = generateAgentToken();
  try {
    const agentId = await rpc<string>("integration_agent_register", {
      p_actor: who.userId,
      p_business_id: parsed.data.businessId,
      p_outlet_id: parsed.data.outletId,
      p_name: parsed.data.name,
      p_token_hash: hashAgentTokenFor(token),
    });
    revalidate();
    return { ok: true, agentId, token };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function revokePrintAgentAction(input: unknown): Promise<ActionResult> {
  const parsed = agentRevokeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const who = await actor();
  if ("error" in who) return { ok: false, error: who.error };
  try {
    await requirePermission({ businessId: parsed.data.businessId, permission: "settings.manage" });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }
  try {
    await rpc("integration_agent_revoke", {
      p_actor: who.userId,
      p_business_id: parsed.data.businessId,
      p_agent_id: parsed.data.agentId,
    });
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
