/**
 * Kestra session-sync client (dsh.docx: dsh(PC) ←会话同步→ Kestra).
 *
 * dsh(PC) has no public IP and never accepts inbound connections — this client
 * only makes outbound HTTP calls to the Kestra API, pushing session snapshots
 * at session start, after each subtask, at high-risk decision points, and at
 * session end.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

import { PkceTokenProvider, type PkceConfig } from './pkce.ts'

/** web 进程留存的用户身份（A10 ②）：结构化句柄，避免 integration 包反向依赖 client-connection。 */
export interface WebIdentityHandle {
  /** 可用 access token（自动续期）；未登录/链断时 undefined。 */
  ensureAccessToken(): Promise<string | undefined>
  /** 当前登录用户 OIDC sub；未加载/未登录时 undefined。 */
  currentSub(): string | undefined
}

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
   * dsh.docx：用户接入端一律 PKCE，客户端不持 client_secret）；
   * web-identity=web 进程留存身份（auth='web-identity' 时必填 webIdentity 句柄，
   * 令牌来自浏览器 OIDC 登录的留存与自动续期）。
   */
  auth?: 'client_credentials' | 'pkce' | 'web-identity'
  /** PKCE 登录参数（auth='pkce' 时必填）。 */
  pkce?: PkceConfig
  /** 本地会话索引快照路径（默认 ~/.dsh/kestra-session-index.json）。 */
  sessionIndexPath?: string
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

/** 手机端待处理输入（原子消费后的结果；SSE 链路 newSession 标记全新会话）。 */
export interface RemoteInput {
  sessionId: string
  text: string
  at?: string
  /** 选项 B：SSE 事件 newSession=true 表示手机端发起全新会话（直接派生新会话）。 */
  newSession?: boolean
}

/** §3.3 轻量指标事件（不含会话全文——纯聚合数字，字节级）。 */
export interface MetricEvent {
  type: 'session_start' | 'session_end' | 'tool_call' | 'approval_requested' | 'approval_resolved'
  sessionId: string
  outcome?: 'completed' | 'failed'
  durationMs?: number
  toolCalls?: number
  toolErrors?: number
  tool?: string
  success?: boolean
  latencyMs?: number
  approvalType?: string
  approved?: boolean
  resolutionMs?: number
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

  private readonly queuePath: string

  /** Cached client_credentials token; refreshed 60s before expiry. */
  private cachedToken: { value: string; expiresAt: number } | undefined

  /** PKCE 用户身份提供者（auth='pkce' 时创建）。 */
  private readonly pkce: PkceTokenProvider | undefined

  /** web 进程留存身份（auth='web-identity' 时由装配注入）。 */
  private readonly webIdentity: WebIdentityHandle | undefined

