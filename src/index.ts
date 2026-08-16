/**
 * dsh-delay-tools — host half.
 *
 * Two delay primitives for DeepSeek Harness:
 *
 *   schedule_reminder  — future wake: the current turn can end, a host-level
 *                        `setTimeout().unref()` keeps running, and when it
 *                        fires the agent is woken through the official
 *                        `followup()` channel in the SAME conversation.
 *   wait               — current-turn gate: the tool execution awaits the
 *                        countdown inline (the agent cannot do anything else),
 *                        observing `exec.signal` so the stop button interrupts
 *                        immediately.
 *
 * The core problem this solves: a plain `pwsh ... run_in_background` timer is
 * killed when its owning agent turn is torn down (ctx.jobs cancels
 * owner-scoped work on disposal), so "wake me in 3 minutes" never survives.
 * Timers here live at PLUGIN scope, not turn scope and not process-global:
 * they survive turns, and are cancelled when the plugin itself is disposed.
 *
 * NOTE (durability): reminders exist only in process memory. Restarting the
 * DSH host cancels all pending reminders. Durable persistence is a roadmap
 * item (0.2.x).
 *
 * @module dsh-delay-tools
 */

import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-delay-tools'

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
const REMINDER_SOURCE = { kind: 'plugin', plugin: 'dsh-delay-tools' } as const

/** One live reminder. Keyed by reminderId so multiple reminders per agent
 * never overwrite each other. */
interface Reminder {
  agentId: string
  dueAt: number
  text: string
  timer: NodeJS.Timeout
}

/** Live reminders by id (in-memory; see the durability note above). */
const reminders = new Map<string, Reminder>()

/** Every live timer handle, so plugin disposal can cancel them all. */
const pluginTimers = new Set<NodeJS.Timeout>()

/** Count reminders still pending for ONE agent. */
function pendingCount(agentId: string): number {
  let n = 0
  const now = Date.now()
  for (const r of reminders.values()) if (r.agentId === agentId && r.dueAt > now) n += 1
  return n
}

/** Clamp a requested delay into [minDelayMs, maxDelayMs]; fall back to the
 * default, ALSO clamped (defense in depth even if the config invariant was
 * somehow violated). */
function clampDelay(requested: unknown, config: Config): number {
  const n = Number(requested)
  const value = Number.isFinite(n) && n > 0 ? Math.floor(n) : config.defaultDelayMs
  return Math.min(Math.max(value, config.minDelayMs), config.maxDelayMs)
}

/** Validate the cross-field delay invariant: min <= default <= max. */
function assertDelayInvariant(config: Config): void {
  if (!(config.minDelayMs <= config.defaultDelayMs && config.defaultDelayMs <= config.maxDelayMs)) {
    throw new Error(
      `dsh-delay-tools: invalid delay config — require minDelayMs (${config.minDelayMs}) `
      + `<= defaultDelayMs (${config.defaultDelayMs}) <= maxDelayMs (${config.maxDelayMs})`,
    )
  }
}

