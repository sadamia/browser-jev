import { script } from "browser-jev";

const URL = process.env.FIXTURE_URL ?? "http://127.0.0.1:4173/";
const assert = (cond: unknown, message: string) => {
  if (!cond) throw new Error(`assertion failed: ${message}`);
};

export default script(async ({ page, browser }) => {
  const r: Record<string, unknown> = {};
  await page.goto(URL);

  // keyboard, type, hover, history
  await page.click({ role: "textbox", name: "Work email" });
  await page.type("a@b.co");
  await page.press("Meta+A");
  await page.type("x@y.io");
  assert((await page.value({ role: "textbox", name: "Work email" })) === "x@y.io", `select-all then type replaces, got ${await page.value("input[name=email]")}`);
  await page.press("Tab");
  assert((await page.evaluate(() => document.activeElement?.getAttribute("name"))) === "plan", "Tab moves focus");
  await page.hover({ role: "button", name: "Recalculate totals" });
  await page.goto(`${URL}popup`);
  await page.back();
  assert((await page.title()) === "Acme Billing", "back");
  await page.forward();
  assert((await page.title()) === "Help center", "forward");
  await page.back();

  // dialogs dismissed → row stays; waitFor hidden after accept
  page.dialogMode = "dismiss";
  await page.click({ role: "button", name: "Delete", exact: true, nth: 0 });
  assert((await page.count(".row")) === 3, "dismissed confirm keeps the row");
  page.dialogMode = "accept";
  await page.click({ role: "button", name: "Delete", exact: true, nth: 0 });
  await page.waitFor({ text: "INV-1001", exact: false }, { state: "hidden", timeout: 2000 });

  // screenshots and recording
  r.full = await page.screenshot({ path: "full.png", fullPage: true });
  r.element = await page.screenshot({ path: "form.png", target: "#signup" });
  await page.viewport(390, 844, { mobile: true });
  r.mobile = await page.screenshot({ path: "mobile.png" });
  await page.viewport(1280, 800);
  const rec = await page.record("flow.mp4", async () => {
    await page.fill({ role: "textbox", name: "Work email" }, "rec@acme.test");
    await page.check({ role: "checkbox", name: "I accept the terms" });
  });
  r.video = rec.video;

  // offline makes the signup request fail and it is reported
  await page.emulate({ network: "offline" });
  await page.click({ role: "button", name: "Create account" });
  assert(page.requests({ failed: true, url: "/api/signup" }).length === 1, "offline request recorded as failed");
  await page.emulate({ network: "none" });

  // throttling changes measured load
  const fast = await browser.bench(URL, { runs: 2 });
  const slow = await browser.bench(URL, { runs: 2, network: "fast3g", cpu: 4 });
  r.loadMs = { fast: fast.stats.load?.median, slow: slow.stats.load?.median };
  assert((slow.stats.load?.median ?? 0) > (fast.stats.load?.median ?? 0) * 3, "throttled load is much slower");

  // isolated contexts: cookie inheritance and concurrency
  await page.evaluate(() => { document.cookie = "session=abc123; path=/"; });
  const [authed, clean] = await Promise.all([browser.newContext({ auth: true }), browser.newContext()]);
  const [p1, p2] = await Promise.all([authed.newPage(), clean.newPage()]);
  await Promise.all([p1.goto(URL), p2.goto(URL)]);
  const [c1, c2] = await Promise.all([p1.evaluate(() => document.cookie), p2.evaluate(() => document.cookie)]);
  assert(c1.includes("session=abc123") && !c2.includes("session"), `auth context inherits cookies, clean one does not: "${c1}" / "${c2}"`);
  await page.evaluate(() => { document.cookie = "session=; path=/; max-age=0"; });
  return r;
});
