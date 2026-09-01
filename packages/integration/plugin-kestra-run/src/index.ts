/**
 * Kestra AIAgent execution-plane observer (dsh.docx 第二种运行位置).
 *
 * Rides over the headless one-shot driver without replacing it: the upstream
 * runner keeps owning stdout and the exit code, while this plugin OBSERVES the
 * same Session feed to build the structured result contract the Kestra
 * io.kestra.plugin.dsh.agent.AIAgent task reads from /result.json, enforces
 * the DSH_TOOLS allowlist through the tools/pre-execute pipeline, and bounds
 * the run with DSH_TIMEOUT.
 *
 * @module @deepseek-ai/dsh-plugin-kestra-run
 */

import { writeFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'kestra-run'

/** No injected services: everything is event-driven or process-level. */
export const inject: string[] = []

/** Plugin config resolved from the deployment environment by dsh.patch.yml. */
export interface Config {
  /** Where the structured result JSON is written (the AIAgent docker-cp target). */
  resultFile: string
  /** Deny-by-default tool allowlist; undefined or empty = deployment default set. */
  allowTools?: string[]
  /** Wall-clock bound in seconds; 0 = unbounded. On expiry the partial result is written and the process exits 124. */
  timeoutSeconds?: number
}

export const Config: z<Config> = z.object({
  resultFile: z.string().required(),
  allowTools: z.array(z.string()),
  timeoutSeconds: z.number(),
})

/** The structured result contract (mirrors io.kestra.plugin.dsh.agent.AIAgent.RunResult). */
export interface RunResultPayload {
  result: string
  success: boolean
  iterations: number
  toolCalls: number
  toolErrors: number
  tokenUsage: { prompt: number; completion: number; total: number }
  durationMs: number
  error: string | null
}

/** Running tallies for one observed process (a one-shot run owns one agent). */
export interface RunTallies {
  turns: Set<number>
  toolCalls: number
  toolErrors: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  lastText: string
  lastError: string | null
  startedAt: number
}

export function createTallies(startedAt = Date.now()): RunTallies {
  return {
    turns: new Set<number>(),
    toolCalls: 0,
    toolErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    lastText: '',
    lastError: null,
    startedAt,
  }
}

/** Fold one session event into the tallies; exports for tests. */
export function observeEvent(tallies: RunTallies, event: SessionEvent): void {
  switch (event.type) {
    case 'turn/start':
      tallies.turns.add(event.data.turn)
      return
    case 'tool/call':
      tallies.toolCalls += 1
      return
    case 'tool/result':
      if (event.data.error !== undefined) tallies.toolErrors += 1
      return
    case 'assistant/message': {
      const usage = event.data.usage
      if (usage) {
        tallies.promptTokens += usage.inputTokens
        tallies.completionTokens += usage.outputTokens
        tallies.totalTokens += usage.totalTokens ?? usage.inputTokens + usage.outputTokens
      }
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') tallies.lastText = joined
      return
    }
    case 'turn/end': {
      const reason = event.data.reason
      if (reason.kind !== 'completed') {
        tallies.lastError = reason.kind === 'error'
          ? `${reason.error.code}: ${reason.error.message}`
          : `turn ended: ${reason.kind}`
      }
      return
    }
    default:
      return
  }
}

/** Project the tallies onto the /result.json payload; exports for tests. */
export function projectResult(tallies: RunTallies, timedOut = false): RunResultPayload {
  const iterations = tallies.turns.size
  return {
    result: tallies.lastText,
    success: !timedOut && tallies.lastError === null && iterations > 0,
    iterations,
    toolCalls: tallies.toolCalls,
    toolErrors: tallies.toolErrors,
    tokenUsage: {
      prompt: tallies.promptTokens,
      completion: tallies.completionTokens,
      total: tallies.totalTokens,
    },
    durationMs: Date.now() - tallies.startedAt,
    error: timedOut ? 'timed out (partial result)' : tallies.lastError,
  }
}

/**
 * Mount the observer: subscribe to the Session feed, install the tool
 * allowlist guard, and arm the timeout. The upstream headless runner owns
 * stdout and the exit code; this plugin only adds the AIAgent file contract.
 */
export function apply(ctx: Context, config: Config): void {
  const tallies = createTallies()
  const write = (timedOut = false): void => {
    try {
      writeFileSync(config.resultFile, JSON.stringify(projectResult(tallies, timedOut)))
    } catch (error) {
      // The Kestra side falls back to the container log tail when the file is
      // missing — a failed write must never take the agent down with it.
      ctx.root.logger('loader').warn('kestra-run: cannot write %s: %s', config.resultFile, error)
    }
  }

  ctx.on('session/event', (_session, event) => {
    observeEvent(tallies, event)
    if (event.type === 'turn/end') write()
  })

  if (config.allowTools && config.allowTools.length > 0) {
    const allowed = new Set(config.allowTools)
    ctx.on('tools/pre-execute', (exec, next) => {
      if (allowed.has(exec.name)) return next()
      return Promise.resolve({
        kind: 'deny',
        reason: `kestra-run: tool "${exec.name}" is not in the DSH_TOOLS allowlist (${[...allowed].join(', ')})`,
      })
    })
  }

  const timeoutSeconds = config.timeoutSeconds ?? 0
  if (timeoutSeconds > 0) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        write(true)
        const exit = ctx.get('appExit')
        if (exit) exit(124)
      }, timeoutSeconds * 1000)
      // Fiber disposal (the one-shot runner's exit) clears the deadline.
      return () => { clearTimeout(timer) }
    })
  }
}
