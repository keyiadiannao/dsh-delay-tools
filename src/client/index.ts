/**
 * dsh-delay-tools browser half.
 *
 * No UI of its own: the plugin is purely a host-side tool (schedule_reminder)
 * that wakes the agent in the same conversation. This file exists so the
 * client bundle builds; the host tool works without any client contribution.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Required services (empty: nothing injected). */
export const inject = [] as const

export function apply(_ctx: ClientContext): void {
  // Intentional no-op: scheduling + wake happen entirely on the host side.
}
