---
description: "Runtime guard rails for dsh sessions: loop detection, nesting depth limits, and token budget enforcement with Kestra observability events."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-runtime-guard

English | [中文](README.zh.md)

dsh 运行时防护插件（dsh.docx 第十二章 稳定性兜底）：为会话提供防死锁、深度限制与 token 预算熔断，防护事件上报 Kestra 观察中心。

## Summary

Runtime guard rails for dsh sessions: a consecutive-hit loop detector, a subagent nesting depth limit, and a per-session token budget, with every guard event emitted through `onEvent` for the Kestra sync plugin. All knobs are delivered through the Nacos `dsh-runtime-guard.yaml` overlay.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Usage](#usage)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The plugin mounts automatically with the profile it ships in and guards every tool loop, subagent spawn, and token-accounting boundary; no per-call wiring is required.

### When to choose it

Use it in any profile that must not hang on a repeated tool fingerprint, must bound subagent nesting, or must keep a session within its token budget.

### Minimal configuration

All knobs come from the Nacos-delivered `dsh-runtime-guard.yaml` overlay: `loopRepeatThreshold`, `maxDepth`, and `tokenBudget`. The plugin is enabled by default in the `dsh` base bundle.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `loopRepeatThreshold` | `3` | Consecutive identical tool+args fingerprints that declare a deadlock loop. |
| `maxDepth` | `8` | Maximum subagent nesting depth before a child spawn is interrupted. |
| `tokenBudget` | `500000` | Per-session token budget; exceeding it emits a budget-exceeded guard event. |

<a id="usage"></a>
## Usage

The guard is transparent while a session behaves; it interrupts only loops, over-deep nesting, and budget overruns:

```ts
import { RuntimeGuard, type GuardEvent } from '@deepseek-ai/dsh-plugin-runtime-guard'

const guard = new RuntimeGuard('session-1', { loopRepeatThreshold: 3, maxDepth: 8, tokenBudget: 500000 })
guard.onEvent((event: GuardEvent) => console.log(event.type, event.detail))
const blocked = guard.checkToolCall('web_search', '{"q":"same query"}')
// null → allowed; GuardEvent → the call was interrupted
```

<a id="dev-note"></a>
## Dev Note

- Tests live in `tests/` and cover loop detection, depth limits, and budget transitions.
- Keep the plugin dependency-free at runtime: it must not import host-only services.

<a id="model-experience"></a>
## Model Experience

### Guard enforcement

#### What the model sees

Nothing directly. Guard verdicts are enforced before a tool call is admitted or a step advances; the model observes the outcome through the normal `tool/result` or turn path, never through guard internals such as `checkToolCall()`.

#### Token effect

None for the model context. Guard events are observational records and add no prompt, tool, or message content.

#### KV Cache effect

None. No request prefix or schema change is introduced.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Loop detection is heuristic: it covers consecutive identical fingerprints and short alternating cycles within a 24-entry window; longer or interleaved cycles can evade it.
- Token accounting is per-session and relies on callers reporting amounts; a caller that never reports usage is invisible to the budget.
- Guard state is in-process memory; a restart clears sequence and budget state for the session.
