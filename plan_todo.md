# OpenDialogue — Plan & TODO

> **一句话定义**：OpenDialogue 是一个让本地部署的 OpenClaw Agent 之间能够实时通讯的基础设施；当前仓库仅负责 **本地 Plugin / Skill / Mock Server**，真实云端 Relay Server 不在本仓库实现。

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [仓库范围](#2-仓库范围)
3. [OpenClaw 接入基线（已调研确认）](#3-openclaw-接入基线已调研确认)
4. [本地架构](#4-本地架构)
5. [安全与边界](#5-安全与边界)
6. [MVP 消息流程](#6-mvp-消息流程)
7. [已验证结果与当前约束](#7-已验证结果与当前约束)
8. [TODO 任务列表](#8-todo-任务列表)
9. [目录结构](#9-目录结构)
10. [待决策问题](#10-待决策问题)

---

## 1. 背景与动机

### 问题

OpenClaw Agent 多数运行在用户自己的机器上，通常没有公网入口，也不适合直接暴露本地服务。现有主流通信方式依赖 Telegram / Discord / WhatsApp 等外部平台，难以形成 Agent 与 Agent 之间的直接实时通信基础设施。

### 当前阶段目标

先完成**本地侧能力**：

- Plugin 能连接一个 relay（先用 Mock Server）
- Plugin 能安全接收远端消息
- Plugin 能通过 **OpenClaw 官方 webhook ingress** 把消息转交给本地 OpenClaw
- Skill 能查看状态、发送消息、辅助安装与排障

这一步的目标不是做完整生产系统，而是把**本地主链路跑通**。

---

## 2. 仓库范围

### 2.1 本仓库包含

- `SKILL.md`
- `references/`
- `plugin/`（本地守护进程）
- `mock-server/`（开发期 relay 替身）
- 文档、安装说明、联调脚本

### 2.2 本仓库不包含

- 真实云端 relay server
- 生产级 agent 注册平台
- 生产级离线消息存储
- 生产级多租户控制台

> **重要约束**：不要在本仓库中继续扩展真实 `server/` 实现。

---

## 3. OpenClaw 接入基线（已调研确认）

基于 OpenClaw 官方文档与本机核查，当前确定如下：

### 3.1 官方支持的 webhook ingress 配置

`openclaw.json` 的 `hooks` 下支持：

- `enabled`
- `token`
- `path`
- `allowedAgentIds`
- `defaultSessionKey`
- `allowRequestSessionKey`
- `allowedSessionKeyPrefixes`

### 3.2 默认路径

- `hooks.path` 默认值为 **`/hooks`**

因此标准入口为：

- `POST http://127.0.0.1:18789/hooks/wake`
- `POST http://127.0.0.1:18789/hooks/agent`

### 3.3 官方支持的 `/hooks/agent` payload 关键字段

- `message`（required）
- `name`
- `agentId`
- `sessionKey`
- `wakeMode`
- `deliver`
- `channel`
- `to`
- `model`
- `thinking`
- `timeoutSeconds`

### 3.4 当前实现结论

OpenDialogue Plugin 与 OpenClaw 的集成方式必须采用：

- **Webhook ingress**
- `Authorization: Bearer <hooks.token>`
- `POST /hooks/agent`

而不是依赖 `hooks.internal`。

---

## 4. 本地架构

### 4.1 组件关系

```text
OpenClaw (local)
   ▲
   │ POST /hooks/agent
   │ Authorization: Bearer <HOOK_TOKEN>
   │
Plugin (local daemon)
   ▲
   │ WebSocket
   │
Mock Server (development only)
```

### 4.2 三类关键凭证

| 凭证 | 用途 | 存放位置 |
|------|------|----------|
| `HOOK_TOKEN` | Plugin 调 OpenClaw webhook ingress | `~/.openclaw/openclaw.json` |
| `AGENT_TOKEN` | Plugin 连接 relay 身份认证 | 环境变量 / 后续迁移到系统密钥链 |
| `SESSION_KEY` | Relay 下发的短期消息验签密钥 | 内存中，仅运行期存在 |

### 4.3 Plugin 启动顺序

```text
Plugin 启动
  │
  ├─ 读取 / 修正 openclaw.json 中的 hooks 配置
  ├─ 确保 hooks.enabled=true
  ├─ 确保 hooks.token 存在
  ├─ 使用默认 hooks.path=/hooks（若未配置）
  ├─ 探测 OpenClaw Gateway /health
  ├─ 建立与 Mock Server / Relay 的连接
  ├─ 接收 session_key
  └─ 接收消息 → 验签 → 转发给 /hooks/agent
```

---

## 5. 安全与边界

### 5.1 本地 OpenClaw 集成边界

Plugin 只做两件事：

1. 调 `GET /health` 判断 Gateway 是否就绪
2. 调 `POST /hooks/agent` 把经过验证的远端消息送入 OpenClaw

Plugin 不依赖未文档化的 OpenClaw 内部接口。

### 5.2 消息验证基线

MVP 阶段保留以下校验：

- HMAC-SHA256 验签
- timestamp 窗口（±5 分钟）
- nonce 去重
- type 白名单：`text`, `typing`, `read_receipt`
- content 长度限制：≤ 2000
- 控制字符过滤

### 5.3 Prompt Injection 防护策略（MVP）

因为官方 `/hooks/agent` 公开文档里以 `message` 为主输入，所以 MVP 阶段不假设任意自定义 `context` 字段都能被稳定消费。

因此当前策略是：

- 将远端消息封装为**固定模板文本**写入 `message`
- 明确声明这是一段**来自外部 Agent 的不可信输入**
- 不把远端原文混入系统提示

后续如需要更强结构化注入，再基于 OpenClaw 官方 hook mappings / transforms 能力升级。

### 5.4 队列职责边界

- **真实离线消息堆积** 应由未来的 relay / server 负责
- plugin 侧缓冲只应用于 **本地短暂窗口**，例如已经收到消息但 OpenClaw Gateway 暂时未 ready

plugin 当前的内存队列应理解为 **local transient buffer**，不是 durable offline queue。

---

## 6. MVP 消息流程

### 6.1 接收远端消息

```text
Mock Server / Relay
  └─ 推送消息包
       │
       ▼
Plugin
  ├─ 校验签名
  ├─ 校验 timestamp / nonce / type / content
  ├─ Gateway 未就绪 → 进入本地短暂缓冲
  └─ Gateway 已就绪 → POST /hooks/agent
```

### 6.2 Plugin 转交给 OpenClaw

```http
POST /hooks/agent
Authorization: Bearer <HOOK_TOKEN>
Content-Type: application/json

{
  "message": "You received a message from another OpenDialogue agent...",
  "name": "OpenDialogue",
  "wakeMode": "now"
}
```

### 6.3 主动发送消息

```text
User / Skill
  └─ POST 127.0.0.1:18791/send
       │
       ▼
Plugin
  └─ 构造签名后的协议消息 → 发给 Mock Server / Relay
```

---

## 7. 已验证结果与当前约束

### 7.1 已验证成功的链路

本地 E2E 已验证成功：

- `mock-server -> plugin -> /hooks/agent -> OpenClaw hook run`
- `POST /send -> plugin -> relay target websocket`
- invalid-signature inbound messages are dropped without crashing the plugin
- relay reconnect works after relay startup order changes

已确认：

- mock-server 可以向 plugin 发送签名后的 WebSocket 消息
- plugin 可以完成验签并转发至 `/hooks/agent`
- OpenClaw 会接受请求并创建实际 hook run
- 对应 run 会在独立 hook session 中执行
- `/send` 会实际发出结构化协议消息到目标 relay 连接
- 非法签名消息会被丢弃，且不会打崩 plugin
- relay 晚启动时，plugin 会自动重连恢复

### 7.2 关键行为约束

验证同时发现：当前 webhook 注入内容会被 OpenClaw 视为 **external untrusted input**。

这意味着当前 OpenDialogue 更适合作为：

- 安全消息中继
- 外部消息转达通道
- 低信任文本交流路径

而不应默认当作：

- 高信任远程控制通道
- 精确指令执行通道

### 7.3 对 MVP 定位的影响

因此当前 MVP 产品定位应更接近：

- **agent-to-agent secure message relay**

而不是：

- **remote command / control plane**

如果未来要支持更高信任、更强控制的交互，需要额外设计：

- 更明确的信任分级
- 更安全的结构化 payload 注入方式
- 更严格的身份与授权模型

---

## 8. TODO 任务列表

> **执行原则**：只做当前仓库范围内的内容。真实云端 relay server 不在本仓库开发。

### ✅ Phase 0 — 调研与基线确认（已完成）

- [x] 确认 OpenClaw 官方支持 `hooks.enabled`
- [x] 确认 OpenClaw 官方支持 `hooks.token`
- [x] 确认 OpenClaw 官方支持 `hooks.path`
- [x] 确认 `hooks.path` 默认值为 `/hooks`
- [x] 确认官方支持 `POST /hooks/agent`
- [x] 确认官方支持 `Authorization: Bearer <token>` / `x-openclaw-token`
- [x] 明确当前仓库不实现真实 relay server

### ✅ Phase 1 — 文档与 Skill（已完成）

- [x] 重写 README，使范围与当前阶段一致
- [x] 重写 `plan_todo.md`，去掉真实 server 开发歧义
- [x] 重写 `SKILL.md`，只保留当前仓库职责
- [x] 重写 `references/setup.md`
- [x] 重写 `references/commands.md`

### 🟡 Phase 2 — Plugin MVP（基础可运行，继续完善）

- [x] `config.ts`
  - [x] 读取 `openclaw.json`
  - [x] 确保 `hooks.enabled=true`
  - [x] 确保 `hooks.token` 存在
  - [x] 默认 `hooks.path=/hooks`
  - [x] 尽量不破坏其他配置字段
- [x] `gateway-probe.ts`
  - [x] 探测 `GET /health`
  - [x] 重试与超时策略
- [x] `hook-client.ts`
  - [x] 调 `POST /hooks/agent`
  - [x] Bearer token 鉴权
  - [x] 错误返回处理
- [x] `message-queue.ts`
  - [x] 本地队列上限控制
  - [x] flush 失败回退
- [x] `security.ts`
  - [x] HMAC 校验
  - [x] nonce / timestamp / type / content 校验
- [x] `daemon.ts`
  - [x] WebSocket 主循环
  - [x] session_key 接收
  - [x] ping / pong
  - [x] relay 自动重连
  - [x] 队列与转发联动
- [x] `status-server.ts`
  - [x] `GET /status`
  - [x] `POST /send`
- [x] `index.ts`
  - [x] 统一初始化与日志输出
- [ ] 继续补更细日志、失败分类
- [ ] 将本地短暂缓冲语义进一步收紧与简化

### ✅ Phase 3 — Mock Server MVP（已完成）

- [x] 支持 Plugin 连接
- [x] 下发 `session_key`
- [x] 响应 ping/pong
- [x] 支持通过 stdin 注入测试消息
- [x] 支持把 Plugin 发送的消息转发给目标连接

### 🟡 Phase 4 — 本地联调（核心主链路已完成）

- [x] 跑通 Mock Server → Plugin → OpenClaw webhook
- [x] 跑通 `GET /status`
- [x] 跑通 `POST /send`
- [x] 验证非法签名消息被丢弃
- [x] 验证 OpenClaw 会实际创建并执行 hook run
- [x] 验证当前 webhook 内容按不可信输入处理
- [x] 验证 relay 晚启动时 plugin 自动重连
- [ ] 仅作为本地短暂缓冲，重新验证 Gateway not-ready buffering 的最小语义

### 📦 Phase 5 — 安装与可用性整理

- [ ] 补最小安装说明
- [ ] 补故障排查说明
- [x] 明确环境变量约定
- [x] 明确当前限制与非目标

---

## 9. 目录结构

```text
OpenDialogue/
├── README.md
├── plan_todo.md
├── SKILL.md
├── references/
│   ├── setup.md
│   └── commands.md
├── plugin/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── config.ts
│       ├── gateway-probe.ts
│       ├── hook-client.ts
│       ├── message-queue.ts
│       ├── security.ts
│       ├── daemon.ts
│       └── status-server.ts
├── mock-server/
│   ├── package.json
│   ├── package-lock.json
│   └── index.js
└── references/
```

---

## 10. 待决策问题

| 问题 | 选项 | 当前倾向 |
|------|------|---------|
| OpenClaw 入站 payload 策略 | message-only / mapping-transform | 先 message-only |
| `hooks.path` 是否显式写入 | 显式写入 / 依赖默认值 | 先显式写入，更清晰 |
| `hooks.defaultSessionKey` | 固定 / 不设置 | 先不强依赖，后续再定 |
| `hooks.allowedAgentIds` | 开放 / 白名单 | 生产用白名单 |
| `allowRequestSessionKey` | true / false | false |
| AGENT_TOKEN 存储 | env / keytar | MVP 先 env |
| Mock Server 实现语言 | JS / TS | 先 JS，减少联调成本 |
| OpenDialogue 定位 | secure relay / remote control plane | 当前明确偏 secure relay |

---

*文档版本：0.6.0 | 已修正 plugin 与 relay 的职责边界，并更新联调验证状态*