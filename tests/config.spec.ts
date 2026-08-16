import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('dsh-schedule-reminder config', () => {
  it('defaults to a 60s delay with 1h ceiling', () => {
    const cfg = Config({})
    expect(cfg.defaultDelayMs).toBe(60_000)
    expect(cfg.maxDelayMs).toBe(3_600_000)
    expect(cfg.minDelayMs).toBe(1_000)
  })

  it('accepts explicit bounds', () => {
    const cfg = Config({ defaultDelayMs: 5000, maxDelayMs: 30_000, minDelayMs: 100 })
    expect(cfg.defaultDelayMs).toBe(5000)
    expect(cfg.maxDelayMs).toBe(30_000)
    expect(cfg.minDelayMs).toBe(100)
  })

  it('rejects invalid bounds', () => {
    expect(() => Config({ maxDelayMs: 500 })).toThrow() // below min 1000
    expect(() => Config({ minDelayMs: 70_000 })).toThrow() // above max 60000
    expect(() => Config({ defaultDelayMs: 0 })).toThrow()
  })
})
