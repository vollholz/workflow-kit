/**
 * Editor eines Workflows (Konzept Abschnitt 10, W4; UX-Neukonzept Etappen 1 und 2): Kopf mit Name und einem Satz zum
 * Workflow, Statusleiste (aktive Version, Entwurf, Hauptaktion je Zustand), darunter links der Ablauf (Start,
 * Schritte mit Wegen, «+» an jeder Stelle) und rechts der Detailbereich: Auslöser, Formular des gewählten Schritts,
 * Auswahl eines neuen Schritts oder – im Modus «Probelauf» – der Probelauf.
 *
 * Regeln:
 * - Bearbeitet wird immer der Entwurf. Er speichert sich selbst (entprellt, `If-Match` mit dem Stand); solange etwas
 *   nicht gespeichert ist, fragt der Browser beim Verlassen nach. Hat jemand anderes inzwischen gespeichert, fragt der
 *   Editor: neu laden (eigene Änderungen verwerfen) oder eigene Fassung über den neuen Stand speichern.
 * - Statusleiste mit genau einer Hauptaktion je Zustand: «Aktivieren …» (nie aktiviert), «Version n aktivieren …»
 *   (Entwurf weicht von der aktiven Version ab), «Fortsetzen» (pausiert, gleiche Version). Daneben Verwerfen,
 *   Pausieren, Archivieren, Löschen. Was wirkt, ändert nur das Aktivieren.
 * - Prüfung live: Nach jeder Änderung (verzögert) prüft `POST /workflows/validate`; Meldungen stehen am Schritt.
 *   Knöpfe sind nicht vorab gesperrt: Aktivieren nennt offene Stellen im Dialog.
 * - Ein entfernter Schritt lässt sich mit «Rückgängig» zurückholen; der Fokus springt auf diesen Knopf.
 * - Einfügen, Entfernen und Verschieben laufen über Pfade (`flow.tsx`); nach dem Einfügen ist der neue Schritt gewählt.
 * - Versionen und Name/Beschreibung stehen in eigenen Bausteinen (`VersionList`, `WorkflowSettings`); mit
 *   `onOpenSettings` öffnet «Name und Beschreibung …» diese statt des Dialogs.
 * - Probelauf und Hinweise nennen Schritte mit Nummer und Titel, nicht mit ihrer ID.
 * - Ohne `workflow:manage` (oder archiviert, oder eine Art späterer Stufen) ist alles nur lesbar.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  useDeleteWorkflow, useDryRun, useSaveWorkflow, useValidateDefinition, useWorkflowDetail, useWorkflowLifecycle, useWorkflowMeta, useWorkflowVersion,
} from './api.ts';
import { FlowView, listAt, numberOf, splitPath, StepDetail, stepAt, StepPicker, withList, type FlowSelection } from './flow.tsx';
import { contextFields, walk } from './placeholders.tsx';
import { ActorName, useWorkflow, type WorkflowActor } from './provider.tsx';
import { EditorCtx, placeOfPath, stepNumberOfPath, stepTitle, type EditorContext } from './steps.tsx';
import { describeCron, describeTrigger, TriggerEditor } from './trigger.tsx';
import type { AutomationDefinition, DefinitionError, DryRunJson, Step, WorkflowDefinition, WorkflowDetail, WorkflowMetaJson } from './types.ts';
import { Badge, fmtTime, MissingRight, STATE_LABEL, stateTone, WorkflowApiError } from './ui.tsx';

export interface StepListEditorProps {
  workflowId?: string | null;
  /** Nach dem Löschen eines Entwurfs. */
  onDeleted?: () => void;
  /** Läufe des Workflows öffnen. */
  onShowRuns?: (workflowId: string) => void;
  /** Verzögerung der Live-Prüfung in ms (Standard 400). */
  validateDelayMs?: number;
  /** Verzögerung des automatischen Speicherns in ms (Standard 800). */
  saveDelayMs?: number;
  /** Name als Überschrift zeigen (Standard `true`); `false`, wenn die App ihn im Seitenkopf zeigt. */
  showTitle?: boolean;
  /** Einstellungen des Workflows öffnen (Name, Beschreibung); ohne Angabe ein Dialog im Editor. */
  onOpenSettings?: () => void;
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

