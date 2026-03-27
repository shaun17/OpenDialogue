# OpenDialogue Setup

## Scope first

This repository currently sets up only the **local side** of OpenDialogue:

- local plugin daemon
- local OpenClaw webhook-ingress integration
- local mock-server-based end-to-end validation

It does **not** install or implement a production relay server.

## OpenClaw baseline

Officially confirmed webhook-ingress config fields:

- `hooks.enabled`
- `hooks.token`
- `hooks.path`
- `hooks.allowedAgentIds`
- `hooks.defaultSessionKey`
- `hooks.allowRequestSessionKey`
- `hooks.allowedSessionKeyPrefixes`

Default path:

- `hooks.path = /hooks`

Confirmed relevant HTTP endpoints:

- `GET http://127.0.0.1:18789/health`
- `POST http://127.0.0.1:18789/hooks/agent`

## What the plugin must ensure

1. load `~/.openclaw/openclaw.json`
2. ensure `hooks.enabled=true`
3. ensure `hooks.token` exists
4. set `hooks.path` to `/hooks` when absent
5. keep `hooks.allowRequestSessionKey=false` for MVP unless explicitly needed
6. use Bearer auth when calling `/hooks/agent`

## Responsibility boundary

- **relay / server side** should own real offline message accumulation and replay
- **plugin side** should only own local receive/validate/forward behavior plus a small transient buffer for short local gaps, such as Gateway not being ready yet

Do not treat the plugin queue as a durable offline message system.

## MVP environment variables

Current local plugin expectations:

- `OPENDIALOGUE_AGENT_TOKEN` — relay auth token
- `OPENDIALOGUE_AGENT_ID` — local logical agent id
- `OPENDIALOGUE_SERVER_URL` — relay or mock-server websocket endpoint
- optional OpenClaw base URL override if needed later
- optional local status port override

## Recommended local development flow

1. start mock-server
2. start plugin
3. verify `GET /status`
4. verify OpenClaw Gateway health
5. inject a test message through mock-server
6. confirm plugin accepts and forwards it to `/hooks/agent`
7. verify `/send` emits a structured outbound protocol message

## Known limitations

- no production relay server here
- no production registration flow here
- no keychain integration yet
- inbound OpenClaw injection currently uses a message template, not a richer structured mapping/transform flow
- plugin buffering is transient only, not a durable offline queue
