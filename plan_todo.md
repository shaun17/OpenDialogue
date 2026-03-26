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

### Phase 1 — 核心骨架

- [ ] **Server**：WebSocket 连接管理（注册、路由、断线清理）
- [ ] **Server**：Agent 注册 API（生成 AGENT_TOKEN、claim URL、人工验证）
- [ ] **Server**：Session Key 生成与下发
- [ ] **Server**：消息转发与签名验证
- [ ] **Plugin**：WSS 建立连接、握手、获取 SESSION_KEY
- [ ] **Plugin**：心跳保活（30s ping）
- [ ] **Plugin**：指数退避重连（1s → 2s → 4s，上限 30s）
- [ ] **Plugin**：HOOK_TOKEN 自动读取 / 生成写入 openclaw.json
- [ ] **Plugin**：Gateway 健康探测（每 2s，最多 2min）
- [ ] **Plugin**：本地内存消息队列（上限 100 条）
- [ ] **Plugin**：结构化转发到 OpenClaw Hook（防 Prompt Injection）
- [ ] **Skill**：SKILL.md 编写（触发词、行为描述）
- [ ] **Skill**：installer.ts（系统服务注册，三平台）
- [ ] **Skill**：uninstaller.ts（优雅退出 + 服务卸载）

### Phase 2 — 安全加固

- [ ] HMAC-SHA256 消息签名与验证
- [ ] nonce + timestamp 防重放（5 分钟窗口缓存）
- [ ] 消息内容白名单过滤（类型、长度、控制字符）
- [ ] 证书指纹校验（Certificate Pinning）
- [ ] 设备指纹绑定（机器 UUID + 安装路径 hash）
- [ ] Token 存储迁移到系统密钥链（keytar npm 包）
- [ ] Session Key 轮换（Plugin 端接收新 Key 替换）
- [ ] 异常检测：频率限制（20条/s）、多点登录告警、连续签名失败

### Phase 3 — 离线消息

- [ ] Server 端离线队列（内存 MVP，Redis 生产）
- [ ] Plugin 重连携带 `last_message_id`
- [ ] Server 补发逻辑
- [ ] 队列 24 小时超时清理

### Phase 4 — 可观测性

- [ ] Plugin 本地状态接口（127.0.0.1:18791/status）
- [ ] Skill 响应用户状态查询
- [ ] 告警通知（通过 OpenClaw 已配置的 IM 渠道推送）
- [ ] Server 端基础监控（连接数、消息吞吐量）

### Phase 5 — 发布

- [ ] Plugin npm 包打包发布（`opendialogue-plugin`）
- [ ] Skill 发布到 ClawHub（`opendialogue`）
- [ ] README 文档
- [ ] Server 部署文档（Docker Compose）
- [ ] 安全最佳实践文档

---

## 8. 目录结构

```
OpenDialogue/
├── plan_todo.md                   # 本文件
│
├── server/                        # 云端中继服务（Node.js + TypeScript）
│   ├── src/
│   │   ├── index.ts               # 入口，启动 HTTP + WSS 服务
│   │   ├── ws-manager.ts          # WebSocket 连接管理与路由表
│   │   ├── router.ts              # 消息路由与转发
│   │   ├── session-key.ts         # Session Key 生成、下发、轮换
│   │   ├── offline-queue.ts       # 离线消息队列
│   │   └── auth.ts                # AGENT_TOKEN 验证
│   ├── package.json
│   ├── tsconfig.json
│   └── docker-compose.yml
│
├── plugin/                        # 本地守护进程（Node.js + TypeScript）
│   ├── src/
│   │   ├── index.ts               # 入口
│   │   ├── daemon.ts              # WSS 长连接主循环
│   │   ├── security.ts            # 签名验证、防重放、白名单
│   │   ├── hook-client.ts         # 调用 OpenClaw Hook
│   │   ├── token-store.ts         # 系统密钥链读写（keytar）
│   │   ├── gateway-probe.ts       # OpenClaw Gateway 健康探测
│   │   ├── message-queue.ts       # 本地内存消息队列
│   │   ├── status-server.ts       # 本地状态 HTTP 接口（18791）
│   │   ├── installer.ts           # 系统服务注册（三平台）
│   │   └── uninstaller.ts         # 系统服务卸载与优雅退出
│   ├── package.json
│   └── tsconfig.json
│
└── skill/                         # OpenClaw Skill
    ├── SKILL.md                   # Skill 主文件（注册入口）
    └── references/
        ├── setup.md               # 安装引导说明
        └── commands.md            # 可用指令说明
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

---

*文档版本：0.1.0 | 创建于 2026-03*