export function apply(ctx: any, config: Config): void {
  assertDelayInvariant(config)

  // Plugin-scoped lifecycle: timers survive turns but are cancelled when the
  // plugin itself is disposed (hot unload/reload).
  ctx.effect(() => () => {
    for (const timer of pluginTimers) clearTimeout(timer)
    pluginTimers.clear()
    reminders.clear()
  }, 'dsh-delay-tools: clear pending timers')

  ctx.tools.register({
    name: 'schedule_reminder',
    description: 'Schedule the agent to wake up and message you after a delay, in the SAME conversation. '
      + 'Unlike a background shell timer (which dies with the turn), this uses a host-level timer and the '
      + 'official agent wake channel, so the reminder survives even after this turn ends. '
      + 'Multiple reminders per conversation are supported (each has its own reminder_id). '
      + 'NOTE: reminders are in-memory — restarting the DSH host cancels pending reminders. '
      + 'The agent will resume and deliver `message` to you after `delay_ms`.',
    parameters: {
      type: 'object',
      properties: {
        delay_ms: {
          type: 'number',
          description: `Delay in milliseconds before waking (min ${config.minDelayMs}, max ${config.maxDelayMs}; default ${config.defaultDelayMs}).`,
        },
        message: {
          type: 'string',
          description: 'The text the agent should deliver to you when the delay elapses. Write it as a direct message to the user.',
        },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scheduled: { type: 'boolean' },
          reminder_id: { type: 'string' },
          due_at: { type: 'string' },
          delay_ms: { type: 'number' },
          pending: { type: 'number' },
        },
        required: ['scheduled', 'reminder_id', 'due_at', 'delay_ms', 'pending'],
      },
      render: (_args: unknown, value: { scheduled: boolean; reminder_id: string; due_at: string; delay_ms: number; pending: number }) => [{
        type: 'text',
        text: `Reminder ${value.reminder_id} scheduled: will wake in ${value.delay_ms}ms (due ${value.due_at}); ${value.pending} reminder(s) pending.`,
      }],
    },
    async execute(args: { delay_ms?: number; message: string }, exec: { agent: { id?: unknown; followup?: (m: unknown) => void } }) {
      const agent = exec.agent
      const delay = clampDelay(args.delay_ms, config)
      const text = typeof args.message === 'string' && args.message.trim().length > 0
        ? args.message.trim()
        : '(reminder)'

      const agentId = String(agent?.id ?? 'unknown')
      const dueAt = Date.now() + delay
      const reminderId = randomUUID()

      const timer = setTimeout(() => {
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
        reminders.delete(reminderId)
        pluginTimers.delete(timer)
      }, delay)
      timer.unref()
      pluginTimers.add(timer)

      reminders.set(reminderId, { agentId, dueAt, text, timer })
      return {
        scheduled: true,
        reminder_id: reminderId,
        due_at: new Date(dueAt).toISOString(),
        delay_ms: delay,
        pending: pendingCount(agentId),
      }
    },
  }, 'dsh-delay-tools: schedule_reminder tool')

  ctx.tools.register({
    name: 'wait',
    description: 'Pause the CURRENT turn for `delay_ms` milliseconds, then continue (a timed gate). '
      + 'While waiting, the agent can do nothing else, and user messages sent during the wait are queued '
      + 'and answered after the wait finishes. Unlike schedule_reminder (which schedules a wake-up and does '
      + 'NOT block), this BLOCKS the current turn — use it when work must pause for a fixed duration, '
      + 'e.g. "wait 30 seconds, then continue".',
    parameters: {
      type: 'object',
      properties: {
        delay_ms: {
          type: 'number',
          description: `Milliseconds to block (min ${config.minDelayMs}, max ${config.maxDelayMs}; default ${config.defaultDelayMs}).`,
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          waited_ms: { type: 'number' },
          elapsed_until: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['waited_ms', 'elapsed_until', 'note'],
      },
      render: (_args: unknown, value: { waited_ms: number; elapsed_until: string; note: string }) => [{
        type: 'text',
        text: `Waited ${value.waited_ms}ms (until ${value.elapsed_until}); ${value.note}`,
      }],
    },
    async execute(args: { delay_ms?: number }, exec: { signal?: AbortSignal }) {
      const delay = clampDelay(args.delay_ms, config)
      const start = Date.now()
      // Blocks the agent turn for the full delay. Not bound to ctx.jobs, so it
      // is immune to turn teardown — but unlike schedule_reminder it is awaited
      // inline, so the agent cannot do anything else until it resolves.
      // The tools contract requires async work to observe `exec.signal`: the
      // stop button aborts the turn's signal, and the registry cannot hard-kill
      // same-process code — so without this listener the wait would hang until
      // the delay elapses and the user could NOT interrupt it.
      await new Promise<void>((resolve) => {
        if (exec.signal?.aborted === true) { resolve(); return }
        const timer = setTimeout(resolve, delay)
        exec.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      const aborted = exec.signal?.aborted === true
      return {
        waited_ms: Date.now() - start,
        elapsed_until: new Date().toISOString(),
        note: aborted ? 'Wait interrupted by the user (stop).' : 'Delay elapsed; continue your current task.',
      }
    },
  }, 'dsh-delay-tools: wait tool')
}
