/**
 * Local model gateway (dsh.docx: Token 经济 + 模型路由).
 *
 * Single entry point for every LLM call made by dsh. Models are selected per
 * task type from the Nacos-pushed routing policy; the user's own third-party
 * API keys are read from the environment and never travel through Nacos.
 */

export interface ModelRoute {
  taskType: string
  provider: string
  model: string
  baseUrl: string
  maxTokens?: number
}

export interface ModelGatewayPolicy {
  default: { provider: string; model: string; baseUrl: string; temperature?: number; maxTokens?: number }
  fallback?: { provider: string; model: string; baseUrl: string }
  routing?: ModelRoute[]
  gray?: { model: string; percent: number; salt: string }
  budget?: { perSessionTokenCap: number; perTaskTokenCap: number }
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatCallResult {
  model: string
  content: string
  usage: { prompt: number; completion: number; total: number }
  fallbackUsed: boolean
  latencyMs: number
}

/** 灰度分桶：hash(salt+userId) % 100 < percent 时命中灰度模型。 */
export function grayBucket(userId: string, salt: string): number {
  let h = 0
  for (const ch of salt + userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 100
}

/** 按任务类型选择模型；灰度命中优先于普通路由。 */
export function routeModel(policy: ModelGatewayPolicy, taskType: string, userId?: string): { provider: string; model: string; baseUrl: string; gray: boolean } {
  if (policy.gray && userId !== undefined && grayBucket(userId, policy.gray.salt) < policy.gray.percent) {
    const base = policy.routing?.find(r => r.taskType === taskType)?.baseUrl ?? policy.default.baseUrl
    return { provider: policy.default.provider, model: policy.gray.model, baseUrl: base, gray: true }
  }
  const route = policy.routing?.find(r => r.taskType === taskType)
  if (route) return { provider: route.provider, model: route.model, baseUrl: route.baseUrl, gray: false }
  return { provider: policy.default.provider, model: policy.default.model, baseUrl: policy.default.baseUrl, gray: false }
}

export class ModelGateway {
  private sessionTokens = 0

  constructor(
    private policy: ModelGatewayPolicy,
    private readonly apiKeyFromEnv: (provider: string) => string | undefined = provider =>
      process.env[`${provider.toUpperCase()}_API_KEY`],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  updatePolicy(policy: ModelGatewayPolicy): void {
    this.policy = policy
  }

  get sessionTokenTotal(): number {
    return this.sessionTokens
  }

  /** 统一模型调用入口：路由 → 调用 → token 记账 → 失败走 fallback。 */
  async chat(taskType: string, messages: ChatMessage[], options: { userId?: string; maxTokens?: number } = {}): Promise<ChatCallResult> {
    const primary = routeModel(this.policy, taskType, options.userId)
    const attempt = async (model: string, baseUrl: string): Promise<ChatCallResult> => {
      const apiKey = this.apiKeyFromEnv(primary.provider ?? 'deepseek')
      if (!apiKey) throw new Error(`model gateway: missing API key for provider ${primary.provider}`)
      const started = Date.now()
      const response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: options.maxTokens ?? this.policy.default.maxTokens }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`model gateway: HTTP ${response.status}`)
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      }
      const usage = {
        prompt: data.usage?.prompt_tokens ?? 0,
        completion: data.usage?.completion_tokens ?? 0,
        total: data.usage?.total_tokens ?? 0,
      }
      this.sessionTokens += usage.total
      return {
        model,
        content: data.choices?.[0]?.message?.content ?? '',
        usage,
        fallbackUsed: false,
        latencyMs: Date.now() - started,
      }
    }

    try {
      return await attempt(primary.model, primary.baseUrl)
    } catch {
      if (!this.policy.fallback) throw new Error('model gateway: primary failed and no fallback configured')
      const fb = this.policy.fallback
      const result = await attempt(fb.model, fb.baseUrl)
      return { ...result, fallbackUsed: true }
    }
  }
}
