"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Layers, MapPin, Plus, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FormError, SubmitButton } from "@/components/forms/form-bits";
import {
  deleteFloorAction,
  deleteSectionAction,
  deleteTableAction,
  saveFloorAction,
  saveSectionAction,
  saveTableAction,
  type FloorActionState,
} from "@/modules/floors/actions";
import type { FloorPlan } from "@/modules/floors/queries";

/**
 * Phase 9 — outlet floor/section/table configuration (outlets.manage).
 * Every mutation goes through the Phase 9 SECURITY DEFINER RPCs; this panel
 * is only rendered for users the server authorised for outlet management.
 */

export interface FloorManagerProps {
  businessId: string;
  outletId: string;
  plan: FloorPlan;
}

function useRefreshOnOk(state: FloorActionState | undefined) {
  const router = useRouter();
  const handled = React.useRef(false);
  React.useEffect(() => {
    if (state?.ok && !handled.current) {
      handled.current = true;
      router.refresh();
    }
  }, [state, router]);
}

// ── floors ──────────────────────────────────────────────────────────────────

function AddFloorForm({ businessId, outletId }: { businessId: string; outletId: string }) {
  const [state, action, pending] = useActionState(saveFloorAction, undefined);
  useRefreshOnOk(state);
  return (
    <form action={action} className="flex items-end gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <div className="flex-1 space-y-1">
        <Label htmlFor="new-floor-name">New floor</Label>
        <Input id="new-floor-name" name="name" placeholder="e.g. Level 2, Terrace" className="h-9" required />
      </div>
      <SubmitButton label="Add" busyLabel="Adding…" pending={pending} className="h-9 w-24" variant="secondary" />
      <FormError state={state} />
    </form>
  );
}

function EditFloorForm({
  businessId,
  outletId,
  floorId,
  name,
}: {
  businessId: string;
  outletId: string;
  floorId: string;
  name: string;
}) {
  const [state, action, pending] = useActionState(saveFloorAction, undefined);
  useRefreshOnOk(state);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteFloorAction, undefined);
  useRefreshOnOk(deleteState);
  const error = state?.error ?? deleteState?.error;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={action} className="flex flex-1 items-center gap-2">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="outletId" value={outletId} />
        <input type="hidden" name="floorId" value={floorId} />
        <Input name="name" defaultValue={name} className="h-8 max-w-52" aria-label={`Rename floor ${name}`} />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Rename
        </Button>
      </form>
      <form action={deleteAction}>
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="floorId" value={floorId} />
        <Button type="submit" size="sm" variant="ghost" disabled={deletePending} aria-label={`Delete floor ${name}`}>
          <Trash2 className="size-3.5 text-destructive" aria-hidden />
        </Button>
      </form>
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// ── sections ────────────────────────────────────────────────────────────────

function AddSectionForm({
  businessId,
  outletId,
  floors,
}: {
  businessId: string;
  outletId: string;
  floors: FloorPlan["floors"];
}) {
  const [state, action, pending] = useActionState(saveSectionAction, undefined);
  useRefreshOnOk(state);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <div className="min-w-40 flex-1 space-y-1">
        <Label htmlFor="new-section-name">New section</Label>
        <Input id="new-section-name" name="name" placeholder="e.g. Window, Patio" className="h-9" required />
      </div>
      <div className="w-40 space-y-1">
        <Label htmlFor="new-section-floor">Floor</Label>
        <Select id="new-section-floor" name="floorId" className="h-9" required>
          {floors.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </div>
      <SubmitButton label="Add" busyLabel="Adding…" pending={pending} className="h-9 w-24" variant="secondary" />
      <FormError state={state} />
    </form>
  );
}

