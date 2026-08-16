import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'

interface ToolDef {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Minimal ctx: captures tool registrations and the plugin disposer. */
function setup(config: Record<string, unknown> = {}) {
  const tools: ToolDef[] = []
  let disposer: (() => void) | undefined
  const ctx = {
    tools: { register: (def: ToolDef): void => { tools.push(def) } },
    effect: (fn: () => () => void): void => { disposer = fn() },
  }
  const cfg = Config(config)
  apply(ctx as never, cfg)
  const tool = (name: string): ToolDef => {
    const found = tools.find(t => t.name === name)
    if (found === undefined) throw new Error(`tool ${name} not registered`)
    return found
  }
  return { tool, dispose: (): void => { disposer?.() }, cfg }
}

/** Fake agent exec: records followup() messages. */
function agent(id = 'agent-1') {
  const wakes: unknown[] = []
  const exec = { agent: { id, followup: (m: unknown): void => { wakes.push(m) } } }
  return { exec, wakes }
}

describe('dsh-delay-tools behavior (fake timers)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires multiple reminders for the SAME agent independently', async () => {
    const { tool } = setup()
    const schedule = tool('schedule_reminder').execute as (args: unknown, exec: unknown) => Promise<{ reminder_id: string; pending: number }>
    const a = agent()

    const r1 = await schedule({ delay_ms: 10_000, message: 'A' }, a.exec)
    const r2 = await schedule({ delay_ms: 20_000, message: 'B' }, a.exec)

    expect(r1.reminder_id).not.toBe(r2.reminder_id)
    expect(r1.pending).toBe(1) // A only
    expect(r2.pending).toBe(2) // A + B

    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.wakes).toHaveLength(1) // only A fired
    expect((a.wakes[0] as { content: { text: string }[] }).content[0].text).toBe('A')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.wakes).toHaveLength(2) // B fires independently
    expect((a.wakes[1] as { content: { text: string }[] }).content[0].text).toBe('B')
  })

  it('counts pending reminders per agent, not globally', async () => {
    const { tool } = setup()
    const schedule = tool('schedule_reminder').execute as (args: unknown, exec: unknown) => Promise<{ pending: number }>
    const a = agent('agent-a')
    const b = agent('agent-b')

    await schedule({ delay_ms: 10_000, message: 'A' }, a.exec)
    const rb = await schedule({ delay_ms: 10_000, message: 'B' }, b.exec)

    expect(rb.pending).toBe(1) // only B's own reminder counts for agent-b
  })

  it('wait resolves immediately when the signal aborts', async () => {
    const { tool } = setup()
    const wait = tool('wait').execute as (args: unknown, exec: unknown) => Promise<{ note: string }>
    const ac = new AbortController()

    const p = wait({ delay_ms: 10_000 }, { signal: ac.signal })
    await vi.advanceTimersByTimeAsync(1_000)
    ac.abort()
    const result = await p

    expect(result.note).toContain('interrupted')
  })

  it('plugin disposal cancels pending timers', async () => {
    const { tool, dispose } = setup()
    const schedule = tool('schedule_reminder').execute as (args: unknown, exec: unknown) => Promise<unknown>
    const a = agent()

    await schedule({ delay_ms: 10_000, message: 'A' }, a.exec)
    dispose()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(a.wakes).toHaveLength(0)
  })

  it('rejects cross-field config invariant violations (min <= default <= max)', () => {
    expect(() => setup({ defaultDelayMs: 5_000, maxDelayMs: 3_000 })).toThrow(/invalid delay config/)
    expect(() => setup({ minDelayMs: 30_000, defaultDelayMs: 5_000 })).toThrow(/invalid delay config/)
  })

  it('clamps the default fallback into the valid range even under a broken config', async () => {
    // Guard the fallback path directly: default above max must not win.
    const { tool, cfg } = setup()
    const wait = tool('wait').execute as (args: unknown, exec: unknown) => Promise<{ waited_ms: number }>
    // Override config in place to simulate an unvalidated admin config
    // (the invariant would normally throw at apply; this pins the clamp).
    cfg.minDelayMs = 1_000
    cfg.defaultDelayMs = 60_000
    cfg.maxDelayMs = 10_000

    const p = wait({}, { signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p
    expect(result.waited_ms).toBeLessThanOrEqual(10_000)
  })
})
