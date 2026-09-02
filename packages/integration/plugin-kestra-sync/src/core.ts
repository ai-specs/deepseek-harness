/**
 * Kestra session-sync client (dsh.docx: dsh(PC) ←会话同步→ Kestra).
 *
 * dsh(PC) has no public IP and never accepts inbound connections — this client
 * only makes outbound HTTP calls to the Kestra API, pushing session snapshots
 * at session start, after each subtask, at high-risk decision points, and at
 * session end.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

import { PkceTokenProvider, type PkceConfig } from './pkce.ts'

export interface KestraSyncConfig {
  /** Kestra API base URL, e.g. http://kestra.internal:8080 */
  baseUrl: string
  /** 批量队列磁盘持久化路径（默认 ~/.dsh/sync-queue.jsonl），重启后待同步快照不丢 */
  queuePath?: string
  /**
   * Bearer token for the dsh APIs — an access token issued by the Kestra OIDC
   * provider. Optional when clientId/clientSecret are given: the client then
   * fetches and refreshes one itself (client_credentials grant).
   */
  token?: string
  /** OIDC client for the client_credentials grant (the seeded `dsh` client). */
  clientId?: string
  clientSecret?: string
  /**
   * 取票方式（默认按提供的凭据自动判定）：client_credentials=服务身份（AIAgent/脚本），
   * pkce=用户身份（Authorization Code + PKCE(S256)，会话归属该用户 OIDC sub ——
   * dsh.docx：用户接入端一律 PKCE，客户端不持 client_secret）。
   */
  auth?: 'client_credentials' | 'pkce'
  /** PKCE 登录参数（auth='pkce' 时必填）。 */
  pkce?: PkceConfig
  /**
   * 消费手机端待处理输入（dsh.docx PC 离线行为）：轮询本用户名下会话的
   * pending_input，原子消费后交给 handler 执行。开启后 PC 在线即接力处理手机输入。
   */
  pollRemoteInputs?: boolean
  /** 输入轮询间隔毫秒（默认 5000）。 */
  pollIntervalMs?: number
  /** Tenant used for the API path (Kestra 2.x multi-tenancy) */
  tenant?: string
  /** realtime pushes immediately; batch coalesces snapshots per interval */
  mode?: 'realtime' | 'batch'
  /** Batch flush interval in milliseconds (mode=batch). Default 2000. */
  batchIntervalMs?: number
  /** Push timeout in milliseconds. Default 5000 (P99 target 500ms is per tool call). */
  timeoutMs?: number
}

export type SessionPhase = 'running' | 'pending_approval' | 'completed' | 'failed'

export interface SessionSnapshot {
  sessionId: string
  phase: SessionPhase
  /** 结构化状态（JSON 字符串）—— Kestra 端原样入库（dsh-ui 详情页展示 prompt/结果/时间线） */
  state?: string
  /** 元数据（JSON 字符串） */
  metadata?: string
  /** 展示用用户 id（归属 owner 由服务端按 token sub 强制绑定，此字段不参与鉴权） */
  userId?: string
  /** Short digest of the message history */
  historySummary?: string
  /** Tool invocations since the last snapshot */
  toolCalls?: Array<{ name: string; ok: boolean; latencyMs: number }>
  tokenUsage?: { prompt: number; completion: number; total: number }
  elapsedMs?: number
  /** High-risk decision point metadata when phase is pending_approval */
  approval?: { approvalType: string; payloadSummary?: string }
  at?: string
}

export interface PushResult {
  ok: boolean
  status: number
  sessionId: string
  phase: SessionPhase
}

/** 手机端待处理输入（原子消费后的结果）。 */
export interface RemoteInput {
  sessionId: string
  text: string
  at?: string
}

/** 纯函数：待处理输入的消费决策 —— 终态会话重新派生新会话，进行中则原地接力。 */
export function decideInputTarget(session: { sessionId: string; phase: string; pendingInput?: string | null }):
  { kind: 'resume'; sessionId: string } | { kind: 'fork'; sessionId: string; newSessionId: string } {
  if (session.phase === 'COMPLETED' || session.phase === 'FAILED') {
    return { kind: 'fork', sessionId: session.sessionId, newSessionId: randomUUID() }
  }
  return { kind: 'resume', sessionId: session.sessionId }
}

/** Builds the outbound request for a snapshot — pure, unit-testable. */
export function buildSyncRequest(
  config: KestraSyncConfig,
  snapshot: SessionSnapshot,
  token = config.token ?? '',
): { url: string; init: RequestInit } {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/v1/dsh/sessions/${encodeURIComponent(snapshot.sessionId)}`
  const body = { ...snapshot, at: snapshot.at ?? new Date().toISOString() }
  return {
    url,
    init: {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    },
  }
}

/** Builds the client_credentials token request against the same OIDC provider — pure, unit-testable. */
export function buildTokenRequest(config: KestraSyncConfig): { url: string; init: RequestInit } {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/oidc/token`
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    },
  }
}

