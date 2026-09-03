#!/usr/bin/env node
/**
 * dsh-kestra-daemon — dsh(PC) 用户身份常驻接入进程（dsh.docx：会话执行权在 dsh(PC)）。
 *
 * 职责：
 *   1. 用缓存/浏览器 PKCE 登录（Authorization Code + PKCE(S256)，客户端 dsh-pc，无 secret）；
 *   2. 轮询本用户名下会话的 pending_input（手机端 dsh-ui 写入的待处理输入）；
 *   3. 原子消费后 spawn headless dsh 接力执行，会话 RUNNING→COMPLETED/FAILED 回推
 *      （终态会话派生新会话，state.parentSessionId 关联）。
 *
 * 这正是「手机端输入 → PC 执行 → 手机端轮询看到回复」链路的 PC 侧。
 * 与 kestra-sync 插件（auth=pkce, pollRemoteInputs=true）同一套实现：插件形态运行在
 * dsh 交互会话内，本 daemon 形态独立常驻。
 *
 * 用法：
 *   DSH_KESTRA_URL=http://localhost:18080 npx dsh-kestra-daemon
 */
import { KestraSessionSyncClient } from '../src/core.ts'
import { executeRemoteInput } from '../src/index.ts'

const issuer = process.env.DSH_KESTRA_URL ?? 'http://localhost:18080'

const client = new KestraSessionSyncClient({
  baseUrl: issuer,
  auth: 'pkce',
  pkce: {
    issuer,
    clientId: process.env.DSH_KESTRA_PKCE_CLIENT_ID ?? 'dsh-pc',
    redirectPort: Number(process.env.DSH_KESTRA_PKCE_PORT ?? 14100),
    scopes: (process.env.DSH_KESTRA_PKCE_SCOPES ?? 'openid profile').split(',').map(s => s.trim()).filter(Boolean),
  },
  pollRemoteInputs: true,
  pollIntervalMs: Number(process.env.DSH_KESTRA_POLL_MS ?? 5000),
  remoteInputTimeoutSeconds: Number(process.env.DSH_KESTRA_REMOTE_TIMEOUT ?? 300),
})

client.startInputPoller(
  (input) => executeRemoteInput(client, input, { timeoutSeconds: Number(process.env.DSH_KESTRA_REMOTE_TIMEOUT ?? 300) }),
  (sub) => process.stdout.write(`[dsh-daemon] PC online as ${sub}\n`),
)
process.stdout.write(`[dsh-daemon] polling remote inputs on ${issuer} every ${process.env.DSH_KESTRA_POLL_MS ?? 5000}ms\n`)

process.on('SIGINT', () => {
  client.dispose()
  process.exit(0)
})
