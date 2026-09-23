import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Browser } from "./browser.ts";
import { browserStatus, launchLoginWindow, stopBrowser, stopLoginWindow, waitForLogin } from "./chrome.ts";
import { BjError } from "./errors.ts";
import { Jev } from "./jev.ts";
import type { RunContext } from "./page.ts";
import { clearPagemap } from "./pagemap.ts";
import type { ScriptFn } from "./index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".runs");

const USAGE = `bj — typed browser automation over CDP with Jev decisions

  bj run <script.ts | ->  [--out <dir>] [--no-check] [--headed]   run a script (use - for stdin)
  bj snapshot [url] [--all]                                       print the working tab (interactive elements, or everything)
  bj login <url>            open a plain visible window for a human to sign in, wait until they land back on
                            the site (or close the window), then return to headless, signed in
                            [--done <url-substring>] [--timeout <s>=600] [--no-wait]
  bj login --finish         (after --no-wait) close the window, save cookies, return to headless
  bj start | stop | status  manage the background Chrome
  bj cache clear            forget cached element resolutions`;

const print = (value: unknown) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 1)}\n`);

function flag(args: string[], name: string, takesValue = false): string | boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  const [, value] = args.splice(i, takesValue ? 2 : 1);
  return takesValue ? (value ?? "") : true;
}

function newContext(outDir?: string): RunContext {
  const dir = resolve(outDir || join(tmpdir(), "browser-jev", `run-${Date.now()}`));
  mkdirSync(dir, { recursive: true });
  return { jev: new Jev(), steps: [], outDir: dir };
}

function typecheck(file: string): string[] {
  const res = spawnSync(
    join(ROOT, "node_modules", ".bin", "tsc"),
    ["--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "es2023", "--lib", "es2023,dom", "--module", "nodenext", "--allowImportingTsExtensions", "--types", "node", "--pretty", "false", file],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (res.status === 0) return [];
  return `${res.stdout}${res.stderr}`.split("\n").filter((line) => line.trim()).slice(0, 20);
}

async function run(args: string[]): Promise<number> {
  const out = flag(args, "--out", true) as string;
  const noCheck = flag(args, "--no-check");
  const headed = Boolean(flag(args, "--headed"));
  const source = args[0];
  if (!source) throw new BjError("config", "bj run needs a script path, or - to read the script from stdin");

  mkdirSync(RUNS, { recursive: true });
  const file = join(RUNS, `run-${Date.now()}.ts`);
  if (source === "-") writeFileSync(file, readFileSync(0, "utf8"));
  else copyFileSync(resolve(source), file);

  const started = performance.now();
  if (!noCheck) {
    const errors = typecheck(file);
    if (errors.length) {
      print({ ok: false, phase: "typecheck", errors, note: "nothing was executed; fix the script and rerun" });
      return 2;
    }
  }
  const checkMs = Math.round(performance.now() - started);

  const ctx = newContext(out);
  const logs: string[] = [];
  const browser = await Browser.connect(ctx, { headed });
  const page = await browser.page();
  let exit = 0;
  let report: Record<string, unknown>;
  try {
    const mod = await import(pathToFileURL(file).href);
    const fn: ScriptFn = mod.default;
    if (typeof fn !== "function") throw new BjError("config", "the script must `export default script(async (ctx) => { ... })`");
    const result = await fn({
      browser,
      page,
      jev: ctx.jev,
      outDir: ctx.outDir,
      log: (...parts) => logs.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")),
    });
    report = { ok: true, result };
  } catch (err) {
    exit = 1;
    const e = err as Error;
    const lastStep = ctx.steps.at(-1);
    const failedStep = lastStep && !lastStep.ok ? lastStep : undefined;
    report = {
      ok: false,
      error: { code: e instanceof BjError ? e.code : e.name, message: e.message, ...(e instanceof BjError ? e.details : {}) },
      failedStep: failedStep ? `${failedStep.op} ${failedStep.arg ?? ""}`.trim() : undefined,
      at: await (ctx.active ?? page).url().catch(() => undefined),
      ...(await (ctx.active ?? page).diagnose().catch(() => ({}))),
    };
  }

  const steps = ctx.steps.map((s) => `${s.ok ? "" : "FAILED "}${s.op}${s.arg ? ` ${s.arg}` : ""} ${s.ms}ms`);
  print({
    ...report,
    logs: logs.length ? logs : undefined,
    steps: exit === 0 && steps.length > 25 ? [`${steps.length} steps`, ...steps.slice(-10)] : steps,
    timing: { totalMs: Math.round(performance.now() - started), typecheckMs: checkMs, browserLaunched: browser.launched },
    jev: ctx.jev.stats.calls ? ctx.jev.stats : undefined,
    outDir: ctx.outDir,
  });
  await browser.dispose();
  return exit;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "run":
      return run(args);
    case "snapshot": {
      const all = flag(args, "--all");
      const browser = await Browser.connect(newContext());
      const page = await browser.page();
      if (args[0]) await page.goto(args[0]);
      print(await page.view({ interactive: !all, maxChars: 20_000 }));
      await browser.dispose();
      return 0;
    }
    case "login": {
      if (flag(args, "--finish")) {
        const wasOpen = await stopLoginWindow();
        const browser = await Browser.connect(newContext());
        const saved = await browser.saveCookies();
        await browser.dispose();
        print(`${wasOpen ? "closed the login window; " : ""}saved ${saved} cookies; the browser is now headless and signed in`);
        return 0;
      }
      const done = flag(args, "--done", true) || undefined;
      const timeoutMs = Number(flag(args, "--timeout", true) || 600) * 1000;
      const url = args.find((a) => !a.startsWith("--"));
      if (!url) throw new BjError("config", "bj login needs the URL to sign in at");
      const { pid, baselineVisitId } = await launchLoginWindow(url);
      if (flag(args, "--no-wait")) {
        print("A plain Chrome window (no DevTools port, so sign-in pages accept it) is open on the automation profile. Ask the user to sign in there, then run: bj login --finish");
        return 0;
      }
      process.stderr.write("A Chrome window is open; waiting for the user to sign in there...\n");
      const how = await waitForLogin({ pid, url, done: typeof done === "string" ? done : undefined, timeoutMs, baselineVisitId });
      if (how === "timeout") {
        await stopLoginWindow();
        throw new BjError("config", `no sign-in detected within ${timeoutMs / 1000}s; the window was closed. Rerun bj login, or pass --done <url-substring> if the signed-in page is not on ${url}`);
      }
      await stopLoginWindow();
      const browser = await Browser.connect(newContext());
      const saved = await browser.saveCookies();
      await browser.dispose();
      print({ ok: true, signedIn: how, cookies: saved, message: "the browser is now headless and signed in; run scripts normally" });
      return 0;
    }
    case "start": {
      const browser = await Browser.connect(newContext(), { headed: Boolean(flag(args, "--headed")) });
      print(browser.launched ? "started" : "already running");
      await browser.dispose();
      return 0;
    }
    case "stop":
      print((await stopBrowser()) ? "stopped" : "not running");
      return 0;
    case "status":
      print(await browserStatus());
      return 0;
    case "cache":
      if (args[0] !== "clear") break;
      clearPagemap();
      print("page map cleared");
      return 0;
  }
  print(USAGE);
  return command ? 64 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    print({ ok: false, error: { code: err instanceof BjError ? err.code : err?.name, message: err?.message ?? String(err) } });
    process.exit(1);
  },
);
