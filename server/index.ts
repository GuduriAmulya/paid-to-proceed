import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { config, hasPayPal } from "./config.js";
import { AIUnavailableError, extractContract } from "./ai.js";
import * as agent from "./agent.js";
import { chat } from "./copilot.js";
import { demoProject, SAMPLE_CONTRACT, SAMPLE_SUBMISSION } from "./demo.js";
import { baselineEnd, buildGanttData, daysOverdue, gateState, projectedEnd } from "./gantt.js";
import { missingFeatures, PayPalError, verifyWebhook } from "./paypal.js";
import { daysBetween, getDb, getProject, isoDate, log, now, resetDb, save } from "./store.js";
import type { Project } from "./types.js";

const app = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });
app.use(express.json({ limit: "2mb" }));

type Req = Request<Record<string, string>>;
type Handler = (req: Req, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Req, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

function view(p: Project) {
  const today = isoDate(now());
  const total = p.milestones.reduce((s, m) => s + m.amount, 0);
  const received = p.milestones.filter((m) => m.status === "paid").reduce((s, m) => s + m.amount, 0);
  const outstanding = p.milestones.filter((m) => m.status === "invoiced").reduce((s, m) => s + m.amount, 0);
  const overdue = p.milestones.filter((m) => gateState(m, today) === "overdue").reduce((s, m) => s + m.amount, 0);
  const paidOut = p.milestones.flatMap((m) => m.payouts).reduce((s, x) => s + x.amount, 0);
  const bEnd = baselineEnd(p);
  const pEnd = projectedEnd(p);
  return {
    ...p,
    milestones: p.milestones.map((m) => ({ ...m, gate: gateState(m, today), daysOverdue: daysOverdue(m, today) })),
    metrics: { total, received, outstanding, overdue, paidOut, baselineEnd: bEnd, projectedEnd: pEnd, slipDays: Math.max(0, daysBetween(bEnd, pEnd)) },
  };
}

// ------------------------------------------------------------------ state

app.get("/api/state", h(async (_req, res) => {
  const db = getDb();
  const paypalMissing = hasPayPal ? await missingFeatures().catch((e) => [`(auth error: ${(e as Error).message})`]) : [];
  res.json({
    paypalMissing,
    today: isoDate(now()),
    clockOffsetDays: db.clockOffsetDays,
    paypalConfigured: hasPayPal,
    paypalEnv: config.paypalEnv,
    aiConfigured: config.hasAnthropicKey,
    model: config.anthropicModel,
    webhookConfigured: Boolean(config.paypalWebhookId),
    projects: db.projects.map((p) => ({ id: p.id, name: p.name, client: p.client.name, pending: p.actions.filter((a) => a.status === "pending").length })),
  });
}));

app.get("/api/sample", (_req, res) => res.json({ contract: SAMPLE_CONTRACT, submission: SAMPLE_SUBMISSION }));

app.get("/api/projects/:id", (req, res) => res.json(view(getProject(req.params.id))));
app.get("/api/projects/:id/gantt", (req, res) => res.json(buildGanttData(getProject(req.params.id))));

app.post("/api/projects/demo", (_req, res) => {
  const p = demoProject();
  getDb().projects.unshift(p);
  save();
  res.json({ id: p.id });
});

app.post(
  "/api/projects",
  upload.single("file"),
  h(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const file = req.file;
    if (!text && !file) return res.status(400).json({ error: "Upload a PDF contract or paste the contract text." });
    if (file && file.mimetype !== "application/pdf") return res.status(400).json({ error: "Only PDF uploads are supported." });
    const plan = await extractContract({ pdfBase64: file?.buffer.toString("base64"), text: text || undefined });
    const p = agent.projectFromPlan(plan);
    getDb().projects.unshift(p);
    save();
    res.json({ id: p.id });
  }),
);

