/**
 * dsh-delay-tools browser half.
 *
 * No UI of its own: the plugin is purely a host-side tool (schedule_reminder)
 * that wakes the agent in the same conversation. This file exists so the
 * client bundle builds; the host tool works without any client contribution.
 *
 * Because nothing is contributed, this row injects no other client row
 * (`package.json` declares an empty `dsh.client.inject`) — the three names it
 * used to list were removed from DSH or were never injectable rows.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Required services (empty: nothing injected). */
export const inject = [] as const

export function apply(_ctx: ClientContext): void {
  // Intentional no-op: scheduling + wake happen entirely on the host side.
}
