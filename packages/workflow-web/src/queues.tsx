/**
 * Warteschlangen (Konzept Abschnitt 10): Liste mit Zählern, Ansicht einer Warteschlange (Aufgaben wie «Meine Arbeit»,
 * Kennzahlen oben) und Editor (Name, Team, Sortierung, Zuweisungsregel, Kalender, Frist, Eskalation).
 *
 * Regeln: Ändern nur mit `queue:manage`; Speichern mit optimistischer Sperre (`revision`), Konflikt als Hinweis.
 */
import { useId, useState } from 'react';
import { useCalendars, useDeleteQueue, useQueue, useQueues, useSaveQueue } from './api.ts';
import { TeamInput } from './assignee.tsx';
import { useWorkflow } from './provider.tsx';
import { DurationInput, describeDuration } from './steps.tsx';
import { MyWork } from './tasks.tsx';
import type { QueueAssignment, QueueBody, QueueJson, TaskSort } from './types.ts';
import { ASSIGNMENT_LABEL, Badge, MissingRight, SORT_LABEL, WorkflowApiError } from './ui.tsx';

export interface QueueListProps {
  /** Warteschlange öffnen (Aufgaben). */
  onOpen?: (id: string) => void;
  /** Warteschlange bearbeiten (`null` = neu); ohne Angabe kein Knopf. */
  onEdit?: (id: string | null) => void;
}

