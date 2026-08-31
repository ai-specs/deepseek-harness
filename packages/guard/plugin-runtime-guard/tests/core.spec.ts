import { describe, expect, it, vi } from 'vitest'
import { RuntimeGuard } from '../src/core.ts'

describe('RuntimeGuard', () => {
  it('detects identical repeated tool calls as a loop', () => {
    const guard = new RuntimeGuard('s-1', { loopRepeatThreshold: 3, maxDepth: 8, tokenBudget: 1000 })
    expect(guard.checkToolCall('crm_query', '{"id":"CUST-1"}')).toBeNull()
    expect(guard.checkToolCall('crm_query', '{"id":"CUST-1"}')).toBeNull()
    const event = guard.checkToolCall('crm_query', '{"id":"CUST-1"}')
    expect(event?.type).toBe('loop_detected')
  })

  it('blocks abnormal call frequency (100 rapid identical calls)', () => {
    const guard = new RuntimeGuard('s-1', { loopRepeatThreshold: 3, maxDepth: 8, tokenBudget: 100000 })
    let blocked = 0
    for (let i = 0; i < 100; i++) {
      if (guard.checkToolCall('crm_query', '{"id":"CUST-1"}') !== null) blocked += 1
    }
    expect(blocked).toBe(98) // 第 3 次起持续拦截
  })

  it('detects alternating A→B→A deadlock cycles', () => {
    const guard = new RuntimeGuard('s-1', { loopRepeatThreshold: 3, maxDepth: 8, tokenBudget: 100000 })
    guard.checkToolCall('toolA', '{"a":1}')
    guard.checkToolCall('toolB', '{"b":1}')
    guard.checkToolCall('toolA', '{"a":1}')
    const event = guard.checkToolCall('toolB', '{"b":1}')
    expect(event?.type).toBe('loop_detected')
    expect(event?.detail).toContain('cycle')
  })

  it('enforces the execution depth limit', () => {
    const guard = new RuntimeGuard('s-1', { loopRepeatThreshold: 3, maxDepth: 2, tokenBudget: 1000 })
    expect(guard.checkDepth(1)).toBeNull()
    expect(guard.checkDepth(2)).toBeNull()
    expect(guard.checkDepth(3)?.type).toBe('depth_exceeded')
  })

  it('fires the token budget event once usage exceeds the cap', () => {
    const listener = vi.fn()
    const guard = new RuntimeGuard('s-1', { loopRepeatThreshold: 3, maxDepth: 8, tokenBudget: 500 })
    guard.onEvent(listener)
    expect(guard.recordTokenUsage(400)).toBeNull()
    const event = guard.recordTokenUsage(200)
    expect(event?.type).toBe('token_budget_exceeded')
    expect(listener).toHaveBeenCalledOnce()
  })
})
