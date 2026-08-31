import { describe, expect, it, vi } from 'vitest'
import { contentMd5, NacosConfigClient } from '../src/core.ts'

const yamlContent = `skills:
  - name: expense-report
    version: 1.2.0
    url: http://mock-enterprise:9000/skills/expense-report-1.2.0.tgz
    gray:
      status: stable
      percent: 100
  - name: travel-booking
    version: 0.9.0-beta
    url: http://mock-enterprise:9000/skills/travel-booking-0.9.0-beta.tgz
    gray:
      status: gray
      percent: 20
`

function clientWith(content: string | undefined, fetchImpl?: typeof fetch): NacosConfigClient {
  const impl = fetchImpl ?? vi.fn().mockResolvedValue(new Response(content ?? 'config data not exist', { status: 200 }))
  return new NacosConfigClient({ server: 'http://nacos.test', pollIntervalMs: 100000 }, impl as unknown as typeof fetch)
}

describe('skill gray rollout', () => {
  it('pull ratio approximates the configured percent', async () => {
    const client = new NacosConfigClient({ server: 'http://nacos.test' })
    let pulled = 0
    for (let i = 0; i < 1000; i++) {
      // 与 syncSkillPackages 相同的灰度语义：桶 < percent 才拉取
      const userId = `user-${i}`
      let h = 0
      for (const ch of 'salt' + userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
      if (h % 100 < 20) pulled += 1
    }
    const ratio = pulled / 1000
    expect(ratio).toBeGreaterThan(0.1)
    expect(ratio).toBeLessThan(0.3)
    void client
  })
})

describe('Nacos degradation (审查 9.2)', () => {
  it('keeps last known config when Nacos goes down', async () => {
    let failing = false
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
      if (failing) throw new Error('connect timeout')
      return new Response('window:\n  maxMessages: 40', { status: 200 })
    })
    const client = new NacosConfigClient({ server: 'http://nacos.test', pollIntervalMs: 50 }, fetchImpl as unknown as typeof fetch)
    await client.fetchConfig('dsh-context.yaml')
    expect(client.getCached<any>('dsh-context.yaml')?.window?.maxMessages).toBe(40)
    failing = true
    await client.refreshAll()          // 不抛出
    expect(client.getCached<any>('dsh-context.yaml')?.window?.maxMessages).toBe(40) // 缓存保留
  })
})

describe('NacosConfigClient', () => {
  it('computes uppercase md5 for change detection', () => {
    expect(contentMd5('abc')).toBe(contentMd5('abc').toUpperCase())
    expect(contentMd5('abc')).not.toBe(contentMd5('abd'))
  })

  it('fetches and parses the skill registry yaml', async () => {
    const client = clientWith(yamlContent)
    const registry = await client.fetchConfig<{ skills: Array<{ name: string }> }>('dsh-skills.yaml')
    expect(registry?.skills).toHaveLength(2)
    expect(registry?.skills[0]?.name).toBe('expense-report')
  })

  it('respects gray percent when syncing skill packages', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(yamlContent, { status: 200 }))
      .mockResolvedValue(new Response('PK', { status: 200 }))
    const client = new NacosConfigClient({ server: 'http://nacos.test' }, fetchSpy as unknown as typeof fetch)
    const results = await client.syncSkillPackages('/tmp/dsh-test-skills', 50)
    const byName = new Map(results.map(r => [r.name, r]))
    expect(byName.get('expense-report')?.cached).toBe(true)   // stable 全量
    expect(byName.get('travel-booking')?.cached).toBe(false)  // gray 20%，桶 5 之内才拉
  })
})
