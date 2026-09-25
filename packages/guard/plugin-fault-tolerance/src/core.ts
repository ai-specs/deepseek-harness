/**
 * Local fault-tolerance engine (dsh.docx 第九章 高容错执行链路).
 *
 * Tool failures are captured here and never surfaced raw to the user:
 * exponential-backoff retry → fallback rule library → circuit breaker.
 */

/**
 * 重试配置：指数退避的预算与节奏。
 */
export interface RetryConfig {
  /** 最大尝试次数（默认 4）。 */
  maxAttempts: number
  /** 基础延迟毫秒数（默认 1000 → 1s/2s/4s/8s）。 */
  baseDelayMs: number
  /** 退避倍增系数（默认 2）。 */
  multiplier: number
  /** 是否启用随机抖动，避免 thundering herd（默认 false）。 */
  jitter: boolean
}

/**
 * 兜底规则：正则匹配工具名，命中时返回安全默认答复。
 */
export interface FallbackRule {
  /** 工具名匹配正则（如 `^mcp_weather`）。 */
  matchTool: string
  /** 命中后返回的安全默认答复。 */
  response: string
}

/**
 * 熔断器配置：连续失败达到阈值后开启熔断，openSeconds 后进入半开探测。
 */
export interface CircuitBreakerConfig {
  /** 连续失败次数阈值（默认 5）。 */
  failureThreshold: number
  /** 熔断窗口时长（秒），用于统计连续失败的时间跨度。 */
  windowSeconds: number
  /** 熔断开启时长（秒），之后放行一次半开探测。 */
  openSeconds: number
}

/** 默认重试配置：最多 4 次、1s 起、倍增 2、无抖动。 */
export const DEFAULT_RETRY: RetryConfig = { maxAttempts: 4, baseDelayMs: 1000, multiplier: 2, jitter: false }
/** 默认熔断配置：连续 5 次失败开启、60s 窗口、30s 后半开探测。 */
export const DEFAULT_CIRCUIT: CircuitBreakerConfig = { failureThreshold: 5, windowSeconds: 60, openSeconds: 30 }

/** 熔断器状态：closed（关闭）/ open（开启）/ half_open（半开探测）。 */
export type BreakerState = 'closed' | 'open' | 'half_open'

/**
 * 指数退避延迟：attempt 从 1 开始 → base * multiplier^(attempt-1)。
 * @param retry - 重试配置（baseDelayMs、multiplier、jitter）。
 * @param attempt - 当前尝试次数（从 1 开始）。
 * @param rand - 随机源，仅 jitter 开启时用于抖动（默认 Math.random）。
 * @returns 本次重试前的等待毫秒数。
 */
export function backoffDelayMs(retry: RetryConfig, attempt: number, rand: () => number = Math.random): number {
  const raw = retry.baseDelayMs * Math.pow(retry.multiplier, attempt - 1)
  return retry.jitter ? Math.round(raw * (0.5 + 0.5 * rand())) : raw
}

/**
 * 兜底规则匹配：返回第一条命中的安全答复。
 * @param rules - 兜底规则库。
 * @param toolName - 失败的工具名。
 * @returns 命中规则的安全答复；无命中返回 undefined。
 */
export function matchFallback(rules: FallbackRule[], toolName: string): string | undefined {
  return rules.find(rule => new RegExp(rule.matchTool).test(toolName))?.response
}

/** 熔断器：closed →（连续失败达阈值）open →（openSeconds 后）half_open → 成功 closed。 */
export class CircuitBreaker {
  private consecutiveFailures = 0
  private openedAt = 0
  /** 当前熔断状态。 */
  state: BreakerState = 'closed'

  constructor(private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT, private readonly now: () => number = Date.now) {}

  /**
   * 放行检查：closed 恒放行；open 超时进入 half_open 并放行探测；half_open 放行。
   * @returns 是否放行本次调用。
   */
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

  /** 记录一次成功：清零连续失败计数并恢复 closed。 */
  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.state = 'closed'
  }

  /** 记录一次失败：累计连续失败，达到阈值（或半开探测失败）即开启熔断。 */
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

  /** 当前熔断状态（只读快照，供外部观测）。 */
  get breakerState(): BreakerState {
    return this.breaker.state
  }

  /**
   * 执行一次带容错的调用：熔断放行后按重试预算重试，耗尽后匹配兜底规则。
   * @param toolName - 工具名，用于兜底规则匹配。
   * @param fn - 底层调用。
   * @returns 成功（ok:true+value）或失败（ok:false+可选 fallback 答复）。
   */
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
