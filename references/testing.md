# Testing scenarios

## Shape of a test script

One script is one suite. Give each case its own isolated context so state never leaks; creating one takes milliseconds and nothing restarts. Collect results instead of stopping at the first failure.

```ts
import { script } from "browser-jev";
import type { Page } from "browser-jev";

const BASE = "http://localhost:3000";

export default script(async ({ browser }) => {
  const results: Record<string, "pass" | string> = {};
  const test = async (name: string, body: (page: Page) => Promise<void>) => {
    const context = await browser.newContext({ auth: true });   // signed in, otherwise clean
    const page = await context.newPage();
    try {
      await body(page);
      results[name] = "pass";
    } catch (e) {
      const shot = await page.screenshot({ path: `${name}.png` }).catch(() => "");
      results[name] = `FAIL: ${(e as Error).message} ${shot}`;
    } finally {
      await context.close();
    }
  };

  await test("create-project", async (page) => {
    await page.goto(`${BASE}/projects/new`);
    await page.fill({ role: "textbox", name: "Project name" }, "Apollo");
    const created = page.waitForResponse((r) => r.method === "POST" && r.url.includes("/api/projects"));
    await page.click({ role: "button", name: "Create" });
    if ((await created).status !== 201) throw new Error("API did not return 201");
    await page.waitForUrl(/\/projects\/\w+/);
    await page.expect("The page shows a project named Apollo.");
  });

  await test("rejects-empty-name", async (page) => {
    await page.goto(`${BASE}/projects/new`);
    await page.click({ role: "button", name: "Create" });
    await page.expect("A validation message says the project name is required.");
    if (page.requests({ url: "/api/projects" }).some((r) => r.method === "POST")) throw new Error("submitted despite validation");
  });

  return results;
});
```

Independent cases can run concurrently: build an array of `test(...)` promises and `await Promise.all(...)`. They share one Chrome but separate contexts.

## Assertions: which kind

| Assert | With |
|---|---|
| A request happened, its status and body | `waitForResponse`, `requests()` |
| Exact text, values, counts, URLs, attributes | `text`, `value`, `count`, `waitForUrl`, `attr`, `evaluate` |
| No errors | `page.errors().length === 0`, `requests({ failed: true })` |
| Meaning: "shows a validation error", "looks like the empty state", "the chart is populated" | `expect`, `judge` |
| Visual regressions | `screenshot` and read the image yourself; Jev cannot see pixels, only the accessibility tree and text |

Prefer the deterministic row whenever the fact is knowable in code. Use Jev where a hand-written assertion would be brittle (copy that changes, layouts that move) or where you do not know the selector yet.

## Waiting

Never `sleep`. Actions auto-wait for their target; after an action use `waitForResponse`, `waitFor`, `waitForText`, or `waitForUrl` for the thing you expect. `click` and `press` already wait for navigation and network quiet.

## Regression suites

Save the script in the project (for example `e2e/checkout.bj.ts`) and rerun it on each branch: `bj run e2e/checkout.bj.ts --out "$SCRATCH/checkout"`. `find` results are cached per route, so reruns make no Jev calls for lookups until the page's controls change, at which point the stale entry is dropped and resolved again.

## Exploratory testing

When there is no script yet: `bj snapshot <url>`, then write a script that walks the main flows while recording evidence at each step.

```ts
const health = async (label: string) => ({
  label,
  url: await page.url(),
  ...(await page.judge({
    broken: "The page shows an error, a blank area where content should be, or obviously broken layout.",
    loading: "The page is still loading or showing placeholders.",
  })),
  errors: page.errors().length,
  failed: page.requests({ failed: true }).length,
});
```

Call it after every navigation and return the array: one run yields a map of where the app is unhealthy. Follow up only on the entries that flag.

## Hostile conditions

`page.emulate({ network: "offline" })` mid-flow, `emulate({ network: "slow3g", cpu: 6 })` for low-end devices, `page.dialogMode = "dismiss"` to cancel confirms, double `click`, `back()` after submit, and `reload()` mid-form all find real bugs cheaply.

## Recording a repro

`await page.record("repro.mp4", async () => { ...steps... })` wraps any steps in a video (needs ffmpeg) to attach to a bug report. Steps are paced (600ms by default) and each click is marked with a ripple, since programmatic clicks have no cursor. The ripple is a temporary DOM node: keep leak checks and DOM-count assertions outside `record`.
