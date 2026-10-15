"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PROVIDER_CATALOG, findProvider, type IntegrationMode, type ProviderKey } from "../catalog";
import { CONFIG_KEYS } from "../schemas";
import {
  queuePrintTestAction,
  registerPrintAgentAction,
  retryIntegrationJobAction,
  revokePrintAgentAction,
  saveIntegrationAction,
  setIntegrationEnabledAction,
  testIntegrationAction,
  type ActionResult,
} from "../actions";
import type { AccountRow, PanelData } from "../panel-types";

/**
 * Phase 18 — the integrations settings panel. The server decides everything that counts
 * (permission, tenant, live gating, the test gate). This component shows the state and
 * sends the staff member's choices. It never shows a credential, only its hint.
 */

interface Props {
  businessId: string;
  outlets: { id: string; name: string }[];
  panel: PanelData;
}

const CONFIG_LABELS: Record<string, string> = {
  host: "Printer IP address or host name",
  paper_width_chars: "Paper width (characters)",
  sender_id: "Sender ID",
  from_address: "From address",
  phone_number_id: "Phone number ID",
  api_version: "API version (for example v21.0)",
  outlet_code: "Outlet code on the platform",
};

const STATUS_LABEL: Record<AccountRow["status"], string> = {
  not_configured: "Not configured",
  untested: "Not tested",
  connected: "Connected",
  error: "Error",
};

