import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { assignableRoles, hasPermission, ROLE_META } from "@/lib/rbac/permissions";
import { createClient } from "@/lib/supabase/server";
import { getManagedBusinesses } from "@/modules/business/queries";
import { AddStaffForm } from "@/modules/staff/components/add-staff-form";
import { StaffMemberCard } from "@/modules/staff/components/staff-member-card";
import { getStaffList } from "@/modules/staff/queries";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const params = await searchParams;
  const businesses = await getManagedBusinesses();
  const withStaffView = businesses.filter((b) => hasPermission(b.role, "staff.view"));

  if (withStaffView.length === 0) {
    redirect("/settings");
  }

  const business = params.business
    ? withStaffView.find((b) => b.id === params.business)
    : withStaffView.length === 1
      ? withStaffView[0]
      : undefined;

  if (!business) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Staff</h1>
        <p className="text-muted-foreground">Choose the business whose staff you want to manage.</p>
        <div className="grid gap-4 md:grid-cols-2">
          {withStaffView.map((b) => (
            <Card key={b.id}>
              <CardHeader>
                <CardTitle className="text-base">{b.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <Link
                  href={`/settings/staff?business=${b.id}`}
                  className="text-sm font-medium text-gold-deep underline-offset-4 hover:underline dark:text-gold"
                >
                  View staff →
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const abilities = await getViewerAbilities(business.id);
  const canManage = abilities.can("staff.manage");
  const viewerRank = abilities.role ? ROLE_META[abilities.role].rank : 0;
  const viewerRoles = assignableRoles(abilities.role);

  let staff: Awaited<ReturnType<typeof getStaffList>> = [];
  try {
    staff = await getStaffList(business.id);
  } catch {
    // staff.view denied between directory read and now — show empty roster.
  }

  const supabase = await createClient();
  const { data: outletRows } = await supabase
    .from("outlets")
    .select("id, name")
    .eq("business_id", business.id)
    .order("created_at", { ascending: true });
  const outlets = (outletRows ?? []).map((o) => ({ id: o.id, name: o.name }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-3xl font-semibold tracking-tight">Staff</h1>
            <Badge variant="outline" className="border-gold/50">{business.name}</Badge>
            {abilities.role ? (
              <Badge variant="secondary">You: {ROLE_META[abilities.role].label}</Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground">
            Roles, outlet assignments and access. Every change is re-authorised server-side.
          </p>
        </div>
      </div>

      {canManage && viewerRoles.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
              <Users className="size-4.5" />
            </div>
            <CardTitle className="text-base">Add staff</CardTitle>
            <CardDescription>
              You can assign roles below your own ({ROLE_META[abilities.role ?? "owner"].label}).
              Ownership is never assigned through staff management.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddStaffForm businessId={business.id} assignableRoles={viewerRoles} outlets={outlets} />
          </CardContent>
        </Card>
      ) : null}

      <Separator />

      <div className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Team ({staff.length})
        </h2>
        {staff.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No staff yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {staff.map((member) => {
              const isSelf = abilities.userId !== null && member.userId === abilities.userId;
              const manageable =
                canManage &&
                !isSelf &&
                member.role !== "owner" &&
                ROLE_META[member.role].rank < viewerRank;
              return (
                <StaffMemberCard
                  key={member.membershipId}
                  businessId={business.id}
                  membershipId={member.membershipId}
                  name={member.fullName}
                  email={member.email}
                  role={member.role}
                  status={member.status}
                  outletIds={member.outletIds}
                  assignableRoles={viewerRoles}
                  outlets={outlets}
                  manageable={manageable}
                  denialReason={
                    isSelf
                      ? "This is you — you cannot manage your own membership."
                      : member.role === "owner"
                        ? "Ownership can only be transferred by the owner."
                        : "Members at or above your role manage themselves."
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
