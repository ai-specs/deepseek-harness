---
description: "Local fault tolerance for dsh tool calls: bounded exponential-backoff retries, graceful degradation fallbacks, and circuit breaking."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-fault-tolerance

English | [中文](README.zh.md)

dsh 本地容错插件（dsh.docx 第九章）：工具调用失败被本层拦截，**底层错误不透传给用户**。

## Summary

Bounded retries, rule-based fallbacks, and circuit breaking for dsh tool calls. Tool failures are captured here and never surface raw to the user: exponential-backoff retry, then the fallback rule library, then the circuit breaker. All knobs are delivered through the Nacos `dsh-fault-tolerance.yaml` overlay.

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

The plugin mounts automatically with the profile it ships in; it intercepts tool-call failures at the tool layer, so no per-call wiring is required.

### When to choose it

Use it in any profile that calls external tools over unreliable networks and wants bounded retries plus a safe default answer when all retries are exhausted.

### Minimal configuration

All knobs are read from the Nacos-delivered `dsh-fault-tolerance.yaml` overlay: `maxRetries`, `baseDelayMs`, `multiplier`, `fallbackRules`, and circuit-breaker thresholds. The plugin is enabled by default in the `dsh` base bundle.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxRetries` | `4` | Maximum attempts before the call is declared failed. |
| `baseDelayMs` | `1000` | Base backoff delay in milliseconds (1s → 2s → 4s → 8s). |
| `multiplier` | `2` | Backoff multiplier between attempts. |
| `fallbackRules` | `[]` | Regex-to-safe-answer rules matched against the failed tool name. |
| `failureThreshold` | `5` | Consecutive failures that open the circuit breaker. |
| `openSeconds` | `30` | How long the breaker stays open before a half-open probe. |

<a id="usage"></a>
## Usage

The plugin operates transparently; a failing call resolves through retry, fallback, or a structured failure instead of throwing raw:

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
## Dev Note

- Tests live in `tests/` and cover retry budget, fallback matching, and breaker transitions.
- Keep the plugin dependency-free at runtime: it must not import host-only services.

<a id="model-experience"></a>
## Model Experience

### Tool failure handling

#### What the model sees

Nothing directly. A failing external call is resolved here into a safe fallback answer or a structured failure before it reaches the model, so raw transport errors from the underlying tool never enter model context; the model only ever sees the normal `tool/result` outcome.

#### Token effect

None. The plugin neither constructs nor consumes model tokens; it only short-circuits failing tool calls.

#### KV Cache effect

None. No prompt, schema, or message is added to any session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Breaker state is per-process memory: a multi-instance deployment does not share the open/half-open state, so traffic to a failing backend can still hit it from another instance.
- Fallback rules match only the tool name against a regular expression; payload-aware fallback decisions are not supported yet.
- No persisted metrics are exported; the Kestra observation center receives guard events only from the runtime-guard plugin.
