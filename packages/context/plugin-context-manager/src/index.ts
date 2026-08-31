/**
 * dsh-context-manager — Cordis plugin for context window control
 * (dsh.docx 第十章：滑动窗口 + 压缩 + 本地向量库，策略由 Nacos dsh-context.yaml 下发).
 * @module @deepseek-ai/dsh-plugin-context-manager
 */

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ContextManager, type ContextPolicy } from './core.ts'

export const name = 'context-manager'
export const inject: string[] = ['nacosConfig']

export interface Config {
  policy: ContextPolicy
}

export const Config: z<Config> = z.object({
  policy: z.object({}).loose as unknown as z<ContextPolicy>,
})

export type * from './core.ts'
export { ContextManager, LocalVectorStore, tokenize } from './core.ts'

export function apply(ctx: Context, config: Config): ContextManager {
  const manager = new ContextManager([], config.policy, async prompt => prompt)
  ctx.provide('contextManager', manager)
  return manager
}
