/**
 * dsh-nacos-config — Cordis plugin that pulls dsh configuration from Nacos and
 * keeps it hot-reloaded (dsh.docx: 配置下发 + 技能包版本管理 + 灰度推送).
 * @module @deepseek-ai/dsh-plugin-nacos-config
 */

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NacosConfigClient, type NacosConfigClientOptions } from './core.ts'

export const name = 'nacos-config'
export const inject: string[] = []

export interface Config extends NacosConfigClientOptions {}

export const Config: z<Config> = z.object({
  server: z.string().required(),
  namespace: z.string().default('dsh'),
  group: z.string().default('DEFAULT_GROUP'),
  pollIntervalMs: z.number().default(10000),
})

export type * from './core.ts'
export { NacosConfigClient, DEFAULT_DATA_IDS, contentMd5 } from './core.ts'

export function apply(ctx: Context, config: Config): NacosConfigClient {
  const client = new NacosConfigClient(config)
  void client.refreshAll()
  client.start()
  ctx.provide('nacosConfig', client)
  return client
}
