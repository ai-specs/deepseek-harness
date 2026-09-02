/**
 * dsh(PC) 用户身份登录 — OIDC Authorization Code + PKCE(S256)（dsh.docx 统一认证：
 * 用户接入端一律 PKCE，客户端不持有 client_secret）。
 *
 * 流程（RFC 8252 loopback）：本机起临时 HTTP 监听 127.0.0.1:<port> → 打开系统浏览器到
 * IdP /oidc/authorize（带 code_challenge）→ 用户在 IdP 登录 → 重定向回 loopback
 * /callback?code= → 本地用 code_verifier 换 token（无 secret）→ 缓存到
 * ~/.dsh/oidc-pkce-token.json（含 refresh_token，过期前自动续）。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface PkceConfig {
  /** IdP 基地址（Kestra OIDC Provider 对 PC 可达的地址）。 */
  issuer: string
  /** 公开客户端 id（migration 2.0.28 种子的 dsh-pc）。 */
  clientId: string
  /** loopback 回跳端口（redirect_uri=http://127.0.0.1:<port>/callback）。 */
  redirectPort: number
  /** 授权 scope。 */
  scopes: string[]
  /** token 缓存路径（默认 ~/.dsh/oidc-pkce-token.json）。 */
  cachePath?: string
  /** 测试注入：跳过真实浏览器打开。 */
  openUrl?: (url: string) => void
  /** 测试注入：fetch 实现。 */
  fetchImpl?: typeof fetch
  /** 测试注入：now。 */
  now?: () => number
}

export interface PkceTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  sub: string
}

/** 默认缓存路径（每个 OS 用户一份）。 */
export function defaultCachePath(): string {
  return join(homedir(), '.dsh', 'oidc-pkce-token.json')
}

