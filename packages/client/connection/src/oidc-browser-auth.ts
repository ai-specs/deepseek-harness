/**
 * Kestra-OIDC browser authentication: the launch-token fence's identity-based
 * sibling. The browser session cookie contract (v1, authority-bound, HMAC via
 * the durable per-home secret) is shared with {@link BrowserAuth}; only the
 * bootstrap differs — instead of exchanging a console-printed launch token,
 * an unauthenticated browser is redirected to the IdP's authorize endpoint
 * (Authorization Code + PKCE S256, public client) and the callback exchanges
 * the code server-side before minting the same cookie.
 * @module @deepseek-ai/dsh-client-connection/oidc-browser-auth
 */

import { createHash, randomBytes } from 'node:crypto'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'
import {
  COOKIE_PAYLOAD_VERSION,
  cookieName,
  header,
  cookieValue,
  decodeBase64Url,
  decodeCookie,
  encodeBase64Url,
  encodeCookie,
  initializeSecret,
  requestAuthority,
  sessionCookie,
} from './browser-auth.ts'
import type { WebIdentityPayload } from './web-identity.ts'

/** Read the `sub` claim off an id_token without verifying it — ownership
 * tagging only; the IdP already authenticated this very exchange. */
function subOfIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string' || idToken === '') return undefined
  const part = idToken.split('.')[1]
  if (part === undefined) return undefined
  const bytes = decodeBase64Url(part)
  if (bytes === undefined) return undefined
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as { sub?: unknown }
    return typeof parsed.sub === 'string' && parsed.sub !== '' ? parsed.sub : undefined
  } catch {
    return undefined
  }
}

/** Deployment-provided IdP endpoints and the public client acting for the browser. */
export interface OidcBrowserAuthConfig {
  /** Browser-facing IdP base URL — where the user's tab is redirected to sign in. */
  readonly issuerBrowserUrl: string
  /** Server-facing IdP base URL for the code exchange; defaults to the browser URL. */
  readonly issuerServerUrl?: string | undefined
  /** Public PKCE client id registered for this web callback (e.g. `dsh-pc`). */
  readonly clientId: string
  /** This server's callback path; must be registered on the IdP client. Default `/oidc/callback`. */
  readonly callbackPath?: string | undefined
  /** Authorize scope. Default `openid profile`. */
  readonly scope?: string | undefined
}

const VERIFIER_BYTES = 32
const PENDING_TTL_MILLISECONDS = 10 * 60 * 1000
const TOKEN_TIMEOUT_MILLISECONDS = 10_000
const DEFAULT_CALLBACK_PATH = '/oidc/callback'
const DEFAULT_SCOPE = 'openid profile'

interface PendingLogin {
  readonly verifier: string
  readonly redirectUri: string
  readonly expiresAt: number
}

/**
 * The same v1 signed-cookie contract as {@link BrowserAuth}, minted through an
 * IdP round-trip. The server keeps one in-memory pending sign-in per attempt
 * (state → PKCE verifier, 10-minute TTL); a `dsh web` restart simply expires
 * the in-flight browser sign-in, which the user retries.
 */
export class OidcBrowserAuth {
  private readonly secret: Buffer
  private readonly maxAgeMilliseconds: number
  private readonly pending = new Map<string, PendingLogin>()
  private readonly scope: string
  private readonly tokenEndpointUrl: string
  private identity: { readonly alive: () => boolean } | undefined
  private identitySink: ((payload: WebIdentityPayload) => Promise<void>) | undefined

  private constructor(
    private readonly config: OidcBrowserAuthConfig,
    secret: Buffer,
    maxAgeDays: number,
  ) {
    this.scope = config.scope ?? DEFAULT_SCOPE
    this.tokenEndpointUrl = new URL(
      '/oidc/token',
      config.issuerServerUrl ?? config.issuerBrowserUrl,
    ).toString()
    this.maxAgeMilliseconds = maxAgeDays * 24 * 60 * 60 * 1000
    if (!Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
    this.secret = secret
  }

  /** Load (or create) the durable signing secret, then build the auth. */
  static async create(
    credentials: CredentialProvider,
    config: OidcBrowserAuthConfig,
    maxAgeDays: number,
    identity?: { readonly alive: () => boolean; readonly save?: (payload: WebIdentityPayload) => Promise<void> },
  ): Promise<OidcBrowserAuth> {
    const auth = new OidcBrowserAuth(config, await initializeSecret(credentials), maxAgeDays)
    auth.identity = identity
    auth.identitySink = identity?.save?.bind(identity)
    return auth
  }

  /**
   * Bind the retained web identity: once bound, a cookie only authenticates
   * while the identity is alive, so a broken refresh chain forces a fresh
   * sign-in instead of leaving a UI that works while the relay silently dies.
   */
  bindIdentity(identity: {
    readonly alive: () => boolean
    readonly save?: (payload: WebIdentityPayload) => Promise<void>
  }): void {
    this.identity = identity
    if (identity.save !== undefined) this.identitySink = identity.save.bind(identity)
  }

  /** The server-authoritative callback path the deployment must register on the IdP client. */
  get callbackPath(): string {
    return this.config.callbackPath ?? DEFAULT_CALLBACK_PATH
  }

  /** OIDC mode needs no console token: the clean root URL is the entry point. */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.href
  }

