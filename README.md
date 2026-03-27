# OpenDialogue

> Real-time communication infrastructure for OpenClaw Agents.

OpenDialogue lets locally deployed OpenClaw agents exchange messages in real time without requiring this repository to expose a production relay server.

## What this repository includes

This repo currently contains only the **local-side MVP**:

- **Skill** — the OpenClaw-facing instructions for setup, status, and sending messages
- **Plugin** — a local daemon that connects to a relay and forwards inbound messages into OpenClaw through official webhook ingress
- **Mock Server** — a development relay used to validate the local end-to-end flow

## What this repository does not include

This repo does **not** implement the real cloud relay server.

That is intentional.

At the current phase, the project is validating the local chain first:

1. relay message received by plugin
2. plugin validates message
3. plugin forwards message through OpenClaw webhook ingress
4. OpenClaw executes the resulting hook run

Only after this chain is stable does it make sense to build the production relay in a separate repository.

## Confirmed OpenClaw integration model

Based on official OpenClaw docs and local verification, the plugin integrates with OpenClaw through **webhook ingress**, not `hooks.internal`.

Confirmed config fields under `openclaw.json -> hooks`:

- `enabled`
- `token`
- `path`
- `allowedAgentIds`
- `defaultSessionKey`
- `allowRequestSessionKey`
- `allowedSessionKeyPrefixes`

Confirmed defaults / endpoints:

- `hooks.path` default: `/hooks`
- `GET http://127.0.0.1:18789/health`
- `POST http://127.0.0.1:18789/hooks/agent`

## Verified local E2E result

The local MVP chain has been validated end to end for:

- `mock-server -> plugin -> /hooks/agent -> OpenClaw hook run`

Verified evidence:

- plugin received and validated a signed WebSocket message from mock-server
- plugin forwarded it successfully to `/hooks/agent`
- OpenClaw accepted the webhook request and created a real hook run
- the hook run executed in a dedicated hook session

## Important behavior constraint discovered during validation

The forwarded message content is currently treated by OpenClaw as **external untrusted input**.

That means OpenDialogue currently behaves like:

- a **secure message relay**
- a **safe external message delivery path**

It does **not** currently behave like:

- a high-trust remote command channel
- a reliable exact-instruction execution path from one remote agent to another

In validation, a test message asked the target agent to reply with exactly `OPENDIALOGUE_E2E_OK`. OpenClaw did receive the message and execute the run, but the agent explicitly refused to obey that exact external instruction because it was labeled as untrusted webhook content.

## Current completion target

The current repository is considered successful when it can reliably do all of the following locally:

- start the mock server
- start the plugin
- confirm OpenClaw Gateway readiness
- receive a signed message from mock server
- validate and queue / forward it correctly
- inject it into OpenClaw using `/hooks/agent`
- expose local status on `127.0.0.1:18791` (fallback to `18787` if needed during local validation)
- allow a local outbound send through `POST /send`

## Known limitations

- no production relay server in this repo
- no production registration service in this repo
- no production offline persistence in this repo
- webhook injection is currently `message`-template-based
- remote messages are treated as untrusted input by OpenClaw
- `AGENT_TOKEN` is MVP-level env-based for now; keychain integration is later

## Project status

🚧 Local plugin + mock-server MVP in progress, with the main webhook-ingress path already validated.

See [plan_todo.md](./plan_todo.md) for the implementation boundary and task plan.
