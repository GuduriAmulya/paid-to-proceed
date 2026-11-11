/**
 * The Paid to Proceed agent loop. The agent watches project + PayPal state and *proposes* money-moving
 * actions (send invoice, send reminder, pay a subcontractor). Nothing touches PayPal until the
 * freelancer approves the proposal, and every step is written to the activity log.
 */
import * as paypal from "./paypal.js";
import { checkScope, draftReminder, type ContractPlan } from "./ai.js";
import { daysOverdue, gateState } from "./gantt.js";
import { addDays, daysBetween, getDb, isoDate, log, now, save, uid } from "./store.js";
import { config } from "./config.js";
import type { AgentAction, Milestone, Project } from "./types.js";

const inflight = new Set<string>();

function money(p: Project, n: number) {
  return `${p.currency} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function propose(p: Project, a: Omit<AgentAction, "id" | "status" | "createdAt">): AgentAction {
  const action: AgentAction = { ...a, id: uid("act"), status: "pending", createdAt: now().toISOString() };
  p.actions.unshift(action);
  log(p, "agent", `Proposed: ${a.title}`);
  return action;
}

export function findMilestone(p: Project, id: string): Milestone {
  const m = p.milestones.find((x) => x.id === id);
  if (!m) throw Object.assign(new Error(`Milestone ${id} not found`), { status: 404 });
  return m;
}

function phasesAfter(p: Project, m: Milestone): string[] {
  const i = p.milestones.indexOf(m);
  return p.milestones.slice(i + 1).map((x) => x.name);
}

// ------------------------------------------------------------------ project creation

export function projectFromPlan(plan: ContractPlan): Project {
  const today = isoDate(now());
  const subs = plan.subcontractors.map((s) => ({
    id: uid("sub"),
    name: s.name,
    role: s.role,
    email: config.demoSubcontractorEmail,
    milestoneIndex: s.milestoneIndex,
    percent: s.percent,
  }));
  const p: Project = {
    id: uid("prj"),
    name: plan.projectName,
    freelancer: { name: plan.freelancerName || "Freelancer", location: plan.freelancerLocation },
    client: {
      name: plan.clientCompany || "Client",
      contactName: plan.clientContactName || plan.clientCompany || "there",
      // Invoices go to the sandbox buyer account so the demo can be paid end to end.
      email: config.demoClientEmail,
    },
    currency: (plan.currency || "USD").toUpperCase(),
    summary: plan.summary,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(plan.startDate) ? plan.startDate : today,
    milestones: plan.milestones.map((m, i) => ({
      id: uid("ms"),
      name: m.name,
      amount: Math.round(m.amount * 100) / 100,
      deliverables: m.deliverables,
      acceptanceCriteria: m.acceptanceCriteria,
      tasks: m.tasks.map((t) => ({ id: uid("tsk"), name: t.name, durationDays: t.durationDays })),
      paymentTermsDays: Math.min(30, Math.max(1, plan.paymentTermsDays || 7)),
      splits: subs.filter((s) => s.milestoneIndex === i).map((s) => ({ subcontractorId: s.id, percent: s.percent })),
      status: "planned",
      reminders: [],
      payouts: [],
    })),
    subcontractors: subs.map(({ milestoneIndex: _i, percent: _p, ...s }) => s),
    actions: [],
    activity: [],
    createdAt: now().toISOString(),
  };
  log(p, "agent", `Read the contract and built ${p.milestones.length} payment-gated phases worth ${money(p, p.milestones.reduce((s, m) => s + m.amount, 0))}.`);
  for (const r of plan.risks.slice(0, 3)) log(p, "agent", `Payment risk spotted: ${r}`);
  return p;
}

// ------------------------------------------------------------------ deliverables & invoicing

export async function submitDeliverable(p: Project, m: Milestone, submission: string) {
  if (m.status !== "planned" && m.status !== "submitted") throw Object.assign(new Error("This milestone is already invoiced."), { status: 400 });
  log(p, "user", `Submitted deliverable for "${m.name}".`);
  const check = await checkScope(p, m, submission);
  m.submission = submission;
  m.scopeCheck = { ...check, checkedAt: now().toISOString() };
  m.status = "submitted";
  const met = check.criteria.filter((c) => c.met).length;
  log(p, "agent", `Scope check for "${m.name}": ${check.verdict.toUpperCase()} (${met}/${check.criteria.length} criteria). ${check.summary}`);
  p.actions = p.actions.filter((a) => !(a.milestoneId === m.id && a.type === "send_invoice" && a.status === "pending"));
  if (check.verdict === "meets") proposeInvoice(p, m);
  save();
}

export function proposeInvoice(p: Project, m: Milestone) {
  const next = phasesAfter(p, m)[0];
  return propose(p, {
    type: "send_invoice",
    milestoneId: m.id,
    title: `Invoice ${p.client.name} ${money(p, m.amount)} for "${m.name}"`,
    rationale:
      m.scopeCheck?.verdict === "meets"
        ? `All acceptance criteria are met. Payment is due in ${m.paymentTermsDays} days${next ? ` and unlocks "${next}"` : ""}.`
        : `You chose to invoice even though the scope check found gaps (${m.scopeCheck?.verdict ?? "unchecked"}).`,
    draft: {
      subject: `${p.freelancer.name}: invoice for ${m.name}`,
      message: m.scopeCheck?.clientNote ?? `Hi ${p.client.contactName}, "${m.name}" is complete. Thank you!`,
      amount: m.amount,
    },
  });
}

async function executeInvoice(p: Project, m: Milestone, a: AgentAction) {
  const today = isoDate(now());
  const dueDate = addDays(today, m.paymentTermsDays);
  const amount = a.draft.amount && a.draft.amount > 0 ? a.draft.amount : m.amount;
  const inv = await paypal.createInvoice({
    freelancerName: p.freelancer.name,
    clientName: p.client.name,
    clientEmail: sandboxEmail(config.demoClientEmail, p.client.email),
    currency: p.currency,
    itemName: `${p.name} - ${m.name}`,
    itemDescription: m.deliverables.join("; "),
    amount,
    note: a.draft.message ?? "",
    dueDate,
    reference: `${p.name} / ${m.name}`,
  });
  await paypal.sendInvoice(inv.id, a.draft.subject ?? `Invoice for ${m.name}`, a.draft.message ?? "");
  const details = await paypal.getInvoice(inv.id).catch(() => undefined);
  m.amount = amount;
  m.status = "invoiced";
  m.invoice = { id: inv.id, number: inv.number, status: details?.status ?? "SENT", payerUrl: details?.payerUrl, sentAt: now().toISOString(), dueDate };
  log(p, "paypal", `PayPal invoice ${inv.number} sent to ${sandboxEmail(config.demoClientEmail, p.client.email)} for ${money(p, amount)}, due ${dueDate}.`);
  return `Invoice ${inv.number} sent (${inv.id})`;
}

// ------------------------------------------------------------------ payments

export function markPaid(p: Project, m: Milestone, source: string) {
  if (m.status === "paid") return;
  m.status = "paid";
  m.paidAt = now().toISOString();
  if (m.invoice) m.invoice.status = "PAID";
  const late = m.invoice ? Math.max(0, daysBetween(m.invoice.dueDate, isoDate(now()))) : 0;
  log(p, "paypal", `Payment received for "${m.name}" (${money(p, m.amount)}) via ${source}${late ? `, ${late} day(s) late` : ""}.`);
  const next = phasesAfter(p, m)[0];
  if (next) log(p, "agent", `Payment gate cleared - "${next}" is unlocked and the timeline was re-planned.`);
  p.actions.forEach((a) => {
    if (a.milestoneId === m.id && a.type === "send_reminder" && a.status === "pending") {
      a.status = "rejected";
      a.result = "No longer needed - invoice paid.";
    }
  });
  for (const s of m.splits) {
    const sub = p.subcontractors.find((x) => x.id === s.subcontractorId);
    if (!sub) continue;
    const amount = Math.round(m.amount * s.percent) / 100;
    propose(p, {
      type: "pay_subcontractor",
      milestoneId: m.id,
      title: `Pay ${sub.name} (${sub.role}) ${money(p, amount)} via PayPal Payouts`,
      rationale: `${s.percent}% of "${m.name}" belongs to ${sub.name}. The client has paid, so it is safe to pay them now.`,
      draft: { amount, subcontractorId: sub.id, message: `Thanks for your work on ${m.name} for ${p.client.name}. Here's your ${s.percent}% share. - ${p.freelancer.name.split(" ")[0]}` },
    });
  }
}

