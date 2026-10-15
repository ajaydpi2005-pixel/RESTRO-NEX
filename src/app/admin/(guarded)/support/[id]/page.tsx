import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { operatorCan } from "@/modules/admin/access";
import {
  SupportNoteForm,
  SupportReplyForm,
  SupportUpdateForm,
} from "@/modules/admin/components/admin-forms";
import {
  PageHeader,
  ReadOnlyNote,
  Section,
  StatusBadge,
} from "@/modules/admin/components/admin-ui";
import { formatDateTime } from "@/modules/admin/format";
import { isUuid } from "@/modules/admin/schemas";
import { loadSupportTicket } from "@/modules/admin/queries";
import { orNotFound } from "@/modules/admin/rpc";
import { requireOperator } from "@/modules/admin/session";

export const metadata: Metadata = { title: "Support ticket" };

const SIDE_LABEL = {
  business: "Business",
  support: "RestroNex support",
  note: "Internal note (hidden from the business)",
} as const;

export default async function SupportTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const op = await requireOperator("view");
  const canSupport = operatorCan(op.permissions, "support");
  const { ticket, messages } = await orNotFound(loadSupportTicket(id));

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/admin/support" className="text-muted-foreground hover:text-foreground text-sm">
          ← Support queue
        </Link>
        <PageHeader
          title={ticket.subject}
          description={`${ticket.business_name} · opened ${formatDateTime(ticket.created_at)} by ${ticket.opened_by_email ?? "unknown"} · assigned to ${ticket.assigned_email ?? "nobody"}`}
          actions={
            <div className="flex gap-2">
              <StatusBadge value={ticket.status} />
              <StatusBadge value={ticket.priority} />
            </div>
          }
        />
      </div>

      <Section title="Conversation">
        <ol className="space-y-3">
          {messages.map((m) => (
            <li
              key={m.id}
              className={
                m.author_side === "note"
                  ? "rounded-lg border border-dashed p-3 text-sm"
                  : m.author_side === "support"
                    ? "bg-gold/10 rounded-lg p-3 text-sm"
                    : "bg-muted rounded-lg p-3 text-sm"
              }
            >
              <p className="text-muted-foreground mb-1 text-xs">
                {SIDE_LABEL[m.author_side]} · {m.author_email ?? "unknown"} ·{" "}
                {formatDateTime(m.created_at)}
              </p>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      {canSupport ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <Section
            title="Reply to the business"
            description="Replying moves the ticket to waiting for the customer."
          >
            <SupportReplyForm ticketId={ticket.id} />
          </Section>
          <Section title="Internal note" description="Visible to operators only.">
            <SupportNoteForm ticketId={ticket.id} />
          </Section>
          <Section title="Status and assignment">
            <SupportUpdateForm
              ticketId={ticket.id}
              status={ticket.status}
              priority={ticket.priority}
            />
          </Section>
        </div>
      ) : (
        <ReadOnlyNote />
      )}
    </div>
  );
}
