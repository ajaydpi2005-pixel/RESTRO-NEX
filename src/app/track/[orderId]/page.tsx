import type { Metadata } from "next";
import { TrackStatus } from "@/modules/online/components/track-status";
import { orderIdSchema } from "@/modules/online/schemas";
import { notFound } from "next/navigation";

/** Phase 17 — customer order tracking. The tracking secret lives in the URL fragment and is read in the browser. */

export const metadata: Metadata = {
  title: "Track your order",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function TrackPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!orderIdSchema.safeParse(orderId).success) notFound();

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <TrackStatus orderId={orderId} />
    </main>
  );
}
