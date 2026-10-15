import { findProvider, type IntegrationMode, type ProviderKey } from "./catalog";
import { buildEscPosDocument, PAPER_WIDTHS, type PaperWidth, type PrintLine } from "./escpos";

/**
 * Phase 18 — adapters. Each provider has a DEMO adapter and, where one exists, a live
 * stub.
 *  • DEMO adapters make no network calls. They say so in every result (`simulated: true`),
 *    and the UI labels the connection DEMO. Nothing sent by a DEMO adapter reaches a
 *    customer or a provider.
 *  • Live stubs fail with `not_built` (fatal). A stub never reports success, so a
 *    connection can never look live when it is not.
 *  • Live printing is NOT here. The server never opens a socket to a LAN printer. Live
 *    printer jobs are claimed by the on-site print agent (see `agent/print-agent.mjs`),
 *    which talks to the printer itself. The registry returns null for a live printer.
 *
 * Results never contain credentials, and they never echo message content.
 */

export interface AdapterContext {
  accountId: string;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
}

export type AdapterResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; retryable: boolean; fatal: boolean; code: string; message: string };

export interface IntegrationAdapter {
  readonly provider: ProviderKey;
  readonly mode: IntegrationMode;
  test(ctx: AdapterContext): Promise<AdapterResult>;
  send(
    ctx: AdapterContext,
    job: { operation: string; payload: Record<string, unknown> },
  ): Promise<AdapterResult>;
}

const NOT_BUILT: AdapterResult = {
  ok: false,
  retryable: false,
  fatal: true,
  code: "not_built",
  message: "Live delivery is not built in this release. Use DEMO mode.",
};

// ── DEMO ──────────────────────────────────────────────────────────────────

function demoAdapter(provider: ProviderKey): IntegrationAdapter {
  return {
    provider,
    mode: "demo",
    async test() {
      return { ok: true, result: { mode: "demo", simulated: true, check: "demo connection ok" } };
    },
    async send(ctx, job) {
      if (provider === "printer") {
        const parsed = parsePrintPayload(job.payload);
        if (!parsed.ok) return parsed.error;
        const bytes = buildEscPosDocument(parsed.lines, paperWidthOf(ctx.config));
        return {
          ok: true,
          result: {
            mode: "demo",
            simulated: true,
            note: "DEMO: no print job was sent to a printer.",
            lines: parsed.lines.length,
            bytes: bytes.length,
          },
        };
      }
      return {
        ok: true,
        result: {
          mode: "demo",
          simulated: true,
          operation: job.operation,
          note: "DEMO: nothing was sent to the provider.",
        },
      };
    },
  };
}

// ── Live stubs ────────────────────────────────────────────────────────────

function liveStub(provider: ProviderKey): IntegrationAdapter {
  return {
    provider,
    mode: "live",
    async test() {
      return NOT_BUILT;
    },
    async send() {
      return NOT_BUILT;
    },
  };
}

// ── Helpers and registry ──────────────────────────────────────────────────

export function paperWidthOf(config: Record<string, unknown>): PaperWidth {
  const value = Number(config.paper_width_chars);
  return (PAPER_WIDTHS as readonly number[]).includes(value) ? (value as PaperWidth) : 32;
}

type PrintPayloadResult = { ok: true; lines: PrintLine[] } | { ok: false; error: AdapterResult };

/** Re-checks the print payload here as well: the database stores it as opaque JSON. */
export function parsePrintPayload(payload: Record<string, unknown>): PrintPayloadResult {
  const raw = payload.lines;
  const bad: AdapterResult = {
    ok: false,
    retryable: false,
    fatal: false,
    code: "bad_payload",
    message: "The print job has no valid lines.",
  };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) return { ok: false, error: bad };
  const lines: PrintLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false, error: bad };
    const { text, bold, center } = item as Record<string, unknown>;
    if (typeof text !== "string" || text.length > 200) return { ok: false, error: bad };
    lines.push({ text, bold: bold === true, center: center === true });
  }
  return { ok: true, lines };
}

export interface AdapterRegistry {
  get(provider: ProviderKey, mode: IntegrationMode): IntegrationAdapter | null;
}

export function createAdapterRegistry(): AdapterRegistry {
  return {
    get(provider, mode) {
      const def = findProvider(provider);
      if (!def) return null;
      if (mode === "demo") return demoAdapter(provider);
      // Swiggy and Zomato have no live path at all. A null adapter means "refuse".
      if (provider === "swiggy" || provider === "zomato") return null;
      if (provider === "accounting_export") return null;
      // A live printer is served by the on-site print agent, never by the server worker.
      if (provider === "printer") return null;
      return liveStub(provider);
    },
  };
}

export const defaultAdapters = createAdapterRegistry();
