import { describe, expect, it } from 'vitest'

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { createTallies, name, observeEvent, projectResult } from '../src/index.ts'

/** Build a minimally-typed session event fixture; data is checked per variant. */
function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): SessionEvent {
  return { type, data, seq: 1, time: new Date() } as SessionEvent
}

describe('kestra-run observer', () => {
  it('exposes the stable plugin name', () => {
    expect(name).toBe('kestra-run')
  })

  it('counts turns, tool calls, tool errors, and token usage', () => {
    const tallies = createTallies(1_000)
    observeEvent(tallies, event('turn/start', { turn: 0 }))
    observeEvent(tallies, event('tool/call', { turn: 0, step: 0, callId: 'c1', name: 'fs/read', arguments: '{}' }))
    observeEvent(tallies, event('tool/result', { turn: 0, step: 0, message: { role: 'tool', content: [] } }))
    observeEvent(tallies, event('tool/call', { turn: 0, step: 1, callId: 'c2', name: 'web/search', arguments: '{}' }))
    observeEvent(tallies, event('tool/result', {
      turn: 0, step: 1, message: { role: 'tool', content: [] },
      error: { name: 'ToolError', code: 'FETCH_FAILED' },
    }))
    observeEvent(tallies, event('assistant/message', {
      turn: 0, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '中间答复' }] },
      usage: { inputTokens: 100, outputTokens: 20 },
    }))
    observeEvent(tallies, event('turn/start', { turn: 1 }))
    observeEvent(tallies, event('assistant/message', {
      turn: 1, step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: '最终答复' }] },
      usage: { inputTokens: 200, outputTokens: 50, totalTokens: 370 },
    }))
    observeEvent(tallies, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const result = projectResult(tallies)
    expect(result.result).toBe('最终答复')
    expect(result.success).toBe(true)
    expect(result.iterations).toBe(2)
    expect(result.toolCalls).toBe(2)
    expect(result.toolErrors).toBe(1)
    expect(result.tokenUsage).toEqual({ prompt: 300, completion: 70, total: 490 })
    expect(result.error).toBeNull()
  })

  it('marks failure from a turn error and keeps the last text', () => {
    const tallies = createTallies()
    observeEvent(tallies, event('turn/start', { turn: 0 }))
    observeEvent(tallies, event('assistant/message', {
      turn: 0, step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: '部分输出' }] },
    }))
    observeEvent(tallies, event('turn/end', {
      turn: 0,
      reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'llm unreachable' } },
    }))

    const result = projectResult(tallies)
    expect(result.success).toBe(false)
    expect(result.result).toBe('部分输出')
    expect(result.error).toBe('TIMEOUT: llm unreachable')
  })

  it('timed-out projection downgrades success and reports partial', () => {
    const tallies = createTallies()
    observeEvent(tallies, event('turn/start', { turn: 0 }))
    const result = projectResult(tallies, true)
    expect(result.success).toBe(false)
    expect(result.error).toBe('timed out (partial result)')
  })

  it('writes the result file with the AIAgent JSON contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestra-run-'))
    const file = join(dir, 'result.json')
    const tallies = createTallies()
    observeEvent(tallies, event('turn/start', { turn: 0 }))
    observeEvent(tallies, event('assistant/message', {
      turn: 0, step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    }))

    writeFileSync(file, JSON.stringify(projectResult(tallies)))
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed).toMatchObject({
      result: 'hello',
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
    })
  })
})
