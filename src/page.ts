import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { choice, noul, score } from "@typesafe-ai/sdk";
import type { ChoiceCriteria, ChoiceResponse, Questions, ScoreCriteria, ScoreResponse, SystemOneResult } from "@typesafe-ai/sdk";
import type { Browser } from "./browser.ts";
import type { Session } from "./cdp.ts";
import { BjError } from "./errors.ts";
import { pickElements } from "./jev.ts";
import type { Jev } from "./jev.ts";
import { forget, lookup, remember } from "./pagemap.ts";
import { Perf } from "./perf.ts";
import { buildElements, describe, queryElements, render } from "./snapshot.ts";
import type { El, Query, Snapshot } from "./snapshot.ts";

export type Target = string | Query | El;

export interface FindOptions {
  /** Below this Jev confidence the lookup throws low_confidence with the top candidates. Raise it for destructive actions. */
  minConfidence?: number;
  among?: "interactive" | "all";
  cache?: boolean;
}

export interface Step {
  op: string;
  arg?: string;
  ms: number;
  ok: boolean;
}

export interface RunContext {
  jev: Jev;
  steps: Step[];
  outDir: string;
  /** The page that ran the most recent step, so failures are diagnosed where they happened. */
  active?: Page;
}

export interface Req {
  id: string;
  url: string;
  method: string;
  type: string;
  status?: number;
  mimeType?: string;
  failed?: string;
  ms?: number;
  bytes?: number;
  fromCache?: boolean;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  url?: string;
}

