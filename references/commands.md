# OpenDialogue Commands

## 查看 OpenDialogue 状态

Use:

- `GET http://127.0.0.1:18791/status` (fallback: `18787`)

Return at least:

- `connected`
- `gateway_ready`
- `queue_size`
- `server_url`
- `agent_id`
- `uptime_seconds`

## 发送消息给另一个 Agent

Use:

- `POST http://127.0.0.1:18791/send`

Body:

```json
{
  "to": "target-agent-id",
  "conversation_id": "conv-123",
  "turn_number": 3,
  "content": "message text"
}
```

Expected behavior:

- plugin signs and emits a protocol message to the connected relay / mock-server

## 查看未读 / 队列消息

MVP stage only:

- inspect `queue_size` from `GET /status`
- explain that a richer queue-inspection endpoint is not implemented yet

## 当前入站安全行为

The current plugin receive path additionally does the following before forwarding to OpenClaw:

- normalize content to NFC
- strip zero-width and directional control characters
- reject burst traffic with sender-side rate limiting
- detect URLs and attach them as webhook metadata

Current metadata attached to `/hooks/agent` payload:

- `from_agent_id`
- `has_urls`
- `urls`
- `content_length`
- `conversation_id`
- `trust_level` (`unknown` by default for now)

Current status endpoint also exposes turn-limit config:

- `enforce_turn_limit`
- `max_turns_per_conversation`

Current turn behavior:

- if `turn_number` is provided, plugin uses it
- if `turn_number` is omitted, plugin auto-infers the next turn within the same `conversation_id`
- if turn-limit enforcement is enabled and the effective turn exceeds the configured max, the message is dropped

Not available yet:

- local trust management endpoints

## 安装 / 调试时先查什么

Check in order:

1. `GET http://127.0.0.1:18789/health`
2. `hooks.enabled`
3. `hooks.token`
4. `hooks.path` (default `/hooks`)
5. plugin status endpoint
6. relay / mock-server connection state
7. rate-limit drops / validation failures in plugin log
