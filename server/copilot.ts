/**
 * "Ask your agent" - a conversational agent over the freelancer's projects and live PayPal data.
 * Read-only PayPal tools come from the official PayPal Agent Toolkit; anything that would move
 * money is only *proposed* into the approval inbox, never executed directly.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod/v4";
import { anthropic } from "./ai.js";
import { config, hasPayPal } from "./config.js";
import { baselineEnd, daysOverdue, gateState, projectedEnd } from "./gantt.js";
import { findMilestone, proposeInvoice } from "./agent.js";
import { getDb, isoDate, log, now, save, uid } from "./store.js";
import type { Project } from "./types.js";

let toolkitTools: ReturnType<typeof buildToolkitTools> | null = null;

function buildToolkitTools() {
  const toolkit = new PayPalAgentToolkit({
    clientId: config.paypalClientId,
    clientSecret: config.paypalClientSecret,
    configuration: {
      actions: { invoices: { list: true, get: true }, transactions: { list: true }, disputes: { list: true, get: true } },
      context: { sandbox: config.paypalEnv !== "PRODUCTION" },
    },
  });
  return Object.entries(toolkit.getTools()).map(([name, t]) => {
    const schema = zodToJsonSchema((t as any).parameters, { target: "jsonSchema7", $refStrategy: "none" }) as any;
    delete schema.$schema;
    if (schema.type !== "object") Object.assign(schema, { type: "object", properties: {} });
    return betaTool({
      name: `paypal_${name}`,
      description: `[PayPal Agent Toolkit] ${String(t.description ?? "").trim().slice(0, 900)}`,
      inputSchema: schema,
      run: async (args: unknown) => {
        try {
          const out = await (t as any).execute(args, { toolCallId: uid("tc"), messages: [] });
          const s = typeof out === "string" ? out : JSON.stringify(out);
          return s.length > 12000 ? `${s.slice(0, 12000)}…(truncated)` : s;
        } catch (e) {
          return `PayPal tool error: ${(e as Error).message}`;
        }
      },
    });
  });
}

function projectBrief(p: Project) {
  const today = isoDate(now());
  return {
    id: p.id,
    name: p.name,
    client: p.client,
    currency: p.currency,
    baselineEnd: baselineEnd(p),
    projectedEnd: projectedEnd(p),
    milestones: p.milestones.map((m) => ({
      id: m.id,
      name: m.name,
      amount: m.amount,
      status: m.status,
      gate: gateState(m, today),
      daysOverdue: daysOverdue(m, today),
      invoice: m.invoice ? { id: m.invoice.id, number: m.invoice.number, dueDate: m.invoice.dueDate, status: m.invoice.status } : null,
      remindersSent: m.reminders.length,
      scopeVerdict: m.scopeCheck?.verdict ?? null,
    })),
    pendingApprovals: p.actions.filter((a) => a.status === "pending").map((a) => ({ id: a.id, type: a.type, title: a.title })),
  };
}

export async function chat(projectId: string | null, messages: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  if (!config.hasAnthropicKey) return "Ask your agent needs ANTHROPIC_API_KEY to be configured on the server.";
  if (hasPayPal && !toolkitTools) toolkitTools = buildToolkitTools();

  const appTools = [
    betaZodTool({
      name: "get_projects",
      description: "Get every Paid to Proceed project with milestones, payment-gate state, invoices, overdue days and pending approvals. Call this first.",
      inputSchema: z.object({}),
      run: async () => JSON.stringify({ today: isoDate(now()), projects: getDb().projects.map(projectBrief) }),
    }),
    betaZodTool({
      name: "propose_payment_reminder",
      description:
        "Queue a payment reminder for an overdue or awaiting invoice in the freelancer's approval inbox. It is NOT sent until the freelancer approves it.",
      inputSchema: z.object({
        projectId: z.string(),
        milestoneId: z.string(),
        tone: z.enum(["friendly", "firm", "final"]),
        subject: z.string(),
        message: z.string(),
        why: z.string().describe("One sentence explaining why now and why this tone"),
      }),
      run: async (i) => {
        const p = getDb().projects.find((x) => x.id === i.projectId);
        if (!p) return "Unknown project id";
        const m = findMilestone(p, i.milestoneId);
        if (m.status !== "invoiced") return `Milestone "${m.name}" has no outstanding invoice (status ${m.status}).`;
        p.actions.unshift({
          id: uid("act"),
          type: "send_reminder",
          milestoneId: m.id,
          title: `Send ${i.tone} reminder for invoice ${m.invoice?.number} (requested in chat)`,
          rationale: i.why,
          draft: { subject: i.subject, message: i.message, tone: i.tone },
          status: "pending",
          createdAt: now().toISOString(),
        });
        log(p, "agent", `Proposed from chat: ${i.tone} reminder for "${m.name}".`);
        save();
        return "Reminder queued for approval in the inbox.";
      },
    }),
    betaZodTool({
      name: "propose_invoice",
      description: "Queue a PayPal invoice for a submitted milestone in the approval inbox. It is NOT sent until the freelancer approves it.",
      inputSchema: z.object({ projectId: z.string(), milestoneId: z.string() }),
      run: async (i) => {
        const p = getDb().projects.find((x) => x.id === i.projectId);
        if (!p) return "Unknown project id";
        const m = findMilestone(p, i.milestoneId);
        if (m.status === "invoiced" || m.status === "paid") return `Already ${m.status}.`;
        proposeInvoice(p, m);
        save();
        return "Invoice queued for approval in the inbox.";
      },
    }),
  ];

  const focus = projectId ? `The freelancer is currently looking at project ${projectId}.` : "";
  const final = await anthropic.beta.messages.toolRunner({
    model: config.anthropicModel,
    max_tokens: 16000,
    max_iterations: 8,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: `You are the Paid to Proceed agent, a calm, sharp back-office assistant for an independent freelancer who bills overseas clients through PayPal.
Today (demo clock) is ${isoDate(now())}. ${focus}
${getDb().clockOffsetDays ? `The demo clock is ${getDb().clockOffsetDays} days ahead of real time: dates Paid to Proceed records (paid dates, due dates) use the demo clock, while PayPal's own timestamps use real time. Don't flag that gap as a problem.` : ""}
Invoices that Paid to Proceed tracks are listed in get_projects. The PayPal account may also hold older test invoices; focus on the tracked ones and mention others in one short line at most.
"Simulate payment" in Paid to Proceed records an external payment on the PayPal invoice (status MARKED_AS_PAID) - treat it as the client having paid.
Use get_projects for project state and the paypal_* tools (PayPal Agent Toolkit, sandbox) for live PayPal data such as invoice status or transactions.
You can propose reminders or invoices, but they only go into the approval inbox - say so. Never claim money moved unless the data shows it.
Answer in short paragraphs or tight bullet points, with amounts and dates. Keep it under 150 words unless asked for more.`,
    tools: [...appTools, ...(toolkitTools ?? [])],
    messages: messages.map((m) => ({ role: m.role, content: m.content })) as Anthropic.Beta.BetaMessageParam[],
  });
  if (final.stop_reason === "refusal") return "I can't help with that request.";
  return final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
