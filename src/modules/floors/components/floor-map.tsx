"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  Armchair,
  CheckCircle2,
  Clock3,
  Combine,
  Scissors,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FormError, SubmitButton } from "@/components/forms/form-bits";
import { minorToDisplay } from "@/modules/menu/schemas";
import {
  completeTableAction,
  mergeTablesAction,
  releaseTableAction,
  reserveTableAction,
  splitOrderAction,
  transferTableAction,
} from "@/modules/floors/actions";
import type { FloorActionState } from "@/modules/floors/actions";
import type { FloorPlan, SplitItem, TableCard } from "@/modules/floors/queries";
import { cn } from "@/lib/utils";

// ── prop types (all serialised by the server page) ─────────────────────────

export interface ActiveDineInOrder {
  id: string;
  orderNumber: number;
  tableId: string | null;
  tableLabel: string | null;
  status: string;
  totalMinor: number;
}

export interface FreeTableOption {
  id: string;
  label: string;
  sectionName: string;
}

export interface FloorMapProps {
  businessId: string;
  outletId: string;
  queryBase: string;
  posBase: string;
  plan: FloorPlan;
  freeTables: FreeTableOption[];
  activeOrders: ActiveDineInOrder[];
  orderItems: Record<string, SplitItem[]>;
  canManage: boolean;
}

const PAYMENT_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  partial: "Partially paid",
  paid: "Paid",
  refunded: "Refunded",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  held: "Held",
  placed: "Placed",
  preparing: "Preparing",
  ready: "Ready",
};

const money = (minor: number) => `₹${minorToDisplay(minor)}`;

/** Refresh + close after a successful mutation. */
function useAfterOk(state: FloorActionState | undefined, onDone: () => void) {
  const router = useRouter();
  const handled = React.useRef(false);
  React.useEffect(() => {
    if (state?.ok && !handled.current) {
      handled.current = true;
      router.refresh();
      onDone();
    }
  }, [state, router, onDone]);
}

// ── table detail sheet ──────────────────────────────────────────────────────

function ReserveForm({ table, businessId, onDone }: { table: TableCard; businessId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(reserveTableAction, undefined);
  useAfterOk(state, onDone);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="tableId" value={table.id} />
      <div className="space-y-1">
        <Label htmlFor={`reserve-note-${table.id}`}>Reservation note</Label>
        <Input
          id={`reserve-note-${table.id}`}
          name="note"
          placeholder="e.g. Mr Rao, 8pm, window seat"
          className="h-10"
        />
      </div>
      <FormError state={state} />
      <SubmitButton label="Reserve table" busyLabel="Reserving…" pending={pending} variant="secondary" />
    </form>
  );
}

function ReleaseForm({ table, businessId, onDone }: { table: TableCard; businessId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(releaseTableAction, undefined);
  useAfterOk(state, onDone);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="tableId" value={table.id} />
      <FormError state={state} />
      <SubmitButton label="Cancel reservation" busyLabel="Releasing…" pending={pending} variant="outline" />
    </form>
  );
}

function TransferForm({
  table,
  businessId,
  freeTables,
  onDone,
}: {
  table: TableCard;
  businessId: string;
  freeTables: FreeTableOption[];
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(transferTableAction, undefined);
  useAfterOk(state, onDone);
  if (!table.order) return null;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="orderId" value={table.order.id} />
      <div className="space-y-1">
        <Label htmlFor={`transfer-${table.id}`}>Move to table</Label>
        <Select id={`transfer-${table.id}`} name="toTableId" required className="h-10">
          <option value="">Select a free table…</option>
          {freeTables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} · {t.sectionName}
            </option>
          ))}
        </Select>
      </div>
      <FormError state={state} />
      <SubmitButton label="Transfer table" busyLabel="Moving…" pending={pending} variant="secondary" />
    </form>
  );
}

function MergeForm({
  table,
  businessId,
  activeOrders,
  onDone,
}: {
  table: TableCard;
  businessId: string;
  activeOrders: ActiveDineInOrder[];
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(mergeTablesAction, undefined);
  useAfterOk(state, onDone);
  if (!table.order) return null;
  const candidates = activeOrders.filter(
    (o) => o.id !== table.order!.id && o.tableId && o.tableId !== table.id,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="keepOrderId" value={table.order.id} />
      <div className="space-y-1">
        <Label htmlFor={`merge-${table.id}`}>Merge another table into this one</Label>
        <Select id={`merge-${table.id}`} name="mergeOrderId" required className="h-10">
          <option value="">Select the order to merge…</option>
          {candidates.map((o) => (
            <option key={o.id} value={o.id}>
              #{o.orderNumber} · {o.tableLabel ?? "table"} · {money(o.totalMinor)}
            </option>
          ))}
        </Select>
      </div>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">No other seated dine-in orders right now.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Items move onto this table&apos;s bill; the other order is closed.
        </p>
      )}
      <FormError state={state} />
      <SubmitButton
        label="Merge tables"
        busyLabel="Merging…"
        pending={pending}
        variant="secondary"
        className={candidates.length === 0 ? "pointer-events-none opacity-50" : undefined}
      />
    </form>
  );
}

