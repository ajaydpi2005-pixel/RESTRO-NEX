import type { IntegrationMode, ProviderKey } from "./catalog";

/** Phase 18 — the shapes the settings panel receives. No credential values, only hints. */

export interface AccountRow {
  id: string;
  provider: ProviderKey;
  mode: IntegrationMode;
  enabled: boolean;
  status: "not_configured" | "untested" | "connected" | "error";
  outlet_id: string | null;
  config: Record<string, unknown>;
  credential_hints: Record<string, string>;
  last_tested_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

export interface JobRow {
  id: string;
  account_id: string;
  operation: string;
  status: "pending" | "running" | "succeeded" | "dead";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error_code: string | null;
  last_error: string | null;
  created_at: string;
}

export interface LogRow {
  id: string;
  account_id: string;
  job_id: string | null;
  attempt_no: number | null;
  operation: string;
  outcome: "succeeded" | "retry_scheduled" | "failed" | "exhausted";
  error_code: string | null;
  error_message: string | null;
  mode: IntegrationMode;
  created_at: string;
}

export interface AgentRow {
  id: string;
  outlet_id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface PanelData {
  accounts: AccountRow[];
  jobs: JobRow[];
  logs: LogRow[];
  agents: AgentRow[];
}
