/**
 * dsh-kestra-sync — Cordis plugin that keeps Kestra up to date with local dsh
 * session state (dsh.docx: 会话存储/观察中心/安全审批 live on the Kestra side).
 * @module @deepseek-ai/dsh-plugin-kestra-sync
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// 事件负载（session/created、session/event）的 cordis Events 增补来自该包的 ambient 声明。
import type {} from '@deepseek-ai/dsh-session'
import {
  KestraSessionSyncClient,
  SessionMirror,
  decideInputTarget,
  type KestraSyncConfig,
  type RemoteInput,
  type SessionSnapshot,
} from './core.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The web profile's retained user identity (provided by client-connection in oidc mode). */
    webIdentity: import('./core.ts').WebIdentityHandle
  }
}

export const name = 'kestra-sync'
export const inject: string[] = []

export interface Config extends KestraSyncConfig {
  /** 批量队列磁盘持久化路径（默认 ~/.dsh/sync-queue.jsonl） */
  queuePath?: string
  /** 手机输入接力执行的超时秒数（默认 300）。 */
  remoteInputTimeoutSeconds?: number
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
  pollRemoteInputs: z.boolean(),
  pollIntervalMs: z.number(),
  tenant: z.string(),
  mode: z.union(['realtime', 'batch']),
  batchIntervalMs: z.number(),
  timeoutMs: z.number(),
  queuePath: z.string(),
  remoteInputTimeoutSeconds: z.number(),
})

export type * from './core.ts'
export type * from './pkce.ts'
export { KestraSessionSyncClient, buildSyncRequest, buildTokenRequest, decideInputTarget } from './core.ts'
export { PkceTokenProvider, codeChallenge, buildAuthorizeUrl } from './pkce.ts'

export type { SessionSnapshot, RemoteInput }

/** Absolute file URL of a sibling integration package's entry (built lib, else workspace source). */
function siblingModuleUrl(packageName: string): string {
  // Walk up from this file so the lookup works whether running from src/, bin/ or the built lib/.
  let dir = fileURLToPath(new URL('.', import.meta.url))
  for (; ;) {
    const candidate = join(dir, packageName)
    const built = join(candidate, 'lib', 'index.js')
    if (existsSync(built)) return pathToFileURL(built).href
    const source = join(candidate, 'src', 'index.ts')
    if (existsSync(source)) return pathToFileURL(source).href
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`plugin-kestra-sync: sibling package '${packageName}' not found from ${import.meta.url}`)
}

/** Walk up from a directory to the dsh workspace root that carries apps/cli. */
function workspaceRoot(startDir: string): string | undefined {
  let dir = resolve(startDir)
  for (;; dir = dirname(dir)) {
    if (existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
  }
}

/**
 * 异步跑子进程并回收输出（spawnSync 的非阻塞替代）：超时先 SIGTERM、5s 后升级
 * SIGKILL；超时/派生失败时 status=null 并带 error，由调用方按原 spawnSync 语义
 * 归一退出码（spawnSync 的 timeout 同样给 status=null + error）。
 */
function runChild(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string; error: Error | undefined }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    }, options.timeoutMs)
    const finish = (status: number | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolve({ status, stdout, stderr, error })
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', err => finish(null, err))
    child.on('close', code => finish(timedOut ? null : code, timedOut ? new Error('ETIMEDOUT') : undefined))
  })
}

/**
 * Relay overlay 的模型取值（裁定版风险 #2 收口）：env 显式覆盖 > PC 当前默认选择
 * （agentDefaultModel.currentSelection()，含 settings user layer）> 历史默认。
 * 生成时写死具体值后，子进程 overlay base == PC 解析值——user layer 覆盖不再造成
 * 「PC 接力用旧值 / Kestra 执行面用 env 值」的两端分叉。
 */
export function resolveRelayModel(
  env: { DSH_PROVIDER?: string | undefined; DSH_MODEL?: string | undefined },
  selection?: { provider: string; model: string } | undefined,
): { provider: string; model: string } {
  return {
    provider: env.DSH_PROVIDER ?? selection?.provider ?? 'deepseek-official',
    model: env.DSH_MODEL ?? selection?.model ?? 'deepseek-v4-flash',
  }
}

/**
 * Run one remote input as a headless dsh child (dsh.docx: 会话执行权在 dsh(PC)——
 * 手机输入被 PC 消费后由 PC 接力执行). Session phases are pushed around the child:
 * RUNNING on spawn, COMPLETED/FAILED with the final answer on exit. A terminal
 * parent session forks a new session (state machine has no terminal→running edge).
 */
