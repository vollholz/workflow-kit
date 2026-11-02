/**
 * Editor eines Workflows (Konzept Abschnitt 10, W4): Kopf mit Name, Zustand, Entwurf gegenüber aktiver Version,
 * Speichern, Aktivieren, Pausieren, Archivieren; darunter der Auslöser, die Schrittliste und der Probelauf.
 *
 * Regeln:
 * - Bearbeitet wird immer der Entwurf; Speichern mit `If-Match` (Stand). Hat jemand anderes inzwischen gespeichert,
 *   fragt der Editor: neu laden (eigene Änderungen verwerfen) oder eigene Fassung über den neuen Stand speichern.
 * - Prüfung live: Nach jeder Änderung (verzögert) prüft `POST /workflows/validate`; Meldungen stehen am Schritt.
 * - Aktivieren zeigt eine Zusammenfassung (Akteur, Auslöser, Zeitplan) und speichert ungespeicherte Änderungen zuerst.
 * - Ohne `workflow:manage` (oder archiviert, oder eine Art späterer Stufen) ist alles nur lesbar.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  useDeleteWorkflow, useDryRun, useSaveWorkflow, useValidateDefinition, useWorkflowDetail, useWorkflowLifecycle, useWorkflowMeta, useWorkflowVersion,
  useWorkflowVersions,
} from './api.ts';
import { contextFields, walk } from './placeholders.tsx';
import { actorName, useWorkflow, type WorkflowActor } from './provider.tsx';
import { EditorCtx, StepList, type EditorContext } from './steps.tsx';
import { describeCron, describeTrigger, TriggerEditor } from './trigger.tsx';
import type { AutomationDefinition, DefinitionError, DryRunJson, Step, WorkflowDefinition, WorkflowDetail, WorkflowMetaJson } from './types.ts';
import { Badge, fmtDateTime, Json, KIND_LABEL, MissingRight, STATE_LABEL, stateTone, WorkflowApiError } from './ui.tsx';

export interface StepListEditorProps {
  workflowId?: string | null;
  /** Nach dem Löschen eines Entwurfs. */
  onDeleted?: () => void;
  /** Protokoll des Workflows öffnen. */
  onShowRuns?: (workflowId: string) => void;
  /** Verzögerung der Live-Prüfung in ms (Standard 400). */
  validateDelayMs?: number;
}

interface Draft { name: string; description: string; definition: WorkflowDefinition }

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, (x as Record<string, unknown>)[k]])) : x);
const draftOf = (d: WorkflowDetail): Draft => ({ name: d.name, description: d.description ?? '', definition: d.definition });
const isAutomation = (d: WorkflowDefinition): d is AutomationDefinition => d.kind === 'automation' && 'trigger' in d && Array.isArray((d as AutomationDefinition).steps);

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function StepListEditor({ workflowId, onDeleted, onShowRuns, validateDelayMs = 400 }: StepListEditorProps) {
  const w = useWorkflow();
  const { ui } = w;
  const detail = useWorkflowDetail(workflowId);
  if (!workflowId) return <ui.Empty title="Kein Workflow gewählt">Wähle einen Workflow aus der Liste oder lege einen neuen an.</ui.Empty>;
  if (detail.isPending) return <ui.Loading label="Workflow wird geladen …" />;
  if (detail.isError) return <ui.ErrorBox error={detail.error} onRetry={() => void detail.refetch()} />;
  return <EditorLoaded key={detail.data.id} detail={detail.data} refetch={async () => (await detail.refetch()).data} onDeleted={onDeleted} onShowRuns={onShowRuns} validateDelayMs={validateDelayMs} />;
}

