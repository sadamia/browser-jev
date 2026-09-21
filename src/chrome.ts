import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BjError } from "./errors.ts";

export const HOME = process.env.BROWSER_JEV_HOME ?? join(homedir(), ".cache", "browser-jev");
export const PROFILE_DIR = join(HOME, "profile");
export const COOKIES_FILE = join(HOME, "cookies.json");
const STATE_FILE = join(HOME, "state.json");

export interface BrowserState {
  pid: number;
  port: number;
  wsUrl: string;
  headed: boolean;
  currentTargetId?: string;
}

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function readState(): BrowserState | undefined {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeState(state: BrowserState): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

async function probe(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) });
    return (await res.json()).webSocketDebuggerUrl;
  } catch {
    return undefined;
  }
}

function chromePath(): string {
  const found = process.env.BROWSER_JEV_CHROME ?? CHROME_CANDIDATES.find(existsSync);
  if (!found) throw new BjError("config", "Chrome not found; set BROWSER_JEV_CHROME to its executable path");
  return found;
}

/** Attach to the running browser, or launch one. Relaunches only when headed/headless differs. */
export async function ensureBrowser(opts: { headed?: boolean; url?: string } = {}): Promise<{ state: BrowserState; launched: boolean }> {
  const headed = opts.headed ?? false;
  const state = readState();
  if (state) {
    const wsUrl = await probe(state.port);
    if (wsUrl && state.headed === headed) return { state: { ...state, wsUrl }, launched: false };
    if (wsUrl) await stopBrowser();
  }

  mkdirSync(PROFILE_DIR, { recursive: true });
  const portFile = join(PROFILE_DIR, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-size=1280,800",
    ...(headed ? [] : ["--headless=new"]),
    opts.url ?? "about:blank",
  ];
  const child = spawn(chromePath(), args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
      if (port && path) {
        const next: BrowserState = { pid: child.pid!, port: Number(port), wsUrl: `ws://127.0.0.1:${port}${path}`, headed };
        writeState(next);
        return { state: next, launched: true };
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new BjError("config", "Chrome did not expose a debugging port within 15s");
}

export async function stopBrowser(): Promise<boolean> {
  const state = readState();
  if (!state) return false;
  const alive = await probe(state.port);
  if (alive) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {}
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await probe(state.port))) await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(STATE_FILE, { force: true });
  return Boolean(alive);
}

export async function browserStatus(): Promise<{ running: boolean; state?: BrowserState }> {
  const state = readState();
  if (!state) return { running: false };
  return { running: Boolean(await probe(state.port)), state };
}
