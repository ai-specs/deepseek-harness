---
description: "Session-sync client pushing dsh(PC) session snapshots to Kestra: outbound-only, event-triggered, with realtime/batch modes."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-kestra-sync

English | [中文](README.zh.md)

dsh-kestra-sync：会话同步客户端（dsh.docx 拓扑中的 `dsh(PC) ←会话同步→ Kestra`）。

## Summary

Outbound-only session-sync client pushing dsh(PC) session snapshots to Kestra: session start, subagent completion, high-risk decision points (pending approval), and session end. Supports realtime and batch push modes, plus web-identity authenticated phone-input relay integration. The plugin listens on no port.

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

The plugin mounts with the profile that ships it and starts pushing session snapshots on the lifecycle triggers; no per-call wiring is required. Because dsh(PC) has no public IP, the plugin only ever connects out to the Kestra API.

### When to choose it

Use it in any deployment where Kestra is the observation center and dsh(PC) must report session lifecycle, token usage, and pending-approval decision points without exposing a listening port.

### Minimal configuration

Point the plugin at the Kestra API with `baseUrl` and a bearer `token`; realtime mode is the default. For phone-input relay, set `auth: 'web-identity'` so the client authenticates with the retained browser OIDC identity instead of a daemon-side login.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Kestra API base URL, e.g. `http://kestra.internal:8080`. |
| `token` | required | Bearer token for the API gateway (unused when `auth: 'web-identity'`). |
| `auth` | `token` | `token` (gateway bearer) or `web-identity` (retained browser OIDC identity). |
| `tenant` | `main` | Kestra 2.x tenant. |
| `mode` | `realtime` | `realtime` pushes immediately; `batch` coalesces within `batchIntervalMs`. |
| `batchIntervalMs` | `2000` | Batch flush interval in milliseconds. |
| `timeoutMs` | `5000` | Per-push timeout in milliseconds. |

<a id="usage"></a>
## Usage

The client is constructed once and pushes session snapshots from lifecycle triggers:

```ts
import { KestraSessionSyncClient } from '@deepseek-ai/dsh-plugin-kestra-sync'

const client = new KestraSessionSyncClient({ baseUrl: 'http://kestra:8080', token: 'gateway-token' })
await client.push({ sessionId: 's-1', phase: 'pending_approval', approval: { approvalType: 'refund' } })
```

<a id="dev-note"></a>
## Dev Note

- Tests live in `tests/`; keep the plugin outbound-only and dependency-free at runtime.
- The PKCE/web-identity machinery lives in this package; the retained identity record itself is owned by `client-connection`.

<a id="model-experience"></a>
## Model Experience

### Session snapshot sync

#### What the model sees

Nothing directly. Snapshots are produced from the session log for the Kestra API and never enter model context; the retained identity record is owned by `client-connection`.

#### Token effect

None. Snapshot construction reads persisted state without adding model-visible tokens.

#### KV Cache effect

None. No request prefix or schema change is introduced.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Outbound-only by design: if the Kestra API is unreachable, snapshots are dropped silently rather than retried indefinitely (a failed push never blocks the session).
- PKCE sign-in state is in-process memory: a `dsh web` restart expires an in-flight browser sign-in, which the user retries.
- Batch mode coalesces by wall-clock interval, not by event count or size; very high event rates can grow a batch buffer.
