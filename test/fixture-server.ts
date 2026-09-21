import { createServer } from "node:http";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme Billing</title>
<style>
  body { font: 15px system-ui; margin: 24px; max-width: 760px }
  .row { display: flex; gap: 12px; align-items: center; padding: 6px 0; border-bottom: 1px solid #ddd }
  .row span { flex: 1 } label { display: block; margin: 8px 0 } .icon { width: 28px; height: 28px }
</style></head>
<body>
<nav aria-label="Main"><a href="/">Dashboard</a> · <a href="/popup" target="_blank">Help center</a></nav>
<main>
  <h1>Acme Billing</h1>

  <h2>Create account</h2>
  <form id="signup" aria-label="Create account">
    <label>Work email <input name="email" type="email" placeholder="you@company.com"></label>
    <label>Plan <select name="plan"><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label>
    <label><input type="checkbox" name="terms"> I accept the terms</label>
    <button id="submit" disabled>Create account</button>
  </form>
  <p role="status" id="status"></p>

  <h2>Invoices</h2>
  <div role="list" aria-label="Invoices" id="invoices">
    ${[["INV-1001", "$120.00", "Paid"], ["INV-1002", "$89.50", "Overdue"], ["INV-1003", "$300.00", "Paid"]]
      .map(([id, amount, state]) => `<div class="row" role="listitem" aria-label="Invoice ${id}"><span>${id} — ${amount} — ${state}</span>
        <button class="icon" data-action="download"><svg class="icon-download" width="14" height="14"><path d="M7 1v9M3 7l4 4 4-4"/></svg></button>
        <button data-action="delete">Delete</button></div>`)
      .join("")}
  </div>
  <div id="late"></div>

  <h2>Diagnostics</h2>
  <button id="heavy">Recalculate totals</button>
  <button id="leak">Open preview</button>
  <span id="heavy-result"></span>
  <iframe title="Support widget" srcdoc="<button>Chat with support</button>" width="300" height="60"></iframe>
</main>
<script>
  const form = document.getElementById("signup"), submit = document.getElementById("submit"), status = document.getElementById("status");
  form.terms.addEventListener("change", () => (submit.disabled = !form.terms.checked));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "Creating account…";
    const res = await fetch("/api/signup", { method: "POST", body: JSON.stringify({ email: form.email.value, plan: form.plan.value }) });
    const data = await res.json();
    status.textContent = res.ok ? "Welcome, " + data.email + " — you are on the " + data.plan + " plan." : "Error: " + data.error;
  });
  document.getElementById("invoices").addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    const row = btn.closest(".row");
    if (btn.dataset.action === "delete" && confirm("Delete " + row.getAttribute("aria-label") + "?")) row.remove();
    if (btn.dataset.action === "download") status.textContent = "Downloaded " + row.getAttribute("aria-label");
  });
  setTimeout(() => (document.getElementById("late").innerHTML = '<button id="more">Load older invoices</button>'), 800);
  document.getElementById("heavy").addEventListener("click", function recalculateTotals() {
    const end = performance.now() + 220; let x = 0;
    do { for (let i = 0; i < 200000; i++) x += Math.sqrt(x + i); } while (performance.now() < end);
    document.getElementById("heavy-result").textContent = "done";
  });
  window.__leaks = [];
  document.getElementById("leak").addEventListener("click", () => {
    const box = document.createElement("div");
    for (let i = 0; i < 400; i++) box.appendChild(document.createElement("p")).textContent = "preview line " + i;
    window.__leaks.push(box);
  });
  console.error("fixture: sample console error");
</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/signup") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => setTimeout(() => {
      const data = JSON.parse(body || "{}");
      const bad = !String(data.email).includes("@");
      res.writeHead(bad ? 422 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(bad ? { error: "invalid email" } : data));
    }, 250));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url === "/popup" ? "<title>Help center</title><h1>Help center</h1><p>How can we help?</p>" : PAGE);
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, "127.0.0.1", () => console.log(`fixture on http://127.0.0.1:${port}`));
