/** SessionIndex 持久化：会话在 PC 重启后仍可被手机端查到（选项 B 查询面）。 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionIndex, deriveHistory } from '../src/core.ts'

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-index-'))
  return join(dir, 'session-index.json')
}

describe('SessionIndex 持久化（PC 重启恢复）', () => {
  it('record 写入后 dispose → 新实例 load 恢复会话', () => {
    const file = tempFile()
    const a = new SessionIndex(file)
    a.record({ sessionId: 'h-1', phase: 'completed', prompt: '帮我查订单', result: '订单已查' })
    a.dispose()

    const b = new SessionIndex(file)
    const detail = b.get('h-1')
    expect(detail).toBeDefined()
    expect(detail?.phase).toBe('completed')
    expect(detail?.title).toContain('帮我查订单')
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

  it('按 history seq 返回首次全量与后续增量消息', () => {
    const a = new SessionIndex()
    a.record({ sessionId: 'phone-seq', phase: 'completed', prompt: '首问', result: '首答' })
    a.record({ sessionId: 'phone-seq', phase: 'completed', prompt: '追问', result: '追答' })

    expect(a.messages('phone-seq', 0)).toMatchObject({
      nextSeq: 4,
      messages: [
        { seq: 1, role: 'user', text: '首问' },
        { seq: 2, role: 'assistant', text: '首答' },
        { seq: 3, role: 'user', text: '追问' },
        { seq: 4, role: 'assistant', text: '追答' },
      ],
    })
    expect(a.messages('phone-seq', 2)).toMatchObject({
      nextSeq: 4,
      messages: [
        { seq: 3, role: 'user', text: '追问' },
        { seq: 4, role: 'assistant', text: '追答' },
      ],
    })
    expect(a.messages('phone-seq', 99)).toMatchObject({ nextSeq: 4, messages: [] })
    expect(a.messages('missing', 0)).toBeUndefined()
    a.dispose()
  })

  it('list 按时间线增量返回且投影不含聊天记录', async () => {
    const a = new SessionIndex()
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
    a.record({ sessionId: 'l1', phase: 'completed', prompt: 'q1', result: 'r1' })
    await sleep(3)
    a.record({ sessionId: 'l2', phase: 'RUNNING', prompt: 'q2' })
    await sleep(3)
    const since = (a.get('l2') as { updatedAt: string }).updatedAt
    a.record({ sessionId: 'l3', phase: 'completed', prompt: 'q3', result: 'r3' })

    const full = a.list()
    expect(full.map(s => s.sessionId)).toEqual(['l3', 'l2', 'l1'])
    // 列表投影是会话元数据：聊天记录（state.history）不得随列表下发。
    for (const item of full) expect(item.state).toBeUndefined()

    expect(a.list(since).map(s => s.sessionId)).toEqual(['l3'])
    expect(a.list('9999-01-01T00:00:00.000Z')).toEqual([])
    a.dispose()
  })

  it('指令受理即登记 RUNNING 占位，终态 record 不重复追加用户消息', () => {
    const a = new SessionIndex()
    a.record({ sessionId: 'phone-run', phase: 'RUNNING', prompt: '启动' })
    expect(a.messages('phone-run', 0)).toMatchObject({
      phase: 'RUNNING',
      nextSeq: 1,
      messages: [{ seq: 1, role: 'user', text: '启动' }],
    })
    a.record({ sessionId: 'phone-run', phase: 'completed', prompt: '启动', result: '完成' })
    expect(a.messages('phone-run', 0)).toMatchObject({
      phase: 'completed',
      nextSeq: 2,
      messages: [
        { seq: 1, role: 'user', text: '启动' },
        { seq: 2, role: 'assistant', text: '完成' },
      ],
    })
    expect(a.messages('phone-run', 1)).toMatchObject({
      messages: [{ seq: 2, role: 'assistant', text: '完成' }],
    })
    a.dispose()
  })

  it('derivedHistory 权威覆盖：PC web 直发轮次进入手机增量流', () => {
    const a = new SessionIndex()
    // 旧路径累计的远程轮次（手机游标消费到 seq 2）
    a.record({ sessionId: 's-relay', phase: 'RUNNING', prompt: 'Q1' })
    a.record({ sessionId: 's-relay', phase: 'completed', prompt: 'Q1', result: 'A1' })
    expect((a.messages('s-relay', 0) as { nextSeq: number }).nextSeq).toBe(2)

    // PC web 在同一会话直发一轮（仅存在于 agent 会话），随后下一次远程回合终态
    // 携带完整派生历史（含 web 轮）作为权威记录。
    a.record({
      sessionId: 's-relay',
      phase: 'completed',
      prompt: 'Q2',
      result: 'A2',
      derivedHistory: [
        { role: 'user', text: 'Q1' },
        { role: 'assistant', text: 'A1' },
        { role: 'user', text: 'PC-web Q' },
        { role: 'assistant', text: 'PC-web A' },
        { role: 'user', text: 'Q2' },
        { role: 'assistant', text: 'A2' },
      ],
    })
    expect(a.messages('s-relay', 2)).toMatchObject({
      nextSeq: 6,
      messages: [
        { seq: 3, role: 'user', text: 'PC-web Q' },
        { seq: 4, role: 'assistant', text: 'PC-web A' },
        { seq: 5, role: 'user', text: 'Q2' },
        { seq: 6, role: 'assistant', text: 'A2' },
      ],
    })

    // 派生历史已含本回合时按末位去重，不重复追加；空派生历史回退旧累计。
    a.record({
      sessionId: 's-relay',
      phase: 'completed',
      prompt: 'Q3',
      result: 'A3',
      derivedHistory: [
        { role: 'user', text: 'Q1' },
        { role: 'assistant', text: 'A1' },
        { role: 'user', text: 'PC-web Q' },
        { role: 'assistant', text: 'PC-web A' },
        { role: 'user', text: 'Q2' },
        { role: 'assistant', text: 'A2' },
        { role: 'user', text: 'Q3' },
        { role: 'assistant', text: 'A3' },
      ],
    })
    expect(a.messages('s-relay', 6)).toMatchObject({
      nextSeq: 8,
      messages: [
        { seq: 7, role: 'user', text: 'Q3' },
        { seq: 8, role: 'assistant', text: 'A3' },
      ],
    })
    a.record({ sessionId: 's-relay', phase: 'RUNNING', prompt: 'Q4' })
    expect(a.messages('s-relay', 8)).toMatchObject({
      nextSeq: 9,
      messages: [{ seq: 9, role: 'user', text: 'Q4' }],
    })
    a.dispose()
  })

  it('deriveHistory 过滤插件注入的 runtime-context user 消息', () => {
    expect(deriveHistory([
      { role: 'user', content: '真实问题' },
      { role: 'user', content: 'Current runtime context: ...', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
      { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
      { role: 'assistant', content: [{ type: 'tool_call', name: 'bash' }] },
    ])).toEqual([
      { role: 'user', text: '真实问题' },
      { role: 'assistant', text: '回答' },
    ])
  })

  it('messages 响应携带前缀指纹（游标自愈依据）', () => {
    const a = new SessionIndex()
    a.record({ sessionId: 'pf', phase: 'completed', prompt: 'Q1', result: 'A1' })
    expect(a.messages('pf', 1)).toMatchObject({ prefix: { role: 'user', len: 2, head: 'Q1' } })
    expect(a.messages('pf', 2)).toMatchObject({ prefix: { role: 'assistant', len: 2, head: 'A1' } })
    expect((a.messages('pf', 0) as Record<string, unknown>).prefix).toBeUndefined()
    a.dispose()
  })
})

function dirnameOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}
