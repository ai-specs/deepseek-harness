import { describe, expect, it, vi } from 'vitest'
import { buildSyncRequest, buildTokenRequest, KestraSessionSyncClient, type KestraSyncConfig } from '../src/core.ts'

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
    const body = JSON.parse(init.body as string) as { phase?: string; at?: unknown }
    expect(body.phase).toBe('running')
    expect(body.at).toBeTruthy()
  })
})

describe('OIDC client_credentials (dsh API Bearer)', () => {
  it('builds the token request against the same provider', () => {
    const { url, init } = buildTokenRequest({
      baseUrl: 'http://kestra.internal:8080/',
      clientId: 'dsh',
      clientSecret: 's3cret',
    })
    expect(url).toBe('http://kestra.internal:8080/oidc/token')
    expect(init.method).toBe('POST')
    expect(init.body as string).toBe('grant_type=client_credentials')
    const auth = (init.headers as Record<string, string>).Authorization
    expect(auth).toBe(`Basic ${Buffer.from('dsh:s3cret').toString('base64')}`)
  })

  it('fetches, caches, and force-refreshes the access token on 401', async () => {
    let issued = 0
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/oidc/token')) {
        issued += 1
        return new Response(JSON.stringify({ access_token: `tok-${issued}`, expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      // 会话推送固定 401（验证取票+强制刷新被触发）
      return new Response(null, { status: 401 })
    })
    const client = new KestraSessionSyncClient(
      { baseUrl: 'http://kestra:8080', clientId: 'dsh', clientSecret: 's3cret' },
      fetchImpl,
    )
    const r1 = await client.push({ sessionId: 'cc-1', phase: 'running' })
    expect(r1?.status).toBe(401)
    expect(issued).toBe(2) // initial fetch + forced refresh on 401
  })

  it('rejects construction without any credential source', () => {
    expect(() => new KestraSessionSyncClient({ baseUrl: 'http://kestra:8080' }))
      .toThrow('clientId+clientSecret')
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
      fetchImpl,
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
    const client = new KestraSessionSyncClient(config, fetchImpl)
    const result = await client.push(snapshot)
    expect(result?.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('batches in batch mode and flushes coalesced snapshots', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const client = new KestraSessionSyncClient(
      { ...config, mode: 'batch' },
      fetchImpl,
    )
    const queued = await client.push(snapshot)
    expect(queued).toBeUndefined()
    const results = await client.flush()
    expect(results).toHaveLength(1)
    client.dispose()
  })

  it('never throws on transport failure (outbound-only side)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const client = new KestraSessionSyncClient(config, fetchImpl)
    const result = await client.push(snapshot)
    expect(result?.ok).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('relay SSE session.query 事件透传', () => {
  it('afterSeq 与 since 游标随事件传给 queryHandler，不得被字段白名单丢弃', async () => {
    const encoder = new TextEncoder()
    const frames = [
      'data: {"event":"session.query","data":{"requestId":"r1","type":"session.messages","sessionId":"s1","afterSeq":3}}\n\n',
      'data: {"event":"session.query","data":{"requestId":"r2","type":"session.list","since":"2026-01-01T00:00:00.000Z"}}\n\n',
    ].join('')
    const queries: Array<Record<string, unknown>> = []
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      // 首连投递事件帧；重连返回永不结束的空流，避免测试期反复消费。
      const body = calls === 1
        ? new ReadableStream({
          start(controller) { controller.enqueue(encoder.encode(frames)) },
        })
        : new ReadableStream({ start() {} })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const client = new KestraSessionSyncClient(config, fetchImpl)
    const stop = client.startInputSse(() => {}, undefined, {
      queryHandler: (query) => { queries.push(query as unknown as Record<string, unknown>) },
    })
    await new Promise((resolve) => { setTimeout(resolve, 80) })
    stop()
    expect(queries[0]).toMatchObject({ requestId: 'r1', type: 'session.messages', sessionId: 's1', afterSeq: 3 })
    expect(queries[1]).toMatchObject({ requestId: 'r2', type: 'session.list', since: '2026-01-01T00:00:00.000Z' })
  })
})
