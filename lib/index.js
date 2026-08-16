import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/index.ts
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
/** Live reminders by id (in-memory; see the durability note above). */
const reminders = /* @__PURE__ */ new Map();
/** Every live timer handle, so plugin disposal can cancel them all. */
const pluginTimers = /* @__PURE__ */ new Set();
/** Count reminders still pending for ONE agent. */
function pendingCount(agentId) {
	let n = 0;
	const now = Date.now();
	for (const r of reminders.values()) if (r.agentId === agentId && r.dueAt > now) n += 1;
	return n;
}
/** Clamp a requested delay into [minDelayMs, maxDelayMs]; fall back to the
* default, ALSO clamped (defense in depth even if the config invariant was
* somehow violated). */
function clampDelay(requested, config) {
	const n = Number(requested);
	const value = Number.isFinite(n) && n > 0 ? Math.floor(n) : config.defaultDelayMs;
	return Math.min(Math.max(value, config.minDelayMs), config.maxDelayMs);
}
/** Validate the cross-field delay invariant: min <= default <= max. */
function assertDelayInvariant(config) {
	if (!(config.minDelayMs <= config.defaultDelayMs && config.defaultDelayMs <= config.maxDelayMs)) throw new Error(`dsh-delay-tools: invalid delay config — require minDelayMs (${config.minDelayMs}) <= defaultDelayMs (${config.defaultDelayMs}) <= maxDelayMs (${config.maxDelayMs})`);
}
function apply(ctx, config) {
	assertDelayInvariant(config);
	ctx.effect(() => () => {
		for (const timer of pluginTimers) clearTimeout(timer);
		pluginTimers.clear();
		reminders.clear();
	}, "dsh-delay-tools: clear pending timers");
	ctx.tools.register({
		name: "schedule_reminder",
		description: "Schedule the agent to wake up and message you after a delay, in the SAME conversation. Unlike a background shell timer (which dies with the turn), this uses a host-level timer and the official agent wake channel, so the reminder survives even after this turn ends. Multiple reminders per conversation are supported (each has its own reminder_id). NOTE: reminders are in-memory — restarting the DSH host cancels pending reminders. The agent will resume and deliver `message` to you after `delay_ms`.",
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
					reminder_id: { type: "string" },
					due_at: { type: "string" },
					delay_ms: { type: "number" },
					pending: { type: "number" }
				},
				required: [
					"scheduled",
					"reminder_id",
					"due_at",
					"delay_ms",
					"pending"
				]
			},
			render: (_args, value) => [{
				type: "text",
				text: `Reminder ${value.reminder_id} scheduled: will wake in ${value.delay_ms}ms (due ${value.due_at}); ${value.pending} reminder(s) pending.`
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			const delay = clampDelay(args.delay_ms, config);
			const text = typeof args.message === "string" && args.message.trim().length > 0 ? args.message.trim() : "(reminder)";
			const agentId = String(agent?.id ?? "unknown");
			const dueAt = Date.now() + delay;
			const reminderId = randomUUID();
			const timer = setTimeout(() => {
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
				reminders.delete(reminderId);
				pluginTimers.delete(timer);
			}, delay);
			timer.unref();
			pluginTimers.add(timer);
			reminders.set(reminderId, {
				agentId,
				dueAt,
				text,
				timer
			});
			return {
				scheduled: true,
				reminder_id: reminderId,
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
