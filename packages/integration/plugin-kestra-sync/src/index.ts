/**
 * dsh-kestra-sync — Cordis plugin that keeps Kestra up to date with local dsh
 * session state (dsh.docx: 会话存储/观察中心/安全审批 live on the Kestra side).
 * @module @deepseek-ai/dsh-plugin-kestra-sync
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// 事件负载（session/created、session/event）的 cordis Events 增补来自该包的 ambient 声明。
import type {} from '@deepseek-ai/dsh-session'
import {
  KestraSessionSyncClient,
  SessionIndex,
  deriveHistory,
  deriveTitleFromLog,
  foldSyncState,
  type KestraSyncConfig,
  type RelayQuery,
  type RemoteInput,
  type SessionSnapshot,
} from './core.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The web profile's retained user identity (provided by client-connection in oidc mode). */
    webIdentity: import('./core.ts').WebIdentityHandle
  }
}

export const name = 'kestra-sync'
export const inject = ['agents', 'sessionController', 'workspaceRegistry']

/**
 * 插件配置：继承 {@link KestraSyncConfig} 全部连接/推送参数，追加 dsh 接入端行为。
 */
export interface Config extends KestraSyncConfig {
  /** 批量队列磁盘持久化路径（默认 ~/.dsh/sync-queue.jsonl） */
  queuePath?: string
  /** 手机输入接力执行的超时秒数（默认 300）。 */
  remoteInputTimeoutSeconds?: number
  /** 选项 B：SSE 指令接收主链路（默认 true）。false 时 PC 不接入中台（无降级轮询——A 组件已退役）。 */
  useSse?: boolean
  /** 本地会话索引快照路径（默认 ~/.dsh/kestra-session-index.json；dsh 数据卷内即持久）。 */
  sessionIndexPath?: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  // 三选一：静态 access token / clientId+clientSecret（client_credentials 服务身份）/
  // pkce 块（Authorization Code + PKCE 用户身份，会话归属该用户 OIDC sub）
  token: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  auth: z.union(['client_credentials', 'pkce', 'web-identity']),
  pkce: z.object({
    issuer: z.string(),
    clientId: z.string(),
    redirectPort: z.number(),
    scopes: z.array(z.string()),
    cachePath: z.string(),
  }),
  tenant: z.string(),
  mode: z.union(['realtime', 'batch']),
  batchIntervalMs: z.number(),
  timeoutMs: z.number(),
  queuePath: z.string(),
  remoteInputTimeoutSeconds: z.number(),
  useSse: z.boolean().default(true),
  sessionIndexPath: z.string(),
})

export type * from './core.ts'
export type * from './pkce.ts'
export { KestraSessionSyncClient, SessionIndex, buildSyncRequest, buildTokenRequest, decideInputTarget } from './core.ts'
export { PkceTokenProvider, codeChallenge, buildAuthorizeUrl } from './pkce.ts'

export type { SessionSnapshot, RemoteInput }

/**
 * agentDefaultModel 服务的最小结构（@deepseek-ai/dsh-agent-default-model，web-app
 * bundle 内置）。按结构类型访问而不 import 该包——插件包独立构建（rootDir=src），
 * 跨包类型导入会把其源码拉进本包工程（TS6059/6307）。
 */
interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: unknown }
  saveSelection(next: { provider: string; model: string; reasoningEffort?: unknown }): Promise<void>
}

