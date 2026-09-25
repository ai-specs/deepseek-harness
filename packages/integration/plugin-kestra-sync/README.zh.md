---
description: "将 dsh(PC) 会话快照推送到 Kestra 的会话同步客户端：仅出站、事件触发、支持实时/批量模式。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-kestra-sync

[English](README.md) | 中文

dsh-kestra-sync：会话同步客户端（dsh.docx 拓扑中的 `dsh(PC) ←会话同步→ Kestra`）。

## 概述

仅出站的会话同步客户端，把 dsh(PC) 会话快照推送到 Kestra：会话开始、子任务完成、高风险决策点（pending approval）与会话结束。支持实时与批量推送模式，以及基于 web-identity 认证的手机输入联动集成。插件不监听任何端口。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [用法](#usage)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

插件随其所属 profile 挂载，并在生命周期触发点开始推送会话快照；无需任何逐调用接线。由于 dsh(PC) 没有公网 IP，插件只主动外连 Kestra API。

### 何时选用

任何以 Kestra 为观察中心、且 dsh(PC) 需要上报会话生命周期、token 消耗与 pending-approval 决策点、同时不暴露监听端口的部署都适用。

### 最小配置

用 `baseUrl` 与 bearer `token` 指向 Kestra API；默认实时模式。启用手机输入联动时设置 `auth: 'web-identity'`，客户端使用留存浏览器 OIDC 身份认证，而不是另一次守护进程侧登录。

<a id="configuration"></a>
## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `baseUrl` | 必填 | Kestra API 地址，如 `http://kestra.internal:8080`。 |
| `token` | 必填 | API 网关 Bearer token（`auth: 'web-identity'` 时不用）。 |
| `auth` | `token` | `token`（网关 bearer）或 `web-identity`（留存浏览器 OIDC 身份）。 |
| `tenant` | `main` | Kestra 2.x 租户。 |
| `mode` | `realtime` | `realtime` 即时推送；`batch` 在 `batchIntervalMs` 内合并。 |
| `batchIntervalMs` | `2000` | 批量刷新间隔毫秒数。 |
| `timeoutMs` | `5000` | 单次推送超时毫秒数。 |

<a id="usage"></a>
## 用法

客户端构造一次，从生命周期触发点推送会话快照：

```ts
import { KestraSessionSyncClient } from '@deepseek-ai/dsh-plugin-kestra-sync'

const client = new KestraSessionSyncClient({ baseUrl: 'http://kestra:8080', token: 'gateway-token' })
await client.push({ sessionId: 's-1', phase: 'pending_approval', approval: { approvalType: 'refund' } })
```

<a id="dev-note"></a>
## 开发备注

- 测试位于 `tests/`；保持插件仅出站且运行时零依赖。
- PKCE/web-identity 机制位于本包；留存身份记录本身由 `client-connection` 拥有。

<a id="model-experience"></a>
## 模型体验

### 会话快照同步

#### 模型看到什么

不直接看到任何内容。快照从会话日志生成并交给 Kestra API，绝不进入模型上下文；留存身份记录由 `client-connection` 拥有。

#### Token 影响

无。快照构造读取持久化状态，不添加任何模型可见 token。

#### KV Cache 影响

无。不会引入任何请求前缀或 schema 变更。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 按设计仅出站：Kestra API 不可达时快照静默丢弃，而非无限重试（失败的推送从不阻塞会话）。
- PKCE 登录状态是进程内内存：`dsh web` 重启会令进行中的浏览器登录失效，用户需重试。
- 批量模式按墙钟间隔合并，而非按事件数或体积；极高事件率可能增大批量缓冲。
