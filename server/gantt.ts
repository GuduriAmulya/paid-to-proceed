/**
 * Builds Bryntum Gantt data for a project. Every milestone becomes a phase whose last row is a
 * "payment gate" task; the next phase depends on that gate. Bryntum's scheduling engine then
 * pushes the rest of the project out whenever a payment is late. A baseline (the plan assuming
 * every invoice is paid on time) is attached to each task so the slip is visible.
 */
import { addDays, daysBetween, isoDate, now } from "./store.js";
import type { Milestone, Project } from "./types.js";

export type GateState = "projected" | "awaiting" | "overdue" | "paid";

export function gateState(m: Milestone, today = isoDate(now())): GateState {
  if (m.status === "paid") return "paid";
  if (m.status === "invoiced" && m.invoice) return today > m.invoice.dueDate ? "overdue" : "awaiting";
  return "projected";
}

export function daysOverdue(m: Milestone, today = isoDate(now())): number {
  if (m.status !== "invoiced" || !m.invoice) return 0;
  return Math.max(0, daysBetween(m.invoice.dueDate, today));
}

/** Duration of the payment gate in days (how long the project waits for this tranche). */
function gateDuration(m: Milestone, today: string): number {
  const st = gateState(m, today);
  if (st === "paid" && m.invoice && m.paidAt) return Math.max(1, daysBetween(m.invoice.sentAt, m.paidAt));
  if (st === "overdue" && m.invoice) return Math.max(1, daysBetween(m.invoice.sentAt, today) + 1);
  if (st === "awaiting" && m.invoice) return Math.max(1, daysBetween(m.invoice.sentAt, m.invoice.dueDate));
  return Math.max(1, m.paymentTermsDays);
}

interface Row {
  id: string;
  name: string;
  startDate?: string;
  duration?: number;
  durationUnit?: string;
  constraintType?: string | null;
  constraintDate?: string;
  percentDone?: number;
  eventColor?: string;
  cls?: string;
  expanded?: boolean;
  children?: Row[];
  baselines?: { startDate: string; endDate: string }[];
  // custom fields shown in columns / tooltips
  kind?: "phase" | "work" | "gate";
  amount?: number;
  gate?: GateState;
  milestoneId?: string;
  note?: string;
}

/** Baseline: simple forward pass with every gate taking exactly its payment terms. */
function baseline(project: Project) {
  const map = new Map<string, { start: string; end: string }>();
  let cursor = project.startDate;
  for (const m of project.milestones) {
    const phaseStart = cursor;
    for (const t of m.tasks) {
      const end = addDays(cursor, t.durationDays);
      map.set(t.id, { start: cursor, end });
      cursor = end;
    }
    const gEnd = addDays(cursor, Math.max(1, m.paymentTermsDays));
    map.set(`gate_${m.id}`, { start: cursor, end: gEnd });
    cursor = gEnd;
    map.set(`phase_${m.id}`, { start: phaseStart, end: cursor });
  }
  map.set("project_end", { start: project.startDate, end: cursor });
  return map;
}

export function buildGanttData(project: Project) {
  const today = isoDate(now());
  const base = baseline(project);
  const tasks: Row[] = [];
  const deps: { id: string; fromTask: string; toTask: string }[] = [];
  let prevId: string | null = null;

  project.milestones.forEach((m, i) => {
    const st = gateState(m, today);
    const done = m.status !== "planned";
    const children: Row[] = m.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      duration: t.durationDays,
      durationUnit: "day",
      percentDone: done ? 100 : 0,
      kind: "work",
      milestoneId: m.id,
      eventColor: done ? "teal" : "blue",
      baselines: bl(base.get(t.id)),
    }));
    const gateId = `gate_${m.id}`;
    const gate: Row = {
      id: gateId,
      name: gateLabel(m, st, project.currency),
      duration: gateDuration(m, today),
      durationUnit: "day",
      percentDone: st === "paid" ? 100 : 0,
      kind: "gate",
      gate: st,
      amount: m.amount,
      milestoneId: m.id,
      eventColor: { paid: "green", awaiting: "amber", overdue: "red", projected: "gray" }[st],
      cls: `gate gate-${st}`,
      baselines: bl(base.get(gateId)),
    };
    if (m.invoice && st !== "projected") {
      gate.constraintType = "startnoearlierthan";
      gate.constraintDate = m.invoice.sentAt.slice(0, 10);
    }
    children.push(gate);

    // project start constraint on the very first task
    if (i === 0 && children[0]) {
      children[0].constraintType = "startnoearlierthan";
      children[0].constraintDate = project.startDate;
      children[0].startDate = project.startDate;
    }

    // chain: previous row → each work task → gate
    for (const c of children) {
      if (prevId) deps.push({ id: `d_${prevId}_${c.id}`, fromTask: prevId, toTask: c.id });
      prevId = c.id;
    }

    tasks.push({
      id: `phase_${m.id}`,
      name: `${i + 1}. ${m.name}`,
      kind: "phase",
      amount: m.amount,
      milestoneId: m.id,
      expanded: true,
      children,
      baselines: bl(base.get(`phase_${m.id}`)),
    });
  });

  return {
    success: true,
    project: { calendar: "allday", startDate: project.startDate, hoursPerDay: 24, daysPerWeek: 7, daysPerMonth: 30 },
    calendars: { rows: [{ id: "allday", name: "Every day", unspecifiedTimeIsWorking: true, intervals: [] }] },
    tasks: { rows: tasks },
    dependencies: { rows: deps },
    timeRanges: { rows: [{ id: "today", name: "Today", startDate: today, cls: "tranche-today" }] },
    meta: {
      today,
      baselineEnd: base.get("project_end")?.end,
    },
  };
}

function bl(x?: { start: string; end: string }) {
  return x ? [{ startDate: x.start, endDate: x.end }] : [];
}

function gateLabel(m: Milestone, st: GateState, currency: string): string {
  const amt = `${currency} ${m.amount.toLocaleString("en-US")}`;
  switch (st) {
    case "paid":
      return `Paid ${amt} via PayPal`;
    case "awaiting":
      return `Awaiting ${amt} - invoice ${m.invoice?.number}`;
    case "overdue":
      return `OVERDUE ${amt} - ${daysOverdue(m)}d late`;
    default:
      return `Client pays ${amt}`;
  }
}

/** Projected end date of the whole project (same rules as Bryntum's forward pass). */
export function projectedEnd(project: Project): string {
  const today = isoDate(now());
  let cursor = project.startDate;
  for (const m of project.milestones) {
    for (const t of m.tasks) cursor = addDays(cursor, t.durationDays);
    if (m.invoice && gateState(m, today) !== "projected" && m.invoice.sentAt.slice(0, 10) > cursor) cursor = m.invoice.sentAt.slice(0, 10);
    cursor = addDays(cursor, gateDuration(m, today));
  }
  return cursor;
}

export function baselineEnd(project: Project): string {
  return baseline(project).get("project_end")!.end;
}
