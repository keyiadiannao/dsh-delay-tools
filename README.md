# dsh-delay-tools

Delay utilities for DeepSeek Harness: **two tools sharing one core concept — delay**:

| Mode | Tool | What the agent does while waiting | User messages during the wait | Typical use |
|---|---|---|---|---|
| Wake | `schedule_reminder` | keeps working; wakes up in the SAME conversation when due | handled normally | "remind me in 3 minutes about X" |
| Gate | `wait` | blocks the current turn | queued, processed after | "wait 30 seconds, then continue", cooldowns |

## Why

A plain background shell timer cannot do "wake me in 3 minutes": DSH background
jobs are bound to the agent turn's lifecycle and get torn down when the turn
ends (`ctx.jobs` owner-scoped dispose — the process exits with `0xC000013A` and
the cancel is misreported as completed). This plugin uses a **host-level timer**
(not bound to any turn) plus the official `followup()` wake channel to deliver
the message back into the **same conversation**.

## Install

```bash
dsh plugin add github:keyiadiannao/dsh-delay-tools#master
```

## Usage

Tell the agent:

> Call the `schedule_reminder` tool and remind me in 30 seconds to drink water.

The agent calls the tool and returns the expected trigger time; when the delay
elapses it wakes up and delivers the reminder in the same conversation. No
matter how many other turns happen in between (including new messages you send),
the reminder arrives on time.

### Tool parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `delay_ms` | number | no | Delay in ms, default 60000; clamped to `minDelayMs`..`maxDelayMs` |
| `message` | string | yes | The text the agent delivers to you when the delay elapses |

### Return value

`scheduled` / `due_at` / `delay_ms` / `pending` (how many reminders are still
pending for this agent).

## The second mode: `wait` (timed gate)

`schedule_reminder` means "wake later, keep working meanwhile"; `wait` is the
opposite — it **blocks the current turn**, and the agent only continues after
the countdown:

> Call the `wait` tool for 30 seconds, then continue.

`wait` takes only `delay_ms` and returns `waited_ms` / `elapsed_until` / `note`.
Messages you send during the gate go into the inbox queue (the composer shows
"N queued messages") and are processed after the countdown — which makes it a
reliable trigger for testing queue/merge plugins such as
[dsh-queue-merge](https://github.com/keyiadiannao/dsh-queue-merge).

`wait` observes `exec.signal` per the tools contract: pressing the **stop**
button mid-wait interrupts the gate immediately (returns
`note: 'Wait interrupted by the user (stop).'`) instead of hanging for the full
delay.

## Configuration

```yaml
- id: dsh-delay-tools
  config:
    defaultDelayMs: 60000       # default delay when delay_ms is omitted
    maxDelayMs: 3600000         # upper bound for a single delay
    minDelayMs: 1000            # lower bound, guards against instant re-entry
```

## How it works

```
user: "tell me X in 3 minutes"
  ↓
schedule_reminder(delay_ms, message)
  ↓
host setTimeout(delay).unref()      ← not bound to any turn lifetime
  ↓ (turn ends, teardown, further turns — none of it matters)
due → agent.followup(userMessage)   ← official wake channel
  ↓
agent (idle) opens a new turn → replies in the same conversation
```

Key points:

- The timer lives in the **plugin apply scope**, not `ctx.jobs` (which dies
  with the owning turn).
- `setTimeout().unref()` lets the process exit normally when only the timer is
  left — it never blocks the DSH lifecycle.
- `agent.followup()` is the runtime's official wake channel: a wake submitted
  while the agent is idle always opens a new turn boundary (see the runtime-types
  comments), so cross-turn waking is a supported semantic.

## Testing

`tests/` holds config-validation tests (`pnpm test`). End-to-end verification:

1. New session → have the agent call `schedule_reminder` with a 30 s delay;
2. After the agent finishes its turn, **send an interrupting message**;
3. ~30 s later the agent wakes and delivers the reminder → cross-turn survival
   confirmed.

`wait` interruption: have the agent call `wait` for 40 s, press stop mid-way →
the turn ends immediately instead of hanging for the full 40 s.

## License

MIT
