# Performance measurement and profiling

Work from coarse to fine: benchmark to see *whether* there is a problem, trace to see *where the time goes*, CPU-profile to see *which function*, heap tools for memory. Every tool writes a file DevTools can open, and returns a small summary so you rarely need to.

## Measure honestly

- **Headless Chrome on a developer laptop is not a user's phone.** Use `emulate({ cpu: 4, network: "fast3g" })` for a mid-range mobile approximation, and report the conditions with the numbers.
- **One run is an anecdote.** Use `browser.bench` (fresh context and cold cache per run) and compare medians. Differences under ~10% on a handful of runs are noise.
- **Compare like with like.** Same machine, same throttling, base branch versus PR branch, back to back.
- **Profile production builds.** Dev servers ship unminified code, dev-only checks, and HMR; their numbers mislead.
- **The tooling perturbs the result.** Tracing and sampling add overhead; take absolute timings from `bench`/`vitals` and use traces and profiles for attribution.

## Load performance

```ts
const result = await browser.bench("https://app.example.dev/dashboard", { runs: 7, cpu: 4, network: "fast3g", auth: true });
// result.stats: median / p75 / min / max for ttfb, fcp, lcp, cls, tbt, domContentLoaded, load, transferKB
```

`page.perf.vitals()` reads the same metrics for the current document: `ttfb`, `fcp`, `lcp` (+ `lcpElement`), `cls`, `inp` (after interactions), `tbt`, `longTasks`, `load`, `transferKB`, `requests`. Rough targets: LCP ≤ 2.5s, CLS ≤ 0.1, INP ≤ 200ms.

What is heavy on the wire:

```ts
page.requests().filter((r) => (r.bytes ?? 0) > 100_000).sort((a, b) => b.bytes! - a.bytes!)
  .map((r) => `${Math.round(r.bytes! / 1024)}KB ${r.ms}ms ${r.type} ${r.url}`);
```

## Where does the time go: trace

```ts
const { trace } = await page.perf.trace(() => page.click({ role: "button", name: "Apply filters" }));
// trace.byCategoryMs  { scripting, rendering, painting, loading, other }
// trace.totalBlockingMs, trace.longTasks: [{ atMs, ms, culprit }]   culprit = heaviest event in the task, with function and URL when known
// trace.file  → load in DevTools > Performance
```

Wrap a `goto` to trace a page load, or an interaction to trace that. High `rendering` points at layout thrash or huge DOM; high `scripting` goes to the CPU profile next. Pass `{ screenshots: true }` for a filmstrip in DevTools.

## Which function: CPU profile

```ts
const { profile } = await page.perf.cpuProfile(
  () => page.click({ role: "button", name: "Apply filters" }),
  { setup: async () => { await page.goto(URL); await page.click({ role: "button", name: "Apply filters" }); } },
);
// profile.top: [{ fn: "applyFilters https://…/app.js:412", selfMs, pct }]
```

**Always pass `setup` for an already-loaded app.** V8 can only name code that was compiled while sampling was on. Without `setup`, warmed-up functions collapse into `(program)` or their caller and the summary carries a `note` saying so. `setup` runs sampled (so the code is known) but is excluded from the summary; put the `goto` and one warm-up pass of the interaction there so you measure optimised steady-state code. Minified bundles give minified names: profile a build with readable names or source maps loaded in DevTools.

## Memory

```ts
const leak = await page.perf.leakCheck(async () => {
  await page.click({ role: "button", name: "Open preview" });
  await page.press("Escape");
}, { iterations: 10 });
// leak.heapGrowthMBPerIter, leak.nodeGrowthPerIter, leak.suspicious, leak.series[]
```

Each sample is taken after a forced GC, so steady growth per iteration is retained memory, not garbage. Growing `domNodes` with a flat visible DOM means detached nodes; growing `listeners` means handlers that are never removed. To find the retainer, take `heapSnapshot("before.heapsnapshot")`, repeat the action, take `"after.heapsnapshot"`, and compare them in DevTools > Memory. `page.perf.heap()` gives a single post-GC reading.

## Interaction latency

```ts
await page.click(target);
const { inp } = await page.perf.vitals();      // worst interaction so far, ms
```

For a precise number on one interaction, trace it and read the long task it produced.

## Reporting

State the conditions (build, throttling, runs), give medians with spread, name the specific cause with its evidence (`longTasks[0].culprit`, `profile.top[0]`, the oversized request), and attach the file paths. If a result surprised you, rerun it before reporting it.
