import { useEffect, useMemo, useRef } from "react";
import { BryntumGantt, type BryntumGanttProps } from "@bryntum/gantt-react";
import { StringHelper } from "@bryntum/gantt";
import { api, fmtMoney } from "./api";

const GATE_ICON: Record<string, string> = {
  paid: "fa fa-circle-check",
  awaiting: "fa fa-hourglass-half",
  overdue: "fa fa-triangle-exclamation",
  projected: "fa fa-lock",
};

const GATE_HINT: Record<string, string> = {
  paid: "Client paid through PayPal - the next phase is unlocked.",
  awaiting: "Invoice sent through PayPal. Waiting for the client to pay.",
  overdue: "Late payment. Every phase after this gate slides right until it's paid.",
  projected: "The PayPal invoice goes out when this phase's deliverable passes the scope check.",
};

const fmtDay = (d?: Date) => d?.toLocaleDateString("en-US", { month: "short", day: "numeric" }) ?? "";

export function Timeline({ projectId, version, currency, showBaseline }: { projectId: string; version: number; currency: string; showBaseline: boolean }) {
  const ref = useRef<BryntumGantt>(null);

  const props = useMemo<BryntumGanttProps>(
    () => ({
      readOnly: true,
      rowHeight: 38,
      barMargin: 8,
      viewPreset: "weekAndDayLetter",
      columns: [
        {
          type: "name",
          text: "Phase / task",
          width: 240,
          renderer: ({ record }: any) => {
            const d = record.originalData ?? {};
            if (d.kind === "gate") return { tag: "span", className: `gate-cell gate-${d.gate}`, children: [{ tag: "i", className: GATE_ICON[d.gate] }, { tag: "span", text: " " + record.name }] };
            return record.name;
          },
        },
        {
          text: "Payment",
          width: 90,
          align: "right",
          field: "name",
          renderer: ({ record }: any) => {
            const d = record.originalData ?? {};
            return d.kind === "phase" ? fmtMoney(d.amount, currency) : "";
          },
        },
      ],
      baselinesFeature: true,
      projectLinesFeature: false,
      timeRangesFeature: { showCurrentTimeLine: false, showHeaderElements: true },
      dependenciesFeature: { radius: 6 },
      taskTooltipFeature: {
        template: ({ taskRecord }: any) => {
          const d = taskRecord.originalData ?? {};
          const s = StringHelper.encodeHtml;
          const dates = `${fmtDay(taskRecord.startDate)} → ${fmtDay(taskRecord.endDate)}`;
          if (d.kind === "gate") return `<div class="tt"><b>${s(taskRecord.name)}</b><div>${dates}</div><div class="tt-hint">${GATE_HINT[d.gate]}</div></div>`;
          return `<div class="tt"><b>${s(taskRecord.name)}</b><div>${dates} · ${Math.round(taskRecord.duration)}d</div></div>`;
        },
      },
      taskRenderer: ({ taskRecord }: any) => {
        const d = taskRecord.originalData ?? {};
        if (d.kind === "gate") return { tag: "span", className: "gate-bar-label", children: [{ tag: "i", className: GATE_ICON[d.gate] }, { tag: "span", text: ` ${fmtMoney(d.amount, currency)}` }] };
        return "";
      },
    }),
    [currency],
  );

  useEffect(() => {
    const feature = (ref.current?.instance as any)?.features?.baselines;
    if (feature) feature.disabled = !showBaseline;
  }, [showBaseline]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await api.gantt(projectId);
      const gantt = ref.current?.instance;
      if (!gantt || cancelled) return;
      await gantt.project.loadCrudManagerData(data);
      await gantt.project.commitAsync();
      if (cancelled) return;
      // Fit the actual schedule and the original plan, with a little air on both sides.
      const start = new Date(data.project.startDate + "T00:00:00");
      start.setDate(start.getDate() - 1);
      const end = new Date(Math.max(new Date(gantt.project.endDate ?? 0).getTime(), Date.parse((data.meta.baselineEnd ?? data.project.startDate) + "T00:00:00")));
      end.setDate(end.getDate() + 2);
      gantt.setTimeSpan(start, end);
      await gantt.zoomToFit({ leftMargin: 10, rightMargin: 30 });
    })().catch((e) => console.error("Gantt load failed", e));
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  return <BryntumGantt ref={ref} {...props} />;
}
