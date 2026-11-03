/**
 * Protokoll (Konzept 4.9 und 10): Läufe mit Zustand, Auslöser, Bezug, Start und Dauer; Filter nach Workflow, Bezug
 * und Zustand; weitere Seiten über den Cursor. Ein Lauf öffnet sich mit seinen Schritten (Ein- und Ausgaben so, wie
 * der Server sie liefert: gekürzt, Geheimnisse geschwärzt, unter «Technische Details»), Fehlern und Zeiten. Workflow und
 * Schritte stehen mit Namen da (Schritt mit Nummer und Titel aus der Version des Laufs), nie mit ihrer ID.
 *
 * Regel: Vorfall-Aktionen («Nochmals versuchen», «Schritt überspringen», «Abbrechen») nur mit `workflow:operate`;
 * Überspringen und Abbrechen fragen nach.
 */
import { useId, useState } from 'react';
import { useIncidentAction, useRun, useRuns, useWorkflowDetail, useWorkflows, useWorkflowVersion, type IncidentAction, type RunFilter } from './api.ts';
import { walk } from './placeholders.tsx';
import { ActorName, SubjectTitle, useWorkflow } from './provider.tsx';
import type { AutomationDefinition, RunJson, RunState } from './types.ts';
import { Badge, fmtDateTime, fmtElapsed, Json, RUN_STATE_LABEL, runTone, STEP_STATE_LABEL, TRIGGER_KIND_LABEL } from './ui.tsx';
import { STEP_KIND_LABEL, stepNumberOfPath, stepTitle } from './steps.tsx';

export interface RunLogProps {
  /** Nur Läufe dieses Workflows (Filter fest). */
  workflowId?: string;
  /** Nur Läufe zu diesem Bezug (Filter fest). */
  subject?: { type: string; id: string };
  /** Diesen Lauf gleich öffnen. */
  runId?: string;
  /** Workflow öffnen (Editor). */
  onOpenWorkflow?: (workflowId: string) => void;
}

