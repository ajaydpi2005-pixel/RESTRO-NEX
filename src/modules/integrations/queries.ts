import { rpc } from "./service";
import type { PanelData } from "./panel-types";

/**
 * Phase 18 — the settings panel's read. The database checks settings.manage and returns
 * only safe columns: no ciphertext and no job payloads. The caller must have checked
 * the page gate already, but the database check is the one that counts.
 */
export async function loadIntegrationPanel(
  actorId: string,
  businessId: string,
): Promise<PanelData> {
  const data = await rpc<Partial<PanelData> | null>("integration_panel_load", {
    p_actor: actorId,
    p_business_id: businessId,
  });
  return {
    accounts: data?.accounts ?? [],
    jobs: data?.jobs ?? [],
    logs: data?.logs ?? [],
    agents: data?.agents ?? [],
  };
}