export function StepListEditor({ workflowId, onDeleted, onShowRuns, validateDelayMs = 400, saveDelayMs = 800, showTitle = true, onOpenSettings }: StepListEditorProps) {
  const w = useWorkflow();
  const { ui } = w;
  const detail = useWorkflowDetail(workflowId);
  if (!workflowId) return <ui.Empty title="Kein Workflow gewählt">Wähle einen Workflow aus der Liste oder lege einen neuen an.</ui.Empty>;
  if (detail.isPending) return <ui.Loading label="Workflow wird geladen …" />;
  if (detail.isError) return <ui.ErrorBox error={detail.error} onRetry={() => void detail.refetch()} />;
  return (
    <EditorLoaded key={detail.data.id} detail={detail.data} refetch={async () => (await detail.refetch()).data} onDeleted={onDeleted} onShowRuns={onShowRuns}
      validateDelayMs={validateDelayMs} saveDelayMs={saveDelayMs} showTitle={showTitle} onOpenSettings={onOpenSettings} />
  );
}

type DialogName = 'activate' | 'archive' | 'delete' | 'discard' | 'details';

function EditorLoaded({ detail, refetch, onDeleted, onShowRuns, validateDelayMs, saveDelayMs, showTitle, onOpenSettings }: {
  detail: WorkflowDetail; refetch: () => Promise<WorkflowDetail | undefined>; onDeleted?: () => void; onShowRuns?: (id: string) => void;
  validateDelayMs: number; saveDelayMs: number; showTitle: boolean; onOpenSettings?: () => void;
}) {
  const w = useWorkflow();
  const { ui } = w;
  const meta = useWorkflowMeta(detail.scope);
  const [draft, setDraft] = useState<Draft>(() => draftOf(detail));
  const [base, setBase] = useState<Draft>(() => draftOf(detail));
  const [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ label: string; definition: WorkflowDefinition } | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const [sel, setSel] = useState<FlowSelection>({ kind: 'trigger' });
  const [mode, setMode] = useState<'edit' | 'sim'>('edit');
  const detailRef = useRef<HTMLElement>(null);
  const openDetail = useRef(false);
  const save = useSaveWorkflow(detail.id);
  const life = useWorkflowLifecycle(detail.id);
  const del = useDeleteWorkflow(detail.id);
  const activeVersion = useWorkflowVersion(detail.id, detail.state === 'archived' ? null : detail.activeVersion);
  const draftKey = canonical(draft);
  const dirty = draftKey !== canonical(base);
  const automation = isAutomation(draft.definition);
  const readOnly = !w.can('workflow:manage') || detail.state === 'archived' || !automation;
  const saving = save.isPending;
  const debounced = useDebounced(automation ? draft.definition : null, validateDelayMs);
  const validation = useValidateDefinition(readOnly ? null : debounced);
  const errors: DefinitionError[] = useMemo(() => [...(validation.data?.errors ?? []), ...(validation.data?.stage ?? [])], [validation.data]);
  const ids = useRef(new Set<string>());
  ids.current = new Set(automation ? [...walk((draft.definition as AutomationDefinition).steps)].map(s => s.id) : []);
  const latest = useRef({ draft, revision: detail.revision });
  latest.current = { draft, revision: detail.revision };
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
  const setDefinition = (d: WorkflowDefinition) => setDraft(x => ({ ...x, definition: d }));
  const adopt = (d: WorkflowDetail) => { setDraft(draftOf(d)); setBase(draftOf(d)); };
  const steps = automation ? def.steps : [];
  const setSteps = (next: Step[]) => setDefinition({ ...def, steps: next });

  // Ablauf: Einfügen, Entfernen, Verschieben über Pfade; die Auswahl folgt dem Schritt.
  const insert = (list: string, index: number, step: Step) => {
    setSteps(withList(steps, list, l => [...l.slice(0, index), step, ...l.slice(index)]));
    setSel({ kind: 'step', path: `${list}/${index}` });
    openDetail.current = true;
  };
  const remove = (path: string) => {
    const step = stepAt(steps, path);
    if (!step) return;
    const { list, index } = splitPath(path);
    setRemoved({ label: `Schritt ${numberOf(path)} (${stepTitle(step, meta.data)})`, definition: latest.current.draft.definition });
    const rest = (listAt(steps, list) ?? []).length - 1;
    setSteps(withList(steps, list, l => l.filter((_, j) => j !== index)));
    setSel(rest > 0 ? { kind: 'step', path: `${list}/${Math.min(index, rest - 1)}` } : list === '/steps' ? { kind: 'trigger' } : { kind: 'step', path: list.slice(0, list.lastIndexOf('/')) });
  };
  const move = (path: string, delta: -1 | 1): string | null => {
    const { list, index } = splitPath(path);
    const items = listAt(steps, list) ?? [];
    const j = index + delta;
    if (j < 0 || j >= items.length) return null;
    setSteps(withList(steps, list, l => { const n = [...l]; [n[index], n[j]] = [n[j]!, n[index]!]; return n; }));
    const next = `${list}/${j}`;
    setSel({ kind: 'step', path: next });
    return next;
  };
  const selected = sel.kind === 'step' ? stepAt(steps, sel.path) : undefined;
  useEffect(() => {
    if (!openDetail.current) return;
    openDetail.current = false;
    detailRef.current?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])')?.focus();
  }, [sel]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Speichert den Entwurf, wie er jetzt dasteht; gespeichert ist danach genau das Gesendete. */
  const doSave = async (revision = latest.current.revision): Promise<WorkflowDetail | null> => {
    const sent = latest.current.draft;
    try {
      const d = await save.mutateAsync({ revision, name: sent.name, description: sent.description || null, definition: sent.definition });
      setBase(sent);
      setSavedAt(new Date());
      setFailed(null);
      return d;
    } catch (e) {
      if (e instanceof WorkflowApiError && e.conflict && detail.state !== 'archived') setConflict(true);
      else setFailed(canonical(sent));
      return null;
    }
  };
  const doSaveRef = useRef(doSave);
  doSaveRef.current = doSave;

  // Automatisch speichern: nach einer Pause im Tippen, nie während eines Konflikts oder nach einem Fehler mit demselben Stand.
  useEffect(() => {
    if (readOnly || !dirty || conflict || saving || failed === draftKey) return;
    const t = setTimeout(() => void doSaveRef.current(), saveDelayMs);
    return () => clearTimeout(t);
  }, [draftKey, dirty, readOnly, conflict, saving, failed, saveDelayMs]);

  // Beim Verlassen mit ungespeicherten Änderungen nachfragen (Browser); beim Abbauen des Editors noch speichern.
  const unsaved = !readOnly && (dirty || saving);
  useEffect(() => {
    if (!unsaved) return;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [unsaved]);
  const flush = useRef(() => {});
  flush.current = () => { if (!readOnly && dirty && !conflict && !saving) void doSaveRef.current(); };
  useEffect(() => () => flush.current(), []);

  useEffect(() => { if (removed) undoRef.current?.focus(); }, [removed]);

  const reload = async () => { const d = await refetch(); if (d) adopt(d); setConflict(false); save.reset(); };
  // Der Konflikt bleibt bis nach dem Speichern bestehen, damit das automatische Speichern nicht dazwischenfährt.
  const keepMine = async () => { const d = await refetch(); save.reset(); if (d && await doSave(d.revision)) setConflict(false); };

  const triggerErrors = errors.filter(e => e.path.startsWith('/trigger'));
  const otherErrors = errors.filter(e => !e.path.startsWith('/trigger') && !e.path.startsWith('/steps/'));
  const versionDef = activeVersion.data?.definition;
  const differs = !!versionDef && canonical(versionDef) !== canonical(draft.definition);
  const canActivate = w.can('workflow:activate') && automation;
  const canManage = w.can('workflow:manage');
  const nextVersion = (detail.activeVersion ?? 0) + 1;

  const pause = () => life.pause.mutate(undefined, { onSuccess: d => { adopt(d); setNotice('Workflow pausiert.'); } });
  const resume = () => life.resume.mutate(undefined, { onSuccess: d => { adopt(d); setNotice(`Workflow läuft wieder mit Version ${d.activeVersion}.`); } });
  const activateLabel = detail.activeVersion === null ? 'Aktivieren …' : `Version ${nextVersion} aktivieren …`;

  // Statusleiste: Text und Aktionen je Zustand.
  let tone: 'accent' | 'ok' | 'info' | 'warn' | 'muted';
  let text: ReactNode;
  let primary: ReactNode = null;
  const more: ReactNode[] = [];
  const btnPause = w.can('workflow:activate') ? <ui.Button key="pause" size="sm" disabled={life.pause.isPending} onClick={pause}>Pausieren</ui.Button> : null;
  const btnArchive = w.can('workflow:activate') ? <ui.Button key="archive" size="sm" variant="ghost" onClick={() => setDialog('archive')}>Archivieren …</ui.Button> : null;
  const btnActivate = (variant: 'primary' | 'default') => (canActivate ? <ui.Button key="activate" size="sm" variant={variant} onClick={() => setDialog('activate')}>{activateLabel}</ui.Button> : null);
  if (detail.state === 'archived') {
    tone = 'muted';
    text = <><b>Archiviert.</b> Der Workflow startet nicht mehr und lässt sich nur noch lesen.</>;
  } else if (detail.activeVersion === null) {
    tone = 'accent';
    text = <><b>Noch nie aktiviert.</b> Der Entwurf speichert sich selbst; er wirkt erst nach dem Aktivieren.</>;
    primary = btnActivate('primary');
    if (canManage) more.push(<ui.Button key="delete" size="sm" variant="ghost" onClick={() => setDialog('delete')}>Löschen …</ui.Button>);
  } else if (detail.state === 'paused') {
    tone = 'warn';
    text = <><b>Pausiert{detail.pausedReason ? `: ${detail.pausedReason}` : ''}.</b> Version {detail.activeVersion} startet keine neuen Läufe{differs ? '; der Entwurf weicht von ihr ab' : ''}.</>;
    primary = w.can('workflow:activate') ? <ui.Button size="sm" variant="primary" disabled={life.resume.isPending} onClick={resume}>Fortsetzen</ui.Button> : null;
    if (differs) more.push(btnActivate('default'));
    more.push(btnArchive);
  } else if (differs) {
    tone = 'info';
    text = <><b>Der Entwurf weicht von Version {detail.activeVersion} ab</b> und wirkt erst nach dem Aktivieren.</>;
    primary = btnActivate('primary');
    if (canManage) more.push(<ui.Button key="discard" size="sm" variant="ghost" onClick={() => setDialog('discard')}>Verwerfen …</ui.Button>);
    more.push(btnPause, btnArchive);
  } else {
    tone = 'ok';
    text = <><b>Aktiv mit Version {detail.activeVersion}.</b> Keine offenen Änderungen.</>;
    more.push(btnPause, btnArchive);
  }
  const saveState: ReactNode = readOnly || conflict ? null
    : saving ? 'Speichert …'
      : failed === draftKey ? <>Nicht gespeichert. <button type="button" className="wf-link" onClick={() => void doSave()}>Erneut versuchen</button></>
        : dirty ? 'Wird gleich gespeichert …'
          : savedAt ? `Gespeichert um ${fmtTime(savedAt)}` : 'Alle Änderungen gespeichert';

  return (
    <EditorCtx.Provider value={ctx}>
      <div className="wf-editor">
        <header className="wf-editor-head">
          <div className="wf-grow">
            {showTitle ? <h2 className="wf-editor-title">{draft.name}</h2> : null}
            <p className="wf-editor-sentence">
              {automation ? describeTrigger(def.trigger, meta.data) : null}
              {automation ? ' · ' : null}{w.scopeLabel(detail.scope)}
              {' · '}{detail.actor ? <>handelt als <ActorName actor={detail.actor} /></> : 'handelt als: wird beim Aktivieren gewählt'}
            </p>
            {draft.description ? <p className="wf-editor-desc">{draft.description}</p> : null}
          </div>
          <div className="wf-editor-actions">
            <Badge tone={stateTone(detail.state)}>{STATE_LABEL[detail.state]}{detail.activeVersion ? ` · Version ${detail.activeVersion}` : ''}</Badge>
            {!readOnly ? <ui.Button size="sm" variant="ghost" onClick={() => (onOpenSettings ? onOpenSettings() : setDialog('details'))}>Name und Beschreibung …</ui.Button> : null}
            {onShowRuns ? <ui.Button size="sm" variant="ghost" onClick={() => onShowRuns(detail.id)}>Läufe ansehen</ui.Button> : null}
          </div>
        </header>
        <div className={`wf-life ${tone}`} role="group" aria-label="Zustand des Workflows">
          <p className="wf-life-text">{text}</p>
          <div className="wf-life-actions">{more}{primary}</div>
          {saveState ? <p className="wf-life-save" aria-live="polite">{saveState}</p> : null}
        </div>
        <div role="status" aria-live="polite" className="wf-sr-live">{notice}</div>
        {!canManage ? <MissingRight perm="workflow:manage" lead="Zum Bearbeiten" /> : null}
        {!automation ? <p className="wf-hint">Diese Art von Workflow folgt in einer späteren Stufe; der Editor zeigt sie noch nicht an.</p> : null}
        {failed === draftKey && save.isError ? <ui.ErrorBox error={save.error} /> : null}
        {life.pause.isError ? <ui.ErrorBox error={life.pause.error} /> : null}
        {life.resume.isError ? <ui.ErrorBox error={life.resume.error} /> : null}
        {meta.isError ? <ui.ErrorBox error={meta.error} onRetry={() => void meta.refetch()} /> : null}
        {automation ? (
          <>
            <div className="wf-editor-tools">
              <div className="wf-seg" role="group" aria-label="Ansicht">
                <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>Bearbeiten</button>
                <button type="button" aria-pressed={mode === 'sim'} onClick={() => setMode('sim')}>Probelauf</button>
              </div>
              <ValidationSummary pending={validation.isFetching} ok={!errors.length && !!validation.data} errors={otherErrors} total={errors.length} readOnly={readOnly} />
            </div>
            <div className="wf-editor-grid">
              <div className="wf-editor-main">
                <FlowView steps={steps} trigger={describeTrigger(def.trigger, meta.data)} sel={sel}
                  onSelect={s => { setSel(s); if (mode === 'sim') setMode('edit'); }} onMove={move} onRemove={remove} onOpen={() => { openDetail.current = true; setSel(x => ({ ...x })); }} />
                {removed ? (
                  <div className="wf-undo" role="status">
                    <span className="wf-grow">{`${removed.label} entfernt.`}</span>
                    <ui.Button ref={undoRef} size="sm" onClick={() => { setDefinition(removed.definition); setRemoved(null); setNotice('Schritt wiederhergestellt.'); }}>Rückgängig</ui.Button>
                    <ui.Button size="sm" variant="ghost" aria-label="Hinweis schliessen" onClick={() => setRemoved(null)}>✕</ui.Button>
                  </div>
                ) : null}
              </div>
              <aside className="wf-editor-side wf-detail" ref={detailRef} aria-label={mode === 'sim' ? 'Probelauf' : 'Detail'}>
                {mode === 'sim' ? <DryRunPanel workflowId={detail.id} definition={def} meta={meta.data} />
                  : sel.kind === 'insert' ? (
                    <StepPicker where={sel.list === '/steps' && sel.index === 0 ? 'am Anfang' : sel.index === 0 ? `am Anfang von ${laneName(sel.list)}` : `nach Schritt ${numberOf(`${sel.list}/${sel.index - 1}`)}`}
                      onPick={step => insert(sel.list, sel.index, step)} onCancel={() => setSel({ kind: 'trigger' })} />
                  ) : selected && sel.kind === 'step' ? (
                    <StepDetail key={sel.path} step={selected} path={sel.path} last={splitPath(sel.path).index >= (listAt(steps, splitPath(sel.path).list)?.length ?? 1) - 1}
                      onChange={s => { const { list, index } = splitPath(sel.path); setSteps(withList(steps, list, l => l.map((x, j) => (j === index ? s : x)))); }}
                      onRemove={() => remove(sel.path)} onMove={d => { move(sel.path, d); }} />
                  ) : (
                    <TriggerEditor trigger={def.trigger} meta={meta.data} readOnly={readOnly} errors={triggerErrors} onChange={trigger => setDefinition({ ...def, trigger })} />
                  )}
              </aside>
            </div>
          </>
        ) : null}
      </div>
      {conflict ? (
        <ui.Dialog title="Inzwischen geändert" role="alertdialog" onClose={() => setConflict(false)}
          footer={<><ui.Button data-autofocus onClick={() => void reload()}>Neu laden</ui.Button><ui.Button variant="primary" onClick={() => void keepMine()}>Meine Fassung speichern</ui.Button></>}>
          <p>Jemand hat diesen Workflow gespeichert, während du ihn bearbeitet hast. Lade den neuen Stand (deine Änderungen gehen verloren) oder speichere deine Fassung darüber.</p>
        </ui.Dialog>
      ) : null}
      {dialog === 'details' ? (
        <DetailsDialog name={draft.name} description={draft.description} onClose={() => setDialog(null)}
          onApply={(name, description) => { setDraft(x => ({ ...x, name, description })); setDialog(null); }} />
      ) : null}
      {dialog === 'activate' ? (
        <ActivateDialog detail={detail} definition={def} meta={meta.data} dirty={dirty} errors={errors} onClose={() => setDialog(null)}
          onActivate={async actor => {
            let revision = detail.revision;
            if (dirty || saving) { const saved = await doSave(); if (!saved) return false; revision = saved.revision; }
            const d = await life.activate.mutateAsync({ revision, actor });
            adopt(d);
            setNotice(`Version ${d.activeVersion} ist aktiv.`);
            return true;
          }} error={life.activate.error} busy={life.activate.isPending || saving} />
      ) : null}
      {dialog === 'discard' && versionDef ? (
        <ui.Dialog title="Entwurf verwerfen?" role="alertdialog" onClose={() => setDialog(null)}
          footer={<><ui.Button data-autofocus onClick={() => setDialog(null)}>Abbrechen</ui.Button>
            <ui.Button variant="danger" onClick={() => { setDefinition(versionDef); setDialog(null); setNotice(`Entwurf verworfen; er entspricht wieder Version ${detail.activeVersion}.`); }}>Verwerfen</ui.Button></>}>
          <p>Deine Änderungen an Auslöser und Schritten gehen verloren; der Entwurf entspricht danach wieder Version {detail.activeVersion}. Version {detail.activeVersion} läuft unverändert weiter.</p>
        </ui.Dialog>
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
      {errors.length ? <ul className="wf-step-errors" aria-label="Weitere Hinweise">{errors.map((e, i) => <li key={i}>{placeOfPath(e.path)}: {e.message}</li>)}</ul> : null}
    </div>
  );
}

// ---------------------------------------------------------------- Name und Beschreibung

function DetailsDialog({ name, description, onClose, onApply }: { name: string; description: string; onClose: () => void; onApply: (name: string, description: string) => void }) {
  const { ui } = useWorkflow();
  const id = useId();
  const [n, setN] = useState(name);
  const [d, setD] = useState(description);
  const [missing, setMissing] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const apply = () => {
    if (!n.trim()) { setMissing(true); nameRef.current?.focus(); return; }
    onApply(n.trim(), d);
  };
  return (
    <ui.Dialog title="Name und Beschreibung" onClose={onClose} width={520}
      footer={<><ui.Button onClick={onClose}>Abbrechen</ui.Button><ui.Button variant="primary" onClick={apply}>Übernehmen</ui.Button></>}>
      <form onSubmit={e => { e.preventDefault(); apply(); }}>
        <div className="wf-field">
          <label htmlFor={`${id}-n`}>Name des Workflows</label>
          <ui.Input ref={nameRef} id={`${id}-n`} data-autofocus value={n} aria-invalid={missing || undefined} aria-describedby={missing ? `${id}-ne` : undefined}
            onChange={e => { setN(e.target.value); setMissing(false); }} />
          {missing ? <span id={`${id}-ne`} className="wf-field-error">Gib einen Namen ein.</span> : null}
        </div>
        <div className="wf-field">
          <label htmlFor={`${id}-d`}>Beschreibung</label>
          <ui.Textarea id={`${id}-d`} className="wf-prose" rows={3} value={d} onChange={e => setD(e.target.value)} />
        </div>
      </form>
    </ui.Dialog>
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
  const [tried, setTried] = useState(false);
  const canChoose = !!meta?.canActAs && !!w.actors.clients;
  useEffect(() => {
    if (!canChoose) return;
    let live = true;
    w.actors.clients!().then(c => { if (live) setClients(c); }, () => { if (live) setClients([]); });
    return () => { live = false; };
  }, [canChoose, w.actors]);
  const t = definition.trigger;
  const actor = who === 'me' ? undefined : clients?.find(c => c.id === who);
  const version = (detail.activeVersion ?? 0) + 1;
  const title = detail.activeVersion === null ? 'Workflow aktivieren' : `Version ${version} aktivieren`;
  const go = async () => {
    setFailed(null);
    if (errors.length) { setTried(true); return; }
    try { if (await onActivate(actor ? { id: actor.id, kind: actor.kind } : undefined)) onClose(); } catch (e) { setFailed(e); }
  };
  return (
    <ui.Dialog title={title} onClose={onClose} width={560}
      footer={<><ui.Button onClick={onClose}>Abbrechen</ui.Button><ui.Button variant="primary" data-autofocus aria-disabled={busy || undefined} onClick={() => { if (!busy) void go(); }}>{busy ? 'Bitte warten …' : detail.activeVersion === null ? 'Aktivieren' : title}</ui.Button></>}>
      <dl className="wf-summary">
        <dt>Workflow</dt><dd>{detail.name}</dd>
        <dt>Neue Version</dt><dd>{version}{detail.activeVersion ? ` (ersetzt Version ${detail.activeVersion}; laufende Läufe bleiben auf ihrer Version)` : ''}</dd>
        <dt>Auslöser</dt><dd>{describeTrigger(t, meta)}</dd>
        {'schedule' in t ? <><dt>Zeitplan</dt><dd>{describeCron(t.schedule.cron) ?? t.schedule.cron} · Zeitzone {t.schedule.timezone}</dd></> : null}
        <dt>Schritte</dt><dd>{[...walk(definition.steps)].length}</dd>
      </dl>
      <fieldset className="wf-field">
        <legend>Handelt als: in wessen Namen der Workflow handelt</legend>
        <div className="wf-check-row">
          <input type="radio" className="wf-check" id={`${id}-me`} name={`${id}-who`} checked={who === 'me'} onChange={() => setWho('me')} />
          <label htmlFor={`${id}-me`}>Ich selbst (<ActorName actor={w.me} />)</label>
        </div>
        {canChoose && clients?.map(c => (
          <div key={c.id} className="wf-check-row">
            <input type="radio" className="wf-check" id={`${id}-${c.id}`} name={`${id}-who`} checked={who === c.id} onChange={() => setWho(c.id)} />
            <label htmlFor={`${id}-${c.id}`}><ActorName actor={c} /></label>
          </div>
        ))}
        <p className="wf-hint">Jeder Schritt prüft die Rechte dieses Akteurs. Fehlt ein Recht oder ist der Akteur nicht mehr aktiv, hält der Lauf an.</p>
      </fieldset>
      {dirty ? <p className="wf-hint">Ungespeicherte Änderungen werden vorher gespeichert.</p> : null}
      {errors.length && !tried ? <p className="wf-hint">{errors.length === 1 ? 'Die Prüfung meldet noch 1 offene Stelle.' : `Die Prüfung meldet noch ${errors.length} offene Stellen.`}</p> : null}
      {errors.length && tried ? (
        <div className="wf-bad" role="alert">
          <p>{errors.length === 1 ? 'Zuerst diese Stelle beheben:' : `Zuerst diese ${errors.length} Stellen beheben:`}</p>
          <ul>{errors.map((e, i) => <li key={i}>{placeOfPath(e.path)}: {e.message}</li>)}</ul>
        </div>
      ) : null}
      {failed || error ? <ui.ErrorBox error={failed ?? error} /> : null}
    </ui.Dialog>
  );
}

// ---------------------------------------------------------------- Probelauf

const laneName = (list: string) => (list.endsWith('/then') ? `«Dann» in Schritt ${numberOf(list.slice(0, list.lastIndexOf('/')))}` : list.endsWith('/else') ? `«Sonst» in Schritt ${numberOf(list.slice(0, list.lastIndexOf('/')))}` : `der Schleife in Schritt ${numberOf(list.slice(0, list.lastIndexOf('/')))}`);

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
  const [chosen, setChosen] = useState<{ id: string; title: string } | null>(null);
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
      } else {
        const sid = cfg?.search ? chosen?.id : subjectId;
        if (sid) body.subject = { type: subjectType, id: sid };
      }
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
              <ui.Select id={`${id}-t`} value={subjectType} onChange={e => { setType(e.target.value); setHits(null); setChosen(null); setSubjectId(''); }}>
                {types.map(s => <option key={s.type} value={s.type}>{w.subjects[s.type]?.label ?? s.label}</option>)}
              </ui.Select>
            </div>
          ) : null}
          {cfg?.search ? (
            chosen ? (
              <div className="wf-field">
                <span className="wf-label">{cfg.label}</span>
                <div className="wf-row"><b>{chosen.title}</b><ui.Button size="sm" variant="ghost" onClick={() => { setChosen(null); setHits(null); }}>Ändern</ui.Button></div>
              </div>
            ) : (
              <div className="wf-field">
                <label htmlFor={`${id}-q`}>{`${cfg.label} suchen`}</label>
                <div className="wf-row">
                  <ui.Input id={`${id}-q`} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
                  <ui.Button size="sm" onClick={() => void search()}>Suchen</ui.Button>
                </div>
                {hits ? (
                  hits.length ? (
                    <ul className="wf-plain" aria-label="Treffer">
                      {hits.map(h => <li key={h.id}><ui.Button size="sm" variant="ghost" onClick={() => { setChosen(h); setHits(null); }}>{h.title}</ui.Button></li>)}
                    </ul>
                  ) : <p className="wf-muted wf-small">Keine Treffer.</p>
                ) : null}
              </div>
            )
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
      <ui.Button variant="primary" aria-disabled={run.isPending || undefined} disabled={!w.can('workflow:manage')} onClick={() => { if (!run.isPending) start(); }}>{run.isPending ? 'Probelauf läuft …' : 'Probelauf starten'}</ui.Button>
      {jsonError ? <p className="wf-bad" role="alert">{jsonError}</p> : null}
      {run.isError ? <ui.ErrorBox error={run.error} /> : null}
      {run.data ? <DryRunResult result={run.data} definition={definition} meta={meta} /> : null}
    </section>
  );
}

