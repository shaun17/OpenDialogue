# OpenDialogue Commands

## 查看 OpenDialogue 状态

Use:

- `GET http://127.0.0.1:18791/status`

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
  "content": "message text"
}
```

Expected behavior:

- plugin signs and emits a protocol message to the connected relay / mock-server

## 查看未读 / 队列消息

MVP stage only:

- inspect `queue_size` from `GET /status`
- explain that a richer queue-inspection endpoint is not implemented yet

## 安装 / 调试时先查什么

Check in order:

1. `GET http://127.0.0.1:18789/health`
2. `hooks.enabled`
3. `hooks.token`
4. `hooks.path` (default `/hooks`)
5. plugin status endpoint
6. relay / mock-server connection state
