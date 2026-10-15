import { createAdminClient } from "@/lib/supabase/admin";
import { getServerEnv } from "@/lib/env";
import { decryptCredentials, encryptCredentials, parseEncryptionKey, secretHint } from "./crypto";
import { defaultAdapters } from "./adapters";
import { findProvider, type ProviderKey, type IntegrationMode } from "./catalog";
import type { ClaimedJob, RuntimeAccount, WorkerDeps, FinishInput } from "./worker";

/**
 * Phase 18 — the only server path to the integration RPCs. It uses the service-role
 * client, and every RPC checks the actor's permission inside the database. Errors from
 * the database are shown only when they carry our own wording (P0001 / 42501 / P0002).
 * Everything else becomes a generic message, so table and function details never leak.
 */

export class IntegrationServiceError extends Error {}

const SHOWN_CODES = new Set(["P0001", "P0002", "42501"]);

export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    if (SHOWN_CODES.has(error.code ?? "")) throw new IntegrationServiceError(error.message);
    // Log the function name and code only. Arguments can contain credentials or payloads.
    console.error(`[integrations] rpc ${name} failed with code ${error.code ?? "unknown"}`);
    throw new IntegrationServiceError("Something went wrong. Please try again.");
  }
  return data as T;
}

export function encryptionKey(): Buffer {
  try {
    return parseEncryptionKey(getServerEnv().INTEGRATION_ENCRYPTION_KEY);
  } catch (error) {
    throw new IntegrationServiceError(
      error instanceof Error ? error.message : "Integration encryption is not configured.",
    );
  }
}

/** Loads one account plus its ciphertext for the server. Null when it does not exist. */
export async function loadRuntimeAccount(accountId: string): Promise<RuntimeAccount | null> {
  try {
    return await rpc<RuntimeAccount>("integration_runtime_load", { p_account_id: accountId });
  } catch (error) {
    if (error instanceof IntegrationServiceError && error.message === "Integration not found.")
      return null;
    throw error;
  }
}

/** Reads an account's credentials for a server-side send or test. Never sent to a client. */
export function readCredentials(account: RuntimeAccount): Record<string, string> {
  if (!account.ciphertext) return {};
  return decryptCredentials(account.ciphertext, account.account_id, encryptionKey());
}

/**
 * Saves an account's settings and, when new credentials are given, its encrypted
 * credentials. Credentials are encrypted with the account id as AAD, so the id is
 * learnt first (settings save), then the credentials are saved with the same settings.
 * The second call updates the same row.
 */
export async function saveAccount(input: {
  actor: string;
  businessId: string;
  outletId: string | null;
  provider: ProviderKey;
  mode: IntegrationMode;
  enabled: boolean;
  config: Record<string, unknown>;
  newCredentials: Record<string, string>;
  existingCiphertext?: string | null;
  existingCredentials?: Record<string, string>;
}): Promise<string> {
  const def = findProvider(input.provider);
  if (!def) throw new IntegrationServiceError("Choose an integration.");

  const base = {
    p_actor: input.actor,
    p_business_id: input.businessId,
    p_outlet_id: input.outletId,
    p_provider: input.provider,
    p_mode: input.mode,
    p_enabled: input.enabled,
    p_config: input.config,
  };

  const accountId = await rpc<string>("integration_account_save", {
    ...base,
    p_hints: null,
    p_ciphertext: null,
  });

  const hasNew = Object.keys(input.newCredentials).length > 0;
  if (!hasNew) return accountId;

  // Merge with the stored credentials so one changed field does not erase the others.
  const merged: Record<string, string> = {
    ...(input.existingCredentials ?? {}),
    ...input.newCredentials,
  };
  const key = encryptionKey();
  const ciphertext = encryptCredentials(merged, accountId, key);

  const hints: Record<string, string> = {};
  for (const field of def.credentialFields) {
    const value = merged[field.name];
    if (field.secret && typeof value === "string" && value.trim() !== "") {
      hints[field.name] = secretHint(value);
    }
  }

  await rpc<string>("integration_account_save", {
    ...base,
    p_hints: hints,
    p_ciphertext: ciphertext,
  });
  return accountId;
}

/** The worker's real dependencies: the database RPCs, the credential key and the adapters. */
export function productionWorkerDeps(): WorkerDeps {
  return {
    async claim(limit, leaseSeconds) {
      return rpc<ClaimedJob[]>("integration_job_claim", {
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
        p_business_id: null,
      });
    },
    loadAccount: loadRuntimeAccount,
    decrypt(ciphertext, accountId) {
      return decryptCredentials(ciphertext, accountId, encryptionKey());
    },
    adapters: defaultAdapters,
    async finish(input: FinishInput) {
      await rpc<string>("integration_job_finish", {
        p_job_id: input.jobId,
        p_outcome: input.outcome,
        p_error_code: input.errorCode,
        p_error_message: input.errorMessage,
        p_result: input.result,
        p_retry_after_seconds: null,
        p_duration_ms: input.durationMs,
        p_account_status: input.accountStatus,
      });
    },
    now: () => Date.now(),
  };
}