  constructor(
    private readonly config: KestraSyncConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    webIdentity?: WebIdentityHandle,
  ) {
    const explicit = config.auth
    if (explicit === 'web-identity') {
      if (!webIdentity) throw new Error('kestra-sync: auth=web-identity requires the webIdentity service')
      this.webIdentity = webIdentity
    } else if (explicit === 'pkce') {
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
    if (this.webIdentity) {
      const token = await this.webIdentity.ensureAccessToken()
      if (token === undefined) throw new Error('kestra-sync: web identity unavailable (not signed in)')
      return token
    }
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

  /** 当前登录用户（web-identity/PKCE 模式返回 IdP sub；服务身份返回 client id）。 */
  currentSub(): string {
    return this.webIdentity?.currentSub() ?? this.pkce?.currentSub() ?? this.config.clientId ?? ''
  }

  // ---------------------------------------------------------------- remote inputs

  // ---------------------------------------------------------------- option B: SSE + metrics

  private inputSseAbort: AbortController | undefined
  private inputSseReading = false

  /**
   * 选项 B 指令接收主链路：SSE 订阅中台 relay/events（GET /api/v1/dsh/relay/events），
   * 复用本客户端既有 token 缓存/刷新（web-identity 自动续期、PKCE、client_credentials）。
   *
   * 事件分发：`session.input` → handler（RemoteInput）；`session.approval.decision` →
   * options.approvalHandler。连接断开指数退避重连（1s 起 2 倍，封顶 30s；成功接收
   * 事件后重置）；401 时强制刷新 token 重试一次（S2 token 生命周期）。返回停止函数。
   */
  startInputSse(
    handler: (input: RemoteInput) => void | Promise<void>,
    onFirstLogin?: (sub: string) => void,
    options?: {
      approvalHandler?: (decision: { sessionId: string; approved: boolean; comment?: string }) => void | Promise<void>
      /** 会话查询（session.query）处理器：从中台转发的列表/详情请求应答。 */
      queryHandler?: (query: { requestId: string; type: string; sessionId?: string }) => void | Promise<void>
    },
  ): () => void {
    if (this.inputSseReading) return () => this.stopInputSse()
    this.inputSseReading = true
    const base = this.config.baseUrl.replace(/\/+$/, '')
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

    void (async () => {
      let backoffMs = 1_000
      let notified = false
      while (this.inputSseReading) {
        let controller = new AbortController()
        this.inputSseAbort = controller
        try {
          const token = await this.bearerToken()
          let response = await this.fetchImpl(
            `${base}/api/v1/dsh/relay/events`,
            { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal },
          )
          // S2：token 失效 → 走既有缓存刷新机制（web-identity/PKCE/client_credentials）强制刷新后重试一次
          if (response.status === 401) {
            const fresh = await this.bearerToken(true)
            controller = new AbortController()
            this.inputSseAbort = controller
            response = await this.fetchImpl(
              `${base}/api/v1/dsh/relay/events`,
              { headers: { Authorization: `Bearer ${fresh}`, Accept: 'text/event-stream' }, signal: controller.signal },
            )
          }
          if (!response.ok) throw new Error(`relay SSE HTTP ${String(response.status)}`)
          if (response.body === null) throw new Error('relay SSE body missing')
          if (onFirstLogin !== undefined && !notified) {
            const sub = this.currentSub()
            if (sub) {
              onFirstLogin(sub)
              notified = true
            }
          }
          backoffMs = 1_000 // 连接成功重置退避
          await this.readInputSse(response.body, handler, options?.approvalHandler, options?.queryHandler)
        } catch (error) {
          if (!this.inputSseReading) break
          process.stderr.write(`[kestra-sync] relay SSE disconnected: ${String(error instanceof Error ? error.message : error)} — reconnect in ${backoffMs}ms\n`)
          await sleep(backoffMs)
          backoffMs = Math.min(backoffMs * 2, 30_000)
        } finally {
          this.inputSseAbort = undefined
        }
      }
    })()

    return () => this.stopInputSse()
  }

  private stopInputSse(): void {
    this.inputSseReading = false
    this.inputSseAbort?.abort()
  }

  /** SSE 流解析（`\n\n` 分帧、`data:` 行 JSON），按 §5.3 事件表分发。 */
  private async readInputSse(
    body: ReadableStream<Uint8Array>,
    handler: (input: RemoteInput) => void | Promise<void>,
    approvalHandler?: (decision: { sessionId: string; approved: boolean; comment?: string }) => void | Promise<void>,
    queryHandler?: (query: { requestId: string; type: string; sessionId?: string }) => void | Promise<void>,
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // 空闲超时：SSE 长连接 TCP 半开（Kestra 端关连接但本端 fetch 流假活）时，
    // 流既不结束也不报错，read() 永远挂起 → 重连循环出不来。heartbeat 15s，
    // 45s（3 个心跳周期）无任何数据即主动 abort 触发重连。
    let lastDataAt = Date.now()
    const idleGuard = setInterval(() => {
      if (Date.now() - lastDataAt > 45_000) {
        this.inputSseAbort?.abort(new Error('relay SSE idle timeout: no data for 45s'))
      }
    }, 15_000)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        lastDataAt = Date.now()
        buffer += decoder.decode(value, { stream: true })
        let frameEnd: number
        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, frameEnd)
          buffer = buffer.slice(frameEnd + 2)
          const dataLine = frame.split('\n').find(line => line.startsWith('data:'))
          if (dataLine === undefined) continue
          const payload = dataLine.slice(5).trim()
          if (payload === '') continue
          try {
            const event = JSON.parse(payload) as { event?: string; id?: string; data?: Record<string, unknown> }
            const type = event.event ?? ''
            const data = event.data
            if (data === undefined) continue
            if (type === 'session.input') {
              await handler({
                sessionId: String(data.sessionId ?? ''),
                text: String(data.text ?? ''),
                newSession: data.newSession === true,
                at: new Date().toISOString(),
              })
            } else if (type === 'session.approval.decision') {
              await approvalHandler?.({
                sessionId: String(data.sessionId ?? ''),
                approved: data.approved === true,
                ...(data.comment === undefined ? {} : { comment: String(data.comment) }),
              })
            } else if (type === 'session.query') {
              await queryHandler?.({
                requestId: String(data.requestId ?? ''),
                type: String(data.type ?? ''),
                ...(data.sessionId === undefined || data.sessionId === null || String(data.sessionId) === ''
                  ? {}
                  : { sessionId: String(data.sessionId) }),
              })
            }
            // heartbeat / pc.status / session.result / session.approval：PC 订阅端不消费
          } catch {
            // 非 JSON 帧（注释/空帧）忽略
          }
        }
      }
    } finally {
      clearInterval(idleGuard)
      reader.releaseLock()
    }
  }

  /**
   * 会话查询结果回填（选项 B）：PC 应答中台转发的 session.query，POST 回
   * relay/query-result 缓存，Phone 轮询取走。失败静默（Phone 侧回落本地缓存）。
   */
  async fillQueryResult(requestId: string, type: string, payload: unknown, error?: string): Promise<void> {
    if (requestId === '' || requestId === undefined) return
    const token = await this.bearerToken().catch(() => undefined)
    if (token === undefined) return
    const body = { requestId, type, payload, ...(error === undefined ? {} : { error }) }
    try {
      await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/+$/, '')}/api/v1/dsh/relay/query-result`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
        },
      )
    } catch {
      // 回填失败静默：Phone 侧下轮查询/本地缓存兜底。
    }
  }

  /**
   * §3.3 指标事件上报 → POST /api/v1/dsh/metrics（复用现有 report 端点，写 dsh_metrics
   * 聚合表；不落会话全文）。本轮只实现 session_end 会话级聚合（tool_call/approval 级
   * 事件后续随 PC Agent 工具面接入）。上报失败不阻断主链路。
   */
  async reportMetric(metric: MetricEvent): Promise<void> {
    if (metric.type !== 'session_end') return
    const token = await this.bearerToken().catch(() => undefined)
    if (token === undefined) return
    const body = {
      sessionId: metric.sessionId,
      userId: this.currentSub(),
      taskCompletionRate: metric.outcome === 'completed' ? 1.0 : 0.0,
      toolErrorRate: (metric.toolCalls ?? 0) > 0 ? (metric.toolErrors ?? 0) / (metric.toolCalls ?? 1) : 0.0,
      p99LatencyMs: metric.durationMs ?? 0,
      tokenUsage: 0,
    }
    try {
      await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/+$/, '')}/api/v1/dsh/metrics`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
        },
      )
    } catch {
      // 指标上报失败不阻塞主链路（日志可观测由调用方补）
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
  }
}