function EditSectionForm({
  businessId,
  outletId,
  sectionId,
  name,
  floorId,
  floors,
  tableCount,
}: {
  businessId: string;
  outletId: string;
  sectionId: string;
  name: string;
  floorId: string;
  floors: FloorPlan["floors"];
  tableCount: number;
}) {
  const [state, action, pending] = useActionState(saveSectionAction, undefined);
  useRefreshOnOk(state);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteSectionAction, undefined);
  useRefreshOnOk(deleteState);
  const error = state?.error ?? deleteState?.error;
  return (
    <div className="space-y-1 rounded-lg border border-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={action} className="flex flex-1 flex-wrap items-center gap-2">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="outletId" value={outletId} />
          <input type="hidden" name="sectionId" value={sectionId} />
          <Input name="name" defaultValue={name} className="h-8 max-w-44" aria-label={`Rename section ${name}`} />
          <Select name="floorId" defaultValue={floorId} className="h-8 w-36" aria-label={`Move section ${name}`}>
            {floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Save
          </Button>
        </form>
        <span className="text-xs text-muted-foreground">{tableCount} tables</span>
        <form action={deleteAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="sectionId" value={sectionId} />
          <Button type="submit" size="sm" variant="ghost" disabled={deletePending} aria-label={`Delete section ${name}`}>
            <Trash2 className="size-3.5 text-destructive" aria-hidden />
          </Button>
        </form>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// ── tables ──────────────────────────────────────────────────────────────────

function AddTableForm({
  businessId,
  outletId,
  sections,
}: {
  businessId: string;
  outletId: string;
  sections: FloorPlan["sections"];
}) {
  const [state, action, pending] = useActionState(saveTableAction, undefined);
  useRefreshOnOk(state);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <div className="w-28 space-y-1">
        <Label htmlFor="new-table-label">Label</Label>
        <Input id="new-table-label" name="label" placeholder="T12" className="h-9" required />
      </div>
      <div className="w-24 space-y-1">
        <Label htmlFor="new-table-capacity">Seats</Label>
        <Input
          id="new-table-capacity"
          name="capacity"
          type="number"
          min={1}
          max={50}
          defaultValue={4}
          className="h-9"
          required
        />
      </div>
      <div className="w-48 space-y-1">
        <Label htmlFor="new-table-section">Section</Label>
        <Select id="new-table-section" name="sectionId" className="h-9" required>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      <SubmitButton label="Add" busyLabel="Adding…" pending={pending} className="h-9 w-24" variant="secondary" />
      <FormError state={state} />
    </form>
  );
}

function EditTableForm({
  businessId,
  outletId,
  table,
  sections,
}: {
  businessId: string;
  outletId: string;
  table: { id: string; label: string; capacity: number; sectionId: string; status: string };
  sections: FloorPlan["sections"];
}) {
  const [state, action, pending] = useActionState(saveTableAction, undefined);
  useRefreshOnOk(state);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteTableAction, undefined);
  useRefreshOnOk(deleteState);
  const error = state?.error ?? deleteState?.error;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <form action={action} className="flex flex-1 flex-wrap items-center gap-2">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="outletId" value={outletId} />
          <input type="hidden" name="tableId" value={table.id} />
          <Input name="label" defaultValue={table.label} className="h-8 w-24" aria-label={`Rename table ${table.label}`} />
          <Input
            name="capacity"
            type="number"
            min={1}
            max={50}
            defaultValue={table.capacity}
            className="h-8 w-20"
            aria-label={`Seats for table ${table.label}`}
          />
          <Select name="sectionId" defaultValue={table.sectionId} className="h-8 w-40" aria-label={`Move table ${table.label}`}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Save
          </Button>
        </form>
        <span
          className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
        >
          {table.status}
        </span>
        <form action={deleteAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="tableId" value={table.id} />
          <Button type="submit" size="sm" variant="ghost" disabled={deletePending} aria-label={`Delete table ${table.label}`}>
            <Trash2 className="size-3.5 text-destructive" aria-hidden />
          </Button>
        </form>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// ── panel ───────────────────────────────────────────────────────────────────

export function FloorManager({ businessId, outletId, plan }: FloorManagerProps) {
  const tablesBySection = new Map<string, number>();
  for (const t of plan.tables) {
    tablesBySection.set(t.sectionId, (tablesBySection.get(t.sectionId) ?? 0) + 1);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-gold-deep" aria-hidden /> Floors
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {plan.floors.map((f) => (
            <EditFloorForm key={f.id} businessId={businessId} outletId={outletId} floorId={f.id} name={f.name} />
          ))}
          <AddFloorForm businessId={businessId} outletId={outletId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="size-4 text-gold-deep" aria-hidden /> Sections
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {plan.sections.map((s) => (
            <EditSectionForm
              key={s.id}
              businessId={businessId}
              outletId={outletId}
              sectionId={s.id}
              name={s.name}
              floorId={s.floorId}
              floors={plan.floors}
              tableCount={tablesBySection.get(s.id) ?? 0}
            />
          ))}
          {plan.sections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sections yet — add one below.</p>
          ) : null}
          {plan.floors.length > 0 ? (
            <AddSectionForm businessId={businessId} outletId={outletId} floors={plan.floors} />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Square className="size-4 text-gold-deep" aria-hidden /> Tables
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
            {plan.tables.map((t) => (
              <EditTableForm
                key={t.id}
                businessId={businessId}
                outletId={outletId}
                table={t}
                sections={plan.sections}
              />
            ))}
            {plan.tables.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tables yet — add one below.</p>
            ) : null}
          </div>
          {plan.sections.length > 0 ? (
            <AddTableForm businessId={businessId} outletId={outletId} sections={plan.sections} />
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Plus className="size-3.5" aria-hidden /> Create a section first, then add tables to it.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
