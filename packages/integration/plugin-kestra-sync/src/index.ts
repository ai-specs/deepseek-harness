/**
 * dsh-kestra-sync — Cordis plugin that keeps Kestra up to date with local dsh
 * session state (dsh.docx: 会话存储/观察中心/安全审批 live on the Kestra side).
 * @module @deepseek-ai/dsh-plugin-kestra-sync
 */

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { KestraSessionSyncClient, type KestraSyncConfig, type SessionSnapshot } from './core.ts'

export const name = 'kestra-sync'
export const inject: string[] = []

export interface Config extends KestraSyncConfig {
  /** 批量队列磁盘持久化路径（默认 ~/.dsh/sync-queue.jsonl） */
  queuePath?: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  token: z.string().required(),
  tenant: z.string(),
  mode: z.union(['realtime', 'batch']),
  batchIntervalMs: z.number(),
  timeoutMs: z.number(),
  queuePath: z.string(),
})

export type * from './core.ts'
export { KestraSessionSyncClient, buildSyncRequest } from './core.ts'

/** Started client handle kept on the plugin context for dispose. */
export function apply(ctx: Context, config: Config): KestraSessionSyncClient {
  const client = new KestraSessionSyncClient(config)
  ctx.provide('kestraSync', client)
  return client
}

export type { SessionSnapshot }
