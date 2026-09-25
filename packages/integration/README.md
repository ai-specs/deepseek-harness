---
description: "Package map for the external-system integration family: the Kestra observation/session-sync bridge, the Nacos configuration client, and the headless remote-input observer."
kind: "package-group"
---

# integration/ — external-system integration family

English | [中文](README.zh.md)

## Summary

The `integration/` group bridges dsh(PC) to external systems without adding a new Harness service. `plugin-kestra-sync` pushes session snapshots out to the Kestra observation center (outbound-only, realtime or batch). `plugin-nacos-config` pulls the six `dsh-*.yaml` policy documents from Nacos and hot-reloads them by MD5 change. `plugin-kestra-run` is the headless one-shot observer for a phone-side remote-input run, producing the structured result that kestra-sync relays.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three plugins cover the three integration directions; each README below explains configuration and limits.

| Package | What it provides |
|---|---|
| [`plugin-kestra-sync/`](plugin-kestra-sync/README.md) | Outbound-only session-sync client pushing dsh(PC) snapshots to Kestra, with web-identity authenticated phone-input relay |
| [`plugin-nacos-config/`](plugin-nacos-config/README.md) | Nacos configuration client polling the six `dsh-*.yaml` Data IDs with MD5-change hot reload and disk degradation |
| [`plugin-kestra-run/`](plugin-kestra-run/README.md) | Headless one-shot observer for phone-side remote-input runs, with allowlist guard and the kestra-sync result contract |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline these plugins observe, then each plugin's README.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline the sync/run plugins observe and report on.
- [Configuration catalog](../../docs/config-catalog.md) — accepted fields of the guard and integration plugins.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The group owns no dedicated subsystem page of its own: the three packages are external-system integration bridges whose contracts live in their own READMEs, and they reference the tools subsystem for the pipeline they observe. Keep every plugin outbound-only and dependency-free at runtime.

</details>
