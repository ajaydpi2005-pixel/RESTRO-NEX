import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/modules/admin/format";
import type { TenantSupportTicket } from "@/modules/admin/types";
import { openSupportTicketAction, replySupportTicketAction } from "../actions";

const STATUS_TEXT: Record<TenantSupportTicket["status"], string> = {
  open: "Waiting for RestroNex",
  waiting_customer: "Reply from RestroNex",
  resolved: "Resolved",
};

const textareaClass =
  "border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-24 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2";

/**
 * Support for one business. Shows the business's own messages. Internal
 * operator notes are removed in the database and never reach this component.
 */
export function SupportPanel({
  businessId,
  tickets,
}: {
  businessId: string;
  tickets: TenantSupportTicket[];
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open a ticket</CardTitle>
          <CardDescription>
            Describe the problem and what you were doing. You can have up to 10 open tickets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={openSupportTicketAction}
            submitLabel="Send ticket"
            busyLabel="Sending…"
          >
            <input type="hidden" name="businessId" value={businessId} />
            <div className="space-y-1.5">
              <Label htmlFor="ticket-subject">Subject</Label>
              <Input id="ticket-subject" name="subject" required minLength={3} maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ticket-body">Message</Label>
              <textarea
                id="ticket-body"
                name="body"
                required
                maxLength={4000}
                className={textareaClass}
              />
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {tickets.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground p-6 text-sm">
              No tickets yet. Tickets you open appear here with replies from RestroNex support.
            </CardContent>
          </Card>
        ) : (
          tickets.map((ticket) => (
            <Card key={ticket.id}>
              <CardHeader className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">{ticket.subject}</CardTitle>
                  <Badge variant="outline">{STATUS_TEXT[ticket.status]}</Badge>
                </div>
                <CardDescription>
                  Opened {formatDateTime(ticket.created_at)} · Last message{" "}
                  {formatDateTime(ticket.last_message_at)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ol className="space-y-2">
                  {ticket.messages.map((message) => (
                    <li
                      key={message.id}
                      className={
                        message.author_side === "support"
                          ? "bg-gold/10 rounded-lg p-3 text-sm"
                          : "bg-muted rounded-lg p-3 text-sm"
                      }
                    >
                      <p className="text-muted-foreground mb-1 text-xs">
                        {message.author_side === "support" ? "RestroNex support" : "Your team"} ·{" "}
                        {formatDateTime(message.created_at)}
                      </p>
                      <p className="whitespace-pre-wrap">{message.body}</p>
                    </li>
                  ))}
                </ol>
                {ticket.status !== "resolved" ? (
                  <ActionForm
                    action={replySupportTicketAction}
                    submitLabel="Reply"
                    busyLabel="Sending…"
                  >
                    <input type="hidden" name="businessId" value={businessId} />
                    <input type="hidden" name="ticketId" value={ticket.id} />
                    <textarea
                      name="body"
                      required
                      maxLength={4000}
                      aria-label="Reply"
                      className={textareaClass}
                    />
                  </ActionForm>
                ) : null}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
