---
description: "dsh 的 Nacos 配置客户端：轮询 Data ID、检测 MD5 变化，并热更新本地缓存与技能注册表。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-nacos-config

[English](README.md) | 中文

dsh-nacos-config：Nacos 配置客户端（dsh.docx 拓扑中的 `dsh(PC) ←配置拉取→ Nacos`）。

## 概述

dsh 的 Nacos 配置客户端：拉取六个 `dsh-*.yaml` Data ID，通过轮询检测 MD5 变化，热更新本地缓存与技能包注册表（stable/gray/disabled），并在 Nacos 不可达时降级读取磁盘缓存。认证默认使用 OIDC client-credentials，也支持传统本地账密登录。

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

插件随其所属 profile 挂载，把六个 `dsh-*.yaml` 文档热保持在内存与磁盘；消费方直接读取缓存中的解析值，无需自行联系 Nacos。

### 何时选用

任何在 Nacos 中集中管理 dsh 策略文档（工具、权限、容错、上下文、技能、提示词）、并希望获得 MD5 变化自动热更新与磁盘降级的部署都适用。

### 最小配置

用 `server` 指向 Nacos v3 控制台。在启用 OIDC 的 Nacos 上提供 `oidcTokenUrl`、`clientId` 与 `clientSecret`；否则用 `auth: 'local'` + `username`/`password`。

<a id="configuration"></a>
## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `server` | 必填 | Nacos v3 控制台地址，如 `http://nacos.internal:18480`。 |
| `auth` | `oidc` | `oidc`（Kestra client-credentials）或 `local`（传统 nacos 账密）。 |
| `oidcTokenUrl` | 推导 | client-credentials 的 Kestra OIDC token 端点。 |
| `clientId` / `clientSecret` | — | client-credentials 身份（种子化 nacos 客户端）。 |
| `username` / `password` | `nacos` / 空 | 传统控制台登录。 |
| `namespace` | `dsh` | Nacos 命名空间。 |
| `group` | `DEFAULT_GROUP` | 配置分组。 |
| `pollIntervalMs` | `10000` | 监听轮询间隔。 |
| `dataIds` | 六个 `dsh-*` | 跟踪的 Data ID。 |

<a id="usage"></a>
## 用法

客户端拥有轮询、缓存与技能注册表；消费方读取解析值并订阅变更：

```ts
import { NacosConfigClient } from '@deepseek-ai/dsh-plugin-nacos-config'

const client = new NacosConfigClient({ server: 'http://nacos.internal:18480', auth: 'oidc', clientId: 'nacos', clientSecret: '…' })
client.onConfigChange((dataId, parsed) => console.log(dataId, 'changed'))
await client.fetchConfig<{ tools: unknown[] }>('dsh-tools.yaml')
client.start()
```

<a id="dev-note"></a>
## 开发备注

- 测试位于 `tests/`；保持插件仅出站且运行时零依赖。
- 六个 Data ID 由部署覆盖层拥有；插件从不编辑它们。

<a id="model-experience"></a>
## 模型体验

### 配置下发

#### 模型看到什么

不直接看到任何内容。覆盖层值通过 `configService` 到达宿主；模型绝不会收到 `dsh-fault-tolerance.yaml` 等配置载荷。

#### Token 影响

无。配置轮询与磁盘降级不添加任何模型可见 token。

#### KV Cache 影响

无，除非某个覆盖层值改变了承载提示词的组件；插件本身不引入任何前缀或 schema 变更。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 轮询基于间隔而非真正的长轮询：MD5 变化在一个轮询间隔内被观察到，而非被推送。
- 磁盘降级是只读尽力而为：损坏的缓存文件被跳过，且只在 Nacos 成功应答时写入。
- access token 缓存在内存，仅在登录时重新获取；凭据被吊销后在下次轮询重试，而非立即检测。
