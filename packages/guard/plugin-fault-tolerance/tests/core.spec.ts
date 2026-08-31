import { describe, expect, it, vi } from 'vitest'
import { backoffDelayMs, CircuitBreaker, FaultTolerance } from '../src/core.ts'

describe('backoffDelayMs', () => {
  it('follows 1s/2s/4s/8s with multiplier 2', () => {
    const retry = { maxAttempts: 4, baseDelayMs: 1000, multiplier: 2, jitter: false }
    expect(backoffDelayMs(retry, 1)).toBe(1000)
    expect(backoffDelayMs(retry, 2)).toBe(2000)
    expect(backoffDelayMs(retry, 3)).toBe(4000)
    expect(backoffDelayMs(retry, 4)).toBe(8000)
  })
})

describe('backoff sequence', () => {
  it('records 1s/2s/4s/8s delays across retries', async () => {
    const delays: number[] = []
    const ft = new FaultTolerance(
      { maxAttempts: 4, baseDelayMs: 1000, multiplier: 2, jitter: false },
      [],
      { failureThreshold: 10, windowSeconds: 60, openSeconds: 1 },
      async (ms) => { delays.push(ms) },
    )
    await ft.execute('any_tool', async () => { throw new Error('http_5xx') })
    expect(delays).toEqual([1000, 2000, 4000]) // 4 次尝试之间 3 段退避
  })
})

describe('FaultTolerance', () => {
  it('retries with backoff and succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const ft = new FaultTolerance({ maxAttempts: 3, baseDelayMs: 1, multiplier: 2, jitter: false }, [], { failureThreshold: 10, windowSeconds: 60, openSeconds: 1 }, sleep)
    let calls = 0
    const result = await ft.execute('crm_query', async () => {
      calls += 1
      if (calls < 3) throw new Error('timeout')
      return 'value'
    })
    expect(result).toEqual({ ok: true, value: 'value' })
    expect(calls).toBe(3)
  })

  it('falls back to the first matching safe response after retries', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const ft = new FaultTolerance(
      { maxAttempts: 2, baseDelayMs: 1, multiplier: 2, jitter: false },
      [{ matchTool: '.*_query.*', response: '查询服务暂时不可用' }],
      { failureThreshold: 10, windowSeconds: 60, openSeconds: 1 },
      sleep,
    )
    const result = await ft.execute('crm_query_customer', async () => { throw new Error('http_5xx') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.fallback).toBe('查询服务暂时不可用')
  })

  it('opens the circuit after consecutive failures and half-opens later', async () => {
    let clock = 0
    const breaker = new CircuitBreaker({ failureThreshold: 2, windowSeconds: 60, openSeconds: 30 }, () => clock)
    breaker.recordFailure(); breaker.recordFailure()
    expect(breaker.state).toBe('open')
    expect(breaker.allow()).toBe(false)
    clock = 31_000
    expect(breaker.allow()).toBe(true)
    expect(breaker.state).toBe('half_open')
    breaker.recordSuccess()
    expect(breaker.state).toBe('closed')
  })
})
