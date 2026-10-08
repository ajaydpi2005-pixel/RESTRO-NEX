import { NextResponse, connection } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Platform health probe.
 *
 * Honest statuses:
 * - "not_configured": Supabase env vars are absent (pre-Phase-1 dev setups).
 * - "connected":      the app reached Supabase and ran a query.
 * - "error":          the database rejected the request.
 * No credentials or internal details are exposed.
 */
export async function GET() {
  // Opt into request-time execution under Cache Components (the probe must
  // run on every request, never from a build-time cache).
  await connection();

  try {
    const admin = createAdminClient();
    // Real GET (not HEAD) so a missing table surfaces as an error instead of
    // an empty response. limit(0) keeps the probe row-free.
    const { error } = await admin.from("user_profiles").select("id").limit(0);

    if (error) {
      return NextResponse.json(
        { status: "error", supabase: "error", message: "Database query failed." },
        { status: 503 },
      );
    }

    return NextResponse.json({ status: "ok", supabase: "connected" });
  } catch {
    return NextResponse.json({ status: "ok", supabase: "not_configured" });
  }
}
