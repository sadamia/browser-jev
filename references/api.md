# API reference

Scripts are `export default script(async (ctx) => { ... })` with `ctx = { page, browser, jev, outDir, log }`. Everything is typed; when unsure, write it and let the type check tell you (`Did you mean 'click'?`). The source of truth is `src/page.ts`, `src/browser.ts`, `src/perf.ts`.

`Target` = a CSS string, an `"@e12"` ref, a query `{ role?, name?, text?, exact?, nth? }`, or an `El` returned by `get`/`find`. `name` and `text` match case-insensitive substrings unless `exact: true`; both accept a `RegExp`. `text` also matches non-interactive text nodes.

## page — navigation

| Method | Notes |
|---|---|
| `goto(url, { waitUntil?: "load" \| "domcontentloaded" \| "networkidle", timeout? })` | Throws `navigation` on network errors. |
| `reload()`, `back()`, `forward()` | |
| `waitForLoad()`, `settle({ quiet?, timeout? })` | `settle` waits for navigation to finish and the network to go quiet; never throws. `click`/`press` call it for you. |
| `url()`, `title()` | |

## page — observation

| Method | Notes |
|---|---|
| `snapshot()` → `{ url, title, elements: El[] }` | Accessibility tree of the main frame and same-process iframes (~5ms). |
| `view({ interactive?, maxChars? })` → string | The snapshot as text with `@refs`. `interactive: true` lists only controls, each with its container. |
| `get(query)` → `El` | Deterministic; throws `not_found` / `ambiguous`. |
| `find(description, opts)` → `El`, `findAll({ key: description }, opts)` → `{ key: El }` | Jev-backed. `opts`: `minConfidence` (0.7), `among: "interactive" \| "all"`, `cache` (true). |

`El` = `{ ref, role, name, value?, states[], context?, interactive }`. `context` is the nearest named container (row, dialog, form, list item) or preceding heading.

## page — actions

All auto-wait for the target to exist, be enabled, and stop moving (default 10s, `page.defaultTimeout`).

`click(t, { count?, button?, settle?, timeout? })` · `dblclick(t)` · `hover(t)` · `fill(t, value)` (replaces content, fires real input events) · `type(text, { target?, delay? })` (appends) · `press("Enter" | "Shift+Tab" | "Meta+A")` · `select(t, valueOrLabel)` (native `<select>`) · `check(t, checked = true)` · `upload(t, [paths])` · `scroll(t | { by: { x?, y? } })`

JavaScript dialogs are auto-accepted and recorded in `page.dialogs`; set `page.dialogMode = "dismiss"` to cancel them instead.

## page — reads and waits

`text(t?)` · `value(t)` · `attr(t, name)` · `html(t?)` · `count(css | query)` · `isVisible(t)` · `isEnabled(t)` · `isChecked(t)` · `evaluate(fnOrString, ...jsonArgs)` (runs in the page; the function cannot close over script variables)

`waitFor(t, { state?: "visible" | "hidden", timeout? })` · `waitForText(strOrRegex)` · `waitForUrl(strOrRegex)` · `waitForFunction(fn)` · `waitForResponse(pattern)` → `{ url, status, method, ms, text(), json() }` · `waitForPopup(action)` → `Page`

`waitForResponse` must be created before the action that triggers the request, and awaited after it.

## page — evidence and environment

`requests({ failed?, url?, type? })` · `console()` · `errors()` (console errors + uncaught exceptions) · `screenshot({ path?, fullPage?, target? })` → path · `record(path, fn, { pace?: 600, marks?: true })` → mp4 (needs ffmpeg; pauses `pace` ms after each step and draws a ripple where each click lands) · `diagnose()` (what the runner prints on failure)

`viewport(w, h, { mobile?, scale? })` · `emulate({ cpu?: 4, network?: "slow3g" | "fast3g" | "fast4g" | "offline" | "none", colorScheme?, reducedMotion?, userAgent? })` · `close()`

## page — Jev

`judge({ key: statement })` → `{ key: probability }` · `expect(statement, { min?: 0.75, not? })` · `rate(instructions, levels[])` → `{ score, confidence, probabilities }` · `choose(instructions, { option: description | null })` → `{ choice, confidence, probabilities }` · `ask(questions, extraState?)` for raw `choice`/`noul`/`score` questions (import them from `"browser-jev"`)

The state Jev sees is `{ url, title, screen, console_errors, failed_requests, ...extraState }`. Refer to extra state in instructions with backticked paths, e.g. `` `pr.description` ``. `jev.ask({ state, questions })` on the context is the same call without the page state, for judging data you gathered yourself. Limits: 255 options per choice, 32k tokens of state.

## browser

`page()` (the persistent signed-in working tab) · `newPage()` · `pages()` · `attach(targetId)` · `newContext({ auth? })` → `Context` with `newPage()` and `close()` · `bench(url, { runs?, cpu?, network?, auth? })` · `saveCookies()`

Contexts created in a run are disposed when the run ends. The working tab is left open.

## page.perf

See [perf.md](perf.md): `vitals()`, `metrics()`, `trace(fn)`, `cpuProfile(fn, { setup })`, `heap()`, `heapSnapshot()`, `leakCheck(action)`.

## Report format

```jsonc
{ "ok": true, "result": <your return value>, "logs": [...], "steps": ["click … 85ms", ...],
  "timing": { "totalMs", "typecheckMs", "browserLaunched" },
  "jev": { "calls", "inputTokens", "ms", "slowestMs" }, "outDir": "…" }
```

On failure: `ok: false`, `error: { code, message, ...details }`, `failedStep`, `at` (URL), `view` (interactive snapshot), `screenshot`, `consoleErrors`, `failedRequests`, `dialogs`. Exit codes: 0 ok, 1 script failed, 2 type check failed (nothing ran).

Error codes: `not_found`, `ambiguous`, `low_confidence`, `timeout`, `expectation`, `navigation`, `not_actionable`, `config`. `low_confidence` and Jev `not_found` carry `candidates` with probabilities.

## Known limits

Cross-origin (out-of-process) iframes are not in the snapshot. File downloads, Electron apps, and cloud browsers are not supported; use the `agent-browser` skill for those. Scripts must be self-contained (they are copied before running, so relative imports break).
