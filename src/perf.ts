import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { Page, RunContext } from "./page.ts";

export interface Vitals {
  ttfb?: number;
  fcp?: number;
  lcp?: number;
  lcpElement?: string;
  cls: number;
  inp?: number;
  tbt: number;
  longTasks: number;
  domContentLoaded?: number;
  load?: number;
  transferKB?: number;
  requests?: number;
}

export interface TraceSummary {
  file: string;
  wallMs: number;
  mainThreadBusyMs: number;
  byCategoryMs: Record<string, number>;
  totalBlockingMs: number;
  longTasks: { atMs: number; ms: number; culprit: string }[];
}

export interface CpuSummary {
  file: string;
  totalMs: number;
  top: { fn: string; selfMs: number; pct: number }[];
  note?: string;
}

const VITALS_SCRIPT = `(() => {
  if (window.__bjVitals) return;
  const v = (window.__bjVitals = { cls: 0, tbt: 0, longTasks: 0 });
  const observe = (type, cb, extra) => { try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...extra }); } catch {} };
  observe("paint", (e) => { if (e.name === "first-contentful-paint") v.fcp = e.startTime; });
  observe("largest-contentful-paint", (e) => {
    v.lcp = e.startTime;
    const el = e.element;
    v.lcpElement = el ? (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "")) : undefined;
  });
  let winValue = 0, winStart = 0, winLast = 0;
  observe("layout-shift", (e) => {
    if (e.hadRecentInput) return;
    if (e.startTime - winLast > 1000 || e.startTime - winStart > 5000) { winValue = 0; winStart = e.startTime; }
    winLast = e.startTime; winValue += e.value;
    if (winValue > v.cls) v.cls = winValue;
  });
  observe("longtask", (e) => { v.longTasks++; v.tbt += Math.max(0, e.duration - 50); });
  observe("event", (e) => { if (e.interactionId && (!v.inp || e.duration > v.inp)) v.inp = e.duration; }, { durationThreshold: 16 });
})()`;

const SCRIPTING = ["EvaluateScript", "FunctionCall", "v8.compile", "v8.run", "RunMicrotasks", "TimerFire", "EventDispatch", "FireAnimationFrame", "XHRLoad", "XHRReadyStateChange", "MinorGC", "MajorGC", "V8.GC", "CompileScript", "v8.produceCache", "FireIdleCallback", "v8.callFunction"];
const RENDERING = ["Layout", "UpdateLayoutTree", "RecalculateStyles", "HitTest", "UpdateLayerTree", "IntersectionObserverController::computeIntersections", "ScrollLayer"];
const PAINTING = ["Paint", "PrePaint", "CompositeLayers", "Commit", "Layerize", "RasterTask", "Decode Image", "PaintImage", "ImageDecodeTask"];
const LOADING = ["ParseHTML", "ParseAuthorStyleSheet", "ResourceReceivedData", "ResourceFinish"];
const CATEGORY = new Map<string, string>([
  ...SCRIPTING.map((n) => [n, "scripting"] as const),
  ...RENDERING.map((n) => [n, "rendering"] as const),
  ...PAINTING.map((n) => [n, "painting"] as const),
  ...LOADING.map((n) => [n, "loading"] as const),
]);
const TRACE_CATEGORIES = [
  "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
  "v8.execute", "v8", "toplevel", "blink.user_timing", "latencyInfo", "loading",
  "disabled-by-default-v8.cpu_profiler", "disabled-by-default-devtools.timeline.stack",
];

const round = (n: number) => Math.round(n * 10) / 10;

