/**
 * Context manager (dsh.docx 第十章 上下文控制).
 *
 * Sliding window over the message history, threshold-driven summary
 * compaction, and a lightweight local vector store (term-frequency vectors)
 * that keeps core semantics of evicted messages retrievable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ContextPolicy {
  window: { maxMessages: number; maxTokens: number; strategy: 'sliding' | 'sliding_with_summary' }
  summarize: { thresholdPercent: number; keepRecentMessages: number; prompt: string }
  vector: { enabled: boolean; path: string; topK: number }
}

export const DEFAULT_POLICY: ContextPolicy = {
  window: { maxMessages: 40, maxTokens: 32000, strategy: 'sliding_with_summary' },
  summarize: { thresholdPercent: 80, keepRecentMessages: 6, prompt: '提取关键决策、未完成任务与用户偏好，输出不超过 300 字的摘要。' },
  vector: { enabled: true, path: './.dsh/vector-store', topK: 5 },
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; tokens?: number }

export interface VectorEntry { id: string; text: string; tokens: string[]; at: string }

/** 极简词频向量：分词（中英文混合）→ 词频表。生产可替换为真向量实现。 */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]/g) ?? []).filter(t => /[\u4e00-\u9fa5]/.test(t) || t.length > 1)
}

export class LocalVectorStore {
  private entries: VectorEntry[] = []

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'store.json')
    if (existsSync(file)) this.entries = JSON.parse(readFileSync(file, 'utf8')) as VectorEntry[]
  }

  private persist(): void {
    writeFileSync(join(this.dir, 'store.json'), JSON.stringify(this.entries))
  }

  add(text: string, at = new Date().toISOString()): VectorEntry {
    const entry: VectorEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, tokens: tokenize(text), at }
    this.entries.push(entry)
    this.persist()
    return entry
  }

  /** 词频重叠打分检索 topK 条相关历史。 */
  search(query: string, topK = 5): VectorEntry[] {
    const q = new Set(tokenize(query))
    return [...this.entries]
      .map(entry => ({ entry, score: entry.tokens.filter(t => q.has(t)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(x => x.entry)
  }

  get size(): number {
    return this.entries.length
  }
}

export class ContextManager {
  private readonly vector: LocalVectorStore | undefined

  constructor(
    private messages: ChatMessage[] = [],
    private policy: ContextPolicy = DEFAULT_POLICY,
    private readonly summarize: (prompt: string, evicted: ChatMessage[]) => Promise<string>,
    storeDir = './.dsh/vector-store',
  ) {
    this.vector = policy.vector.enabled ? new LocalVectorStore(storeDir) : undefined
  }

  get history(): ChatMessage[] {
    return this.messages
  }

  get evictedCount(): number {
    return this.vector?.size ?? 0
  }

  /** 追加消息并把被淘汰的核心语义写入本地向量库。 */
  async append(message: ChatMessage): Promise<{ evicted: number; summary: string | undefined }> {
    this.messages.push(message)
    const budget = Math.max(1, Math.floor((this.policy.window.maxTokens * this.policy.summarize.thresholdPercent) / 100))
    const used = this.messages.reduce((sum, m) => sum + (m.tokens ?? Math.ceil(m.content.length / 2)), 0)
    let evicted = 0
    let summary: string | undefined
    if (used > budget || this.messages.length > this.policy.window.maxMessages) {
      const keep = this.policy.summarize.keepRecentMessages
      const overflow = this.messages.length - this.policy.window.maxMessages
      const cut = Math.max(overflow, this.messages.length - keep)
      const leaving = this.messages.slice(0, Math.max(0, cut))
      if (leaving.length > 0 && this.policy.window.strategy === 'sliding_with_summary') {
        summary = await this.summarize(this.policy.summarize.prompt, leaving)
        this.messages = [ { role: 'system', content: `历史摘要: ${summary}`, tokens: Math.ceil(summary.length / 2) }, ...this.messages.slice(leaving.length) ]
      } else {
        this.messages = this.messages.slice(leaving.length)
      }
      if (this.vector) for (const m of leaving) this.vector.add(m.content)
      evicted = leaving.length
    }
    return { evicted, summary }
  }

  /** 从本地向量库检索与当前任务最相关的历史语义。 */
  recall(query: string): string[] {
    return this.vector?.search(query, this.policy.vector.topK).map(e => e.text) ?? []
  }
}