function DryRunResult({ result, definition, meta }: { result: DryRunJson; definition: AutomationDefinition; meta: WorkflowMetaJson | undefined }) {
  const byId = new Map([...walk(definition.steps)].map(s => [s.id, s]));
  return (
    <div className="wf-dryrun-result" aria-label="Ergebnis des Probelaufs" role="region">
      {result.triggerMatches !== null ? <p>{result.triggerMatches ? 'Das Ereignis passt zum Filter des Auslösers.' : 'Das Ereignis passt nicht zum Filter: Der Workflow würde nicht starten.'}</p> : null}
      <p><b>Ergebnis:</b> {RESULT_LABEL[result.result]}</p>
      <ol className="wf-plain">
        {result.steps.map((s, i) => {
          const step = byId.get(s.stepId);
          const name = `Schritt ${stepNumberOfPath(s.path) ?? i + 1}${step ? ` · ${stepTitle(step, meta)}` : s.label ? ` · ${s.label}` : ''}`;
          return (
            <li key={i} className={s.error || s.allowed === false ? 'bad' : ''}>
              <b>{name}</b>: {s.summary}
              {s.allowed === false ? <div className="wf-bad">Dem Akteur fehlen Rechte: {(s.missing ?? []).join(', ')}</div> : null}
              {s.error ? <div className="wf-bad">{s.error.message}</div> : null}
              {s.input !== undefined || s.output !== undefined ? (
                <details className="wf-json"><summary>Technische Details</summary><pre>{JSON.stringify({ eingabe: s.input, ausgabe: s.output }, null, 2)}</pre></details>
              ) : null}
            </li>
          );
        })}
      </ol>
      {Object.keys(result.variables).length ? <details className="wf-json"><summary>Variablen am Ende</summary><pre>{JSON.stringify(result.variables, null, 2)}</pre></details> : null}
    </div>
  );
}
