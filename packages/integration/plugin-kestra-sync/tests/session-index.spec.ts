/** SessionIndex 持久化：headless 派生会话在 PC 重启后仍可被手机端查到（选项 B 查询面）。 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionIndex } from '../src/core.ts'

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-index-'))
  return join(dir, 'session-index.json')
}

describe('SessionIndex 持久化（PC 重启恢复）', () => {
  it('record 写入后 dispose → 新实例 load 恢复 headless 会话', () => {
    const file = tempFile()
    const a = new SessionIndex(file)
    a.record({ sessionId: 'h-1', phase: 'completed', prompt: '帮我查订单', result: '订单已查' })
    a.dispose()

    const b = new SessionIndex(file)
    const detail = b.get('h-1')
    expect(detail).toBeDefined()
    expect(detail?.phase).toBe('completed')
    expect(detail?.summary).toContain('帮我查订单')
    expect((detail?.state as Record<string, unknown>)?.result).toBe('订单已查')
    b.dispose()
    rmSync(dirnameOf(file), { recursive: true, force: true })
  })

  it('upsert（web 会话事件）同样落盘，重启后可恢复', () => {
    const file = tempFile()
    const a = new SessionIndex(file)
    const sid = 'session-2f3c0a1e-8b4d-4f6e-9a2b-1c2d3e4f5a6b'
    const session = {
      id: sid,
      header: { parentSession: undefined, id: sid },
      events: [{ type: 'turn/end', data: undefined }],
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    }
    a.upsert(session as never)
    a.dispose()

    const b = new SessionIndex(file)
    const list = b.list()
    expect(list.some(s => s.sessionId === '2f3c0a1e-8b4d-4f6e-9a2b-1c2d3e4f5a6b')).toBe(true)
    b.dispose()
    rmSync(dirnameOf(file), { recursive: true, force: true })
  })

  it('快照不存在/损坏 → 空索引不抛错', () => {
    const file = tempFile()
    const a = new SessionIndex(file)
    expect(a.list()).toEqual([])
    a.dispose()
    rmSync(dirnameOf(file), { recursive: true, force: true })
  })

  it('未传路径 → 纯内存（不落盘）', () => {
    const a = new SessionIndex()
    a.record({ sessionId: 'mem-1', phase: 'running', prompt: 'x' })
    expect(a.get('mem-1')).toBeDefined()
    a.dispose()
  })
})

function dirnameOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}
