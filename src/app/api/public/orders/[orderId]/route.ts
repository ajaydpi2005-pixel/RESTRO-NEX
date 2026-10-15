import { NextResponse } from "next/server";
import { loadPublicOrderStatus } from "@/modules/online/public-service";
import { NO_STORE_HEADERS } from "@/modules/online/security";
import { orderIdSchema, trackingSecretSchema } from "@/modules/online/schemas";

/**
 * Phase 17 — order status for the customer. The tracking secret comes in a request
 * header, never in the URL, so it stays out of proxy and access logs. Wrong or
 * missing secrets get the same 404 as an unknown order, so ids can't be probed.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const id = orderIdSchema.safeParse(orderId);
  const secret = trackingSecretSchema.safeParse(request.headers.get("x-tracking-secret") ?? "");
  if (!id.success || !secret.success) {
    return NextResponse.json(
      { error: "Order not found." },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  const order = await loadPublicOrderStatus(id.data, secret.data);
  if (!order) {
    return NextResponse.json(
      { error: "Order not found." },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  return NextResponse.json({ order }, { headers: NO_STORE_HEADERS });
}