/** Mount one configured client: provide + optional remote-input poller. */
function mountClient(ctx: Context, config: Config, client: KestraSessionSyncClient): KestraSessionSyncClient {
  ctx.provide('kestraSync', client)

  // 模型选择读取（裁定版风险 #2 收口）：relay overlay 生成时读 PC 当前默认选择写死。
  // 按调用时同步解析；服务不可见时回落
  // env/历史默认——每条路径都有日志可观测。
  const getModelService = (): AgentDefaultModelLike | undefined =>
    ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined

  // DSH_MODEL/DSH_PROVIDER 显式覆盖（首次 relay 时应用一次，规避 mount 期服务未就绪的
  // 竞态；之后不重申，UI 修改以后续修改为准 last-write-wins）：PC 端 settings user
  // layer 会压过 overlay base（层语义 schema defaults → base → user），env 想真正赢
  // 必须落到 user layer。三分支都有日志可观测。
  let envOverrideApplied = false
  const applyEnvOverrideOnce = (): void => {
    if (envOverrideApplied) return
    envOverrideApplied = true
    const envProvider = process.env.DSH_PROVIDER
    const envModel = process.env.DSH_MODEL
    if (envModel === undefined && envProvider === undefined) return
    const svc = getModelService()
    if (svc === undefined) {
      process.stderr.write('[kestra-sync] agentDefaultModel unavailable — DSH_MODEL/DSH_PROVIDER override NOT applied to PC relay\n')
      return
    }
    const cur = svc.currentSelection()
    const next = {
      provider: envProvider ?? cur.provider,
      model: envModel ?? cur.model,
      ...cur.reasoningEffort === undefined ? {} : { reasoningEffort: `${cur.reasoningEffort as string | number}` },
    }
    if (next.provider !== cur.provider || next.model !== cur.model) {
      void svc.saveSelection(next)
        .then(() => process.stderr.write(`[kestra-sync] DSH_MODEL/DSH_PROVIDER override saved as default model: ${next.provider}/${next.model}\n`))
        .catch((e: unknown) => process.stderr.write(`[kestra-sync] DSH_MODEL override save failed: ${String(e)}\n`))
    } else {
      process.stderr.write(`[kestra-sync] DSH_MODEL already default model: ${cur.provider}/${cur.model}\n`)
    }
  }

  // 指令接收（选项 B 主链路）：链式执行入口保证同一时刻至多一个 live agent 回合。
  // SSE 开启（默认）时经 startInputSse 实时接收；useSse=false 时 PC 不接入中台
  // （轮询降级已随选项 A 退役）。
  const chain: { p: Promise<void> } = { p: Promise.resolve() }
  const index = new SessionIndex(config.sessionIndexPath ?? join(homedir(), '.dsh', 'kestra-session-index.json'))
  const workspaceRegistry = (ctx as Context & {
    workspaceRegistry: {
      get(id: string): {
        id: string
        title: string
        path: string
        sessionIds: readonly string[]
        attachSession(id: string): Promise<void>
      } | undefined
      list(): Array<{
        id: string
        title: string
        path: string
        sessionIds: readonly string[]
        attachSession(id: string): Promise<void>
      }>
    }
  }).workspaceRegistry

  /**
   * 方案 A（统一执行面）：手机 relay 输入在 PC web 进程内以 live Agent 执行——
   * 与 PC UI 直接新建会话同机制。新会话先 `session.create`（会话实体 id = 手机端
   * sessionId，两端同 id、PC 为权威），再 `prompt` 驱动；追问 resume 同一实体。
   * 会话因此进入 PC 原生会话体系（PC UI 列表可见、live agent 可保持续上下文、
   * `session/title` 权威标题回填 SessionIndex——手机端标题 = PC 权威）。
   * 本函数是手机 relay 输入的**唯一执行面**（2026-09-24 退役 headless 保底）：
   * live agent 不可用/创建失败一律记录 failed 终态，不再回退子进程。
   */
  const executeOnLiveAgent = async (
    input: RemoteInput,
    pcSessionId: string,
    options: {
      isNewSession?: boolean
      workspaceId?: string
    },
  ): Promise<boolean> => {
    interface LiveAgent {
      whenIdle(): Promise<void>
      session: {
        deriveMessages(): ReadonlyArray<{ role: string; content: unknown }>
        // 事件快照（session/title 等）——运行时 API 存在，类型对齐 core.ts 契约。
        snapshotEvents?(): ReadonlyArray<{ type: string; data?: unknown }>
      }
    }
    const host = ctx as Context & {
      agents?: { get(id: string): LiveAgent | undefined }
      sessionController?: {
        create?(request: {
          sessionId: string
          workspaceId?: string
          cwd?: string
          agentPreset?: string
        }): Promise<{ sessionId: string }>
        prompt(request: {
          requestId: string
          sessionId: string
          mode: 'queue'
          content: Array<{ type: 'text'; text: string }>
        }, signal: AbortSignal): Promise<{ accepted: true }>
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- defensive coalesce in case a caller violates the input type
    const recordSessionId = input.sessionId ?? pcSessionId
    const startedAt = Date.now()
    if (host.agents === undefined || host.sessionController === undefined) {
      // PC 只支持 web 形态（daemon/headless 挂载已退役）：live agent 缺失即执行失败。
      process.stderr.write('[kestra-sync] live PC agent unavailable (agents/sessionController not provided)\n')
      index.record({
        sessionId: recordSessionId,
        phase: 'failed',
        prompt: input.text,
        result: '执行失败：PC web 进程未提供 live agent 能力',
      })
      void client.reportMetric({
        type: 'session_end',
        sessionId: recordSessionId,
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
      })
      return true
    }
    // SessionIndex 主键恒为手机端稳定 sessionId（手机查询面）；pcSessionId 即手机
    // sessionId（方案 A：会话实体双端同 id，无孪生映射）。

    process.stderr.write(`[kestra-sync] remote input using live PC agent: session=${input.sessionId} pc=${pcSessionId} new=${options.isNewSession === true}\n`)
    try {
      // 新会话：先 create（幂等 adopt，会话实体 id=手机 sessionId，cwd 由 workspace/defaultCwd 决定）。
      if (options.isNewSession === true) {
        if (host.sessionController.create === undefined) return false
        try {
          await host.sessionController.create({
            sessionId: pcSessionId,
            ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          })
        } catch (createError) {
          // 创建失败（如 workspace not found）即执行失败：live agent 是唯一执行面，
          // 不再回退 headless 子进程（2026-09-24 退役）。
          process.stderr.write(`[kestra-sync] live PC agent create failed: session=${input.sessionId} error=${String(createError)}\n`)
          index.record({
            sessionId: recordSessionId,
            phase: 'failed',
            prompt: input.text,
            result: `执行失败：会话创建失败 ${String(createError).slice(0, 200)}`,
          })
          void client.reportMetric({
            type: 'session_end',
            sessionId: recordSessionId,
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
          })
          return true
        }
      }
      await host.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: pcSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: input.text }],
      }, new AbortController().signal)
      const agent = host.agents.get(pcSessionId)
      if (agent === undefined) throw new Error('SessionController accepted input without publishing the live Agent')
      // whenIdle 竞速超时：远程输入链是串行的，agent 卡死（如 LLM 流停滞）时若无限
      // 等待，一个卡死的回合会堵死所有后续远程输入。超时落 failed 终态并释放链。
      const idleTimeoutMs = (config.remoteInputTimeoutSeconds ?? 300) * 1000
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<boolean>((resolve) => {
        idleTimer = setTimeout(() => { resolve(true) }, idleTimeoutMs)
        ;(idleTimer as { unref?: () => void }).unref?.()
      })
      const idle = agent.whenIdle().then(() => false as const)
      const hitTimeout = await Promise.race([idle, timedOut])
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      if (hitTimeout) {
        process.stderr.write(`[kestra-sync] live PC agent idle timeout (${idleTimeoutMs}ms): session=${recordSessionId}\n`)
        index.record({
          sessionId: recordSessionId,
          phase: 'failed',
          prompt: input.text,
          result: `执行超时：live agent ${Math.round(idleTimeoutMs / 1000)}s 未回到空闲`,
        })
        void client.reportMetric({
          type: 'session_end',
          sessionId: recordSessionId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
        })
        return true
      }
      const derived = agent.session.deriveMessages()
      const result = foldSyncState(derived).result ?? ''
      const agentEvents = agent.session.snapshotEvents?.() ?? []
      // 会话标题以 PC 端为准：LLM 生成标题（provider）则镜像为 title（回填 SessionIndex）。
      const providerTitle = deriveTitleFromLog(agentEvents)
      index.record({
        sessionId: recordSessionId,
        phase: 'completed',
        prompt: input.text,
        ...(result === '' ? {} : { result }),
        // 完整轮次（含 PC web 直发轮）作为权威历史：手机游标增量内可见 PC 插入的消息。
        derivedHistory: deriveHistory(derived),
        ...(providerTitle === undefined ? {} : { title: providerTitle }),
      })
      void client.reportMetric({
        type: 'session_end',
        sessionId: recordSessionId,
        outcome: 'completed',
        durationMs: Date.now() - startedAt,
      })
      return true
    } catch (e) {
      process.stderr.write(`[kestra-sync] live PC agent input failed: session=${recordSessionId} error=${String(e)}\n`)
      index.record({
        sessionId: recordSessionId,
        phase: 'failed',
        prompt: input.text,
        result: `执行失败：${String(e).slice(0, 200)}`,
      })
      void client.reportMetric({
        type: 'session_end',
        sessionId: recordSessionId,
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
      })
      return true
    }
  }

  const handleRemoteInput = (input: RemoteInput): Promise<void> => {
    process.stderr.write(`[kestra-sync] DIAG input=${JSON.stringify(input)}\n`)
    // 受理即登记 RUNNING 占位（同步，不经 chain 排队）：同一条 SSE 连接内事件有序，
    // input 事件先于后续 session.messages 查询到达，占位保证执行期间 phase/用户消息
    // 回显即可见（终态 record 按末位 prompt 去重，不会重复追加用户消息）。
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- keep the undefined guard as a caller-contract backstop
    if (input.sessionId !== undefined && input.sessionId !== '') {
      index.record({ sessionId: input.sessionId, phase: 'RUNNING', prompt: input.text })
    }
    chain.p = chain.p
      .then(() => {
        applyEnvOverrideOnce()
        // 方案 A（统一执行面，2026-09-24 完全退役 headless 保底）：手机 relay 输入
        // 一律走 PC web 进程内 live agent——会话实体=手机 sessionId（PC UI 可见、
        // live agent 保持续上下文、权威标题回填；追问 resume 同一实体）。不再有
        // headless 子进程回退：live agent 不可用/创建失败即执行失败（记录 failed 终态）。
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- defensive fallback if a caller omits sessionId
        void executeOnLiveAgent(input, input.sessionId ?? randomUUID(), {
          isNewSession: input.newSession === true,
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        })
      })
      .catch(() => {})
    return chain.p
  }

  // 本地会话索引（选项 B 查询面）：应答中台转发的 session.query（列表/详情）。
  // 会话数据权威在 PC 本地；快照持久化（~/.dsh/kestra-session-index.json）保证
  // PC 重启后会话仍可被手机端查到（live 会话另经恢复通告重建，幂等）。
  const workspaceForSession = (sessionId: string): { workspaceId: string; title: string } | undefined => {
    const workspace = workspaceRegistry.list().find(item => item.sessionIds.some(id => id === sessionId))
    return workspace === undefined ? undefined : { workspaceId: workspace.id, title: workspace.title }
  }
  ctx.on('session/created', (session) => { index.upsert(session, workspaceForSession(String(session.id))) })
  ctx.on('session/event', (session) => { index.upsert(session, workspaceForSession(String(session.id))) })
  // 退出兜底：进程正常退出前强制落盘（防抖周期最多丢 2s 内事件，正常退出不丢）。
  process.once('exit', () => { index.dispose() })

  // 查询应答：session.list → 索引列表（时间线增量）；session.detail → 索引详情（未命中回填 error）。
  const handleQuery = (query: RelayQuery): Promise<void> => {
    process.stderr.write(`[kestra-sync] query received: ${query.type} rid=${query.requestId}${query.sessionId ? ` sid=${query.sessionId}` : ''}${query.since ? ` since=${query.since}` : ''}\n`)
    if (query.type === 'session.detail' && query.sessionId !== undefined) {
      const detail = index.get(query.sessionId)
      return detail === undefined
        ? client.fillQueryResult(query.requestId, query.type, undefined, 'session not found on PC')
        : client.fillQueryResult(query.requestId, query.type, detail)
    }
    if (query.type === 'session.messages' && query.sessionId !== undefined) {
      const messages = index.messages(query.sessionId, query.afterSeq ?? 0)
      return messages === undefined
        ? client.fillQueryResult(query.requestId, query.type, undefined, 'session not found on PC')
        : client.fillQueryResult(query.requestId, query.type, messages)
    }
    if (query.type === 'workspace.list') {
      const workspaces = workspaceRegistry.list().map((workspace, position) => ({
        workspaceId: workspace.id,
        title: workspace.title,
        recent: position === 0,
        sessionCount: workspace.sessionIds.length,
      }))
      return client.fillQueryResult(query.requestId, query.type, workspaces)
    }
    return client.fillQueryResult(query.requestId, query.type, index.list(query.since))
  }

  if (config.useSse !== false) {
    client.startInputSse(
      handleRemoteInput,
      sub => process.stderr.write(`[kestra-sync] PC online via SSE as ${sub} — remote inputs will be executed here\n`),
      { queryHandler: handleQuery },
    )
  } else {
    process.stderr.write('[kestra-sync] useSse=false：PC 不接入中台（轮询降级已随 A 组件退役）\n')
  }
  return client
}

/**
 * 已挂载的 client 句柄；web-identity 模式下 webIdentity 注入异步就绪，
 * 同步返回时 client 尚未创建——如实返回 undefined（cordis 不消费 apply 返回值）。
 */
export function apply(ctx: Context, config: Config): KestraSessionSyncClient | undefined {
  if (config.auth === 'web-identity') {
    // webIdentity 由 client-connection 在 OIDC 模式下提供；注入就绪后挂载。
    let started: KestraSessionSyncClient | undefined
    ctx.inject(['webIdentity'], (identityCtx) => {
      const client = new KestraSessionSyncClient(config, fetch, Date.now, identityCtx.webIdentity)
      started = mountClient(identityCtx, config, client)
    })
    return started
  }
  return mountClient(ctx, config, new KestraSessionSyncClient(config))
}