function SplitForm({
  table,
  businessId,
  freeTables,
  items,
  onDone,
}: {
  table: TableCard;
  businessId: string;
  freeTables: FreeTableOption[];
  items: SplitItem[];
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(splitOrderAction, undefined);
  useAfterOk(state, onDone);
  const [checkedCount, setCheckedCount] = React.useState(0);
  if (!table.order) return null;
  const canSplit = items.length > 1;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="orderId" value={table.order.id} />
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Move these items to another table
      </p>
      {!canSplit ? (
        <p className="text-xs text-muted-foreground">
          This order has a single line — transfer the whole table instead.
        </p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {items.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="itemIds"
                value={item.id}
                onChange={(e) =>
                  setCheckedCount((c) => Math.max(0, c + (e.target.checked ? 1 : -1)))
                }
                className="size-4 accent-[#D4B477]"
              />
              <span className="flex-1">
                {item.quantity}× {item.name}
              </span>
              <span className="text-xs text-muted-foreground">{money(item.lineTotalMinor)}</span>
            </label>
          ))}
        </div>
      )}
      {checkedCount >= items.length && items.length > 0 ? (
        <p className="text-xs text-destructive">Leave at least one item on this table.</p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`split-table-${table.id}`}>Onto table</Label>
        <Select id={`split-table-${table.id}`} name="toTableId" required className="h-10">
          <option value="">Select a free table…</option>
          {freeTables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} · {t.sectionName}
            </option>
          ))}
        </Select>
      </div>
      <FormError state={state} />
      <SubmitButton
        label="Split onto new table"
        busyLabel="Splitting…"
        pending={pending}
        variant="secondary"
        className={!canSplit || checkedCount === 0 || checkedCount >= items.length ? "pointer-events-none opacity-50" : undefined}
      />
    </form>
  );
}

function CompleteForm({ table, businessId, onDone }: { table: TableCard; businessId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(completeTableAction, undefined);
  useAfterOk(state, onDone);
  const order = table.order;
  const blocked = order ? order.status !== "ready" || order.paymentStatus !== "paid" : false;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="tableId" value={table.id} />
      {order && blocked ? (
        <p className="text-xs text-muted-foreground">
          {order.status !== "ready"
            ? `Kitchen status is “${ORDER_STATUS_LABELS[order.status] ?? order.status}” — the order must be ready first.`
            : "Payment is not fully recorded yet (Phase 10 adds settlement)."}
        </p>
      ) : null}
      <FormError state={state} />
      <SubmitButton
        label={order ? "Complete table" : table.status === "reserved" ? "Clear reservation" : "Mark available"}
        busyLabel="Completing…"
        pending={pending}
        variant="default"
      />
    </form>
  );
}