// ---------------------------------------------------------------- session mirror

/** 结构化最小的本地会话视图（core Session 的镜像面；不反向依赖 @deepseek-ai/dsh-session）。 */
export interface MirrorSession {
  readonly id: string
  readonly header: { parentSession?: string }
  deriveMessages?(): ReadonlyArray<{ role: string; content: unknown }>
  /** 规范事件日志（created/恢复通告从末尾推导真实阶段用）。 */
  events?: ReadonlyArray<{ type: string; data?: unknown }>
  /** core Session 的真实事件读取面：Session 实例没有 `events` 属性，恢复通告从这里取已回放日志。 */
  snapshotEvents?(): ReadonlyArray<{ type: string; data?: unknown }>
}

/** 会话生命周期事件 → 同步阶段。`turn/end` 按 reason.kind 区分 FAILED/COMPLETED；其余事件不推送。 */
export function deriveSyncPhase(eventType: string, reasonKind?: string): SessionPhase | undefined {
  if (eventType === 'session/created' || eventType === 'turn/start') return 'running'
  if (eventType === 'turn/end') return reasonKind === 'error' ? 'failed' : 'completed'
  return undefined
}

/** 由消息列表折叠镜像 state：prompt=首条用户文本，result=末条助手文本（手机端列表摘要/详情页直接消费）。 */
export function foldSyncState(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): { prompt?: string; result?: string } {
  let prompt: string | undefined
  let result: string | undefined
  for (const message of messages) {
    const text = textBlocksOf(message.content)
    if (text === undefined) continue
    if (message.role === 'user' && prompt === undefined) prompt = text
    if (message.role === 'assistant') result = text
  }
  return {
    ...(prompt === undefined ? {} : { prompt }),
    ...(result === undefined ? {} : { result }),
  }
}

