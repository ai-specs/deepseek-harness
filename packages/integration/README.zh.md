---
description: "外部系统集成家族的包映射：Kestra 观察/会话同步桥、Nacos 配置客户端与无头 remote-input 观察器。"
kind: "package-group"
---

# integration/：外部系统集成家族

[English](README.md) | 中文

## 概述

`integration/` 组把 dsh(PC) 桥接到外部系统，而不新增 Harness 服务。`plugin-kestra-sync` 把会话快照仅出站推送到 Kestra 观察中心（实时或批量）。`plugin-nacos-config` 从 Nacos 拉取六个 `dsh-*.yaml` 策略文档，按 MD5 变化热更新。`plugin-kestra-run` 是手机侧 remote-input 运行的无头单次观察器，产出由 kestra-sync 转发的结构化结果。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

三个插件覆盖三个集成方向；下方每个 README 说明配置与限制。

| 包 | 提供什么 |
|---|---|
| [`plugin-kestra-sync/`](plugin-kestra-sync/README.zh.md) | 仅出站的会话同步客户端，把 dsh(PC) 快照推送到 Kestra，支持 web-identity 认证的手机输入联动 |
| [`plugin-nacos-config/`](plugin-nacos-config/README.zh.md) | Nacos 配置客户端，轮询六个 `dsh-*.yaml` Data ID，MD5 变化热更新并支持磁盘降级 |
| [`plugin-kestra-run/`](plugin-kestra-run/README.zh.md) | 手机侧 remote-input 运行的无头单次观察器，带白名单防护与 kestra-sync 结果契约 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解这些插件所观察的工具调用流水线，再看各插件的 README。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——sync/run 插件所观察并上报的工具调用流水线。
- [配置目录](../../docs/config-catalog.zh.md)——guard 与 integration 插件的受支持字段。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本组不拥有自己的专门子系统页：三个包是外部系统集成桥接，其契约由各自 README 拥有，它们引用工具子系统以说明所观察的流水线。保持每个插件仅出站且运行时零依赖。

</details>
