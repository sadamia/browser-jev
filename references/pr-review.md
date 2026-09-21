# Reviewing a pull request in the browser

The goal is evidence: does the running app do what the PR says, and what does the PR not mention that changed or broke? Code reading finds what was written; this finds what actually happens.

## 1. Turn the PR into claims (no browser yet)

```bash
gh pr view <n> --json title,body,files,headRefName
gh pr diff <n> --name-only
```

Write down, as plain sentences, each user-visible behaviour the PR claims ("the invoice list shows an Overdue badge", "saving with an empty name shows a validation error"). Then list the routes and components the diff touches that the description does **not** mention: those are the gap candidates. Get the URL to test: a preview deployment from the PR checks, or a local dev server on the PR branch.

## 2. One script: exercise every claim, collect evidence

Keep facts deterministic and use Jev for meaning. Return a structured result rather than throwing on the first problem, so one run reports on every claim.

```ts
import { script } from "browser-jev";

const PR = {
  description: "Adds an Overdue badge to invoices past their due date and a filter to show only overdue invoices.",
  claims: {
    badge: "Invoices past their due date show an 'Overdue' badge.",
    filter: "With the overdue filter on, only overdue invoices are listed.",
  },
};

export default script(async ({ page }) => {
  const findings: Record<string, unknown> = {};
  await page.goto("https://preview.example.dev/invoices");

  findings.before = await page.judge({ badge: PR.claims.badge });
  await page.click(await page.find("the control that filters the list to overdue invoices"));
  findings.after = await page.judge({ filter: PR.claims.filter }, { pr: PR });

  // Facts Jev is bad at (counting, numbers): compute them.
  findings.rows = await page.evaluate(() => [...document.querySelectorAll("[data-invoice]")].map((r) => (r as HTMLElement).innerText));

  findings.fit = await page.rate("How completely does this screen implement `pr.description`?", [
    "Missing: the described feature is absent",
    "Partial: present but with visible gaps or rough edges",
    "Complete: everything described is present and coherent",
  ], { pr: PR });

  findings.consoleErrors = page.errors();
  findings.failedRequests = page.requests({ failed: true }).map((r) => `${r.method} ${r.url} → ${r.failed ?? r.status}`);
  findings.shot = await page.screenshot({ path: "overdue-filter.png" });
  return findings;
});
```

## 3. Hunt the gaps

These are where PRs most often fall short; script the ones that apply.

| Gap | How to probe |
|---|---|
| Unhappy paths | Empty, overlong, and invalid input; submit twice; `page.emulate({ network: "offline" })` then act. |
| Untouched neighbours | Routes that share a changed component but are not in the description: load each, check `errors()` and a `judge` that the page looks intact. |
| States | Empty list, single item, many items, loading (`network: "slow3g"`), error response. |
| Responsive and theme | `page.viewport(390, 844, { mobile: true })`, `emulate({ colorScheme: "dark" })`, screenshot each. |
| Keyboard and a11y | `press("Tab")` through the new UI; new controls with an empty `name` in `view({ interactive: true })` are unlabeled for screen readers. |
| Regression in speed | `browser.bench(url)` on the PR preview and on the base branch; compare medians (see [perf.md](perf.md)). |
| Permissions | If the feature is role-gated, repeat in `browser.newContext()` (signed out) and confirm it is not reachable. |

Compare against the base branch whenever you can: the same script against both URLs turns "this looks odd" into "this changed".

## 4. Report

For each claim: verified / not verified / contradicted, with the evidence (probability, the computed fact, the screenshot path, the failing request). List gaps separately from claim failures. Say plainly what you did not test. A Jev probability is supporting evidence, not proof: where a claim matters, back it with a deterministic check.
