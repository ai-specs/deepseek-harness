/**
 * dsh-runtime-guard — Cordis plugin for runtime stability guards
 * (dsh.docx 第十二章：防死锁 / 深度限制 / Token 预算，防护事件上报 Kestra 观察中心).
 * @module @deepseek-ai/dsh-plugin-runtime-guard
 */

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RuntimeGuard, type RuntimeGuardConfig } from './core.ts'

export const name = 'runtime-guard'
export const inject: string[] = []

export interface Config extends RuntimeGuardConfig {
  /** 事件上报的目标会话同步插件（经 Kestra 观察中心） */
  reportToKestra?: boolean
}

export const Config: z<Config> = z.object({
  loopRepeatThreshold: z.number().default(3),
  maxDepth: z.number().default(8),
  tokenBudget: z.number().default(500000),
  reportToKestra: z.boolean().default(true),
})

export type * from './core.ts'
export { RuntimeGuard } from './core.ts'

export function apply(ctx: Context, config: Config): RuntimeGuard {
  const sessionId = (ctx as unknown as { id?: string }).id ?? 'session'
  const guard = new RuntimeGuard(sessionId, config)
  if (config.reportToKestra) {
    guard.onEvent((event) => {
      // 观察中心上报走 dsh-kestra-sync 的会话通道（phase=failed + guard 事件明细）
      ctx.logger?.warn?.(`[dsh-guard] ${event.type}: ${event.detail}`)
    })
  }
  ctx.provide('runtimeGuard', guard)
  return guard
}
