---
description: "Runtime guard rails for dsh sessions: loop detection, nesting depth limits, and token budget enforcement with Kestra observability events."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-runtime-guard

dsh 运行时防护插件（dsh.docx 第十二章 稳定性兜底）：

## Summary

- **防死锁计数器**：同一工具+同参指纹连续 `loopRepeatThreshold`（默认 3）次即判循环并强制打断
- **执行深度检测**：子任务嵌套深度超 `maxDepth`（默认 8）强制终止
- **Token 消耗监控**：单会话超 `tokenBudget`（默认 500000）告警/熔断
- 防护事件经 `onEvent` 上报 Kestra 观察中心（配合 dsh-kestra-sync）

## Table of Contents

- [Summary](#summary)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Use this package

The plugin mounts automatically with the profile it ships in and guards every tool loop, subagent spawn, and token-accounting boundary; no per-call wiring is required.

### When to choose it

Use it in any profile that must not hang on a repeated tool fingerprint, must bound subagent nesting, or must keep a session within its token budget.

### Minimal configuration

All knobs come from the Nacos-delivered `dsh-runtime-guard.yaml` overlay: `loopRepeatThreshold`, `maxDepth`, `tokenBudget`, and breaker behavior.

## Understand the implementation

A fingerprint of tool + serialized arguments feeds a consecutive-hit counter; exceeding the threshold interrupts the loop. Subagent nesting depth is tracked per session and enforced at spawn. Token consumption is measured against the budget with warning then hard-stop semantics, and every guard event is emitted through `onEvent` for the Kestra sync plugin.

## Dev Note

- Tests live in `tests/` and cover loop detection, depth limits, and budget transitions.
- Keep the plugin dependency-free at runtime: it must not import host-only services.
