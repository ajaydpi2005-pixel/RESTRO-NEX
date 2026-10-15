import { isIP } from "node:net";
import { promises as dnsPromises, type LookupAddress } from "node:dns";

/**
 * Phase 18 — printer address guard. The server must not reach arbitrary addresses on
 * a printer's behalf. Before any socket opens, every address the host resolves to is
 * checked. A host is refused when any resolved address is:
 *   • loopback (127.0.0.0/8, ::1) — would reach this server's own services
 *   • link-local (169.254.0.0/16, fe80::/10) — includes the cloud metadata endpoint
 *   • unspecified (0.0.0.0, ::) or broadcast
 *   • multicast or reserved
 *   • an IPv4-mapped IPv6 address whose IPv4 part is any of the above
 * Private LAN ranges (10/8, 172.16/12, 192.168/16) are allowed: a network printer is
 * normally on a LAN the operator controls. The port is fixed at 9100 and is never
 * taken from configuration.
 *
 * The resolved address is what the socket connects to, so the check cannot be
 * bypassed by DNS changing between the check and the connection.
 */

export const PRINTER_PORT = 9100;

export type GuardResult = { ok: true; address: string } | { ok: false; reason: string };

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const BLOCKED_HOSTNAMES = ["localhost", "metadata.google.internal"];

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** Returns a reason when the IPv4 address must not be reached, or null when it may. */
export function blockedIPv4Reason(ip: string): string | null {
  const p = ipv4Parts(ip);
  if (!p) return "not an IPv4 address";
  const a = p[0] ?? -1;
  const b = p[1] ?? -1;
  if (a === 0) return "unspecified address";
  if (a === 127) return "loopback address";
  if (a === 169 && b === 254) return "link-local address";
  if (a >= 224 && a <= 239) return "multicast address";
  if (a >= 240) return "reserved address";
  return null;
}

/** Returns a reason when the IPv6 address must not be reached, or null when it may. */
export function blockedIPv6Reason(ip: string): string | null {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return blockedIPv4Reason(mapped[1] ?? "");
  if (lower === "::" || /^0+(:0+)*$/.test(lower)) return "unspecified address";
  if (lower === "::1" || /^0+(:0+)*:1$/.test(lower)) return "loopback address";
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return "link-local address";
  if (lower.startsWith("ff")) return "multicast address";
  return null;
}

export function blockedAddressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return blockedIPv4Reason(address);
  if (family === 6) return blockedIPv6Reason(address);
  return "not an IP address";
}

/**
 * Checks a printer host name or literal address, resolving names first. Every resolved
 * address must pass. A host that does not resolve is refused.
 */
export async function guardPrinterHost(
  host: string,
  resolve: (name: string) => Promise<LookupAddress[]> = (name) =>
    dnsPromises.lookup(name, { all: true, verbatim: true }),
): Promise<GuardResult> {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: "No printer address is set." };
  if (trimmed.length > 253) return { ok: false, reason: "The printer address is too long." };
  if (BLOCKED_HOSTNAMES.includes(trimmed) || trimmed.endsWith(".localhost")) {
    return { ok: false, reason: "That printer address is not allowed." };
  }
  if (!isIP(trimmed) && !HOSTNAME_RE.test(trimmed)) {
    return { ok: false, reason: "The printer address is not a valid host name or IP address." };
  }

  // An IP literal needs no lookup: it is checked as written.
  let addresses: LookupAddress[];
  if (isIP(trimmed)) {
    addresses = [{ address: trimmed, family: isIP(trimmed) }];
  } else {
    try {
      addresses = await resolve(trimmed);
    } catch {
      return { ok: false, reason: "The printer address could not be resolved." };
    }
  }
  if (addresses.length === 0)
    return { ok: false, reason: "The printer address could not be resolved." };

  for (const entry of addresses) {
    const reason = blockedAddressReason(entry.address);
    if (reason) return { ok: false, reason: `That printer address is a ${reason}.` };
  }
  const first = addresses[0];
  if (!first) return { ok: false, reason: "The printer address could not be resolved." };
  return { ok: true, address: first.address };
}

/**
 * Save-time check for a live printer host. IP literals are checked now. Host names are
 * checked by the print agent when it connects, because only the agent's network can
 * resolve the LAN. Numeric-only names (such as 2130706433) are refused here, since some
 * resolvers read them as IPv4 shorthand.
 */
export function printerHostSaveError(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return "Enter the printer's IP address or host name.";
  if (BLOCKED_HOSTNAMES.includes(trimmed) || trimmed.endsWith(".localhost")) {
    return "That printer address is not allowed.";
  }
  if (isIP(trimmed)) {
    const reason = blockedAddressReason(trimmed);
    return reason ? `That printer address is a ${reason}.` : null;
  }
  if (/^[0-9]+$/.test(trimmed) || /^0x[0-9a-f]+$/.test(trimmed)) {
    return "Enter the printer's IP address in dotted form, such as 192.168.1.50.";
  }
  return null;
}
