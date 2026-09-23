# browser-jev

A [Claude Code](https://claude.com/claude-code) skill for browser automation, built on two ideas:

1. **One type-checked script per agent turn**, running against a persistent headless Chrome over the DevTools Protocol. No per-action round trips, no browser relaunches between tests.
2. **[TypeSafe's Jev](https://typesafe.ai) makes the small decisions inside the script**: which of these forty buttons is "the download icon for the overdue invoice", is the page signed in, how well does this screen match the PR description. Each answer comes with a probability, and the script only hands control back to the agent when confidence is low.

Built for reviewing pull requests in a real browser, finding gaps between a PR's claims and the running app, end-to-end test scenarios, and performance profiling.

```ts
import { script } from "browser-jev";

export default script(async ({ page }) => {
  await page.goto("http://localhost:3000/invoices");
  await page.fill({ role: "textbox", name: "Search" }, "overdue");
  await page.click(await page.find("the download icon for the overdue invoice"));
  await page.expect("A download confirmation is visible.");
  return { vitals: await page.perf.vitals(), errors: page.errors() };
});
```

```bash
bj run flow.ts --out ./out
```

The script is type-checked first (~0.2 s), then executed as one batch. The result is one JSON report: the return value, every step with its duration, timing, Jev usage, and on failure the failed step, the page's interactive elements, console errors, failed requests and a screenshot.

## Install

Requirements: Node 22.18+, Google Chrome or Chromium, and a `TYPESAFE_API_KEY` for the Jev-backed calls (everything else works without it).

```bash
git clone https://github.com/sadamia/browser-jev ~/.claude/skills/browser-jev
cd ~/.claude/skills/browser-jev && npm install
export TYPESAFE_API_KEY=...   # in your shell profile
```

Claude Code picks the skill up from `~/.claude/skills/`. To use the CLI directly, put `bin/` on your `PATH` or call `~/.claude/skills/browser-jev/bin/bj`.

Self-test:

```bash
node test/fixture-server.ts &
bin/bj run test/smoke.ts
bin/bj run test/extras.ts
```

## What it does

| Area | Highlights |
|---|---|
| Finding elements | Three tiers: CSS or `{ role, name }` queries (~5 ms), `"@ref"`s from a snapshot, and `find`/`findAll` descriptions resolved by Jev and cached per route |
| Actions | `click`, `fill`, `type`, `press`, `select`, `check`, `upload`, `hover`, `scroll`; all auto-wait for the target to exist, be enabled and stop moving |
| Waits | `waitForResponse`, `waitForText`, `waitForUrl`, `waitFor`, `waitForPopup`; event-driven, never polling sleeps |
| Judgments | `expect`, `judge`, `rate`, `choose`, `ask`: typed questions about the current screen, answered in parallel |
| Evidence | Screenshots (viewport, full page, element), console and network capture, mp4 recordings with paced steps and click markers |
| Profiling | Web vitals, DevTools traces with long-task culprits, CPU profiles, heap and leak checks, CPU/network throttling, cold-load benchmarks |
| Isolation | Fresh `BrowserContext` per test case in milliseconds; a signed-in default context that survives across runs |

## Commands

```
bj run <file|->  [--out dir] [--no-check] [--headed]   run a script (- reads stdin)
bj snapshot [url] [--all]                              list the page's interactive elements
bj login <url>                                         one visible plain window (no DevTools port) for a human to sign in; waits, then returns to headless signed in
bj start | stop | status                               manage the background Chrome
bj cache clear                                         forget cached element resolutions
```

## Docs

- [SKILL.md](SKILL.md): the workflow and rules the agent follows
- [references/api.md](references/api.md): every method and the report format
- [references/pr-review.md](references/pr-review.md), [testing.md](references/testing.md), [perf.md](references/perf.md): guides per use case

## Things to know

- Runs are headless. The only visible window is `bj login`, and the skill never drives a login form or handles credentials.
- `find`, `judge`, `expect`, `rate`, `choose` and `ask` send the page's text to `api.typesafe.ai`. Everything else stays on the machine.
- Jev answers are advisory. Nothing destructive should be gated on a probability alone.
- Not supported in this version: Electron apps, Slack, cloud browsers, file downloads, cross-origin iframes.

## License

MIT
