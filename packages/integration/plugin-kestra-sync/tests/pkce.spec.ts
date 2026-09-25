import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PkceTokenProvider,
  buildAuthorizeUrl,
  buildTokenRequest,
  codeChallenge,
  subFromIdToken,
  type PkceConfig,
} from '../src/pkce.ts'
import {
  decideInputTarget,
} from '../src/core.ts'

const tempDir = mkdtempSync(join(tmpdir(), 'pkce-test-'))
afterEach(() => { rmSync(join(tempDir, 'cache.json'), { force: true }) })

function testConfig(overrides: Partial<PkceConfig> = {}): PkceConfig {
  return {
    issuer: 'http://kestra:8080',
    clientId: 'dsh-pc',
    redirectPort: 0, // unused in these tests (openUrl/loopback bypassed)
    scopes: ['openid', 'profile'],
    cachePath: join(tempDir, 'cache.json'),
    ...overrides,
  }
}

/** Minimal standalone id_token (unsigned; sub claim only — parse-only path). */
function fakeIdToken(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64({ sub })}.sig`
}

describe('PKCE helpers (dsh.docx 统一认证：公开客户端无 secret)', () => {
  it('computes the S256 challenge per RFC 7636 appendix B', () => {
    // RFC 7636 appendix B test vector
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(codeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(codeChallenge(verifier))
  })

  it('builds the authorize URL with code_challenge and no client_secret', () => {
    const url = new URL(buildAuthorizeUrl(testConfig(), 'v3rifier', 'st@te', 14100))
    expect(url.pathname).toBe('/oidc/authorize')
    expect(url.searchParams.get('client_id')).toBe('dsh-pc')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(codeChallenge('v3rifier')).toBe(url.searchParams.get('code_challenge'))
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:14100/callback')
    expect(String(url)).not.toMatch(/client_secret/)
  })

  it('builds a token request with client_id in the body (public client)', () => {
    const { url, init } = buildTokenRequest(testConfig(), {
      grant_type: 'authorization_code',
      code: 'abc',
      code_verifier: 'v',
      redirect_uri: 'http://127.0.0.1:14100/callback',
    })
    expect(url).toBe('http://kestra:8080/oidc/token')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    const body = new URLSearchParams(init.body as string)
    expect(body.get('client_id')).toBe('dsh-pc')
    expect(body.get('code_verifier')).toBe('v')
    expect(body.get('grant_type')).toBe('authorization_code')
  })

  it('parses sub from an id_token payload', () => {
    expect(subFromIdToken(fakeIdToken('alice@kestra.io'))).toBe('alice@kestra.io')
    expect(subFromIdToken('garbage')).toBe('')
  })
})

describe('PkceTokenProvider', () => {
  it('runs the full loopback login: opens the browser, catches the redirect, exchanges with the verifier', async () => {
    const bodies: URLSearchParams[] = []
    const seenAuthorize: string[] = []
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/oidc/token')) {
        bodies.push(new URLSearchParams((init?.body as string | undefined) ?? ''))
        return new Response(JSON.stringify({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          id_token: fakeIdToken('alice@kestra.io'),
          expires_in: 3600,
        }), { status: 200 })
      }
      return new Response(null, { status: 404 })
    })
    // 固定测试端口（避免并行冲突用高位随机口）
    const port = 34_000 + Math.floor(Math.random() * 20_000)
    const provider = new PkceTokenProvider(testConfig({
      redirectPort: port,
      fetchImpl: fetchImpl,
      // “浏览器”：拿到授权 URL 后解析 challenge，直接回跳 loopback /callback?code&state
      openUrl: (authorizeUrl: string) => {
        seenAuthorize.push(authorizeUrl)
        const u = new URL(authorizeUrl)
        const challenge = u.searchParams.get('code_challenge')
        const state = u.searchParams.get('state')
        // 验证 challenge 是 verifier 的 S256（这里从 openUrl 侧只校验存在性；
        // 真正的 verifier 匹配由 token 端点（服务端集成测试）验证）
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
        void state
        // 模拟 IdP 重定向浏览器到 loopback
        const callback = new URL(`http://127.0.0.1:${port}/callback`)
        callback.searchParams.set('code', 'auth-code-1')
        callback.searchParams.set('state', state ?? '')
        void fetch(callback.toString()).catch(() => {})
      },
    }))
    const tokens = await provider.login()
    expect(tokens.accessToken).toBe('at-1')
    expect(tokens.refreshToken).toBe('rt-1')
    expect(tokens.sub).toBe('alice@kestra.io')
    expect(seenAuthorize).toHaveLength(1)
    // 换票请求是公开客户端形态：client_id 在 body，无 Basic 头
    const body = bodies[0]!
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code-1')
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    // 缓存落盘（0600）
    const cached = JSON.parse(readFileSync(testConfig().cachePath!, 'utf8')) as { accessToken?: string }
    expect(cached.accessToken).toBe('at-1')
  })

  it('refreshes via refresh_token grant before re-login', async () => {
    // 预置缓存（模拟此前登录成功）
    const cache = join(tempDir, 'refresh-cache.json')
    const expiresSoon = { accessToken: 'expired', refreshToken: 'rt-old', expiresAt: Date.now() - 1000, sub: 'alice@kestra.io' }
    writeFileSync(cache, JSON.stringify(expiresSoon))

    const bodies: URLSearchParams[] = []
    const fetchImpl = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      bodies.push(new URLSearchParams((init?.body as string | undefined) ?? ''))
      return new Response(JSON.stringify({
        access_token: 'at-2',
        refresh_token: 'rt-new',
        id_token: fakeIdToken('alice@kestra.io'),
        expires_in: 3600,
      }), { status: 200 })
    })
    const provider = new PkceTokenProvider(testConfig({
      cachePath: cache,
      fetchImpl: fetchImpl,
    }))
    expect(provider.currentSub()).toBe('alice@kestra.io')
    const token = await provider.getToken()
    expect(token).toBe('at-2')
    const body = bodies[0]!
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt-old')
    expect(body.get('client_id')).toBe('dsh-pc')
    const cached = JSON.parse(readFileSync(cache, 'utf8')) as { accessToken?: string; refreshToken?: string }
    expect(cached.accessToken).toBe('at-2')
    expect(cached.refreshToken).toBe('rt-new') // 旋转后的新 refresh 落盘
  })
})

describe('remote input consumption (dsh.docx PC 离线行为)', () => {
  it('forks terminal sessions and resumes live ones', () => {
    const fork = decideInputTarget({ sessionId: 's-done', phase: 'COMPLETED', pendingInput: 'hi' })
    expect(fork.kind).toBe('fork')
    expect(fork.kind === 'fork' && fork.newSessionId).not.toBe('s-done')
    const resume = decideInputTarget({ sessionId: 's-live', phase: 'RUNNING', pendingInput: 'hi' })
    expect(resume).toEqual({ kind: 'resume', sessionId: 's-live' })
  })
})