export async function syncPayments(p: Project): Promise<number> {
  let changed = 0;
  for (const m of p.milestones) {
    if (m.status !== "invoiced" || !m.invoice) continue;
    try {
      const inv = await paypal.getInvoice(m.invoice.id);
      m.invoice.status = inv.status;
      if (inv.payerUrl) m.invoice.payerUrl = inv.payerUrl;
      if (inv.status === "PAID" || inv.status === "MARKED_AS_PAID") {
        markPaid(p, m, inv.status === "PAID" ? "PayPal" : "a recorded payment");
        changed++;
      }
    } catch (e) {
      console.warn(`[sync] ${m.invoice.id}:`, (e as Error).message);
    }
  }
  for (const m of p.milestones) {
    for (const po of m.payouts) {
      if (po.status === "SUCCESS" || po.status === "DENIED") continue;
      try {
        const st = await paypal.getPayoutStatus(po.batchId);
        if (st !== po.status) {
          po.status = st;
          changed++;
          if (st === "SUCCESS") log(p, "paypal", `Payout batch ${po.batchId} completed.`);
        }
      } catch {
        /* payout status is best-effort */
      }
    }
  }
  if (changed) save();
  return changed;
}

export async function simulatePayment(p: Project, m: Milestone) {
  if (m.status !== "invoiced" || !m.invoice) throw Object.assign(new Error("Milestone is not invoiced yet."), { status: 400 });
  await paypal.recordInvoicePayment(m.invoice.id, m.amount, p.currency, isoDate(now()));
  markPaid(p, m, "a recorded payment (demo)");
  save();
}

