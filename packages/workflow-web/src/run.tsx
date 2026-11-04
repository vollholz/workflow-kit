/**
 * Lauf als Ablauf (UX-Neukonzept Etappe 4, Abschnitte 3.3 und 4): derselbe Ablauf wie im Editor, mit dem tatsächlichen
 * Weg, Zeiten und Namen. Oben Zustand, Start, Bezug und wer gestartet hat (ohne Versionsnummer; «ältere Fassung», wenn
 * der Lauf nicht mit der zuletzt aktivierten lief); «Lauf abbrechen» im Menü. Ein Vorfall
 * steht an seinem Schritt mit «Nochmals versuchen» und «Schritt überspringen». Daneben die Angaben zum gewählten Schritt:
 * Zeiten, Versuche, wer erledigt oder entschieden hat, Protokoll, Ein- und Ausgabe unter «Technische Details».
 *
 * Regeln:
 * - Schritte und Nummern stammen aus der Version des Laufs, nicht aus dem Entwurf.
 * - Vorfall-Aktionen nur mit `workflow:operate`; Überspringen und Abbrechen fragen nach.
 * - Gewählt ist zuerst der Schritt mit dem Vorfall, sonst der, an dem der Lauf steht, sonst der zuletzt ausgeführte.
 * - Solange der Lauf nicht beendet ist, lädt die Ansicht alle 5 Sekunden nach.
 * - Ohne Version oder bei Arten späterer Stufen bleibt die Liste der ausgeführten Schritte.
 * - Kopf «Kontextleiste»: Mit `slots` ist der Run eine eigene Ebene der App; Zustand, wo er steht, und das Menü stehen
 *   in ihrer Leiste (`slots.actions`), Titel und «← Zurück zur Liste» entfallen.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIncidentAction, useRun, useWorkflowDetail, useWorkflowMeta, useWorkflowVersion, type IncidentAction } from './api.ts';
import { FlowView, numberOf, stepAt, type FlowRun, type FlowSelection, type FlowStepResult } from './flow.tsx';
import { MoreMenu, type MenuItem } from './menu.tsx';
import { definitionPathOf } from './paths.ts';
import { contextFields, DataLabels, walk } from './placeholders.tsx';
import { ActorName, SubjectTitle, useWorkflow } from './provider.tsx';
import { EditorCtx, kindOf, STEP_KIND_LABEL, stepNumberOfPath, stepTitle, type EditorContext } from './steps.tsx';
import type { ActorRefJson, AutomationDefinition, RunDetailJson, RunJson, RunStepJson, Step, WorkflowMetaJson } from './types.ts';
import { Badge, fmtDateTime, fmtElapsed, fmtTime, Json, outcomeLabel, RUN_STATE_LABEL, runTone, STEP_STATE_LABEL, TRIGGER_KIND_LABEL } from './ui.tsx';

export interface RunViewProps {
  runId: string;
  /** Zurück zur Liste der Läufe; ohne Angabe kein Knopf. */
  onBack?: () => void;
  /** Workflow öffnen (Editor). */
  onOpenWorkflow?: (workflowId: string) => void;
  /** Platz in der Leiste der App für Zustand und Menü (eigene Ebene); ohne Angabe Titel und Leiste im Baustein. */
  slots?: { actions?: HTMLElement | null };
}

const ACTION_LABEL: Record<IncidentAction, string> = { retry: 'Nochmals versuchen', skip: 'Schritt überspringen', cancel: 'Run abbrechen' };
const isOpen = (r: Pick<RunJson, 'state'>) => r.state === 'running' || r.state === 'waiting' || r.state === 'incident';
const isAutomation = (d: unknown): d is AutomationDefinition =>
  !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === 'automation' && Array.isArray((d as { steps?: unknown }).steps);

