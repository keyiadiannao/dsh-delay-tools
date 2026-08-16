/**
 * dsh-schedule-reminder — host half.
 *
 * Delayed wake-up for DeepSeek Harness. The core problem this solves: a plain
 * `pwsh ... run_in_background` timer is killed when its owning agent turn is
 * torn down (ctx.jobs cancels owner-scoped work on disposal), so "wake me in
 * 3 minutes" never survives. This plugin keeps a HOST-level timer that is not
 * bound to any turn, then wakes the agent through the official `followup()`
 * channel (runtime-types: "a wake submitted while already idle always opens
 * its turn boundary"), so the SAME conversation resumes and replies.
 *
 *   user: "3 分钟后告诉我 X"
 *     ↓
 *   schedule_reminder(delay_ms, message)
 *     ↓
 *   host setTimeout(delay).unref()          ← not tied to any turn lifetime
 *     ↓
 *   due → agent.followup(userMessage)       ← official wake channel
 *     ↓
 *   agent (idle) opens a new turn → replies in the same conversation
 *
 * @module dsh-schedule-reminder
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-schedule-reminder'

export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Default delay in ms when the tool is called without one. */
  defaultDelayMs: number
  /** Upper bound (ms) for a single reminder delay. */
  maxDelayMs: number
  /** Minimum delay (ms); guards against accidental instant re-entry. */
  minDelayMs: number
}

/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
export const Config: z<Config> = z.object({
  defaultDelayMs: z.number().min(1000).max(86_400_000).default(60_000),
  maxDelayMs: z.number().min(1000).max(86_400_000).default(3_600_000),
  minDelayMs: z.number().min(0).max(60_000).default(1_000),
})

/** Source marker for the synthetic wake message (visible in the transcript). */
const REMINDER_SOURCE = { kind: 'plugin', plugin: 'dsh-schedule-reminder' } as const

/** Track live reminders so a second call can report how many are pending. */
const pending = new Map<string, { dueAt: number; text: string }>()

/** Human-readable pending count for the tool's return value. */
function pendingCount(agentId: string): number {
  let n = 0
  for (const entry of pending.values()) if (entry.dueAt > Date.now()) n += 1
  return n
}

export function apply(ctx: any, config: Config): void {
  ctx.tools.register({
    name: 'schedule_reminder',
    description: 'Schedule the agent to wake up and message you after a delay, in the SAME conversation. '
      + 'Unlike a background shell timer (which dies with the turn), this uses a host-level timer and the '
      + 'official agent wake channel, so the reminder survives even after this turn ends. '
      + 'The agent will resume and deliver `message` to you after `delay_ms`.',
    parameters: {
      delay_ms: {
        type: 'number',
        description: `Delay in milliseconds before waking (min ${config.minDelayMs}, max ${config.maxDelayMs}; default ${config.defaultDelayMs}).`,
      },
      message: {
        type: 'string',
        required: true,
        description: 'The text the agent should deliver to you when the delay elapses. Write it as a direct message to the user.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scheduled: { type: 'boolean' },
          due_at: { type: 'string' },
          delay_ms: { type: 'number' },
          pending: { type: 'number' },
        },
        required: ['scheduled', 'due_at', 'delay_ms', 'pending'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Reminder scheduled: will wake in ${value.delay_ms}ms (due ${value.due_at}); ${value.pending} reminder(s) pending.`,
      }],
    },
    async execute(args: { delay_ms?: number; message: string }, exec: { agent: { id?: unknown; followup?: (m: unknown) => void } }) {
      const agent = exec.agent
      const delay = Number.isFinite(args.delay_ms) && (args.delay_ms as number) > 0
        ? Math.min(Math.max(Math.floor(args.delay_ms as number), config.minDelayMs), config.maxDelayMs)
        : config.defaultDelayMs
      const text = typeof args.message === 'string' && args.message.trim().length > 0
        ? args.message.trim()
        : '(reminder)'

      const agentId = String(agent?.id ?? 'unknown')
      const dueAt = Date.now() + delay

      setTimeout(() => {
        // Wake the agent in the SAME conversation. followup() is safe from a
        // host timer: the agent object lives at session scope (not per-turn),
        // and an idle agent always opens a new turn boundary for the message.
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: REMINDER_SOURCE,
        })
        try {
          agent.followup?.(message)
        } catch { /* agent gone: nothing to wake */ }
        pending.delete(agentId)
      }, delay).unref()

      pending.set(agentId, { dueAt, text })
      return {
        scheduled: true,
        due_at: new Date(dueAt).toISOString(),
        delay_ms: delay,
        pending: pendingCount(agentId),
      }
    },
  }, 'dsh-schedule-reminder: schedule_reminder tool')
}