/** 拼接 content 的 text 块；无可见文本返回 undefined（工具调用/纯 reasoning 消息不产生摘要）。 */
function textBlocksOf(content: unknown): string | undefined {
  const blocks = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.map(block =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
          ? String((block as { text?: unknown }).text ?? '')
          : '')
      : []
  const text = blocks.join('').trim()
  return text === '' ? undefined : text
}

/** Kestra dsh_session.id 是 uuid 列（`?::uuid` 强校验）。本地 `session-<uuid>` 剥前缀上线；其余形态无法落库。 */
export function wireSessionId(localId: string): string | undefined {
  const bare = localId.startsWith('session-') ? localId.slice('session-'.length) : localId
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bare) ? bare : undefined
}

/** 从事件日志末尾推导会话当前阶段：最后一条 turn 边决定（恢复/进程重启后的 created 通告走这里）。 */
export function deriveSessionPhaseFromLog(
  events: ReadonlyArray<{ type: string; data?: unknown }>,
): SessionPhase {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/end') {
      const kind = (event.data as { reason?: { kind?: string } } | undefined)?.reason?.kind
      return deriveSyncPhase('turn/end', kind) ?? 'completed'
    }
    if (event.type === 'turn/start') return 'running'
  }
  return 'running'
}


/**
 * 本地会话索引（选项 B 查询面）：PC 端已见会话的内存索引，应答中台转发的
 * session.query（列表/详情）——会话数据权威在 PC 本地（边端权威），不落中台。
 * 观测入口为 session/created、session/event 事件（与既有观测一致），不推中台；
 * 重启后经恢复通告（session/created，日志已回放）重建索引。
 */
export class SessionIndex {
  private readonly sessions = new Map<string, IndexedSession>()
  private readonly filePath: string | undefined
  private dirty = false
  private flushTimer: ReturnType<typeof setInterval> | undefined

  /**
   * @param filePath 可选快照路径：传入则持久化（构造时 load，事件后防抖落盘，
   *   dispose 强制 flush）；不传则纯内存（单测/临时场景）。
   */
  constructor(filePath?: string) {
    this.filePath = filePath
    if (filePath === undefined) return
    this.load()
    // 防抖落盘：会话事件流密集时合并写；2s 间隔 + 退出时强制 flush。
    this.flushTimer = setInterval(() => this.flush(), 2000)
  }