async function executeRemoteInput(
  client: KestraSessionSyncClient,
  input: RemoteInput,
  options: { timeoutSeconds: number; selection?: (() => { provider: string; model: string } | undefined) | undefined },
): Promise<void> {
  const sessions = await client.listOwnedSessions(50).catch(() => [] as Array<Record<string, unknown>>)
  const parent = sessions.find(s => String(s.sessionId ?? '') === input.sessionId)
  const target = decideInputTarget({
    sessionId: input.sessionId,
    phase: String(parent?.phase ?? 'RUNNING'),
  })
  const sessionId = target.kind === 'fork' ? target.newSessionId : input.sessionId

  const state: Record<string, unknown> = {
    prompt: input.text,
    source: 'dsh-ui-remote-input',
    remoteInputAt: input.at,
    timeline: { running: new Date().toISOString() },
  }
  if (target.kind === 'fork') {
    state.parentSessionId = input.sessionId
    state.forkedFrom = 'COMPLETED/FAILED 会话的手机端输入派生新会话'
  }

  // Create / resume the row with the caller's user identity (owner = token sub)
  await client.push({
    sessionId,
    phase: 'running',
    state: JSON.stringify(state),
    userId: client.currentSub(),
  })

  // Generated overlay: model config + kestra-run observer for the result contract.
  // Deliberately WITHOUT kestra-sync — the parent (this plugin) owns Kestra pushes,
  // so the child cannot recurse into input polling. 模型为生成时写死的具体值
  // （见 resolveRelayModel），不再用 env 表达式——避免子进程 settings user layer
  // 压过 overlay base 造成两端模型分叉。
  const { provider, model } = resolveRelayModel(process.env, options.selection?.())
  process.stderr.write(`[kestra-sync] remote input model=${provider}/${model}\n`)
  const overlay = [
    '# Generated by plugin-kestra-sync remote-input handler.',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    '',
    '- insert:',
    '    - id: kestra-run',
    `      name: '${siblingModuleUrl('plugin-kestra-run')}'`,
    '      config:',
    '        resultFile: !!js process.env.DSH_OUTPUT_FILE',
    '        timeoutSeconds: !!js Number(process.env.DSH_TIMEOUT) || 0',
    '',
  ].join('\n')

  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-remote-input-'))
  const overlayPath = join(tempDir, 'dsh-remote.overlay.yml')
  const resultFile = join(tempDir, 'result.json')
  writeFileSync(overlayPath, overlay)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_PROMPT: input.text,
    DSH_OUTPUT_FILE: resultFile,
    DSH_TIMEOUT: String(options.timeoutSeconds * 1000),
  }

  const startedAt = Date.now()
  try {
    const root = workspaceRoot(fileURLToPath(new URL('..', import.meta.url)))
    let exitCode: number
    if (root !== undefined) {
      const result = await runChild(process.execPath,
        ['--import', 'tsx/esm', join(root, 'apps', 'cli', 'src', 'bin.ts'),
          '--profile', 'headless', '--patch', overlayPath, input.text],
        { env, timeoutMs: options.timeoutSeconds * 1000 + 30_000 })
      exitCode = result.status ?? (result.error ? 1 : 0)
      if (result.status !== 0) {
        // 子进程失败要留痕：错误输出进 daemon/插件日志，手机端也能看到 FAILED 会话
        process.stderr.write(`[kestra-sync] remote input run exit=${result.status}: `
          + `${(result.stderr ?? '').slice(-600)}${(result.stdout ?? '').slice(-200)}\n`)
      }
      if (result.error) process.stderr.write(`[kestra-sync] remote input run error: ${String(result.error)}\n`)
    } else {
      const result = await runChild('dsh', ['--profile', 'headless', '--patch', overlayPath, input.text],
        { env, timeoutMs: options.timeoutSeconds * 1000 + 30_000 })
      exitCode = result.status ?? 1
    }

    let answer = ''
    try {
      const parsed = JSON.parse(readFileSync(resultFile, 'utf8')) as { result?: string; answer?: string }
      answer = parsed.result ?? parsed.answer ?? ''
    } catch { /* 无结果文件（超时/崩溃）—— 状态照常落地，供手机端可见 */ }

    const finalState = {
      ...state,
      result: answer,
      durationMs: Date.now() - startedAt,
      exitCode,
      timeline: { ...((state.timeline as Record<string, string>) ?? {}), completed: new Date().toISOString() },
    }
    await client.push({
      sessionId,
      phase: exitCode === 0 ? 'completed' : 'failed',
      state: JSON.stringify(finalState),
      userId: client.currentSub(),
    })
    process.stderr.write(`[kestra-sync] remote input executed: session=${sessionId} exit=${exitCode}\n`)
  } catch (e) {
    // 兜底：执行器本身抛错也要把会话从 RUNNING 落到 FAILED，手机端才不会永远执行中
    const failedTimeline = {
      ...((state.timeline as Record<string, string>) ?? {}),
      failed: new Date().toISOString(),
    }
    await client.push({
      sessionId,
      phase: 'failed',
      state: JSON.stringify({ ...state, error: String(e), timeline: failedTimeline }),
      userId: client.currentSub(),
    }).catch(() => {})
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

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
  // 按调用时同步解析（与 headless/webhook 消费同姿势）；服务不可见时回落
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
      ...cur.reasoningEffort === undefined ? {} : { reasoningEffort: String(cur.reasoningEffort) },
    }
    if (next.provider !== cur.provider || next.model !== cur.model) {
      void svc.saveSelection(next)
        .then(() => process.stderr.write(`[kestra-sync] DSH_MODEL/DSH_PROVIDER override saved as default model: ${next.provider}/${next.model}\n`))
        .catch((e: unknown) => process.stderr.write(`[kestra-sync] DSH_MODEL override save failed: ${String(e)}\n`))
    } else {
      process.stderr.write(`[kestra-sync] DSH_MODEL already default model: ${cur.provider}/${cur.model}\n`)
    }
  }

  const selection = (): { provider: string; model: string } | undefined => {
    const cur = getModelService()?.currentSelection()
    return cur === undefined ? undefined : { provider: cur.provider, model: cur.model }
  }

  if (config.pollRemoteInputs) {
    // 子进程 spawn 化后事件循环不再被冻结，多个轮询 tick 可能并发到达——
    // 链式 promise 保住「同一时刻至多一个 headless 子进程」的原有语义；
    // 每链吞错防断裂（执行器早期异常原本由轮询器静默兜住）。
    let chain: Promise<void> = Promise.resolve()
    client.startInputPoller(
      (input) => {
        chain = chain
          .then(() => {
            applyEnvOverrideOnce()
            return executeRemoteInput(client, input, {
              timeoutSeconds: config.remoteInputTimeoutSeconds ?? 300,
              selection,
            })
          })
          .catch(() => {})
        return chain
      },
      sub => process.stderr.write(`[kestra-sync] PC online as ${sub} — remote inputs will be executed here\n`),
    )
  }
  return client
}

