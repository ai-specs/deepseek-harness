#!/usr/bin/env node
/**
 * dsh-kestra-login — dsh(PC) 用户身份一次性登录（dsh.docx 统一认证：用户接入端一律
 * Authorization Code + PKCE(S256)，客户端不持有 client_secret）。
 *
 * 打开系统浏览器到 Kestra 统一 IdP 登录，本机 127.0.0.1:<port> 接收回跳换取 token，
 * 缓存到 ~/.dsh/oidc-pkce-token.json。之后 kestra-sync 插件（auth=pkce）自动续期复用。
 *
 * 用法（环境变量配置，默认值适配 dsh-monorepo compose）：
 *   DSH_KESTRA_URL=http://localhost:18080 \
 *   DSH_KESTRA_PKCE_CLIENT_ID=dsh-pc \
 *   DSH_KESTRA_PKCE_PORT=14100 \
 *   npx dsh-kestra-login
 */
import { PkceTokenProvider } from '../src/pkce.ts'

const provider = new PkceTokenProvider({
  issuer: process.env.DSH_KESTRA_URL ?? 'http://localhost:18080',
  clientId: process.env.DSH_KESTRA_PKCE_CLIENT_ID ?? 'dsh-pc',
  redirectPort: Number(process.env.DSH_KESTRA_PKCE_PORT ?? 14100),
  scopes: (process.env.DSH_KESTRA_PKCE_SCOPES ?? 'openid profile').split(',').map(s => s.trim()).filter(Boolean),
})

provider.login()
  .then((tokens) => {
    process.stdout.write(`登录成功：${tokens.sub}\ntoken 缓存已写入（kestra-sync auth=pkce 将自动复用与续期）\n`)
    process.exit(0)
  })
  .catch((error) => {
    process.stderr.write(`登录失败：${error.message}\n`)
    process.exit(1)
  })
