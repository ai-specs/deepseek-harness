# Agent Note: 定制功能跟随上游新架构移植

Status: implemented

[English](2026-09-25-follow-upstream-architecture-when-porting-fork-customizations.md) | 中文

## Problem

fork 的 `llm-deepseek` 包过去是单插件形态：共享协议选项、`apiKeyEnv` 凭证引用、provider 注册和账号路由全部塞在一个 `apply` 里。上游后来把它拆成三个包：`llm-deepseek`（纯协议库，无凭证）、`llm-deepseek-api-key`（API-key provider 插件）和 `llm-deepseek-account`（登录账号 provider 插件）。直接合并会保留 fork 的单插件形态，但那是硬分叉：之后每次同步上游都要重新协调一个结构完全不同的插件面，fork 也无法直接吸收上游对任一 provider 包的改进。这正是合并冲突审计指出的陷阱："整个 fork 定制"往往只有一小部分是真的定制，拒绝跟随上游架构会让之后每次同步的代价成倍放大。

部署层同理：fork 的 base bundle 把 `llm-deepseek` 行映射到单插件。拆分之后，该行必须按上游映射到 api-key 包，并挂载 account 包，这样 fork 沿用上游自己的组合方式，而不是一个上游不认识、仅 fork 独有的插件 id。

## Decision

**当定制功能是在上游组件之上实现的，而上游后来改变该组件的架构时，必须跟随新架构，把定制移植到新架构上。** 不要把整个组件划为"fork 定制"并冻结不动。具体到 DeepSeek 拆分：

- `llm-deepseek` 回归纯协议库：移除插件入口（`apply`/`name`/`inject`）、`ConfigWithApiKey`/`OptionsWithApiKey`/`deepSeekApiKeyConfigFields`/`plainOptionsWithApiKey`，以及 `resolveAdapterOptions` 里的 `apiKeyEnv` 投影；`resolveAdapterOptions` 接收无凭证的 `Options`，返回无凭证的 `ResolvedDeepSeekOptions`。
- `llm-deepseek-api-key` 保持上游形态：其 `Config` 在共享 `deepSeekConfigFields` 之上扩展 `apiKeyEnv`，其 resolver 附加 `credentialRef`，provider 仅用 `x-api-key` 认证。拆分前"账号优先、API-key 回落"的 `resolveAuth` **不移植**：上游的账号路由测试（随合并进入 fork，如 `never borrows an account token for a missing API key`）钉死了严格的职责分离，fork 产品本身通过账号 provider 承载登录态流量。
- `llm-deepseek-account` 原样 re-export 共享 `Config`（上游形态）；fork 的 OSS/协议字段留在共享 `deepSeekConfigFields`，两个 provider 包自动继承。
- base bundle 把 `llm-deepseek` 映射到 `@deepseek-ai/dsh-llm-deepseek-api-key` 并挂载 `llm-deepseek-account`，fork 的 DashScope `protocol: chat-completions` 钉死作为 api-key 行的 config 保留（fork 特有的协议选择器本身在共享 schema 里）。

fork 真正的定制在新架构上全部存活：DashScope `protocol` 选择器和 base-URL 解析链留在共享协议库（两个 provider 都继承），部署配置继续使用 `llm-deepseek` settings 命名空间（`welcome-backend.ts` 读该命名空间的 `value.apiKeyEnv`，正是 api-key provider 的 `settingsNs` 写入的位置）。

## Alternatives considered

**保留单插件 fork 形态，把整个包视为 fork 定制。** 这是硬分叉选项。今天能过测试，但之后每次上游同步都要重新合并一个结构不同的插件，fork 也无法无冲突地吸收上游对任一 provider 的修复。

**把账号优先回落移植进 api-key provider。** 拆分前插件先走账号服务再回落 API-key。上游拆分刻意分离两个 provider，且测试断言 api-key provider 绝不借用账号 token。移植该回落会破坏 `packages/llm/llm-deepseek/tests/account-routing.spec.ts`（`never borrows an account token for a missing API key`）；合并后的 fork 自己只有严格分离时才全绿，所以该回落后是拆分前的退役产物，不是需要的定制。

## Consequences

fork 的 DeepSeek 集成与上游包面、组合方式完全对齐：后续同步只需协调三个包，其中两个相对上游近乎零差异，唯一的 fork 专属面是共享 schema 里的协议选择器加部署钉死。三个包的单元测试全过（`llm-deepseek`、`llm-deepseek-api-key`、`llm-deepseek-account` 共 552 项），全量本地套件与远端 CI 再验证整个仓库。账号路由测试现在加载的是真正的上游包，把 provider 分离的回归保护提升到上游自己的水平。
