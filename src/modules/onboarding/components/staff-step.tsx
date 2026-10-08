"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Link2, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ROLE_META, type Role } from "@/lib/rbac/permissions";
import {
  createStaffInviteAction,
  revokeStaffInviteAction,
  type OnboardingActionState,
} from "@/modules/onboarding/actions";
import type { OnboardingOutlet, PendingInvite } from "@/modules/onboarding/queries";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

function InviteLinkBox({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const href = typeof window === "undefined" ? `/invite/${token}` : `${window.location.origin}/invite/${token}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-gold/50 bg-gold/10 p-4">
      <p className="text-sm font-medium">Invitation created — share this link</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-ink/10 bg-white px-3 py-2 text-xs">
          {href}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={copy} aria-label="Copy invitation link">
          {copied ? <Check className="size-4 text-emerald-600" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Anyone with the link can accept it while signed in. If you entered an email, only that account can use it.
      </p>
    </div>
  );
}

export function StaffInviteForm({
  businessId,
  assignableRoles,
  outlets,
}: {
  businessId: string;
  assignableRoles: Role[];
  outlets: OnboardingOutlet[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    createStaffInviteAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />
      {state?.ok && state.inviteToken ? <InviteLinkBox token={state.inviteToken} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="inv-email">Email (optional)</Label>
          <Input id="inv-email" name="email" type="email" placeholder="colleague@company.com" />
          <p className="text-xs text-muted-foreground">Lock the invite to one person, or leave blank for a shareable link.</p>
          <FieldError state={state} name="email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inv-role">Role</Label>
          <Select id="inv-role" name="role" defaultValue={assignableRoles[0] ?? "cashier"}>
            {assignableRoles.map((role) => (
              <option key={role} value={role}>
                {ROLE_META[role].label}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="role" />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Outlets</legend>
        <div className="flex flex-wrap gap-2">
          {outlets.map((outlet) => (
            <label
              key={outlet.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm transition-colors hover:border-ink/35 has-[:checked]:border-gold-deep has-[:checked]:bg-gold/10"
            >
              <input type="checkbox" name="outletId" value={outlet.id} className="size-4 accent-ink" />
              {outlet.name}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Required for outlet roles; admins cover the whole business.</p>
        <FieldError state={state} name="outletId" />
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="inv-expiry">Link expires in</Label>
        <Select id="inv-expiry" name="expiryDays" defaultValue="7" className="sm:max-w-52">
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
        </Select>
      </div>

      <SubmitButton label="Create invitation link" busyLabel="Creating…" pending={pending} className="sm:w-auto sm:px-6" />
    </form>
  );
}

export function RevokeInviteButton({ businessId, inviteId }: { businessId: string; inviteId: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    revokeStaffInviteAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="inviteId" value={inviteId} />
      <button
        type="submit"
        disabled={pending}
        className="flex items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
      >
        <ShieldX className="size-3.5" aria-hidden /> Revoke
      </button>
    </form>
  );
}

export function PendingInvitesList({
  businessId,
  invites,
}: {
  businessId: string;
  invites: PendingInvite[];
}) {
  if (invites.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-ink/15 p-4 text-sm text-muted-foreground">
        No pending invitations yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
      {invites.map((invite) => (
        <li key={invite.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
          <Link2 className="size-4 shrink-0 text-gold-deep" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{invite.email ?? "Anyone with the link"}</span>
            <span className="block text-xs text-muted-foreground">
              {ROLE_META[invite.role as Role]?.label ?? invite.role}
              {invite.outletNames.length > 0 ? ` · ${invite.outletNames.join(", ")}` : ""} · expires{" "}
              {new Date(invite.expiresAt).toLocaleDateString()}
            </span>
          </span>
          <RevokeInviteButton businessId={businessId} inviteId={invite.id} />
        </li>
      ))}
    </ul>
  );
}
