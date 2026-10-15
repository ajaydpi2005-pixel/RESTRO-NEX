import type { Metadata } from "next";
import { Storefront } from "@/modules/online/components/storefront";
import { loadPublicMenu, loadQrContext } from "@/modules/online/public-service";
import { qrTokenSchema } from "@/modules/online/schemas";

/**
 * Phase 17 — table QR menu. The token sits in the path, so this page must not leak
 * it through the Referer header. It is marked no-referrer and noindex.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Table ordering",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function QrMenuPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const parsed = qrTokenSchema.safeParse(token);
  const qr = parsed.success ? await loadQrContext(parsed.data) : null;

  if (!qr) {
    return (
      <main className="mx-auto max-w-md space-y-3 px-4 py-16 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          This QR code is not active
        </h1>
        <p className="text-muted-foreground text-sm">
          Ask a team member for help. They can show you a current code.
        </p>
      </main>
    );
  }

  const menu = await loadPublicMenu(qr.business_id, qr.outlet_id);

  return (
    <Storefront
      mode="qr"
      businessName={qr.business_name}
      outletName={qr.outlet_name}
      qrToken={parsed.data}
      tableLabel={qr.table_label}
      settings={qr.settings}
      menu={menu}
    />
  );
}
