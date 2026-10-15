# Phase 18 — External integrations framework

This phase adds one framework for every external connection: payments, aggregators,
messaging, printers and accounting exports. It is built around one rule from the spec:
**never fake a live integration.**

## What is live and what is not

| Integration | Status in this build | Why |
|---|---|---|
| Razorpay | DEMO only. Live is a stub that fails with `not_built`. | No live adapter has been built or tested. |
| Swiggy | DEMO only. Live is refused by the database. | No self-serve API. Access is through partner onboarding only. |
| Zomato | DEMO only. Live is refused by the database. | No self-serve API. The public developer API is discontinued. |
| WhatsApp Cloud | DEMO only. Live is a stub. | No live adapter yet. Inbound signature checks are built and tested. |
| SMS (Twilio) | DEMO only. Live is a stub. | No live adapter yet. Inbound signature checks are built and tested. |
| Email (Resend) | DEMO only. Live is a stub. | No live adapter yet. Svix signature checks are built and tested. |
| Network printer (ESC/POS) | Live through the on-site print agent (`agent/print-agent.mjs`). The agent runs on the outlet's network and sends bytes to the printer on port 9100. A live printer becomes connected only after its agent connection test passes. The agent's code is tested, but it has not been run against real hardware. DEMO prints nothing and returns the byte count. | The server cannot reach a LAN printer, so the agent does it. |
| Accounting CSV | Live. It is a file download, not a connection. | No external service is contacted. |

Every DEMO result says `simulated: true`. The settings page labels every connection
DEMO, and the Live option is disabled with the reason shown. A connection that passes a
test in DEMO mode means only that the DEMO adapter responded. It does not mean that a
provider was reached.

## Architecture

- **Catalogue** (`src/modules/integrations/catalog.ts`): providers, operations, credential
  fields and `liveAvailable`. Operation names match the database allow-list.
- **Adapters** (`adapters.ts`): one DEMO adapter per provider and live stubs. The server holds no
  printer socket code. A live printer resolves to no adapter here, because the print agent handles it.
  Adapters never return credentials and never echo message content.
- **Worker** (`worker.ts`): a pure pipeline with injected dependencies. It claims a batch,
  checks the account, decrypts credentials, sends, and reports the outcome.
- **Database** (`supabase/migrations/20261016100000_integrations.sql`): accounts, encrypted
  secrets, jobs, logs and webhook receipts. RLS is on and client roles have no grants. All
  RPCs are service-role only and check permissions inside the database.
- **Routes**: `POST /api/integrations/worker`, the inbound webhook route under
  `/api/webhooks/integrations/{provider}/{accountId}`, `GET /api/integrations/accounting/export`,
  and the print agent's `POST /api/integrations/agent/claim` and `POST /api/integrations/agent/report`.
- **Settings**: `/settings/integrations` (owners and managers only, `settings.manage`).

## Credentials

- Encrypted with AES-256-GCM. The additional authenticated data is the account id, so a
  ciphertext copied to another account fails to decrypt.
- Stored as `v1:iv:tag:ciphertext`. The key comes from `INTEGRATION_ENCRYPTION_KEY`, which
  is 32 random bytes, base64-encoded. It is not stored in the database.
- Only a hint is shown afterwards: the last four characters of a secret, or `set` for a short
  value. Credentials never appear in audit rows, logs, or the settings panel.
- Saving a single credential keeps the others. The stored blob is merged, not replaced.
- Rotating the key makes stored credentials unreadable. Re-enter them after a rotation.

## Jobs, retry and idempotency

- Each job has an idempotency key per account. The same key returns the same job.
- A job is claimed under a lease (120 seconds). An expired lease is reclaimed as the next attempt.
- Retryable failures back off 1, 2, 4 and 8 minutes. The fifth failure marks the job dead.
- Fatal failures mark the job dead and set the connection to `error`, which blocks new work
  until a test passes.
- Every attempt is logged with its number and outcome.
- Enqueueing needs a connection that is `connected` and turned on. Any settings change
  resets the connection to untested and turns it off.
- The worker is triggered by a scheduler that calls `POST /api/integrations/worker` with
  `Authorization: Bearer $INTEGRATION_WORKER_SECRET`. Nothing runs without that call.
- **Executor routing.** Each job has an `executor`. A live printer's jobs get `agent`, and every
  other job gets `worker`. The server worker claims only `worker` jobs, so it never sends to a LAN
  printer. Agents claim only `agent` jobs for their own outlet.

## Webhooks

- Verification happens before anything is parsed or recorded, and it uses constant-time
  comparisons: Razorpay (HMAC-SHA256), Svix/Resend (with a five-minute timestamp window),
  Meta/WhatsApp (`sha256=` HMAC), and Twilio (HMAC-SHA1 over the public URL and sorted params).
- The Twilio check uses the configured `NEXT_PUBLIC_APP_URL`, which must match the URL
  Twilio calls.
- A verified event is claimed once per account (`webhook_events`). A replay is a duplicate. An
  altered payload under the same event id is refused with 409.
