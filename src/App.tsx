import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDate, fmtMoney, type Action, type AppState, type Milestone, type Project } from "./api";
import { Timeline } from "./Timeline";

const GATE_LABEL: Record<Milestone["gate"], string> = { projected: "Locked", awaiting: "Awaiting payment", overdue: "Overdue", paid: "Paid" };

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [ganttVersion, setGanttVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [submitFor, setSubmitFor] = useState<Milestone | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showBaseline, setShowBaseline] = useState(true);
  const signature = useRef("");

  const notify = (kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 5000);
  };

  const applyProject = useCallback((p: Project, today = "") => {
    setProject(p);
    const sig = `${p.id}|${today}|${p.milestones.map((m) => `${m.status}:${m.gate}:${m.daysOverdue}`).join(",")}`;
    if (sig !== signature.current) {
      signature.current = sig;
      setGanttVersion((v) => v + 1);
    }
  }, []);

  const refresh = useCallback(async () => {
    const s = await api.state();
    setState(s);
    const id = projectId && s.projects.some((p) => p.id === projectId) ? projectId : s.projects[0]?.id ?? null;
    if (id !== projectId) setProjectId(id);
    if (id) applyProject(await api.project(id), s.today);
    else setProject(null);
  }, [projectId, applyProject]);

  useEffect(() => {
    refresh().catch((e) => notify("err", e.message));
    const t = window.setInterval(() => refresh().catch(() => {}), 8000);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function run<T>(label: string, fn: () => Promise<T>, ok?: string) {
    setBusy(label);
    try {
      const r = await fn();
      if (ok) notify("ok", ok);
      await refresh();
      return r;
    } catch (e) {
      notify("err", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const pending = project?.actions.filter((a) => a.status === "pending") ?? [];
  const resolved = project?.actions.filter((a) => a.status !== "pending").slice(0, 6) ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>
            <span />
            <span />
            <span />
          </div>
          <div>
            <div className="brand-name">Paid to Proceed</div>
            <div className="brand-tag">Work gets done. Money gets paid. In that order.</div>
          </div>
        </div>

        <div className="topbar-mid">
          {state && state.projects.length > 0 && (
            <select className="select" value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.client}
                </option>
              ))}
            </select>
          )}
          <button className="btn ghost-light" onClick={() => setShowNew(true)}>
            <i className="fa fa-file-contract" /> New from contract
          </button>
        </div>

        <div className="clock" title="Demo clock: fast-forward time to see overdue handling">
          <i className="fa fa-calendar-day" />
          <div>
            <div className="clock-label">Demo clock{state && state.clockOffsetDays ? ` (+${state.clockOffsetDays}d)` : ""}</div>
            <div className="clock-date">{state ? fmtDate(state.today) : "…"}</div>
          </div>
          {[1, 3, 7].map((d) => (
            <button key={d} className="chip-btn" disabled={!!busy} onClick={() => run("clock", () => api.clock({ days: d }))}>
              +{d}d
            </button>
          ))}
          <button className="chip-btn" disabled={!!busy || !state?.clockOffsetDays} onClick={() => run("clock", () => api.clock({ reset: true }))} title="Reset clock">
            <i className="fa fa-rotate-left" />
          </button>
        </div>
      </header>

      {state && (!state.paypalConfigured || !state.aiConfigured || state.paypalMissing.length > 0 || state.paypalAuthError) && (
        <div className="setup-banner">
          <i className="fa fa-plug-circle-exclamation" />
          {!state.paypalConfigured && <span>PayPal sandbox keys missing - set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.</span>}
          {state.paypalAuthError && (
            <span>
              PayPal rejected the server's sandbox keys ({state.paypalAuthError}). Check that PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are the sandbox Client ID and Secret of the same app.
            </span>
          )}
          {state.paypalMissing.length > 0 && (
            <span>
              Your PayPal sandbox app is missing: <b>{state.paypalMissing.join(", ")}</b>. Enable them under Apps &amp; Credentials → your app → Features.
            </span>
          )}
          {!state.aiConfigured && <span>Claude not configured - set ANTHROPIC_API_KEY (template messages will be used).</span>}
        </div>
      )}

      {!project ? (
        <div className="empty">
          <h2>No projects yet</h2>
          <p>Upload a contract and Paid to Proceed turns it into a payment-gated timeline.</p>
          <div className="row">
            <button className="btn primary" onClick={() => setShowNew(true)}>
              New from contract
            </button>
            <button className="btn" onClick={() => run("demo", () => api.createDemo())}>
              Load demo project
            </button>
          </div>
        </div>
      ) : (
        <main className="layout">
          <section className="main-col">
            <div className="project-head">
              <div>
                <h1>{project.name}</h1>
                <p className="muted">
                  {project.freelancer.name}
                  {project.freelancer.location ? ` · ${project.freelancer.location}` : ""} → {project.client.name} ({project.client.contactName}) · {project.summary}
                </p>
              </div>
              <div className="pill-row">
                <span className={`pill ${state?.paypalConfigured ? "ok" : "warn"}`}>
                  <i className="fa fa-p" /> PayPal {state?.paypalEnv === "PRODUCTION" ? "Live" : "Sandbox"}
                </span>
                <span className={`pill ${state?.aiConfigured ? "ok" : "warn"}`}>
                  <i className="fa fa-wand-magic-sparkles" /> Claude {state?.aiConfigured ? "" : "off"}
                </span>
              </div>
            </div>

            <Kpis p={project} />

            <div className="card gantt-card">
              <div className="card-head">
                <div>
                  <h3>Payment-gated timeline</h3>
                  <span className="muted small">Each phase ends in a PayPal payment gate. Late payments push everything after them. Grey ghost bars show the original plan.</span>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} /> Original plan
                </label>
              </div>
              <div className="gantt-wrap">
                <Timeline projectId={project.id} version={ganttVersion} currency={project.currency} showBaseline={showBaseline} />
              </div>
            </div>

            <div className="milestones">
              {project.milestones.map((m, i) => (
                <MilestoneCard
                  key={m.id}
                  p={project}
                  m={m}
                  index={i}
                  locked={i > 0 && project.milestones[i - 1].status !== "paid"}
                  busy={busy}
                  onSubmit={() => setSubmitFor(m)}
                  onInvoiceAnyway={() => run("anyway", () => api.invoiceAnyway(project.id, m.id), "Invoice queued for approval")}
                  onSimulate={() => run(`sim-${m.id}`, () => api.simulatePayment(project.id, m.id), "Payment recorded in PayPal")}
                  onSync={() => run(`sync`, () => api.sync(project.id), "Synced with PayPal")}
                />
              ))}
            </div>
          </section>

          <aside className="side-col">
            <div className="card">
              <div className="card-head">
                <h3>
                  <i className="fa fa-inbox" /> Agent inbox {pending.length > 0 && <span className="count">{pending.length}</span>}
                </h3>
              </div>
              <p className="muted small">Paid to Proceed never moves money on its own. Review, edit, approve.</p>
              {pending.length === 0 && <div className="inbox-empty">Nothing needs you right now.</div>}
              {pending.map((a) => (
                <ActionCard
                  key={a.id}
                  a={a}
                  p={project}
                  busy={busy === a.id}
                  onApprove={(draft) =>
                    run(a.id, async () => {
                      const r = await api.approve(project.id, a.id, draft);
                      if (r.action.status === "failed") throw new Error(r.action.result ?? "Action failed");
                      return r;
                    }, "Done - executed on PayPal")
                  }
                  onReject={() => run(a.id, () => api.reject(project.id, a.id))}
                />
              ))}
              {resolved.length > 0 && (
                <div className="resolved">
                  {resolved.map((a) => (
                    <div key={a.id} className={`resolved-row ${a.status}`}>
                      <i className={`fa ${a.status === "executed" ? "fa-check" : a.status === "failed" ? "fa-xmark" : "fa-ban"}`} />
                      <span>{a.title}</span>
                      {a.status === "failed" && <em>{a.result}</em>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card activity">
              <div className="card-head">
                <h3>
                  <i className="fa fa-wave-square" /> Activity
                </h3>
              </div>
              <ul>
                {project.activity.slice(0, 40).map((e) => (
                  <li key={e.id} className={`ev ev-${e.kind}`}>
                    <span className="ev-dot" />
                    <div>
                      <div>{e.text}</div>
                      <time>
                        {fmtDate(e.at)} · {e.kind === "paypal" ? "PayPal" : e.kind === "agent" ? "Agent" : e.kind === "user" ? "You" : "System"}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <button className="btn link small" onClick={() => confirm("Reset the demo? This deletes all projects and resets the clock.") && run("reset", () => api.reset())}>
              Reset demo data
            </button>
          </aside>
        </main>
      )}

      <button className="chat-fab" onClick={() => setShowChat(true)}>
        <i className="fa fa-comments" /> Ask your agent
      </button>

      {submitFor && project && (
        <SubmitModal
          m={submitFor}
          busy={busy === "submit"}
          onClose={() => setSubmitFor(null)}
          onSubmit={async (text) => {
            const r = await run("submit", () => api.submit(project.id, submitFor.id, text));
            if (r) {
              const m = r.milestones.find((x) => x.id === submitFor.id);
              setSubmitFor(null);
              notify(m?.scopeCheck?.verdict === "meets" ? "ok" : "err", m?.scopeCheck?.summary ?? "Checked");
            }
          }}
        />
      )}
      {showNew && (
        <NewProjectModal
          busy={busy === "new"}
          onClose={() => setShowNew(false)}
          onDemo={async () => {
            const r = await run("new", () => api.createDemo());
            if (r) {
              setProjectId(r.id);
              setShowNew(false);
            }
          }}
          onCreate={async (form) => {
            const r = await run("new", () => api.createFromContract(form), "Contract converted into a payment-gated plan");
            if (r) {
              setProjectId(r.id);
              setShowNew(false);
            }
          }}
        />
      )}
      <ChatDrawer open={showChat} projectId={projectId} onClose={() => setShowChat(false)} onChange={() => refresh()} />
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

function Kpis({ p }: { p: Project }) {
  const c = p.currency;
  const pct = p.metrics.total ? Math.round((p.metrics.received / p.metrics.total) * 100) : 0;
  return (
    <div className="kpis">
      <div className="kpi">
        <span>Contract value</span>
        <b>{fmtMoney(p.metrics.total, c)}</b>
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="kpi good">
        <span>Received via PayPal</span>
        <b>{fmtMoney(p.metrics.received, c)}</b>
        <small>{pct}% collected</small>
      </div>
      <div className="kpi">
        <span>Awaiting</span>
        <b>{fmtMoney(p.metrics.outstanding, c)}</b>
        <small>{p.metrics.overdue > 0 ? <em className="bad-text">{fmtMoney(p.metrics.overdue, c)} overdue</em> : "nothing overdue"}</small>
      </div>
      <div className="kpi">
        <span>Paid to your team</span>
        <b>{fmtMoney(p.metrics.paidOut, c)}</b>
        <small>{p.subcontractors.length} collaborator{p.subcontractors.length === 1 ? "" : "s"}</small>
      </div>
      <div className={`kpi ${p.metrics.slipDays > 0 ? "bad" : ""}`}>
        <span>Delivery date</span>
        <b>{fmtDate(p.metrics.projectedEnd)}</b>
        <small>{p.metrics.slipDays > 0 ? `${p.metrics.slipDays}d later than planned (${fmtDate(p.metrics.baselineEnd)})` : "on plan"}</small>
      </div>
    </div>
  );
}

function MilestoneCard(props: {
  p: Project;
  m: Milestone;
  index: number;
  locked: boolean;
  busy: string | null;
  onSubmit: () => void;
  onInvoiceAnyway: () => void;
  onSimulate: () => void;
  onSync: () => void;
}) {
  const { p, m, index, locked } = props;
  const pendingInvoice = p.actions.some((a) => a.milestoneId === m.id && a.type === "send_invoice" && a.status === "pending");
  return (
    <div className={`card ms ms-${m.gate}`}>
      <div className="ms-top">
        <span className="ms-index">Phase {index + 1}</span>
        <span className={`gate-chip gate-${m.gate}${m.gate === "projected" && !locked ? " current" : ""}`}>
          {m.gate === "projected" ? (locked ? "Locked" : m.status === "submitted" ? "Ready to invoice" : "In progress") : GATE_LABEL[m.gate]}
          {m.gate === "overdue" ? ` · ${m.daysOverdue}d` : ""}
        </span>
      </div>
      <h4>{m.name}</h4>
      <div className="ms-amount">{fmtMoney(m.amount, p.currency)}</div>
      <ul className="criteria">
        {(m.scopeCheck?.criteria ?? m.acceptanceCriteria.map((c) => ({ criterion: c, met: false, evidence: "" }))).map((c, i) => (
          <li key={i} className={m.scopeCheck ? (c.met ? "met" : "unmet") : ""} title={c.evidence}>
            <i className={`fa ${m.scopeCheck ? (c.met ? "fa-circle-check" : "fa-circle-xmark") : "fa-circle"}`} /> {c.criterion}
          </li>
        ))}
      </ul>
      {m.scopeCheck && <p className={`scope-summary ${m.scopeCheck.verdict}`}>{m.scopeCheck.summary}</p>}
      {m.invoice && (
        <div className="invoice-line">
          <i className="fa fa-file-invoice-dollar" /> Invoice <b>{m.invoice.number}</b> · due {fmtDate(m.invoice.dueDate)}
          {m.reminders.length > 0 && <span className="muted"> · {m.reminders.length} reminder{m.reminders.length > 1 ? "s" : ""}</span>}
        </div>
      )}
      {m.payouts.length > 0 && (
        <div className="invoice-line">
          <i className="fa fa-people-arrows" /> Paid out {fmtMoney(m.payouts.reduce((s, x) => s + x.amount, 0), p.currency)} ({m.payouts.map((x) => x.status).join(", ")})
        </div>
      )}
      <div className="ms-actions">
        {(m.status === "planned" || m.status === "submitted") && (
          <>
            <button className="btn primary sm" disabled={locked || !!props.busy} onClick={props.onSubmit} title={locked ? "Unlocks when the previous phase is paid" : ""}>
              {locked ? (
                <>
                  <i className="fa fa-lock" /> Locked until paid
                </>
              ) : m.status === "submitted" ? (
                "Resubmit deliverable"
              ) : (
                "Submit deliverable"
              )}
            </button>
            {m.status === "submitted" && m.scopeCheck?.verdict !== "meets" && !pendingInvoice && (
              <button className="btn sm" disabled={!!props.busy} onClick={props.onInvoiceAnyway}>
                Invoice anyway
              </button>
            )}
            {pendingInvoice && <span className="muted small">Invoice waiting in inbox →</span>}
          </>
        )}
        {m.status === "invoiced" && (
          <>
            {m.invoice?.payerUrl && (
              <a className="btn sm" href={m.invoice.payerUrl} target="_blank" rel="noreferrer">
                <i className="fa fa-arrow-up-right-from-square" /> Pay as client
              </a>
            )}
            <button className="btn sm" disabled={!!props.busy} onClick={props.onSync} title="Check PayPal for payment now">
              <i className="fa fa-arrows-rotate" />
            </button>
            <button className="btn sm ghost" disabled={!!props.busy} onClick={props.onSimulate} title="Records a payment on the PayPal invoice (sandbox demo shortcut)">
              {props.busy === `sim-${m.id}` ? "Recording…" : "Simulate payment"}
            </button>
          </>
        )}
        {m.status === "paid" && (
          <span className="paid-line">
            <i className="fa fa-circle-check" /> Paid {fmtDate(m.paidAt)}
          </span>
        )}
      </div>
    </div>
  );
}

function ActionCard({ a, p, busy, onApprove, onReject }: { a: Action; p: Project; busy: boolean; onApprove: (d: Action["draft"]) => void; onReject: () => void }) {
  const [subject, setSubject] = useState(a.draft.subject ?? "");
  const [message, setMessage] = useState(a.draft.message ?? "");
  const [amount, setAmount] = useState(a.draft.amount ?? 0);
  const icon = { send_invoice: "fa-file-invoice-dollar", send_reminder: "fa-bell", pay_subcontractor: "fa-hand-holding-dollar" }[a.type];
  const verb = { send_invoice: "Approve & send invoice", send_reminder: "Approve & send reminder", pay_subcontractor: "Approve payout" }[a.type];
  return (
    <div className={`action action-${a.type}`}>
      <div className="action-title">
        <i className={`fa ${icon}`} /> {a.title}
      </div>
      <p className="action-why">
        <i className="fa fa-wand-magic-sparkles" /> {a.rationale}
      </p>
      {a.result && <p className="action-error">{a.result}</p>}
      {a.type !== "pay_subcontractor" && (
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
      )}
      {(a.type === "send_invoice" || a.type === "pay_subcontractor") && (
        <label className="amount">
          {p.currency}
          <input type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </label>
      )}
      <textarea className="input" rows={a.type === "send_reminder" ? 6 : 4} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Message" />
      <div className="row">
        <button className="btn primary sm" disabled={busy} onClick={() => onApprove({ subject, message, amount })}>
          {busy ? "Working on PayPal…" : verb}
        </button>
        <button className="btn sm ghost" disabled={busy} onClick={onReject}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function SubmitModal({ m, busy, onClose, onSubmit }: { m: Milestone; busy: boolean; onClose: () => void; onSubmit: (t: string) => void }) {
  const [text, setText] = useState(m.submission ?? "");
  return (
    <Modal title={`Submit "${m.name}"`} onClose={onClose}>
      <p className="muted">Tell Paid to Proceed what you delivered - links, files, what the client approved. Claude checks it against the contract before anything is invoiced.</p>
      <div className="criteria-box">
        {m.acceptanceCriteria.map((c, i) => (
          <div key={i}>
            <i className="fa fa-list-check" /> {c}
          </div>
        ))}
      </div>
      <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Figma link, staging URL, what changed after feedback…" />
      <div className="row between">
        <button className="btn link" onClick={async () => setText((await api.sample()).submission)}>
          Use sample submission
        </button>
        <button className="btn primary" disabled={busy || text.trim().length < 10} onClick={() => onSubmit(text)}>
          {busy ? (
            <>
              <i className="fa fa-spinner fa-spin" /> Checking scope with Claude…
            </>
          ) : (
            "Run scope check"
          )}
        </button>
      </div>
    </Modal>
  );
}

function NewProjectModal({ busy, onClose, onCreate, onDemo }: { busy: boolean; onClose: () => void; onCreate: (f: FormData) => void; onDemo: () => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  return (
    <Modal title="New project from a contract" onClose={onClose}>
      <p className="muted">Drop in a contract or proposal. Claude extracts milestones, amounts, acceptance criteria and subcontractor splits, and builds the payment-gated timeline.</p>
      <label className={`drop ${file ? "has" : ""}`}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <i className="fa fa-file-pdf" /> {file ? file.name : "Choose a PDF contract"}
      </label>
      <div className="or">or paste text</div>
      <textarea className="input mono" rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the contract / proposal / SOW here" />
      <div className="row between">
        <div className="row">
          <button className="btn link" onClick={async () => setText((await api.sample()).contract)}>
            Use sample contract
          </button>
          <button className="btn link" disabled={busy} onClick={onDemo}>
            Instant demo project
          </button>
        </div>
        <button
          className="btn primary"
          disabled={busy || (!file && text.trim().length < 40)}
          onClick={() => {
            const f = new FormData();
            if (file) f.append("file", file);
            if (text.trim()) f.append("text", text);
            onCreate(f);
          }}
        >
          {busy ? (
            <>
              <i className="fa fa-spinner fa-spin" /> Reading contract…
            </>
          ) : (
            "Build payment plan"
          )}
        </button>
      </div>
    </Modal>
  );
}

function ChatDrawer({ open, projectId, onClose, onChange }: { open: boolean; projectId: string | null; onClose: () => void; onChange: () => void }) {
  const [msgs, setMsgs] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);
  const suggestions = ["Who owes me money right now?", "Check PayPal: has the latest invoice been paid?", "Draft a firm reminder for anything overdue"];
  async function send(text: string) {
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const { reply } = await api.chat(projectId, next);
      setMsgs([...next, { role: "assistant", content: reply }]);
      onChange();
    } catch (e) {
      setMsgs([...next, { role: "assistant", content: `⚠️ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`drawer${open ? "" : " closed"}`} aria-hidden={!open}>
      <div className="drawer-head">
        <div>
          <b>Ask your agent</b>
          <div className="muted small">Claude + PayPal Agent Toolkit (read-only). Money moves only via your inbox.</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <i className="fa fa-xmark" />
        </button>
      </div>
      <div className="drawer-body">
        {msgs.length === 0 && (
          <div className="suggestions">
            {suggestions.map((s) => (
              <button key={s} className="chip-btn wide" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === "assistant" ? <Markdown text={m.content} /> : m.content}
          </div>
        ))}
        {busy && (
          <div className="bubble assistant typing">
            <i className="fa fa-spinner fa-spin" /> Checking projects and PayPal…
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="drawer-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim() && !busy) send(input.trim());
        }}
      >
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about payments, invoices, delays…" />
        <button className="btn primary" disabled={busy || !input.trim()}>
          <i className="fa fa-paper-plane" />
        </button>
      </form>
    </div>
  );
}

/** Minimal, safe markdown for chat replies: **bold**, `code`, headings and bullet lists (no HTML injection). */
function Markdown({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part,
    );
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((li, i) => <li key={i}>{inline(li)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(h ? <p key={blocks.length} className="md-h">{inline(h[1])}</p> : <p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="md">{blocks}</div>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <i className="fa fa-xmark" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
