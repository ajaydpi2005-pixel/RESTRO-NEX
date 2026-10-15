import { NextResponse } from "next/server";
import { checkoutSchema } from "@/modules/online/schemas";
import { loadQrContext, loadStorefront, submitPublicOrder } from "@/modules/online/public-service";
import {
  clientFingerprint,
  isSameOriginRequest,
  NO_STORE_HEADERS,
  readJsonBody,
} from "@/modules/online/security";

/**
 * Phase 17 — public checkout. Anonymous, rate-limited in the database.
 *
 * The request names a restaurant by slug (online) or a printed QR token (table).
 * Tenant, outlet and QR identity are resolved here from those names, and the
 * client's ids are never trusted. Prices, tax, fees and status are computed in
 * the database. The response carries the order status but never the tracking secret.
 */

export const dynamic = "force-dynamic";

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return reply(403, { error: "This request was refused." });
  }

  const body = await readJsonBody(request);
  if (!body.ok) return reply(body.status, { error: body.message });

  const parsed = checkoutSchema.safeParse(body.value);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "form";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    // Missing fields carry library wording from zod. Show plain language instead.
    const first = parsed.error.issues[0];
    const message =
      first?.code === "invalid_type"
        ? "Some details are missing. Refresh the page and try again."
        : (first?.message ?? "Check the highlighted fields.");
    return reply(422, {
      error: message,
      fieldErrors,
    });
  }
  const input = parsed.data;
  const fingerprint = clientFingerprint(request.headers);

  if (input.channel === "online") {
    const storefront = await loadStorefront(input.businessSlug!, input.outletSlug!);
    if (!storefront) return reply(404, { error: "This restaurant is not available." });

    const result = await submitPublicOrder({
      ...input,
      fingerprint,
      businessId: storefront.business_id,
      outletId: storefront.outlet_id,
      qrCodeId: null,
    });
    if (!result.ok) return reply(result.failure.status, { error: result.failure.message });
    return reply(201, { order: result.order });
  }

  const qr = await loadQrContext(input.qrToken!);
  if (!qr) return reply(404, { error: "This QR code is not active. Ask a team member for help." });

  const result = await submitPublicOrder({
    ...input,
    fingerprint,
    businessId: qr.business_id,
    outletId: qr.outlet_id,
    qrCodeId: qr.qr_code_id,
  });
  if (!result.ok) return reply(result.failure.status, { error: result.failure.message });
  return reply(201, { order: result.order });
}