function EditorLoaded({ detail, refetch, onDeleted, onShowRuns, validateDelayMs }: {
  detail: WorkflowDetail; refetch: () => Promise<WorkflowDetail | undefined>; onDeleted?: () => void; onShowRuns?: (id: string) => void; validateDelayMs: number;
}) {
  const w = useWorkflow();
  const { ui } = w;
  const meta = useWorkflowMeta(detail.scope);
  const [draft, setDraft] = useState<Draft>(() => draftOf(detail));
  const [base, setBase] = useState<Draft>(() => draftOf(detail));
  const [conflict, setConflict] = useState(false);
  const [dialog, setDialog] = useState<null | 'activate' | 'archive' | 'delete'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useSaveWorkflow(detail.id);
  const life = useWorkflowLifecycle(detail.id);
  const del = useDeleteWorkflow(detail.id);
  const activeVersion = useWorkflowVersion(detail.id, detail.state === 'active' || detail.state === 'paused' ? detail.activeVersion : null);
  const dirty = canonical(draft) !== canonical(base);
  const automation = isAutomation(draft.definition);
  const readOnly = !w.can('workflow:manage') || detail.state === 'archived' || !automation;
  const debounced = useDebounced(automation ? draft.definition : null, validateDelayMs);
  const validation = useValidateDefinition(readOnly ? null : debounced);
  const errors: DefinitionError[] = useMemo(() => [...(validation.data?.errors ?? []), ...(validation.data?.stage ?? [])], [validation.data]);
  const ids = useRef(new Set<string>());
  ids.current = new Set(automation ? [...walk((draft.definition as AutomationDefinition).steps)].map(s => s.id) : []);
  const subjectLabel = (type: string) => w.subjects[type]?.label ?? meta.data?.subjectTypes.find(s => s.type === type)?.label ?? type;
  const fields = automation ? contextFields(draft.definition as AutomationDefinition, meta.data, subjectLabel) : [];
  const ctx: EditorContext = {
    meta: meta.data, fields, errors, readOnly,
    newId: () => {
      let n = ids.current.size + 1;
      while (ids.current.has(`s${n}`)) n++;
      ids.current.add(`s${n}`);
      return `s${n}`;
    },
  };
  const def = draft.definition as AutomationDefinition;
  const setDef = (d: AutomationDefinition) => setDraft(x => ({ ...x, definition: d }));
  const adopt = (d: WorkflowDetail) => { setDraft(draftOf(d)); setBase(draftOf(d)); };

  const doSave = async (revision = detail.revision): Promise<WorkflowDetail | null> => {
    try {
      const d = await save.mutateAsync({ revision, name: draft.name, description: draft.description || null, definition: draft.definition });
      setBase(draftOf(d));
      setNotice('Entwurf gespeichert.');
      return d;
    } catch (e) {
      if (e instanceof WorkflowApiError && e.conflict && detail.state !== 'archived') setConflict(true);
      return null;
    }
  };
  const reload = async () => { const d = await refetch(); if (d) adopt(d); setConflict(false); save.reset(); };
  const keepMine = async () => { const d = await refetch(); setConflict(false); save.reset(); if (d) await doSave(d.revision); };

  const triggerErrors = errors.filter(e => e.path.startsWith('/trigger'));
  const otherErrors = errors.filter(e => !e.path.startsWith('/trigger') && !e.path.startsWith('/steps/'));
  const differsFromActive = !!activeVersion.data?.definition && canonical(activeVersion.data.definition) !== canonical(draft.definition);
  const nameId = useId();

  return (
    <EditorCtx.Provider value={ctx}>
      <div className="wf-editor">
        <header className="wf-editor-head">
          <div className="wf-grow">
            <div className="wf-field">
              <label htmlFor={nameId} className="wf-sr">Name des Workflows</label>
              <ui.Input id={nameId} className="wf-title-input" value={draft.name} disabled={readOnly} onChange={e => setDraft(x => ({ ...x, name: e.target.value }))} />
            </div>
            <div className="wf-row wf-small">
              <Badge tone={stateTone(detail.state)}>{STATE_LABEL[detail.state]}</Badge>
              <span>{KIND_LABEL[detail.kind]}</span>
              <span className="wf-muted">{w.scopeLabel(detail.scope)}</span>
              <span className="wf-muted">{detail.activeVersion ? `Aktive Version ${detail.activeVersion}` : 'Noch nie aktiviert'} · Entwurf Stand {detail.revision}</span>
              {detail.actor ? <span className="wf-muted">Akteur: {actorName(w, detail.actor)}</span> : null}
              {dirty ? <Badge tone="warn">Ungespeichert</Badge> : null}
            </div>
            {detail.state === 'paused' && detail.pausedReason ? <p className="wf-warn" role="note">Pausiert: {detail.pausedReason}</p> : null}
            {differsFromActive ? <p className="wf-hint">Der Entwurf weicht von der aktiven Version ab; Änderungen wirken erst nach dem Aktivieren.</p> : null}
          </div>
          <div className="wf-editor-actions">
            {!readOnly ? <ui.Button variant="primary" disabled={!dirty || save.isPending} onClick={() => void doSave()}>{save.isPending ? 'Speichert …' : 'Speichern'}</ui.Button> : null}
            {w.can('workflow:activate') && detail.state !== 'archived' && automation ? <ui.Button onClick={() => setDialog('activate')}>Aktivieren …</ui.Button> : null}
            {w.can('workflow:activate') && detail.state === 'active' ? <ui.Button disabled={life.pause.isPending} onClick={() => life.pause.mutate(undefined, { onSuccess: d => { adopt(d); setNotice('Workflow pausiert.'); } })}>Pausieren</ui.Button> : null}
            {w.can('workflow:activate') && detail.state !== 'archived' && detail.activeVersion !== null ? <ui.Button variant="ghost" onClick={() => setDialog('archive')}>Archivieren …</ui.Button> : null}
            {w.can('workflow:manage') && detail.state === 'draft' && detail.activeVersion === null ? <ui.Button variant="ghost" onClick={() => setDialog('delete')}>Löschen …</ui.Button> : null}
            {onShowRuns ? <ui.Button variant="ghost" onClick={() => onShowRuns(detail.id)}>Protokoll</ui.Button> : null}
          </div>
        </header>
        <div role="status" aria-live="polite" className="wf-sr-live">{notice}</div>
        {!w.can('workflow:manage') ? <MissingRight perm="workflow:manage" lead="Zum Bearbeiten" /> : null}
        {!automation ? <p className="wf-hint">Diese Art von Workflow folgt in einer späteren Stufe; der Editor zeigt sie noch nicht an.</p> : null}
        {save.isError && !conflict ? <ui.ErrorBox error={save.error} /> : null}
        {life.pause.isError ? <ui.ErrorBox error={life.pause.error} /> : null}
        {meta.isError ? <ui.ErrorBox error={meta.error} onRetry={() => void meta.refetch()} /> : null}
        {automation ? (
          <div className="wf-editor-grid">
            <div className="wf-editor-main">
              <div className="wf-field">
                <label htmlFor={`${nameId}-d`}>Beschreibung</label>
                <ui.Textarea id={`${nameId}-d`} rows={2} value={draft.description} disabled={readOnly} onChange={e => setDraft(x => ({ ...x, description: e.target.value }))} />
              </div>
              <TriggerEditor trigger={def.trigger} meta={meta.data} readOnly={readOnly} errors={triggerErrors} onChange={trigger => setDef({ ...def, trigger })} />
              <section className="wf-section" aria-labelledby={`${nameId}-s`}>
                <h3 id={`${nameId}-s`}>Schritte</h3>
                <StepList steps={def.steps} onChange={(steps: Step[]) => setDef({ ...def, steps })} path="/steps" number="" title="Schritte" />
              </section>
              <ValidationSummary pending={validation.isFetching} ok={!errors.length && !!validation.data} errors={otherErrors} total={errors.length} readOnly={readOnly} />
            </div>
            <aside className="wf-editor-side">
              <DryRunPanel workflowId={detail.id} definition={def} meta={meta.data} />
              <Versions workflowId={detail.id} />
            </aside>
          </div>
        ) : null}
      </div>
      {conflict ? (
        <ui.Dialog title="Inzwischen geändert" role="alertdialog" onClose={() => setConflict(false)}
          footer={<><ui.Button data-autofocus onClick={() => void reload()}>Neu laden</ui.Button><ui.Button variant="primary" onClick={() => void keepMine()}>Meine Fassung speichern</ui.Button></>}>
          <p>Jemand hat diesen Workflow gespeichert, während du ihn bearbeitet hast. Lade den neuen Stand (deine Änderungen gehen verloren) oder speichere deine Fassung darüber.</p>
        </ui.Dialog>
      ) : null}
      {dialog === 'activate' ? (
        <ActivateDialog detail={detail} definition={def} meta={meta.data} dirty={dirty} errors={errors} onClose={() => setDialog(null)}
          onActivate={async actor => {
            let revision = detail.revision;
            if (dirty) { const saved = await doSave(); if (!saved) return false; revision = saved.revision; }
            const d = await life.activate.mutateAsync({ revision, actor });
            adopt(d);
            setNotice(`Version ${d.activeVersion} ist aktiv.`);
            return true;
          }} error={life.activate.error} busy={life.activate.isPending || save.isPending} />
      ) : null}
      {dialog === 'archive' ? (
        <ui.Dialog title="Workflow archivieren?" role="alertdialog" onClose={() => setDialog(null)}
          footer={<><ui.Button data-autofocus onClick={() => setDialog(null)}>Abbrechen</ui.Button>
            <ui.Button variant="danger" disabled={life.archive.isPending} onClick={() => life.archive.mutate(undefined, { onSuccess: d => { adopt(d); setDialog(null); setNotice('Workflow archiviert.'); } })}>Archivieren</ui.Button></>}>
          <p>Der Workflow startet danach nicht mehr; laufende Läufe enden auf ihrer Version. Archivierte Workflows lassen sich nicht mehr ändern.</p>
          {life.archive.isError ? <ui.ErrorBox error={life.archive.error} /> : null}
        </ui.Dialog>
      ) : null}
      {dialog === 'delete' ? (
        <ui.Dialog title="Entwurf löschen?" role="alertdialog" onClose={() => setDialog(null)}
          footer={<><ui.Button data-autofocus onClick={() => setDialog(null)}>Abbrechen</ui.Button>
            <ui.Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(detail.revision, { onSuccess: () => { setDialog(null); onDeleted?.(); } })}>Löschen</ui.Button></>}>
          <p>Der Entwurf «{detail.name}» wird endgültig gelöscht.</p>
          {del.isError ? <ui.ErrorBox error={del.error} /> : null}
        </ui.Dialog>
      ) : null}
    </EditorCtx.Provider>
  );
}

