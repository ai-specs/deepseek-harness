---
description: "dsh 会话的运行时防护：循环检测、嵌套深度限制与带 Kestra 可观测事件的 token 预算执行。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-runtime-guard

[English](README.md) | 中文

dsh 运行时防护插件（dsh.docx 第十二章 稳定性兜底）：为会话提供防死锁、深度限制与 token 预算熔断，防护事件上报 Kestra 观察中心。

## 概述

dsh 会话的运行时防护：连续命中计数器检测循环、子任务嵌套深度上限、单会话 token 预算，每个防护事件都经 `onEvent` 交给 Kestra 同步插件。全部旋钮由 Nacos `dsh-runtime-guard.yaml` 覆盖层下发。

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

插件随其所属 profile 自动挂载，守护每个工具循环、子任务派生与 token 记账边界；无需任何逐调用接线。

### 何时选用

任何不能容忍重复工具指纹导致卡死、必须限制子任务嵌套深度、或必须把会话控制在 token 预算内的 profile 都适用。

### 最小配置

全部旋钮来自 Nacos 下发的 `dsh-runtime-guard.yaml` 覆盖层：`loopRepeatThreshold`、`maxDepth` 与 `tokenBudget`。插件在 `dsh` 基础组合包中默认启用。

<a id="configuration"></a>
## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `loopRepeatThreshold` | `3` | 相同工具+参数指纹连续出现次数，达到即判死锁循环。 |
| `maxDepth` | `8` | 子任务嵌套深度上限，超过则中断派生。 |
| `tokenBudget` | `500000` | 单会话 token 预算；超过则发出预算超限防护事件。 |

<a id="usage"></a>
## 用法

会话行为正常时防护透明；它只打断循环、过深嵌套与预算超限：

```ts
import { RuntimeGuard, type GuardEvent } from '@deepseek-ai/dsh-plugin-runtime-guard'

const guard = new RuntimeGuard('session-1', { loopRepeatThreshold: 3, maxDepth: 8, tokenBudget: 500000 })
guard.onEvent((event: GuardEvent) => console.log(event.type, event.detail))
const blocked = guard.checkToolCall('web_search', '{"q":"same query"}')
// null → allowed; GuardEvent → the call was interrupted
```

<a id="dev-note"></a>
## 开发备注

- 测试位于 `tests/`，覆盖循环检测、深度限制与预算转换。
- 保持插件运行时零依赖：不得导入仅宿主可用的服务。

<a id="model-experience"></a>
## 模型体验

### 防护执行

#### 模型看到什么

不直接看到任何内容。防护裁决在工具调用被准入或步骤推进之前执行；模型通过常规 `tool/result` 或回合路径观察结果，绝不会看到 `checkToolCall()` 等防护内部机制。

#### Token 影响

对模型上下文无影响。防护事件是观测性记录，不添加任何提示词、工具或消息内容。

#### KV Cache 影响

无。不会引入任何请求前缀或 schema 变更。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 循环检测是启发式的：覆盖连续相同指纹与 24 条窗口内的短交替循环；更长或交错的循环可能绕过。
- token 记账是单会话的，依赖调用方上报数额；从不上报的调用方对预算不可见。
- 防护状态是进程内内存；重启会清空会话的序列与预算状态。
