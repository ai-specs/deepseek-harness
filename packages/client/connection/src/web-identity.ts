/**
 * The web profile's retained user identity: the tokens the browser's OIDC
 * sign-in exchanged, persisted in this Harness home's credential store and
 * kept alive by refresh. This is what lets the same signed-in user power the
 * phone-input relay (kestra-sync `auth="web-identity"`) instead of requiring
 * a second, daemon-side login. Local session storage stays owner-less and
 * login-optional; this record is the single "who is at this PC" fact.
 * @module @deepseek-ai/dsh-client-connection/web-identity
 */

import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

/** Stored shape, version 1. */
export interface WebIdentityPayload {
  readonly version: 1
  /** OIDC sub — the same identity the phone-side sessions are owned by. */
  readonly sub: string
  readonly accessToken: string
  readonly refreshToken?: string | undefined
  /** Access-token expiry, ms since epoch. */
  readonly expiresAt: number
}

/** What the IdP token endpoint returns on refresh. */
interface TokenResponse {
  readonly access_token?: unknown
  readonly refresh_token?: unknown
  readonly expires_in?: unknown
}

const WEB_IDENTITY_KEY = credentialKey('client-connection', 'web-identity')
const TOKEN_TIMEOUT_MILLISECONDS = 10_000
const EXPIRY_MARGIN_MILLISECONDS = 60_000

function storedPayload(record: CredentialRecord | undefined): WebIdentityPayload | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) return undefined
  const payload = record.payload as Partial<WebIdentityPayload>
  if (payload.version !== 1 || typeof payload.sub !== 'string' || typeof payload.accessToken !== 'string'
    || !Number.isSafeInteger(payload.expiresAt)) {
    return undefined
  }
  return payload as WebIdentityPayload
}

/**
 * Owner of the retained web identity. The record is the source of truth for
 * both the sign-in cookie (the cookie is refused once the identity is gone —
 * see OidcBrowserAuth) and any consumer needing the user's tokens.
 */
export class WebIdentityService extends Service {
  static inject = ['credentials'] as const

  private payload: WebIdentityPayload | undefined
  private loaded = false
  private inflight: Promise<string | undefined> | undefined

  constructor(ctx: Context, private readonly refreshEndpoint: { url: string; clientId: string }) {
    super(ctx, 'webIdentity')
  }

  /** Load the stored identity once; safe for the synchronous checks afterwards. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.payload = storedPayload(await this.ctx.credentials.readRecord(WEB_IDENTITY_KEY))
      this.loaded = true
    }
  }

  /**
   * Whether a sign-in exists and is not known-dead. A present record with a
   * refresh token counts as alive even past expiry — the chain has not been
   * observed broken; only a failed refresh (or explicit clear/logout) kills it.
   */
  alive(): boolean {
    return this.payload !== undefined
      && (this.payload.expiresAt > Date.now() - EXPIRY_MARGIN_MILLISECONDS
        || this.payload.refreshToken !== undefined)
  }

  /** The signed-in user's OIDC sub, once loaded. */
  currentSub(): string | undefined {
    return this.payload?.sub
  }

  /** Persist the tokens minted by a completed browser sign-in. */
  async save(payload: WebIdentityPayload): Promise<void> {
    this.payload = payload
    await this.ctx.credentials.modifyRecord(WEB_IDENTITY_KEY, () =>
      Promise.resolve<CredentialRecord | undefined>({ kind: 'grant', payload }))
  }

  /** Drop the identity (logout, or a broken refresh chain). */
  async clear(): Promise<void> {
    this.payload = undefined
    await this.ctx.credentials.deleteRecord(WEB_IDENTITY_KEY)
  }

  /**
   * A usable access token for the signed-in user, refreshing (and rotating the
   * stored refresh token) when the current one is within its expiry margin.
   * Resolves undefined when nobody is signed in or the refresh chain broke —
   * callers treat that as "relay idle until the browser signs in again".
   */
  async ensureAccessToken(): Promise<string | undefined> {
    await this.ensureLoaded()
    if (this.payload === undefined) return undefined
    if (this.payload.expiresAt > Date.now() + EXPIRY_MARGIN_MILLISECONDS) return this.payload.accessToken
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.refresh().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async refresh(): Promise<string | undefined> {
    const current = this.payload
    if (current === undefined || current.refreshToken === undefined) {
      await this.clear()
      return undefined
    }
    let response: Response
    try {
      response = await fetch(this.refreshEndpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.refreshEndpoint.clientId,
          refresh_token: current.refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MILLISECONDS),
      })
    } catch {
      // Network-level failure says nothing about the chain — keep the record
      // and let the next call retry.
      return current.accessToken
    }
    if (!response.ok) {
      // A rejected refresh grant means the chain is revoked (rotation went
      // elsewhere or the session ended server-side): the identity is dead.
      await this.clear()
      return undefined
    }
    let body: TokenResponse
    try {
      body = await response.json() as TokenResponse
    } catch {
      return current.accessToken
    }
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      await this.clear()
      return undefined
    }
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
    await this.save({
      version: 1,
      sub: current.sub,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token !== ''
        ? body.refresh_token
        : current.refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    })
    return body.access_token
  }
}
