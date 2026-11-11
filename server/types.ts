export type MilestoneStatus =
  | "planned" // work not started / in progress
  | "submitted" // freelancer submitted the deliverable, scope check done
  | "invoiced" // PayPal invoice sent, awaiting payment
  | "paid"; // client paid via PayPal

export interface WorkTask {
  id: string;
  name: string;
  durationDays: number;
}

export interface PayoutSplit {
  subcontractorId: string;
  percent: number;
}

export interface Subcontractor {
  id: string;
  name: string;
  role: string;
  email: string;
}

export interface ScopeCheck {
  verdict: "meets" | "partial" | "missing";
  summary: string;
  criteria: { criterion: string; met: boolean; evidence: string }[];
  clientNote: string;
  checkedAt: string;
}

export interface Milestone {
  id: string;
  name: string;
  amount: number;
  deliverables: string[];
  acceptanceCriteria: string[];
  tasks: WorkTask[];
  paymentTermsDays: number;
  splits: PayoutSplit[];
  status: MilestoneStatus;
  submission?: string;
  scopeCheck?: ScopeCheck;
  invoice?: {
    id: string;
    number: string;
    status: string;
    payerUrl?: string;
    sentAt: string;
    dueDate: string;
  };
  paidAt?: string;
  reminders: { sentAt: string; tone: string }[];
  payouts: { batchId: string; subcontractorId: string; amount: number; status: string; at: string }[];
}

export type ActionType = "send_invoice" | "send_reminder" | "pay_subcontractor";

export interface AgentAction {
  id: string;
  type: ActionType;
  milestoneId: string;
  title: string;
  rationale: string;
  // Editable content the human can tweak before approving
  draft: { subject?: string; message?: string; amount?: number; subcontractorId?: string; tone?: string };
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  result?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ActivityEvent {
  id: string;
  at: string;
  kind: "agent" | "paypal" | "user" | "system";
  text: string;
}

export interface Project {
  id: string;
  name: string;
  freelancer: { name: string; location: string };
  client: { name: string; email: string; contactName: string };
  currency: string;
  summary: string;
  startDate: string; // ISO date
  milestones: Milestone[];
  subcontractors: Subcontractor[];
  actions: AgentAction[];
  activity: ActivityEvent[];
  createdAt: string;
}

export interface DB {
  clockOffsetDays: number;
  projects: Project[];
}
