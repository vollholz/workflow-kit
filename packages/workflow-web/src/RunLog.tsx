/**
 * Runs (Konzept 4.9 und 10): Runs mit Zustand, Auslöser, Bezug, Start und Dauer; Filter nach Workflow, Bezug und
 * Zustand; weitere Seiten über den Cursor. Ein Run öffnet sich als Ablauf (`RunView`, UX-Neukonzept Etappe 4):
 * tatsächlicher Weg mit Zeiten und Namen, Vorfall am Schritt – in der Liste selbst oder, mit `onOpenRun`, auf einer
 * eigenen Seite der App. Workflow und Schritte stehen mit Namen da, nie mit ihrer ID.
 */
import { useId, useState } from 'react';
import { useRuns, useWorkflows, type RunFilter } from './api.ts';
import { SubjectTitle, useWorkflow } from './provider.tsx';
import { RunView, SubjectLink } from './run.tsx';
import type { RunState } from './types.ts';
import { Badge, fmtDateTime, fmtElapsed, rowLink, RUN_STATE_LABEL, runTone, TRIGGER_KIND_LABEL } from './ui.tsx';

export { SubjectLink } from './run.tsx';

export interface RunLogProps {
  /** Nur Läufe dieses Workflows (Filter fest). */
  workflowId?: string;
  /** Nur Läufe zu diesem Bezug (Filter fest). */
  subject?: { type: string; id: string };
  /** Diesen Lauf gleich öffnen. */
  runId?: string;
  /** Anfangs nur Läufe in diesem Zustand (z. B. `incident` für «Vorfall ansehen»). */
  state?: RunState;
  /** Workflow öffnen (Editor). */
  onOpenWorkflow?: (workflowId: string) => void;
  /** Einen Run öffnen (eigene Seite der App); ohne Angabe öffnet er sich an Stelle der Liste. */
  onOpenRun?: (runId: string) => void;
  /** Überschrift «Runs» zeigen (Standard `true`); `false`, wenn die App den Bereich im Seitenkopf nennt (bleibt für Screenreader). */
  showTitle?: boolean;
}

export function RunLog({ workflowId, subject, runId, state: initialState, onOpenWorkflow, onOpenRun, showTitle = true }: RunLogProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const [open, setOpen] = useState<string | null>(runId ?? null);
  const [wf, setWf] = useState(workflowId ?? '');
  const [state, setState] = useState<RunState | ''>(initialState ?? '');
  const [subjectType, setSubjectType] = useState(subject?.type ?? '');
  const [subjectId, setSubjectId] = useState(subject?.id ?? '');
  const workflows = useWorkflows({}, !workflowId);
  const filter: RunFilter = {
    workflowId: workflowId ?? (wf || undefined), state: state || undefined,
    subjectType: subject?.type ?? (subjectType || undefined), subjectId: subject?.id ?? (subjectId || undefined),
  };
  const runs = useRuns(filter);
  const names = new Map((workflows.data?.items ?? []).map(x => [x.id, x.name]));
  const items = runs.data?.pages.flatMap(p => p.items) ?? [];
  const openRun = (x: string) => (onOpenRun ? onOpenRun(x) : setOpen(x));
  if (open) return <RunView runId={open} onBack={() => setOpen(null)} onOpenWorkflow={onOpenWorkflow} />;
  return (
    <section className="wf-runlog" aria-labelledby={`${id}-h`}>
      <header className="wf-list-head">
        <h2 id={`${id}-h`} className={showTitle ? undefined : 'wf-sr'}>Runs</h2>
        <div className="wf-row">
          {!workflowId ? (
            <>
              <label htmlFor={`${id}-w`} className="wf-sr">Workflow</label>
              <ui.Select id={`${id}-w`} value={wf} onChange={e => setWf(e.target.value)}>
                <option value="">Alle Workflows</option>
                {(workflows.data?.items ?? []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </ui.Select>
            </>
          ) : null}
          <label htmlFor={`${id}-s`} className="wf-sr">Zustand</label>
          <ui.Select id={`${id}-s`} value={state} onChange={e => setState(e.target.value as RunState | '')}>
            <option value="">Alle Zustände</option>
            {(Object.keys(RUN_STATE_LABEL) as RunState[]).map(s => <option key={s} value={s}>{RUN_STATE_LABEL[s]}</option>)}
          </ui.Select>
          {!subject ? (
            <>
              <label htmlFor={`${id}-bt`} className="wf-sr">Art des Bezugs</label>
              <ui.Select id={`${id}-bt`} value={subjectType} onChange={e => { setSubjectType(e.target.value); if (!e.target.value) setSubjectId(''); }}>
                <option value="">Alle Bezüge</option>
                {Object.entries(w.subjects).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
              </ui.Select>
              {subjectType ? (
                <>
                  <label htmlFor={`${id}-bi`} className="wf-sr">ID des Bezugs</label>
                  <ui.Input id={`${id}-bi`} placeholder="ID" value={subjectId} onChange={e => setSubjectId(e.target.value)} />
                  {subjectId.trim() ? <span className="wf-muted wf-small" aria-live="polite"><SubjectTitle type={subjectType} id={subjectId.trim()} /></span> : null}
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      {runs.isPending ? <ui.Loading label="Runs werden geladen …" />
        : runs.isError ? <ui.ErrorBox error={runs.error} onRetry={() => void runs.refetch()} />
          : !items.length ? <ui.Empty title="Keine Runs">{state || wf || subjectType ? 'Kein Run passt zum Filter.' : 'Sobald ein aktiver Workflow startet, erscheint sein Run hier.'}</ui.Empty>
            : (
              <>
                <table className="wf-table">
                  <thead>
                    <tr><th scope="col">Start</th>{!workflowId ? <th scope="col">Workflow</th> : null}<th scope="col">Auslöser</th><th scope="col">Bezug</th><th scope="col">Zustand</th><th scope="col">Dauer</th></tr>
                  </thead>
                  <tbody>
                    {items.map(r => (
                      <tr key={r.id} {...rowLink(() => openRun(r.id))}>
                        <th scope="row" className="wf-plain-cell"><button type="button" className="wf-cell-link" onClick={() => openRun(r.id)} aria-label={`Run vom ${fmtDateTime(r.startedAt)} öffnen`}>{fmtDateTime(r.startedAt)}</button></th>
                        {!workflowId ? <td>{names.get(r.workflowId) ?? r.workflowId}</td> : null}
                        <td>{TRIGGER_KIND_LABEL[r.triggerKind] ?? r.triggerKind}{r.trigger.event ? ` · ${r.trigger.event.type}` : ''}</td>
                        <td><SubjectLink subject={r.subject} /></td>
                        <td><Badge tone={runTone(r.state)}>{RUN_STATE_LABEL[r.state]}</Badge></td>
                        <td>{fmtElapsed(r.startedAt, r.finishedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {runs.hasNextPage ? <ui.Button disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>{runs.isFetchingNextPage ? 'Lädt …' : 'Weitere Runs laden'}</ui.Button> : null}
              </>
            )}
    </section>
  );
}