  /** 启动恢复：从快照文件重建索引（PC 重启后 headless 派生会话仍可见）。 */
  private load(): void {
    try {
      const raw = readFileSync(this.filePath as string, 'utf8')
      const parsed = JSON.parse(raw) as Array<IndexedSession>
      if (!Array.isArray(parsed)) return
      for (const s of parsed) {
        if (s?.sessionId !== undefined && s?.phase !== undefined) {
          this.sessions.set(s.sessionId, s)
        }
      }
      process.stderr.write(`[kestra-sync] session index restored: ${this.sessions.size} sessions from ${this.filePath}\n`)
    } catch (err) {
      // 首次运行或快照损坏：静默空索引（web 会话仍经恢复通告重建）。
      process.stderr.write(`[kestra-sync] session index load skipped: ${String(err)}\n`)
    }
  }

  private scheduleFlush(): void {
    this.dirty = true
  }

  /** 落盘（原子：tmp + rename）。失败保留脏标记，下个周期重试。 */
  private flush(): void {
    if (!this.dirty || this.filePath === undefined) return
    this.dirty = false
    try {
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify([...this.sessions.values()]), 'utf8')
      renameSync(tmp, this.filePath)
    } catch (err) {
      process.stderr.write(`[kestra-sync] session index flush failed: ${String(err)}\n`)
      this.dirty = true
    }
  }

  /** 停止定时器并强制落盘（插件 dispose/进程退出路径）。 */
  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }
    this.flush()
  }

  /** 观测入口：会话创建/事件驱动，阶段按事件日志末尾推导。 */
  upsert(session: MirrorSession): void {
    if (session.header.parentSession !== undefined) return
    const sessionId = wireSessionId(session.id)
    if (sessionId === undefined) return
    const events = session.events ?? session.snapshotEvents?.() ?? []
    const phase = deriveSessionPhaseFromLog(events) ?? 'running'
    const state = { source: 'dsh-pc-web', ...foldSyncState(session.deriveMessages?.() ?? []) }
    const now = new Date().toISOString()
    const prev = this.sessions.get(sessionId)
    this.sessions.set(sessionId, {
      sessionId,
      phase,
      pendingInput: false,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      summary: String(state.prompt ?? '（无摘要）').slice(0, 90),
      state,
    })
    this.scheduleFlush()
  }

  /** 会话列表（按 updatedAt 倒序），供 session.list 应答。 */
  list(): Array<Record<string, unknown>> {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(s => ({ ...s }))
  }

  /** 会话详情，供 session.detail 应答。 */
  get(sessionId: string): Record<string, unknown> | undefined {
    const s = this.sessions.get(sessionId)
    return s === undefined ? undefined : { ...s }
  }

  /**
   * 记录 headless 执行结果（远程指令派生会话的事件在子进程内，web 观测不到，
   * 由 executeRemoteInput 终态回调写入本索引）。同 id 时以最新结果覆盖并保留既有 state。
   */
  record(info: { sessionId: string; phase: string; prompt: string; result?: string; parentSessionId?: string }): void {
    const now = new Date().toISOString()
    const prev = this.sessions.get(info.sessionId)
    this.sessions.set(info.sessionId, {
      sessionId: info.sessionId,
      phase: info.phase,
      pendingInput: false,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      summary: String(info.prompt ?? '（无摘要）').slice(0, 90),
      state: {
        source: 'dsh-pc-web',
        prompt: info.prompt,
        ...(info.result === undefined ? {} : { result: info.result }),
        ...(info.parentSessionId === undefined ? {} : { parentSessionId: info.parentSessionId }),
        ...(prev?.state ?? {}),
      },
    })
    this.scheduleFlush()
  }
}

interface IndexedSession {
  sessionId: string
  phase: string
  pendingInput: boolean
  createdAt: string
  updatedAt: string
  summary: string
  state: Record<string, unknown>
}
