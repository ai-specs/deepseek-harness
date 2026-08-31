import { describe, expect, it, vi } from 'vitest'
import { buildSyncRequest, KestraSessionSyncClient, type KestraSyncConfig } from '../src/core.ts'

const config: KestraSyncConfig = {
  baseUrl: 'http://kestra.internal:8080/',
  token: 't0k3n',
  mode: 'realtime',
}

const snapshot = {
  sessionId: 's-1',
  phase: 'running' as const,
  toolCalls: [{ name: 'crm_query_customer', ok: true, latencyMs: 120 }],
  tokenUsage: { prompt: 100, completion: 40, total: 140 },
}

describe('buildSyncRequest', () => {
  it('targets the dsh session API with bearer auth', () => {
    const { url, init } = buildSyncRequest(config, snapshot)
    expect(url).toBe('http://kestra.internal:8080/api/v1/dsh/sessions/s-1')
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0k3n')
    const body = JSON.parse(String(init.body))
    expect(body.phase).toBe('running')
    expect(body.at).toBeTruthy()
  })
})

describe('Kestra degradation (审查 9.1)', () => {
  it('queues while Kestra is down and pushes after recovery', async () => {
    let down = true
    const fetchImpl = vi.fn().mockImplementation(async () => {
      if (down) throw new Error('connection refused')
      return new Response(null, { status: 200 })
    })
    const client = new KestraSessionSyncClient(
      { ...config, mode: 'batch' },
      fetchImpl as unknown as typeof fetch,
    )
    await client.push({ ...snapshot, sessionId: 'deg-1' })
    await client.push({ ...snapshot, sessionId: 'deg-2' })
    await client.flush()
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0) // 停机期间仍尝试外连
    down = false
    const results = await client.flush()
    expect(results.filter(r => r.ok)).toHaveLength(2)      // 恢复后补推成功
    client.dispose()
  })
})

describe('KestraSessionSyncClient', () => {
  it('pushes realtime snapshots and reports ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const client = new KestraSessionSyncClient(config, fetchImpl as unknown as typeof fetch)
    const result = await client.push(snapshot)
    expect(result?.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('batches in batch mode and flushes coalesced snapshots', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const client = new KestraSessionSyncClient(
      { ...config, mode: 'batch' },
      fetchImpl as unknown as typeof fetch,
    )
    const queued = await client.push(snapshot)
    expect(queued).toBeUndefined()
    const results = await client.flush()
    expect(results).toHaveLength(1)
    client.dispose()
  })

  it('never throws on transport failure (outbound-only side)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const client = new KestraSessionSyncClient(config, fetchImpl as unknown as typeof fetch)
    const result = await client.push(snapshot)
    expect(result?.ok).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
