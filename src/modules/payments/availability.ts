/**
 * Client-safe feature flag: whether this build can take customer payments.
 * Kept separate from the server-side ledger modules so client components can
 * import it without pulling in the service-role client.
 */
export const PAYMENT_COLLECTION_AVAILABLE = true;
