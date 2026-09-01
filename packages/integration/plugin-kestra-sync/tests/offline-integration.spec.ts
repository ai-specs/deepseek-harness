/**
 * 离线能力集成测试（审查任务 4.2）：
 * 覆盖 dsh.docx 生产级联动的一次完整"断连 → 降级 → 恢复 → 补推/刷新"周期。
 * 三个插件共用注入的 fetch mock，按 URL 路由模拟 Kestra / Nacos 的可用性切换。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { KestraSessionSyncClient } from '../src/core.ts'
import { NacosConfigClient } from '../../plugin-nacos-config/src/core.ts'

const snapshot = { sessionId: 'e2e-1', phase: 'running' as const, at: '2026-01-01T00:00:00Z' }
const configYaml = 'retry:\n  maxAttempts: 4'

let kestraUp = true
let nacosUp = true
let fetchCalls: string[] = []

async function routedFetch(input: any): Promise<Response> {
  const target = String(input)
  fetchCalls.push(target)
  if (target.includes(':18080')) {
    if (!kestraUp) throw new Error('connect ECONNREFUSED')
    if (target.includes('/v3/auth/user/login')) {
      return new Response(JSON.stringify({ accessToken: 't' }), { status: 200 })
    }
    return new Response(null, { status: 200 })
  }
  if (target.includes(':8848')) {
    if (!nacosUp) throw new Error('connect timeout')
    return new Response(JSON.stringify({ code: 0, data: { content: configYaml, md5: 'cfg-md5' } }), { status: 200 })
  }
  return new Response('{}', { status: 200 })
}

let dir: string
beforeEach(() => {
  kestraUp = true
  nacosUp = true
  fetchCalls = []
  dir = mkdtempSync(join(tmpdir(), 'offline-e2e-'))
})

describe('离线能力集成（断连 → 降级 → 恢复）', () => {
  it('Kestra 停机：kestra-sync 入队落盘不丢，恢复后补推', async () => {
    kestraUp = false
    const queuePath = join(dir, 'sync-queue.jsonl')
    const sync = new KestraSessionSyncClient(
      { baseUrl: 'http://localhost:18080', token: 't', mode: 'batch', queuePath },
      routedFetch as unknown as typeof fetch,
    )
    await sync.push(snapshot)
    await sync.push({ ...snapshot, sessionId: 'e2e-2' })
    const drained = await sync.flush()
    expect(drained.every(r => !r.ok)).toBe(true)               // 停机期推送失败
    expect(existsSync(queuePath)).toBe(true)                    // 磁盘队列保留
    const lines = readFileSync(queuePath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)

    kestraUp = true
    const recovered = new KestraSessionSyncClient(
      { baseUrl: 'http://localhost:18080', token: 't', mode: 'batch', queuePath },
      routedFetch as unknown as typeof fetch,
    )
    const results = await recovered.flush()
    expect(results.filter(r => r.ok)).toHaveLength(2)           // 恢复后补推成功
    expect(readFileSync(queuePath, 'utf8').trim()).toBe('')     // 队列清空
  })

  it('Nacos 停机：nacos-config 降级读磁盘缓存；恢复后自动刷新', async () => {
    nacosUp = true
    const cacheDir = join(dir, 'config-cache')
    const warm = new NacosConfigClient(
      { server: 'http://localhost:8848', cacheDir, username: 'n', password: 'p' },
      routedFetch as unknown as typeof fetch,
    )
    await warm.refreshAll()
    expect(warm.getCached<any>('dsh-fault-tolerance.yaml')?.retry?.maxAttempts).toBe(4)

    nacosUp = false
    const degraded = new NacosConfigClient(
      { server: 'http://localhost:8848', cacheDir, username: 'n', password: 'p' },
      routedFetch as unknown as typeof fetch,
    )
    await degraded.refreshAll()                                  // 不崩溃
    expect(degraded.getCached<any>('dsh-fault-tolerance.yaml')?.retry?.maxAttempts).toBe(4) // 磁盘缓存兜底

    nacosUp = true
    const recovered = new NacosConfigClient(
      { server: 'http://localhost:8848', cacheDir, username: 'n', password: 'p' },
      routedFetch as unknown as typeof fetch,
    )
    await recovered.refreshAll()
    expect(recovered.getCached<any>('dsh-fault-tolerance.yaml')?.retry?.maxAttempts).toBe(4) // 恢复后刷新
  })

})
