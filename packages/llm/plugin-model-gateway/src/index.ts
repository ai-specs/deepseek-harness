/**
 * dsh-model-gateway — Cordis plugin exposing the local model gateway
 * (dsh.docx: Token 经济与模型路由；切换模型不改业务代码).
 * @module @deepseek-ai/dsh-plugin-model-gateway
 */

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ModelGateway, type ModelGatewayPolicy } from './core.ts'

export const name = 'model-gateway'
export const inject: string[] = ['nacosConfig']

export interface Config {
  /** 初始路由策略；运行期由 Nacos dsh-model-gateway.yaml 热更新覆盖 */
  policy: ModelGatewayPolicy
}

export const Config: z<Config> = z.object({
  policy: z.object({}).loose as unknown as z<ModelGatewayPolicy>,
})

export type * from './core.ts'
export { ModelGateway, routeModel, grayBucket } from './core.ts'

export function apply(ctx: Context, config: Config): ModelGateway {
  const gateway = new ModelGateway(config.policy)
  ctx.provide('modelGateway', gateway)
  return gateway
}
