import type { AdapterRegistry, AdapterResult } from "./adapters";
import type { IntegrationMode, ProviderKey } from "./catalog";

/**
 * Phase 18 — the job worker. It is a pure pipeline with injected dependencies, so the
 * same logic runs in the route and in the tests.
 *
 * For each claimed job:
 *   1. Load the account (service-only RPC). Missing → fail.
 *   2. Account disabled or not connected → retry later (an operator can fix it).
 *   3. Decrypt credentials with the account id as AAD. Unreadable → fail, connection error.
 *   4. Pick the adapter for (provider, mode). None → fail (Swiggy/Zomato live).
 *   5. Send. Success → succeeded. Retryable error → retry (backoff in the database).
 *      Fatal error → fail, and the connection is marked error.
 *
 * Error text stored in the database is short, fixed and free of credentials.
 */

export interface ClaimedJob {
  job_id: string;
  account_id: string;
  business_id: string;
  operation: string;
  payload: Record<string, unknown>;
  attempt_no: number;
  max_attempts: number;
}

export interface RuntimeAccount {
  account_id: string;
  business_id: string;
  outlet_id: string | null;
  provider: ProviderKey;
  mode: IntegrationMode;
  enabled: boolean;
  status: "not_configured" | "untested" | "connected" | "error";
  config: Record<string, unknown>;
  ciphertext: string | null;
}

export type FinishOutcome = "succeeded" | "retry" | "failed";

export interface FinishInput {
  jobId: string;
  outcome: FinishOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown>;
  accountStatus: "error" | null;
  durationMs: number;
}

export interface WorkerDeps {
  claim(limit: number, leaseSeconds: number): Promise<ClaimedJob[]>;
  loadAccount(accountId: string): Promise<RuntimeAccount | null>;
  decrypt(ciphertext: string, accountId: string): Record<string, string>;
  adapters: AdapterRegistry;
  finish(input: FinishInput): Promise<void>;
  now(): number;
}

export interface BatchSummary {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
}

export const MAX_BATCH = 25;
export const LEASE_SECONDS = 120;

const MAX_MESSAGE = 300;
const MAX_CODE = 60;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function retry(job: ClaimedJob, code: string, message: string, durationMs: number): FinishInput {
  return {
    jobId: job.job_id,
    outcome: "retry",
    errorCode: clip(code, MAX_CODE),
    errorMessage: clip(message, MAX_MESSAGE),
    result: {},
    accountStatus: null,
    durationMs,
  };
}

function fail(
  job: ClaimedJob,
  code: string,
  message: string,
  durationMs: number,
  accountStatus: "error" | null,
): FinishInput {
  return {
    jobId: job.job_id,
    outcome: "failed",
    errorCode: clip(code, MAX_CODE),
    errorMessage: clip(message, MAX_MESSAGE),
    result: {},
    accountStatus,
    durationMs,
  };
}

/** Decides the outcome for one claimed job. Pure given its dependencies. */
export async function planJob(job: ClaimedJob, deps: WorkerDeps): Promise<FinishInput> {
  const started = deps.now();
  const elapsed = () => Math.max(0, deps.now() - started);

  const account = await deps.loadAccount(job.account_id);
  if (!account || account.business_id !== job.business_id) {
    return fail(job, "account_missing", "The connection no longer exists.", elapsed(), null);
  }
  if (!account.enabled) {
    return retry(job, "account_disabled", "The connection is turned off.", elapsed());
  }
  if (account.status !== "connected") {
    return retry(
      job,
      "account_not_connected",
      "The connection has not passed its last test.",
      elapsed(),
    );
  }

  let credentials: Record<string, string> = {};
  if (account.ciphertext) {
    try {
      credentials = deps.decrypt(account.ciphertext, account.account_id);
    } catch {
      return fail(
        job,
        "credentials_unreadable",
        "The stored credentials could not be read.",
        elapsed(),
        "error",
      );
    }
  }

  const adapter = deps.adapters.get(account.provider, account.mode);
  if (!adapter) {
    return fail(
      job,
      "no_adapter",
      "This integration has no live path. Use DEMO mode.",
      elapsed(),
      null,
    );
  }

  let outcome: AdapterResult;
  try {
    outcome = await adapter.send(
      { accountId: account.account_id, config: account.config, credentials },
      { operation: job.operation, payload: job.payload },
    );
  } catch {
    // Adapter internals are not shown: the message is generic and the job retries.
    return retry(
      job,
      "adapter_error",
      "The integration returned an unexpected error. It will be retried.",
      elapsed(),
    );
  }

  if (outcome.ok) {
    return {
      jobId: job.job_id,
      outcome: "succeeded",
      errorCode: null,
      errorMessage: null,
      result: outcome.result,
      accountStatus: null,
      durationMs: elapsed(),
    };
  }
  if (outcome.fatal) {
    return fail(job, outcome.code, outcome.message, elapsed(), "error");
  }
  if (outcome.retryable) {
    return retry(job, outcome.code, outcome.message, elapsed());
  }
  return fail(job, outcome.code, outcome.message, elapsed(), null);
}

export async function runWorkerBatch(deps: WorkerDeps, limit: number): Promise<BatchSummary> {
  const size = Math.min(Math.max(1, Math.trunc(limit)), MAX_BATCH);
  const jobs = await deps.claim(size, LEASE_SECONDS);
  const summary: BatchSummary = { claimed: jobs.length, succeeded: 0, retried: 0, failed: 0 };

  for (const job of jobs) {
    const plan = await planJob(job, deps);
    await deps.finish(plan);
    if (plan.outcome === "succeeded") summary.succeeded += 1;
    else if (plan.outcome === "retry") summary.retried += 1;
    else summary.failed += 1;
  }
  return summary;
}
