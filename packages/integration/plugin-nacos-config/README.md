---
description: "Nacos configuration client for dsh: polls Data IDs, detects MD5 changes, and hot-reloads the local cache and skill registry."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-nacos-config

## Summary

dsh-nacos-config：Nacos 配置客户端（dsh.docx 拓扑中的 `dsh(PC) ←配置拉取→ Nacos`）。

- 拉取 6 个 Data ID：dsh-tools / dsh-permission / dsh-fault-tolerance / dsh-context / dsh-skills / dsh-prompt
- 轮询监听（MD5 变更检测），变更回调热更新本地缓存
- 技能包注册表解析 + 灰度下载（stable 全量、gray 按 percent 灰度桶、disabled 跳过）

## Table of Contents

- [Summary](#summary)
- [Configuration](#configuration)
- [Usage](#usage)
- [Dev Note](#dev-note)

## Dev Note

- Tests live in `tests/`; keep the plugin outbound-only and dependency-free at runtime.


dsh-nacos-config：Nacos 配置客户端（dsh.docx 拓扑中的 `dsh(PC) ←配置拉取→ Nacos`）。

- 拉取 6 个 Data ID：dsh-tools / dsh-permission / dsh-fault-tolerance / dsh-context / dsh-skills / dsh-prompt
- 轮询监听（MD5 变更检测），变更回调热更新本地缓存
- 技能包注册表解析 + 灰度下载（stable 全量、gray 按 percent 灰度桶、disabled 跳过）


| 字段 | 默认 | 说明 |
|---|---|---|
| server | 必填 | Nacos 地址，如 `http://nacos.internal:8848` |
| namespace | `dsh` | 命名空间 |
| group | `DEFAULT_GROUP` | 分组 |
| pollIntervalMs | `10000` | 监听轮询间隔 |