import { describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { ContextManager, LocalVectorStore, tokenize } from '../src/core.ts'

const policy = {
  window: { maxMessages: 4, maxTokens: 10000, strategy: 'sliding_with_summary' as const },
  summarize: { thresholdPercent: 80, keepRecentMessages: 2, prompt: '摘要' },
  vector: { enabled: true, path: './.dsh/vector-store-test', topK: 3 },
}

describe('tokenize', () => {
  it('splits cjk and latin tokens', () => {
    const tokens = tokenize('提交 refund 申请')
    expect(tokens).toContain('refund')
    expect(tokens).toContain('提')       // 单 CJK 字保留用于中文检索
    expect(tokens).not.toContain('r')    // 单拉丁字符过滤
  })
})

describe('ContextManager', () => {
  it('evicts old messages into the vector store when over the window', async () => {
    rmSync('./.dsh/vector-store-test', { recursive: true, force: true })
    const manager = new ContextManager([], policy, async (_p, evicted) => `摘要: ${evicted.length} 条`)
    for (let i = 0; i < 8; i++) {
      await manager.append({ role: 'user', content: `第 ${i} 条消息 about refund ${i === 3 ? '关键决策' : ''}` })
    }
    expect(manager.history.length).toBeLessThanOrEqual(6)
    expect(manager.evictedCount).toBeGreaterThan(0)
    const recalled = manager.recall('关键决策 refund')
    expect(recalled.length).toBeGreaterThan(0)
  })
})

describe('LocalVectorStore', () => {
  it('persists entries across instances', () => {
    rmSync('./.dsh/vector-store-test2', { recursive: true, force: true })
    const s1 = new LocalVectorStore('./.dsh/vector-store-test2')
    s1.add('客户 CUST-1001 的退款决策')
    const s2 = new LocalVectorStore('./.dsh/vector-store-test2')
    expect(s2.search('退款决策')[0]?.text).toContain('CUST-1001')
  })
})
