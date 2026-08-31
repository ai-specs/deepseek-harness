/**
 * Kestra session-sync client (dsh.docx: dsh(PC) ←会话同步→ Kestra).
 *
 * dsh(PC) has no public IP and never accepts inbound connections — this client
 * only makes outbound HTTP calls to the Kestra API, pushing session snapshots
 * at session start, after each subtask, at high-risk decision points, and at
 * session end.
 */

export interface KestraSyncConfig {
  /** Kestra API base URL, e.g. http://kestra.internal:8080 */
  baseUrl: string
  /** Bearer token for the Kestra API gateway */
  token: string
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
): { url: string; init: RequestInit } {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/v1/dsh/sessions/${encodeURIComponent(snapshot.sessionId)}`
  const body = { ...snapshot, at: snapshot.at ?? new Date().toISOString() }
  return {
    url,
    init: {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    },
  }
}

/** Coalescing + flushing sync queue with bounded retry. */
export class KestraSessionSyncClient {
  private readonly queue: SessionSnapshot[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight = false

  constructor(
    private readonly config: KestraSyncConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    // 批量定时器惰性启动：首次 enqueue 才出现（dispose 由调用方显式调用）
  }

  /** Push immediately (realtime mode) or enqueue for the next batch flush. */
  async push(snapshot: SessionSnapshot): Promise<PushResult | undefined> {
    const enriched = { ...snapshot, at: new Date(this.now()).toISOString() }
    if ((this.config.mode ?? 'realtime') === 'batch') {
      this.queue.push(enriched)
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
    }
    return results
  }

  private async send(snapshot: SessionSnapshot, attempt = 1): Promise<PushResult> {
    const { url, init } = buildSyncRequest(this.config, snapshot)
    try {
      const response = await this.fetchImpl(url, init)
      return { ok: response.ok, status: response.status, sessionId: snapshot.sessionId, phase: snapshot.phase }
    } catch {
      // dsh 是主动外连侧：传输失败不阻塞 Agent。batch 模式下重新入队
      // （有界 1000 条，Kestra 恢复后由下次 flush 补推）；realtime 模式做一次退避重试。
      if (attempt < 2) return this.send(snapshot, attempt + 1)
      if ((this.config.mode ?? 'realtime') === 'batch' && this.queue.length < 1000) {
        this.queue.push(snapshot)
      }
      return { ok: false, status: 0, sessionId: snapshot.sessionId, phase: snapshot.phase }
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
  }
}