export function handleWebhook(event: { event_type?: string; resource?: any }) {
  const type = event.event_type ?? "";
  const r = event.resource ?? {};
  for (const p of getDb().projects) {
    if (type.startsWith("INVOICING.INVOICE.")) {
      const invId = r.invoice?.id ?? r.id;
      const m = p.milestones.find((x) => x.invoice?.id === invId);
      if (!m) continue;
      log(p, "paypal", `Webhook ${type} for invoice ${m.invoice?.number}.`);
      if (type === "INVOICING.INVOICE.PAID") markPaid(p, m, "PayPal (webhook)");
      save();
    }
    if (type.startsWith("PAYMENT.PAYOUTSBATCH.")) {
      const batchId = r.batch_header?.payout_batch_id;
      for (const m of p.milestones)
        for (const po of m.payouts)
          if (po.batchId === batchId) {
            po.status = r.batch_header?.batch_status ?? po.status;
            log(p, "paypal", `Webhook ${type}: payout ${batchId} is ${po.status}.`);
            save();
          }
    }
  }
}

// ------------------------------------------------------------------ the watch loop

/** Look for overdue invoices and draft an escalating reminder (at most one every 3 days). */
export async function tick(p: Project) {
  for (const m of p.milestones) {
    if (gateState(m) !== "overdue") continue;
    if (inflight.has(m.id)) continue;
    if (p.actions.some((a) => a.milestoneId === m.id && a.type === "send_reminder" && a.status === "pending")) continue;
    const last = m.reminders.at(-1);
    if (last && daysBetween(last.sentAt, isoDate(now())) < 3) continue;
    inflight.add(m.id);
    try {
      const late = daysOverdue(m);
      const blocked = phasesAfter(p, m);
      const draft = await draftReminder(p, m, late, blocked);
      propose(p, {
        type: "send_reminder",
        milestoneId: m.id,
        title: `Send ${draft.tone} reminder for invoice ${m.invoice?.number} (${late}d overdue)`,
        rationale: `${draft.rationale}${blocked.length ? ` Every day late pushes "${blocked[0]}" back a day.` : ""}`,
        draft: { subject: draft.subject, message: draft.message, tone: draft.tone },
      });
      save();
    } catch (e) {
      log(p, "system", `Could not draft a reminder: ${(e as Error).message}`);
    } finally {
      inflight.delete(m.id);
    }
  }
}

