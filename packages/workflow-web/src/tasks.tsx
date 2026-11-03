/**
 * «Meine Arbeit» (Konzept Abschnitt 10): Aufgaben der Person, ihres Teams und – mit Recht – aller, sortiert nach
 * Dringlichkeit, Frist oder Alter, mit Zählern, Frist-Anzeige und Massenaktionen; daneben die Aufgabe mit Formular,
 * Nehmen, Zurücklegen, Weitergeben, Erledigen sowie Genehmigen/Ablehnen mit Begründung.
 *
 * Regeln:
 * - Was erlaubt ist, sagt der Server je Aufgabe (`actions`); die Oberfläche zeigt nur diese Knöpfe. Massenaktionen nur
 *   mit `task:assign` (Provider `can`).
 * - Formulare wie beim manuellen Start (`FieldForm`, Feldarten der App); Pflichtfelder prüft die Oberfläche vorab, der
 *   Server prüft verbindlich und meldet Fehler, die hier stehen.
 * - Bezug, den die Person nicht sehen darf: neutraler Titel vom Server, kein Link.
 * - Texte in Du-Form, Ergebnisse `approved`/`rejected`/`done`/`cancelled` übersetzt, eigene Ergebnisse wie definiert.
 */
import { useId, useState, type ReactNode } from 'react';
import { useBulkTasks, useQueueMembers, useQueues, useTask, useTaskAction, useTaskCounts, useTasks, type TaskAction, type TaskFilter } from './api.ts';
import { FieldForm, missingRequired } from './forms.tsx';
import { actorName, useWorkflow, type WorkflowActor } from './provider.tsx';
import type { ActorRefJson, TaskDetailJson, TaskJson, TaskSort, TaskView } from './types.ts';
import {
  Badge, fmtDateTime, fmtDue, MODE_LABEL, outcomeLabel, PRIORITY_LABEL, priorityTone, SORT_LABEL, TASK_STATE_LABEL, taskTone,
} from './ui.tsx';

const VIEW_LABEL: Record<TaskView, string> = { mine: 'Mir', team: 'Mein Team', all: 'Alle' };
type StateFilter = NonNullable<TaskFilter['state']>;
const STATE_FILTER: [StateFilter, string][] = [['active', 'Offen und in Arbeit'], ['open', 'Offen'], ['in_progress', 'In Arbeit'], ['done', 'Erledigt'], ['cancelled', 'Abgebrochen'], ['any', 'Alle']];

/** Frist als Abzeichen (überfällig, bald fällig, sonst neutral). */
export function DueBadge({ dueAt, done }: { dueAt: string | null; done?: boolean }) {
  if (!dueAt) return <span className="wf-muted wf-small">ohne Frist</span>;
  if (done) return <span className="wf-muted wf-small">{fmtDateTime(dueAt)}</span>;
  const d = fmtDue(dueAt);
  return <span title={fmtDateTime(dueAt)}><Badge tone={d.overdue ? 'bad' : d.soon ? 'warn' : 'muted'}>{d.text}</Badge></span>;
}

/** Bezug einer Aufgabe mit Link bzw. Öffnen aus der App. */
function SubjectLabel({ task }: { task: Pick<TaskJson, 'subject' | 'hidden'> }) {
  const w = useWorkflow();
  const s = task.subject;
  if (!s) return <span className="wf-muted">–</span>;
  if (task.hidden) return <span className="wf-muted">vertraulich</span>;
  const cfg = w.subjects[s.type];
  const text = s.title ?? `${cfg?.label ?? s.type} ${s.id}`;
  if (cfg?.onOpen) return <button type="button" className="wf-link" onClick={() => cfg.onOpen!(s.id)}>{text}</button>;
  if (cfg?.href) return <a className="wf-link" href={cfg.href(s.id)}>{text}</a>;
  return <span>{text}</span>;
}

export interface MyWorkProps {
  /** Reiter zu Beginn (Standard «mir»). */
  filter?: TaskView;
  /** Nur Aufgaben dieser Warteschlange. */
  queueId?: string;
  /** Geöffnete Aufgabe (gesteuert); ohne Angabe verwaltet der Baustein sie selbst. */
  taskId?: string | null;
  onOpenTask?: (id: string | null) => void;
  /** Lauf im Protokoll öffnen. */
  onOpenRun?: (runId: string) => void;
  /** Überschrift (Standard «Meine Arbeit»). */
  title?: string;
}

