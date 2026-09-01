import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { KestraSessionSyncClient } from '../src/core.ts'

const snapshot = { sessionId: 's-1', phase: 'running' as const, at: '2026-01-01T00:00:00Z' }

let queueDir: string
beforeEach(() => {
  queueDir = mkdtempSync(join(tmpdir(), 'sync-queue-'))
})

function newClient(failing: boolean): KestraSessionSyncClient {
  const fetchImpl = vi.fn().mockImplementation(async () => {
    if (failing) throw new Error('connection refused')
    return new Response(null, { status: 200 })
  })
  return new KestraSessionSyncClient(
    { baseUrl: 'http://k.test', token: 't', mode: 'batch', queuePath: join(queueDir, 'q.jsonl') },
    fetchImpl as unknown as typeof fetch,
  )
}

describe('队列磁盘持久化（审查任务 1.3）', () => {
  it('enqueue persists snapshots to disk; flush empties the file', async () => {
    const client = newClient(false)
    await client.push({ ...snapshot, sessionId: 'a' })
    await client.push({ ...snapshot, sessionId: 'b' })
    const qf = join(queueDir, 'q.jsonl')
    expect(readFileSync(qf, 'utf8').trim().split('\n')).toHaveLength(2)
    await client.flush()
    expect(readFileSync(qf, 'utf8').trim()).toBe('')
  })

  it('a restarted client recovers pending snapshots from disk', async () => {
    const writer = newClient(true)
    await writer.push({ ...snapshot, sessionId: 'a' })
    await writer.push({ ...snapshot, sessionId: 'b' })
    await writer.flush() // Kestra 不可用：入队失败但磁盘保留

    const recovered = newClient(false) // 模拟重启（Kestra 已恢复）
    const results = await recovered.flush()
    expect(results.filter(r => r.ok)).toHaveLength(2)
    expect(existsSync(join(queueDir, 'q.jsonl'))).toBe(true) // 文件保留（清空后为空文件）
  })

  it('caps the queue at 1000 and drops the oldest', async () => {
    const client = newClient(true)
    for (let i = 0; i < 1001; i++) {
      await client.push({ ...snapshot, sessionId: `s-${i}`, at: String(i) })
    }
    const lines = readFileSync(join(queueDir, 'q.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1000)
    expect(JSON.parse(lines[0]).sessionId).toBe('s-1') // 最旧的 s-0 被丢弃
  })
})