export interface ResponseInfo extends Req {
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

type WaitUntil = "load" | "domcontentloaded" | "networkidle";
const LIFECYCLE: Record<WaitUntil, string> = { load: "load", domcontentloaded: "DOMContentLoaded", networkidle: "networkIdle" };

const NETWORK_PRESETS = {
  slow3g: { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  fast3g: { offline: false, latency: 562.5, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  fast4g: { offline: false, latency: 165, downloadThroughput: 1_012_500, uploadThroughput: 168_750 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
} as const;

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const HANDLES = "browser-jev";
const IGNORED_INFLIGHT = new Set(["WebSocket", "EventSource", "Media", "Ping"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isEl = (t: Target): t is El => typeof t === "object" && "ref" in t && "states" in t;
const short = (t: Target): string =>
  typeof t === "string" ? t : isEl(t) ? `@${t.ref} ${describe(t, false)}` : JSON.stringify(t, (_k, v) => (v instanceof RegExp ? String(v) : v));

export class Page {
  readonly session: Session;
  readonly targetId: string;
  readonly browser: Browser;
  readonly perf: Perf;
  readonly dialogs: { type: string; message: string }[] = [];
  dialogMode: "accept" | "dismiss" = "accept";
  defaultTimeout = 10_000;

  #ctx: RunContext;
  #refs = new Map<string, El>();
  #requests = new Map<string, Req & { started: number }>();
  #log: Req[] = [];
  #inflight = new Set<string>();
  #lastNet = 0;
  #loading = false;
  #lifecycle = new Map<string, Set<string>>();
  #console: ConsoleEntry[] = [];
  #mainFrame: string;
  #stepDepth = 0;
  #recording: { pace: number; marks: boolean } | undefined;

  constructor(browser: Browser, session: Session, targetId: string, ctx: RunContext) {
    this.browser = browser;
    this.session = session;
    this.targetId = targetId;
    this.#mainFrame = targetId;
    this.#ctx = ctx;
    this.perf = new Perf(this, ctx);
  }

  async init(opts: { viewport?: { width: number; height: number } } = {}): Promise<this> {
    const s = this.session;
    s.on("Page.lifecycleEvent", (e) => {
      if (e.frameId !== this.#mainFrame) return;
      let set = this.#lifecycle.get(e.loaderId);
      if (!set) this.#lifecycle.set(e.loaderId, (set = new Set()));
      set.add(e.name);
    });
    s.on("Page.frameStartedLoading", (e) => {
      if (e.frameId === this.#mainFrame) this.#loading = true;
    });
    s.on("Page.frameStoppedLoading", (e) => {
      if (e.frameId === this.#mainFrame) this.#loading = false;
    });
    s.on("Page.javascriptDialogOpening", (e) => {
      this.dialogs.push({ type: e.type, message: e.message });
      void s.send("Page.handleJavaScriptDialog", { accept: this.dialogMode === "accept" }).catch(() => {});
    });
    s.on("Network.requestWillBeSent", (e) => {
      const type = e.type ?? "Other";
      const req = { id: e.requestId, url: e.request.url, method: e.request.method, type, started: performance.now() };
      this.#requests.set(e.requestId, req);
      this.#log.push(req);
      if (this.#log.length > 2000) this.#log.shift();
      if (!IGNORED_INFLIGHT.has(type) && !e.request.url.startsWith("data:")) this.#inflight.add(e.requestId);
      this.#lastNet = performance.now();
    });
    s.on("Network.responseReceived", (e) => {
      const req = this.#requests.get(e.requestId);
      if (!req) return;
      req.status = e.response.status;
      req.mimeType = e.response.mimeType;
      req.fromCache = e.response.fromDiskCache || e.response.fromPrefetchCache || undefined;
    });
    s.on("Network.loadingFinished", (e) => this.#finish(e.requestId, { bytes: e.encodedDataLength }));
    s.on("Network.loadingFailed", (e) => this.#finish(e.requestId, { failed: e.canceled ? "canceled" : e.errorText }));
    s.on("Runtime.consoleAPICalled", (e) => {
      const text = e.args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type))).join(" ");
      this.#pushConsole({ type: e.type === "warning" ? "warn" : e.type, text, url: e.stackTrace?.callFrames[0]?.url });
    });
    s.on("Runtime.exceptionThrown", (e) => {
      const d = e.exceptionDetails;
      this.#pushConsole({ type: "exception", text: d.exception?.description ?? d.text, url: d.url });
    });
    s.on("Log.entryAdded", (e) => {
      if (e.entry.level === "error" || e.entry.level === "warning") this.#pushConsole({ type: e.entry.level === "error" ? "error" : "warn", text: e.entry.text, url: e.entry.url });
    });

    await Promise.all([
      s.send("Page.enable"),
      s.send("Runtime.enable"),
      s.send("Network.enable"),
      s.send("Log.enable"),
      s.send("Page.setLifecycleEventsEnabled", { enabled: true }),
    ]);
    const { frameTree } = await s.send("Page.getFrameTree");
    this.#mainFrame = frameTree.frame.id;
    await this.perf.install();
    if (opts.viewport) await this.viewport(opts.viewport.width, opts.viewport.height);
    return this;
  }

  #finish(id: string, patch: Partial<Req>): void {
    const req = this.#requests.get(id);
    if (req) Object.assign(req, patch, { ms: Math.round(performance.now() - req.started) });
    this.#inflight.delete(id);
    this.#lastNet = performance.now();
  }

  #pushConsole(entry: ConsoleEntry): void {
    this.#console.push({ ...entry, text: entry.text.slice(0, 1000) });
    if (this.#console.length > 1000) this.#console.shift();
  }

  async step<T>(op: string, arg: string | undefined, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const record: Step = { op, arg: arg?.slice(0, 120), ms: 0, ok: false };
    this.#ctx.steps.push(record);
    this.#ctx.active = this;
    this.#stepDepth++;
    try {
      const result = await fn();
      record.ok = true;
      return result;
    } finally {
      record.ms = Math.round(performance.now() - started);
      if (this.#stepDepth === 1 && this.#recording && record.ok && op !== "find" && op !== "ask") await sleep(this.#recording.pace);
      // Handles to page objects keep removed DOM nodes alive; drop them once the outermost step is done.
      if (--this.#stepDepth === 0) void this.session.send("Runtime.releaseObjectGroup", { objectGroup: HANDLES }).catch(() => {});
    }
  }

  async #until(cond: () => boolean | Promise<boolean>, timeout: number, label: string, interval = 20): Promise<void> {
    const deadline = performance.now() + timeout;
    for (;;) {
      if (await cond()) return;
      if (performance.now() > deadline) throw new BjError("timeout", `timed out after ${timeout}ms waiting for ${label}`);
      await sleep(interval);
    }
  }

  // ---------- navigation ----------

  goto(url: string, opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<void> {
    return this.step("goto", url, async () => {
      const res = await this.session.send("Page.navigate", { url });
      if (res.errorText) throw new BjError("navigation", `navigation to ${url} failed: ${res.errorText}`);
      if (!res.loaderId) return;
      const wanted = LIFECYCLE[opts.waitUntil ?? "load"];
      await this.#until(() => this.#lifecycle.get(res.loaderId!)?.has(wanted) ?? false, opts.timeout ?? 30_000, `${wanted} of ${url}`);
    });
  }

  reload(opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<void> {
    return this.step("reload", undefined, async () => {
      this.#loading = true;
      await this.session.send("Page.reload");
      await this.waitForLoad(opts);
    });
  }

  back(): Promise<void> {
    return this.#history(-1);
  }

  forward(): Promise<void> {
    return this.#history(1);
  }

  #history(delta: number): Promise<void> {
    return this.step(delta < 0 ? "back" : "forward", undefined, async () => {
      const { currentIndex, entries } = await this.session.send("Page.getNavigationHistory");
      const entry = entries[currentIndex + delta];
      if (!entry) throw new BjError("navigation", "no history entry in that direction");
      await this.session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await this.settle();
    });
  }

  async waitForLoad(opts: { timeout?: number } = {}): Promise<void> {
    await sleep(30);
    await this.#until(() => !this.#loading, opts.timeout ?? 30_000, "page load");
  }

  /** Wait until navigation has finished and the network has been quiet briefly. Never throws. */
  async settle(opts: { quiet?: number; timeout?: number } = {}): Promise<void> {
    const quiet = opts.quiet ?? 100;
    await sleep(40);
    await this.#until(
      () => !this.#loading && this.#inflight.size === 0 && performance.now() - this.#lastNet >= quiet,
      opts.timeout ?? 3_000,
      "settle",
    ).catch(() => {});
  }

  async url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  async title(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  // ---------- observation ----------

  async snapshot(): Promise<Snapshot> {
    const s = this.session;
    const [{ nodes }, info, { frameTree }] = await Promise.all([
      s.send("Accessibility.getFullAXTree", {}),
      this.evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })"),
      s.send("Page.getFrameTree"),
    ]);
    const elements = buildElements(nodes, 1);
    const childFrames = (frameTree.childFrames ?? []).map((f) => f.frame);
    for (const frame of childFrames) {
      try {
        const sub = await s.send("Accessibility.getFullAXTree", { frameId: frame.id });
        elements.push(...buildElements(sub.nodes, elements.length + 1, frame.name || frame.url));
      } catch {}
    }
    this.#refs = new Map(elements.map((el) => [el.ref, el]));
    return { ...info, elements };
  }

  /** Text rendering of the page for the agent to read; refs are valid until the next snapshot. */
  async view(opts: { interactive?: boolean; maxChars?: number } = {}): Promise<string> {
    return render(await this.snapshot(), { maxChars: 12_000, ...opts });
  }

  /** Deterministic lookup by role/name/text. Throws not_found or ambiguous. */
  get(query: Query, opts: { timeout?: number } = {}): Promise<El> {
    return this.step("get", short(query), () => this.#resolve(query, opts.timeout ?? this.defaultTimeout));
  }

  /** Jev-backed lookup by natural-language description, cached per route after the first hit. */
  async find(description: string, opts: FindOptions = {}): Promise<El> {
    return (await this.findAll({ target: description }, opts)).target;
  }

  /** Resolve several descriptions in ONE Jev request (parallel questions), so a whole screen costs one round trip. */
  findAll<const T extends Record<string, string>>(targets: T, opts: FindOptions = {}): Promise<{ [K in keyof T]: El }> {
    return this.step("find", Object.values(targets).join(" | "), async () => {
      const snap = await this.snapshot();
      const useCache = opts.cache !== false;
      const found: Record<string, El> = {};
      const pending: Record<string, string> = {};
      for (const [key, description] of Object.entries(targets)) {
        const hit = useCache ? lookup(snap.url, description) : undefined;
        const cached = hit ? queryElements(snap.elements, { role: hit.role, name: hit.name, exact: true }) : [];
        if (cached.length === 1) found[key] = cached[0]!;
        else {
          if (hit) forget(snap.url, description);
          pending[key] = description;
        }
      }
      if (Object.keys(pending).length) {
        const pool = snap.elements.filter((el) => (opts.among === "all" ? true : el.interactive));
        const unnamed = pool.filter((el) => el.name === "" && el.backendNodeId !== undefined).slice(0, 40);
        const hints = new Map<string, string>();
        await Promise.all(
          unnamed.map(async (el) => {
            try {
              const { outerHTML } = await this.session.send("DOM.getOuterHTML", { backendNodeId: el.backendNodeId });
              hints.set(el.ref, outerHTML.replace(/\s+/g, " ").slice(0, 160));
            } catch {}
          }),
        );
        const screen = render(snap, { refs: false, maxChars: 16_000 });
        const picks = await pickElements(this.#ctx.jev, pending, { url: snap.url, title: snap.title, screen }, pool, { minConfidence: opts.minConfidence ?? 0.7, hints });
        for (const [key, pick] of Object.entries(picks)) {
          if (pick instanceof BjError) throw pick;
          const { el } = pick;
          const unique = el.name !== "" && queryElements(snap.elements, { role: el.role, name: el.name, exact: true }).length === 1;
          if (useCache && unique) remember(snap.url, pending[key]!, { role: el.role, name: el.name });
          found[key] = el;
        }
      }
      return found as { [K in keyof T]: El };
    });
  }

  async #resolve(target: Target, timeout: number, opts: { enabled?: boolean } = {}): Promise<El> {
    if (isEl(target)) return target;
    if (typeof target === "string" && target.startsWith("@")) {
      const el = this.#refs.get(target.slice(1));
      if (!el) throw new BjError("not_found", `unknown ref ${target}; refs are only valid after snapshot()/view() on this page`);
      return el;
    }
    const deadline = performance.now() + timeout;
    let lastProblem = "no match";
    for (;;) {
      if (typeof target === "string") {
        const { result } = await this.session.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(target)})`, objectGroup: HANDLES });
        if (result.objectId) return { ref: target, role: "css", name: target, states: [], interactive: true, depth: 0, objectId: result.objectId };
      } else {
        const { elements } = await this.snapshot();
        const found = queryElements(elements, target);
        if (found.length > 1 && target.nth === undefined) {
          throw new BjError("ambiguous", `${found.length} elements match ${short(target)}; add nth, exact, or a more specific name`, {
            matches: found.slice(0, 8).map((el) => `@${el.ref} ${describe(el)}`),
          });
        }
        const el = found[target.nth ?? 0];
        if (el && opts.enabled && el.states.includes("disabled")) lastProblem = "element is disabled";
        else if (el) return el;
      }
      if (performance.now() > deadline) {
        const code = lastProblem === "no match" ? "not_found" : "not_actionable";
        throw new BjError(code, `${short(target)}: ${lastProblem} after ${timeout}ms`);
      }
      await sleep(120);
    }
  }

  async #objectId(el: El): Promise<string> {
    if (el.objectId) return el.objectId;
    const { object } = await this.session.send("DOM.resolveNode", { backendNodeId: el.backendNodeId, objectGroup: HANDLES });
    if (!object.objectId) throw new BjError("not_actionable", `cannot resolve @${el.ref} to a DOM node`);
    return object.objectId;
  }

  async #callOn<T>(el: El, fn: (node: any, ...args: any[]) => T, ...args: unknown[]): Promise<T> {
    const res = await this.session.send("Runtime.callFunctionOn", {
      objectId: await this.#objectId(el),
      functionDeclaration: `function(...a){ return (${fn.toString()})(this, ...a); }`,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value as T;
  }

  async #point(el: El, timeout: number): Promise<{ x: number; y: number }> {
    const id = el.objectId ? { objectId: el.objectId } : { backendNodeId: el.backendNodeId };
    await this.session.send("DOM.scrollIntoViewIfNeeded", id).catch(() => {});
    const deadline = performance.now() + timeout;
    let previous: { x: number; y: number } | undefined;
    for (;;) {
      const quads = await this.session.send("DOM.getContentQuads", id).then((r) => r.quads, () => []);
      const quad = quads.find((q) => Math.abs((q[2]! - q[0]!) * (q[5]! - q[1]!)) > 1);
      if (quad) {
        const point = { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
        if (previous && Math.abs(previous.x - point.x) < 1 && Math.abs(previous.y - point.y) < 1) return point;
        previous = point;
      }
      if (performance.now() > deadline) throw new BjError("not_actionable", `${short(el)} is not visible or never stopped moving`);
      await sleep(25);
    }
  }

  // ---------- actions ----------

  click(target: Target, opts: { timeout?: number; count?: number; button?: "left" | "right" | "middle"; settle?: boolean } = {}): Promise<void> {
    return this.step(opts.count === 2 ? "dblclick" : "click", short(target), async () => {
      const timeout = opts.timeout ?? this.defaultTimeout;
      const el = await this.#resolve(target, timeout, { enabled: true });
      const { x, y } = await this.#point(el, timeout);
      const button = opts.button ?? "left";
      const clickCount = opts.count ?? 1;
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (this.#recording?.marks) await this.#mark(x, y);
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
      if (opts.settle !== false) await this.settle();
    });
  }

  dblclick(target: Target, opts: { timeout?: number } = {}): Promise<void> {
    return this.click(target, { ...opts, count: 2 });
  }

  hover(target: Target, opts: { timeout?: number } = {}): Promise<void> {
    return this.step("hover", short(target), async () => {
      const timeout = opts.timeout ?? this.defaultTimeout;
      const { x, y } = await this.#point(await this.#resolve(target, timeout), timeout);
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    });
  }

  /** Replace the field's content with `value`, firing real input events. */
  fill(target: Target, value: string, opts: { timeout?: number } = {}): Promise<void> {
    return this.step("fill", `${short(target)} = ${JSON.stringify(value)}`, async () => {
      const el = await this.#resolve(target, opts.timeout ?? this.defaultTimeout, { enabled: true });
      await this.#callOn(el, (node) => {
        node.scrollIntoView({ block: "center" });
        node.focus();
        if (typeof node.select === "function") node.select();
        else {
          const range = document.createRange();
          range.selectNodeContents(node);
          const sel = getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
      if (value === "") await this.press("Backspace");
      else await this.session.send("Input.insertText", { text: value });
    });
  }

  /** Type into whatever is focused (or `target`, focused first) without clearing it. */
  type(text: string, opts: { target?: Target; delay?: number } = {}): Promise<void> {
    return this.step("type", JSON.stringify(text), async () => {
      if (opts.target) await this.#callOn(await this.#resolve(opts.target, this.defaultTimeout, { enabled: true }), (node) => node.focus());
      if (!opts.delay) return void (await this.session.send("Input.insertText", { text }));
      for (const ch of text) {
        await this.session.send("Input.insertText", { text: ch });
        await sleep(opts.delay);
      }
    });
  }

  /** Press a key or chord, e.g. "Enter", "Escape", "Shift+Tab", "Meta+A". */
  press(chord: string): Promise<void> {
    return this.step("press", chord, async () => {
      const parts = chord.split("+");
      const keyName = parts.pop()!;
      const modifiers = parts.reduce((bits, m) => bits | (MODIFIERS[m] ?? 0), 0);
      const def = KEYS[keyName] ?? {
        key: keyName,
        code: /^[a-z]$/i.test(keyName) ? `Key${keyName.toUpperCase()}` : /^\d$/.test(keyName) ? `Digit${keyName}` : "",
        keyCode: keyName.toUpperCase().charCodeAt(0),
        text: keyName,
      };
      const chorded = (modifiers & (MODIFIERS.Control! | MODIFIERS.Meta!)) !== 0;
      const text = chorded ? undefined : def.text;
      const commands = chorded && keyName.toLowerCase() === "a" ? ["selectAll"] : undefined;
      const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
      await this.session.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text, commands });
      await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await this.settle({ timeout: 1_500 });
    });
  }

  /** Choose an option of a native <select> by value or visible label. */
  select(target: Target, option: string, opts: { timeout?: number } = {}): Promise<void> {
    return this.step("select", `${short(target)} = ${option}`, async () => {
      const el = await this.#resolve(target, opts.timeout ?? this.defaultTimeout, { enabled: true });
      const ok = await this.#callOn(el, (node, wanted) => {
        const match = [...(node.options ?? [])].find((o: any) => o.value === wanted || o.label === wanted || o.textContent.trim() === wanted);
        if (!match) return false;
        node.value = match.value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, option);
      if (!ok) throw new BjError("not_found", `no option "${option}" in ${short(target)}`);
    });
  }

  check(target: Target, checked = true): Promise<void> {
    return this.step(checked ? "check" : "uncheck", short(target), async () => {
      const el = await this.#resolve(target, this.defaultTimeout, { enabled: true });
      const current = await this.#callOn(el, (node) => node.checked ?? node.getAttribute("aria-checked") === "true");
      if (current !== checked) await this.click(el);
    });
  }

  upload(target: Target, files: string[]): Promise<void> {
    return this.step("upload", short(target), async () => {
      const el = await this.#resolve(target, this.defaultTimeout);
      await this.session.send("DOM.setFileInputFiles", { files, objectId: await this.#objectId(el) });
    });
  }

  /** Scroll an element into view, or scroll the window by a pixel delta. */
  async scroll(to: Target | { by: { x?: number; y?: number } }): Promise<void> {
    if (typeof to === "object" && "by" in to) {
      await this.evaluate((x: number, y: number) => window.scrollBy(x, y), to.by.x ?? 0, to.by.y ?? 0);
    } else {
      await this.#callOn(await this.#resolve(to, this.defaultTimeout), (node) => (node.nodeType === 3 ? node.parentElement : node).scrollIntoView({ block: "center" }));
    }
    await this.settle({ timeout: 1_500 });
  }

  // ---------- reads ----------

  async evaluate<T = unknown>(fn: string | ((...args: any[]) => T | Promise<T>), ...args: unknown[]): Promise<T> {
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(${args.map((a) => (a === undefined ? "undefined" : JSON.stringify(a))).join(",")})`;
    const res = await this.session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value as T;
  }

  async text(target?: Target): Promise<string> {
    if (!target) return this.evaluate<string>("document.body.innerText");
    return this.#callOn(await this.#resolve(target, this.defaultTimeout), (node) => (node.nodeType === 3 ? node.textContent : (node.innerText ?? node.textContent)) as string);
  }

  async value(target: Target): Promise<string> {
    return this.#callOn(await this.#resolve(target, this.defaultTimeout), (node) => String(node.value ?? ""));
  }

  async attr(target: Target, name: string): Promise<string | null> {
    return this.#callOn(await this.#resolve(target, this.defaultTimeout), (node, n) => node.getAttribute(n) as string | null, name);
  }

  async html(target?: Target): Promise<string> {
    if (!target) return this.evaluate<string>("document.documentElement.outerHTML");
    return this.#callOn(await this.#resolve(target, this.defaultTimeout), (node) => node.outerHTML as string);
  }

  async count(target: string | Query): Promise<number> {
    if (typeof target === "string") return this.evaluate((sel: string) => document.querySelectorAll(sel).length, target);
    return queryElements((await this.snapshot()).elements, target).length;
  }

  async isVisible(target: Target): Promise<boolean> {
    try {
      await this.#point(await this.#resolve(target, 0), 150);
      return true;
    } catch {
      return false;
    }
  }

  async isEnabled(target: Target): Promise<boolean> {
    return this.#callOn(await this.#resolve(target, this.defaultTimeout), (node) => !node.disabled && node.getAttribute("aria-disabled") !== "true");
  }

  async isChecked(target: Target): Promise<boolean> {
    return this.#callOn(await this.#resolve(target, this.defaultTimeout), (node) => Boolean(node.checked ?? node.getAttribute("aria-checked") === "true"));
  }

  // ---------- waits ----------

  waitFor(target: Target, opts: { state?: "visible" | "hidden"; timeout?: number } = {}): Promise<void> {
    const state = opts.state ?? "visible";
    return this.step("waitFor", `${short(target)} ${state}`, () =>
      this.#until(async () => (await this.isVisible(target)) === (state === "visible"), opts.timeout ?? this.defaultTimeout, `${short(target)} to be ${state}`, 100),
    );
  }

  waitForText(text: string | RegExp, opts: { timeout?: number } = {}): Promise<void> {
    return this.step("waitForText", String(text), () =>
      this.#until(async () => {
        const body = await this.text();
        return typeof text === "string" ? body.includes(text) : text.test(body);
      }, opts.timeout ?? this.defaultTimeout, `text ${String(text)}`, 100),
    );
  }

  waitForUrl(pattern: string | RegExp, opts: { timeout?: number } = {}): Promise<void> {
    return this.step("waitForUrl", String(pattern), () =>
      this.#until(async () => {
        const url = await this.url();
        return typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
      }, opts.timeout ?? this.defaultTimeout, `url ${String(pattern)}`, 50),
    );
  }

  waitForFunction(fn: string | (() => unknown), opts: { timeout?: number } = {}): Promise<void> {
    return this.step("waitForFunction", undefined, () =>
      this.#until(async () => Boolean(await this.evaluate(fn as string)), opts.timeout ?? this.defaultTimeout, "function to return truthy", 50),
    );
  }

  /** Start waiting BEFORE the action that triggers the request, then await the returned promise. */
  waitForResponse(pattern: string | RegExp | ((req: Req) => boolean), opts: { timeout?: number } = {}): Promise<ResponseInfo> {
    const from = this.#log.length;
    const test = typeof pattern === "function" ? pattern : (req: Req) => (typeof pattern === "string" ? req.url.includes(pattern) : pattern.test(req.url));
    const promise = this.step("waitForResponse", String(pattern), async () => {
      let hit: Req | undefined;
      await this.#until(() => {
        hit = this.#log.slice(from).find((req) => req.ms !== undefined && test(req));
        return hit !== undefined;
      }, opts.timeout ?? this.defaultTimeout, `response matching ${String(pattern)}`);
      const req = hit!;
      const text = async () => {
        const body = await this.session.send("Network.getResponseBody", { requestId: req.id });
        return body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
      };
      return { ...req, text, json: async <T>() => JSON.parse(await text()) as T };
    });
    promise.catch(() => {});
    return promise;
  }

  /** The page opened by `action` (target=_blank, window.open). */
  async waitForPopup(action: () => Promise<unknown>, opts: { timeout?: number } = {}): Promise<Page> {
    const created = this.browser.root.waitFor("Target.targetCreated", {
      predicate: (e) => e.targetInfo.type === "page" && e.targetInfo.openerId === this.targetId,
      timeout: opts.timeout ?? this.defaultTimeout,
    });
    created.catch(() => {});
    await action();
    const { targetInfo } = await created;
    return this.browser.attach(targetInfo.targetId);
  }

  // ---------- evidence ----------

  requests(filter: { failed?: boolean; url?: string | RegExp; type?: string } = {}): Req[] {
    return this.#log
      .filter((req) => {
        if (filter.failed !== undefined && filter.failed !== Boolean(req.failed || (req.status ?? 0) >= 400)) return false;
        if (filter.type && req.type !== filter.type) return false;
        if (filter.url && !(typeof filter.url === "string" ? req.url.includes(filter.url) : filter.url.test(req.url))) return false;
        return true;
      })
      .map(({ ...req }) => req);
  }

  console(): ConsoleEntry[] {
    return [...this.#console];
  }

  errors(): ConsoleEntry[] {
    return this.#console.filter((e) => e.type === "error" || e.type === "exception");
  }

  out(name: string): string {
    const path = name.startsWith("/") ? name : join(this.#ctx.outDir, name);
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }

  screenshot(opts: { path?: string; fullPage?: boolean; target?: Target } = {}): Promise<string> {
    return this.step("screenshot", opts.path, async () => {
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
      if (opts.target) {
        const el = await this.#resolve(opts.target, this.defaultTimeout);
        const id = el.objectId ? { objectId: el.objectId } : { backendNodeId: el.backendNodeId };
        await this.session.send("DOM.scrollIntoViewIfNeeded", id).catch(() => {});
        const { model } = await this.session.send("DOM.getBoxModel", id);
        const [x, y] = [model.border[0]!, model.border[1]!];
        const scroll = await this.evaluate<{ x: number; y: number }>("({ x: scrollX, y: scrollY })");
        clip = { x: x + scroll.x, y: y + scroll.y, width: model.width, height: model.height, scale: 1 };
      } else if (opts.fullPage) {
        const { cssContentSize } = await this.session.send("Page.getLayoutMetrics");
        clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 16_000), scale: 1 };
      }
      const { data } = await this.session.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: Boolean(clip) });
      const path = this.out(opts.path ?? `shot-${Date.now()}.png`);
      writeFileSync(path, Buffer.from(data, "base64"));
      return path;
    });
  }

  /** Programmatic clicks have no cursor, so recordings get a brief ripple where each click lands. */
  async #mark(x: number, y: number): Promise<void> {
    await this.evaluate((px: number, py: number) => {
      const dot = document.createElement("div");
      dot.style.cssText = `position:fixed;left:${px - 16}px;top:${py - 16}px;width:32px;height:32px;border-radius:50%;background:rgba(255,64,64,.45);border:2px solid rgba(255,64,64,.9);z-index:2147483647;pointer-events:none;transition:transform .5s ease-out,opacity .5s ease-out`;
      document.documentElement.appendChild(dot);
      requestAnimationFrame(() => { dot.style.transform = "scale(1.8)"; dot.style.opacity = "0"; });
      setTimeout(() => dot.remove(), 650);
    }, x, y).catch(() => {});
    await sleep(180);
  }