export function summarizeTrace(file: string): TraceSummary {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const events: any[] = Array.isArray(raw) ? raw : raw.traceEvents;
  const mainThreads = new Set(events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  const busyByThread = new Map<string, number>();
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`;
    if (e.ph === "X" && e.name === "RunTask" && mainThreads.has(key)) busyByThread.set(key, (busyByThread.get(key) ?? 0) + (e.dur ?? 0));
  }
  const main = [...busyByThread.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const slices = events.filter((e) => e.ph === "X" && `${e.pid}:${e.tid}` === main && e.dur !== undefined).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  if (slices.length === 0) return { file, wallMs: 0, mainThreadBusyMs: 0, byCategoryMs: {}, totalBlockingMs: 0, longTasks: [] };

  const byCategory: Record<string, number> = { scripting: 0, rendering: 0, painting: 0, loading: 0, other: 0 };
  const stack: { end: number; childUs: number; ev: any }[] = [];
  const tasks: { ts: number; dur: number; culprit?: { dur: number; label: string } }[] = [];
  let currentTask: (typeof tasks)[number] | undefined;
  const pop = () => {
    const top = stack.pop()!;
    const self = Math.max(0, top.ev.dur - top.childUs);
    if (top.ev.name !== "RunTask") byCategory[CATEGORY.get(top.ev.name) ?? "other"]! += self;
    else byCategory.other! += self;
  };
  for (const ev of slices) {
    while (stack.length && stack.at(-1)!.end <= ev.ts) pop();
    if (stack.length) stack.at(-1)!.childUs += ev.dur;
    stack.push({ end: ev.ts + ev.dur, childUs: 0, ev });
    if (ev.name === "RunTask") {
      currentTask = { ts: ev.ts, dur: ev.dur };
      tasks.push(currentTask);
    } else if (currentTask && ev.ts < currentTask.ts + currentTask.dur && CATEGORY.has(ev.name)) {
      const d = ev.args?.data ?? ev.args?.beginData ?? {};
      if (!currentTask.culprit || ev.dur > currentTask.culprit.dur) {
        const where = d.url ? ` ${String(d.url).slice(0, 120)}${d.lineNumber !== undefined ? `:${d.lineNumber}` : ""}` : "";
        currentTask.culprit = { dur: ev.dur, label: `${ev.name}${d.functionName ? ` ${d.functionName}` : ""}${d.type ? ` ${d.type}` : ""}${where}` };
      }
    }
  }
  while (stack.length) pop();

  const start = slices[0]!.ts;
  const end = Math.max(...slices.map((e) => e.ts + e.dur));
  const long = tasks.filter((t) => t.dur > 50_000);
  return {
    file,
    wallMs: round((end - start) / 1000),
    mainThreadBusyMs: round(tasks.reduce((sum, t) => sum + t.dur, 0) / 1000),
    byCategoryMs: Object.fromEntries(Object.entries(byCategory).map(([k, us]) => [k, round(us / 1000)])),
    totalBlockingMs: round(long.reduce((sum, t) => sum + (t.dur - 50_000), 0) / 1000),
    longTasks: long.sort((a, b) => b.dur - a.dur).slice(0, 8).map((t) => ({ atMs: round((t.ts - start) / 1000), ms: round(t.dur / 1000), culprit: t.culprit?.label ?? "unknown" })),
  };
}

/** Self time per function, counting only samples inside [fromMs, toMs) relative to the profile start. */
export function summarizeCpuProfile(file: string, profile: any, window?: { fromMs: number; toMs: number }): CpuSummary {
  const fromUs = profile.startTime + (window?.fromMs ?? 0) * 1000;
  const toUs = window ? profile.startTime + window.toMs * 1000 : Infinity;
  const self = new Map<number, number>();
  const deltas: number[] = profile.timeDeltas ?? [];
  let clock = profile.startTime;
  let totalUs = 0;
  (profile.samples as number[]).forEach((id, i) => {
    clock += deltas[i] ?? 0;
    if (clock < fromUs || clock >= toUs) return;
    self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0));
    totalUs += deltas[i] ?? 0;
  });
  const byFn = new Map<string, number>();
  for (const node of profile.nodes as any[]) {
    const cf = node.callFrame;
    const label = `${cf.functionName || "(anonymous)"} ${cf.url ? `${String(cf.url).slice(-80)}:${cf.lineNumber + 1}` : ""}`.trim();
    byFn.set(label, (byFn.get(label) ?? 0) + (self.get(node.id) ?? 0));
  }
  const pct = (us: number) => (totalUs ? round((us / totalUs) * 100) : 0);
  const programPct = pct(byFn.get("(program)") ?? 0);
  const active = [...byFn.entries()].filter(([fn, us]) => us > 0 && !/^\((idle|program|root)\)/.test(fn));
  return {
    file,
    totalMs: round(totalUs / 1000),
    top: active.sort((a, b) => b[1] - a[1]).slice(0, 15).map(([fn, us]) => ({ fn, selfMs: round(us / 1000), pct: pct(us) })),
    note: programPct > 40
      ? `${programPct}% of samples are unattributed "(program)". V8 cannot name code compiled before sampling began; pass { setup } so sampling starts before the page loads.`
      : undefined,
  };
}

export class Perf {
  #page: Page;
  #ctx: RunContext;

  constructor(page: Page, ctx: RunContext) {
    this.#page = page;
    this.#ctx = ctx;
  }

  async install(): Promise<void> {
    await this.#page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: VITALS_SCRIPT });
    await this.#page.session.send("Runtime.evaluate", { expression: VITALS_SCRIPT }).catch(() => {});
  }

  /** Core Web Vitals and load timings for the current document, in milliseconds. */
  async vitals(): Promise<Vitals> {
    const v = await this.#page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const bytes = resources.reduce((sum, r) => sum + (r.transferSize || 0), nav?.transferSize ?? 0);
      return {
        ...(window as any).__bjVitals,
        ttfb: nav?.responseStart,
        domContentLoaded: nav?.domContentLoadedEventEnd,
        load: nav?.loadEventEnd,
        transferKB: bytes / 1024,
        requests: resources.length + 1,
      };
    });
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, typeof val === "number" ? round(val) : val])) as unknown as Vitals;
  }

  async metrics(): Promise<Record<string, number>> {
    await this.#page.session.send("Performance.enable");
    const { metrics } = await this.#page.session.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }

  /** Record a DevTools-loadable trace around `fn` and summarise main-thread work and long tasks. */
  async trace<T>(fn: () => Promise<T>, opts: { path?: string; screenshots?: boolean } = {}): Promise<{ result: T; trace: TraceSummary }> {
    const s = this.#page.session;
    const file = this.#page.out(opts.path ?? `trace-${Date.now()}.json`);
    const categories = [...TRACE_CATEGORIES, ...(opts.screenshots ? ["disabled-by-default-devtools.screenshot"] : [])];
    await s.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: categories, excludedCategories: ["*"] } });
    let result: T;
    try {
      result = await this.#page.step("trace", file, fn);
    } finally {
      const done = s.waitFor("Tracing.tracingComplete", { timeout: 120_000 });
      await s.send("Tracing.end");
      const { stream } = await done;
      if (stream) {
        const fd = openSync(file, "w");
        for (;;) {
          const chunk = await s.send("IO.read", { handle: stream, size: 1 << 20 });
          writeSync(fd, Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
          if (chunk.eof) break;
        }
        closeSync(fd);
        await s.send("IO.close", { handle: stream });
      }
    }
    return { result, trace: summarizeTrace(file) };
  }

  /**
   * Sampling CPU profile of `fn`; the .cpuprofile file opens in DevTools.
   * V8 only names code compiled while sampling is on, so for warmed-up app code pass `setup`
   * (typically the goto plus any warm-up): it runs sampled but is left out of the summary.
   */
  async cpuProfile<T>(fn: () => Promise<T>, opts: { path?: string; intervalUs?: number; setup?: () => Promise<unknown> } = {}): Promise<{ result: T; profile: CpuSummary }> {
    const s = this.#page.session;
    const file = this.#page.out(opts.path ?? `cpu-${Date.now()}.cpuprofile`);
    await s.send("Profiler.enable");
    await s.send("Profiler.setSamplingInterval", { interval: opts.intervalUs ?? 250 });
    await s.send("Profiler.start");
    const startedAt = performance.now();
    const stop = async () => {
      const { profile } = await s.send("Profiler.stop");
      await s.send("Profiler.disable");
      writeFileSync(file, JSON.stringify(profile));
      return profile;
    };
    try {
      await opts.setup?.();
      const fromMs = performance.now() - startedAt;
      const result = await this.#page.step("cpuProfile", file, fn);
      const toMs = performance.now() - startedAt;
      return { result, profile: summarizeCpuProfile(file, await stop(), opts.setup ? { fromMs, toMs } : undefined) };
    } catch (err) {
      await stop().catch(() => {});
      throw err;
    }
  }

  async heap(): Promise<{ usedMB: number; totalMB: number; domNodes: number; listeners: number; documents: number }> {
    const s = this.#page.session;
    await s.send("HeapProfiler.collectGarbage");
    const [usage, dom] = await Promise.all([s.send("Runtime.getHeapUsage"), s.send("Memory.getDOMCounters")]);
    return { usedMB: round(usage.usedSize / 1048576), totalMB: round(usage.totalSize / 1048576), domNodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents };
  }

  async heapSnapshot(path?: string): Promise<string> {
    const s = this.#page.session;
    const file = this.#page.out(path ?? `heap-${Date.now()}.heapsnapshot`);
    const fd = openSync(file, "w");
    const off = s.on("HeapProfiler.addHeapSnapshotChunk", (e) => writeSync(fd, e.chunk));
    try {
      await s.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    } finally {
      off();
      closeSync(fd);
    }
    return file;
  }

  /** Repeat `action` and track post-GC heap and DOM counts; steady growth per iteration suggests a leak. */
  async leakCheck(action: () => Promise<unknown>, opts: { iterations?: number } = {}): Promise<{ series: Awaited<ReturnType<Perf["heap"]>>[]; heapGrowthMBPerIter: number; nodeGrowthPerIter: number; suspicious: boolean }> {
    const iterations = opts.iterations ?? 8;
    await action();
    const series = [await this.heap()];
    for (let i = 0; i < iterations; i++) {
      await action();
      series.push(await this.heap());
    }
    const slope = (pick: (h: (typeof series)[number]) => number) => {
      const n = series.length;
      const xMean = (n - 1) / 2;
      const yMean = series.reduce((sum, h) => sum + pick(h), 0) / n;
      const num = series.reduce((sum, h, i) => sum + (i - xMean) * (pick(h) - yMean), 0);
      const den = series.reduce((sum, _h, i) => sum + (i - xMean) ** 2, 0);
      return num / den;
    };
    const heapGrowth = Math.round(slope((h) => h.usedMB) * 1000) / 1000;
    const nodeGrowth = round(slope((h) => h.domNodes));
    // A node or two per iteration is within measurement noise (hover state, framework bookkeeping).
    return { series, heapGrowthMBPerIter: heapGrowth, nodeGrowthPerIter: nodeGrowth, suspicious: heapGrowth > 0.05 || nodeGrowth >= 2 };
  }
}

export interface BenchStats {
  median: number;
  p75: number;
  min: number;
  max: number;
}

export function stats(values: number[]): BenchStats | undefined {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  return { median: round(at(0.5)), p75: round(at(0.75)), min: round(xs[0]!), max: round(xs.at(-1)!) };
}
