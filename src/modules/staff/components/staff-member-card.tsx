"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { ROLE_META, type Role } from "@/lib/rbac/permissions";
import {
  assignOutletsAction,
  setStaffStatusAction,
  updateStaffRoleAction,
  type StaffActionState,
} from "@/modules/staff/actions";
import { FormError } from "@/components/forms/form-bits";

export interface StaffOutletOption {
  id: string;
  name: string;
}

/**
 * One staff member: change role, activate/deactivate, assign outlets.
 * Every control submits a REAL server action; the server re-verifies
 * permissions regardless of what this card renders.
 */
export function StaffMemberCard({
  businessId,
  membershipId,
  name,
  email,
  role,
  status,
  outletIds,
  assignableRoles,
  outlets,
  manageable,
  denialReason,
}: {
  businessId: string;
  membershipId: string;
  name: string | null;
  email: string;
  role: Role;
  status: string;
  outletIds: string[];
  assignableRoles: Role[];
  outlets: StaffOutletOption[];
  manageable: boolean;
  denialReason?: string;
}) {
  const router = useRouter();
  const [showOutlets, setShowOutlets] = useState(false);

  const [roleState, roleAction, rolePending] = useActionState<StaffActionState | undefined, FormData>(
    updateStaffRoleAction,
    undefined,
  );
  const [statusState, statusAction, statusPending] = useActionState<StaffActionState | undefined, FormData>(
    setStaffStatusAction,
    undefined,
  );
  const [outletsState, outletsAction, outletsPending] = useActionState<StaffActionState | undefined, FormData>(
    assignOutletsAction,
    undefined,
  );

  useEffect(() => {
    if (roleState?.ok || statusState?.ok || outletsState?.ok) {
      router.refresh();
    }
  }, [roleState, statusState, outletsState, router]);

  const isOutletScopedRole = role !== "owner" && role !== "business_admin";
  const error = roleState?.error ?? statusState?.error ?? outletsState?.error;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              {name || email}
              {status !== "active" ? <Badge variant="outline">deactivated</Badge> : null}
            </CardTitle>
            <p className="text-sm text-muted-foreground">{email}</p>
          </div>
          <Badge variant={role === "owner" ? "default" : "secondary"}>{ROLE_META[role].label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <FormError state={{ error }} /> : null}
        {!manageable ? (
          <p className="text-xs text-muted-foreground">
            {denialReason ?? "You cannot manage this member."}
          </p>
        ) : (
          <>
            <form action={roleAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="businessId" value={businessId} />
              <input type="hidden" name="membershipId" value={membershipId} />
              <div className="space-y-1.5">
                <label htmlFor={`role-${membershipId}`} className="text-xs text-muted-foreground">
                  Change role
                </label>
                <Select id={`role-${membershipId}`} name="role" defaultValue={role}>
                  {[role, ...assignableRoles.filter((r) => r !== role)].map((r) => (
                    <option key={r} value={r}>
                      {ROLE_META[r].label}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" variant="outline" size="sm" disabled={rolePending}>
                {rolePending ? "Saving…" : "Save role"}
              </Button>
              {roleState?.fieldErrors?.role ? (
                <p className="text-xs text-destructive">{roleState.fieldErrors.role[0]}</p>
              ) : null}
            </form>

            {isOutletScopedRole && outlets.length > 0 ? (
              <div>
                <button
                  type="button"
                  onClick={() => setShowOutlets((v) => !v)}
                  className="text-xs font-medium text-gold-deep underline-offset-4 hover:underline dark:text-gold"
                >
                  {showOutlets ? "Hide outlet assignment" : `Edit outlets (${outletIds.length} assigned)`}
                </button>
                {showOutlets ? (
                  <form action={outletsAction} className="mt-3 space-y-3">
                    <input type="hidden" name="businessId" value={businessId} />
                    <input type="hidden" name="membershipId" value={membershipId} />
                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                      {outlets.map((outlet) => (
                        <label key={outlet.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name="outletId"
                            value={outlet.id}
                            defaultChecked={outletIds.includes(outlet.id)}
                            className="size-4 accent-[#D4B477]"
                          />
                          {outlet.name}
                        </label>
                      ))}
                    </div>
                    {outletsState?.fieldErrors?.outletIds ? (
                      <p className="text-xs text-destructive">{outletsState.fieldErrors.outletIds[0]}</p>
                    ) : null}
                    <Button type="submit" variant="outline" size="sm" disabled={outletsPending}>
                      {outletsPending ? "Saving…" : "Save outlets"}
                    </Button>
                  </form>
                ) : null}
              </div>
            ) : null}

            <form action={statusAction}>
              <input type="hidden" name="businessId" value={businessId} />
              <input type="hidden" name="membershipId" value={membershipId} />
              <input type="hidden" name="active" value={status !== "active" ? "true" : "false"} />
              <Button type="submit" variant="outline" size="sm" disabled={statusPending}>
                {statusPending ? "Working…" : status === "active" ? "Deactivate" : "Reactivate"}
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