/** PKCE code_verifier → S256 challenge（RFC 7636 §4.2）。 */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** 生成 43-128 字符的 code_verifier。 */
export function createVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/** 纯函数：构造授权端点 URL（无 secret —— 公开客户端）。 */
export function buildAuthorizeUrl(config: PkceConfig, verifier: string, state: string, port: number): string {
  const url = new URL('/oidc/authorize', config.issuer)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`)
  url.searchParams.set('scope', config.scopes.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** 纯函数：构造 token 请求（公开客户端：client_id 进 body，无 Basic 认证）。 */
export function buildTokenRequest(config: PkceConfig, fields: Record<string, string>): { url: string; init: RequestInit } {
  return {
    url: new URL('/oidc/token', config.issuer).toString(),
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, ...fields }).toString(),
      signal: AbortSignal.timeout(10_000),
    },
  }
}

/** 纯函数：解析 id_token 的 sub（不验签 —— 展示与归属展示用；归属鉴权在 Kestra 端）。 */
export function subFromIdToken(idToken: string | undefined): string {
  try {
    const payload = String(idToken ?? '').split('.')[1] ?? ''
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof json.sub === 'string' ? json.sub : ''
  } catch {
    return ''
  }
}

function openBrowser(url: string): void {
  const launcher = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(launcher, args, { stdio: 'ignore', detached: true })
  child.unref()
}

/** 等 System 起一次性 loopback 监听，解析回跳 query。 */
function waitForCallback(port: number, expectedState: string, timeoutMs = 120_000): Promise<URL> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('PKCE login timed out waiting for the browser redirect'))
    }, timeoutMs)
    const onRequest = (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>dsh 登录</title><body style="font-family:sans-serif;padding:2rem"><h3>dsh 登录完成</h3><p>已收到授权响应，可以关闭此页面回到终端。</p></body>')
      server.close()
      clearTimeout(timer)
      const error = url.searchParams.get('error')
      if (error) {
        reject(new Error(`authorization failed: ${error} (${url.searchParams.get('error_description') ?? ''})`))
        return
      }
      if (url.searchParams.get('state') !== expectedState) {
        reject(new Error('state mismatch on the loopback redirect'))
        return
      }
      resolve(url)
    }
    const server = createServer(onRequest)
    server.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`loopback listener on 127.0.0.1:${port} failed: ${(e as Error).message}`))
    })
    server.listen(port, '127.0.0.1')
  })
}

function readCache(cachePath: string): PkceTokens | undefined {
  try {
    if (!existsSync(cachePath)) return undefined
    return JSON.parse(readFileSync(cachePath, 'utf8')) as PkceTokens
  } catch {
    return undefined
  }
}

function writeCache(cachePath: string, tokens: PkceTokens): void {
  mkdirSync(join(cachePath, '..'), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

/** PKCE token 提供者：缓存命中→续期→重新登录 的三级取票路径。 */
export class PkceTokenProvider {
  private readonly cachePath: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private inflight: Promise<string> | undefined

  constructor(private readonly config: PkceConfig) {
    this.cachePath = config.cachePath ?? defaultCachePath()
    this.fetchImpl = config.fetchImpl ?? fetch
    this.now = config.now ?? Date.now
  }

  /** 当前用户（缓存中的 sub），供 UI/日志展示。 */
  currentSub(): string {
    return readCache(this.cachePath)?.sub ?? ''
  }

  logout(): void {
    rmSync(this.cachePath, { force: true })
  }

  /** 取一个有效 access token：缓存未过期直接用；临期/失效先 refresh；都失败则重新登录。 */
  async getToken(forceRefresh = false): Promise<string> {
    this.inflight ??= (async () => {
      const cached = readCache(this.cachePath)
      if (cached && !forceRefresh && cached.expiresAt > this.now() + 60_000) return cached.accessToken
      if (cached?.refreshToken) {
        try {
          const refreshed = await this.refresh(cached.refreshToken)
          return refreshed.accessToken
        } catch {
          // refresh 失效（旋转后旧票/撤销）→ 重新走授权码
        }
      }
      const fresh = await this.login()
      return fresh.accessToken
    })()
    try {
      return await this.inflight
    } finally {
      this.inflight = undefined
    }
  }

  /** 完整授权码 + PKCE 登录：起 loopback、开浏览器、换票、写缓存。 */
  async login(): Promise<PkceTokens> {
    const port = this.config.redirectPort
    const verifier = createVerifier()
    const state = randomBytes(16).toString('hex')
    const authorizeUrl = buildAuthorizeUrl(this.config, verifier, state, port)

    const callbackPromise = waitForCallback(port, state)
    const opener = this.config.openUrl ?? openBrowser
    opener(authorizeUrl)
    process.stderr.write(`[kestra-sync] PKCE login: browser opened (${authorizeUrl}); waiting on http://127.0.0.1:${port}/callback\n`)

    const callback = await callbackPromise
    const code = callback.searchParams.get('code') ?? ''
    const tokens = await this.exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: `http://127.0.0.1:${port}/callback` })
    process.stderr.write(`[kestra-sync] PKCE login ok: sub=${tokens.sub}\n`)
    return tokens
  }

  private async refresh(refreshToken: string): Promise<PkceTokens> {
    return this.exchange({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  private async exchange(fields: Record<string, string>): Promise<PkceTokens> {
    const { url, init } = buildTokenRequest(this.config, fields)
    const response = await this.fetchImpl(url, init)
    if (!response.ok) {
      throw new Error(`token endpoint failed (${response.status}): ${await response.text().catch(() => '')}`)
    }
    const payload = (await response.json()) as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number }
    const tokens: PkceTokens = {
      accessToken: payload.access_token,
      expiresAt: this.now() + (payload.expires_in ?? 3600) * 1000,
      sub: subFromIdToken(payload.id_token),
    }
    if (payload.refresh_token !== undefined) tokens.refreshToken = payload.refresh_token
    writeCache(this.cachePath, tokens)
    return tokens
  }
}