- Only live, enabled and connected accounts receive webhooks. A verified event never changes an
  order, a payment or a customer in this phase.
- The Svix and Twilio test vectors in the test suite come from the providers' documentation.

## Printers

- ESC/POS bytes are built in pure code (`escpos.ts`). Text is ASCII, wrapped at 32, 42 or 48
  characters. The bytes are built on the server for live jobs and inside the DEMO adapter.
- A live printer needs no credentials. Its settings are the outlet and the printer's IP
  address or host name. Saving checks an IP literal (loopback, link-local and the other
  blocked ranges are refused) and numeric-only names. A host name is checked by the agent when it
  connects.
- Live printing works through the print agent, described below. The server never opens a
  socket to a printer.
- The port is always 9100 and is never taken from configuration.

## Print agent

The agent is an outbound-only poller. It runs on a computer on the outlet's network, so the
printer never needs a public address, and the server never needs a route into the LAN.

**Setup.** In `/settings/integrations`, under Print agents, choose an outlet and a name and
create the agent. The token (it starts with `ragt_`) is shown once. Copy it then. Only its
SHA-256 hash is stored. To revoke an agent, press Revoke: its token stops working at once.

**Run.** Copy the `agent/` folder to the outlet computer. It needs Node.js 18 or newer, and it
has no dependencies. Then run:

```
RESTRO_URL=https://your-restro-app.example AGENT_TOKEN=ragt_… node agent/print-agent.mjs
```

Optional: `POLL_SECONDS` (2–60, default 5) and `BATCH` (1–10, default 5). `RESTRO_URL` must be
https. http is accepted only for localhost.

**Flow.**

1. Save the printer as live with its IP address. It starts untested and off.
2. Press Test connection. This queues a `connection.test` job for the agent.
3. The agent opens a socket to the printer and closes it. It sends no bytes, so nothing prints.
   A pass sets the printer to connected. A failure sets it to error, with the reason shown.
4. Turn the printer on. Print test page now queues a `print.document` job.
5. The agent claims the job, sends the bytes, and reports the result. A refused or timed-out print
   is retried with backoff. A blocked address fails the job and marks the printer as an error.

**Safety in the agent** (`agent/print-agent.mjs`, which has its own copy of the guard):

- It resolves each host name and checks every address. It refuses loopback, link-local
  (including `169.254.169.254`), unspecified, multicast, reserved and IPv4-mapped forms of
  these. Private LAN addresses are allowed.
- It connects to the address it checked, not to the name, and the port is fixed at 9100.
- Each connect and each write has a 4-second timeout. A print job is at most 64 KB.
- The token is sent only in the `Authorization` header. The agent's logs never show the token or
  the bytes.

**Delivery.** Delivery is at least once. If the agent sends a page but cannot save its report,
the lease expires and the job is claimed again, so that page could print twice. The activity log
shows each attempt.

**Server routes.** `POST /api/integrations/agent/claim` takes the agent token and returns due jobs
for its outlet, with bytes built on the server. `POST /api/integrations/agent/report` takes the
job's outcome. Both return 401 for an unknown or revoked token, and the report returns 409 if the
agent does not hold the job's lease.

## Accounting export

`GET /api/integrations/accounting/export?business=…&outlet=…&from=…&to=…` returns a CSV of
the `sales-daily` report rows, with the report's own numbers. It needs `reports.view` and the
same row cap as the reports export: above the cap, the export is refused, not truncated.
Money is plain decimal rupees with no thousands separators. Text cells are guarded against
formula injection.

## Verification

- `scripts/local-pg/assertions-phase18.sql` (13 sections, in `scripts/verify-db.sh`) covers
  provider rules, permissions, the enqueue gate, idempotency, the lease, backoff, exhaustion,
  fatal errors, retry, lease recovery, webhook idempotency, connection tests, grants, RLS,
  the panel loader, the audit trail, and print agents (P18.12: outlet scope, token hashing,
  executor routing, the agent test gate, lease ownership and revocation).
- `src/modules/integrations/integrations.test.ts` (64 tests) covers encryption, signatures,
  the printer guard, ESC/POS, adapters, worker decisions, save validation, the catalogue and
  the CSV. `src/modules/integrations/agent.test.ts` (12 tests) covers agent tokens, job
  conversion, request bodies and the save-time host check.
- `agent/print-agent.test.mjs` (16 tests, `npm run test:agent`) covers the agent's address
  guard, real TCP sends to a loopback printer, refused connections, job outcomes, and polling with
  a stubbed server. It also checks that the token never appears in logs.

## Not in this phase

- Live adapters for any provider. Each one needs its own credentials, sandbox access and tests.
- Acting on verified webhook events (for example, updating order status from a delivery
  partner). Events are recorded only.
- Automatic printing of kitchen tickets from the KDS. The printer adapter is ready, but the
  producer is a later phase.
- Hardware testing of the print agent against a real printer. The agent is tested against
  loopback TCP servers only.