/** Ausgeführte Schritte je Pfad der Definition (Einträge einer Schleife zusammengefasst), in der Reihenfolge des Laufs. */
export function runStepsByPath(steps: RunStepJson[]): Map<string, RunStepJson[]> {
  const m = new Map<string, RunStepJson[]>();
  for (const s of steps) { const p = definitionPathOf(s.path); m.set(p, [...(m.get(p) ?? []), s]); }
  return m;
}

interface TaskOutput { outcome?: string; completedBy?: ActorRefJson; reason?: string | null }
const out = (s: RunStepJson | undefined) => (s?.output && typeof s.output === 'object' ? s.output as Record<string, unknown> : {});

/** Was die Karte eines ausgeführten Schritts sagt: Ergebnis, wer, wann. */
function cardText(rows: RunStepJson[]): ReactNode {
  const last = rows[rows.length - 1]!;
  const done = [...rows].reverse().find(x => x.state === 'completed');
  const o = out(done);
  const at = last.finishedAt ?? last.startedAt;
  const when = at ? ` · ${fmtTime(new Date(at))}` : '';
  const times = rows.length > 1 && rows.some(x => /\/items\/\d+\//.test(x.path)) ? `${rows.length}× · ` : '';
  const tries = last.attempt > 1 ? ` · ${last.attempt}. Versuch` : '';
  if (last.state === 'skipped') return `Übersprungen${when}`;
  if (last.state === 'waiting') return last.kind === 'approval' ? 'Wartet auf den Entscheid' : last.kind === 'task' ? 'Wartet auf die Erledigung' : 'Wartet';
  if (last.state !== 'completed') return STEP_STATE_LABEL[last.state] ?? last.state;
  if (last.kind === 'task' || last.kind === 'approval') {
    const t = o as TaskOutput;
    return <>{`«${outcomeLabel(t.outcome)}»`}{t.completedBy ? <>{' · '}<ActorName actor={t.completedBy} /></> : null}{when}</>;
  }
  if (last.kind === 'if') return `${times}${o.result === true ? 'Bedingung erfüllt' : 'Bedingung nicht erfüllt'}${when}`;
  if (last.kind === 'foreach') return `${typeof o.count === 'number' ? `${o.count} Einträge` : 'Erledigt'}${when}`;
  if (last.kind === 'end') return `Beendet: ${({ completed: 'erfolgreich', cancelled: 'abgebrochen', failed: 'fehlgeschlagen' } as Record<string, string>)[String(o.result)] ?? 'Run beendet'}${when}`;
  if (last.kind === 'set') return `${times}Gesetzt: ${Object.keys(o).join(', ') || '–'}${when}`;
  return `${times}Erledigt${when}${tries}`;
}

/** Ergebnis je Schritt für die Karten; dazu der Schritt, an dem der Lauf steht (auch wenn er noch nicht ausgeführt wurde). */
function flowResults(r: RunDetailJson, byPath: Map<string, RunStepJson[]>): Map<string, FlowStepResult> {
  const m = new Map<string, FlowStepResult>();
  const here = isOpen(r) && r.position ? definitionPathOf(r.position) : null;
  for (const [path, rows] of byPath) {
    const last = rows[rows.length - 1]!;
    const done = [...rows].reverse().find(x => x.state === 'completed');
    const outcome = (out(done) as TaskOutput).outcome;
    m.set(path, {
      path, stepId: last.stepId, kind: last.kind, label: null, summary: '', output: done?.output,
      ...(typeof outcome === 'string' ? { outcome } : {}),
      ...(last.state === 'failed' && last.error ? { error: last.error } : {}),
      active: path === here && last.state === 'waiting', skipped: last.state === 'skipped',
      text: cardText(rows),
    });
  }
  if (here && !m.has(here)) {
    m.set(here, { path: here, stepId: '', kind: '', label: null, summary: '', active: true, text: r.wakeAt ? `Geht weiter ${fmtDateTime(r.wakeAt)}` : 'Als Nächstes' });
  }
  return m;
}

export function RunView({ runId, onBack, onOpenWorkflow, slots }: RunViewProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const [live, setLive] = useState(true);
  const run = useRun(runId, { refetchInterval: live ? 5000 : false });
  const r = run.data;
  useEffect(() => { if (r) setLive(isOpen(r)); }, [r]);
  const wf = useWorkflowDetail(r?.workflowId);
  const version = useWorkflowVersion(r?.workflowId, r?.version);
  const meta = useWorkflowMeta(wf.data?.scope ?? null);
  const act = useIncidentAction();
  const [confirm, setConfirm] = useState<IncidentAction | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [sel, setSel] = useState<FlowSelection | null>(null);
  const back = onBack && !slots ? <ui.Button variant="ghost" size="sm" onClick={onBack}>← Zurück zur Liste</ui.Button> : null;
  if (run.isPending) return <>{back}<ui.Loading label="Run wird geladen …" /></>;
  if (run.isError) return <>{back}<ui.ErrorBox error={run.error} onRetry={() => void run.refetch()} /></>;
  const data = run.data;
  const wfName = wf.data?.name ?? 'Workflow';
  const def = isAutomation(version.data?.definition) ? version.data.definition : null;
  const operate = w.can('workflow:operate');
  const doIt = (action: IncidentAction) => act.mutate({ runId: data.id, action }, {
    onSuccess: (x: RunJson) => { setConfirm(null); setLive(isOpen(x)); setDone(`${ACTION_LABEL[action]}: Run ist jetzt «${RUN_STATE_LABEL[x.state]}».`); },
  });
  const byPath = runStepsByPath(data.steps);
  const steps = def?.steps ?? [];
  const errorPath = data.state === 'incident' && data.error?.path ? definitionPathOf(data.error.path) : null;
  const errorShown = !!errorPath && !!def && !!stepAt(steps, errorPath);
  const here = isOpen(data) && data.position ? definitionPathOf(data.position) : null;
  const lastRan = data.steps.length ? definitionPathOf(data.steps[data.steps.length - 1]!.path) : null;
  const first = errorShown ? errorPath : here && def && stepAt(steps, here) ? here : lastRan && def && stepAt(steps, lastRan) ? lastRan : null;
  const current: FlowSelection = sel ?? (first ? { kind: 'step', path: first } : { kind: 'trigger' });

  /** Vorfall mit «Nochmals versuchen» und «Schritt überspringen …»; am Schritt ohne Ortsangabe im Text. */
  const incidentBox = (where: string | null, atStep = false) => (
    <div className="wf-incident" role="group" aria-label={where ? `Vorfall an ${where}` : 'Vorfall'}>
      <p><b>Vorfall</b>{where && !atStep ? ` an ${where}` : ''}: {data.error?.message}</p>
      {operate ? (
        <div className="wf-row">
          <ui.Button size="sm" variant="primary" aria-disabled={act.isPending || undefined} onClick={() => { if (!act.isPending) doIt('retry'); }}>{ACTION_LABEL.retry}</ui.Button>
          <ui.Button size="sm" onClick={() => setConfirm('skip')}>{`${ACTION_LABEL.skip} …`}</ui.Button>
        </div>
      ) : <p className="wf-hint">Zum Lösen des Vorfalls fehlt dir das Recht «Vorfälle bearbeiten».</p>}
    </div>
  );

  const menu: MenuItem[] = [];
  if (onOpenWorkflow) menu.push({ label: 'Workflow öffnen', onSelect: () => onOpenWorkflow(data.workflowId) });
  if (operate && isOpen(data)) menu.push({ label: `${ACTION_LABEL.cancel} …`, danger: true, onSelect: () => setConfirm('cancel') });

  const n = (path: string) => numberOf(path, steps);
  const note = data.state === 'incident' ? (errorPath ? `hält an Schritt ${n(errorPath)} an` : 'hält an')
    : data.state === 'waiting' ? (here ? `wartet an Schritt ${n(here) || '…'}` : 'wartet')
      : data.state === 'running' ? 'läuft'
        : data.finishedAt ? `nach ${fmtElapsed(data.startedAt, data.finishedAt)}` : '';

  const flowRun: FlowRun = {
    steps: flowResults(data, byPath), triggerMatches: null, live: { open: isOpen(data) },
    below: path => (errorShown && path === errorPath ? incidentBox(`Schritt ${n(path)}`, true) : null),
  };
  const subjectLabel = (type: string) => w.subjects[type]?.label ?? meta.data?.subjectTypes.find(s => s.type === type)?.label ?? type;
  const fields = def ? contextFields(def, meta.data, subjectLabel) : [];
  const ctx: EditorContext = { meta: meta.data, fields, allFields: fields, errors: [], warnings: [], readOnly: true, steps, newId: () => '' };
  const started = <Started run={data} meta={meta.data} />;

  return (
    <section className="wf-run" aria-labelledby={`${id}-h`}>
      {back}
      <h2 id={`${id}-h`} className={slots ? 'wf-sr' : undefined}>{`Run von «${wfName}»`}</h2>
      {slots ? (slots.actions ? createPortal(
        <span className="wf-bar-actions" role="group" aria-label="Zustand des Runs">
          <Badge tone={runTone(data.state)}>{RUN_STATE_LABEL[data.state]}</Badge>
          {note ? <span className="wf-bar-note wf-bar-note-plain">{note}</span> : null}
          {menu.length ? <MoreMenu items={menu} /> : null}
        </span>, slots.actions) : null) : (
        <div className="wf-bar" role="group" aria-label="Zustand des Runs">
          <div className="wf-bar-state">
            <Badge tone={runTone(data.state)}>{RUN_STATE_LABEL[data.state]}</Badge>
            {note ? <span className="wf-bar-note">{note}</span> : null}
          </div>
          <div className="wf-bar-actions">{menu.length ? <MoreMenu items={menu} /> : null}</div>
        </div>
      )}
      <dl className="wf-summary wf-run-head">
        <dt>Workflow</dt><dd>{onOpenWorkflow ? <button type="button" className="wf-link" onClick={() => onOpenWorkflow(data.workflowId)}>{wfName}</button> : wfName}{wf.data && wf.data.activeVersion !== data.version ? <span className="wf-muted"> · ältere Fassung</span> : null}</dd>
        <dt>Gestartet</dt><dd>{started}</dd>
        {data.finishedAt ? <><dt>Beendet</dt><dd>{`${fmtDateTime(data.finishedAt)} (${fmtElapsed(data.startedAt, data.finishedAt)})`}</dd></> : null}
        <dt>Bezug</dt><dd><SubjectLink subject={data.subject} /></dd>
        <dt>Handelt als</dt><dd><ActorName actor={data.actor} /></dd>
        {data.wakeAt ? <><dt>Geht weiter</dt><dd>{fmtDateTime(data.wakeAt)}</dd></> : null}
        {data.chainDepth > 1 ? <><dt>Kettentiefe</dt><dd>{data.chainDepth}</dd></> : null}
      </dl>
      <div role="status" aria-live="polite" className="wf-ok">{done}</div>
      {act.isError && !confirm ? <ui.ErrorBox error={act.error} /> : null}
      {data.error && !errorShown && !version.isPending ? (data.state === 'incident' ? incidentBox(data.error.path ? `Schritt ${stepNumberOfPath(definitionPathOf(data.error.path), steps) ?? '?'}` : null)
        : <div className="wf-error" role="alert"><div><b>Fehler</b><div>{data.error.message}</div></div></div>) : null}
      {def ? (
        <EditorCtx.Provider value={ctx}>
          <DataLabels.Provider value={fields}>
            <div className="wf-editor-grid">
              <div className="wf-editor-main">
                <FlowView steps={steps} run={flowRun} locked trigger={{ value: def.trigger, text: started }} sel={current}
                  onSelect={s => { if (s.kind !== 'insert') setSel(s); }} onAddFirst={() => {}} onMove={() => null} onRemove={() => {}} onOpen={() => {}} />
              </div>
              <aside className="wf-editor-side wf-detail" aria-label="Schritt im Run">
                {current.kind === 'step'
                  ? <RunStepDetail path={current.path} step={stepAt(steps, current.path)} rows={byPath.get(current.path) ?? []} run={data} steps={steps} meta={meta.data} />
                  : <RunTriggerDetail run={data} started={started} />}
                {Object.keys(data.variables ?? {}).length ? <Json value={data.variables} label="Variablen" /> : null}
              </aside>
            </div>
          </DataLabels.Provider>
        </EditorCtx.Provider>
      ) : version.isPending && r ? <ui.Loading label="Ablauf wird geladen …" /> : <RunStepList run={data} />}
      {confirm ? (
        <ui.Dialog title={`${ACTION_LABEL[confirm]}?`} role="alertdialog" onClose={() => setConfirm(null)}
          footer={<><ui.Button data-autofocus onClick={() => setConfirm(null)}>Zurück</ui.Button><ui.Button variant="danger" disabled={act.isPending} onClick={() => doIt(confirm)}>{ACTION_LABEL[confirm]}</ui.Button></>}>
          <p>{confirm === 'skip' ? 'Der fehlgeschlagene Schritt wird übersprungen; der Run macht mit dem nächsten Schritt weiter.' : 'Der Run wird beendet; bereits ausgeführte Schritte bleiben, wie sie sind.'}</p>
          {act.isError ? <ui.ErrorBox error={act.error} /> : null}
        </ui.Dialog>
      ) : null}
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

/** Wie und wann der Lauf startete: Zeit und von wem bzw. durch welches Ereignis oder welchen Zeitplan. */
function Started({ run, meta }: { run: RunJson; meta: WorkflowMetaJson | undefined }) {
  const by = run.trigger.manual?.by ?? run.startedBy;
  const ev = run.trigger.event ? meta?.events.find(e => e.type === run.trigger.event!.type)?.label ?? run.trigger.event.type : null;
  return (
    <>
      {fmtDateTime(run.startedAt)}
      {run.triggerKind === 'manual' ? (by ? <>{' · von '}<ActorName actor={by} /></> : ' · von Hand')
        : run.triggerKind === 'event' ? ` · bei «${ev}»` : ` · ${TRIGGER_KIND_LABEL[run.triggerKind] ?? run.triggerKind}`}
    </>
  );
}

function RunTriggerDetail({ run, started }: { run: RunJson; started: ReactNode }) {
  return (
    <section className="wf-detail-step" aria-label="Auslöser">
      <header className="wf-detail-head"><div className="wf-grow"><p className="wf-detail-ey">Auslöser · {TRIGGER_KIND_LABEL[run.triggerKind] ?? run.triggerKind}</p><h3>Start</h3></div></header>
      <p>{started}</p>
      <Json value={run.trigger} label="Technische Details" />
    </section>
  );
}

/** Angaben zu einem Schritt im Lauf: Zustand, Zeiten, Versuche, wer erledigt hat, Protokoll und technische Details. */
function RunStepDetail({ path, step, rows, run, steps, meta }: {
  path: string; step: Step | undefined; rows: RunStepJson[]; run: RunDetailJson; steps: Step[]; meta: WorkflowMetaJson | undefined;
}) {
  const name = `Schritt ${numberOf(path, steps)}`;
  const kind = step ? STEP_KIND_LABEL[kindOf(step)] ?? 'Schritt' : 'Schritt';
  const last = rows[rows.length - 1];
  const done = [...rows].reverse().find(x => x.state === 'completed');
  const t = out(done) as TaskOutput;
  const here = isOpen(run) && run.position ? definitionPathOf(run.position) === path : false;
  const first = rows[0];
  // Titel, wie ihn der Lauf gesetzt hat (Aufgabe, Genehmigung: «Ausmustern: Confluence»), sonst der des Schritts
  const titled = rows.map(x => (x.input && typeof x.input === 'object' ? (x.input as { title?: unknown }).title : undefined)).find((t): t is string => typeof t === 'string' && !!t);
  return (
    <section className="wf-detail-step" aria-label={`${name}: ${step ? stepTitle(step, meta) : kind}`}>
      <header className="wf-detail-head">
        <div className="wf-grow">
          <p className="wf-detail-ey">{`${name} · ${kind}`}</p>
          <h3>{titled ?? (step ? stepTitle(step, meta) : kind)}</h3>
        </div>
      </header>
      {!last ? <p className="wf-muted">{here ? `Der Run ist als Nächstes hier${run.wakeAt ? ` (${fmtDateTime(run.wakeAt)})` : ''}.` : isOpen(run) ? `${name} ist in diesem Run noch nicht erreicht.` : `${name} wurde in diesem Run nicht erreicht.`}</p> : (
        <>
          <dl className="wf-summary">
            <dt>Zustand</dt><dd><Badge tone={last.error ? 'bad' : last.state === 'completed' ? 'ok' : 'muted'}>{STEP_STATE_LABEL[last.state] ?? last.state}</Badge></dd>
            <dt>Start</dt><dd>{fmtDateTime(first?.startedAt)}</dd>
            {last.finishedAt && last.state !== 'waiting' ? <><dt>Ende</dt><dd>{`${fmtDateTime(last.finishedAt)} (${fmtElapsed(first?.startedAt, last.finishedAt)})`}</dd></> : null}
            {last.attempt > 1 ? <><dt>Versuche</dt><dd>{last.attempt}</dd></> : null}
            {rows.length > 1 && rows.some(x => /\/items\/\d+\//.test(x.path)) ? <><dt>Ausführungen</dt><dd>{rows.length}</dd></> : null}
            {t.outcome !== undefined && (last.kind === 'task' || last.kind === 'approval') ? <><dt>Ergebnis</dt><dd>{outcomeLabel(t.outcome)}</dd></> : null}
            {t.completedBy ? <><dt>{last.kind === 'approval' ? 'Entschieden von' : 'Erledigt von'}</dt><dd><ActorName actor={t.completedBy} /></dd></> : null}
            {t.reason ? <><dt>Begründung</dt><dd>{t.reason}</dd></> : null}
          </dl>
          {last.error ? <p className="wf-bad">{last.error.message}</p> : null}
          {rows.some(x => x.log.length) ? <ul className="wf-log">{rows.flatMap(x => x.log).map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
          {rows.map((x, i) => (x.input !== undefined && x.input !== null) || (x.output !== undefined && x.output !== null)
            ? <Json key={x.id} value={{ eingabe: x.input, ausgabe: x.output }} label={rows.length > 1 ? `Technische Details · ${i + 1}. Ausführung` : 'Technische Details'} />
            : null)}
        </>
      )}
    </section>
  );
}

/** Ausweg ohne Ablauf (Version nicht lesbar, Arten späterer Stufen): ausgeführte Schritte als Liste. */
function RunStepList({ run }: { run: RunDetailJson }) {
  const version = useWorkflowVersion(run.workflowId, run.version);
  const def = version.data?.definition as AutomationDefinition | undefined;
  const byId = new Map(def && Array.isArray(def.steps) ? [...walk(def.steps)].map(s => [s.id, s]) : []);
  return (
    <>
      <h3>Schritte</h3>
      {run.steps.length ? (
        <ol className="wf-run-steps">
          {run.steps.map(s => (
            <li key={s.id} className={s.error ? 'bad' : ''}>
              <div className="wf-row">
                <b>{`Schritt ${stepNumberOfPath(definitionPathOf(s.path)) ?? '?'}`}</b>
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
    </>
  );
}
