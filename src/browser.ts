import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Protocol } from "devtools-protocol";
import { Connection } from "./cdp.ts";
import type { Session } from "./cdp.ts";
import { COOKIES_FILE, ensureBrowser, readState, writeState } from "./chrome.ts";
import { Page } from "./page.ts";
import type { RunContext } from "./page.ts";
import { stats } from "./perf.ts";
import type { BenchStats, Vitals } from "./perf.ts";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const toCookieParam = (c: Protocol.Network.Cookie): Protocol.Network.CookieParam => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  secure: c.secure,
  httpOnly: c.httpOnly,
  sameSite: c.sameSite,
  expires: c.session ? undefined : c.expires,
});

/** An isolated cookie/storage jar inside the same Chrome process; creating one takes milliseconds. */
export class Context {
  readonly id: string;
  #browser: Browser;
  constructor(browser: Browser, id: string) {
    this.#browser = browser;
    this.id = id;
  }
  newPage(opts: { viewport?: { width: number; height: number } } = {}): Promise<Page> {
    return this.#browser.newPage({ ...opts, contextId: this.id });
  }
  async close(): Promise<void> {
    await this.#browser.root.send("Target.disposeBrowserContext", { browserContextId: this.id }).catch(() => {});
  }
}

export class Browser {
  readonly conn: Connection;
  readonly root: Session;
  readonly launched: boolean;
  #ctx: RunContext;
  #contexts: Context[] = [];

  private constructor(conn: Connection, ctx: RunContext, launched: boolean) {
    this.conn = conn;
    this.root = conn.root;
    this.#ctx = ctx;
    this.launched = launched;
  }

  static async connect(ctx: RunContext, opts: { headed?: boolean; url?: string } = {}): Promise<Browser> {
    const { state, launched } = await ensureBrowser(opts);
    const browser = new Browser(await Connection.connect(state.wsUrl), ctx, launched);
    await browser.root.send("Target.setDiscoverTargets", { discover: true });
    if (launched && existsSync(COOKIES_FILE)) {
      const cookies = JSON.parse(readFileSync(COOKIES_FILE, "utf8"));
      await browser.root.send("Storage.setCookies", { cookies }).catch(() => {});
    }
    return browser;
  }

  async attach(targetId: string, opts: { viewport?: { width: number; height: number } } = {}): Promise<Page> {
    const { sessionId } = await this.root.send("Target.attachToTarget", { targetId, flatten: true });
    return new Page(this, this.conn.session(sessionId), targetId, this.#ctx).init({ viewport: opts.viewport ?? DEFAULT_VIEWPORT });
  }

  async newPage(opts: { contextId?: string; viewport?: { width: number; height: number } } = {}): Promise<Page> {
    const { targetId } = await this.root.send("Target.createTarget", { url: "about:blank", browserContextId: opts.contextId });
    return this.attach(targetId, opts);
  }

  /** Open tabs in the default (signed-in) context. */
  async pages(): Promise<{ targetId: string; url: string; title: string }[]> {
    const [{ targetInfos }, { browserContextIds }] = await Promise.all([this.root.send("Target.getTargets"), this.root.send("Target.getBrowserContexts")]);
    return targetInfos
      .filter((t) => t.type === "page" && !browserContextIds.includes(t.browserContextId ?? ""))
      .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title }));
  }

  /** The persistent working tab: survives across runs, so a later script can continue where the last one stopped. */
  async page(): Promise<Page> {
    const state = readState();
    const open = await this.pages();
    const current = open.find((p) => p.targetId === state?.currentTargetId) ?? open[0];
    const page = current ? await this.attach(current.targetId) : await this.newPage();
    if (state) writeState({ ...state, currentTargetId: page.targetId });
    return page;
  }

  /** Fresh isolated context. With `auth`, the signed-in cookies of the default context are copied in. */
  async newContext(opts: { auth?: boolean } = {}): Promise<Context> {
    const { browserContextId } = await this.root.send("Target.createBrowserContext", { disposeOnDetach: false });
    if (opts.auth) {
      const { cookies } = await this.root.send("Storage.getCookies", {});
      if (cookies.length) await this.root.send("Storage.setCookies", { cookies: cookies.map(toCookieParam), browserContextId });
    }
    const context = new Context(this, browserContextId);
    this.#contexts.push(context);
    return context;
  }

  /** Persist the default context's cookies (including session cookies) so they survive a browser restart. */
  async saveCookies(): Promise<number> {
    const { cookies } = await this.root.send("Storage.getCookies", {});
    writeFileSync(COOKIES_FILE, JSON.stringify(cookies.map(toCookieParam)));
    chmodSync(COOKIES_FILE, 0o600);
    return cookies.length;
  }

  /** Cold-load `url` several times, each in a fresh context, and aggregate web vitals. */
  async bench(
    url: string,
    opts: { runs?: number; cpu?: number; network?: "slow3g" | "fast3g" | "fast4g"; auth?: boolean } = {},
  ): Promise<{ runs: number; stats: Record<string, BenchStats>; samples: Vitals[] }> {
    const samples: Vitals[] = [];
    const runs = opts.runs ?? 5;
    for (let i = 0; i < runs; i++) {
      const context = await this.newContext({ auth: opts.auth });
      try {
        const page = await context.newPage();
        await page.emulate({ cpu: opts.cpu, network: opts.network });
        await page.goto(url, { timeout: 60_000 });
        await page.settle({ quiet: 500, timeout: 10_000 });
        samples.push(await page.perf.vitals());
      } finally {
        await context.close();
      }
    }
    const result: Record<string, BenchStats> = {};
    for (const key of ["ttfb", "fcp", "lcp", "cls", "tbt", "domContentLoaded", "load", "transferKB"] as const) {
      const s = stats(samples.map((v) => v[key]).filter((n) => n !== undefined));
      if (s) result[key] = s;
    }
    return { runs, stats: result, samples };
  }

  async dispose(): Promise<void> {
    await Promise.all(this.#contexts.map((c) => c.close()));
    this.conn.close();
  }
}
