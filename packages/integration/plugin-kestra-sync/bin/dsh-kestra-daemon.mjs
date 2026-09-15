#!/usr/bin/env node
/**
 * dsh-kestra-daemon — dsh(PC) 用户身份常驻接入进程（dsh.docx：会话执行权在 dsh(PC)）。
 *
 * 职责：
 *   1. 用缓存/浏览器 PKCE 登录（Authorization Code + PKCE(S256)，客户端 dsh-pc，无 secret）；
 *   2. SSE 订阅中台 relay/events（选项 B 主链路），实时接收手机端 dsh-ui 指令；
 *   3. 经 executeRemoteInput spawn headless dsh 接力执行，终态写本地 SessionIndex；
 *   4. 应答中台转发的会话查询（session.list / session.detail）——查询数据源为
 *      本地 SessionIndex（快照持久化 ~/.dsh/kestra-session-index.json，PC 重启后
 *      headless 派生会话仍可被手机端查到）。
 *
 * 这正是「手机端输入 → PC 执行 → 手机端查询看到回复」链路的 PC 侧（无 UI 形态）。
 * 与 kestra-sync 插件（auth=pkce）同一套实现：插件形态运行在 dsh 交互会话内
 * （web-identity），本 daemon 形态独立常驻（PKCE）。两者按用户互斥（PKCE 缓存
 * 轮换吊销会互相打断），同一台机器同一用户只跑其一。
 *
 * 用法（先构建插件 lib，再运行）：
 *   pnpm run build:lib:host   # 生成 packages/integration/plugin-kestra-sync/lib/
 *   DSH_KESTRA_URL=http://localhost:18080 npx dsh-kestra-daemon
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
// 编译产物（lib/index.js）：daemon 与部署一致运行编译后的插件公共 API
// （SessionIndex 由 src/index.ts 公共 re-export）。
import { KestraSessionSyncClient, SessionIndex, executeRemoteInput } from '../lib/index.js'

const issuer = process.env.DSH_KESTRA_URL ?? 'http://localhost:18080'
const timeoutSeconds = Number(process.env.DSH_KESTRA_REMOTE_TIMEOUT ?? 300)

const client = new KestraSessionSyncClient({
  baseUrl: issuer,
  auth: 'pkce',
  pkce: {
    issuer,
    clientId: process.env.DSH_KESTRA_PKCE_CLIENT_ID ?? 'dsh-pc',
    redirectPort: Number(process.env.DSH_KESTRA_PKCE_PORT ?? 14100),
    scopes: (process.env.DSH_KESTRA_PKCE_SCOPES ?? 'openid profile').split(',').map(s => s.trim()).filter(Boolean),
    ...(process.env.DSH_KESTRA_PKCE_CACHE ? { cachePath: process.env.DSH_KESTRA_PKCE_CACHE } : {}),
  },
  remoteInputTimeoutSeconds: timeoutSeconds,
})

// 本地会话索引（选项 B 查询面）：headless 派生会话终态回调写入，快照持久化。
const index = new SessionIndex(join(homedir(), '.dsh', 'kestra-session-index.json'))

// 串行执行链：同一时刻至多一个 headless 子进程（与 web 形态一致）。
const chain = { p: Promise.resolve() }
const handleRemoteInput = (input) => {
  chain.p = chain.p
    .then(() => executeRemoteInput(client, input, {
      timeoutSeconds,
      // 追问的父会话 phase 从本地索引读取（会话数据权威在 PC）。
      getPhase: sessionId => String(index.get(sessionId)?.phase ?? '') || undefined,
    }, info => index.record(info)))
    .catch(() => {})
  return chain.p
}

// 查询应答：session.list → 索引列表；session.detail → 索引详情（未命中回填 error）。
const handleQuery = (query) => {
  process.stderr.write(`[dsh-daemon] query received: ${query.type} rid=${query.requestId}${query.sessionId ? ` sid=${query.sessionId}` : ''}\n`)
  if (query.type === 'session.detail' && query.sessionId !== undefined) {
    const detail = index.get(query.sessionId)
    return detail === undefined
      ? client.fillQueryResult(query.requestId, query.type, undefined, 'session not found on PC')
      : client.fillQueryResult(query.requestId, query.type, detail)
  }
  return client.fillQueryResult(query.requestId, query.type, index.list())
}

client.startInputSse(
  handleRemoteInput,
  sub => process.stdout.write(`[dsh-daemon] PC online via SSE as ${sub}\n`),
  { queryHandler: handleQuery },
)
process.stdout.write(`[dsh-daemon] SSE subscribed on ${issuer}\n`)

process.on('SIGINT', () => {
  client.dispose()
  index.dispose()
  process.exit(0)
})
process.on('SIGTERM', () => {
  client.dispose()
  index.dispose()
  process.exit(0)
})
process.once('exit', () => index.dispose())
