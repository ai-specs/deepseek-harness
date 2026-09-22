import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/**
 * The result of a tool invocation, sent back to the model.
 *
 * Upstream moved tool results out of the shared content vocabulary (they are
 * first-class `role: 'tool'` messages now), but the DeepSeek wire protocols
 * (chat-completions and messages) still project tool results as content blocks
 * inside user/tool turns. The shared ContentBlockMap is merge-extensible by
 * design, so this fork re-registers the block type against the shared types
 * module — providers (llm-deepseek), adapters, and session compaction that
 * still use the block vocabulary keep compiling against the upstream core.
 */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: ToolCallId
  content: ContentBlock[]
  isError?: boolean
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface ContentBlockMap {
    'tool-result': ToolResultBlock
  }
}
