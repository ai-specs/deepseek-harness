---
description: "Nacos configuration client for dsh: polls Data IDs, detects MD5 changes, and hot-reloads the local cache and skill registry."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-nacos-config

English | [中文](README.zh.md)

dsh-nacos-config：Nacos 配置客户端（dsh.docx 拓扑中的 `dsh(PC) ←配置拉取→ Nacos`）。

## Summary

Nacos configuration client for dsh: pulls the six `dsh-*.yaml` Data IDs, detects MD5 changes by polling, hot-reloads the local cache and the skill-package registry (stable/gray/disabled), and degrades to the on-disk cache when Nacos is unreachable. Authentication is OIDC client-credentials by default, with legacy local login supported.

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

The plugin mounts with the profile that ships it and keeps the six `dsh-*.yaml` documents hot in memory and on disk; consumers read parsed config through the cached values without contacting Nacos themselves.

### When to choose it

Use it in any deployment that manages dsh policy documents (tools, permission, fault tolerance, context, skills, prompt) centrally in Nacos and wants automatic MD5-change hot reload with disk degradation.

### Minimal configuration

Point the plugin at the Nacos v3 console with `server`. In an OIDC-deployed Nacos, provide `oidcTokenUrl`, `clientId`, and `clientSecret`; otherwise use `username`/`password` with `auth: 'local'`.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `server` | required | Nacos v3 console URL, e.g. `http://nacos.internal:18480`. |
| `auth` | `oidc` | `oidc` (Kestra client-credentials) or `local` (legacy nacos login). |
| `oidcTokenUrl` | derived | Kestra OIDC token endpoint for client-credentials. |
| `clientId` / `clientSecret` | — | Client-credentials identity (seeded nacos client). |
| `username` / `password` | `nacos` / empty | Legacy console login. |
| `namespace` | `dsh` | Nacos namespace. |
| `group` | `DEFAULT_GROUP` | Config group. |
| `pollIntervalMs` | `10000` | Listener poll interval. |
| `dataIds` | six `dsh-*` | Data IDs to track. |

<a id="usage"></a>
## Usage

The client owns polling, caching, and the skill registry; consumers read parsed values and subscribe to changes:

```ts
import { NacosConfigClient } from '@deepseek-ai/dsh-plugin-nacos-config'

const client = new NacosConfigClient({ server: 'http://nacos.internal:18480', auth: 'oidc', clientId: 'nacos', clientSecret: '…' })
client.onConfigChange((dataId, parsed) => console.log(dataId, 'changed'))
await client.fetchConfig<{ tools: unknown[] }>('dsh-tools.yaml')
client.start()
```

<a id="dev-note"></a>
## Dev Note

- Tests live in `tests/`; keep the plugin outbound-only and dependency-free at runtime.
- The six Data IDs are owned by the deployment overlay; the plugin never edits them.

<a id="model-experience"></a>
## Model Experience

### Configuration delivery

#### What the model sees

Nothing directly. Overlay values reach the host through the `configService`; the model never receives configuration payloads such as `dsh-fault-tolerance.yaml`.

#### Token effect

None. Config polling and disk degradation add no model-visible tokens.

#### KV Cache effect

None unless an overlay value changes a prompt-bearing component; the plugin itself introduces no prefix or schema change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Polling is interval-based rather than true long-polling: MD5 changes are observed within one poll interval, not pushed.
- Disk degradation is read-only best-effort: a corrupted cached file is skipped, and writes happen only when Nacos answers successfully.
- The access token is cached in memory and re-fetched only on login; a revoked credential is retried on the next poll rather than detected immediately.
