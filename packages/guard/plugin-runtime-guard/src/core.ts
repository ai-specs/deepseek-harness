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

export const DEFAULT_RUNTIME_GUARD: RuntimeGuardConfig = {
  loopRepeatThreshold: 3,
  maxDepth: 8,
  tokenBudget: 500000,
}

export type GuardEventType = 'loop_detected' | 'depth_exceeded' | 'token_budget_exceeded'

export interface GuardEvent {
  type: GuardEventType
  sessionId: string
  detail: string
  at: string
}

/** 防死锁：对工具+参数指纹做连续重复计数。 */
export function callFingerprint(toolName: string, argsJson: string): string {
  return `${toolName}:${argsJson}`
}

export class RuntimeGuard {
  private readonly lastFingerprint = new Map<string, { fingerprint: string; count: number }>()
  /** 最近调用指纹序列（用于 A→B→A 交叉循环检测） */
  private sequence: string[] = []
  private tokenUsed = 0
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

  /** 每次工具调用前登记；返回 null 表示放行，返回 GuardEvent 表示已拦截。 */
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

  /** 子任务入栈深度校验；超限返回拦截事件。 */
  checkDepth(depth: number): GuardEvent | null {
    if (depth > this.config.maxDepth) {
      return this.emit('depth_exceeded', `execution depth ${depth} > ${this.config.maxDepth}`)
    }
    return null
  }

  /** 记录 token 消耗；超过预算返回熔断事件。 */
  recordTokenUsage(amount: number): GuardEvent | null {
    this.tokenUsed += amount
    if (this.tokenUsed > this.config.tokenBudget) {
      return this.emit('token_budget_exceeded', `token usage ${this.tokenUsed} > budget ${this.config.tokenBudget}`)
    }
    return null
  }

  get tokensUsed(): number {
    return this.tokenUsed
  }
}
