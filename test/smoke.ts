import { script } from "browser-jev";

const URL = process.env.FIXTURE_URL ?? "http://127.0.0.1:4173/";

const assert = (cond: unknown, message: string) => {
  if (!cond) throw new Error(`assertion failed: ${message}`);
};

export default script(async ({ page, browser, jev, log }) => {
  const results: Record<string, unknown> = {};

  // --- deterministic core ---
  await page.goto(URL);
  assert((await page.title()) === "Acme Billing", "title");
  await page.fill({ role: "textbox", name: "Work email" }, "dev@acme.test");
  await page.select({ role: "combobox", name: "Plan" }, "Pro");
  assert(!(await page.isEnabled("#submit")), "submit disabled before terms");
  await page.check({ role: "checkbox", name: "I accept the terms" });
  const signup = page.waitForResponse("/api/signup");
  await page.click({ role: "button", name: "Create account" });
  const res = await signup;
  assert(res.status === 200, "signup status");
  assert((await res.json<{ plan: string }>()).plan === "pro", "signup body");
  await page.waitForText("Welcome, dev@acme.test");

  await page.click({ role: "button", name: "Load older invoices" });
  assert((await page.count({ role: "button", name: "Delete", exact: true })) === 3, "three delete buttons");
  let ambiguous = false;
  await page.click({ role: "button", name: "Delete", exact: true }, { timeout: 500 }).catch((e) => (ambiguous = e.code === "ambiguous"));
  assert(ambiguous, "ambiguous query is rejected");
  await page.click({ role: "button", name: "Delete", exact: true, nth: 0 });
  assert(page.dialogs.at(-1)?.message === "Delete Invoice INV-1001?", "confirm dialog handled");
  assert((await page.count(".row")) === 2, "row removed");
  assert(page.errors().some((e) => e.text.includes("sample console error")), "console error captured");

  const popup = await page.waitForPopup(() => page.click({ role: "link", name: "Help center" }));
  await popup.waitForText("How can we help?");
  await popup.close();

  const view = await page.view({ interactive: true });
  assert(view.includes("Chat with support"), "iframe content in snapshot");
  results.shot = await page.screenshot({ path: "fixture.png" });

  // --- profiling ---
  const { trace } = await page.perf.trace(() => page.click("#heavy"));
  assert(trace.longTasks.length >= 1, "long task detected");
  results.trace = { blockingMs: trace.totalBlockingMs, top: trace.longTasks[0], byCategoryMs: trace.byCategoryMs };
  const cold = await page.perf.cpuProfile(() => page.click("#heavy"));
  assert(cold.profile.note !== undefined, "profile of pre-compiled code warns about lost attribution");
  const { profile } = await page.perf.cpuProfile(() => page.click("#heavy"), {
    setup: async () => {
      await page.reload();
      await page.click("#heavy");
    },
  });
  results.cpuTop = profile.top[0];
  assert(profile.top.some((t) => t.fn.includes("recalculateTotals")), "cpu profile names the hot function");
  const leak = await page.perf.leakCheck(() => page.click("#leak", { settle: false }), { iterations: 5 });
  assert(leak.suspicious, "leak detected");
  results.leak = { nodesPerIter: leak.nodeGrowthPerIter, heapMBPerIter: leak.heapGrowthMBPerIter };
  results.vitals = await page.perf.vitals();
  const bench = await browser.bench(URL, { runs: 3 });
  results.benchLcp = bench.stats.lcp;

  // --- Jev decisions ---
  if (!jev.available) {
    log("TYPESAFE_API_KEY not set; skipping Jev checks");
    return results;
  }
  await page.goto(URL);
  const download = await page.find("the download icon for the overdue invoice", { cache: false });
  await page.click(download);
  assert((await page.text("#status")) === "Downloaded Invoice INV-1002", `Jev picked the right unlabeled icon button, got: ${await page.text("#status")}`);

  const batchStart = performance.now();
  const els = await page.findAll({ email: "where I type my email address", remove300: "delete button of the $300 invoice", plan: "the plan picker" }, { cache: false });
  assert(els.email.role === "textbox" && els.plan.role === "combobox" && els.remove300.context === "Invoice INV-1003", "findAll resolves three targets in one request");
  results.findAllMs = Math.round(performance.now() - batchStart);

  let refused = "";
  await page.find("the button that exports everything to PDF", { cache: false }).catch((e) => (refused = e.code));
  assert(refused === "not_found" || refused === "low_confidence", `Jev refuses a nonexistent element, got: ${refused}`);

  results.judge = await page.judge({
    hasOverdue: "At least one invoice is overdue.",
    signedUp: "The page shows that an account was successfully created.",
    isLogin: "This is a login page asking for a password.",
  });
  results.quality = await page.rate("How complete and usable does this billing page look?", [
    "Broken or empty: errors, missing content",
    "Partially working: some content but obvious gaps",
    "Complete: content present and coherent",
  ]);
  return results;
});
