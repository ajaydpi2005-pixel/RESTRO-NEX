import { ActionForm } from "@/components/forms/action-form";
import { OPERATOR_ROLES, OPERATOR_ROLE_LABELS } from "../access";
import {
  deactivateMembershipAction,
  grantOperatorAction,
  revokeOperatorAction,
  saveOverrideAction,
  savePlanAction,
  saveSubscriptionAction,
  setBusinessStatusAction,
  supportNoteAction,
  supportReplyAction,
  supportUpdateAction,
} from "../actions";
import type {
  PlanFeature,
  PlanRow,
  SubscriptionStatus,
  TicketPriority,
  TicketStatus,
} from "../types";
import { adminInputClass, adminTextareaClass, Field } from "./admin-ui";

/**
 * Operator forms. Each form posts to one server action, and that action checks
 * the permission again. Showing a form here is only a convenience; the
 * pages render these forms only for operators who hold the permission.
 */

const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ["trial", "active", "past_due", "cancelled"];

function ReasonField() {
  return (
    <Field label="Reason (recorded in the audit log)" hint="3 to 300 characters.">
      <input name="reason" required minLength={3} maxLength={300} className={adminInputClass} />
    </Field>
  );
}

export function OperatorGrantForm() {
  return (
    <ActionForm action={grantOperatorAction} submitLabel="Save operator access" busyLabel="Saving…">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Email">
          <input name="email" type="email" required className={adminInputClass} />
        </Field>
        <Field label="Role">
          <select name="role" defaultValue="support" className={adminInputClass}>
            {OPERATOR_ROLES.map((role) => (
              <option key={role} value={role}>
                {OPERATOR_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </Field>
        <ReasonField />
      </div>
      <p className="text-muted-foreground text-xs">
        The person must already have a RestroNex account. Granting an existing operator a new role
        changes their role.
      </p>
    </ActionForm>
  );
}

export function OperatorRevokeForm({ userId }: { userId: string }) {
  return (
    <ActionForm
      action={revokeOperatorAction}
      submitLabel="Revoke"
      busyLabel="Revoking…"
      variant="outline"
    >
      <input type="hidden" name="userId" value={userId} />
      <Field label="Reason">
        <input name="reason" required minLength={3} maxLength={300} className={adminInputClass} />
      </Field>
    </ActionForm>
  );
}

export function BusinessStatusForm({
  businessId,
  current,
}: {
  businessId: string;
  current: "active" | "suspended" | "closed";
}) {
  // "closed" is set by the tenant owner and is not offered here.
  const target = current === "active" ? "suspended" : "active";
  return (
    <ActionForm
      action={setBusinessStatusAction}
      submitLabel={target === "suspended" ? "Suspend business" : "Reactivate business"}
      busyLabel="Saving…"
      variant={target === "suspended" ? "destructive" : "default"}
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="status" value={target} />
      <ReasonField />
      <p className="text-muted-foreground text-xs">
        {target === "suspended"
          ? "Suspending locks every staff member of this business out of the app immediately. Their memberships move to suspended and are restored on reactivation."
          : "Reactivating restores only the staff memberships that the suspension changed."}
      </p>
    </ActionForm>
  );
}

export function DeactivateMembershipForm({ membershipId }: { membershipId: string }) {
  return (
    <ActionForm
      action={deactivateMembershipAction}
      submitLabel="Deactivate"
      busyLabel="Deactivating…"
      variant="outline"
    >
      <input type="hidden" name="membershipId" value={membershipId} />
      <Field label="Reason">
        <input name="reason" required minLength={3} maxLength={300} className={adminInputClass} />
      </Field>
    </ActionForm>
  );
}

export function SubscriptionForm({
  businessId,
  plans,
  current,
}: {
  businessId: string;
  plans: PlanRow[];
  current: {
    plan_code: string;
    status: SubscriptionStatus;
    trial_ends_at: string | null;
    current_period_ends_at: string | null;
  } | null;
}) {
  return (
    <ActionForm action={saveSubscriptionAction} submitLabel="Save subscription" busyLabel="Saving…">
      <input type="hidden" name="businessId" value={businessId} />
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Plan">
          <select
            name="planCode"
            defaultValue={current?.plan_code ?? plans[0]?.code}
            className={adminInputClass}
          >
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            name="status"
            defaultValue={current?.status ?? "trial"}
            className={adminInputClass}
          >
            {SUBSCRIPTION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Trial ends on" hint="Required for trial. End of day, IST.">
          <input
            type="date"
            name="trialEndsOn"
            defaultValue={current?.trial_ends_at ? istDate(current.trial_ends_at) : ""}
            className={adminInputClass}
          />
        </Field>
        <Field label="Current period ends on" hint="Optional. End of day, IST.">
          <input
            type="date"
            name="periodEndsOn"
            defaultValue={
              current?.current_period_ends_at ? istDate(current.current_period_ends_at) : ""
            }
            className={adminInputClass}
          />
        </Field>
      </div>
      <ReasonField />
    </ActionForm>
  );
}

/** Date part of an ISO timestamp in Asia/Kolkata, for a date input. */
function istDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function OverrideForm({
  businessId,
  feature,
  current,
}: {
  businessId: string;
  feature: PlanFeature;
  current: { included: boolean | null; limit_value: number | null } | null;
}) {
  const includedValue =
    current?.included === null || current?.included === undefined
      ? "inherit"
      : current.included
        ? "yes"
        : "no";
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">{feature.label}</p>
      <ActionForm action={saveOverrideAction} submitLabel="Save override" busyLabel="Saving…">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="featureKey" value={feature.feature_key} />
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Included">
            <select name="included" defaultValue={includedValue} className={adminInputClass}>
              <option value="inherit">Use plan</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          {feature.kind === "limit" ? (
            <Field
              label={`Limit${feature.unit ? ` (${feature.unit})` : ""}`}
              hint="Blank uses the plan."
            >
              <input
                name="limit"
                inputMode="numeric"
                defaultValue={current?.limit_value ?? ""}
                className={adminInputClass}
              />
            </Field>
          ) : null}
          <ReasonField />
        </div>
      </ActionForm>
      <ActionForm
        action={saveOverrideAction}
        submitLabel="Remove override"
        busyLabel="Removing…"
        variant="outline"
      >
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="featureKey" value={feature.feature_key} />
        <input type="hidden" name="clear" value="1" />
        <input type="hidden" name="included" value="inherit" />
        <Field label="Reason for removing">
          <input name="reason" required minLength={3} maxLength={300} className={adminInputClass} />
        </Field>
      </ActionForm>
    </div>
  );
}

export function PlanForm({
  plan,
  catalog,
}: {
  /** Existing plan to edit, or undefined to create a new plan. */
  plan?: PlanRow;
  catalog: PlanFeature[];
}) {
  const valueOf = (key: string) => plan?.features.find((f) => f.feature_key === key);
  return (
    <ActionForm
      action={savePlanAction}
      submitLabel={plan ? "Save plan" : "Create plan"}
      busyLabel="Saving…"
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Code" hint="Capital letters and underscores.">
          <input
            name="code"
            required
            readOnly={Boolean(plan)}
            defaultValue={plan?.code ?? ""}
            className={adminInputClass}
          />
        </Field>
        <Field label="Name">
          <input name="name" required defaultValue={plan?.name ?? ""} className={adminInputClass} />
        </Field>
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" name="isActive" defaultChecked={plan ? plan.is_active : true} />
          Available for new subscriptions
        </label>
      </div>
      <Field label="Description">
        <input
          name="description"
          defaultValue={plan?.description ?? ""}
          className={adminInputClass}
        />
      </Field>
      <div className="grid gap-2 md:grid-cols-2">
        {catalog.map((feature) => {
          const value = valueOf(feature.feature_key);
          return (
            <div
              key={feature.feature_key}
              className="flex items-center gap-3 rounded-md border p-2 text-sm"
            >
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={`included__${feature.feature_key}`}
                  defaultChecked={value?.included ?? false}
                />
                {feature.label}
              </label>
              {feature.kind === "limit" ? (
                <input
                  name={`limit__${feature.feature_key}`}
                  inputMode="numeric"
                  aria-label={`${feature.label} limit`}
                  placeholder="Unlimited"
                  defaultValue={value?.limit_value ?? ""}
                  className={`${adminInputClass} ml-auto w-28`}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        Blank limit means unlimited. Only features marked enforced stop the business when the limit
        is reached. Changes apply to every business on this plan immediately.
      </p>
      <ReasonField />
    </ActionForm>
  );
}

export function SupportReplyForm({ ticketId }: { ticketId: string }) {
  return (
    <ActionForm action={supportReplyAction} submitLabel="Send reply" busyLabel="Sending…">
      <input type="hidden" name="ticketId" value={ticketId} />
      <textarea
        name="body"
        required
        maxLength={4000}
        aria-label="Reply to the business"
        className={adminTextareaClass}
      />
      <p className="text-muted-foreground text-xs">
        The business sees this reply. The ticket moves to waiting for the customer.
      </p>
    </ActionForm>
  );
}

export function SupportNoteForm({ ticketId }: { ticketId: string }) {
  return (
    <ActionForm
      action={supportNoteAction}
      submitLabel="Add internal note"
      busyLabel="Saving…"
      variant="outline"
    >
      <input type="hidden" name="ticketId" value={ticketId} />
      <textarea
        name="body"
        required
        maxLength={4000}
        aria-label="Internal note"
        className={adminTextareaClass}
      />
      <p className="text-muted-foreground text-xs">Internal notes are hidden from the business.</p>
    </ActionForm>
  );
}

export function SupportUpdateForm({
  ticketId,
  status,
  priority,
}: {
  ticketId: string;
  status: TicketStatus;
  priority: TicketPriority;
}) {
  return (
    <ActionForm
      action={supportUpdateAction}
      submitLabel="Update ticket"
      busyLabel="Saving…"
      variant="outline"
    >
      <input type="hidden" name="ticketId" value={ticketId} />
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Status">
          <select name="status" defaultValue={status} className={adminInputClass}>
            <option value="open">Open</option>
            <option value="waiting_customer">Waiting for customer</option>
            <option value="resolved">Resolved</option>
          </select>
        </Field>
        <Field label="Priority">
          <select name="priority" defaultValue={priority} className={adminInputClass}>
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" name="assignToMe" /> Assign to me
        </label>
      </div>
    </ActionForm>
  );
}
