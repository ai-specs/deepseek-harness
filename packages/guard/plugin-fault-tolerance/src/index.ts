/**
 * dsh-fault-tolerance — Cordis plugin exposing the local fault-tolerance engine
 * (dsh.docx 第九章：底层错误不透传给用户，指数退避 → 兜底降级 → 熔断).
 * @module @deepseek-ai/dsh-plugin-fault-tolerance
 */

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FaultTolerance, type FallbackRule, type RetryConfig, type CircuitBreakerConfig } from './core.ts'

export const name = 'fault-tolerance'
export const inject: string[] = []

/**
 * 插件配置：容错引擎的覆盖层，全部字段经 Nacos `dsh-fault-tolerance.yaml` 下发映射而来。
 */
export interface Config {
  /** 重试配置（默认 4 次、1s 起、倍增 2）。 */
  retry?: RetryConfig
  /** 兜底规则库：重试耗尽后按正则命中返回安全默认答复。 */
  fallbacks?: FallbackRule[]
  /** 熔断器配置（默认连续 5 次失败开启、30s 后半开探测）。 */
  circuitBreaker?: CircuitBreakerConfig
}

export const Config: z<Config> = z.object({
  retry: z.object({
    maxAttempts: z.number().default(4),
    baseDelayMs: z.number().default(1000),
    multiplier: z.number().default(2),
    jitter: z.boolean().default(false),
  }),
  fallbacks: z.array(z.object({ matchTool: z.string(), response: z.string() })),
  circuitBreaker: z.object({
    failureThreshold: z.number(),
    windowSeconds: z.number(),
    openSeconds: z.number(),
  }),
})

export type * from './core.ts'
export { FaultTolerance, backoffDelayMs, matchFallback, CircuitBreaker } from './core.ts'

export function apply(ctx: Context, config: Config): FaultTolerance {
  const ft = new FaultTolerance(config.retry, config.fallbacks ?? [], config.circuitBreaker)
  ctx.provide('faultTolerance', ft)
  return ft
}
