import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/index.ts
/**
* dsh-delay-tools — host half.
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
* @module dsh-delay-tools
*/
const name = "dsh-delay-tools";
const inject = ["tools"];
/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
const Config = z.object({
	defaultDelayMs: z.number().min(1e3).max(864e5).default(6e4),
	maxDelayMs: z.number().min(1e3).max(864e5).default(36e5),
	minDelayMs: z.number().min(0).max(6e4).default(1e3)
});
/** Source marker for the synthetic wake message (visible in the transcript). */
const REMINDER_SOURCE = {
	kind: "plugin",
	plugin: "dsh-delay-tools"
};
/** Track live reminders so a second call can report how many are pending. */
const pending = /* @__PURE__ */ new Map();
/** Human-readable pending count for the tool's return value. */
function pendingCount(agentId) {
	let n = 0;
	for (const entry of pending.values()) if (entry.dueAt > Date.now()) n += 1;
	return n;
}
/** Clamp a requested delay into [minDelayMs, maxDelayMs]; fall back to the default. */
function clampDelay(requested, config) {
	const n = Number(requested);
	return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), config.minDelayMs), config.maxDelayMs) : config.defaultDelayMs;
}
function apply(ctx, config) {
	ctx.tools.register({
		name: "schedule_reminder",
		description: "Schedule the agent to wake up and message you after a delay, in the SAME conversation. Unlike a background shell timer (which dies with the turn), this uses a host-level timer and the official agent wake channel, so the reminder survives even after this turn ends. The agent will resume and deliver `message` to you after `delay_ms`.",
		parameters: {
			type: "object",
			properties: {
				delay_ms: {
					type: "number",
					description: `Delay in milliseconds before waking (min ${config.minDelayMs}, max ${config.maxDelayMs}; default ${config.defaultDelayMs}).`
				},
				message: {
					type: "string",
					description: "The text the agent should deliver to you when the delay elapses. Write it as a direct message to the user."
				}
			},
			required: ["message"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					scheduled: { type: "boolean" },
					due_at: { type: "string" },
					delay_ms: { type: "number" },
					pending: { type: "number" }
				},
				required: [
					"scheduled",
					"due_at",
					"delay_ms",
					"pending"
				]
			},
			render: (_args, value) => [{
				type: "text",
				text: `Reminder scheduled: will wake in ${value.delay_ms}ms (due ${value.due_at}); ${value.pending} reminder(s) pending.`
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			const delay = clampDelay(args.delay_ms, config);
			const text = typeof args.message === "string" && args.message.trim().length > 0 ? args.message.trim() : "(reminder)";
			const agentId = String(agent?.id ?? "unknown");
			const dueAt = Date.now() + delay;
			setTimeout(() => {
				const message = createUserMessage({
					content: [{
						type: "text",
						text
					}],
					source: REMINDER_SOURCE
				});
				try {
					agent.followup?.(message);
				} catch {}
				pending.delete(agentId);
			}, delay).unref();
			pending.set(agentId, {
				dueAt,
				text
			});
			return {
				scheduled: true,
				due_at: new Date(dueAt).toISOString(),
				delay_ms: delay,
				pending: pendingCount(agentId)
			};
		}
	}, "dsh-delay-tools: schedule_reminder tool");
	ctx.tools.register({
		name: "wait",
		description: "Pause the CURRENT turn for `delay_ms` milliseconds, then continue (a timed gate). While waiting, the agent can do nothing else, and user messages sent during the wait are queued and answered after the wait finishes. Unlike schedule_reminder (which schedules a wake-up and does NOT block), this BLOCKS the current turn — use it when work must pause for a fixed duration, e.g. \"wait 30 seconds, then continue\".",
		parameters: {
			type: "object",
			properties: { delay_ms: {
				type: "number",
				description: `Milliseconds to block (min ${config.minDelayMs}, max ${config.maxDelayMs}; default ${config.defaultDelayMs}).`
			} },
			required: []
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					waited_ms: { type: "number" },
					elapsed_until: { type: "string" },
					note: { type: "string" }
				},
				required: [
					"waited_ms",
					"elapsed_until",
					"note"
				]
			},
			render: (_args, value) => [{
				type: "text",
				text: `Waited ${value.waited_ms}ms (until ${value.elapsed_until}); ${value.note}`
			}]
		},
		async execute(args, exec) {
			const delay = clampDelay(args.delay_ms, config);
			const start = Date.now();
			await new Promise((resolve) => {
				if (exec.signal?.aborted === true) {
					resolve();
					return;
				}
				const timer = setTimeout(resolve, delay);
				exec.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				}, { once: true });
			});
			const aborted = exec.signal?.aborted === true;
			return {
				waited_ms: Date.now() - start,
				elapsed_until: (/* @__PURE__ */ new Date()).toISOString(),
				note: aborted ? "Wait interrupted by the user (stop)." : "Delay elapsed; continue your current task."
			};
		}
	}, "dsh-delay-tools: wait tool");
}
//#endregion
export { Config, apply, inject, name };
