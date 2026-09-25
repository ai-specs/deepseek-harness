---
description: "dsh 工具调用的本地容错：有界指数退避重试、优雅降级兜底与熔断。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-fault-tolerance

[English](README.md) | 中文

dsh 本地容错插件（dsh.docx 第九章）：工具调用失败被本层拦截，**底层错误不透传给用户**。

## 概述

为 dsh 工具调用提供有界重试、规则兜底与熔断。工具失败在此处被捕获，绝不以原始形式暴露给用户：指数退避重试 → 兜底规则库 → 熔断器。全部旋钮由 Nacos `dsh-fault-tolerance.yaml` 覆盖层下发。

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

插件随其所属 profile 自动挂载；它在工具层拦截工具调用失败，无需任何逐调用接线。

### 何时选用

任何通过不可靠网络调用外部工具、且希望在重试耗尽后得到有界重试与安全默认答复的 profile 都适用。

### 最小配置

全部旋钮从 Nacos 下发的 `dsh-fault-tolerance.yaml` 覆盖层读取：`maxRetries`、`baseDelayMs`、`multiplier`、`fallbackRules` 与熔断阈值。插件在 `dsh` 基础组合包中默认启用。

<a id="configuration"></a>
## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxRetries` | `4` | 判定失败前的最大尝试次数。 |
| `baseDelayMs` | `1000` | 基础退避延迟毫秒数（1s → 2s → 4s → 8s）。 |
| `multiplier` | `2` | 各次尝试间的退避倍增系数。 |
| `fallbackRules` | `[]` | 按失败工具名匹配的正则到安全答复规则。 |
| `failureThreshold` | `5` | 触发熔断开启的连续失败次数。 |
| `openSeconds` | `30` | 熔断开启时长，之后放行一次半开探测。 |

<a id="usage"></a>
## 用法

插件透明运行；失败调用通过重试、兜底或结构化失败得到结果，而不是抛出原始错误：

```ts
import { FaultTolerance } from '@deepseek-ai/dsh-plugin-fault-tolerance'

const ft = new FaultTolerance({ maxAttempts: 4, baseDelayMs: 1000, multiplier: 2, jitter: false }, [
  { matchTool: '^mcp_weather', response: 'weather service unavailable, please retry later' },
])
const fetchWeather = async (): Promise<string> => 'sunny'
const result = await ft.execute('mcp_weather', fetchWeather)
// result.ok === true → { value }; otherwise { ok: false, fallback? }
```

<a id="dev-note"></a>
## 开发备注

- 测试位于 `tests/`，覆盖重试预算、兜底匹配与熔断状态转换。
- 保持插件运行时零依赖：不得导入仅宿主可用的服务。

<a id="model-experience"></a>
## 模型体验

### 工具失败处理

#### 模型看到什么

不直接看到任何内容。失败的外部调用在到达模型之前已在此处解析为安全兜底答复或结构化失败，因此底层工具的原始传输错误永远不会进入模型上下文；模型只会看到常规的 `tool/result` 结果。

#### Token 影响

无。插件既不构造也不消耗模型 token；它只短路失败的调用。

#### KV Cache 影响

无。不会向任何会话添加提示词、schema 或消息。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 熔断状态是进程内内存：多实例部署不共享 open/half_open 状态，失败后端的流量仍可能从另一实例命中。
- 兜底规则只按正则匹配工具名；暂不支持按载荷感知的兜底决策。
- 不导出持久化指标；Kestra 观察中心只从 runtime-guard 插件接收防护事件。
