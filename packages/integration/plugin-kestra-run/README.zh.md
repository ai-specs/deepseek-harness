---
description: "dsh(PC) remote-input 派生会话的无头单次观察器：环境变量驱动的模型/工具选择、白名单防护，以及供 kestra-sync 上报的结构化结果契约。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-kestra-run

[English](README.md) | 中文

dsh headless one-shot observer（PC 端 remote-input 派生会话）：以环境变量驱动的模型/工具选择、工具白名单防护，以及供 kestra-sync 上报的结构化结果契约。

## 概述

为手机侧输入派生的 dsh(PC) 运行提供的无头单次观察器：它从环境变量驱动一个 agent 进程，执行默认拒绝的工具白名单与 ReAct 轮次预算，并写出结构化的 `RunResultPayload` JSON 供 kestra-sync 转发。墙钟超时时写出部分结果并以 124 退出。

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

插件以 `dsh-run.mjs` 二进制形式随包发布，由 Kestra 工作流用来在 PC 上启动无头 remote-input 运行；它是事件驱动、进程级的，无注入服务。

### 何时选用

当手机侧远程输入需要在 PC 上派生一次性、有界的 agent 运行，并通过 kestra-sync 回传结构化结果——且不依赖监听守护进程时使用。

### 最小配置

配置 `resultFile`（结构化结果 JSON 的写入位置）、可选的 `allowTools` 白名单、`timeoutSeconds` 与 `maxIterations`。模型与工具选择来自工作流设置的 `DSH_TOOLS` / `DSH_TIMEOUT` 环境变量。

<a id="configuration"></a>
## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `resultFile` | 必填 | 结构化结果 JSON 写入位置（kestra-sync 转发上报目标）。 |
| `allowTools` | 部署默认集 | 默认拒绝的工具白名单；未定义或为空使用部署默认集。 |
| `timeoutSeconds` | `0`（无界） | 墙钟上限；到期写出部分结果并以 124 退出。 |
| `maxIterations` | `0`（无界） | ReAct 轮次预算；超出预算后新轮次被拒绝工具调用并收到收尾指令，模型仍以最佳最终答复收尾而非被杀。 |

<a id="usage"></a>
## 用法

运行由 Kestra 工作流派生；进程内插件观察会话事件并投影最终契约：

```ts
import { createTallies, observeEvent, projectResult } from '@deepseek-ai/dsh-plugin-kestra-run'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

const tallies = createTallies()
observeEvent(tallies, {
  type: 'tool/call',
  seq: SessionSeq(1),
  time: Date.now(),
  data: { turn: 1, step: 3, callId: brandString<ToolCallId>('call-1'), name: 'web_search', arguments: '{}' },
})
const result = projectResult(tallies, false)
// { result, success, iterations, toolCalls, toolErrors, tokenUsage, durationMs, error }
```

<a id="dev-note"></a>
## 开发备注

- 测试位于 `tests/`，覆盖统计折叠、轮次预算拒绝与结果投影。
- 保持插件运行时零依赖：不得导入仅宿主可用的服务。
- `dsh-run.mjs`、`dsh.patch.yml` 与类型契约由 `Dockerfile.base` / `Dockerfile.pr` 的容器契约门验证。

<a id="model-experience"></a>
## 模型体验

### 运行观测

#### 模型看到什么

不直接看到任何内容。观察者读取 `tool/call` 等会话事件并为 Kestra 运行报告做统计；它不注册任何自身的提示词、工具或会话内容。

#### Token 影响

无。观测消耗既有事件，不添加任何模型可见 token。

#### KV Cache 影响

无。不会引入任何提示词或 schema 变更。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 按设计单次：每个进程只观察一个 agent 运行；没有守护模式或长生命周期会话。
- 白名单按工具*名称*默认拒绝；载荷级策略不在此范围，属于权限覆盖层。
- 若观测目标从不发出事件（例如模型客户端挂起），墙钟 `timeoutSeconds` 上限是唯一兜底。