function ValidationSummary({ pending, ok, errors, total, readOnly }: { pending: boolean; ok: boolean; errors: DefinitionError[]; total: number; readOnly: boolean }) {
  if (readOnly) return null;
  return (
    <div className="wf-validation" role="status" aria-live="polite">
      {pending ? <span className="wf-muted">Wird geprüft …</span>
        : ok ? <span className="wf-ok">Keine Fehler gefunden – der Workflow lässt sich aktivieren.</span>
          : total ? <span className="wf-bad">{total === 1 ? '1 Hinweis' : `${total} Hinweise`} – siehe die markierten Stellen.</span> : null}
      {errors.length ? <ul className="wf-step-errors" aria-label="Weitere Hinweise">{errors.map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}</ul> : null}
    </div>
  );
}

// ---------------------------------------------------------------- Aktivieren

function ActivateDialog({ detail, definition, meta, dirty, errors, onClose, onActivate, error, busy }: {
  detail: WorkflowDetail; definition: AutomationDefinition; meta: WorkflowMetaJson | undefined; dirty: boolean; errors: DefinitionError[];
  onClose: () => void; onActivate: (actor?: WorkflowActor) => Promise<boolean>; error: Error | null; busy: boolean;
}) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const [who, setWho] = useState<'me' | string>('me');
  const [clients, setClients] = useState<WorkflowActor[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const canChoose = !!meta?.canActAs && !!w.actors.clients;
  useEffect(() => {
    if (!canChoose) return;
    let live = true;
    w.actors.clients!().then(c => { if (live) setClients(c); }, () => { if (live) setClients([]); });
    return () => { live = false; };
  }, [canChoose, w.actors]);
  const t = definition.trigger;
  const actor = who === 'me' ? undefined : clients?.find(c => c.id === who);
  const blocked = errors.length > 0;
  const go = async () => {
    setFailed(null);
    try { if (await onActivate(actor ? { id: actor.id, kind: actor.kind } : undefined)) onClose(); } catch (e) { setFailed(e); }
  };
  return (
    <ui.Dialog title="Workflow aktivieren" onClose={onClose} width={560}
      footer={<><ui.Button onClick={onClose}>Abbrechen</ui.Button><ui.Button variant="primary" data-autofocus disabled={blocked || busy} onClick={() => void go()}>{busy ? 'Bitte warten …' : 'Aktivieren'}</ui.Button></>}>
      <dl className="wf-summary">
        <dt>Workflow</dt><dd>{detail.name}</dd>
        <dt>Neue Version</dt><dd>{(detail.activeVersion ?? 0) + 1}{detail.activeVersion ? ` (ersetzt Version ${detail.activeVersion}; laufende Läufe bleiben auf ihrer Version)` : ''}</dd>
        <dt>Auslöser</dt><dd>{describeTrigger(t, meta)}</dd>
        {'schedule' in t ? <><dt>Zeitplan</dt><dd>{describeCron(t.schedule.cron) ?? t.schedule.cron} · Zeitzone {t.schedule.timezone}</dd></> : null}
        <dt>Schritte</dt><dd>{[...walk(definition.steps)].length}</dd>
      </dl>
      <fieldset className="wf-field">
        <legend>Akteur: in wessen Namen der Workflow handelt</legend>
        <div className="wf-check-row">
          <input type="radio" className="wf-check" id={`${id}-me`} name={`${id}-who`} checked={who === 'me'} onChange={() => setWho('me')} />
          <label htmlFor={`${id}-me`}>Ich selbst ({actorName(w, w.me)})</label>
        </div>
        {canChoose && clients?.map(c => (
          <div key={c.id} className="wf-check-row">
            <input type="radio" className="wf-check" id={`${id}-${c.id}`} name={`${id}-who`} checked={who === c.id} onChange={() => setWho(c.id)} />
            <label htmlFor={`${id}-${c.id}`}>{actorName(w, c)}</label>
          </div>
        ))}
        <p className="wf-hint">Jeder Schritt prüft die Rechte dieses Akteurs. Fehlt ein Recht oder ist der Akteur nicht mehr aktiv, hält der Lauf an.</p>
      </fieldset>
      {dirty ? <p className="wf-hint">Ungespeicherte Änderungen werden vorher gespeichert.</p> : null}
      {blocked ? <p className="wf-bad" role="alert">Zuerst die {errors.length === 1 ? 'markierte Stelle' : `${errors.length} markierten Stellen`} beheben.</p> : null}
      {failed || error ? <ui.ErrorBox error={failed ?? error} /> : null}
    </ui.Dialog>
  );
}

