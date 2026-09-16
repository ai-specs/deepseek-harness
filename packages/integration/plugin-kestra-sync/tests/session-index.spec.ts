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

  it('外部会话映射到 headless 会话后，列表只暴露外部会话且追问保留首问标题', () => {
    const a = new SessionIndex()
    a.record({ sessionId: 'phone-1', phase: 'completed', prompt: '首问', result: '首答', headlessSessionId: 'headless-1' })
    a.record({ sessionId: 'headless-1', phase: 'completed', prompt: '首问', result: '首答' })
    a.record({ sessionId: 'phone-1', phase: 'completed', prompt: '追问', result: '追答', headlessSessionId: 'headless-1' })

    expect(a.list().map(session => session.sessionId)).toEqual(['phone-1'])
    expect(a.get('phone-1')?.summary).toBe('首问')
    expect((a.get('phone-1')?.state as Record<string, unknown>).prompt).toBe('追问')
    expect((a.get('phone-1')?.state as Record<string, unknown>).history).toEqual([
      { role: 'user', text: '首问' },
      { role: 'assistant', text: '首答' },
      { role: 'user', text: '追问' },
      { role: 'assistant', text: '追答' },
    ])
    a.dispose()
  })

  it('列表隐藏带 session- 前缀的内部 headless 会话', () => {
    const a = new SessionIndex()
    const internal = 'session-64ecd3fd-146e-42bf-80c7-27f1f291082a'
    a.record({ sessionId: 'phone-2', phase: 'completed', prompt: '首问', result: '首答', headlessSessionId: internal })
    a.record({ sessionId: '64ecd3fd-146e-42bf-80c7-27f1f291082a', phase: 'completed', prompt: '首问', result: '首答' })
    expect(a.list().map(session => session.sessionId)).toEqual(['phone-2'])
    a.dispose()
  })

  it('记录并保留手机会话的工作区最小投影', () => {
    const a = new SessionIndex()
    a.record({
      sessionId: 'phone-workspace', phase: 'completed', prompt: '首问', result: '首答',
      workspace: { workspaceId: 'workspace-1', title: '研发平台' },
    })
    a.record({ sessionId: 'phone-workspace', phase: 'completed', prompt: '追问', result: '追答' })
    expect(a.get('phone-workspace')?.workspace).toEqual({ workspaceId: 'workspace-1', title: '研发平台' })
    a.dispose()
  })
})

function dirnameOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}