/** «Meine Arbeit»: Reiter mir/Team/alle mit Zählern, Filter, Sortierung, Liste, Massenaktionen und Aufgabe daneben. */
export function MyWork({ filter = 'mine', queueId, taskId, onOpenTask, onOpenRun, title = 'Meine Arbeit' }: MyWorkProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const [view, setView] = useState<TaskView>(filter);
  const [state, setState] = useState<StateFilter>('active');
  const [sort, setSort] = useState<TaskSort | ''>('');
  const [overdue, setOverdue] = useState(false);
  const [own, setOwn] = useState<string | null>(null);
  const open = taskId !== undefined ? taskId : own;
  const select = (x: string | null) => { if (taskId === undefined) setOwn(x); onOpenTask?.(x); };
  const counts = useTaskCounts({ refetchInterval: false });
  const list = useTasks({ view, state, queueId, overdue: overdue || undefined, sort: sort || undefined });
  const canAssign = w.can('task:assign');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const items = list.data?.items ?? [];
  const tabs: TaskView[] = ['mine', 'team', 'all'];
  const tabCount = (v: TaskView) => (v === 'mine' ? counts.data?.mine : v === 'team' ? counts.data?.team : undefined);
  return (
    <section className="wf-work" aria-labelledby={`${id}-h`}>
      <div className="wf-list-head">
        <h2 id={`${id}-h`}>{title}</h2>
      </div>
      <div className="wf-tabs" role="tablist" aria-label="Ansicht">
        {tabs.map(v => {
          const c = tabCount(v);
          return (
            <button key={v} type="button" role="tab" id={`${id}-t-${v}`} aria-selected={view === v} aria-controls={`${id}-p`} className={`wf-tab${view === v ? ' on' : ''}`}
              onClick={() => { setView(v); setPicked(new Set()); }}>
              {VIEW_LABEL[v]}
              {c ? <span className="wf-count" aria-label={`${c.open} offen${c.overdue ? `, ${c.overdue} überfällig` : ''}`}>{c.open}{c.overdue ? <span className="wf-count-bad">{c.overdue}</span> : null}</span> : null}
            </button>
          );
        })}
      </div>
      <div id={`${id}-p`} role="tabpanel" aria-labelledby={`${id}-t-${view}`}>
        <div className="wf-row wf-filters">
          <div className="wf-field">
            <label htmlFor={`${id}-s`}>Zustand</label>
            <ui.Select id={`${id}-s`} value={state} onChange={e => setState(e.target.value as StateFilter)}>
              {STATE_FILTER.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </ui.Select>
          </div>
          <div className="wf-field">
            <label htmlFor={`${id}-o`}>Sortierung</label>
            <ui.Select id={`${id}-o`} value={sort} onChange={e => setSort(e.target.value as TaskSort | '')}>
              <option value="">Vorgabe</option>
              {(Object.keys(SORT_LABEL) as TaskSort[]).map(s => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
            </ui.Select>
          </div>
          <label className="wf-check-row"><ui.Input type="checkbox" checked={overdue} onChange={e => setOverdue(e.target.checked)} /> nur überfällige</label>
        </div>
        {canAssign && picked.size ? <BulkBar ids={[...picked]} onDone={() => setPicked(new Set())} /> : null}
        <div className={open ? 'wf-work-grid' : undefined}>
          <div>
            {list.isPending ? <ui.Loading label="Aufgaben werden geladen …" /> : list.isError ? <ui.ErrorBox error={list.error} onRetry={() => void list.refetch()} /> : items.length ? (
              <TaskTable items={items} open={open} onOpen={select} picked={canAssign ? picked : null} onPick={setPicked} />
            ) : (
              <ui.Empty title={view === 'mine' ? 'Keine Aufgaben für dich' : 'Keine Aufgaben'}>
                {view === 'mine' ? 'Neue Aufgaben erscheinen hier, sobald ein Workflow sie dir gibt.' : 'Für diese Auswahl gibt es nichts zu tun.'}
              </ui.Empty>
            )}
            {list.data && list.data.total > items.length ? <p className="wf-muted wf-small">{`${items.length} von ${list.data.total} Aufgaben angezeigt.`}</p> : null}
          </div>
          {open ? <TaskDetail taskId={open} onClose={() => select(null)} onOpenRun={onOpenRun} /> : null}
        </div>
      </div>
    </section>
  );
}

function TaskTable({ items, open, onOpen, picked, onPick }: {
  items: TaskJson[]; open: string | null; onOpen: (id: string) => void; picked: Set<string> | null; onPick: (s: Set<string>) => void;
}) {
  const w = useWorkflow();
  const { ui } = w;
  const toggle = (id: string) => { if (!picked) return; const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); onPick(n); };
  return (
    <table className="wf-table wf-tasks">
      <thead>
        <tr>
          {picked ? (
            <th scope="col"><ui.Input type="checkbox" aria-label="Alle auswählen" checked={items.length > 0 && items.every(t => picked.has(t.id))}
              onChange={e => onPick(e.target.checked ? new Set(items.map(t => t.id)) : new Set())} /></th>
          ) : null}
          <th scope="col">Aufgabe</th><th scope="col">Bezug</th><th scope="col">Zuständig</th><th scope="col">Frist</th><th scope="col">Priorität</th>
        </tr>
      </thead>
      <tbody>
        {items.map(t => (
          <tr key={t.id} className={open === t.id ? 'on' : undefined}>
            {picked ? <td><ui.Input type="checkbox" aria-label={`«${t.title}» auswählen`} checked={picked.has(t.id)} onChange={() => toggle(t.id)} /></td> : null}
            <th scope="row">
              <button type="button" className="wf-link" aria-current={open === t.id ? 'true' : undefined} onClick={() => onOpen(t.id)}>{t.title}</button>
              <div className="wf-row wf-small">
                <Badge tone={taskTone(t.state)}>{TASK_STATE_LABEL[t.state]}</Badge>
                {t.kind === 'approval' ? <Badge tone="accent">Genehmigung</Badge> : null}
                {t.queue ? <span className="wf-muted">{t.queue.name ?? 'Warteschlange'}</span> : null}
              </div>
            </th>
            <td><SubjectLabel task={t} /></td>
            <td>{t.assignee ? actorName(w, t.assignee) : <span className="wf-muted">{t.kind === 'approval' ? `${t.candidates.length} Personen` : 'niemand'}</span>}</td>
            <td><DueBadge dueAt={t.dueAt} done={t.state === 'done' || t.state === 'cancelled'} /></td>
            <td>{t.priority === 'normal' ? <span className="wf-muted">{PRIORITY_LABEL.normal}</span> : <Badge tone={priorityTone(t.priority)}>{PRIORITY_LABEL[t.priority]}</Badge>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Massenaktionen für ausgewählte Aufgaben (zuweisen, abbrechen). */
function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { ui } = useWorkflow();
  const bulk = useBulkTasks();
  const [dialog, setDialog] = useState<'assign' | 'cancel' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = (b: Omit<Parameters<typeof bulk.mutate>[0], 'ids'>) => bulk.mutate({ ...b, ids }, {
    onSuccess: r => { setDialog(null); setMsg(r.failed ? `${r.ok} erledigt, ${r.failed} nicht möglich: ${r.results.filter(x => !x.ok).map(x => x.message).join('; ')}` : `${r.ok} Aufgabe(n) bearbeitet.`); onDone(); },
  });
  return (
    <div className="wf-bulk" role="group" aria-label="Massenaktionen">
      <span>{`${ids.length} ausgewählt`}</span>
      <ui.Button size="sm" onClick={() => setDialog('assign')}>Zuweisen …</ui.Button>
      <ui.Button size="sm" onClick={() => setDialog('cancel')}>Abbrechen …</ui.Button>
      <span role="status" className="wf-small">{msg}</span>
      {dialog === 'assign' ? <AssignDialog title={`${ids.length} Aufgabe(n) zuweisen`} allowQueue busy={bulk.isPending} error={bulk.error} onClose={() => setDialog(null)} onAssign={t => run({ action: 'assign', ...t })} /> : null}
      {dialog === 'cancel' ? <CancelDialog title={`${ids.length} Aufgabe(n) abbrechen?`} busy={bulk.isPending} error={bulk.error} onClose={() => setDialog(null)} onCancel={reason => run({ action: 'cancel', reason })} /> : null}
    </div>
  );
}

export interface TaskDetailProps {
  taskId: string;
  onClose?: () => void;
  onOpenRun?: (runId: string) => void;
}

/** Eine Aufgabe: Angaben, Frist, Formular und die erlaubten Aktionen. */
export function TaskDetail({ taskId, onClose, onOpenRun }: TaskDetailProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const task = useTask(taskId);
  const act = useTaskAction(taskId);
  const [msg, setMsg] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'assign' | 'cancel' | null>(null);
  if (task.isPending) return <aside className="wf-task"><ui.Loading label="Aufgabe wird geladen …" /></aside>;
  if (task.isError) return <aside className="wf-task"><ui.ErrorBox error={task.error} onRetry={() => void task.refetch()} /></aside>;
  const t = task.data;
  const a = t.actions;
  const send = (x: TaskAction, done: string) => {
    setMsg(null);
    act.mutate({ ...x, revision: t.revision }, { onSuccess: () => { setDialog(null); setMsg(done); } });
  };
  const active = t.state === 'open' || t.state === 'in_progress';
  return (
    <aside className="wf-task" aria-labelledby={`${id}-h`}>
      <header className="wf-row">
        <h3 id={`${id}-h`} className="wf-grow">{t.title}</h3>
        {onClose ? <ui.Button size="sm" variant="ghost" onClick={onClose} aria-label="Aufgabe schliessen">✕</ui.Button> : null}
      </header>
      <div className="wf-row">
        <Badge tone={taskTone(t.state)}>{TASK_STATE_LABEL[t.state]}</Badge>
        {t.kind === 'approval' && t.mode ? <Badge tone="accent">{`Genehmigung: ${MODE_LABEL[t.mode]}`}</Badge> : null}
        {t.priority !== 'normal' ? <Badge tone={priorityTone(t.priority)}>{PRIORITY_LABEL[t.priority]}</Badge> : null}
        {active ? <DueBadge dueAt={t.dueAt} /> : null}
      </div>
      {t.hidden ? <p className="wf-muted wf-small">Den Bezug dieser Aufgabe darfst du nicht sehen; Titel und Beschreibung sind deshalb ausgeblendet.</p> : null}
      {t.description ? <p className="wf-task-desc">{t.description}</p> : null}
      <dl className="wf-summary">
        <dt>Bezug</dt><dd><SubjectLabel task={t} /></dd>
        {t.queue ? <><dt>Warteschlange</dt><dd>{t.queue.name ?? t.queue.id}</dd></> : null}
        <dt>Zuständig</dt><dd>{t.assignee ? actorName(w, t.assignee) : t.candidates.length ? `eine Person aus: ${t.candidates.map(c => actorName(w, c)).join(', ')}` : 'noch niemand'}</dd>
        <dt>Frist</dt><dd>{t.dueAt ? `${fmtDateTime(t.dueAt)}${t.breachedAt ? ' (überschritten)' : ''}` : 'keine'}</dd>
        <dt>Erstellt</dt><dd>{fmtDateTime(t.createdAt)}</dd>
        {t.outcome ? <><dt>Ergebnis</dt><dd>{outcomeLabel(t.outcome)}{t.reason ? ` – ${t.reason}` : ''}</dd></> : null}
        {t.completedBy ? <><dt>{t.state === 'cancelled' ? 'Abgebrochen von' : 'Erledigt von'}</dt><dd>{`${actorName(w, t.completedBy)}, ${fmtDateTime(t.completedAt)}`}</dd></> : null}
        {t.runId && onOpenRun ? <><dt>Lauf</dt><dd><button type="button" className="wf-link" onClick={() => onOpenRun(t.runId!)}>Im Protokoll öffnen</button></dd></> : null}
      </dl>
      {active && (a.take || a.release || a.assign || a.handOver || a.cancel) ? (
        <div className="wf-row" role="group" aria-label="Aktionen">
          {a.take ? <ui.Button size="sm" variant={t.assignee ? 'default' : 'primary'} disabled={act.isPending} onClick={() => send({ action: 'take' }, 'Du arbeitest jetzt an dieser Aufgabe.')}>{t.assignee && t.state === 'open' && w.me?.id === t.assignee.id ? 'Beginnen' : 'Nehmen'}</ui.Button> : null}
          {a.release ? <ui.Button size="sm" disabled={act.isPending} onClick={() => send({ action: 'release' }, 'Aufgabe zurückgelegt.')}>Zurücklegen</ui.Button> : null}
          {a.assign || a.handOver ? <ui.Button size="sm" disabled={act.isPending} onClick={() => setDialog('assign')}>Weitergeben …</ui.Button> : null}
          {a.cancel ? <ui.Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => setDialog('cancel')}>Abbrechen …</ui.Button> : null}
        </div>
      ) : null}
      {t.kind === 'task' && a.complete ? <CompleteForm task={t} busy={act.isPending} onComplete={(outcome, values) => send({ action: 'complete', outcome, values }, `Erledigt: ${outcomeLabel(outcome)}.`)} /> : null}
      {t.kind === 'approval' ? <Votes task={t} /> : null}
      {t.kind === 'approval' && a.decide ? <DecideForm task={t} busy={act.isPending} onDecide={(decision, reason) => send({ action: 'decide', decision, reason }, decision === 'approved' ? 'Du hast genehmigt.' : 'Du hast abgelehnt.')} /> : null}
      {t.kind === 'approval' && active && t.voted ? <p className="wf-muted wf-small">Du hast schon entschieden; es fehlen noch Stimmen anderer.</p> : null}
      <div role="status" aria-live="polite" className="wf-ok">{msg}</div>
      {act.isError && !dialog ? <ui.ErrorBox error={act.error} /> : null}
      {dialog === 'assign' ? (
        <AssignDialog title="Weitergeben" queueId={t.queue?.id ?? null} candidates={t.candidates} allowQueue={a.assign} allowAny={a.assign} busy={act.isPending} error={act.error}
          onClose={() => { setDialog(null); act.reset(); }} onAssign={x => send({ action: 'assign', ...x }, 'Aufgabe weitergegeben.')} />
      ) : null}
      {dialog === 'cancel' ? (
        <CancelDialog title="Aufgabe abbrechen?" busy={act.isPending} error={act.error} onClose={() => { setDialog(null); act.reset(); }}
          onCancel={reason => send({ action: 'cancel', reason }, 'Aufgabe abgebrochen.')} />
      ) : null}
    </aside>
  );
}

function CompleteForm({ task, busy, onComplete }: { task: TaskDetailJson; busy: boolean; onComplete: (outcome: string, values: Record<string, unknown>) => void }) {
  const { ui } = useWorkflow();
  const [value, setValue] = useState<Record<string, unknown>>({});
  const [tried, setTried] = useState(false);
  const missing = missingRequired(task.form, value);
  const outcomes = task.outcomes.length ? task.outcomes : ['done'];
  const submit = (o: string) => { setTried(true); if (!missing.length) onComplete(o, value); };
  return (
    <form className="wf-section" aria-label="Erledigen" onSubmit={e => { e.preventDefault(); if (outcomes.length === 1) submit(outcomes[0]!); }}>
      {task.form.length ? <FieldForm fields={task.form} value={value} onChange={setValue} disabled={busy} /> : null}
      {tried && missing.length ? <p className="wf-bad" role="alert">Bitte ausfüllen: {missing.map(l => `«${l}»`).join(', ')}.</p> : null}
      <div className="wf-row">
        {outcomes.map((o, i) => (
          <ui.Button key={o} type={outcomes.length === 1 ? 'submit' : 'button'} variant={i === 0 ? 'primary' : 'default'} disabled={busy}
            onClick={outcomes.length === 1 ? undefined : () => submit(o)}>
            {outcomes.length === 1 ? 'Erledigen' : `Erledigen: ${outcomeLabel(o)}`}
          </ui.Button>
        ))}
      </div>
    </form>
  );
}

function Votes({ task }: { task: TaskDetailJson }) {
  const w = useWorkflow();
  if (!task.votes.length) return <p className="wf-muted wf-small">{`Noch keine Stimmen (${task.candidates.length} Personen können entscheiden).`}</p>;
  return (
    <ul className="wf-plain wf-votes" aria-label="Stimmen">
      {task.votes.map((v, i) => (
        <li key={i} className="wf-row">
          <Badge tone={v.decision === 'approved' ? 'ok' : 'bad'}>{outcomeLabel(v.decision)}</Badge>
          <span>{actorName(w, v.actor)}</span>
          <span className="wf-muted wf-small">{fmtDateTime(v.at)}</span>
          {v.reason ? <span className="wf-small">{`«${v.reason}»`}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function DecideForm({ task, busy, onDecide }: { task: TaskDetailJson; busy: boolean; onDecide: (d: 'approved' | 'rejected', reason: string | null) => void }) {
  const { ui } = useWorkflow();
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const decide = (d: 'approved' | 'rejected') => {
    if (d === 'rejected' && task.reasonRequired && !reason.trim()) { setError('Bitte begründe die Ablehnung.'); return; }
    setError(null);
    onDecide(d, reason.trim() || null);
  };
  return (
    <div className="wf-section" role="group" aria-label="Entscheiden">
      <div className="wf-field">
        <label htmlFor={id}>{`Begründung${task.reasonRequired ? ' (Pflicht bei Ablehnung)' : ' (optional)'}`}</label>
        <ui.Textarea id={id} rows={3} value={reason} aria-invalid={!!error} aria-describedby={error ? `${id}-e` : undefined} onChange={e => setReason(e.target.value)} />
        {error ? <div id={`${id}-e`} className="wf-field-error" role="alert">{error}</div> : null}
      </div>
      <div className="wf-row">
        <ui.Button variant="primary" disabled={busy} onClick={() => decide('approved')}>Genehmigen</ui.Button>
        <ui.Button variant="danger" disabled={busy} onClick={() => decide('rejected')}>Ablehnen</ui.Button>
      </div>
    </div>
  );
}

/** Weitergeben an eine Person (Mitglieder, Kandidaten oder – mit Recht – frei bzw. über die Suche der App) oder eine Warteschlange. */
function AssignDialog({ title, queueId = null, candidates = [], allowQueue = false, allowAny = true, busy, error, onClose, onAssign }: {
  title: string; queueId?: string | null; candidates?: ActorRefJson[]; allowQueue?: boolean; allowAny?: boolean; busy: boolean; error: Error | null;
  onClose: () => void; onAssign: (to: { assignee?: ActorRefJson | null; queueId?: string | null }) => void;
}) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const members = useQueueMembers(queueId);
  const queues = useQueues(allowQueue);
  const [person, setPerson] = useState('');
  const [free, setFree] = useState('');
  const [queue, setQueue] = useState('');
  const [hits, setHits] = useState<WorkflowActor[]>([]);
  const options: ActorRefJson[] = [...(members.data?.items ?? []).map(m => ({ id: m.id, kind: m.kind })), ...candidates, ...hits]
    .filter((a, i, all) => all.findIndex(b => b.id === a.id && b.kind === a.kind) === i);
  const load = new Map((members.data?.items ?? []).map(m => [`${m.kind}:${m.id}`, m.open]));
  const chosen: ActorRefJson | null = person ? options.find(o => `${o.kind}:${o.id}` === person) ?? null : free.trim() ? { id: free.trim(), kind: 'person' } : null;
  const submit = () => {
    if (!chosen && !queue) return;
    onAssign({ ...(chosen ? { assignee: chosen } : {}), ...(queue ? { queueId: queue } : {}) });
  };
  return (
    <ui.Dialog title={title} onClose={onClose}
      footer={<><ui.Button onClick={onClose}>Zurück</ui.Button><ui.Button variant="primary" disabled={busy || (!chosen && !queue)} onClick={submit}>{busy ? 'Wird weitergegeben …' : 'Weitergeben'}</ui.Button></>}>
      <div className="wf-field">
        <label htmlFor={`${id}-p`}>Person</label>
        <ui.Select id={`${id}-p`} value={person} onChange={e => { setPerson(e.target.value); setFree(''); }}>
          <option value="">– wählen –</option>
          {options.map(o => <option key={`${o.kind}:${o.id}`} value={`${o.kind}:${o.id}`}>{`${actorName(w, o)}${load.has(`${o.kind}:${o.id}`) ? ` (${load.get(`${o.kind}:${o.id}`)} offen)` : ''}`}</option>)}
        </ui.Select>
      </div>
      {allowAny ? (
        <div className="wf-field">
          <label htmlFor={`${id}-f`}>{w.actors.search ? 'Andere Person suchen' : 'Andere Person (ID)'}</label>
          <ui.Input id={`${id}-f`} value={free} onChange={e => {
            setFree(e.target.value); setPerson('');
            if (w.actors.search && e.target.value.trim().length >= 2) void w.actors.search(e.target.value.trim()).then(setHits).catch(() => setHits([]));
          }} />
          {w.actors.search && hits.length ? <div className="wf-hint">Treffer stehen oben in der Liste.</div> : null}
        </div>
      ) : null}
      {allowQueue ? (
        <div className="wf-field">
          <label htmlFor={`${id}-q`}>Warteschlange</label>
          <ui.Select id={`${id}-q`} value={queue} onChange={e => setQueue(e.target.value)}>
            <option value="">– unverändert –</option>
            {(queues.data?.items ?? []).map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
          </ui.Select>
          <div className="wf-hint">Ohne Person verteilt die Warteschlange nach ihrer Regel.</div>
        </div>
      ) : null}
      {error ? <ui.ErrorBox error={error} /> : null}
    </ui.Dialog>
  );
}

function CancelDialog({ title, busy, error, onClose, onCancel }: { title: string; busy: boolean; error: Error | null; onClose: () => void; onCancel: (reason: string | null) => void }) {
  const { ui } = useWorkflow();
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <ui.Dialog title={title} role="alertdialog" onClose={onClose}
      footer={<><ui.Button data-autofocus onClick={onClose}>Zurück</ui.Button><ui.Button variant="danger" disabled={busy} onClick={() => onCancel(reason.trim() || null)}>Abbrechen</ui.Button></>}>
      <p>Der Workflow geht mit dem Ergebnis «Abgebrochen» weiter.</p>
      <div className="wf-field">
        <label htmlFor={id}>Grund (optional)</label>
        <ui.Textarea id={id} rows={2} value={reason} onChange={e => setReason(e.target.value)} />
      </div>
      {error ? <ui.ErrorBox error={error} /> : null}
    </ui.Dialog>
  );
}

/** Offene Aufgaben zu einem Bezug (für `SubjectWorkflowBar`). */
export function SubjectTasks({ subject, onOpenTask }: { subject: { type: string; id: string }; onOpenTask?: (id: string) => void }): ReactNode {
  const w = useWorkflow();
  const tasks = useTasks({ view: 'all', state: 'active', subjectType: subject.type, subjectId: subject.id, limit: 20 });
  const items = tasks.data?.items ?? [];
  if (tasks.isPending) return <w.ui.Loading label="Aufgaben werden geladen …" />;
  if (tasks.isError) return <w.ui.ErrorBox error={tasks.error} />;
  if (!items.length) return <p className="wf-muted wf-small">Keine offenen Aufgaben.</p>;
  return (
    <ul className="wf-plain" aria-label="Offene Aufgaben">
      {items.map(t => (
        <li key={t.id} className="wf-row">
          <Badge tone={taskTone(t.state)}>{TASK_STATE_LABEL[t.state]}</Badge>
          {onOpenTask ? <button type="button" className="wf-link" onClick={() => onOpenTask(t.id)}>{t.title}</button> : <span>{t.title}</span>}
          <span className="wf-muted wf-small">{t.assignee ? actorName(w, t.assignee) : t.queue?.name ?? ''}</span>
          <DueBadge dueAt={t.dueAt} />
        </li>
      ))}
    </ul>
  );
}
