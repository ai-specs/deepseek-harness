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

  constructor(
    private readonly config: KestraSyncConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (config.token === undefined && (config.clientId === undefined || config.clientSecret === undefined)) {
      throw new Error('kestra-sync: either token or clientId+clientSecret is required')
    }
    this.queuePath = config.queuePath ?? join(homedir(), '.dsh', 'sync-queue.jsonl')
    this.loadQueueFromDisk()
    // 批量定时器惰性启动：首次 enqueue 才出现
  }

  /** The effective Bearer token: the configured one, or a cached client_credentials token. */
  private async bearerToken(forceRefresh = false): Promise<string> {
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
