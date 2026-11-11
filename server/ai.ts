/**
 * Claude-powered reasoning for Paid to Proceed:
 *  - turn a contract (PDF or text) into milestones, tasks and payment tranches
 *  - check a submitted deliverable against the milestone's acceptance criteria
 *  - draft payment reminders whose tone escalates politely
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { config } from "./config.js";
import type { Milestone, Project, ScopeCheck } from "./types.js";

export const anthropic = new Anthropic();

export class AIUnavailableError extends Error {}

async function structured<T extends z.ZodType>(opts: {
  schema: T;
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  effort?: "low" | "medium" | "high";
}): Promise<z.infer<T>> {
  if (!config.hasAnthropicKey) throw new AIUnavailableError("ANTHROPIC_API_KEY is not set");
  const res = await anthropic.beta.messages.parse({
    model: config.anthropicModel,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: opts.system,
    output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
    messages: [{ role: "user", content: opts.content }],
  });
  if (res.stop_reason === "refusal") throw new Error(`Claude declined this request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ""}`);
  if (!res.parsed_output) throw new Error(`Claude returned no structured output (stop_reason=${res.stop_reason})`);
  return res.parsed_output as z.infer<T>;
}

// ---------------------------------------------------------------- contract → plan

export const ContractPlanSchema = z.object({
  projectName: z.string().describe("Short project name, e.g. 'Clinic website + online booking'"),
  summary: z.string().describe("One or two sentence plain-English summary of the engagement"),
  freelancerName: z.string(),
  freelancerLocation: z.string().describe("City/country of the freelancer if stated, else empty string"),
  clientCompany: z.string(),
  clientContactName: z.string(),
  clientEmail: z.string().describe("Client billing email if stated, else empty string"),
  currency: z.string().describe("ISO 4217 currency code, e.g. USD"),
  startDate: z.string().describe("Project start date YYYY-MM-DD if stated, else empty string"),
  paymentTermsDays: z.number().int().describe("Days the client has to pay each invoice (net terms). Default 7 if unstated."),
  milestones: z
    .array(
      z.object({
        name: z.string().describe("Milestone / phase name"),
        amount: z.number().describe("Amount payable on completion of this milestone"),
        deliverables: z.array(z.string()),
        acceptanceCriteria: z.array(z.string()).describe("Concrete, checkable conditions that mean this milestone is done"),
        tasks: z
          .array(z.object({ name: z.string(), durationDays: z.number().int().min(1).max(60) }))
          .describe("2-5 work tasks in order, with realistic calendar-day durations"),
      }),
    )
    .min(1)
    .max(8),
  subcontractors: z
    .array(
      z.object({
        name: z.string(),
        role: z.string(),
        milestoneIndex: z.number().int().describe("0-based index of the milestone they are paid from"),
        percent: z.number().describe("Percent of that milestone's amount they receive"),
      }),
    )
    .describe("People the freelancer pays out of milestone money, if the contract or notes mention them"),
  risks: z.array(z.string()).describe("Up to 3 payment risks spotted in the contract (vague acceptance, no late fee, etc.)"),
});
export type ContractPlan = z.infer<typeof ContractPlanSchema>;

const CONTRACT_SYSTEM = `You are the Paid to Proceed agent, a back-office agent for independent freelancers who bill international clients through PayPal.
Read the contract or proposal and turn it into a payment-gated project plan: each milestone is a tranche of money that
the client pays when its acceptance criteria are met. Extract figures exactly as written; never invent amounts. If the
contract gives a total but no split, divide it sensibly and say so in the summary. Durations should be realistic for a
solo freelancer. Acceptance criteria must be concrete enough that someone could check a deliverable against them.`;

export async function extractContract(input: { pdfBase64?: string; text?: string }): Promise<ContractPlan> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.pdfBase64) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 } });
  }
  if (input.text) content.push({ type: "text", text: `<contract>\n${input.text}\n</contract>` });
  content.push({ type: "text", text: "Build the payment-gated project plan for this engagement." });
  return structured({ schema: ContractPlanSchema, system: CONTRACT_SYSTEM, content, effort: "medium" });
}

// ---------------------------------------------------------------- deliverable scope check

const ScopeSchema = z.object({
  verdict: z.enum(["meets", "partial", "missing"]),
  summary: z.string().describe("One sentence for the freelancer: is this ready to invoice, and if not what's missing"),
  criteria: z.array(z.object({ criterion: z.string(), met: z.boolean(), evidence: z.string() })),
  clientNote: z
    .string()
    .describe("A warm, professional 2-4 sentence note to the client that goes on the PayPal invoice, summarising what was delivered"),
});

export async function checkScope(project: Project, m: Milestone, submission: string): Promise<Omit<ScopeCheck, "checkedAt">> {
  if (!config.hasAnthropicKey) {
    return {
      verdict: "meets",
      summary: "AI key not configured - accepted without an automated scope check.",
      criteria: m.acceptanceCriteria.map((c) => ({ criterion: c, met: true, evidence: "Not checked (no AI key)" })),
      clientNote: `Hi ${project.client.contactName}, "${m.name}" is complete. Thank you - the next phase starts as soon as this invoice is settled.`,
    };
  }
  return structured({
    schema: ScopeSchema,
    effort: "medium",
    system: `You are the Paid to Proceed agent, reviewing a freelancer's milestone submission before it is invoiced through PayPal.
Be fair but strict: a criterion is met only if the submission gives evidence for it. Never fabricate evidence.
The client note is sent to ${project.client.contactName} at ${project.client.name} and must not mention this review.`,
    content: [
      {
        type: "text",
        text: `Project: ${project.name}\nMilestone: ${m.name} (${project.currency} ${m.amount})\nDeliverables: ${m.deliverables.join("; ")}\nAcceptance criteria:\n${m.acceptanceCriteria
          .map((c, i) => `${i + 1}. ${c}`)
          .join("\n")}\n\n<submission>\n${submission}\n</submission>`,
      },
    ],
  });
}

// ---------------------------------------------------------------- payment reminders

const ReminderSchema = z.object({
  tone: z.enum(["friendly", "firm", "final"]),
  subject: z.string(),
  message: z.string().describe("The reminder body, 3-6 sentences, signed with the freelancer's first name"),
  rationale: z.string().describe("One sentence for the freelancer explaining why this tone and timing"),
});
export type ReminderDraft = z.infer<typeof ReminderSchema>;

export async function draftReminder(project: Project, m: Milestone, daysLate: number, blockedPhases: string[]): Promise<ReminderDraft> {
  const count = m.reminders.length;
  const first = project.freelancer.name.split(" ")[0];
  if (!config.hasAnthropicKey) {
    const tone = count === 0 ? "friendly" : count === 1 ? "firm" : "final";
    return {
      tone,
      subject: `Reminder: ${m.name} invoice ${m.invoice?.number ?? ""}`.trim(),
      message: `Hi ${project.client.contactName}, a quick reminder that the invoice for "${m.name}" is ${daysLate} day(s) past due. The next phase (${blockedPhases.join(", ") || "handover"}) starts once it's settled. You can pay securely through PayPal using the invoice link. Thanks, ${first}`,
      rationale: "Template reminder (no AI key configured).",
    };
  }
  return structured({
    schema: ReminderSchema,
    effort: "low",
    system: `You write payment reminders for ${project.freelancer.name}, a freelancer in ${project.freelancer.location || "India"}, to an overseas client.
Goal: get paid while keeping the relationship warm. Escalate tone with each reminder: 1st friendly nudge, 2nd firm and specific
about schedule impact, 3rd+ final notice that work is paused. Never threaten, never guilt-trip, never invent late fees that
are not in the contract. Mention that the client can pay by PayPal (card or PayPal balance) from the invoice.`,
    content: [
      {
        type: "text",
        text: `Client: ${project.client.contactName} (${project.client.name})\nMilestone: ${m.name} - ${project.currency} ${m.amount}\nInvoice: ${m.invoice?.number} due ${m.invoice?.dueDate}\nDays overdue: ${daysLate}\nReminders already sent: ${count}\nPhases blocked until payment: ${blockedPhases.join(", ") || "none (final milestone)"}\nWhat was delivered: ${m.scopeCheck?.summary ?? m.deliverables.join("; ")}`,
      },
    ],
  });
}
