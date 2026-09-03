/** The retained web identity: persistence, refresh rotation, and the cookie-identity binding. */

import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OidcBrowserAuth } from '../src/oidc-browser-auth.ts'
import { WebIdentityService } from '../src/web-identity.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function identity(store: RecordCredentials): WebIdentityService {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('credentials', store as unknown as CredentialProvider)
  return new WebIdentityService(ctx, { url: 'http://idp/oidc/token', clientId: 'dsh-pc' })
}

function idToken(sub: string): string {
  const b64 = (value: object): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64({ sub })}.sig`
}

describe('WebIdentityService', () => {
  it('starts empty, saves a sign-in durably, and reloads it next activation', async () => {
    const store = new RecordCredentials()
    const first = identity(store)
    await first.ensureLoaded()
    expect(first.alive()).toBe(false)
    expect(first.currentSub()).toBeUndefined()
    expect(await first.ensureAccessToken()).toBeUndefined()

    await first.save({
      version: 1,
      sub: 'alice@kestra.io',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
    })
    expect(first.alive()).toBe(true)
    expect(first.currentSub()).toBe('alice@kestra.io')
    expect(await first.ensureAccessToken()).toBe('at-1')

    const reloaded = identity(store)
    await reloaded.ensureLoaded()
    expect(reloaded.currentSub()).toBe('alice@kestra.io')
    expect(reloaded.alive()).toBe(true)
  })

  it('refreshes an expiring token, rotates the stored refresh token, and keeps the chain alive', async () => {
    const store = new RecordCredentials()
    const service = identity(store)
    await service.save({
      version: 1,
      sub: 'alice@kestra.io',
      accessToken: 'stale',
      refreshToken: 'rt-old',
      expiresAt: Date.now() + 10_000,
    })
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'fresh',
        refresh_token: 'rt-new',
        expires_in: 3600,
        id_token: idToken('alice@kestra.io'),
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(service.ensureAccessToken()).resolves.toBe('fresh')
      expect(fetchMock).toHaveBeenCalledOnce()
      const call = fetchMock.mock.calls[0]
      if (call === undefined) throw new Error('fetch was not called')
      const [, init] = call
      if (init === undefined) throw new Error('fetch init missing')
      const body = new URLSearchParams(String(init.body))
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('rt-old')
      // Rotation persisted: the next refresh would use rt-new.
      const record = store.record as { payload: { refreshToken?: string } } | undefined
      expect(record?.payload.refreshToken).toBe('rt-new')
      expect(service.alive()).toBe(true)
      // Within the new margin, no further endpoint call.
      await expect(service.ensureAccessToken()).resolves.toBe('fresh')
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('clears the identity when the IdP rejects the refresh grant', async () => {
    const store = new RecordCredentials()
    const service = identity(store)
    await service.save({
      version: 1,
      sub: 'alice@kestra.io',
      accessToken: 'stale',
      refreshToken: 'revoked-elsewhere',
      expiresAt: Date.now() - 1_000,
    })
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, _init?: RequestInit) => ({ ok: false, status: 400, json: async () => ({}) })))
    try {
      await expect(service.ensureAccessToken()).resolves.toBeUndefined()
      expect(service.alive()).toBe(false)
      expect(store.record).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('cookie-identity binding', () => {
  it('a valid cookie stops authenticating once the identity is gone', async () => {
    const store = new RecordCredentials()
    const service = identity(store)
    await service.ensureLoaded()
    const auth = await OidcBrowserAuth.create(store as unknown as Parameters<typeof OidcBrowserAuth.create>[0], {
      issuerBrowserUrl: 'http://idp',
      clientId: 'dsh-pc',
    }, 30, service)

    const res = response()
    expect(auth.authorizeIndex({
      method: 'GET',
      url: '/',
      headers: { host: '127.0.0.1:3080' },
    }, res.value)).toBe(false)
    const begin = new URL(res.state.headers?.location ?? 'http://x')
    const authorizeState = begin.searchParams.get('state') ?? ''

    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        id_token: idToken('alice@kestra.io'),
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const done = response()
      await auth.handleCallback({
        method: 'GET',
        url: `/oidc/callback?code=c&state=${authorizeState}`,
        headers: { host: '127.0.0.1:3080' },
      }, done.value)
      expect(done.state.status).toBe(303)
      expect(service.currentSub()).toBe('alice@kestra.io')
      const cookie = done.state.headers?.['set-cookie']?.split(';', 1)[0] ?? ''
      const request = (extra?: { cookie?: string }): ConnectionIndexRequest => ({
        method: 'GET',
        url: '/',
        headers: { host: '127.0.0.1:3080', ...(extra?.cookie === undefined ? {} : { cookie: extra.cookie }) },
      })
      expect(auth.isAuthenticated(request({ cookie }))).toBe(true)

      // The refresh chain breaks (IdP rejects) → identity cleared → the very
      // same cookie is refused and the browser is sent back to the IdP.
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, _init?: RequestInit) => ({ ok: false, status: 400, json: async () => ({}) })))
      await service.clear()
      expect(auth.isAuthenticated(request({ cookie }))).toBe(false)
      const redirect = response()
      expect(auth.authorizeIndex(request({ cookie }), redirect.value)).toBe(false)
      expect(redirect.state.status).toBe(303)
      expect(String(redirect.state.headers?.location)).toContain('/oidc/authorize')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