export async function tickAll() {
  for (const p of getDb().projects) {
    await syncPayments(p).catch(() => 0);
    await tick(p);
  }
}

// ------------------------------------------------------------------ approvals

export async function approve(p: Project, actionId: string, edits: AgentAction["draft"] = {}) {
  const a = p.actions.find((x) => x.id === actionId);
  if (!a) throw Object.assign(new Error("Action not found"), { status: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(`Action is already ${a.status}`), { status: 400 });
  a.draft = { ...a.draft, ...Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined && v !== "")) };
  a.status = "approved";
  log(p, "user", `Approved: ${a.title}`);
  const m = findMilestone(p, a.milestoneId);
  try {
    if (a.type === "send_invoice") a.result = await executeInvoice(p, m, a);
    else if (a.type === "send_reminder") {
      if (!m.invoice || m.status !== "invoiced") throw new Error("Invoice is no longer outstanding");
      await paypal.remindInvoice(m.invoice.id, a.draft.subject ?? "Payment reminder", a.draft.message ?? "");
      m.reminders.push({ sentAt: now().toISOString(), tone: a.draft.tone ?? "friendly" });
      log(p, "paypal", `PayPal reminder #${m.reminders.length} (${a.draft.tone}) sent for invoice ${m.invoice.number}.`);
      a.result = "Reminder sent through PayPal Invoicing";
    } else if (a.type === "pay_subcontractor") {
      const sub = p.subcontractors.find((s) => s.id === a.draft.subcontractorId);
      if (!sub) throw new Error("Subcontractor not found");
      const amount = Number(a.draft.amount);
      if (!(amount > 0) || amount > m.amount) throw new Error(`Payout amount must be between 0 and ${m.amount}`);
      const po = await paypal.createPayout({ receiverEmail: sandboxEmail(config.demoSubcontractorEmail, sub.email), amount, currency: p.currency, note: a.draft.message ?? "", reference: `${m.id}_${sub.id}` });
      m.payouts.push({ batchId: po.batchId, subcontractorId: sub.id, amount, status: po.status, at: now().toISOString() });
      log(p, "paypal", `PayPal Payout ${po.batchId} created: ${money(p, amount)} to ${sub.name} (${po.status}).`);
      a.result = `Payout ${po.batchId} ${po.status}`;
    }
    a.status = "executed";
  } catch (e) {
    // Keep it in the inbox so the freelancer can fix the cause and retry.
    a.status = "pending";
    a.result = `Last attempt failed: ${(e as Error).message}`;
    log(p, "system", `Action failed: ${a.title} - ${(e as Error).message}`);
    save();
    throw e;
  }
  a.resolvedAt = now().toISOString();
  save();
  return a;
}

export function reject(p: Project, actionId: string) {
  const a = p.actions.find((x) => x.id === actionId);
  if (!a) throw Object.assign(new Error("Action not found"), { status: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(`Action is already ${a.status}`), { status: 400 });
  a.status = "rejected";
  a.resolvedAt = now().toISOString();
  log(p, "user", `Rejected: ${a.title}`);
  save();
}

/** In the sandbox, money always goes to the test accounts currently configured in .env. */
function sandboxEmail(configured: string, stored: string): string {
  const isPlaceholder = (e: string) => !e || /^(client|subcontractor)@example\.com$/.test(e);
  return config.paypalEnv === "SANDBOX" && !isPlaceholder(configured) ? configured : stored;
}
