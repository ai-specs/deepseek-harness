---
description: "Headless one-shot observer for dsh(PC) remote-input runs: env-driven model/tool selection, allowlist guard, and the structured result contract for kestra-sync."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-kestra-run

English | [中文](README.zh.md)

dsh headless one-shot observer（PC 端 remote-input 派生会话）：以环境变量驱动的模型/工具选择、工具白名单防护，以及供 kestra-sync 上报的结构化结果契约。

## Summary

Headless one-shot observer for a dsh(PC) run derived from a phone-side input: it drives one agent process from environment variables, enforces a deny-by-default tool allowlist and a ReAct turn budget, and writes a structured `RunResultPayload` JSON for kestra-sync to relay. On wall-clock expiry the partial result is written and the process exits 124.

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

The plugin ships as the `dsh-run.mjs` binary used by the Kestra workflow to launch a headless remote-input run on the PC; it is event-driven and process-level, with no injected services.

### When to choose it

Use it when a phone-side remote input must spawn a disposable, bounded agent run on the PC and report the structured outcome back through kestra-sync — without a listening daemon.

### Minimal configuration

Configure `resultFile` (where the structured result JSON is written), an optional `allowTools` allowlist, `timeoutSeconds`, and `maxIterations`. Model and tool selection come from the `DSH_TOOLS` / `DSH_TIMEOUT` environment the workflow sets.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `resultFile` | required | Where the structured result JSON is written (kestra-sync relay report target). |
| `allowTools` | deployment default set | Deny-by-default tool allowlist; undefined or empty uses the deployment default. |
| `timeoutSeconds` | `0` (unbounded) | Wall-clock bound; on expiry the partial result is written and the process exits 124. |
| `maxIterations` | `0` (unbounded) | ReAct turn budget; a new turn beyond the budget denies tool calls with a wrap-up instruction so the model still closes with its best final answer. |

<a id="usage"></a>
## Usage

The run is spawned by the Kestra workflow; inside the process the plugin observes session events and projects the final contract:

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
## Dev Note

- Tests live in `tests/` and cover tallies folding, turn-budget denial, and result projection.
- Keep the plugin dependency-free at runtime: it must not import host-only services.
- `dsh-run.mjs`, `dsh.patch.yml`, and the type contract are verified by the container contract gate in `Dockerfile.base` / `Dockerfile.pr`.

<a id="model-experience"></a>
## Model Experience

### Run observation

#### What the model sees

Nothing directly. The observer reads session events such as `tool/call` and tallies them for the Kestra run report; it registers no prompt, tool, or session content of its own.

#### Token effect

None. Observation consumes existing events without adding model-visible tokens.

#### KV Cache effect

None. No prompt or schema change is introduced.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One-shot by design: each process observes exactly one agent run; there is no daemon mode or long-lived session.
- The allowlist is deny-by-default on tool *names*; payload-level policy is out of scope here and belongs to the permission overlay.
- If the observation target never emits events (e.g. a hung model client), the wall-clock `timeoutSeconds` bound is the only backstop.
