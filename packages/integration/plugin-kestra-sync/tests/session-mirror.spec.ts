/** Session mirror pure derivations: wire id mapping, phase mapping, state folding, terminal freeze. */

import { describe, expect, it, vi } from 'vitest'
import { SessionMirror, deriveSessionPhaseFromLog, deriveSyncPhase, foldSyncState, wireSessionId, type MirrorSession, type PushResult, type SessionSnapshot } from '../src/core.ts'

type PushMock = (snapshot: SessionSnapshot) => Promise<PushResult>

const UUID_A = 'f0bd69a0-da2d-4f0d-b155-be899c7ea237'
const UUID_B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function session(input: {
  id: string
  parentSession?: string
  messages?: Array<{ role: string; content: unknown }>
  events?: Array<{ type: string; data?: unknown }>
}): MirrorSession {
  return {
    id: input.id,
    header: input.parentSession === undefined ? {} : { parentSession: input.parentSession },
    deriveMessages: () => input.messages ?? [],
    ...(input.events === undefined ? {} : { events: input.events }),
  }
}

describe('wireSessionId', () => {
  it('strips the local session- prefix from UUID ids', () => {
    expect(wireSessionId(`session-${UUID_A}`)).toBe(UUID_A)
    expect(wireSessionId(UUID_A)).toBe(UUID_A)
  })

  it('returns undefined for non-UUID local ids', () => {
    expect(wireSessionId('session-1')).toBeUndefined()
    expect(wireSessionId('session-not-a-uuid')).toBeUndefined()
  })
})

describe('deriveSyncPhase', () => {
  it('maps lifecycle events to remote phases', () => {
    expect(deriveSyncPhase('session/created')).toBe('running')
    expect(deriveSyncPhase('turn/start')).toBe('running')
  })

  it('maps turn end reason kinds to terminal phases', () => {
    expect(deriveSyncPhase('turn/end', 'completed')).toBe('completed')
    expect(deriveSyncPhase('turn/end', 'aborted')).toBe('completed')
    expect(deriveSyncPhase('turn/end', 'error')).toBe('failed')
  })

  it('ignores unrelated events', () => {
    expect(deriveSyncPhase('user/message')).toBeUndefined()
    expect(deriveSyncPhase('assistant/chunk')).toBeUndefined()
    expect(deriveSyncPhase('step/end')).toBeUndefined()
  })
})

describe('foldSyncState', () => {
  it('keeps the first user prompt and the latest assistant result', () => {
    const state = foldSyncState([
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '答一' }] },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '答二' }] },
    ])
    expect(state).toEqual({ prompt: '第一问', result: '答二' })
  })

  it('skips messages without visible text', () => {
    const state = foldSyncState([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'ls', arguments: '{}' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] },
      { role: 'user', content: [{ type: 'text', text: '  ' }] },
    ])
    expect(state).toEqual({})
  })

  it('joins split text blocks and accepts plain string content', () => {
    expect(foldSyncState([
      { role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'text', text: '，世界' }] },
    ])).toEqual({ prompt: '你好，世界' })
    expect(foldSyncState([{ role: 'user', content: 'plain' }])).toEqual({ prompt: 'plain' })
  })
})

describe('deriveSessionPhaseFromLog', () => {
  it('derives the phase from the last turn edge', () => {
    expect(deriveSessionPhaseFromLog([])).toBe('running')
    expect(deriveSessionPhaseFromLog([
      { type: 'turn/start', data: { turn: 0 } },
      { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
      { type: 'user/message', data: {} },
    ])).toBe('completed')
    expect(deriveSessionPhaseFromLog([
      { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 1 } },
    ])).toBe('running')
    expect(deriveSessionPhaseFromLog([
      { type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { message: 'x', code: 'U' } } } },
    ])).toBe('failed')
  })
})

describe('SessionMirror', () => {
  function harness() {
    const pushes: SessionSnapshot[] = []
    const push: PushMock = async (snapshot) => {
      pushes.push(snapshot)
      const result: PushResult = { ok: true, status: 200, sessionId: snapshot.sessionId, phase: snapshot.phase }
      return result
    }
    const client = { push: vi.fn(push), currentSub: () => 'alice@kestra.io' }
    return { mirror: new SessionMirror(client), pushes, client }
  }

  it('pushes running on create and completes on turn end, mapping the wire id', async () => {
    const { mirror, pushes } = harness()
    const alice = session({
      id: `session-${UUID_A}`,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    mirror.onCreated(alice)
    await vi.waitFor(() => expect(pushes.length).toBe(1))
    mirror.onEvent(alice, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
    await vi.waitFor(() => expect(pushes.length).toBe(2))
    expect(pushes[0]).toMatchObject({ sessionId: UUID_A, phase: 'running', userId: 'alice@kestra.io' })
    expect(pushes[1]).toMatchObject({ sessionId: UUID_A, phase: 'completed' })
    expect(JSON.parse(String(pushes[1]?.state)).source).toBe('dsh-pc-web')
    expect(JSON.parse(String(pushes[1]?.state)).prompt).toBe('hi')
  })

  it('skips local ids that cannot map onto the Kestra uuid column', async () => {
    const { mirror, pushes } = harness()
    const draft = session({ id: 'session-3' })
    mirror.onCreated(draft)
    mirror.onEvent(draft, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(pushes.length).toBe(0)
  })

  it('freezes a session after a terminal push (Kestra has no terminal exit edge)', async () => {
    const { mirror, pushes } = harness()
    const alice = session({ id: `session-${UUID_B}` })
    mirror.onEvent(alice, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
    await vi.waitFor(() => expect(pushes.length).toBe(1))
    mirror.onCreated(alice)
    mirror.onEvent(alice, { type: 'turn/start', data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(pushes.length).toBe(1)
  })

  it('restores a finished session as completed and freezes it (no RUNNING relapse after restart)', async () => {
    const { mirror, pushes } = harness()
    const restored = session({
      id: `session-${UUID_A}`,
      events: [
        { type: 'turn/start', data: { turn: 0 } },
        { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
      ],
    })
    mirror.onCreated(restored)
    await vi.waitFor(() => expect(pushes.length).toBe(1))
    expect(pushes[0]).toMatchObject({ sessionId: UUID_A, phase: 'completed' })
    mirror.onEvent(restored, { type: 'turn/start', data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(pushes.length).toBe(1)
  })

  it('skips forked subagent sessions entirely', async () => {
    const { mirror, pushes } = harness()
    const sub = session({ id: `session-${UUID_A}`, parentSession: `session-${UUID_B}` })
    mirror.onCreated(sub)
    mirror.onEvent(sub, { type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(pushes.length).toBe(0)
  })

  it('drops the userId field when unsigned in', async () => {
    const pushes: SessionSnapshot[] = []
    const mirror = new SessionMirror({
      push: async (snapshot) => {
        pushes.push(snapshot)
        const result: PushResult = { ok: true, status: 200, sessionId: snapshot.sessionId, phase: snapshot.phase }
        return result
      },
      currentSub: () => '',
    })
    mirror.onCreated(session({ id: `session-${UUID_A}` }))
    await vi.waitFor(() => expect(pushes.length).toBe(1))
    expect(pushes[0]).toMatchObject({ sessionId: UUID_A, phase: 'running' })
    expect(pushes[0]?.userId).toBeUndefined()
  })
})