app.delete("/api/projects/:id", (req, res) => {
  const db = getDb();
  db.projects = db.projects.filter((p) => p.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ milestones

app.post(
  "/api/projects/:id/milestones/:mid/submit",
  h(async (req, res) => {
    const p = getProject(req.params.id);
    const submission = String(req.body?.submission ?? "").trim();
    if (submission.length < 10) return res.status(400).json({ error: "Describe what you delivered (links, files, notes)." });
    await agent.submitDeliverable(p, agent.findMilestone(p, req.params.mid), submission);
    res.json(view(p));
  }),
);

app.post("/api/projects/:id/milestones/:mid/invoice-anyway", (req, res) => {
  const p = getProject(req.params.id);
  const m = agent.findMilestone(p, req.params.mid);
  if (m.status === "invoiced" || m.status === "paid") return res.status(400).json({ error: `Already ${m.status}` });
  if (!p.actions.some((a) => a.milestoneId === m.id && a.type === "send_invoice" && a.status === "pending")) agent.proposeInvoice(p, m);
  save();
  res.json(view(p));
});

app.post(
  "/api/projects/:id/milestones/:mid/simulate-payment",
  h(async (req, res) => {
    const p = getProject(req.params.id);
    await agent.simulatePayment(p, agent.findMilestone(p, req.params.mid));
    res.json(view(p));
  }),
);

// ------------------------------------------------------------------ approvals

app.post(
  "/api/projects/:id/actions/:aid/approve",
  h(async (req, res) => {
    const p = getProject(req.params.id);
    const a = await agent.approve(p, req.params.aid, req.body?.draft ?? {});
    res.json({ action: a, project: view(p) });
  }),
);

app.post("/api/projects/:id/actions/:aid/reject", (req, res) => {
  const p = getProject(req.params.id);
  agent.reject(p, req.params.aid);
  res.json(view(p));
});

app.post(
  "/api/projects/:id/sync",
  h(async (req, res) => {
    const p = getProject(req.params.id);
    await agent.syncPayments(p);
    await agent.tick(p);
    res.json(view(p));
  }),
);

// ------------------------------------------------------------------ demo clock

app.post(
  "/api/clock",
  h(async (req, res) => {
    const db = getDb();
    if (req.body?.reset) db.clockOffsetDays = 0;
    else db.clockOffsetDays += Math.max(-60, Math.min(60, Number(req.body?.days ?? 1)));
    for (const p of db.projects) log(p, "system", `Demo clock moved to ${isoDate(now())}.`);
    save();
    await agent.tickAll();
    res.json({ today: isoDate(now()), clockOffsetDays: db.clockOffsetDays });
  }),
);

app.post("/api/reset", (_req, res) => {
  resetDb({ clockOffsetDays: 0, projects: [demoProject()] });
  res.json({ id: getDb().projects[0].id });
});

// ------------------------------------------------------------------ copilot

app.post(
  "/api/chat",
  h(async (req, res) => {
    const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
    const clean = msgs
      .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!clean.length || clean[0].role !== "user") return res.status(400).json({ error: "Send at least one user message." });
    res.json({ reply: await chat(req.body?.projectId ?? null, clean) });
  }),
);

// ------------------------------------------------------------------ PayPal webhooks

app.post(
  "/api/webhooks/paypal",
  h(async (req, res) => {
    const ok = await verifyWebhook(req.headers, req.body).catch(() => false);
    if (!ok) {
      console.warn("[webhook] rejected: signature not verified (is PAYPAL_WEBHOOK_ID set?)");
      return res.status(400).json({ error: "verification failed" });
    }
    agent.handleWebhook(req.body);
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ static client (production)

const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof PayPalError ? 502 : err instanceof AIUnavailableError ? 503 : (err.status ?? 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? "Something went wrong" });
});

// Seed a demo project on first boot so the app is never empty.
if (getDb().projects.length === 0) {
  getDb().projects.push(demoProject());
  save();
}

// Background watcher: poll PayPal for payments and draft reminders for overdue invoices.
setInterval(() => agent.tickAll().catch((e) => console.warn("[tick]", e.message)), 20_000);

app.listen(config.port, () => {
  console.log(`Paid to Proceed API on http://localhost:${config.port}  (PayPal ${hasPayPal ? config.paypalEnv : "NOT CONFIGURED"}, AI ${config.hasAnthropicKey ? config.anthropicModel : "NOT CONFIGURED"})`);
});
