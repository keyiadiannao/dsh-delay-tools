import z from "@deepseek-ai/schemastery";
//#region src/index.d.ts
declare const name = "dsh-schedule-reminder";
declare const inject: string[];
/** Plugin configuration. */
interface Config {
  /** Default delay in ms when the tool is called without one. */
  defaultDelayMs: number;
  /** Upper bound (ms) for a single reminder delay. */
  maxDelayMs: number;
  /** Minimum delay (ms); guards against accidental instant re-entry. */
  minDelayMs: number;
}
/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
declare const Config: z<Config>;
declare function apply(ctx: any, config: Config): void;
//#endregion
export { Config, apply, inject, name };