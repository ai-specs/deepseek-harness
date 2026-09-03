/** web-identity auth mode: token source, sub reporting, and the missing-handle guard. */

import { describe, expect, it, vi } from 'vitest'
import { KestraSessionSyncClient } from '../src/core.ts'

function handle(fetchImpl?: typeof fetch): {
  client: KestraSessionSyncClient
  ensure: ReturnType<typeof vi.fn>
} {
  const ensure = vi.fn(async () => 'web-at')
  const client = new KestraSessionSyncClient(
    { baseUrl: 'http://k.test', auth: 'web-identity' },
    fetchImpl,
    undefined,
    { ensureAccessToken: ensure, currentSub: () => 'alice@kestra.io' },
  )
  return { client, ensure }
}

describe('kestra-sync auth=web-identity', () => {
  it('pulls the bearer token from the web identity handle', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify([]), { status: 200 }))
    const { client, ensure } = handle(fetchImpl as unknown as typeof fetch)
    expect(client.currentSub()).toBe('alice@kestra.io')

    await client.listOwnedSessions(5)
    expect(ensure).toHaveBeenCalled()
    const call = fetchImpl.mock.calls[0]
    if (call === undefined) throw new Error('fetch was not called')
    const headers = (call[1] as RequestInit | undefined)?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer web-at')
  })

  it('reports the sub and stays silent while unsigned-in', () => {
    const client = new KestraSessionSyncClient(
      { baseUrl: 'http://k.test', auth: 'web-identity' },
      undefined,
      undefined,
      { ensureAccessToken: async () => undefined, currentSub: () => undefined },
    )
    expect(client.currentSub()).toBe('')
    // Unsigned-in handle rejects the bearer path instead of sending an empty token.
    void expect(client['bearerToken']()).rejects.toThrow(/not signed in/u)
  })

  it('refuses to construct without the handle', () => {
    expect(() => new KestraSessionSyncClient({ baseUrl: 'http://k.test', auth: 'web-identity' }))
      .toThrow(/webIdentity/u)
  })
})
