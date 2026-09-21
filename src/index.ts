import type { Browser } from "./browser.ts";
import type { Jev } from "./jev.ts";
import type { Page } from "./page.ts";

export { choice, noul, score } from "@typesafe-ai/sdk";
export { Browser, Context } from "./browser.ts";
export { BjError } from "./errors.ts";
export type { BjErrorCode } from "./errors.ts";
export { Jev } from "./jev.ts";
export { Page } from "./page.ts";
export type { ConsoleEntry, FindOptions, Req, ResponseInfo, Step, Target } from "./page.ts";
export type { BenchStats, CpuSummary, TraceSummary, Vitals } from "./perf.ts";
export type { El, Query, Snapshot } from "./snapshot.ts";

export interface ScriptContext {
  browser: Browser;
  /** The persistent working tab in the signed-in default context. */
  page: Page;
  jev: Jev;
  /** Directory for screenshots, traces, and other artifacts of this run. */
  outDir: string;
  log: (...args: unknown[]) => void;
}

export type ScriptFn = (ctx: ScriptContext) => unknown;

/** Entry point of a run script: `export default script(async ({ page }) => { ... })`. */
export const script = (fn: ScriptFn): ScriptFn => fn;
