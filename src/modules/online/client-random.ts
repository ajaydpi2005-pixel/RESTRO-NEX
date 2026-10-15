/**
 * Phase 17 — browser-side random tokens for checkout. Uses the Web Crypto API,
 * never Math.random. The output is url-safe, which matches the server's checks.
 */
export function randomUrlSafe(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Integer paise → "1,234.50". Display only; the server computes every amount. */
export function formatRupees(minor: number): string {
  return (minor / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