function TableSheet({
  table,
  props,
  onClose,
}: {
  table: TableCard;
  props: FloorMapProps;
  onClose: () => void;
}) {
  const { businessId, canManage, freeTables, activeOrders, orderItems, posBase } = props;
  const sectionName = props.plan.sections.find((s) => s.id === table.sectionId)?.name ?? "Tables";
  const order = table.order;

  return (
    <Sheet open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Armchair className="size-4 text-gold-deep" aria-hidden />
            Table {table.label}
            <span className="text-sm font-normal text-muted-foreground">
              · {sectionName} · seats {table.capacity}
            </span>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {!table.isActive ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
              This table is switched off and cannot take orders.
            </p>
          ) : null}

          {table.status === "reserved" ? (
            <div className="rounded-lg border border-gold/40 bg-gold/10 px-3 py-2 text-sm">
              Reserved{table.reservationNote ? ` — ${table.reservationNote}` : ""}
            </div>
          ) : null}

          {order ? (
            <div className="space-y-2 rounded-xl border border-border p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  Order #{order.orderNumber}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {ORDER_STATUS_LABELS[order.status] ?? order.status}
                  </span>
                </p>
                <Link
                  href={`/orders/${order.id}?business=${businessId}`}
                  className="text-sm font-medium text-gold-deep underline-offset-4 hover:underline"
                >
                  View →
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                {order.itemCount} line{order.itemCount === 1 ? "" : "s"} ·{" "}
                {PAYMENT_LABELS[order.paymentStatus] ?? order.paymentStatus}
              </p>
              <p className="text-lg font-semibold">{money(order.totalMinor)}</p>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
              {table.status === "available" ? "No active order on this table." : "No order attached."}
            </p>
          )}

          {canManage && table.isActive ? (
            <div className="space-y-4">
              {table.status !== "occupied" ? (
                <Button asChild variant="default" className="w-full">
                  <Link href={`${posBase}&table=${table.id}`}>
                    <Users className="size-4" aria-hidden /> Seat guests &amp; take order
                  </Link>
                </Button>
              ) : null}

              <Separator />

              {table.status === "available" ? <ReserveForm table={table} businessId={businessId} onDone={onClose} /> : null}
              {table.status === "reserved" ? <ReleaseForm table={table} businessId={businessId} onDone={onClose} /> : null}

              {order ? (
                <>
                  <div className="space-y-3">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <ArrowLeftRight className="size-4 text-muted-foreground" aria-hidden /> Move &amp; settle
                    </p>
                    <TransferForm table={table} businessId={businessId} freeTables={freeTables} onDone={onClose} />
                  </div>
                  <Separator />
                  <div className="space-y-3">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <Combine className="size-4 text-muted-foreground" aria-hidden /> Merge tables
                    </p>
                    <MergeForm table={table} businessId={businessId} activeOrders={activeOrders} onDone={onClose} />
                  </div>
                  <Separator />
                  <div className="space-y-3">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <Scissors className="size-4 text-muted-foreground" aria-hidden /> Split bill
                    </p>
                    <SplitForm
                      table={table}
                      businessId={businessId}
                      freeTables={freeTables}
                      items={orderItems[order.id] ?? []}
                      onDone={onClose}
                    />
                  </div>
                  <Separator />
                </>
              ) : null}

              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden /> Wrap up
                </p>
                <CompleteForm table={table} businessId={businessId} onDone={onClose} />
              </div>
            </div>
          ) : null}

          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              You can view table status; managing tables needs the order-management permission.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── map ─────────────────────────────────────────────────────────────────────

const STATUS_META = {
  available: { label: "Available", chip: "border-border bg-card text-foreground" },
  reserved: { label: "Reserved", chip: "border-gold/50 bg-gold/15 text-foreground" },
  occupied: { label: "Occupied", chip: "border-foreground bg-foreground text-background" },
} as const;

export function FloorMap(props: FloorMapProps) {
  const { plan } = props;
  const [floorId, setFloorId] = React.useState<string>(() => plan.floors[0]?.id ?? "");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const visibleSections = plan.sections.filter((s) => s.floorId === floorId);
  const tablesBySection = new Map<string, TableCard[]>();
  for (const t of plan.tables) {
    const list = tablesBySection.get(t.sectionId) ?? [];
    list.push(t);
    tablesBySection.set(t.sectionId, list);
  }

  const counts = plan.tables.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const selected = selectedId ? plan.tables.find((t) => t.id === selectedId) ?? null : null;

  if (plan.floors.length === 0 || plan.tables.length === 0) {
    return (
      <Card className="p-10 text-center">
        <Armchair className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <p className="mt-3 font-medium">No tables configured yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add floors, sections and tables below (managers), or run the onboarding floor-plan step.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {plan.floors.length > 1 ? (
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Floors">
            {plan.floors.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={f.id === floorId}
                onClick={() => setFloorId(f.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition",
                  f.id === floorId ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm font-medium text-muted-foreground">{plan.floors[0]?.name}</p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="size-2.5 rounded-full border border-border bg-card" aria-hidden /> Available{" "}
            {counts.available ?? 0}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2.5 rounded-full bg-gold" aria-hidden /> Reserved {counts.reserved ?? 0}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2.5 rounded-full bg-foreground" aria-hidden /> Occupied {counts.occupied ?? 0}
          </span>
        </div>
      </div>

      {visibleSections.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          This floor has no sections yet. Add one below.
        </Card>
      ) : (
        <div className="space-y-6">
          {visibleSections.map((section) => {
            const tables = tablesBySection.get(section.id) ?? [];
            return (
              <div key={section.id} className="space-y-2">
                <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                  {section.name}
                </h3>
                {tables.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tables in this section.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                    {tables.map((table) => {
                      const meta = STATUS_META[table.status];
                      return (
                        <button
                          key={table.id}
                          type="button"
                          onClick={() => setSelectedId(table.id)}
                          className={cn(
                            "flex min-h-24 flex-col items-start gap-1 rounded-xl border p-3 text-left transition hover:shadow-md",
                            meta.chip,
                            !table.isActive && "border-dashed opacity-60",
                          )}
                        >
                          <span className="flex w-full items-center justify-between">
                            <span className="font-display text-base font-semibold">{table.label}</span>
                            <Armchair className="size-4 opacity-70" aria-hidden />
                          </span>
                          <span className="text-xs opacity-80">Seats {table.capacity}</span>
                          {table.status === "occupied" && table.order ? (
                            <span className="mt-auto flex w-full items-center justify-between text-xs">
                              <span>#{table.order.orderNumber}</span>
                              <span className="font-semibold">{money(table.order.totalMinor)}</span>
                            </span>
                          ) : null}
                          {table.status === "reserved" ? (
                            <span className="mt-auto flex items-center gap-1 text-xs opacity-90">
                              <Clock3 className="size-3" aria-hidden />
                              {table.reservationNote ? table.reservationNote.slice(0, 18) : "Reserved"}
                            </span>
                          ) : null}
                          {table.status === "available" && !table.isActive ? (
                            <span className="mt-auto text-xs opacity-80">Off</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selected ? (
        <TableSheet table={selected} props={props} onClose={() => setSelectedId(null)} />
      ) : null}
    </div>
  );
}
