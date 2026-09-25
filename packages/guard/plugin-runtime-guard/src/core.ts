/**
 * Runtime guard (dsh.docx 第十二章 稳定性兜底).
 *
 * Prevents runaway agent loops, enforces execution depth limits, watches the
 * token budget, and emits guard events for the Kestra observation center.
 */

export interface RuntimeGuardConfig {
  /** 同一工具+同参指纹连续出现该次数即判死锁循环 */
  loopRepeatThreshold: number        // 默认 3
  /** 最大执行深度（子任务嵌套层数） */
  maxDepth: number                   // 默认 8
  /** 单会话 token 预算，超过即熔断告警 */
  tokenBudget: number                // 默认 500000
}

/** 默认运行防护配置：3 次同参判死锁、深度上限 8、token 预算 500000。 */
export const DEFAULT_RUNTIME_GUARD: RuntimeGuardConfig = {
  loopRepeatThreshold: 3,
  maxDepth: 8,
  tokenBudget: 500000,
}

/** 防护事件类型：死锁循环 / 深度超限 / token 预算超限。 */
export type GuardEventType = 'loop_detected' | 'depth_exceeded' | 'token_budget_exceeded'

/**
 * 防护事件：上报 Kestra 观察中心的稳定载荷。
 */
export interface GuardEvent {
  type: GuardEventType
  sessionId: string
  detail: string
  at: string
}

/**
 * 防死锁：对工具+参数指纹做连续重复计数。
 * @param toolName - 工具名。
 * @param argsJson - 序列化后的参数（同一指纹才视为重复调用）。
 * @returns 指纹字符串（`工具名:参数JSON`）。
 */
export function callFingerprint(toolName: string, argsJson: string): string {
  return `${toolName}:${argsJson}`
}

/**
 * 运行防护引擎：循环检测 / 深度限制 / token 预算，事件经 {@link RuntimeGuard.listeners} 分发。
 */
export class RuntimeGuard {
  private readonly lastFingerprint = new Map<string, { fingerprint: string; count: number }>()
  /** 最近调用指纹序列（用于 A→B→A 交叉循环检测） */
  private sequence: string[] = []
  private tokenUsed = 0
  /** 防护事件监听器集合（Kestra 观察中心接入点）。 */
  listeners = new Set<(event: GuardEvent) => void>()

  constructor(
    private readonly sessionId: string,
    private readonly config: RuntimeGuardConfig = DEFAULT_RUNTIME_GUARD,
    private readonly now: () => number = Date.now,
  ) {}

  private emit(type: GuardEventType, detail: string): GuardEvent {
    const event: GuardEvent = { type, sessionId: this.sessionId, detail, at: new Date(this.now()).toISOString() }
    for (const listener of this.listeners) listener(event)
    return event
  }

  /**
   * 注册防护事件监听器。
   * @param listener - 事件回调。
   */
  onEvent(listener: (event: GuardEvent) => void): void {
    this.listeners.add(listener)
  }

  /** 检测最近序列中的短周期循环（周期长度 1..4，重复两轮即判死锁）。 */
  private detectCycle(fingerprint: string): number | undefined {
    this.sequence.push(fingerprint)
    if (this.sequence.length > 24) this.sequence = this.sequence.slice(-24)
    const n = this.sequence.length
    // 周期长度 2..4（周期 1 = 同参连续重复，由指纹计数器处理）；需两轮完整重复
    for (let cycle = 2; cycle <= 4; cycle++) {
      if (n < cycle * 2) continue
      const head = this.sequence.slice(n - cycle)
      const previousWindow = this.sequence.slice(n - cycle * 2, n - cycle)
      if (head.every((v, i) => v === previousWindow[i])) return cycle
    }
    return undefined
  }

  /**
   * 每次工具调用前登记；返回 null 表示放行，返回 GuardEvent 表示已拦截。
   * @param toolName - 工具名。
   * @param argsJson - 序列化后的参数。
   * @returns 放行返回 null；拦截（连续重复或交叉循环）返回防护事件。
   */
  checkToolCall(toolName: string, argsJson: string): GuardEvent | null {
    const key = `${this.sessionId}:${toolName}`
    const fingerprint = callFingerprint(toolName, argsJson)
    const previous = this.lastFingerprint.get(key)
    const count = previous && previous.fingerprint === fingerprint ? previous.count + 1 : 1
    this.lastFingerprint.set(key, { fingerprint, count })
    if (count >= this.config.loopRepeatThreshold) {
      return this.emit('loop_detected', `${toolName} repeated ${count}x with identical args`)
    }
    const cycle = this.detectCycle(fingerprint)
    if (cycle !== undefined) {
      return this.emit('loop_detected', `alternating call cycle of length ${cycle} detected`)
    }
    return null
  }

  /**
   * 子任务入栈深度校验；超限返回拦截事件。
   * @param depth - 当前嵌套深度。
   * @returns 放行返回 null；超限返回深度超限事件。
   */
  checkDepth(depth: number): GuardEvent | null {
    if (depth > this.config.maxDepth) {
      return this.emit('depth_exceeded', `execution depth ${depth} > ${this.config.maxDepth}`)
    }
    return null
  }

  /**
   * 记录 token 消耗；超过预算返回熔断事件。
   * @param amount - 本次消耗的 token 数。
   * @returns 未超预算返回 null；超预算返回熔断事件。
   */
  recordTokenUsage(amount: number): GuardEvent | null {
    this.tokenUsed += amount
    if (this.tokenUsed > this.config.tokenBudget) {
      return this.emit('token_budget_exceeded', `token usage ${this.tokenUsed} > budget ${this.config.tokenBudget}`)
    }
    return null
  }

  /** 当前会话累计 token 消耗（只读）。 */
  get tokensUsed(): number {
    return this.tokenUsed
  }
}
