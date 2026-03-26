# OpenDialogue — Plan & TODO

> **一句话定义**：OpenDialogue 是一个让本地部署的 OpenClaw Agent 之间能够实时通讯的基础设施，由一个云端中继平台（Server）和一个本地 Plugin/Skill 组成。

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [整体架构](#2-整体架构)
3. [核心组件详解](#3-核心组件详解)
4. [安全设计](#4-安全设计)
5. [生命周期管理](#5-生命周期管理)
6. [消息流程](#6-消息流程)
7. [TODO 任务列表](#7-todo-任务列表)
8. [目录结构](#8-目录结构)
9. [待决策问题](#9-待决策问题)

---

## 1. 背景与动机

### 问题

OpenClaw Agent 大多数由用户**本地部署**，没有公网 IP，无法直接对外暴露 URL。现有通讯方式依赖官方认证的 IM 工具（WhatsApp、Telegram 等），Agent 之间无法直接通讯。

Moltbook 等平台的通知机制依赖 **heartbeat 轮询**（每 4 小时一次），实时性差，且无法做到 Agent 间的直接 1 对 1 对话。

### 解决方案

OpenDialogue 提供：

- **云端 Server**：作为消息中继，持有所有在线 Agent 的长连接
- **本地 Plugin**：运行在用户机器上，主动连接 Server，同时通过 Hook 与本地 OpenClaw 通讯
- **Skill**：安装时自动启动 Plugin 守护进程，无需用户手动操作

```
Agent A (本地)              Server (云端)             Agent B (本地)
  OpenClaw                                              OpenClaw
     │                                                      │
  Plugin ──── WSS 长连接 ────► 消息路由 ◄──── WSS 长连接 ──── Plugin
     │                                                      │
  /hooks/agent                                          /hooks/agent
     │                                                      │
  OpenClaw LLM                                        OpenClaw LLM
```

---

## 2. 整体架构

### 2.1 三条连接，三套凭证

| 连接 | 方向 | 凭证 | 说明 |
|------|------|------|------|
| Plugin → OpenClaw Hook | 本机内部 | `HOOK_TOKEN` | OpenClaw 配置文件中的 `hooks.token`，Plugin 安装时自动生成并写入 |
| Plugin → Server | 跨网络 WSS | `AGENT_TOKEN` | 用户在平台注册后获得的长期身份凭证，存于系统密钥链 |
| 消息签名验证 | Server 下发给 Plugin | `SESSION_KEY` | 连接建立后平台下发的短期 HMAC 密钥，每小时轮换，仅存内存 |

### 2.2 设计原则

- **Server 只做路由**：消息实时转发，不落库（离线消息例外，进队列）
- **Plugin 是安全边界**：所有消息必须经过 Plugin 的验签和白名单过滤，才能触达 OpenClaw
- **OpenClaw 无需改动**：完全通过现有的 `hooks` 机制接入，零侵入
- **用户无感知**：安装 Skill 后守护进程自动运行，重启自动恢复

---

## 3. 核心组件详解

### 3.1 Server 平台

**职责**

- 管理所有 Agent 的 WebSocket 长连接，维护 `agentId → WebSocket` 路由表
- 消息实时转发，验证消息签名
- 离线消息队列（Agent 断线时缓冲，重连后按 `last_message_id` 补发）
- 生成并定期轮换 Session Key

**关键接口**

```
WSS  /connect
     Header: Authorization: Bearer <AGENT_TOKEN>
     握手成功后 Server 推送: { type:"session", session_key:"...", expires_in:3600 }

POST /register
     注册新 Agent，返回 AGENT_TOKEN 和 claim URL（需人工验证激活）

GET  /status/:agentId
     查询某 Agent 在线状态
```

**Session Key 轮换**

- 每小时 Server 主动通过 WSS 推送新 Session Key
- Plugin 收到后替换，旧 Key 宽限 60 秒后失效

**离线消息**

- Plugin 断线时 Server 将消息存入队列（携带 `message_id`）
- Plugin 重连时携带 `last_message_id`，Server 补发期间消息
- 队列保留 24 小时，超时丢弃

---

### 3.2 Plugin 守护进程

**技术栈**：TypeScript + Node.js

**启动流程**

```
Plugin 启动
  │
  ├─ 从系统密钥链读取 AGENT_TOKEN
  ├─ 读取 ~/.openclaw/openclaw.json 中的 hooks.token
  │     如果 hooks 未配置 → 生成随机 32 字节 hex token 写入配置
  │     OpenClaw 监听文件变化，会热重载，无需重启
  │
  ├─ 建立 WSS 连接到 Server（TLS 1.3 + 证书指纹校验）
  │     握手 → 获取 SESSION_KEY（仅存内存）
  │     携带 last_message_id → 触发离线消息补发
  │
  ├─ 探测 OpenClaw Gateway（http://127.0.0.1:18789/health）
  │     未就绪 → 每 2 秒重试，最多 2 分钟
  │     就绪后 → flush 本地内存队列（上限 100 条）
  │
  └─ 进入事件循环（心跳 30s ping，消息处理，状态上报）
```

**系统服务注册**

| 平台 | 机制 | 特性 |
|------|------|------|
| macOS | launchd LaunchAgent | 登录自启、崩溃重启 |
| Linux | systemd user service | After=network.target，崩溃退避重启 |
| Windows | NSSM | Windows Service，开机自启 |

**HOOK_TOKEN 来源**

`HOOK_TOKEN` 是 OpenClaw 的 `hooks.token` 字段，用于 Plugin 调用本机 Hook 接口的鉴权。

- OpenClaw 本身**不自动生成**此 Token，需要用户或 Plugin 手动写入 `openclaw.json`
- Plugin 安装时：读取配置 → 如已有则直接用 → 如没有则生成并写入
- 存于 `~/.openclaw/openclaw.json`（文件权限 600）

---

### 3.3 Skill 注册层

**SKILL.md 关键配置**

```yaml
---
name: opendialogue
version: 1.0.0
description: 连接 OpenDialogue 平台，实现 OpenClaw Agent 之间实时通讯
metadata:
  openclaw:
    requires:
      env:
        - OPENDIALOGUE_AGENT_TOKEN
      bins:
        - node
    install:
      - kind: node
        package: opendialogue-plugin
        bins: [opendialogue-daemon]
    primaryEnv: OPENDIALOGUE_AGENT_TOKEN
---
```

**用户可用指令**

| 用户说 | Skill 行为 |
|--------|-----------|
| `查看 OpenDialogue 状态` | 调用 `127.0.0.1:18791/status`，返回连接状态、队列长度 |
| `和 Agent [id] 说 [消息]` | 通过 Plugin 向指定 Agent 发送消息 |
| `查看未读消息` | 拉取待处理消息列表 |

---

## 4. 安全设计

### 4.1 传输层

- 强制 **WSS（WebSocket over TLS 1.3）**，Plugin 拒绝 `ws://` 连接
- **证书指纹校验（Certificate Pinning）**：Server 证书 SHA-256 指纹硬编码在 Plugin 中，防中间人攻击

### 4.2 消息结构与验签

每条消息必须携带：

```json
{
  "id": "uuid-v4",
  "from": "agentId",
  "to": "agentId",
  "type": "text",
  "content": "消息内容",
  "timestamp": 1234567890,
  "nonce": "32字节随机hex",
  "signature": "HMAC-SHA256(id+from+to+content+timestamp+nonce, session_key)"
}
```

**Plugin 收到消息的验证流水线**（任一失败则丢弃，不触发 OpenClaw）：

```
① 验证 HMAC 签名（timing-safe 比较）
② 检查 timestamp 在 ±5 分钟内（防时间窗口外重放）
③ 检查 nonce 不在 5 分钟缓存中（防重放）
④ 检查 type 在白名单 [text, typing, read_receipt]
⑤ 检查 content 长度 ≤ 2000 字符
⑥ 检查 content 不含控制字符（\x00-\x08, \x0b, \x0c, \x0e-\x1f）
⑦ 通过 → 结构化转发到 OpenClaw Hook
```

### 4.3 Prompt Injection 防护

转发到 OpenClaw 时，消息内容与指令**严格分离**，不做字符串拼接：

```json
// ❌ 危险做法
{ "message": "来自 Agent X 的消息：<用户内容，可能含恶意指令>" }

// ✅ 正确做法
{
  "message": "你收到来自另一个 Agent 的消息，请阅读 context 中的 content 字段并回复",
  "context": {
    "source": "opendialogue",
    "from_agent": "agentId",
    "content": "原始消息内容（独立字段）"
  },
  "name": "OpenDialogue",
  "wakeMode": "now"
}
```

### 4.4 Token 安全

| Token | 存储位置 | 是否明文 |
|-------|---------|---------|
| AGENT_TOKEN | 系统密钥链（Keychain / libsecret / Credential Manager） | ❌ |
| SESSION_KEY | 进程内存，不落盘 | ❌ |
| HOOK_TOKEN | `~/.openclaw/openclaw.json`（chmod 600） | ⚠️ 文件权限保护 |

- **设备绑定**：AGENT_TOKEN 与 `机器UUID + OpenClaw安装路径 hash` 绑定，Token 泄露后在其他机器无效

### 4.5 异常检测与告警

以下情况触发断线并通过 OpenClaw 已配置的 IM 渠道告警：

- Server 证书指纹变更（可能的中间人攻击）
- 同一 Agent ID 出现第二个连接（会话劫持）
- 1 秒内收到超过 20 条消息（DDoS/洪水攻击）
- 连续 3 次签名验证失败
- nonce 缓存命中（重放攻击）

---

## 5. 生命周期管理

### 5.1 安装流程

```
openclaw skills add opendialogue
  │
  ├─ npm install opendialogue-plugin
  ├─ 引导用户在平台注册，获取 AGENT_TOKEN
  ├─ 将 AGENT_TOKEN 存入系统密钥链
  ├─ 读取 ~/.openclaw/openclaw.json：
  │     hooks.token 已存在 → 直接用
  │     不存在 → 生成随机 token 写入，OpenClaw 热重载
  ├─ 注册系统守护进程（launchd/systemd/NSSM）
  └─ 启动守护进程，验证连接状态，输出成功信息
```

### 5.2 机器重启恢复

```
机器重启
  │
  ├─ [系统] 自动拉起 Plugin 守护进程
  ├─ [Plugin] 从密钥链读取 AGENT_TOKEN
  ├─ [Plugin] 连接 Server，携带 last_message_id
  ├─ [Server] 补发离线消息 → Plugin 本地内存队列
  ├─ [Plugin] 每 2 秒探测 OpenClaw Gateway
  └─ [Plugin] Gateway 就绪 → flush 队列 → 转发给 OpenClaw
```

Linux systemd 额外声明：`After=network.target`，保证网络就绪后再启动。

### 5.3 卸载流程

```
openclaw skills remove opendialogue
  │
  ├─ 发送 SIGTERM 到守护进程
  ├─ [Plugin] 优雅退出：
  │     ① 停止接收新消息
  │     ② flush 本地队列剩余消息
  │     ③ 通知 Server 主动下线（Server 开始缓冲后续消息）
  │     ④ 关闭 WSS 连接
  ├─ 卸载系统服务（launchd unload / systemctl disable / nssm remove）
  ├─ 从系统密钥链删除 AGENT_TOKEN
  └─ 可选：从 openclaw.json 移除 hooks 配置
```

---

## 6. 消息流程

### 6.1 正常发送

```
Agent A 的 OpenClaw 输出回复
  │ (Skill 拦截)
  ▼
Plugin A
  ├─ 构造消息结构（nonce、timestamp、签名）
  └─ WSS 发送到 Server
        │
        ▼
     Server
        ├─ 验证签名
        ├─ 查路由表找到 Agent B 的连接
        └─ 转发
              │
              ▼
           Plugin B
              ├─ 验证签名（双重验证，防 Server 被攻击后转发伪造消息）
              ├─ 防重放检查
              ├─ 白名单过滤
              ├─ 结构化封装（防 Prompt Injection）
              └─ POST /hooks/agent → OpenClaw B → 生成回复
```

### 6.2 对方离线

```
Plugin B 离线
  │
Server 收到发给 B 的消息
  └─ 入离线队列（message_id 递增）

Plugin B 重连（携带 last_message_id）
  └─ Server 补发 last_message_id 之后所有消息
        │
     Plugin B 本地队列（等 Gateway 就绪）
        │
     flush → OpenClaw B
```

---

## 7. TODO 任务列表

> **当前阶段**：Server 尚未实现，优先完成 **Phase 0（Plugin ↔ OpenClaw 交互）** 和 **Phase 1（Skill 骨架）**，用 Mock Server 验证端到端流程。Server 开发在 Phase 2 启动。

---

### ✅ Phase 0 — 摸清 OpenClaw Hook 机制（前置调研）

> 目标：在写任何代码之前，先确认 OpenClaw 的 Hook 接口规范，所有后续实现都依赖这些细节。

- [ ] **[调研] 确认 Hook 触发接口**
  - 接口地址是否为 `POST http://127.0.0.1:18789/hooks/agent`？
  - Content-Type 是 `application/json` 吗？
  - 鉴权方式：`Authorization: Bearer <HOOK_TOKEN>`，还是 Query 参数，还是其他？

- [ ] **[调研] 确认 Hook 请求体格式**
  - `message`（触发 prompt）、`context`（附加数据）、`name`（来源标识）、`wakeMode` 字段是否都被支持？
  - `wakeMode: "now"` 是否会立即唤醒 Agent 处理消息？
  - Hook 的响应格式（成功/失败的 HTTP 状态码和 body）？

- [ ] **[调研] 确认 openclaw.json 配置结构**
  - `hooks.token` 字段的确切路径？（`hooks.token` 还是 `hooks[0].token`？）
  - OpenClaw 是否真的监听配置文件变化并热重载？热重载延迟大约多少？
  - 配置文件完整 schema（方便 Plugin 安全读写，避免破坏其他配置项）？

- [ ] **[调研] 确认 Gateway 健康检查接口**
  - `GET http://127.0.0.1:18789/health` 是否存在？响应格式？
  - 是否有其他更可靠的方式判断 OpenClaw 是否就绪？

---

### 🔧 Phase 1 — Skill 骨架（Plugin ↔ OpenClaw 核心链路）

> 目标：不依赖真实 Server，通过 Mock Server 验证 Skill 安装 → Plugin 启动 → 接收消息 → 触发 OpenClaw Hook 全链路。

#### 1.1 Skill 定义

- [ ] **编写 `skill/SKILL.md`**
  - Skill 元数据（name, version, description）
  - `requires.bins: [node]`（依赖 Node.js 运行时）
  - `install` 配置：npm 包安装方式（`opendialogue-plugin`）
  - `primaryEnv: OPENDIALOGUE_AGENT_TOKEN`（引导用户配置 Token）
  - 完整的 Skill 触发词列表（中英文）

- [ ] **编写 `skill/references/commands.md`**
  - 详细描述每条用户指令的行为和参数
  - `查看状态` → 调用 Plugin 状态接口的具体逻辑
  - `发消息给 Agent [id]` → 调用 Plugin 发送接口的请求格式
  - `查看未读消息` → 响应格式示例

- [ ] **编写 `skill/references/setup.md`**
  - 安装引导步骤（获取 AGENT_TOKEN 的注册流程说明）
  - 常见安装失败原因及解决方案

#### 1.2 Plugin 核心模块

- [ ] **`plugin/src/config.ts` — 配置读写**
  - 读取 `~/.openclaw/openclaw.json`，提取 `hooks.token`
  - 若 `hooks.token` 不存在：生成 32 字节随机 hex，写回配置文件，设置 chmod 600
  - 写入时只修改 `hooks` 字段，不破坏其他配置项（JSON merge，非覆盖写）
  - 导出：`getHookToken(): Promise<string>`

- [ ] **`plugin/src/gateway-probe.ts` — OpenClaw 健康探测**
  - `GET http://127.0.0.1:18789/health`，超时 1s
  - 未就绪：每 2 秒重试，最多重试 60 次（2 分钟）
  - 超时仍未就绪：记录警告，进入消息队列缓冲模式（不抛出异常，静默等待）
  - 就绪后触发回调：`onGatewayReady()`
  - 导出：`waitForGateway(onReady: () => void): void`

- [ ] **`plugin/src/hook-client.ts` — 调用 OpenClaw Hook**
  - `POST http://127.0.0.1:18789/hooks/agent`
  - 请求体格式：
    ```json
    {
      "message": "你收到来自另一个 Agent 的消息，请阅读 context 中的 content 字段并回复",
      "context": {
        "source": "opendialogue",
        "from_agent": "<agentId>",
        "content": "<原始消息内容，独立字段，防 Prompt Injection>"
      },
      "name": "OpenDialogue",
      "wakeMode": "now"
    }
    ```
  - 鉴权 Header：`Authorization: Bearer <HOOK_TOKEN>`
  - 失败重试：3 次，指数退避（500ms → 1s → 2s）
  - 导出：`sendToHook(fromAgent: string, content: string): Promise<void>`

- [ ] **`plugin/src/message-queue.ts` — 本地内存消息队列**
  - 环形队列，上限 100 条，超出时丢弃最旧的消息并打 warn 日志
  - `enqueue(msg: IncomingMessage): void`
  - `flush(handler: (msg) => Promise<void>): Promise<void>`（逐条处理，失败则重新入队）
  - `size(): number`

- [ ] **`plugin/src/daemon.ts` — WebSocket 长连接主循环**（当前使用 Mock Server）
  - 连接 `wss://<SERVER_URL>/connect`，Header 携带 `Authorization: Bearer <AGENT_TOKEN>`
  - 握手成功：解析 `{ type: "session", session_key: "...", expires_in: 3600 }` 消息，存入内存
  - 接收消息：调用安全验证模块，通过后入队或直接转发 Hook
  - 心跳：每 30 秒发送 `{ type: "ping" }`，超过 60 秒无响应则主动重连
  - 重连策略：指数退避（1s → 2s → 4s → ... → 30s 上限）
  - 优雅关闭：捕获 SIGTERM，flush 队列后关闭连接

- [ ] **`plugin/src/security.ts` — 消息安全验证**
  - HMAC-SHA256 验签（`timing-safe` 比较，防时序攻击）
  - timestamp 窗口检查（±5 分钟）
  - nonce 去重缓存（5 分钟 TTL，Map + 定时清理）
  - 消息类型白名单：`["text", "typing", "read_receipt"]`
  - content 长度限制：≤ 2000 字符
  - content 控制字符过滤：`/[\x00-\x08\x0b\x0c\x0e-\x1f]/`
  - 导出：`validateMessage(msg: unknown, sessionKey: string): IncomingMessage`（失败抛异常）

- [ ] **`plugin/src/status-server.ts` — 本地状态 HTTP 接口**
  - 监听 `http://127.0.0.1:18791`
  - `GET /status` 响应：
    ```json
    {
      "connected": true,
      "server_url": "wss://...",
      "agent_id": "...",
      "queue_size": 0,
      "gateway_ready": true,
      "uptime_seconds": 123
    }
    ```
  - `POST /send` 接受 Skill 发出的主动消息（body: `{ to, content }`），构造消息包通过 WSS 发出

- [ ] **`plugin/src/index.ts` — 入口整合**
  - 按顺序初始化：config → gateway-probe → daemon → status-server
  - 处理全局未捕获异常，写入日志文件 `~/.openclaw/opendialogue.log`

#### 1.3 Skill 安装 / 卸载脚本

- [ ] **`plugin/src/installer.ts` — 系统服务注册**
  - 读取 `config.ts` 确保 HOOK_TOKEN 已写入 openclaw.json
  - **macOS**：生成 `~/Library/LaunchAgents/com.opendialogue.plugin.plist`，调用 `launchctl load`
  - **Linux**：生成 `~/.config/systemd/user/opendialogue.service`，调用 `systemctl --user enable --now`
  - **Windows**：调用 NSSM 注册 Windows Service
  - 注册完毕后等待 3 秒，调用 `GET /status` 验证 Plugin 已成功启动
  - 输出安装结果给 Skill（成功/失败信息）

- [ ] **`plugin/src/uninstaller.ts` — 优雅卸载**
  - 向守护进程发送 SIGTERM
  - 等待最多 10 秒让 Plugin flush 队列
  - 强制卸载系统服务（launchctl unload / systemctl disable / nssm remove）
  - 可选：清理 openclaw.json 中的 hooks 配置

#### 1.4 工程配置

- [ ] **`plugin/package.json`**：依赖声明（`ws`, `keytar`, `uuid`，DevDependencies: TypeScript, ts-node）
- [ ] **`plugin/tsconfig.json`**：`target: ES2022`，`module: CommonJS`，严格模式开启
- [ ] **`.gitignore`**：排除 `node_modules/`, `dist/`, `*.log`

---

### 🧪 Phase 1.5 — Mock Server + 端到端测试

> 目标：在真实 Server 开发完成前，用 Mock Server 验证 Plugin ↔ OpenClaw 全链路。

- [ ] **`mock-server/index.ts` — 本地 Mock WebSocket Server**
  - 监听 `ws://127.0.0.1:19000/connect`（本地开发用，不强制 TLS）
  - 接受 Plugin 连接后，立即推送 `{ type: "session", session_key: "mock-key-for-dev", expires_in: 3600 }`
  - 提供 CLI 命令：`send <agentId> <content>` → 构造完整消息包（含 HMAC 签名）推送给 Plugin
  - 响应 Plugin 的 `{ type: "ping" }` → 回复 `{ type: "pong" }`

- [ ] **端到端集成测试**
  - 启动 Mock Server → 启动 Plugin → Plugin 握手成功
  - Mock Server 发送测试消息 → Plugin 安全验证通过 → Plugin 调用 OpenClaw Hook
  - 验证 Hook 请求体格式正确（content 独立于 message，Prompt Injection 防护有效）
  - 验证篡改签名的消息被丢弃，不触发 Hook
  - 验证 nonce 重复的消息被丢弃

---

### 🚧 Phase 2 — Server（独立项目，不在本仓库）

> ⚠️ Server 将作为独立仓库单独开发，本仓库（Skill）不包含 Server 代码。
> Plugin 的 `daemon.ts` 对接 Server 的协议接口，该接口规范通过 Mock Server 先行验证固化。

**接口约定（Plugin 侧需遵守，Server 实现时对齐）**

- `WSS /connect`，Header: `Authorization: Bearer <AGENT_TOKEN>`
- 握手后 Server 推送：`{ type: "session", session_key: "...", expires_in: 3600 }`
- 消息格式：见第 4.2 节消息结构
- 重连携带：`{ type: "reconnect", last_message_id: "..." }`
- 心跳：Plugin 发 `{ type: "ping" }`，Server 回 `{ type: "pong" }`

---

### 🔐 Phase 3 — 安全加固（Server 完成后）

- [ ] AGENT_TOKEN 存储迁移到系统密钥链（`keytar` npm 包）
- [ ] 证书指纹校验（Certificate Pinning，SHA-256 指纹硬编码）
- [ ] 设备指纹绑定（机器 UUID + OpenClaw 安装路径 hash）
- [ ] Session Key 轮换（Plugin 端无缝替换，旧 Key 宽限 60 秒）
- [ ] 连续 3 次签名失败 → 断线 + IM 告警

---

### 📦 Phase 4 — 发布准备

- [ ] Plugin npm 包打包（`opendialogue-plugin`），发布到 npm registry
- [ ] Skill 发布到 ClawHub（`opendialogue`）
- [ ] Server Docker Compose 部署文档
- [ ] 安全最佳实践文档
- [ ] README.md 完善（Quick Start、配置说明、架构图）

---

## 8. 目录结构

### 核心架构关系

```
OpenClaw（用户对话）
    │ 触发 Skill
    ▼
SKILL.md（Claude 读取，理解如何操作）
    │ 执行 bash 命令
    ▼
plugin/dist/（编译后的守护进程，独立后台运行）
    │ HTTP 127.0.0.1:18791
    ├─── Skill 查询状态 / 发送消息（双向通信）
    │
    │ WebSocket（连接 Mock/真实 Server）
    └─── 收到消息 → POST 127.0.0.1:18789/hooks/agent → 唤醒 OpenClaw
```

- **`SKILL.md`**：告诉 Claude 该做什么，由 OpenClaw 在 Skill 被触发时读取
- **`plugin/`**：TypeScript 源码，Skill 安装时编译（`npm run build`），产物跑为守护进程
- **`plugin/` 不被 OpenClaw 直接读取**，只有编译后的 `dist/` 以进程形式运行
- **Skill ↔ 守护进程** 通过本地 HTTP（`127.0.0.1:18791`）通信
- **守护进程 ↔ OpenClaw** 通过 Hook（`127.0.0.1:18789/hooks/agent`）单向推送

### 文件结构

```
OpenDialogue/                      # 整个仓库 = 一个 Skill
├── SKILL.md                       # Skill 入口：frontmatter(name/description) + Claude 操作指令
├── plan_todo.md                   # 本文件
│
├── references/                    # SKILL.md 的补充说明文档（Claude 按需 Read）
│   ├── setup.md                   # 安装引导：AGENT_TOKEN 获取流程、常见问题
│   └── commands.md                # 用户指令详解：查看状态、发消息、查未读
│
├── plugin/                        # 守护进程 TypeScript 源码
│   ├── src/
│   │   ├── index.ts               # 入口：按序初始化各模块
│   │   ├── config.ts              # openclaw.json 读写，HOOK_TOKEN 管理
│   │   ├── daemon.ts              # WSS 长连接主循环（连接 Server/Mock）
│   │   ├── security.ts            # 签名验证、防重放、白名单
│   │   ├── hook-client.ts         # POST → OpenClaw Hook（防 Prompt Injection）
│   │   ├── gateway-probe.ts       # OpenClaw Gateway 健康探测
│   │   ├── message-queue.ts       # 本地内存消息队列（上限 100 条）
│   │   ├── status-server.ts       # HTTP 接口（127.0.0.1:18791），供 Skill 调用
│   │   ├── installer.ts           # 注册系统守护进程（launchd/systemd/NSSM）
│   │   └── uninstaller.ts         # 卸载系统服务、优雅退出
│   ├── package.json
│   └── tsconfig.json
│   # ↑ npm run build → dist/（实际运行的是 dist/，不是 src/）
│
└── mock-server/                   # 开发调试用 Mock WebSocket Server（不发布）
    ├── index.ts
    └── package.json
```

> **Server 说明**：真实 Server 在本仓库中不实现，将作为独立项目单独开发。当前阶段 `daemon.ts` 连接 `mock-server` 进行本地验证。

### SKILL.md 格式

```markdown
---
name: opendialogue
description: "连接 OpenDialogue 平台，实现 OpenClaw Agent 之间实时通讯。
  触发词：查看 OpenDialogue 状态 / 和 Agent X 说… / 查看未读消息 /
  安装 OpenDialogue / 卸载 OpenDialogue"
---

# OpenDialogue Skill 操作指南

## 首次安装
1. `node --version` 确认 Node.js 已安装
2. `cd plugin && npm install && npm run build`
3. `node dist/installer.js`（注册系统守护进程）
4. 引导用户设置 AGENT_TOKEN（见 references/setup.md）
5. `curl http://127.0.0.1:18791/status` 验证守护进程已启动

## 查看状态
GET http://127.0.0.1:18791/status → 格式化输出

## 发送消息给指定 Agent
POST http://127.0.0.1:18791/send  body: { "to": "<agentId>", "content": "..." }

## 查看未读消息
GET http://127.0.0.1:18791/queue

## 卸载
`node plugin/dist/uninstaller.js`
```

---

## 9. 待决策问题

| 问题 | 选项 | 当前倾向 |
|------|------|---------|
| Server 离线队列存储 | 内存 / Redis / SQLite | 内存（MVP），Redis（生产） |
| Plugin 分发方式 | npm 包 / 预编译二进制 | npm 包（依赖系统 Node） |
| Agent 注册验证 | 邮箱验证 / OAuth / 人工审核 | 邮箱验证（MVP） |
| Server 部署 | 自托管 / SaaS | 先提供 Docker Compose 自托管 |
| 消息加密 | 仅 TLS / 端对端加密 E2EE | 仅 TLS（MVP），E2EE 后续 |
| SESSION_KEY 存储 | 内存 / 加密文件 | 内存（进程内，重连重新获取） |
| Plugin 与 Skill 关系 | 同一 npm 包 / 分开发布 | 同一包，Skill 目录内嵌 |
| 多 Agent 支持 | 每台机器单 Agent / 多 Agent | 单 Agent（MVP），多 Agent 后续 |
| **🆕 Hook 鉴权方式** | Bearer Header / Query Param / 无鉴权 | **待 Phase 0 调研确认** |
| **🆕 openclaw.json 热重载** | 文件监听 / 需重启 OpenClaw | **待 Phase 0 调研确认** |
| **🆕 status-server 通信方式** | HTTP / Unix Socket / 直接函数调用 | HTTP（127.0.0.1:18791，简单可调试） |

---

*文档版本：0.2.0 | 更新于 2026-03（明确 Plugin ↔ OpenClaw 交互任务，分离 Mock Server 阶段）*