/**
 * web-identity 模式与 daemon 互斥提醒：daemon 的 PKCE 缓存若属同一用户，
 * 两条 refresh 链会因轮换吊销互相打断（实测）。缓存文件存在即提示——跨进程
 * 无法可靠判定存活，宁可误报也不静默双跑。
 */
function warnDaemonConflict(): void {
  const daemonCache = join(homedir(), '.dsh', 'oidc-pkce-token.json')
  if (!existsSync(daemonCache)) return
  let sub = ''
  try {
    sub = String((JSON.parse(readFileSync(daemonCache, 'utf8')) as { sub?: string }).sub ?? '')
  } catch { /* 缓存损坏按未知处理 */ }
  process.stderr.write(`[kestra-sync] WARNING: dsh-kestra-daemon cache present${sub ? ` (sub=${sub})` : ''} — running both revokes each other's refresh tokens; stop the daemon for this user
`)
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
      warnDaemonConflict()
      const client = new KestraSessionSyncClient(config, fetch, Date.now, identityCtx.webIdentity)
      started = mountClient(identityCtx, config, client)
      mountSessionMirror(identityCtx, client)
    })
    return started
  }
  return mountClient(ctx, config, new KestraSessionSyncClient(config))
}

/** A10 ①：本地会话镜像 —— PC 端创建的会话推 Kestra dsh_session（手机端同 sub 可见）。 */
function mountSessionMirror(ctx: Context, client: KestraSessionSyncClient): void {
  const mirror = new SessionMirror(client)
  ctx.on('session/created', (session) => { mirror.onCreated(session) })
  ctx.on('session/event', (session, event) => { mirror.onEvent(session, event) })
}

export { executeRemoteInput }
