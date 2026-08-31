/**
 * Local fault-tolerance engine (dsh.docx 第九章 高容错执行链路).
 *
 * Tool failures are captured here and never surfaced raw to the user:
 * exponential-backoff retry → fallback rule library → circuit breaker.
 */

export interface RetryConfig {
  maxAttempts: number          // 默认 4
  baseDelayMs: number          // 默认 1000 → 1s/2s/4s/8s
  multiplier: number           // 默认 2
  jitter: boolean
}

export interface FallbackRule {
  matchTool: string            // 正则
  response: string             // 安全默认答复
}

export interface CircuitBreakerConfig {
  failureThreshold: number     // 连续失败次数（默认 5）
  windowSeconds: number
  openSeconds: number          // 熔断开启时长，之后半开探测
}

export const DEFAULT_RETRY: RetryConfig = { maxAttempts: 4, baseDelayMs: 1000, multiplier: 2, jitter: false }
export const DEFAULT_CIRCUIT: CircuitBreakerConfig = { failureThreshold: 5, windowSeconds: 60, openSeconds: 30 }

export type BreakerState = 'closed' | 'open' | 'half_open'

/** 指数退避延迟：attempt 从 1 开始 → base * multiplier^(attempt-1)。 */
export function backoffDelayMs(retry: RetryConfig, attempt: number, rand: () => number = Math.random): number {
  const raw = retry.baseDelayMs * Math.pow(retry.multiplier, attempt - 1)
  return retry.jitter ? Math.round(raw * (0.5 + 0.5 * rand())) : raw
}

/** 兜底规则匹配：返回第一条命中的安全答复。 */
export function matchFallback(rules: FallbackRule[], toolName: string): string | undefined {
  return rules.find(rule => new RegExp(rule.matchTool).test(toolName))?.response
}

/** 熔断器：closed →（连续失败达阈值）open →（openSeconds 后）half_open → 成功 closed。 */
export class CircuitBreaker {
  private consecutiveFailures = 0
  private openedAt = 0
  state: BreakerState = 'closed'

  constructor(private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT, private readonly now: () => number = Date.now) {}

  allow(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.config.openSeconds * 1000) {
        this.state = 'half_open'
        return true
      }
      return false
    }
    return true // half_open 放行探测
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.state = 'closed'
  }

  recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.state === 'half_open' || this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = 'open'
      this.openedAt = this.now()
    }
  }
}

/** 容错执行引擎：重试 → 兜底 → 熔断，统一捕获底层错误。 */
export class FaultTolerance {
  private breaker: CircuitBreaker

  constructor(
    private readonly retry: RetryConfig = DEFAULT_RETRY,
    private readonly fallbacks: FallbackRule[] = [],
    circuit: CircuitBreakerConfig = DEFAULT_CIRCUIT,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  ) {
    this.breaker = new CircuitBreaker(circuit)
  }

  get breakerState(): BreakerState {
    return this.breaker.state
  }

  async execute<T>(toolName: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; fallback?: string }> {
    if (!this.breaker.allow()) return { ok: false, fallback: matchFallback(this.fallbacks, toolName) ?? 'circuit open' }
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        const value = await fn()
        this.breaker.recordSuccess()
        return { ok: true, value }
      } catch {
        if (attempt < this.retry.maxAttempts) {
          await this.sleep(backoffDelayMs(this.retry, attempt))
        }
      }
    }
    this.breaker.recordFailure()
    const fallback = matchFallback(this.fallbacks, toolName)
    return fallback === undefined ? { ok: false } : { ok: false, fallback }
  }
}