/** Coalescing + flushing sync queue with bounded retry. */
export class KestraSessionSyncClient {
  private readonly queue: SessionSnapshot[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight = false
  private inputTimer: ReturnType<typeof setInterval> | undefined

  private readonly queuePath: string

  /** Cached client_credentials token; refreshed 60s before expiry. */
  private cachedToken: { value: string; expiresAt: number } | undefined

  /** PKCE 用户身份提供者（auth='pkce' 时创建）。 */
  private readonly pkce: PkceTokenProvider | undefined

  constructor(
    private readonly config: KestraSyncConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const explicit = config.auth
    if (explicit === 'pkce') {
      if (!config.pkce) throw new Error('kestra-sync: auth=pkce requires the pkce config block')
      this.pkce = new PkceTokenProvider({ ...config.pkce, fetchImpl, now })
    } else if (explicit === undefined && config.token === undefined && config.clientId === undefined && config.pkce) {
      // 只给了 pkce 块 —— 隐含用户身份模式
      this.pkce = new PkceTokenProvider({ ...config.pkce, fetchImpl, now })
    } else if (config.token === undefined && (config.clientId === undefined || config.clientSecret === undefined)) {
      throw new Error('kestra-sync: either token, clientId+clientSecret, or the pkce block is required')
    }
    this.queuePath = config.queuePath ?? join(homedir(), '.dsh', 'sync-queue.jsonl')
    this.loadQueueFromDisk()
    // 批量定时器惰性启动：首次 enqueue 才出现
  }

  /** The effective Bearer token: the configured one, PKCE user identity, or a cached client_credentials token. */
  private async bearerToken(forceRefresh = false): Promise<string> {
    if (this.pkce) return this.pkce.getToken(forceRefresh)
    if (this.config.token !== undefined) return this.config.token
    if (!forceRefresh
      && this.cachedToken !== undefined
      && this.cachedToken.expiresAt > this.now() + 60_000) {
      return this.cachedToken.value
    }
    const { url, init } = buildTokenRequest(this.config)
    const response = await this.fetchImpl(url, init)
    if (!response.ok) {
      throw new Error(`kestra-sync: token fetch failed (${String(response.status)})`)
    }
    const payload = await response.json() as { access_token: string; expires_in?: number }
    const ttlMs = (payload.expires_in ?? 3600) * 1000
    this.cachedToken = { value: payload.access_token, expiresAt: this.now() + ttlMs }
    return this.cachedToken.value
  }

  /** 当前登录用户（PKCE 模式返回 IdP sub；服务身份返回 client id）。 */
  currentSub(): string {
    return this.pkce?.currentSub() ?? this.config.clientId ?? ''
  }

  // ---------------------------------------------------------------- remote inputs

  /** 列出本用户名下会话（Kestra 端按 token sub 过滤 —— 跨用户隔离由服务端保证）。 */
  async listOwnedSessions(limit = 50): Promise<Array<Record<string, unknown>>> {
    const token = await this.bearerToken()
    const response = await this.fetchImpl(
      `${this.config.baseUrl.replace(/\/+$/, '')}/api/v1/dsh/sessions?limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000) },
    )
    if (!response.ok) throw new Error(`list sessions failed (${response.status})`)
    return (await response.json()) as Array<Record<string, unknown>>
  }

  /** 原子消费一条待处理输入（服务端 UPDATE..RETURNING，并发安全）。 */
  async consumePendingInput(sessionId: string): Promise<RemoteInput | undefined> {
    const token = await this.bearerToken()
    const response = await this.fetchImpl(
      `${this.config.baseUrl.replace(/\/+$/, '')}/api/v1/dsh/sessions/${encodeURIComponent(sessionId)}/input/consume`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000) },
    )
    if (!response.ok) return undefined
    const payload = (await response.json()) as { text?: string | null; at?: string }
    if (!payload.text) return undefined
    return payload.at === undefined
      ? { sessionId, text: payload.text }
      : { sessionId, text: payload.text, at: payload.at }
  }

  /**
   * 轮询一次：找所有带 pending_input 的会话并逐条原子消费。
   * 返回消费到的输入（调用方决定如何执行 —— 默认由插件 spawn headless dsh 接力）。
   */
  async pollRemoteInputsOnce(): Promise<RemoteInput[]> {
    const sessions = await this.listOwnedSessions()
    const consumed: RemoteInput[] = []
    for (const session of sessions) {
      if (!session.pendingInput) continue
      const sessionId = String(session.sessionId ?? '')
      const input = await this.consumePendingInput(sessionId)
      if (input) consumed.push(input)
    }
    return consumed
  }

  /**
   * 启动待处理输入轮询（dsh.docx：PC 掉线期间手机输入保持待处理，上线后接力执行）。
   * 返回停止函数。消费失败（网络/未登录）静默，下个周期重试。
   */
  startInputPoller(handler: (input: RemoteInput) => void | Promise<void>, onFirstLogin?: (sub: string) => void): () => void {
    if (this.inputTimer !== undefined) return () => this.stopInputPoller()
    this.inputTimer = setInterval(() => {
      void (async () => {
        try {
          const inputs = await this.pollRemoteInputsOnce()
          if (onFirstLogin) {
            const sub = this.currentSub()
            if (sub) (onFirstLogin as (s: string) => void)(sub)
          }
          for (const input of inputs) await handler(input)
        } catch {
          // 未登录（无缓存票）时 PKCE getToken 会尝试弹浏览器 —— 每个周期只尝试一次并静默失败，
          // 避免轮询风暴；用户完成登录后自然恢复。
        }
      })()
    }, this.config.pollIntervalMs ?? 5000)
    return () => this.stopInputPoller()
  }

  private stopInputPoller(): void {
    if (this.inputTimer !== undefined) {
      clearInterval(this.inputTimer)
      this.inputTimer = undefined
    }
  }

  /** 队列磁盘持久化：每次变更后全量重写（JSONL，每行一个快照）。 */
  private persistQueue(): void {
    try {
      if (this.queue.length === 0) {
        writeFileSync(this.queuePath, '')
        return
      }
      writeFileSync(this.queuePath, this.queue.map(s => JSON.stringify(s)).join('\n') + '\n')
    } catch {
      // 磁盘写入失败不阻塞同步主流程；内存队列仍是权威副本
    }
  }

  private loadQueueFromDisk(): void {
    try {
      if (!existsSync(this.queuePath)) return
      const lines = readFileSync(this.queuePath, 'utf8').split('\n').filter(l => l.trim())
      for (const line of lines) {
        try { this.queue.push(JSON.parse(line) as SessionSnapshot) } catch { /* 跳过损坏行 */ }
      }
      if (this.queue.length > 0) console.warn(`[kestra-sync] recovered ${this.queue.length} pending snapshot(s) from disk`)
    } catch {
      // 读取失败按空队列处理
    }
  }

  /** Push immediately (realtime mode) or enqueue for the next batch flush. */
  async push(snapshot: SessionSnapshot): Promise<PushResult | undefined> {
    const enriched = { ...snapshot, at: new Date(this.now()).toISOString() }
    if ((this.config.mode ?? 'realtime') === 'batch') {
      if (this.queue.length >= 1000) {
        this.queue.shift()
        console.warn('[kestra-sync] queue overflow (>1000), dropped the oldest snapshot')
      }
      this.queue.push(enriched)
      this.persistQueue()
      if (this.timer === undefined) {
        this.timer = setInterval(() => void this.flush(), this.config.batchIntervalMs ?? 2000)
      }
      return undefined
    }
    return this.send(enriched)
  }

  /** Drain the batch queue, newest snapshot per session wins. */
  async flush(): Promise<PushResult[]> {
    if (this.inFlight || this.queue.length === 0) return []
    this.inFlight = true
    const batch = this.queue.splice(0)
    const results: PushResult[] = []
    try {
      for (const snapshot of batch) results.push(await this.send(snapshot))
    } finally {
      this.inFlight = false
      this.persistQueue() // 成功推送的已移除；失败重入队的保留在磁盘
    }
    return results
  }

  private async send(snapshot: SessionSnapshot, attempt = 1): Promise<PushResult> {
    let token: string
    try {
      token = await this.bearerToken(attempt > 1)
    } catch {
      if ((this.config.mode ?? 'realtime') === 'batch' && this.queue.length < 1000) {
        this.queue.push(snapshot)
        this.persistQueue()
      }
      return { ok: false, status: 0, sessionId: snapshot.sessionId, phase: snapshot.phase }
    }
    const { url, init } = buildSyncRequest(this.config, snapshot, token)
    try {
      const response = await this.fetchImpl(url, init)
      // 过期/撤销的 client_credentials token：强制刷新后重试一次
      if (response.status === 401 && this.config.token === undefined && attempt < 2) {
        return this.send(snapshot, attempt + 1)
      }
      return { ok: response.ok, status: response.status, sessionId: snapshot.sessionId, phase: snapshot.phase }
    } catch {
      // dsh 是主动外连侧：传输失败不阻塞 Agent。batch 模式下重新入队
      // （有界 1000 条，Kestra 恢复后由下次 flush 补推）；realtime 模式做一次退避重试。
      if (attempt < 2) return this.send(snapshot, attempt + 1)
      if ((this.config.mode ?? 'realtime') === 'batch' && this.queue.length < 1000) {
        this.queue.push(snapshot)
        this.persistQueue()
      }
      return { ok: false, status: 0, sessionId: snapshot.sessionId, phase: snapshot.phase }
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.stopInputPoller()
  }
}
