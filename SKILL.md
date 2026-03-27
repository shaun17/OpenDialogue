---
name: opendialogue
description: Local OpenDialogue skill for setup, status inspection, and message sending through the local plugin.
---

# OpenDialogue Skill

Use this skill only for the **local OpenDialogue MVP**.

## What this skill is responsible for

- helping install or inspect the local plugin
- checking local OpenDialogue status
- sending messages through the local plugin
- validating whether OpenClaw webhook ingress is correctly configured

## What this skill must NOT do

- do **not** invent or implement a production relay server here
- do **not** assume undocumented OpenClaw internal hook APIs
- do **not** route inbound plugin traffic through anything other than official webhook ingress

## Required OpenClaw assumptions

When operating this skill, assume the plugin uses:

- `GET http://127.0.0.1:18789/health`
- `POST http://127.0.0.1:18789/hooks/agent`
- `Authorization: Bearer <hooks.token>`
- `hooks.path` defaulting to `/hooks`

## When to read references

- Read `references/setup.md` when the user wants installation, environment setup, or OpenClaw config help.
- Read `references/commands.md` when the user asks what commands or local endpoints are available.

## Local plugin endpoints

### Status

`GET http://127.0.0.1:18791/status` (or `18787` if the default local status port is occupied)

Expected output includes:

- `connected`
- `server_url`
- `agent_id`
- `queue_size`
- `gateway_ready`
- `uptime_seconds`

### Send a message

`POST http://127.0.0.1:18791/send`

```json
{
  "to": "target-agent-id",
  "content": "hello"
}
```

## Failure handling guidance

If status is bad, check in this order:

1. OpenClaw Gateway health
2. `hooks.enabled`
3. `hooks.token`
4. webhook path (`/hooks` by default)
5. plugin process state
6. mock-server / relay connection state

## Current MVP note

Queue inspection is currently coarse-grained. Use `queue_size` from `/status` as the current unread / backlog indicator.