// ---------------------------------------------------------------- Versionen

function Versions({ workflowId }: { workflowId: string }) {
  const w = useWorkflow();
  const v = useWorkflowVersions(workflowId);
  if (!v.data?.items.length) return null;
  return (
    <details className="wf-section">
      <summary>Versionen ({v.data.items.length})</summary>
      <ul className="wf-plain">
        {v.data.items.map(x => (
          <li key={x.version}>
            <b>Version {x.version}</b>{x.active ? ' · aktiv' : ''} · {fmtDateTime(x.activatedAt)} · Akteur {actorName(w, x.actor)}
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------- Probelauf

const RESULT_LABEL: Record<DryRunJson['result'], string> = { completed: 'würde erfolgreich enden', failed: 'würde scheitern', cancelled: 'würde abgebrochen', limit: 'würde an eine Grenze stossen' };

function DryRunPanel({ workflowId, definition, meta }: { workflowId: string; definition: AutomationDefinition; meta: WorkflowMetaJson | undefined }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const run = useDryRun(workflowId);
  const t = definition.trigger;
  const eventType = 'event' in t ? t.event : '';
  const [mode, setMode] = useState<'subject' | 'event'>('subject');
  const [type, setType] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; title: string }[] | null>(null);
  const [eventJson, setEventJson] = useState(() => JSON.stringify({ type: eventType, subject: null, data: {} }, null, 2));
  const [inputJson, setInputJson] = useState('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const types = meta?.subjectTypes ?? [];
  const evSubject = meta?.events.find(e => e.type === eventType)?.subjectType;
  const subjectType = type || evSubject || types[0]?.type || '';
  const cfg = w.subjects[subjectType];
  const search = async () => { if (cfg?.search) setHits(await cfg.search(q)); };
  const start = () => {
    setJsonError(null);
    try {
      const body: Parameters<typeof run.mutate>[0] = { definition };
      if (mode === 'event') {
        const ev = JSON.parse(eventJson) as { type?: string; subject?: { type: string; id: string } | null; data?: Record<string, unknown> };
        if (!ev || typeof ev.type !== 'string') throw new Error('type');
        body.event = { type: ev.type, subject: ev.subject ?? null, data: ev.data ?? {} };
      } else if (subjectId) body.subject = { type: subjectType, id: subjectId };
      if ('manual' in t) body.input = JSON.parse(inputJson || '{}') as Record<string, unknown>;
      run.mutate(body);
    } catch { setJsonError('Bitte gültiges JSON eingeben (beim Ereignis mit «type»).'); }
  };
  return (
    <section className="wf-section wf-dryrun" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Probelauf</h3>
      <p className="wf-hint">Zeigt je Schritt, was geschähe – ohne etwas zu ändern. Verwendet den Entwurf, wie er jetzt dasteht.</p>
      <div className="wf-row" role="radiogroup" aria-label="Probelauf mit">
        <span className="wf-check-row"><input type="radio" className="wf-check" id={`${id}-ms`} checked={mode === 'subject'} onChange={() => setMode('subject')} /><label htmlFor={`${id}-ms`}>Bezug wählen</label></span>
        <span className="wf-check-row"><input type="radio" className="wf-check" id={`${id}-me`} checked={mode === 'event'} onChange={() => setMode('event')} /><label htmlFor={`${id}-me`}>Ereignis als JSON</label></span>
      </div>
      {mode === 'subject' ? (
        <>
          {types.length > 1 ? (
            <div className="wf-field">
              <label htmlFor={`${id}-t`}>Art des Bezugs</label>
              <ui.Select id={`${id}-t`} value={subjectType} onChange={e => { setType(e.target.value); setHits(null); setSubjectId(''); }}>
                {types.map(s => <option key={s.type} value={s.type}>{w.subjects[s.type]?.label ?? s.label}</option>)}
              </ui.Select>
            </div>
          ) : null}
          {cfg?.search ? (
            <div className="wf-field">
              <label htmlFor={`${id}-q`}>{`${cfg.label} suchen`}</label>
              <div className="wf-row">
                <ui.Input id={`${id}-q`} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
                <ui.Button size="sm" onClick={() => void search()}>Suchen</ui.Button>
              </div>
              {hits ? (
                hits.length ? (
                  <ul className="wf-plain" aria-label="Treffer">
                    {hits.map(h => (
                      <li key={h.id}><ui.Button size="sm" variant={subjectId === h.id ? 'primary' : 'ghost'} aria-pressed={subjectId === h.id} onClick={() => setSubjectId(h.id)}>{h.title}</ui.Button></li>
                    ))}
                  </ul>
                ) : <p className="wf-muted wf-small">Keine Treffer.</p>
              ) : null}
            </div>
          ) : (
            <div className="wf-field">
              <label htmlFor={`${id}-i`}>{`ID ${cfg ? `(${cfg.label})` : 'des Bezugs'}`}</label>
              <ui.Input id={`${id}-i`} value={subjectId} onChange={e => setSubjectId(e.target.value)} />
            </div>
          )}
        </>
      ) : (
        <div className="wf-field">
          <label htmlFor={`${id}-ev`}>Ereignis (JSON mit type, subject, data)</label>
          <ui.Textarea id={`${id}-ev`} rows={6} value={eventJson} onChange={e => setEventJson(e.target.value)} />
        </div>
      )}
      {'manual' in t ? (
        <div className="wf-field">
          <label htmlFor={`${id}-in`}>Eingabe beim Start (JSON)</label>
          <ui.Textarea id={`${id}-in`} rows={3} value={inputJson} onChange={e => setInputJson(e.target.value)} />
        </div>
      ) : null}
      <ui.Button variant="primary" disabled={run.isPending || !w.can('workflow:manage')} onClick={start}>{run.isPending ? 'Probelauf läuft …' : 'Probelauf starten'}</ui.Button>
      {jsonError ? <p className="wf-bad" role="alert">{jsonError}</p> : null}
      {run.isError ? <ui.ErrorBox error={run.error} /> : null}
      {run.data ? <DryRunResult result={run.data} /> : null}
    </section>
  );
}

function DryRunResult({ result }: { result: DryRunJson }) {
  return (
    <div className="wf-dryrun-result" aria-label="Ergebnis des Probelaufs" role="region">
      {result.triggerMatches !== null ? <p>{result.triggerMatches ? 'Das Ereignis passt zum Filter des Auslösers.' : 'Das Ereignis passt nicht zum Filter: Der Workflow würde nicht starten.'}</p> : null}
      <p><b>Ergebnis:</b> {RESULT_LABEL[result.result]}</p>
      <ol className="wf-plain">
        {result.steps.map((s, i) => (
          <li key={i} className={s.error || s.allowed === false ? 'bad' : ''}>
            <b>{s.label ?? s.stepId}</b>: {s.summary}
            {s.allowed === false ? <div className="wf-bad">Dem Akteur fehlen Rechte: {(s.missing ?? []).join(', ')}</div> : null}
            {s.error ? <div className="wf-bad">{s.error.message}</div> : null}
            <Json value={s.input} label="Eingabe" />
            <Json value={s.output} label="Ausgabe" />
          </li>
        ))}
      </ol>
      {Object.keys(result.variables).length ? <Json value={result.variables} label="Variablen am Ende" /> : null}
    </div>
  );
}
