import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_POLICY, ModelGateway } from '../src/core.ts'

describe('DEFAULT_POLICY（审查任务 1.1）', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('constructs without a policy and routes to the default model', () => {
    const gateway = new ModelGateway(undefined, () => 'env-key')
    expect(gateway.getPolicy().default.model).toBe('deepseek-chat')
    expect(gateway.getPolicy().default.baseUrl).toBe('https://api.deepseek.com')
    expect(gateway.getPolicy().default.maxTokens).toBe(4096)
  })

  it('chat() works offline from Nacos using the default policy', async () => {
    process.env.DEEPSEEK_API_KEY = 'env-key'
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200 },
    ))
    const gateway = new ModelGateway(undefined, () => 'env-key', fetchMock as unknown as typeof fetch)
    const result = await gateway.chat('tool_call', [{ role: 'user', content: 'hi' }])
    expect(result.model).toBe('deepseek-chat')
    expect(result.content).toBe('ok')
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://api.deepseek.com/chat/completions')
  })

  it('updatePolicy switches the effective policy', () => {
    const gateway = new ModelGateway()
    gateway.updatePolicy({ default: { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' } })
    expect(gateway.getPolicy().default.model).toBe('gpt-4o')
    expect(gateway.getPolicy()).not.toEqual(DEFAULT_POLICY)
  })
})
