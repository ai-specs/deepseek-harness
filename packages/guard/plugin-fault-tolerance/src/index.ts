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

export interface Config {
  retry?: RetryConfig
  fallbacks?: FallbackRule[]
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