export function RunLog({ workflowId, subject, runId, onOpenWorkflow }: RunLogProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const [open, setOpen] = useState<string | null>(runId ?? null);
  const [wf, setWf] = useState(workflowId ?? '');
  const [state, setState] = useState<RunState | ''>('');
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
  if (open) return <RunDetail runId={open} name={names} onBack={() => setOpen(null)} onOpenWorkflow={onOpenWorkflow} />;
  return (
    <section className="wf-runlog" aria-labelledby={`${id}-h`}>
      <header className="wf-list-head">
        <h2 id={`${id}-h`}>Protokoll</h2>
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
      {runs.isPending ? <ui.Loading label="Läufe werden geladen …" />
        : runs.isError ? <ui.ErrorBox error={runs.error} onRetry={() => void runs.refetch()} />
          : !items.length ? <ui.Empty title="Keine Läufe">{state || wf || subjectType ? 'Kein Lauf passt zum Filter.' : 'Sobald ein aktiver Workflow startet, erscheint sein Lauf hier.'}</ui.Empty>
            : (
              <>
                <table className="wf-table">
                  <thead>
                    <tr><th scope="col">Start</th>{!workflowId ? <th scope="col">Workflow</th> : null}<th scope="col">Auslöser</th><th scope="col">Bezug</th><th scope="col">Zustand</th><th scope="col">Dauer</th></tr>
                  </thead>
                  <tbody>
                    {items.map(r => (
                      <tr key={r.id}>
                        <th scope="row"><button type="button" className="wf-link" onClick={() => setOpen(r.id)} aria-label={`Lauf vom ${fmtDateTime(r.startedAt)} öffnen`}>{fmtDateTime(r.startedAt)}</button></th>
                        {!workflowId ? <td>{names.get(r.workflowId) ?? r.workflowId}</td> : null}
                        <td>{TRIGGER_KIND_LABEL[r.triggerKind] ?? r.triggerKind}{r.trigger.event ? ` · ${r.trigger.event.type}` : ''}</td>
                        <td><SubjectLink subject={r.subject} /></td>
                        <td><Badge tone={runTone(r.state)}>{RUN_STATE_LABEL[r.state]}</Badge></td>
                        <td>{fmtElapsed(r.startedAt, r.finishedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {runs.hasNextPage ? <ui.Button disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>{runs.isFetchingNextPage ? 'Lädt …' : 'Weitere Läufe laden'}</ui.Button> : null}
              </>
            )}
    </section>
  );
}

/** Bezug mit Bezeichnung des Typs; Link oder Knopf, wenn die App ihn öffnen kann. */
export function SubjectLink({ subject }: { subject: { type: string; id: string } | null }) {
  const w = useWorkflow();
  if (!subject) return <span className="wf-muted">–</span>;
  const cfg = w.subjects[subject.type];
  const text = <SubjectTitle type={subject.type} id={subject.id} />;
  if (cfg?.onOpen) return <button type="button" className="wf-link" onClick={() => cfg.onOpen!(subject.id)}>{text}</button>;
  if (cfg?.href) return <a className="wf-link" href={cfg.href(subject.id)}>{text}</a>;
  return <span>{text}</span>;
}

const ACTION_LABEL: Record<IncidentAction, string> = { retry: 'Nochmals versuchen', skip: 'Schritt überspringen', cancel: 'Lauf abbrechen' };

function RunDetail({ runId, name, onBack, onOpenWorkflow }: { runId: string; name: Map<string, string>; onBack: () => void; onOpenWorkflow?: (id: string) => void }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const run = useRun(runId);
  const wf = useWorkflowDetail(run.data?.workflowId);
  const version = useWorkflowVersion(run.data?.workflowId, run.data?.version);
  const act = useIncidentAction();
  const [confirm, setConfirm] = useState<IncidentAction | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const back = <ui.Button variant="ghost" size="sm" onClick={onBack}>← Zurück zur Liste</ui.Button>;
  if (run.isPending) return <>{back}<ui.Loading label="Lauf wird geladen …" /></>;
  if (run.isError) return <>{back}<ui.ErrorBox error={run.error} onRetry={() => void run.refetch()} /></>;
  const r = run.data;
  const wfName = name.get(r.workflowId) ?? wf.data?.name ?? 'Workflow';
  const def = version.data?.definition as AutomationDefinition | undefined;
  const byId = new Map(def && Array.isArray(def.steps) ? [...walk(def.steps)].map(s => [s.id, s]) : []);
  const operate = w.can('workflow:operate');
  const doIt = (action: IncidentAction) => act.mutate({ runId: r.id, action }, { onSuccess: (x: RunJson) => { setConfirm(null); setDone(`${ACTION_LABEL[action]}: Lauf ist jetzt «${RUN_STATE_LABEL[x.state]}».`); } });
  const actions: IncidentAction[] = r.state === 'incident' ? ['retry', 'skip', 'cancel'] : r.state === 'running' || r.state === 'waiting' ? ['cancel'] : [];
  return (
    <section className="wf-run" aria-labelledby={`${id}-h`}>
      {back}
      <h2 id={`${id}-h`}>{`Lauf von «${wfName}»`}</h2>
      <dl className="wf-summary">
        <dt>Zustand</dt><dd><Badge tone={runTone(r.state)}>{RUN_STATE_LABEL[r.state]}</Badge></dd>
        <dt>Workflow</dt><dd>{onOpenWorkflow ? <button type="button" className="wf-link" onClick={() => onOpenWorkflow(r.workflowId)}>{wfName}</button> : wfName} · Version {r.version}</dd>
        <dt>Auslöser</dt><dd>{TRIGGER_KIND_LABEL[r.triggerKind] ?? r.triggerKind}{r.trigger.event ? ` · ${r.trigger.event.type}` : ''}{r.trigger.manual ? <>{' · von '}<ActorName actor={r.trigger.manual.by} /></> : null}</dd>
        <dt>Bezug</dt><dd><SubjectLink subject={r.subject} /></dd>
        <dt>Handelt als</dt><dd><ActorName actor={r.actor} /></dd>
        <dt>Start</dt><dd>{fmtDateTime(r.startedAt)}{r.finishedAt ? ` · Ende ${fmtDateTime(r.finishedAt)} (${fmtElapsed(r.startedAt, r.finishedAt)})` : ''}</dd>
        {r.wakeAt ? <><dt>Wartet bis</dt><dd>{fmtDateTime(r.wakeAt)}</dd></> : null}
        {r.chainDepth > 1 ? <><dt>Kettentiefe</dt><dd>{r.chainDepth}</dd></> : null}
      </dl>
      {r.error ? <div className="wf-error" role="alert"><div><b>{r.state === 'incident' ? 'Vorfall' : 'Fehler'}</b><div>{r.error.message}</div>{r.error.path ? <div className="wf-small wf-muted">bei Schritt {stepNumberOfPath(r.error.path) ?? r.error.path}</div> : null}</div></div> : null}
      {actions.length ? (
        operate ? (
          <div className="wf-row" role="group" aria-label="Vorfall lösen">
            {actions.map(a => <ui.Button key={a} variant={a === 'retry' ? 'primary' : a === 'cancel' ? 'danger' : 'default'} disabled={act.isPending}
              onClick={() => (a === 'retry' ? doIt(a) : setConfirm(a))}>{ACTION_LABEL[a]}</ui.Button>)}
          </div>
        ) : <p className="wf-muted wf-small">Zum Lösen des Vorfalls fehlt dir das Recht «Vorfälle bearbeiten».</p>
      ) : null}
      <div role="status" aria-live="polite" className="wf-ok">{done}</div>
      {act.isError && !confirm ? <ui.ErrorBox error={act.error} /> : null}
      <h3>Schritte</h3>
      {r.steps.length ? (
        <ol className="wf-run-steps">
          {r.steps.map(s => (
            <li key={s.id} className={s.error ? 'bad' : ''}>
              <div className="wf-row">
                <b>{`Schritt ${stepNumberOfPath(s.path) ?? '?'}`}</b>
                <span>{byId.get(s.stepId) ? stepTitle(byId.get(s.stepId)!, undefined) : (STEP_KIND_LABEL[s.kind] ?? s.kind)}</span>
                <Badge tone={s.error ? 'bad' : s.state === 'completed' ? 'ok' : 'muted'}>{STEP_STATE_LABEL[s.state] ?? s.state}</Badge>
                {s.attempt > 1 ? <span className="wf-small">Versuch {s.attempt}</span> : null}
                <span className="wf-small wf-muted">{fmtDateTime(s.startedAt)} {fmtElapsed(s.startedAt, s.finishedAt)}</span>
              </div>
              {s.error ? <div className="wf-bad">{s.error.message}</div> : null}
              {s.log.length ? <ul className="wf-log">{s.log.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
              {s.input !== undefined || s.output !== undefined ? <Json value={{ eingabe: s.input, ausgabe: s.output }} label="Technische Details" /> : null}
            </li>
          ))}
        </ol>
      ) : <p className="wf-muted">Noch kein Schritt ausgeführt.</p>}
      {Object.keys(r.variables ?? {}).length ? <Json value={r.variables} label="Variablen" /> : null}
      {confirm ? (
        <ui.Dialog title={`${ACTION_LABEL[confirm]}?`} role="alertdialog" onClose={() => setConfirm(null)}
          footer={<><ui.Button data-autofocus onClick={() => setConfirm(null)}>Zurück</ui.Button><ui.Button variant="danger" disabled={act.isPending} onClick={() => doIt(confirm)}>{ACTION_LABEL[confirm]}</ui.Button></>}>
          <p>{confirm === 'skip' ? 'Der fehlgeschlagene Schritt wird übersprungen; der Lauf macht mit dem nächsten Schritt weiter.' : 'Der Lauf wird beendet; bereits ausgeführte Schritte bleiben, wie sie sind.'}</p>
          {act.isError ? <ui.ErrorBox error={act.error} /> : null}
        </ui.Dialog>
      ) : null}
    </section>
  );
}
