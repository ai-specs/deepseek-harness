---
description: "Local fault tolerance for dsh tool calls: bounded exponential-backoff retries, graceful degradation fallbacks, and circuit breaking."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-fault-tolerance

dsh 本地容错插件（dsh.docx 第九章）：工具调用失败被本层拦截，**底层错误不透传给用户**。

## Summary

- 指数退避重试：默认 4 次，1s → 2s → 4s → 8s（baseDelayMs × multiplier^(n-1)）
- 兜底降级：重试耗尽后按正则匹配兜底规则库，返回安全默认答复
- 熔断：连续失败达阈值（默认 5）进入 open，openSeconds 后 half_open 探测

配置全部由 Nacos `dsh-fault-tolerance.yaml` 下发映射而来。

## Table of Contents

- [Summary](#summary)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Use this package

The plugin mounts automatically with the profile it ships in; it intercepts tool-call failures at the tool layer, so no per-call wiring is required.

### When to choose it

Use it in any profile that calls external tools over unreliable networks and wants bounded retries plus a safe default answer when all retries are exhausted.

### Minimal configuration

All knobs are read from the Nacos-delivered `dsh-fault-tolerance.yaml` overlay: `maxRetries`, `baseDelayMs`, `multiplier`, `fallbackRules`, and circuit-breaker thresholds.

## Understand the implementation

Retries run with exponential backoff and jitter; when the retry budget is exhausted the failure is matched against the fallback rule base and, if matched, replaced with the configured safe answer. A circuit breaker tracks consecutive failures and opens for `openSeconds`, then probes with a half-open request.

## Dev Note

- Tests live in `tests/` and cover retry budget, fallback matching, and breaker transitions.
- Keep the plugin dependency-free at runtime: it must not import host-only services.
