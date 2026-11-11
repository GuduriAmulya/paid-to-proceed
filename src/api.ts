export type Gate = "projected" | "awaiting" | "overdue" | "paid";

export interface Milestone {
  id: string;
  name: string;
  amount: number;
  deliverables: string[];
  acceptanceCriteria: string[];
  tasks: { id: string; name: string; durationDays: number }[];
  paymentTermsDays: number;
  splits: { subcontractorId: string; percent: number }[];
  status: "planned" | "submitted" | "invoiced" | "paid";
  submission?: string;
  scopeCheck?: {
    verdict: "meets" | "partial" | "missing";
    summary: string;
    criteria: { criterion: string; met: boolean; evidence: string }[];
    clientNote: string;
  };
  invoice?: { id: string; number: string; status: string; payerUrl?: string; sentAt: string; dueDate: string };
  paidAt?: string;
  reminders: { sentAt: string; tone: string }[];
  payouts: { batchId: string; subcontractorId: string; amount: number; status: string; at: string }[];
  gate: Gate;
  daysOverdue: number;
}

export interface Action {
  id: string;
  type: "send_invoice" | "send_reminder" | "pay_subcontractor";
  milestoneId: string;
  title: string;
  rationale: string;
  draft: { subject?: string; message?: string; amount?: number; subcontractorId?: string; tone?: string };
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  result?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  freelancer: { name: string; location: string };
  client: { name: string; email: string; contactName: string };
  currency: string;
  summary: string;
  startDate: string;
  milestones: Milestone[];
  subcontractors: { id: string; name: string; role: string; email: string }[];
  actions: Action[];
  activity: { id: string; at: string; kind: "agent" | "paypal" | "user" | "system"; text: string }[];
  metrics: {
    total: number;
    received: number;
    outstanding: number;
    overdue: number;
    paidOut: number;
    baselineEnd: string;
    projectedEnd: string;
    slipDays: number;
  };
}

export interface AppState {
  today: string;
  clockOffsetDays: number;
  paypalConfigured: boolean;
  paypalMissing: string[];
  paypalEnv: string;
  aiConfigured: boolean;
  model: string;
  webhookConfigured: boolean;
  projects: { id: string; name: string; client: string; pending: number }[];
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  state: () => req<AppState>("GET", "/api/state"),
  sample: () => req<{ contract: string; submission: string }>("GET", "/api/sample"),
  project: (id: string) => req<Project>("GET", `/api/projects/${id}`),
  gantt: (id: string) => req<any>("GET", `/api/projects/${id}/gantt`),
  createDemo: () => req<{ id: string }>("POST", "/api/projects/demo"),
  createFromContract: (form: FormData) => req<{ id: string }>("POST", "/api/projects", form),
  deleteProject: (id: string) => req("DELETE", `/api/projects/${id}`),
  submit: (id: string, mid: string, submission: string) => req<Project>("POST", `/api/projects/${id}/milestones/${mid}/submit`, { submission }),
  invoiceAnyway: (id: string, mid: string) => req<Project>("POST", `/api/projects/${id}/milestones/${mid}/invoice-anyway`),
  simulatePayment: (id: string, mid: string) => req<Project>("POST", `/api/projects/${id}/milestones/${mid}/simulate-payment`),
  approve: (id: string, aid: string, draft: Action["draft"]) => req<{ action: Action; project: Project }>("POST", `/api/projects/${id}/actions/${aid}/approve`, { draft }),
  reject: (id: string, aid: string) => req<Project>("POST", `/api/projects/${id}/actions/${aid}/reject`),
  sync: (id: string) => req<Project>("POST", `/api/projects/${id}/sync`),
  clock: (body: { days?: number; reset?: boolean }) => req<{ today: string }>("POST", "/api/clock", body),
  reset: () => req<{ id: string }>("POST", "/api/reset"),
  chat: (projectId: string | null, messages: { role: "user" | "assistant"; content: string }[]) =>
    req<{ reply: string }>("POST", "/api/chat", { projectId, messages }),
};

export function fmtMoney(n: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
}

export function fmtDate(iso?: string) {
  if (!iso) return "-";
  return new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
