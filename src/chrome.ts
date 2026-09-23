import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BjError } from "./errors.ts";

export const HOME = process.env.BROWSER_JEV_HOME ?? join(homedir(), ".cache", "browser-jev");
export const PROFILE_DIR = join(HOME, "profile");
export const COOKIES_FILE = join(HOME, "cookies.json");
const STATE_FILE = join(HOME, "state.json");
const LOGIN_FILE = join(HOME, "login.json");

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

/**
 * Flags that must be identical between the login window and the automation browser: the cookie store is
 * encrypted with the keychain the profile was created under, so a mismatch makes the signed-in cookies unreadable.
 */
function profileArgs(): string[] {
  return [`--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic"];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pidAlive(pid)) await new Promise((r) => setTimeout(r, 100));
  return !pidAlive(pid);
}

/**
 * Open a plain, visible Chrome on the automation profile for a human to sign in. Deliberately no
 * --remote-debugging-port and no automation flags: Google and other identity providers refuse sign-in
 * ("Try again" / "This browser or app may not be secure") when the browser is under DevTools control.
 * The session lands in the profile on disk, where the headless automation browser picks it up later.
 */
export async function launchLoginWindow(url: string): Promise<{ pid: number; baselineVisitId: number }> {
  await stopBrowser();
  await stopLoginWindow();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const baselineVisitId = await maxVisitId();
  const child = spawn(chromePath(), [...profileArgs(), "--window-size=1280,800", url], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(LOGIN_FILE, JSON.stringify({ pid: child.pid }));
  return { pid: child.pid!, baselineVisitId };
}

const CHAIN_END = 0x20000000; // Chrome history transition flag: last hop of a redirect chain, i.e. a page that actually rendered

interface Visit {
  id: number;
  url: string;
  chainEnd: boolean;
}

/** Visits recorded in the automation profile's History, newest first. Empty when the DB is unreadable or node:sqlite is missing. */
async function historyVisits(afterId: number): Promise<Visit[]> {
  const src = join(PROFILE_DIR, "Default", "History");
  if (!existsSync(src)) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const copy = join(tmpdir(), `bj-history-${process.pid}.db`);
    // Chrome holds the live file locked; a snapshot copy (plus its WAL/journal sidecars, which hold the newest pages) is enough
    copyFileSync(src, copy);
    for (const ext of ["-wal", "-journal"]) {
      if (existsSync(src + ext)) copyFileSync(src + ext, copy + ext);
      else rmSync(copy + ext, { force: true });
    }
    const db = new DatabaseSync(copy);
    try {
      return db
        // visit_time is a 64-bit microsecond stamp that overflows a JS number, so it is deliberately not selected
        .prepare("SELECT v.id AS id, u.url AS url, v.transition AS transition FROM visits v JOIN urls u ON u.id = v.url WHERE v.id > ? ORDER BY v.id DESC")
        .all(afterId)
        .map((r: any) => ({ id: Number(r.id), url: String(r.url), chainEnd: (Number(r.transition) & CHAIN_END) !== 0 }));
    } finally {
      db.close();
      for (const ext of ["", "-wal", "-journal", "-shm"]) rmSync(copy + ext, { force: true });
    }
  } catch (e) {
    if (process.env.BJ_DEBUG) process.stderr.write(`history read failed: ${(e as Error).message}\n`);
    return [];
  }
}

async function maxVisitId(): Promise<number> {
  const src = join(PROFILE_DIR, "Default", "History");
  if (!existsSync(src)) return 0;
  const all = await historyVisits(0);
  return all[0]?.id ?? 0;
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Block until the human has signed in, then hand the profile back to automation.
 * Signed-in is detected as: the login window navigated (after at least one other page, e.g. the identity
 * provider) and landed on `done` — a URL substring, defaulting to the origin of `url` — or the human closed
 * the window. Returns how it ended.
 */
export async function waitForLogin(opts: { pid: number; url: string; done?: string; timeoutMs: number; baselineVisitId: number }): Promise<"landed" | "closed" | "timeout"> {
  // Match on origin (or host+path for --done), never on the full URL: identity providers carry the target
  // in query strings such as continue=https://mail.google.com/..., which would fire before any sign-in.
  const target = origin(opts.url);
  const onTarget = (u: string): boolean => {
    try {
      const parsed = new URL(u);
      return opts.done ? (parsed.host + parsed.pathname).includes(opts.done) : parsed.origin === target;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(opts.pid)) return "closed";
    const visits = await historyVisits(opts.baselineVisitId);
    if (process.env.BJ_DEBUG) process.stderr.write(`poll: ${visits.length} visits after #${opts.baselineVisitId}: ${visits.map((v) => `${v.id}${v.chainEnd ? "*" : ""} ${v.url.slice(0, 80)}`).join(" | ")}\n`);
    const first = visits[visits.length - 1]; // the launch navigation itself
    const landed = visits.find((v) => v.chainEnd && onTarget(v.url));
    if (landed && first && landed.id !== first.id) {
      const leftSite = !onTarget(first.url) || visits.some((v) => v.id > first.id && v.id < landed.id && !onTarget(v.url));
      if (leftSite || opts.done) return "landed";
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return "timeout";
}

/** Close the login window if it is still open, so the profile lock is released. Returns true if it was open. */
export async function stopLoginWindow(): Promise<boolean> {
  let pid: number | undefined;
  try {
    pid = JSON.parse(readFileSync(LOGIN_FILE, "utf8")).pid;
  } catch {}
  rmSync(LOGIN_FILE, { force: true });
  if (!pid || !pidAlive(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if (!(await waitForExit(pid, 8_000))) throw new BjError("config", `login window (pid ${pid}) did not exit; quit it and rerun bj login --finish`);
  return true;
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
    ...profileArgs(),
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
