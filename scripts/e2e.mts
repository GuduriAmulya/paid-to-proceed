/**
 * End-to-end smoke test against a running Paid to Proceed server (npm run dev) and the PayPal sandbox.
 * Usage: npx tsx scripts/e2e.mts            (core flow)
 *        npx tsx scripts/e2e.mts --full     (also chat + contract extraction)
 */
const BASE = process.env.TRANCHE_URL ?? "http://localhost:8787";
const full = process.argv.includes("--full");

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error ?? JSON.stringify(data)}`);
  return data as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (s: string) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] ▶ ${s}`);
const ok = (s: string) => console.log(`   ✓ ${s}`);
function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  ok(msg);
}

step("Server state + reset demo");
const st = await call("GET", "/api/state");
expect(st.paypalConfigured && st.paypalMissing.length === 0, `PayPal sandbox ready (missing: ${st.paypalMissing.join(", ") || "none"})`);
expect(st.aiConfigured, `Claude configured (${st.model})`);
const { id } = await call("POST", "/api/reset");
let p = await call("GET", `/api/projects/${id}`);
const [m1, m2] = p.milestones;
ok(`Project "${p.name}" with ${p.milestones.length} phases, ${p.currency} ${p.metrics.total}`);

step("Gantt data");
const g = await call("GET", `/api/projects/${id}/gantt`);
expect(g.tasks.rows.length === 3 && g.dependencies.rows.length > 5, `${g.tasks.rows.length} phases, ${g.dependencies.rows.length} dependencies`);

step("Submit Phase 1 deliverable → Claude scope check");
const { submission } = await call("GET", "/api/sample");
p = await call("POST", `/api/projects/${id}/milestones/${m1.id}/submit`, { submission });
let ms = p.milestones[0];
console.log(`   verdict=${ms.scopeCheck.verdict}: ${ms.scopeCheck.summary}`);
for (const c of ms.scopeCheck.criteria) console.log(`     ${c.met ? "✓" : "✗"} ${c.criterion}`);
let inv = p.actions.find((a: any) => a.type === "send_invoice" && a.status === "pending");
if (!inv) {
  ok("Scope not fully met - using Invoice anyway");
  p = await call("POST", `/api/projects/${id}/milestones/${m1.id}/invoice-anyway`);
  inv = p.actions.find((a: any) => a.type === "send_invoice" && a.status === "pending");
}
expect(inv, "Invoice proposal waiting in inbox");
console.log(`   note: ${inv.draft.message}`);

step("Approve invoice → PayPal Invoicing (create + send)");
let r = await call("POST", `/api/projects/${id}/actions/${inv.id}/approve`, { draft: {} });
p = r.project;
ms = p.milestones[0];
expect(r.action.status === "executed", `Action executed: ${r.action.result}`);
expect(ms.status === "invoiced" && ms.invoice?.id, `Invoice ${ms.invoice.number} (${ms.invoice.id}) status ${ms.invoice.status}, due ${ms.invoice.dueDate}`);
expect(ms.invoice.payerUrl, `Payer link: ${ms.invoice.payerUrl}`);

step("Demo clock +10d → overdue → Claude drafts reminder");
await call("POST", "/api/clock", { days: 10 });
let rem: any;
for (let i = 0; i < 20 && !rem; i++) {
  p = await call("GET", `/api/projects/${id}`);
  rem = p.actions.find((a: any) => a.type === "send_reminder" && a.status === "pending");
  if (!rem) await sleep(2000);
}
ms = p.milestones[0];
expect(ms.gate === "overdue", `Gate overdue by ${ms.daysOverdue}d`);
expect(p.metrics.slipDays > 0, `Delivery slipped ${p.metrics.slipDays}d (${p.metrics.baselineEnd} → ${p.metrics.projectedEnd})`);
expect(rem, `Reminder drafted (${rem?.draft.tone}): "${rem?.draft.subject}"`);
console.log(`   ${rem.draft.message.replace(/\n/g, "\n   ")}`);

step("Approve reminder → PayPal invoice remind");
r = await call("POST", `/api/projects/${id}/actions/${rem.id}/approve`, { draft: {} });
expect(r.action.status === "executed", `Reminder: ${r.action.result}`);

step("Client pays (recorded payment on the PayPal invoice) → gate clears");
p = await call("POST", `/api/projects/${id}/milestones/${m1.id}/simulate-payment`);
ms = p.milestones[0];
expect(ms.status === "paid", `Phase 1 paid at ${ms.paidAt}`);
expect(p.metrics.received === ms.amount, `Received ${p.currency} ${p.metrics.received}`);
const pay = p.actions.find((a: any) => a.type === "pay_subcontractor" && a.status === "pending");
expect(pay, `Payout proposed: ${pay?.title}`);

step("Verify PayPal agrees the invoice is paid (sync)");
p = await call("POST", `/api/projects/${id}/sync`);
const act = p.activity.slice(0, 3).map((e: any) => e.text);
ok(`Recent activity: ${act.join(" | ")}`);

step("Approve payout → PayPal Payouts");
r = await call("POST", `/api/projects/${id}/actions/${pay.id}/approve`, { draft: {} });
expect(r.action.status === "executed", `Payout: ${r.action.result}`);
expect(r.project.metrics.paidOut > 0, `Paid to team: ${r.project.currency} ${r.project.metrics.paidOut}`);
expect(r.project.milestones[1].id === m2.id, `Phase 2 "${m2.name}" unlocked (previous phase paid)`);

if (full) {
  step("Ask your agent (Claude + PayPal Agent Toolkit)");
  const chat = await call("POST", "/api/chat", { projectId: id, messages: [{ role: "user", content: "Check PayPal directly: what is the live status of the Discovery & Design invoice, and who has been paid out so far?" }] });
  console.log(`   ${chat.reply.replace(/\n/g, "\n   ")}`);
  expect(chat.reply.length > 20, "Chat replied");

  step("New project from sample contract (Claude extraction)");
  const { contract } = await call("GET", "/api/sample");
  const form = new FormData();
  form.append("text", contract);
  const res = await fetch(BASE + "/api/projects", { method: "POST", body: form });
  const created: any = await res.json();
  expect(res.ok, `Created ${created.id ?? created.error}`);
  const np = await call("GET", `/api/projects/${created.id}`);
  for (const m of np.milestones) console.log(`     ${m.name}: ${np.currency} ${m.amount} · ${m.tasks.length} tasks · ${m.acceptanceCriteria.length} criteria · splits ${m.splits.length}`);
  expect(np.milestones.length >= 2, `Extracted ${np.milestones.length} milestones totalling ${np.metrics.total}`);
  await call("DELETE", `/api/projects/${created.id}`);
}

step("Reset clock");
await call("POST", "/api/clock", { reset: true });
console.log(`\nALL CHECKS PASSED in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