  /**
   * Authenticate an index request. A valid cookie lets the caller serve the
   * index; a GET without one is redirected to the IdP (state + PKCE challenge
   * tracked in memory); everything else receives the minimal 401.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    if (this.isAuthenticated(req)) return true
    const authority = requestAuthority(req.headers)
    if (req.method === 'GET' && authority !== undefined) {
      res.writeHead(303, {
        'cache-control': 'no-store',
        'location': this.beginLogin(`http://${authority}${this.callbackPath}`).url,
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return false
    }
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Consume the IdP callback: exchange the code (PKCE verifier, public client,
   * no secret), then mint the same authority-bound session cookie and land on
   * the clean root. Owns the response in every outcome.
   */
  async handleCallback(req: ConnectionIndexRequest, res: ConnectionIndexResponse): Promise<void> {
    const authority = requestAuthority(req.headers)
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const fail = (status: number, message: string): void => {
      res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      res.end(message)
    }
    if (authority === undefined || code === null || state === null) {
      return fail(400, 'dsh web oidc sign-in failed: missing code or state\n')
    }
    const pending = this.pending.get(state)
    this.pending.delete(state)
    const redirectUri = `http://${authority}${this.callbackPath}`
    if (pending === undefined || pending.expiresAt <= Date.now() || pending.redirectUri !== redirectUri) {
      return fail(400, 'dsh web oidc sign-in failed: unknown or expired sign-in attempt\n')
    }
    let body: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; id_token?: unknown }
    try {
      const response = await fetch(this.tokenEndpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: pending.verifier,
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MILLISECONDS),
      })
      if (!response.ok) {
        return fail(401, `dsh web oidc sign-in failed: token endpoint returned ${String(response.status)}\n`)
      }
      body = await response.json() as typeof body
      if (typeof body.access_token !== 'string' || body.access_token === '') {
        return fail(401, 'dsh web oidc sign-in failed: token endpoint returned no access token\n')
      }
    } catch (error) {
      return fail(401, `dsh web oidc sign-in failed: ${String(error)}\n`)
    }
    if (this.identitySink !== undefined) {
      // 本地为主（期 1.5）：换到的用户令牌留存为 web 身份（自动续期，驱动
      // 手机输入联动）；留存失败不让登录失败——最坏情况是退化为只读门。
      const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
      await this.identitySink({
        version: 1,
        sub: subOfIdToken(body.id_token) ?? 'unknown',
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token !== ''
          ? body.refresh_token
          : undefined,
        expiresAt: Date.now() + expiresIn * 1000,
      }).catch(() => undefined)
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': '/',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority),
        encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, this.secret),
        expiresAt,
        Math.floor(this.maxAgeMilliseconds / 1000),
      ),
    })
    res.end()
  }

  /** Same authority-bound signed-cookie verification as the launch-token strategy. */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return false
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return false
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return false
    const now = Date.now()
    return payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
      && (this.identity === undefined || this.identity.alive())
  }

  /** Build the authorize redirect and remember the matching PKCE verifier. */
  private beginLogin(redirectUri: string): { url: string; state: string } {
    const now = Date.now()
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(state)
    }
    const verifier = encodeBase64Url(randomBytes(VERIFIER_BYTES))
    const state = encodeBase64Url(randomBytes(16))
    this.pending.set(state, {
      verifier,
      redirectUri,
      expiresAt: now + PENDING_TTL_MILLISECONDS,
    })
    const url = new URL('/oidc/authorize', this.config.issuerBrowserUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', this.scope)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    return { url: url.toString(), state }
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; sign in through the redirected identity provider.\n')
  }
}
