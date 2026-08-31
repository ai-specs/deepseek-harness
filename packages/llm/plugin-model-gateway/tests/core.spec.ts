import { describe, expect, it, vi } from 'vitest'
import { grayBucket, ModelGateway, routeModel, type ModelGatewayPolicy } from '../src/core.ts'

const policy: ModelGatewayPolicy = {
  default: { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
  fallback: { provider: 'deepseek', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1' },
  routing: [{ taskType: 'reasoning', provider: 'deepseek', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1' }],
  gray: { model: 'deepseek-chat-v2', percent: 10, salt: 's1' },
}

describe('routeModel', () => {
  it('routes reasoning to the strong model', () => {
    expect(routeModel(policy, 'reasoning').model).toBe('deepseek-reasoner')
  })
  it('falls back to the default model for unknown task types', () => {
    expect(routeModel(policy, 'other').model).toBe('deepseek-chat')
  })
  it('is deterministic per user for gray bucketing', () => {
    const a = grayBucket('u-1', 's1')
    expect(grayBucket('u-1', 's1')).toBe(a)
  })
})

describe('ModelGateway', () => {
  it('accounts token usage and switches to fallback on failure', async () => {
    process.env.DEEPSEEK_API_KEY = 'k0'
    const gateway = new ModelGateway(policy, () => 'k0')
    const failing = vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200 }),
    )
    ;(gateway as unknown as { fetchImpl: typeof fetch }).fetchImpl = failing as unknown as typeof fetch
    const result = await gateway.chat('summary', [{ role: 'user', content: 'hi' }])
    expect(result.content).toBe('ok')
    expect(result.fallbackUsed).toBe(true)
    expect(result.model).toBe('deepseek-reasoner')
    expect(gateway.sessionTokenTotal).toBe(15)
  })
})
