/** Kestra-OIDC browser bootstrap: redirect, PKCE exchange, and the shared cookie contract. */

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import { OidcBrowserAuth } from '../src/oidc-browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

const ISSUER_BROWSER = 'http://localhost:18080'
const AUTHORITY = '127.0.0.1:3080'

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

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(store: RecordCredentials): Promise<OidcBrowserAuth> {
  return OidcBrowserAuth.create(credentials(store), {
    issuerBrowserUrl: ISSUER_BROWSER,
    issuerServerUrl: 'http://kestra.internal:8080',
    clientId: 'dsh-pc',
  }, 30)
}

function request(url: string, authority = AUTHORITY, init?: {
  cookie?: string
  method?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
    },
  }
}

/** Drive authorizeIndex on `/` and return the IdP redirect target. */
function beginLogin(auth: OidcBrowserAuth): { state: ResponseState; authorizeUrl: URL } {
  const res = response()
  expect(auth.authorizeIndex(request('/'), res.value)).toBe(false)
  const location = res.state.headers?.location
  if (res.state.status !== 303 || location === undefined) {
    throw new Error(`expected an IdP redirect, got ${String(res.state.status)}`)
  }
  return { state: res.state, authorizeUrl: new URL(location) }
}

/** Run the callback for the captured sign-in attempt against a stubbed token endpoint. */
async function completeLogin(
  auth: OidcBrowserAuth,
  authorizeUrl: URL,
  tokenPayload: { ok?: boolean; status?: number; body?: unknown } = { ok: true, body: { access_token: 'at' } },
): Promise<ResponseState> {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({
    ok: tokenPayload.ok ?? true,
    status: tokenPayload.status ?? 200,
    json: async () => tokenPayload.body,
  }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const res = response()
    await auth.handleCallback(
      request(`/oidc/callback?code=the-code&state=${authorizeUrl.searchParams.get('state') ?? ''}`),
      res.value,
    )
    if (fetchMock.mock.calls.length > 0) {
      const call = fetchMock.mock.calls[0]
      if (call === undefined) throw new Error('fetch was not called')
      const [url, init] = call
      expect(url).toBe('http://kestra.internal:8080/oidc/token')
      if (init === undefined) throw new Error('fetch init missing')
      const headers = init.headers as Record<string, string>
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
      const body = new URLSearchParams(String(init.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('client_id')).toBe('dsh-pc')
      expect(body.get('code')).toBe('the-code')
      expect(body.get('redirect_uri')).toBe(`http://${AUTHORITY}/oidc/callback`)
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{40,}$/u)
      const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')
      expect(authorizeUrl.searchParams.get('code_challenge')).toBe(challenge)
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    }
    return res.state
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('OidcBrowserAuth', () => {
  it('redirects an unauthenticated browser to the IdP with PKCE and mints the shared cookie', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { state, authorizeUrl } = beginLogin(auth)

    expect(state.headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    expect(authorizeUrl.origin).toBe(ISSUER_BROWSER)
    expect(authorizeUrl.pathname).toBe('/oidc/authorize')
    expect(authorizeUrl.searchParams.get('client_id')).toBe('dsh-pc')
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`http://${AUTHORITY}/oidc/callback`)
    expect(authorizeUrl.searchParams.get('scope')).toBe('openid profile')
    expect(authorizeUrl.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+$/u)

    const done = await completeLogin(auth, authorizeUrl)
    expect(done.status).toBe(303)
    expect(done.headers).toMatchObject({ location: '/' })
    const cookie = done.headers?.['set-cookie']?.split(';', 1)[0] ?? ''
    expect(done.headers?.['set-cookie']).toMatch(/Max-Age=2592000/u)

    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(true)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3081', { cookie }))).toBe(false)
    // v1 cookie contract is shared: the launch-token strategy verifies the same secret's cookies.
    const tokenAuth = await BrowserAuth.create({}, credentials(store), 30)
    expect(tokenAuth.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(true)
  })

  it('keeps the printed entry URL clean in oidc mode', async () => {
    const auth = await createAuth(new RecordCredentials())
    expect(auth.authenticatedUrl(`http://${AUTHORITY}`)).toBe(`http://${AUTHORITY}/`)
  })

  it('rejects an unknown state, a token-endpoint failure, and a missing access token', async () => {
    const auth = await createAuth(new RecordCredentials())

    const unknown = response()
    await auth.handleCallback(request('/oidc/callback?code=c&state=unknown'), unknown.value)
    expect(unknown.state.status).toBe(400)
    expect(unknown.state.body).toContain('unknown or expired sign-in attempt')

    const { authorizeUrl } = beginLogin(auth)
    const failure = await completeLogin(auth, authorizeUrl, { ok: false, status: 400, body: {} })
    expect(failure.status).toBe(401)
    expect(failure.body).toContain('token endpoint returned 400')

    const { authorizeUrl: again } = beginLogin(auth)
    const empty = await completeLogin(auth, again, { ok: true, body: { access_token: '' } })
    expect(empty.status).toBe(401)
    expect(empty.body).toContain('no access token')
  })

  it('answers a non-GET unauthenticated request with the strategy 401', async () => {
    const auth = await createAuth(new RecordCredentials())
    const denied = response()
    expect(auth.authorizeIndex(request('/', AUTHORITY, { method: 'POST' }), denied.value)).toBe(false)
    expect(denied.state.status).toBe(401)
    expect(denied.state.body).toContain('sign in through the redirected identity provider')
  })
})
