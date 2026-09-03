/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { BrowserAuth } from './browser-auth.ts'
import { OidcBrowserAuth } from './oidc-browser-auth.ts'
import { WebIdentityService } from './web-identity.ts'
import { HostConnectionService } from './rpc-host.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject = ['webServer', 'credentials']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by; the Web runtime derives LAN IP literals from an active all-interface
   * bind. An entry that is not a bare, canonical authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
  /**
   * Browser bootstrap strategy. `launch-token` (default) authenticates the
   * first browser through the console-printed `?token=` URL; `oidc` redirects
   * unauthenticated browsers to the Kestra IdP (Authorization Code + PKCE,
   * public client) instead — the unified-identity deployment where the console
   * is not read by the person at the browser. Local session storage is the
   * data plane in both modes (本地为主，远程同步为辅).
   */
  auth?: 'launch-token' | 'oidc'
  /** Required when `auth` is `oidc`. */
  oidc?: {
    /** Browser-facing IdP base URL (authorize/login redirects). */
    issuerBrowserUrl: string
    /** Server-facing IdP base URL for the code exchange; defaults to the browser URL. */
    issuerServerUrl?: string
    /** Public PKCE client id carrying the browser sign-in (e.g. `dsh-pc`). */
    clientId: string
    /** Callback path; must be registered on the IdP client. Default `/oidc/callback`. */
    callbackPath?: string
    /** Authorize scope. Default `openid profile`. */
    scope?: string
  }
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  auth: z.union(['launch-token', 'oidc']).default('launch-token'),
  // auth='oidc' 时 issuerBrowserUrl/clientId 必填——缺席在 apply() 里报错，
  // 而不是让半配置的部署在首个浏览器请求时才失败。
  oidc: z.object({
    issuerBrowserUrl: z.string(),
    issuerServerUrl: z.string(),
    clientId: z.string(),
    callbackPath: z.string().default('/oidc/callback'),
    scope: z.string().default('openid profile'),
  }),
})

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the Host/Origin browser-trust fence and persistent browser
 * authentication before dispatch.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const auth = config?.auth ?? 'launch-token'
  let oidcConfig: NonNullable<ConnectionConfig['oidc']> | undefined
  if (auth === 'oidc') {
    const oidc = config?.oidc
    if (oidc === undefined || !oidc.issuerBrowserUrl || !oidc.clientId) {
      throw new Error('client-connection: auth="oidc" requires the oidc.issuerBrowserUrl and oidc.clientId settings')
    }
    oidcConfig = oidc
  }
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  let webIdentity: WebIdentityService | undefined
  let browserAuth: BrowserAuth | OidcBrowserAuth
  if (oidcConfig !== undefined) {
    webIdentity = new WebIdentityService(ctx, {
      url: new URL('/oidc/token', oidcConfig.issuerServerUrl ?? oidcConfig.issuerBrowserUrl).toString(),
      clientId: oidcConfig.clientId,
    })
    await webIdentity.ensureLoaded()
    browserAuth = await OidcBrowserAuth.create(ctx.credentials, {
      issuerBrowserUrl: oidcConfig.issuerBrowserUrl,
      issuerServerUrl: oidcConfig.issuerServerUrl,
      clientId: oidcConfig.clientId,
      callbackPath: oidcConfig.callbackPath,
      scope: oidcConfig.scope,
    }, cookieMaxAgeDays, webIdentity)
  } else {
    browserAuth = await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays)
  }
  const connection = new HostConnectionService(ctx, trustedHosts, browserAuth)
  const fetchHandler = connection.createSharedFetchHandler(API_PATH)
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  if (browserAuth instanceof OidcBrowserAuth) {
    // The IdP bounces the user's tab back here with ?code=&state=; the strategy
    // owns the whole response (exchange, cookie mint, redirect to /).
    const callbackRoute: WebRoute = {
      kind: 'exact',
      path: browserAuth.callbackPath,
      handler: (req, res) => { void browserAuth.handleCallback(req, res) },
    }
    ctx.effect(() => ctx.webServer.register(callbackRoute), 'client-connection: oidc callback route')
  }
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