  /**
   * Record `fn` as an mp4 (needs ffmpeg; otherwise the JPEG frames are kept). While recording, each step is
   * followed by a `pace` pause so a viewer can follow, and clicks are marked. The marker is a temporary
   * DOM node, so do not combine recording with leak checks or DOM-count assertions.
   */
  async record<T>(path: string, fn: () => Promise<T>, opts: { pace?: number; marks?: boolean } = {}): Promise<{ result: T; video: string }> {
    this.#recording = { pace: opts.pace ?? 600, marks: opts.marks ?? true };
    const dir = mkdtempSync(join(tmpdir(), "bj-rec-"));
    const frames: { file: string; at: number }[] = [];
    const off = this.session.on("Page.screencastFrame", (e) => {
      const file = join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(e.data, "base64"));
      frames.push({ file, at: e.metadata.timestamp ?? Date.now() / 1000 });
      void this.session.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
    });
    await this.session.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
    let result: T;
    try {
      result = await fn();
      await sleep(250);
    } finally {
      this.#recording = undefined;
      await this.session.send("Page.stopScreencast").catch(() => {});
      off();
    }
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.016, (frames[i + 1]?.at ?? f.at + 0.5) - f.at).toFixed(3)}`).join("\n");
    const concat = join(dir, "frames.txt");
    writeFileSync(concat, `${list}\nfile '${frames.at(-1)?.file}'\n`);
    const video = this.out(path);
    try {
      execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concat, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,tpad=stop_mode=clone:stop_duration=1.5", "-pix_fmt", "yuv420p", "-vsync", "vfr", video], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
      return { result, video };
    } catch {
      return { result, video: dir };
    }
  }

  // ---------- environment ----------

  async viewport(width: number, height: number, opts: { mobile?: boolean; scale?: number } = {}): Promise<void> {
    await this.session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: opts.scale ?? 1, mobile: opts.mobile ?? false });
  }

  async emulate(opts: { cpu?: number; network?: keyof typeof NETWORK_PRESETS; colorScheme?: "dark" | "light"; reducedMotion?: boolean; userAgent?: string }): Promise<void> {
    const s = this.session;
    if (opts.cpu !== undefined) await s.send("Emulation.setCPUThrottlingRate", { rate: opts.cpu });
    if (opts.network) await s.send("Network.emulateNetworkConditions", { ...NETWORK_PRESETS[opts.network] });
    if (opts.userAgent) await s.send("Emulation.setUserAgentOverride", { userAgent: opts.userAgent });
    const features = [
      ...(opts.colorScheme ? [{ name: "prefers-color-scheme", value: opts.colorScheme }] : []),
      ...(opts.reducedMotion !== undefined ? [{ name: "prefers-reduced-motion", value: opts.reducedMotion ? "reduce" : "no-preference" }] : []),
    ];
    if (features.length) await s.send("Emulation.setEmulatedMedia", { features });
  }

  async close(): Promise<void> {
    await this.browser.root.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }

  // ---------- Jev judgments over the current screen ----------

  async #jevState(extra?: Record<string, unknown>): Promise<Record<string, any>> {
    const snap = await this.snapshot();
    return {
      url: snap.url,
      title: snap.title,
      screen: render(snap, { refs: false, maxChars: 40_000 }),
      console_errors: this.errors().slice(-8).map((e) => e.text.slice(0, 300)),
      failed_requests: this.requests({ failed: true }).slice(-8).map((r) => `${r.method} ${r.url.slice(0, 200)} → ${r.failed ?? r.status}`),
      ...extra,
    };
  }

  /** Typed questions about the current screen, answered by Jev in one parallel request. */
  ask<const Q extends Questions>(questions: Q, extraState?: Record<string, unknown>): Promise<SystemOneResult<Q>["answers"]> {
    return this.step("ask", Object.keys(questions).join(","), async () => this.#ctx.jev.ask({ state: await this.#jevState(extraState), questions }));
  }

  /** Probability (0–1) that each statement about the current screen is true. Near 0.5 means Jev cannot tell. */
  async judge<const T extends Record<string, string>>(statements: T, extraState?: Record<string, unknown>): Promise<{ [K in keyof T]: number }> {
    const questions: Questions = {};
    for (const [key, statement] of Object.entries(statements)) questions[key] = noul(`Considering the web page in \`screen\`: ${statement}`);
    const answers = (await this.ask(questions, extraState)) as Record<string, { noul: number }>;
    return Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Number(v.noul.toFixed(3))])) as { [K in keyof T]: number };
  }

  /** Throw unless Jev agrees the statement holds (or, with `not`, does not hold) on the current screen. */
  async expect(statement: string, opts: { min?: number; not?: boolean } = {}): Promise<number> {
    const min = opts.min ?? 0.75;
    const { p } = await this.judge({ p: statement });
    const pass = opts.not ? p <= 1 - min : p >= min;
    if (!pass) throw new BjError("expectation", `expected ${opts.not ? "NOT " : ""}"${statement}" — Jev probability ${p}`, { probability: p, min });
    return p;
  }

  async rate<const T extends ScoreCriteria>(instructions: string, levels: T, extraState?: Record<string, unknown>): Promise<ScoreResponse<T>> {
    const answers = await this.ask({ rating: score(instructions, levels) }, extraState);
    return answers.rating as ScoreResponse<T>;
  }

  async choose<const T extends ChoiceCriteria>(instructions: string, options: T, extraState?: Record<string, unknown>): Promise<ChoiceResponse<T>> {
    const answers = await this.ask({ pick: choice(instructions, options) }, extraState);
    return answers.pick as ChoiceResponse<T>;
  }

  /** Compact failure evidence for the agent: what the page looked like when a step threw. */
  async diagnose(): Promise<Record<string, unknown>> {
    const view = await this.view({ interactive: true, maxChars: 5_000 }).catch((e) => `snapshot failed: ${e}`);
    const screenshot = await this.screenshot({ path: `failure-${Date.now()}.png` }).catch(() => undefined);
    return {
      view,
      screenshot,
      consoleErrors: this.errors().slice(-10),
      failedRequests: this.requests({ failed: true }).slice(-10).map((r) => `${r.method} ${r.url} → ${r.failed ?? r.status}`),
      dialogs: this.dialogs.slice(-5),
    };
  }
}
