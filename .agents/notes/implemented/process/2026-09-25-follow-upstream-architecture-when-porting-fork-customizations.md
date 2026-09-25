# Agent Note: Follow upstream architecture when porting fork customizations

Status: implemented

English | [中文](2026-09-25-follow-upstream-architecture-when-porting-fork-customizations.zh.md)

## Problem

The fork's `llm-deepseek` package used to be a single plugin carrying the whole DeepSeek integration: shared protocol options, the `apiKeyEnv` credential reference, provider registration, and account routing all lived in one `apply`. Upstream later split this into three packages: `llm-deepseek` (a pure protocol library with no credentials), `llm-deepseek-api-key` (the API-key provider plugin), and `llm-deepseek-account` (the signed-in account provider plugin). A straightforward merge keeps the fork's single-package shape, but that is a hard fork: every future upstream sync must re-reconcile a wholesale-different plugin surface, and the fork cannot consume upstream improvements to either provider package. This was exactly the trap the merge conflict audit flagged: "the whole fork customization" is often only a small part of it, and refusing to follow the upstream architecture multiplies the cost of every later sync.

The same principle applies at the deployment layer: the fork's base bundle mapped the `llm-deepseek` row to the single plugin. After the split, the row must resolve to the api-key package (upstream mapping) with the account package mounted alongside, so the fork keeps using upstream's own composition rather than a fork-only plugin id that upstream does not know.

## Decision

**When a fork customization is implemented on top of an upstream component and the upstream later changes that component's architecture, follow the new architecture and re-port the customization onto it.** Do not declare the whole component "fork customization" and freeze it. Concretely, for the DeepSeek split:

- `llm-deepseek` reverts to the pure protocol library: plugin entry points (`apply`/`name`/`inject`), `ConfigWithApiKey`/`OptionsWithApiKey`/`deepSeekApiKeyConfigFields`/`plainOptionsWithApiKey`, and the `apiKeyEnv` projection in `resolveAdapterOptions` are removed; `resolveAdapterOptions` takes the credential-free `Options` and returns the credential-free `ResolvedDeepSeekOptions`.
- `llm-deepseek-api-key` keeps the upstream shape: its `Config` extends the shared `deepSeekConfigFields` with `apiKeyEnv`, its resolver attaches the `credentialRef`, and its provider authenticates with `x-api-key` only. The pre-split "account first, API-key fallback" `resolveAuth` is **not** ported: upstream's account-routing tests (loaded with the merge, e.g. `never borrows an account token for a missing API key`) pin the strict separation, and the fork's product routes signed-in traffic through the account provider.
- `llm-deepseek-account` re-exports the shared `Config` unchanged (upstream form); the fork's OSS/protocol fields stay in the shared `deepSeekConfigFields`, which both provider packages inherit.
- The base bundle maps `llm-deepseek` to `@deepseek-ai/dsh-llm-deepseek-api-key` and mounts `llm-deepseek-account`, preserving the fork's DashScope `protocol: chat-completions` pin as a row config on the api-key entry (the fork-specific protocol selector itself lives in the shared schema).

The fork's genuine customizations survive on the new architecture: the DashScope `protocol` selector and base-URL resolution chain stay in the shared protocol library (both providers inherit them), and deployment configs keep the `llm-deepseek` settings namespace (`welcome-backend.ts` reads `value.apiKeyEnv` from that namespace, exactly as the api-key provider's `settingsNs` writes it).

## Alternatives considered

**Keep the single-plugin fork shape and treat the whole package as a fork customization.** This is the hard-fork option. It passes today's tests but makes every future upstream sync re-merge a structurally different plugin, and the fork cannot adopt upstream fixes for either provider without conflict.

**Port the account-first fallback into the api-key provider.** The pre-split plugin resolved authentication through the account service first and fell back to the API key. Upstream's split deliberately separates the two providers, and its tests assert the api-key provider never borrows an account token. Porting the fallback into the api-key plugin broke `packages/llm/llm-deepseek/tests/account-routing.spec.ts` (`never borrows an account token for a missing API key`); the merged fork's own suite passes only with the strict separation, so the fallback is a retired pre-split artifact, not a needed customization.

## Consequences

The fork's DeepSeek integration matches the upstream package surface and composition: future syncs reconcile three packages with near-zero fork diff on two of them, and the only fork-specific surface is the protocol selector in the shared schema plus the deployment pin. The three packages' unit suites pass (552 tests across `llm-deepseek`, `llm-deepseek-api-key`, `llm-deepseek-account`), and the full local suite plus remote CI verify the whole repo. The account-routing tests now load the actual upstream packages, which raises the fork's regression protection for provider separation to upstream's own level.