function fmt(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function todayIst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function firstOfMonthIst(): string {
  return `${todayIst().slice(0, 8)}01`;
}

export function IntegrationsPanel({ businessId, outlets, panel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const outletName = useMemo(() => new Map(outlets.map((o) => [o.id, o.name])), [outlets]);
  const providers = PROVIDER_CATALOG.filter((p) => !p.fileExport);

  const [provider, setProvider] = useState<ProviderKey>("printer");
  const [outletId, setOutletId] = useState<string>(outlets[0]?.id ?? "");
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<IntegrationMode>("demo");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [agentOutlet, setAgentOutlet] = useState<string>(outlets[0]?.id ?? "");
  const [agentName, setAgentName] = useState("");
  // The token is shown once, right after it is created. It is not kept anywhere else.
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);

  const def = findProvider(provider);
  // Match the exact scope the database uses: provider plus outlet (null = all outlets).
  const scopeOutlet = outletId || null;
  const existing = panel.accounts.find(
    (a) => a.provider === provider && (a.outlet_id ?? null) === scopeOutlet,
  );

  function run(task: () => Promise<ActionResult<object>>, success: string) {
    startTransition(async () => {
      const result = await task();
      if (result.ok) {
        setNotice({ tone: "ok", text: success });
        router.refresh();
      } else {
        setNotice({ tone: "err", text: result.error });
      }
    });
  }

  function loadIntoForm(account: AccountRow) {
    setProvider(account.provider);
    setOutletId(account.outlet_id ?? outletId);
    setEnabled(account.enabled);
    setMode(account.mode);
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(account.config)) next[k] = String(v);
    setConfig(next);
    setCredentials({});
    setNotice(null);
  }

  function save() {
    if (!def) return;
    const cleanConfig: Record<string, string | number> = {};
    for (const key of CONFIG_KEYS[provider]) {
      const value = (config[key] ?? "").trim();
      if (value === "") continue;
      cleanConfig[key] = key === "paper_width_chars" ? Number(value) : value;
    }
    const cleanCredentials: Record<string, string> = {};
    for (const field of def.credentialFields) {
      const value = (credentials[field.name] ?? "").trim();
      if (value !== "") cleanCredentials[field.name] = value;
    }
    run(
      () =>
        saveIntegrationAction({
          businessId,
          accountId: existing?.id ?? null,
          outletId: scopeOutlet,
          provider,
          mode,
          enabled,
          config: cleanConfig,
          credentials: cleanCredentials,
        }),
      mode === "live"
        ? "Saved. Test the connection through the print agent before turning it on."
        : "Saved. Run a connection test before turning it on.",
    );
    setCredentials({});
  }

  const exportable = findProvider("accounting_export");
  const runOrigin =
    typeof window !== "undefined" ? window.location.origin : "https://your-restro-app";

  return (
    <div className="space-y-6">
      {notice ? (
        <p
          role="status"
          className={
            notice.tone === "ok"
              ? "rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"
              : "border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm"
          }
        >
          {notice.text}
        </p>
      ) : null}

      <section aria-labelledby="catalog-heading" className="space-y-3">
        <h2 id="catalog-heading" className="font-display text-xl font-semibold">
          Connections
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {providers.map((p) => {
            const mine = panel.accounts.filter((a) => a.provider === p.key);
            return (
              <Card key={p.key}>
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{p.label}</CardTitle>
                    <Badge variant="outline">DEMO only in this build</Badge>
                  </div>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {mine.length === 0 ? (
                    <p className="text-muted-foreground">Not set up.</p>
                  ) : (
                    mine.map((a) => (
                      <div key={a.id} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {a.outlet_id
                              ? (outletName.get(a.outlet_id) ?? "Outlet")
                              : "All outlets"}
                          </span>
                          <Badge variant="secondary">{a.mode === "live" ? "LIVE" : "DEMO"}</Badge>
                          <Badge variant={a.status === "connected" ? "default" : "outline"}>
                            {STATUS_LABEL[a.status]}
                          </Badge>
                          <Badge variant={a.enabled ? "default" : "outline"}>
                            {a.enabled ? "On" : "Off"}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground mt-1 text-xs">
                          Last test: {fmt(a.last_tested_at)} · Last success:{" "}
                          {fmt(a.last_success_at)}
                        </p>
                        {a.last_error ? (
                          <p className="text-destructive mt-1 text-xs">{a.last_error}</p>
                        ) : null}
                        {Object.keys(a.credential_hints).length > 0 ? (
                          <p className="text-muted-foreground mt-1 text-xs">
                            Credentials saved:{" "}
                            {Object.entries(a.credential_hints)
                              .map(([k, v]) => `${k} ${v}`)
                              .join(", ")}
                          </p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() =>
                              run(
                                () => testIntegrationAction({ businessId, accountId: a.id }),
                                "Test complete.",
                              )
                            }
                          >
                            Test connection
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending || (!a.enabled && a.status !== "connected")}
                            onClick={() =>
                              run(
                                () =>
                                  setIntegrationEnabledAction({
                                    businessId,
                                    accountId: a.id,
                                    enabled: !a.enabled,
                                  }),
                                a.enabled ? "Turned off." : "Turned on.",
                              )
                            }
                          >
                            {a.enabled ? "Turn off" : "Turn on"}
                          </Button>
                          {a.provider === "printer" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending || !a.enabled}
                              onClick={() =>
                                run(
                                  () => queuePrintTestAction({ businessId, accountId: a.id }),
                                  "Test page queued. It prints when the job worker next runs.",
                                )
                              }
                            >
                              Print test page
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => loadIntoForm(a)}>
                            Edit
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setProvider(p.key);
                      setMode("demo");
                      setEnabled(false);
                      setConfig({});
                      setCredentials({});
                      setNotice(null);
                    }}
                  >
                    {mine.length === 0 ? "Set up" : "Add another"}
                  </Button>
                  {p.liveNote ? (
                    <p className="text-muted-foreground text-xs">{p.liveNote}</p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {existing
              ? `Update ${def?.label ?? "connection"}`
              : `Set up ${def?.label ?? "connection"}`}
          </CardTitle>
          <CardDescription>
            Credentials are encrypted when saved and are never shown again. Leave a credential blank
            to keep the saved one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="int-provider">Integration</Label>
              <select
                id="int-provider"
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as ProviderKey);
                  setMode("demo");
                  setConfig({});
                  setCredentials({});
                }}
              >
                {providers.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="int-outlet">Outlet</Label>
              <select
                id="int-outlet"
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={outletId}
                onChange={(e) => setOutletId(e.target.value)}
              >
                {provider !== "printer" ? <option value="">All outlets</option> : null}
                {outlets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              {provider === "printer" ? (
                <p className="text-muted-foreground text-xs">Each printer serves one outlet.</p>
              ) : null}
            </div>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Mode</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="int-mode"
                checked={mode === "demo"}
                onChange={() => setMode("demo")}
              />{" "}
              DEMO / sandbox (nothing is sent to a provider)
            </label>
            <label
              className={`flex items-center gap-2 text-sm ${def?.liveAvailable ? "" : "text-muted-foreground"}`}
            >
              <input
                type="radio"
                name="int-mode"
                checked={mode === "live"}
                disabled={!def?.liveAvailable}
                onChange={() => setMode("live")}
              />{" "}
              Live
              <span className="text-xs">
                {def?.liveAvailable ? "" : "Not available in this build."}
              </span>
            </label>
            {mode === "live" && def?.liveAvailable ? (
              <p className="text-muted-foreground text-xs">{def.liveNote}</p>
            ) : null}
          </fieldset>

          {def && CONFIG_KEYS[provider].length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {CONFIG_KEYS[provider].map((key) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={`cfg-${key}`}>{CONFIG_LABELS[key] ?? key}</Label>
                  {key === "paper_width_chars" ? (
                    <select
                      id={`cfg-${key}`}
                      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                      value={config[key] ?? "32"}
                      onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                    >
                      <option value="32">32 (58 mm, standard)</option>
                      <option value="42">42 (80 mm, condensed)</option>
                      <option value="48">48 (80 mm)</option>
                    </select>
                  ) : (
                    <Input
                      id={`cfg-${key}`}
                      value={config[key] ?? ""}
                      onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                      maxLength={200}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {def && def.credentialFields.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {def.credentialFields.map((field) => {
                const hint = existing?.credential_hints[field.name];
                return (
                  <div key={field.name} className="space-y-1.5">
                    <Label htmlFor={`cred-${field.name}`}>{field.label}</Label>
                    <Input
                      id={`cred-${field.name}`}
                      type={field.secret ? "password" : "text"}
                      autoComplete="off"
                      placeholder={hint ? `Saved ${hint}. Leave blank to keep.` : "Not saved"}
                      value={credentials[field.name] ?? ""}
                      onChange={(e) =>
                        setCredentials({ ...credentials, [field.name]: e.target.value })
                      }
                      maxLength={500}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Turn on (only takes effect after a passing connection test)
          </label>

          <div>
            <Button onClick={save} disabled={pending || !def}>
              {pending ? "Saving…" : "Save connection"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="agents-heading" className="space-y-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base" id="agents-heading">
              Print agents
            </CardTitle>
            <CardDescription>
              A print agent runs on a computer on the outlet&apos;s network and sends jobs to live
              printers. The server never connects to a printer directly. Copy the agent folder from
              this project to that computer and keep it running.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {newToken ? (
              <div
                role="alert"
                className="space-y-2 rounded-md border border-amber-500/40 bg-amber-50 p-3 dark:bg-amber-950/30"
              >
                <p className="font-medium">Copy this token now. It will not be shown again.</p>
                <p className="text-muted-foreground text-xs">Agent: {newToken.name}</p>
                <code className="bg-background block rounded px-2 py-1 text-xs break-all">
                  {newToken.token}
                </code>
                <p className="text-xs">
                  On the outlet computer (Node.js 18 or newer, no install needed), run:
                </p>
                <code className="bg-background block rounded px-2 py-1 text-xs break-all">
                  {`RESTRO_URL=${runOrigin} AGENT_TOKEN=${newToken.token} node agent/print-agent.mjs`}
                </code>
                <p className="text-muted-foreground text-xs">
                  Keep the token private. Anyone with it can receive print jobs for this outlet.
                </p>
                <Button size="sm" variant="ghost" onClick={() => setNewToken(null)}>
                  I have copied it
                </Button>
              </div>
            ) : null}

            {panel.agents.length === 0 ? (
              <p className="text-muted-foreground">No print agents yet.</p>
            ) : (
              <ul className="space-y-2">
                {panel.agents.map((g) => (
                  <li
                    key={g.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-3"
                  >
                    <span className="font-medium">{g.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {outletName.get(g.outlet_id) ?? "Outlet"}
                    </span>
                    <Badge variant={g.revoked_at ? "outline" : "secondary"}>
                      {g.revoked_at ? "Revoked" : "Active"}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      Last seen: {g.last_seen_at ? fmt(g.last_seen_at) : "Never"}
                    </span>
                    {g.revoked_at ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => revokePrintAgentAction({ businessId, agentId: g.id }),
                            "Agent revoked. Its token no longer works.",
                          )
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {outlets.length === 0 ? (
              <p className="text-muted-foreground">Add an outlet before creating an agent.</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="agent-outlet">Outlet</Label>
                  <select
                    id="agent-outlet"
                    className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                    value={agentOutlet}
                    onChange={(e) => setAgentOutlet(e.target.value)}
                  >
                    {outlets.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="agent-name">Agent name</Label>
                  <Input
                    id="agent-name"
                    value={agentName}
                    maxLength={60}
                    placeholder="Kitchen PC"
                    onChange={(e) => setAgentName(e.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    variant="outline"
                    disabled={pending || !agentOutlet || agentName.trim() === ""}
                    onClick={() => {
                      const name = agentName.trim();
                      startTransition(async () => {
                        const result = await registerPrintAgentAction({
                          businessId,
                          outletId: agentOutlet,
                          name,
                        });
                        if (result.ok) {
                          setNewToken({ name, token: result.token });
                          setAgentName("");
                          setNotice({ tone: "ok", text: "Agent created. Copy its token now." });
                          router.refresh();
                        } else {
                          setNotice({ tone: "err", text: result.error });
                        }
                      });
                    }}
                  >
                    Create agent
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent jobs</CardTitle>
          <CardDescription>
            Jobs are retried with backoff (1, 2, 4, 8 minutes), up to five tries.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto text-sm">
          {panel.jobs.length === 0 ? (
            <p className="text-muted-foreground">No jobs yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr>
                  <th className="py-1 pr-3">Created</th>
                  <th className="py-1 pr-3">Operation</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className="py-1 pr-3">Tries</th>
                  <th className="py-1 pr-3">Last error</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {panel.jobs.map((j) => (
                  <tr key={j.id} className="border-t">
                    <td className="py-1.5 pr-3">{fmt(j.created_at)}</td>
                    <td className="py-1.5 pr-3">{j.operation}</td>
                    <td className="py-1.5 pr-3">{j.status}</td>
                    <td className="py-1.5 pr-3">
                      {j.attempts}/{j.max_attempts}
                    </td>
                    <td className="py-1.5 pr-3">{j.last_error ?? "—"}</td>
                    <td className="py-1.5 text-right">
                      {j.status === "dead" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            run(
                              () => retryIntegrationJobAction({ businessId, jobId: j.id }),
                              "Job queued again.",
                            )
                          }
                        >
                          Retry
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity log</CardTitle>
          <CardDescription>
            Every attempt and connection test. Credentials never appear here.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto text-sm">
          {panel.logs.length === 0 ? (
            <p className="text-muted-foreground">Nothing logged yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr>
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">Operation</th>
                  <th className="py-1 pr-3">Mode</th>
                  <th className="py-1 pr-3">Outcome</th>
                  <th className="py-1 pr-3">Message</th>
                </tr>
              </thead>
              <tbody>
                {panel.logs.map((l) => (
                  <tr key={l.id} className="border-t">
                    <td className="py-1.5 pr-3">{fmt(l.created_at)}</td>
                    <td className="py-1.5 pr-3">{l.operation}</td>
                    <td className="py-1.5 pr-3">{l.mode.toUpperCase()}</td>
                    <td className="py-1.5 pr-3">{l.outcome}</td>
                    <td className="py-1.5 pr-3">{l.error_message ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {exportable ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{exportable.label}</CardTitle>
            <CardDescription>
              {exportable.description} The file is built on the spot from the sales report.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              method="get"
              action="/api/integrations/accounting/export"
              className="grid gap-4 md:grid-cols-4"
            >
              <input type="hidden" name="business" value={businessId} />
              <div className="space-y-1.5">
                <Label htmlFor="acc-outlet">Outlet</Label>
                <select
                  id="acc-outlet"
                  name="outlet"
                  className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                  defaultValue=""
                >
                  <option value="">All outlets</option>
                  {outlets.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acc-from">From</Label>
                <Input
                  id="acc-from"
                  name="from"
                  type="date"
                  defaultValue={firstOfMonthIst()}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acc-to">To</Label>
                <Input id="acc-to" name="to" type="date" defaultValue={todayIst()} required />
              </div>
              <div className="flex items-end">
                <Button type="submit" variant="outline">
                  Download CSV
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
