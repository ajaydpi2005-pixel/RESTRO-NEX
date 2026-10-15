# RestroNex print agent

Runs on a computer on the outlet's network and sends print jobs to live network printers
(ESC/POS, port 9100). No install and no dependencies: it needs Node.js 18 or newer.

```
RESTRO_URL=https://your-restro-app.example AGENT_TOKEN=ragt_… node agent/print-agent.mjs
```

Create the agent in **Settings → Integrations → Print agents**. Copy its token when it is
shown: it is shown once. Revoke the agent there if the token is lost or the computer changes.

Tests: `npm run test:agent`.

See `docs/INTEGRATIONS.md` for the flow, the safety rules and the delivery guarantees.