export function QueueList({ onOpen, onEdit }: QueueListProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const queues = useQueues();
  const manage = w.can('queue:manage');
  const items = queues.data?.items ?? [];
  return (
    <section aria-labelledby={`${id}-h`}>
      <div className="wf-list-head">
        <h2 id={`${id}-h`}>Warteschlangen</h2>
        {manage && onEdit ? <ui.Button variant="primary" onClick={() => onEdit(null)}>Neue Warteschlange</ui.Button> : null}
      </div>
      {queues.isPending ? <ui.Loading label="Warteschlangen werden geladen …" /> : queues.isError ? <ui.ErrorBox error={queues.error} onRetry={() => void queues.refetch()} /> : items.length ? (
        <table className="wf-table">
          <thead><tr><th scope="col">Name</th><th scope="col">Zuweisung</th><th scope="col">Offen</th><th scope="col">Überfällig</th><th scope="col">Ohne Person</th>{manage && onEdit ? <th scope="col"><span className="wf-sr">Bearbeiten</span></th> : null}</tr></thead>
          <tbody>
            {items.map(q => (
              <tr key={q.id}>
                <th scope="row">
                  {onOpen ? <button type="button" className="wf-link" onClick={() => onOpen(q.id)}>{q.name}</button> : q.name}
                  {q.member ? <> <Badge tone="accent">Mitglied</Badge></> : null}
                </th>
                <td>{ASSIGNMENT_LABEL[q.assignment]}</td>
                <td>{q.counts?.open ?? 0}</td>
                <td>{q.counts?.overdue ? <Badge tone="bad">{q.counts.overdue}</Badge> : 0}</td>
                <td>{q.counts?.unassigned ?? 0}</td>
                {manage && onEdit ? <td><ui.Button size="sm" onClick={() => onEdit(q.id)} aria-label={`«${q.name}» bearbeiten`}>Bearbeiten</ui.Button></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : <ui.Empty title="Keine Warteschlangen">{manage ? 'Lege eine an, um Aufgaben an ein Team zu geben.' : 'Du gehörst zu keiner Warteschlange.'}</ui.Empty>}
    </section>
  );
}

export interface QueueViewProps {
  queueId: string;
  onOpenRun?: (runId: string) => void;
}

/** Eine Warteschlange: Kennzahlen und ihre Aufgaben (Sortierung der Warteschlange, Massenaktionen mit Recht). */
export function QueueView({ queueId, onOpenRun }: QueueViewProps) {
  const { ui } = useWorkflow();
  const q = useQueue(queueId);
  if (q.isPending) return <ui.Loading label="Warteschlange wird geladen …" />;
  if (q.isError) return <ui.ErrorBox error={q.error} />;
  const c = q.data.counts ?? { open: 0, overdue: 0, unassigned: 0 };
  return (
    <div className="wf-queue-view">
      <dl className="wf-kpis" aria-label="Kennzahlen">
        <div><dt>Offen</dt><dd>{c.open}</dd></div>
        <div><dt>Überfällig</dt><dd className={c.overdue ? 'wf-bad' : undefined}>{c.overdue}</dd></div>
        <div><dt>Ohne Person</dt><dd>{c.unassigned}</dd></div>
        <div><dt>Frist</dt><dd>{q.data.slaTarget ? describeDuration(q.data.slaTarget) : 'keine'}</dd></div>
      </dl>
      <MyWork title={q.data.name} queueId={queueId} filter={q.data.member ? 'team' : 'all'} onOpenRun={onOpenRun} />
    </div>
  );
}

export interface QueueEditorProps {
  /** `null` = neue Warteschlange. */
  queueId: string | null;
  onSaved?: (q: QueueJson) => void;
  onClose?: () => void;
}

export function QueueEditor({ queueId, onSaved, onClose }: QueueEditorProps) {
  const w = useWorkflow();
  const { ui } = w;
  const existing = useQueue(queueId);
  if (!w.can('queue:manage')) return <MissingRight perm="queue:manage" lead="Zum Bearbeiten" />;
  if (queueId && existing.isPending) return <ui.Loading label="Warteschlange wird geladen …" />;
  if (queueId && existing.isError) return <ui.ErrorBox error={existing.error} />;
  return <QueueForm key={existing.data?.revision ?? 'neu'} queue={existing.data ?? null} onSaved={onSaved} onClose={onClose} />;
}

function QueueForm({ queue, onSaved, onClose }: { queue: QueueJson | null; onSaved?: (q: QueueJson) => void; onClose?: () => void }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const save = useSaveQueue();
  const del = useDeleteQueue();
  const calendars = useCalendars();
  const queues = useQueues();
  const [v, setV] = useState<QueueBody>(() => ({
    name: queue?.name ?? '', description: queue?.description ?? null, team: queue?.team ?? { type: '', id: '' }, sort: queue?.sort ?? 'urgency',
    assignment: queue?.assignment ?? 'pull', calendarId: queue?.calendarId ?? null, slaTarget: queue?.slaTarget ?? null, escalation: queue?.escalation ?? null,
  }));
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const esc = v.escalation ?? {};
  const setEsc = (e: typeof esc) => setV({ ...v, escalation: e.raisePriority || e.queue || e.notify?.length ? e : null });
  const valid = !!v.name?.trim() && !!v.team?.type && !!v.team.id;
  const submit = () => {
    if (!valid) return;
    save.mutate({ ...v, ...(queue ? { id: queue.id, revision: queue.revision } : {}) }, { onSuccess: q => { setMsg('Gespeichert.'); onSaved?.(q); } });
  };
  const conflict = save.error instanceof WorkflowApiError && save.error.conflict;
  return (
    <form className="wf-form wf-editor-form" aria-labelledby={`${id}-h`} onSubmit={e => { e.preventDefault(); submit(); }}>
      <h2 id={`${id}-h`}>{queue ? `Warteschlange «${queue.name}»` : 'Neue Warteschlange'}</h2>
      <div className="wf-field">
        <label htmlFor={`${id}-n`}>Name<span className="wf-req" aria-hidden="true"> *</span></label>
        <ui.Input id={`${id}-n`} required value={v.name} onChange={e => setV({ ...v, name: e.target.value })} />
      </div>
      <div className="wf-field">
        <label htmlFor={`${id}-d`}>Beschreibung</label>
        <ui.Textarea id={`${id}-d`} rows={2} value={v.description ?? ''} onChange={e => setV({ ...v, description: e.target.value || null })} />
      </div>
      <TeamInput label="Team" value={v.team!} onChange={team => setV({ ...v, team })} />
      <div className="wf-row">
        <div className="wf-field">
          <label htmlFor={`${id}-a`}>Zuweisung</label>
          <ui.Select id={`${id}-a`} value={v.assignment} onChange={e => setV({ ...v, assignment: e.target.value as QueueAssignment })}>
            {(Object.keys(ASSIGNMENT_LABEL) as QueueAssignment[]).map(a => <option key={a} value={a}>{ASSIGNMENT_LABEL[a]}</option>)}
          </ui.Select>
        </div>
        <div className="wf-field">
          <label htmlFor={`${id}-s`}>Sortierung</label>
          <ui.Select id={`${id}-s`} value={v.sort} onChange={e => setV({ ...v, sort: e.target.value as TaskSort })}>
            {(Object.keys(SORT_LABEL) as TaskSort[]).map(s => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
          </ui.Select>
        </div>
        <div className="wf-field">
          <label htmlFor={`${id}-c`}>Kalender</label>
          <ui.Select id={`${id}-c`} value={v.calendarId ?? ''} onChange={e => setV({ ...v, calendarId: e.target.value || null })}>
            <option value="">Standard</option>
            {(calendars.data?.items ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </ui.Select>
        </div>
      </div>
      <fieldset className="wf-field">
        <legend>Frist für Aufgaben ohne eigene Frist</legend>
        <label className="wf-check-row"><ui.Input type="checkbox" checked={!!v.slaTarget} onChange={e => setV({ ...v, slaTarget: e.target.checked ? 'P1BD' : null })} /> Frist setzen</label>
        {v.slaTarget ? <DurationInput label="Frist" value={v.slaTarget} onChange={slaTarget => setV({ ...v, slaTarget })} /> : null}
      </fieldset>
      <fieldset className="wf-field">
        <legend>Bei Verzug</legend>
        <label className="wf-check-row"><ui.Input type="checkbox" checked={!!esc.raisePriority} onChange={e => setEsc({ ...esc, raisePriority: e.target.checked || undefined })} /> Priorität erhöhen</label>
        <div className="wf-field">
          <label htmlFor={`${id}-e`}>Umleiten an</label>
          <ui.Select id={`${id}-e`} value={esc.queue ?? ''} onChange={e => setEsc({ ...esc, queue: e.target.value || undefined })}>
            <option value="">nicht umleiten</option>
            {(queues.data?.items ?? []).filter(q => q.id !== queue?.id).map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
          </ui.Select>
        </div>
        <div className="wf-hint">Zuständige bzw. Mitglieder werden immer benachrichtigt.</div>
      </fieldset>
      <div className="wf-row">
        <ui.Button type="submit" variant="primary" disabled={!valid || save.isPending}>{save.isPending ? 'Wird gespeichert …' : 'Speichern'}</ui.Button>
        {onClose ? <ui.Button onClick={onClose}>Schliessen</ui.Button> : null}
        {queue ? <ui.Button variant="ghost" onClick={() => setConfirm(true)}>Löschen …</ui.Button> : null}
        <span role="status" className="wf-ok">{msg}</span>
      </div>
      {conflict ? <p className="wf-bad" role="alert">Jemand hat die Warteschlange inzwischen geändert. Lade neu und speichere nochmals.</p> : save.isError ? <ui.ErrorBox error={save.error} /> : null}
      {confirm && queue ? (
        <ui.Dialog title="Warteschlange löschen?" role="alertdialog" onClose={() => setConfirm(false)}
          footer={<><ui.Button data-autofocus onClick={() => setConfirm(false)}>Zurück</ui.Button><ui.Button variant="danger" disabled={del.isPending}
            onClick={() => del.mutate({ id: queue.id, revision: queue.revision }, { onSuccess: () => { setConfirm(false); onClose?.(); } })}>Löschen</ui.Button></>}>
          <p>Das geht nur, wenn keine offenen Aufgaben mehr darin liegen.</p>
          {del.isError ? <ui.ErrorBox error={del.error} /> : null}
        </ui.Dialog>
      ) : null}
    </form>
  );
}
