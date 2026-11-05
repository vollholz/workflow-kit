/**
 * Editor eines Workflows (Konzept Abschnitt 10, W4; UX-Neukonzept Etappen 1 und 2): oben eine Werkzeugleiste, darunter
 * links der Ablauf (wächst Schritt für Schritt) und rechts der Detailbereich (Auslöser, Formular des gewählten Schritts
 * oder – im Modus «Probelauf» – der Probelauf). Neue Schritte und den ersten Auslöser wählt man im Sheet.
 *
 * Werkzeugleiste – was jemand wann sehen muss, auf einer Zeile:
 * - immer: Zustand (Aktiv / Inaktiv / Archiviert, ohne Versionsnummer), der Marker «Entwurf», solange Änderungen noch
 *   nicht wirken, knapp ergänzt, wenn es zählt («noch nie aktiviert», «Änderungen noch nicht wirksam»), und der
 *   Speicherstand;
 * - nur bei Bedarf: die Zahl der Hinweise (Klick springt zur Stelle), eine Meldung, wenn das System deaktiviert hat;
 * - genau eine Hauptaktion je Zustand («Aktivieren …», «Entwurf aktivieren …», «Aktivieren»), alles Seltene im Menü
 *   «Weitere Aktionen» (Deaktivieren, Verwerfen, Archivieren, Löschen, Name und Beschreibung, Läufe);
 * - der Wechsel «Bearbeiten | Probelauf». Bereich und Akteur stehen in den Einstellungen und beim Aktivieren.
 *
 * Regeln:
 * - Bearbeitet wird immer der Entwurf. Er speichert sich selbst (entprellt, `If-Match` mit dem Stand); solange etwas
 *   nicht gespeichert ist, fragt der Browser beim Verlassen nach. Hat jemand anderes inzwischen gespeichert, fragt der
 *   Editor: neu laden (eigene Änderungen verwerfen) oder eigene Fassung über den neuen Stand speichern.
 * - Statusleiste mit genau einer Hauptaktion je Zustand: «Aktivieren …» (nie aktiviert, oder das System hat
 *   deaktiviert und es braucht einen anderen Akteur), «Entwurf aktivieren …» (Änderungen gegenüber der aktiven bzw.
 *   zuletzt aktiven Fassung), «Aktivieren» (deaktiviert, ohne Änderungen: dieselbe Fassung läuft wieder, ohne neue
 *   Version). Daneben Verwerfen, Deaktivieren, Archivieren, Löschen. Was wirkt, ändert nur das Aktivieren.
 *   Versionsnummern nennt nur `VersionList`.
 * - Prüfung live: Nach jeder Änderung (verzögert) prüft `POST /workflows/validate`; Meldungen stehen am Schritt.
 *   Knöpfe sind nicht vorab gesperrt: Aktivieren nennt offene Stellen im Dialog.
 * - Ein entfernter Schritt lässt sich mit «Rückgängig» zurückholen; der Fokus springt auf diesen Knopf.
 * - Einfügen, Entfernen und Verschieben laufen über Pfade (`flow.tsx`); nach dem Einfügen ist der neue Schritt gewählt.
 * - Versionen und Name/Beschreibung stehen in eigenen Bausteinen (`VersionList`, `WorkflowSettings`); mit
 *   `onOpenSettings` öffnet «Name und Beschreibung …» diese statt des Dialogs.
 * - Probelauf und Hinweise nennen Schritte mit Nummer und Titel, nicht mit ihrer ID.
 * - Ohne `workflow:manage` (oder archiviert, oder eine Art späterer Stufen) ist alles nur lesbar.
 *
 * Etappe 3 (Sicherheit):
 * - Die Prüfung meldet Fehler (hindern das Aktivieren) und Hinweise (hindern nicht, z. B. ein leerer Weg); beide stehen
 *   getrennt in der Leiste und an den Karten.
 * - Probelauf im Ablauf: Der Detailbereich fragt, womit durchgespielt wird (Bezug, Ereignis, Eingabe als Formular), die
 *   Karten zeigen das Ergebnis je Schritt. Das angenommene Ergebnis einer Aufgabe oder Genehmigung wählt man an der Karte;
 *   der Probelauf läuft dann neu. Nach Änderungen läuft er beim Wechsel in den Probelauf neu.
 * - «Änderungen ansehen» vergleicht den Entwurf mit der aktiven Fassung; der Aktivieren-Dialog zeigt die Änderungen und
 *   den Stand des Probelaufs (keiner, veraltet, Ergebnis). Ein Probelauf ist keine Pflicht (E3).
 * - Mit dem ersten Weg nach Ergebnis hebt der Editor die Fassung der Definition auf 2.
 *
 * Etappe 4 (Betrieb):
 * - Hält ein Lauf der aktiven Version an einem Schritt an (Vorfall), sagt die Leiste das («1 Lauf hält an»); die
 *   Hauptaktion ist dann «Vorfall ansehen» (ein Lauf: `onOpenRun`, mehrere: `onShowRuns` mit Zustand «Vorfall»), die
 *   bisherige Hauptaktion steht im Menü.
 * - Tastatur im Ablauf (nicht in Eingabefeldern): `P` Bearbeiten ↔ Probelauf, `Ctrl`+`Z` rückgängig, `Ctrl`+`Y` bzw.
 *   `Ctrl`+`Shift`+`Z` wiederholen; auf einer Karte `Ctrl`+`D` duplizieren. Rückgängig fasst Tippen innerhalb einer
 *   Sekunde zusammen und meldet sich über `aria-live`. «Tastenkürzel» im Menü listet alle.
 *
 * Kopf «Kontextleiste» (Variante C):
 * - Mit `slots` stehen Zustand, Hauptaktion und Menü in der Leiste der App (`slots.actions`), der Marker «Entwurf»
 *   neben dem Namen (`slots.draft`, live mit dem Entwurf); Einträge der App (`menuItems`, z. B. «Versionen …»,
 *   «Einstellungen …») stehen zuoberst im Menü. Die eigene Leiste über dem Ablauf zeigt dann nur Fehler, Hinweise,
 *   anhaltende Runs, den Speicherstand und Bearbeiten | Probelauf; «Name und Beschreibung …» und «Runs ansehen»
 *   entfallen (die App hat dafür Einstellungen und Reiter).
 * - Mit `requireProbe` gibt es «Aktivieren …» bzw. «Entwurf aktivieren …» erst nach einem erfolgreichen Probelauf mit
 *   genau diesem Entwurf; vorher keine Hauptaktion. Dieselbe Fassung wieder aktivieren («Aktivieren») braucht keinen.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  useDryRun, useRuns, useSaveWorkflow, useValidateDefinition, useWorkflowDetail, useWorkflowLifecycle, useWorkflowMeta, useWorkflowVersion,
  type DryRunBody,
} from './api.ts';
import { TeamScope } from './assignee.tsx';
import { ArchiveDialog, DeleteDialog, DiscardDialog } from './bar.tsx';
import { ChangesList, diffDefinitions, type DefinitionChange } from './changes.tsx';
import { FlowView, listAt, numberOf, splitPath, StepDetail, stepAt, StepSheet, TriggerSheet, withList, type FlowRun, type FlowSelection } from './flow.tsx';
import { FieldForm } from './forms.tsx';
import { MoreMenu, type MenuItem } from './menu.tsx';
import { branchesOf } from './paths.ts';
import { contextFields, DataLabels, walk } from './placeholders.tsx';
import { ActorName, useWorkflow, type WorkflowActor } from './provider.tsx';
import { EditorCtx, placeOfPath, stepTitle, type EditorContext } from './steps.tsx';
import { describeCron, describeTrigger, TriggerEditor, triggerOfKind } from './trigger.tsx';
import type { AutomationDefinition, DefinitionError, DryRunJson, RunState, Step, WorkflowDefinition, WorkflowDetail, WorkflowMetaJson } from './types.ts';
import { Badge, DraftMark, fmtTime, hasDraft, MissingRight, outcomeLabel, plural, STATE_LABEL, stateTone, WorkflowApiError } from './ui.tsx';

export interface StepListEditorProps {
  workflowId?: string | null;
  /** Nach dem Löschen eines Entwurfs. */
  onDeleted?: () => void;
  /** Läufe des Workflows öffnen; mit `state` nur Läufe in diesem Zustand (z. B. `incident` für «Vorfall ansehen»). */
  onShowRuns?: (workflowId: string, filter?: { state?: RunState }) => void;
  /** Einen Lauf öffnen (z. B. den mit dem Vorfall). */
  onOpenRun?: (runId: string) => void;
  /** Verzögerung der Live-Prüfung in ms (Standard 400). */
  validateDelayMs?: number;
  /** Verzögerung des automatischen Speicherns in ms (Standard 800). */
  saveDelayMs?: number;
  /** Name als Überschrift zeigen (Standard `true`); `false`, wenn die App ihn im Seitenkopf zeigt. */
  showTitle?: boolean;
  /** Einstellungen des Workflows öffnen (Name, Beschreibung); ohne Angabe ein Dialog im Editor. */
  onOpenSettings?: () => void;
  /**
   * Plätze in der Leiste der App: `draft` neben dem Namen für den Marker «Entwurf», `actions` für Zustand, Hauptaktion
   * und Menü. Ohne Angabe steht alles in der eigenen Leiste über dem Ablauf.
   */
  slots?: { draft?: HTMLElement | null; actions?: HTMLElement | null };
  /** Einträge der App zuoberst im Menü (z. B. «Versionen …», «Einstellungen …»). */
  menuItems?: MenuItem[];
  /** Aktivieren erst nach einem erfolgreichen Probelauf mit diesem Entwurf (Standard `false`). */
  requireProbe?: boolean;
}

interface Draft { name: string; description: string; definition: WorkflowDefinition }

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, (x as Record<string, unknown>)[k]])) : x);
const draftOf = (d: WorkflowDetail): Draft => ({ name: d.name, description: d.description ?? '', definition: d.definition });
const isAutomation = (d: WorkflowDefinition): d is AutomationDefinition => d.kind === 'automation' && 'trigger' in d && Array.isArray((d as AutomationDefinition).steps);
/** Wege nach Ergebnis brauchen Fassung 2: Mit dem ersten Weg hebt der Editor die Fassung an. */
const upgrade = (d: WorkflowDefinition): WorkflowDefinition =>
  isAutomation(d) && d.schemaVersion < 2 && [...walk(d.steps)].some(s => Object.keys(branchesOf(s)).length) ? { ...d, schemaVersion: 2 } : d;
/** Womit der Probelauf durchspielt (ohne Definition und Annahmen). */
type DryRunSetup = Omit<DryRunBody, 'definition' | 'assume' | 'version'>;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function StepListEditor({ workflowId, onDeleted, onShowRuns, onOpenRun, validateDelayMs = 400, saveDelayMs = 800, showTitle = true, onOpenSettings, slots, menuItems, requireProbe = false }: StepListEditorProps) {
  const w = useWorkflow();
  const { ui } = w;
  const detail = useWorkflowDetail(workflowId);
  if (!workflowId) return <ui.Empty title="Kein Workflow gewählt">Wähle einen Workflow aus der Liste oder lege einen neuen an.</ui.Empty>;
  if (detail.isPending) return <ui.Loading label="Workflow wird geladen …" />;
  if (detail.isError) return <ui.ErrorBox error={detail.error} onRetry={() => void detail.refetch()} />;
  return (
    <EditorLoaded key={detail.data.id} detail={detail.data} refetch={async () => (await detail.refetch()).data} onDeleted={onDeleted} onShowRuns={onShowRuns} onOpenRun={onOpenRun}
      validateDelayMs={validateDelayMs} saveDelayMs={saveDelayMs} showTitle={showTitle} onOpenSettings={onOpenSettings} slots={slots} menuItems={menuItems} requireProbe={requireProbe} />
  );
}

type DialogName = 'activate' | 'archive' | 'delete' | 'discard' | 'details' | 'changes' | 'keys';

/** Neue IDs für einen kopierten Schritt und alle Schritte darin (Wege, Schleife, Fehlerpfad). */
function withNewIds(step: Step, newId: () => string): Step {
  const copy = JSON.parse(JSON.stringify(step)) as Step;
  for (const s of walk([copy])) s.id = newId();
  return copy;
}

function EditorLoaded({ detail, refetch, onDeleted, onShowRuns, onOpenRun, validateDelayMs, saveDelayMs, showTitle, onOpenSettings, slots, menuItems = [], requireProbe }: {
  detail: WorkflowDetail; refetch: () => Promise<WorkflowDetail | undefined>; onDeleted?: () => void;
  onShowRuns?: (id: string, filter?: { state?: RunState }) => void; onOpenRun?: (runId: string) => void;
  validateDelayMs: number; saveDelayMs: number; showTitle: boolean; onOpenSettings?: () => void;
  slots?: StepListEditorProps['slots']; menuItems?: MenuItem[]; requireProbe: boolean;
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
  const activeVersion = useWorkflowVersion(detail.id, detail.state === 'archived' ? null : detail.activeVersion);
  const draftKey = canonical(draft);
  const dirty = draftKey !== canonical(base);
  const automation = isAutomation(draft.definition);
  const readOnly = !w.can('workflow:manage') || detail.state === 'archived' || !automation;
  const saving = save.isPending;
  const debounced = useDebounced(automation ? draft.definition : null, validateDelayMs);
  const validation = useValidateDefinition(readOnly ? null : debounced);
  const errors: DefinitionError[] = useMemo(() => [...(validation.data?.errors ?? []), ...(validation.data?.stage ?? [])], [validation.data]);
  const warnings: DefinitionError[] = useMemo(() => validation.data?.warnings ?? [], [validation.data]);
  const ids = useRef(new Set<string>());
  ids.current = new Set(automation ? [...walk((draft.definition as AutomationDefinition).steps)].map(s => s.id) : []);
  const latest = useRef({ draft, revision: detail.revision });
  latest.current = { draft, revision: detail.revision };
  const subjectLabel = (type: string) => w.subjects[type]?.label ?? meta.data?.subjectTypes.find(s => s.type === type)?.label ?? type;
  const def = draft.definition as AutomationDefinition;
  const fields = automation ? contextFields(def, meta.data, subjectLabel) : [];
  const ctx: EditorContext = {
    meta: meta.data, fields, allFields: fields, errors, warnings, readOnly, steps: automation ? def.steps : [],
    fieldsAt: path => (automation ? contextFields(def, meta.data, subjectLabel, path) : []),
    newId: () => {
      let n = ids.current.size + 1;
      while (ids.current.has(`s${n}`)) n++;
      ids.current.add(`s${n}`);
      return `s${n}`;
    },
  };
  // Rückgängig und Wiederholen: frühere Fassungen der Definition; Tippen innerhalb einer Sekunde zählt als ein Schritt.
  const history = useRef<{ past: WorkflowDefinition[]; future: WorkflowDefinition[]; at: number }>({ past: [], future: [], at: 0 });
  const setDefinition = (d: WorkflowDefinition) => {
    const h = history.current, now = Date.now();
    if (now - h.at > 1000) { h.past = [...h.past.slice(-49), latest.current.draft.definition]; }
    h.at = now;
    h.future = [];
    setDraft(x => ({ ...x, definition: upgrade(d) }));
  };
  const travel = (back: boolean) => {
    const h = history.current;
    const from = back ? h.past : h.future;
    const to = from[from.length - 1];
    if (!to) { setNotice(back ? 'Nichts rückgängig zu machen.' : 'Nichts zu wiederholen.'); return; }
    const current = latest.current.draft.definition;
    if (back) { h.past = h.past.slice(0, -1); h.future = [...h.future, current]; } else { h.future = h.future.slice(0, -1); h.past = [...h.past, current]; }
    h.at = 0;
    setDraft(x => ({ ...x, definition: to }));
    setSel(s => (s.kind === 'step' && isAutomation(to) && !stepAt(to.steps, s.path) ? { kind: 'trigger' } : s));
    setNotice(back ? 'Rückgängig gemacht.' : 'Wiederholt.');
  };
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
    setRemoved({ label: `Schritt ${numberOf(path, steps)} (${stepTitle(step, meta.data)})`, definition: latest.current.draft.definition });
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
  const duplicate = (path: string) => {
    const step = stepAt(steps, path);
    if (!step) return;
    const { list, index } = splitPath(path);
    setSteps(withList(steps, list, l => [...l.slice(0, index + 1), withNewIds(step, ctx.newId), ...l.slice(index + 1)]));
    setSel({ kind: 'step', path: `${list}/${index + 1}` });
    setNotice(`Schritt ${numberOf(path, steps)} dupliziert.`);
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
  const changes: DefinitionChange[] | null = versionDef && isAutomation(versionDef) && automation ? diffDefinitions(versionDef, def, meta.data) : null;
  const canActivate = w.can('workflow:activate') && automation;
  const canManage = w.can('workflow:manage');
  // Leerer Ablauf: Der Auslöser gilt als gewählt, sobald es Schritte gibt, er vom Standard abweicht oder jemand ihn wählt.
  const [triggerChosen, setTriggerChosen] = useState(() => !automation || def.steps.length > 0 || canonical(def.trigger) !== canonical({ manual: {} }));
  const [sheet, setSheet] = useState<null | { mode: 'trigger' } | { mode: 'step'; list: string; index: number }>(null);
  const pickTrigger = (kind: 'event' | 'schedule' | 'manual') => {
    setDefinition({ ...def, trigger: triggerOfKind(kind, meta.data) });
    setTriggerChosen(true);
    setSheet(null);
    setSel({ kind: 'trigger' });
    openDetail.current = true;
  };
  const selectInFlow = (s: FlowSelection) => {
    if (s.kind === 'insert') { setSheet({ mode: 'step', list: s.list, index: s.index }); return; }
    setSel(s);
  };
  /** Zur ersten Stelle mit einem Fehler bzw. Hinweis springen (Auslöser oder Schritt). */
  const goTo = (list: DefinitionError[]) => {
    const first = list[0];
    if (!first) return;
    setMode('edit');
    const m = /^\/steps(?:\/\d+\/(?:then|else|steps|onError\/steps|branches\/[^/]+))*\/\d+/.exec(first.path);
    setSel(m ? { kind: 'step', path: m[0] } : { kind: 'trigger' });
    openDetail.current = true;
  };

  // Probelauf: womit durchgespielt wird, angenommene Ergebnisse, letztes Ergebnis mit dem Stand des Entwurfs.
  const dry = useDryRun(detail.id);
  const [setup, setSetup] = useState<DryRunSetup | null>(null);
  const [assume, setAssume] = useState<Record<string, string>>({});
  const [lastRun, setLastRun] = useState<{ key: string; result: DryRunJson } | null>(null);
  const defKey = automation ? canonical(def) : '';
  const stale = !!lastRun && lastRun.key !== defKey;
  const runDry = (body: DryRunSetup, nextAssume = assume) => {
    setSetup(body);
    const key = canonical(def);
    dry.mutate({ ...body, definition: def, assume: nextAssume }, { onSuccess: r => setLastRun({ key, result: r }) });
  };
  const runDryRef = useRef(runDry);
  runDryRef.current = runDry;
  const onAssume = (stepId: string, outcome: string) => {
    const next = { ...assume, [stepId]: outcome };
    setAssume(next);
    if (setup) runDry(setup, next);
  };
  // Nach Änderungen: beim Wechsel in den Probelauf mit derselben Wahl neu durchspielen.
  useEffect(() => {
    if (mode === 'sim' && setup && stale && !dry.isPending) runDryRef.current(setup);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const flowRun: FlowRun | null = mode === 'sim' && lastRun && !stale
    ? { steps: new Map(lastRun.result.steps.map(x => [x.path, x])), triggerMatches: lastRun.result.triggerMatches, onAssume, busy: dry.isPending }
    : null;
  const probe: ProbeState = !lastRun ? { state: 'none', text: 'Noch kein Probelauf mit diesem Entwurf.' }
    : stale ? { state: 'stale', text: 'Der letzte Probelauf ist älter als die letzten Änderungen.' }
      : { state: lastRun.result.result === 'completed' && lastRun.result.triggerMatches !== false ? 'ok' : 'bad', text: `Probelauf mit diesem Entwurf: ${RESULT_LABEL[lastRun.result.result]}.` };

  // Vorfälle: Läufe der aktiven Version, die an einem Schritt anhalten.
  const incidentRuns = useRuns({ workflowId: detail.id, state: 'incident', limit: 20 }, detail.activeVersion !== null && detail.state !== 'archived', { refetchInterval: 30_000 });
  const incidents = incidentRuns.data?.pages[0]?.items ?? [];
  const openIncident = incidents.length === 1 && onOpenRun ? () => onOpenRun(incidents[0]!.id)
    : incidents.length && onShowRuns ? () => onShowRuns(detail.id, { state: 'incident' }) : null;

  const pause = () => life.pause.mutate(undefined, { onSuccess: d => { adopt(d); setNotice('Workflow deaktiviert; er startet keine neuen Runs mehr.'); } });
  const resume = () => { if (!life.resume.isPending) life.resume.mutate(undefined, { onSuccess: d => { adopt(d); setNotice('Workflow ist wieder aktiv.'); } }); };

  // Werkzeugleiste: Zustand (ohne Versionsnummer), Marker «Entwurf», ein Hinweis nur wenn er zählt, eine Hauptaktion,
  // Seltenes im Menü. Inaktiv heisst: noch nie aktiviert (`draft`) oder deaktiviert (`paused`, von Hand oder vom System).
  const v = detail.activeVersion;
  const archived = detail.state === 'archived';
  const paused = detail.state === 'paused';
  const draftMark = hasDraft(detail, differs);
  const state: { label: string; tone: 'ok' | 'muted'; note?: string } =
    archived ? { label: STATE_LABEL.archived, tone: 'muted', note: 'nur lesbar' }
      : { label: STATE_LABEL[detail.state], tone: stateTone(detail.state), note: v === null ? 'noch nie aktiviert' : differs ? 'Änderungen noch nicht wirksam' : undefined };
  const canLife = w.can('workflow:activate');
  // Hauptaktion: nie aktiviert oder ein neuer Akteur nötig → «Aktivieren …» (Dialog); Änderungen → «Entwurf aktivieren …»;
  // deaktiviert ohne Änderungen → «Aktivieren» (dieselbe Fassung läuft wieder).
  const needsDialog = v === null || differs || (paused && !!detail.pausedReason);
  const activateLabel = v === null || !differs ? 'Aktivieren …' : 'Entwurf aktivieren …';
  // Mit `requireProbe`: Etwas Neues (nie aktiviert oder Änderungen) wird erst nach einem erfolgreichen Probelauf aktiviert.
  const probeMissing = requireProbe && (v === null || differs) && probe.state !== 'ok';
  let main: MenuItem | null = null;
  const menu: MenuItem[] = [];
  if (!archived) {
    if (needsDialog && canActivate && !probeMissing) main = { label: activateLabel, onSelect: () => setDialog('activate') };
    else if (paused && canLife) main = { label: 'Aktivieren', onSelect: resume };
    if (v === null) {
      if (canManage) menu.push({ label: 'Workflow löschen …', danger: true, onSelect: () => setDialog('delete') });
    } else {
      if (paused && differs && !detail.pausedReason && canLife) menu.push({ label: 'Ohne Änderungen aktivieren', onSelect: resume });
      if (differs && canManage) menu.push({ label: 'Änderungen verwerfen …', onSelect: () => setDialog('discard') });
      if (!paused && canLife) menu.push({ label: 'Deaktivieren', onSelect: pause });
      if (canLife) menu.push({ label: 'Archivieren …', danger: true, onSelect: () => setDialog('archive') });
    }
  }
  let primary: ReactNode = main
    ? <ui.Button size="sm" variant="primary" aria-disabled={(main.onSelect === resume && life.resume.isPending) || undefined} onClick={main.onSelect}>{main.label}</ui.Button>
    : null;
  // Vorfall offen: «Vorfall ansehen» ist die Hauptaktion; die bisherige steht zuoberst im Menü.
  if (openIncident) {
    if (main) menu.unshift(main);
    primary = <ui.Button size="sm" variant="primary" onClick={openIncident}>{incidents.length === 1 ? 'Vorfall ansehen' : 'Vorfälle ansehen'}</ui.Button>;
  }
  if (differs && changes) menu.push({ label: 'Änderungen ansehen', onSelect: () => setDialog('changes') });
  if (!readOnly && !slots) menu.push({ label: 'Name und Beschreibung …', onSelect: () => (onOpenSettings ? onOpenSettings() : setDialog('details')) });
  if (onShowRuns && !slots) menu.push({ label: 'Runs ansehen', onSelect: () => onShowRuns(detail.id) });
  if (automation && !readOnly) menu.push({ label: 'Tastenkürzel', onSelect: () => setDialog('keys') });
  // Einträge der App zuoberst, danach eine Trennlinie vor den eigenen
  const firstSafe = menu.findIndex(x => !x.danger);
  if (menuItems.length && firstSafe >= 0) menu[firstSafe] = { ...menu[firstSafe]!, separator: true };
  const allMenu = [...menuItems, ...menu];
  const saveState: ReactNode = readOnly || conflict ? null
    : saving ? 'Speichert …'
      : failed === draftKey ? <>Nicht gespeichert · <button type="button" className="wf-link" onClick={() => void doSave()}>Erneut versuchen</button></>
        : dirty ? 'Speichert gleich …'
          : savedAt ? <span title={`Gespeichert um ${fmtTime(savedAt)}`}>Gespeichert</span> : 'Gespeichert';
  const where = (list: string, index: number) => (list === '/steps' && index === 0 ? 'nach dem Auslöser'
    : index === 0 ? `am Anfang von ${laneName(list, steps)}` : `nach Schritt ${numberOf(`${list}/${index - 1}`, steps)}`);

  // Tastenkürzel des Ablaufs, solange der Editor offen ist (auch wenn der Fokus nach Rückgängig auf der Seite liegt);
  // in Eingabefeldern, Dialogen, Sheets und Menüs gelten deren eigene.
  const keys = useRef((_e: globalThis.KeyboardEvent) => {});
  keys.current = e => {
    const t = e.target as HTMLElement | null;
    if (e.defaultPrevented || e.altKey || t?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"], [role="dialog"], [role="alertdialog"]')) return;
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (!mod && !e.shiftKey && key === 'p' && automation) { e.preventDefault(); setMode(m => (m === 'edit' ? 'sim' : 'edit')); return; }
    if (readOnly || !mod) return;
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); travel(true); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); travel(false); }
  };
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => keys.current(e);
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  return (
    <EditorCtx.Provider value={ctx}>
      <DataLabels.Provider value={fields}>
      <TeamScope.Provider value={detail.scope}>
      <div className="wf-editor">
        {showTitle ? (
          <header className="wf-editor-head">
            <h2 className="wf-editor-title">{draft.name}</h2>
            {draft.description ? <p className="wf-editor-desc">{draft.description}</p> : null}
          </header>
        ) : null}
        <div className={`wf-bar${slots ? ' wf-bar-slim' : ''}`} role="group" aria-label={slots ? 'Stand des Entwurfs' : 'Zustand des Workflows'}>
          <div className="wf-bar-state">
            {slots ? null : <Badge tone={state.tone}>{state.label}</Badge>}
            {draftMark && !slots ? <DraftMark /> : null}
            {state.note && !slots ? (differs && changes
              ? <button type="button" className="wf-bar-note wf-bar-link" onClick={() => setDialog('changes')}>{state.note}</button>
              : <span className="wf-bar-note">{state.note}</span>) : null}
            {saveState && !slots ? <span className="wf-bar-save" aria-live="polite">{saveState}</span> : null}
            {!readOnly && errors.length ? <button type="button" className="wf-bar-issues" onClick={() => goTo(errors)}>{plural(errors.length, 'Fehler', 'Fehler')}</button> : null}
            {!readOnly && warnings.length ? <button type="button" className="wf-bar-hints" onClick={() => goTo(warnings)}>{plural(warnings.length, 'Hinweis', 'Hinweise')}</button> : null}
            {incidents.length ? (openIncident
              ? <button type="button" className="wf-bar-incident" onClick={openIncident}>{incidents.length === 1 ? '1 Run hält an' : `${incidents.length}${incidentRuns.data?.pages[0]?.nextCursor ? '+' : ''} Runs halten an`}</button>
              : <span className="wf-bar-incident">{incidents.length === 1 ? '1 Run hält an' : `${incidents.length} Runs halten an`}</span>) : null}
          </div>
          {saveState && slots ? <span className="wf-bar-save" aria-live="polite">{saveState}</span> : null}
          {automation ? (
            <div className="wf-seg" role="group" aria-label="Ansicht">
              <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>Bearbeiten</button>
              <button type="button" aria-pressed={mode === 'sim'} onClick={() => setMode('sim')}>Probelauf</button>
            </div>
          ) : null}
          {slots ? null : (
            <div className="wf-bar-actions">
              {primary}
              {allMenu.length ? <MoreMenu items={allMenu} /> : null}
            </div>
          )}
        </div>
        {slots?.draft && draftMark ? createPortal(<DraftMark />, slots.draft) : null}
        {slots?.actions ? createPortal(
          <span className="wf-bar-actions" role="group" aria-label="Zustand des Workflows">
            <Badge tone={state.tone}>{state.label}</Badge>
            {primary}
            {allMenu.length ? <MoreMenu items={allMenu} /> : null}
          </span>, slots.actions) : null}
        {paused && detail.pausedReason ? <p className="wf-banner" role="note">{`Automatisch deaktiviert: ${detail.pausedReason}. Wähle beim Aktivieren, in wessen Namen er handelt.`}</p> : null}
        <div role="status" aria-live="polite" className="wf-sr-live">{notice}</div>
        {!canManage ? <MissingRight perm="workflow:manage" lead="Zum Bearbeiten" /> : null}
        {!automation ? <p className="wf-hint">Diese Art von Workflow folgt in einer späteren Stufe; der Editor zeigt sie noch nicht an.</p> : null}
        {failed === draftKey && save.isError ? <ui.ErrorBox error={save.error} /> : null}
        {life.pause.isError ? <ui.ErrorBox error={life.pause.error} /> : null}
        {life.resume.isError ? <ui.ErrorBox error={life.resume.error} /> : null}
        {meta.isError ? <ui.ErrorBox error={meta.error} onRetry={() => void meta.refetch()} /> : null}
        {automation ? (
          <div className="wf-editor-grid">
            <div className="wf-editor-main">
              <FlowView steps={steps} run={flowRun} locked={mode === 'sim'} trigger={triggerChosen ? { value: def.trigger, text: describeTrigger(def.trigger, meta.data) } : null} sel={sel}
                onSelect={selectInFlow} onAddFirst={() => setSheet({ mode: 'trigger' })} onMove={move} onRemove={remove} onDuplicate={duplicate}
                onOpen={() => { openDetail.current = true; setSel(x => ({ ...x })); }} />
              {otherErrors.length ? <ul className="wf-step-errors" aria-label="Weitere Fehler">{otherErrors.map((e, i) => <li key={i}>{placeOfPath(e.path, steps)}: {e.message}</li>)}</ul> : null}
              {removed ? (
                <div className="wf-undo" role="status">
                  <span className="wf-grow">{`${removed.label} entfernt.`}</span>
                  <ui.Button ref={undoRef} size="sm" onClick={() => { setDefinition(removed.definition); setRemoved(null); setNotice('Schritt wiederhergestellt.'); }}>Rückgängig</ui.Button>
                  <ui.Button size="sm" variant="ghost" aria-label="Hinweis schliessen" onClick={() => setRemoved(null)}>✕</ui.Button>
                </div>
              ) : null}
            </div>
            <aside className="wf-editor-side wf-detail" ref={detailRef} aria-label={mode === 'sim' ? 'Probelauf' : 'Detail'}>
              {mode === 'sim' ? (
                <DryRunPanel definition={def} meta={meta.data} result={lastRun && !stale ? lastRun.result : null} busy={dry.isPending} error={dry.isError ? dry.error : null}
                  selected={sel.kind === 'step' ? sel.path : null} canRun={w.can('workflow:manage')} onStart={body => runDry(body)}
                  gate={requireProbe && !archived && canActivate && (v === null || differs) ? (probe.state === 'ok' ? 'ready' : 'needed') : null} />
              )
                : !triggerChosen ? (
                  <div className="wf-detail-empty"><b>Noch kein Schritt</b><p>Beginne links mit «Ersten Schritt hinzufügen»: Wähle, wie der Workflow startet.</p></div>
                ) : selected && sel.kind === 'step' ? (
                  <StepDetail key={sel.path} step={selected} path={sel.path} last={splitPath(sel.path).index >= (listAt(steps, splitPath(sel.path).list)?.length ?? 1) - 1}
                    onChange={s => { const { list, index } = splitPath(sel.path); setSteps(withList(steps, list, l => l.map((x, j) => (j === index ? s : x)))); }}
                    onRemove={() => remove(sel.path)} onMove={d => { move(sel.path, d); }} onDuplicate={() => duplicate(sel.path)} />
                ) : (
                  <TriggerEditor trigger={def.trigger} meta={meta.data} readOnly={readOnly} errors={triggerErrors} onChange={trigger => setDefinition({ ...def, trigger })} />
                )}
            </aside>
          </div>
        ) : null}
      </div>
      </TeamScope.Provider>
      </DataLabels.Provider>
      {sheet?.mode === 'trigger' ? <TriggerSheet onPick={pickTrigger} onClose={() => setSheet(null)} /> : null}
      {sheet?.mode === 'step' ? (
        <StepSheet where={where(sheet.list, sheet.index)} onClose={() => setSheet(null)}
          onPick={step => { const { list, index } = sheet; setSheet(null); insert(list, index, step); }} />
      ) : null}
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
        <ActivateDialog detail={detail} definition={def} meta={meta.data} dirty={dirty} errors={errors} warnings={warnings} changes={changes} probe={probe}
          onProbe={() => { setDialog(null); setMode('sim'); }} onClose={() => setDialog(null)}
          onActivate={async actor => {
            let revision = detail.revision;
            if (dirty || saving) { const saved = await doSave(); if (!saved) return false; revision = saved.revision; }
            const d = await life.activate.mutateAsync({ revision, actor });
            adopt(d);
            setNotice(v === null ? 'Workflow ist aktiv.' : 'Änderungen sind aktiv.');
            return true;
          }} error={life.activate.error} busy={life.activate.isPending || saving} />
      ) : null}
      {dialog === 'changes' && changes ? (
        <ui.Dialog title={paused ? 'Änderungen gegenüber der zuletzt aktiven Fassung' : 'Änderungen gegenüber der aktiven Fassung'} onClose={() => setDialog(null)} width={560}
          footer={<ui.Button data-autofocus onClick={() => setDialog(null)}>Schliessen</ui.Button>}>
          <p className="wf-hint">{paused ? 'Der Entwurf wirkt erst nach dem Aktivieren.' : 'Der Entwurf wirkt erst nach dem Aktivieren; bis dahin läuft die aktive Fassung.'}</p>
          <ChangesList changes={changes} />
        </ui.Dialog>
      ) : null}
      {dialog === 'keys' ? (
        <ui.Dialog title="Tastenkürzel" onClose={() => setDialog(null)} width={480} footer={<ui.Button data-autofocus onClick={() => setDialog(null)}>Schliessen</ui.Button>}>
          <dl className="wf-keys">
            <dt><kbd>↓</kbd> <kbd>↑</kbd> · <kbd>J</kbd> <kbd>K</kbd></dt><dd>Schritt wechseln</dd>
            <dt><kbd>Enter</kbd></dt><dd>Formular des Schritts öffnen</dd>
            <dt><kbd>+</kbd></dt><dd>Schritt danach einfügen</dd>
            <dt><kbd>Alt</kbd> + <kbd>↓</kbd> <kbd>↑</kbd></dt><dd>Schritt verschieben</dd>
            <dt><kbd>Ctrl</kbd> + <kbd>D</kbd></dt><dd>Schritt duplizieren</dd>
            <dt><kbd>Entf</kbd></dt><dd>Schritt entfernen</dd>
            <dt><kbd>Ctrl</kbd> + <kbd>Z</kbd></dt><dd>Rückgängig</dd>
            <dt><kbd>Ctrl</kbd> + <kbd>Y</kbd></dt><dd>Wiederholen</dd>
            <dt><kbd>P</kbd></dt><dd>Bearbeiten ↔ Probelauf</dd>
            <dt><kbd>{'{'}</kbd></dt><dd>Daten einfügen (im Textfeld)</dd>
            <dt><kbd>Esc</kbd></dt><dd>Auswahl oder Dialog schliessen</dd>
          </dl>
        </ui.Dialog>
      ) : null}
      {dialog === 'discard' && versionDef ? (
        <DiscardDialog paused={paused} onClose={() => setDialog(null)}
          onConfirm={() => { setDefinition(versionDef); setDialog(null); setNotice(paused ? 'Änderungen verworfen; es gilt wieder die zuletzt aktive Fassung.' : 'Änderungen verworfen; es gilt wieder die aktive Fassung.'); }} />
      ) : null}
      {dialog === 'archive' ? <ArchiveDialog workflowId={detail.id} onClose={() => setDialog(null)} onDone={d => { adopt(d); setDialog(null); setNotice('Workflow archiviert.'); }} /> : null}
      {dialog === 'delete' ? <DeleteDialog detail={detail} onClose={() => setDialog(null)} onDeleted={() => { setDialog(null); onDeleted?.(); }} /> : null}
    </EditorCtx.Provider>
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

interface ProbeState { state: 'none' | 'stale' | 'ok' | 'bad'; text: string }

function ActivateDialog({ detail, definition, meta, dirty, errors, warnings, changes, probe, onProbe, onClose, onActivate, error, busy }: {
  detail: WorkflowDetail; definition: AutomationDefinition; meta: WorkflowMetaJson | undefined; dirty: boolean; errors: DefinitionError[];
  warnings: DefinitionError[]; changes: DefinitionChange[] | null; probe: ProbeState; onProbe: () => void;
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
  const first = detail.activeVersion === null;
  const title = first || !changes?.length ? 'Workflow aktivieren' : 'Entwurf aktivieren';
  const before = detail.state === 'active' ? { nom: 'die aktive Fassung', dat: 'der aktiven Fassung' } : { nom: 'die zuletzt aktive Fassung', dat: 'der zuletzt aktiven Fassung' };
  const go = async () => {
    setFailed(null);
    if (errors.length) { setTried(true); return; }
    try { if (await onActivate(actor ? { id: actor.id, kind: actor.kind } : undefined)) onClose(); } catch (e) { setFailed(e); }
  };
  return (
    <ui.Dialog title={title} onClose={onClose} width={560}
      footer={<><ui.Button onClick={onClose}>Abbrechen</ui.Button><ui.Button variant="primary" data-autofocus aria-disabled={busy || undefined} onClick={() => { if (!busy) void go(); }}>{busy ? 'Bitte warten …' : title === 'Workflow aktivieren' ? 'Aktivieren' : title}</ui.Button></>}>
      <dl className="wf-summary">
        <dt>Workflow</dt><dd>{detail.name}</dd>
        {first ? null : <><dt>Ersetzt</dt><dd>{`${before.nom}; laufende Runs enden mit ihrer Fassung`}</dd></>}
        <dt>Auslöser</dt><dd>{describeTrigger(t, meta)}</dd>
        {'schedule' in t ? <><dt>Zeitplan</dt><dd>{describeCron(t.schedule.cron) ?? t.schedule.cron} · Zeitzone {t.schedule.timezone}</dd></> : null}
        <dt>Schritte</dt><dd>{[...walk(definition.steps)].length}</dd>
      </dl>
      {changes ? (
        <section className="wf-activate-part" aria-label={`Änderungen gegenüber ${before.dat}`}>
          <h4>{`Änderungen gegenüber ${before.dat}`}</h4>
          <ChangesList changes={changes} />
        </section>
      ) : null}
      <p className={`wf-probe ${probe.state}`}>
        {probe.text}{' '}
        {probe.state === 'none' || probe.state === 'stale' ? <button type="button" className="wf-link" onClick={onProbe}>Zum Probelauf</button> : null}
      </p>
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
        <p className="wf-hint">Jeder Schritt prüft die Rechte dieses Akteurs. Fehlt ein Recht oder ist der Akteur nicht mehr aktiv, hält der Run an.</p>
      </fieldset>
      {dirty ? <p className="wf-hint">Ungespeicherte Änderungen werden vorher gespeichert.</p> : null}
      {errors.length && !tried ? <p className="wf-hint">{errors.length === 1 ? 'Die Prüfung meldet noch 1 offene Stelle.' : `Die Prüfung meldet noch ${errors.length} offene Stellen.`}</p> : null}
      {errors.length && tried ? (
        <div className="wf-bad" role="alert">
          <p>{errors.length === 1 ? 'Zuerst diese Stelle beheben:' : `Zuerst diese ${errors.length} Stellen beheben:`}</p>
          <ul>{errors.map((e, i) => <li key={i}>{placeOfPath(e.path, definition.steps)}: {e.message}</li>)}</ul>
        </div>
      ) : null}
      {warnings.length ? (
        <div className="wf-hint">
          <p>{warnings.length === 1 ? 'Ein Hinweis der Prüfung (hindert nicht):' : `${warnings.length} Hinweise der Prüfung (hindern nicht):`}</p>
          <ul>{warnings.map((e, i) => <li key={i}>{placeOfPath(e.path, definition.steps)}: {e.message}</li>)}</ul>
        </div>
      ) : null}
      {failed || error ? <ui.ErrorBox error={failed ?? error} /> : null}
    </ui.Dialog>
  );
}

// ---------------------------------------------------------------- Probelauf

const laneName = (list: string, steps: Step[]) => {
  const owner = list.replace(/\/(then|else|steps|branches\/[^/]+)$/, '');
  const n = numberOf(owner, steps);
  const way = /\/branches\/([^/]+)$/.exec(list);
  return way ? `«${outcomeLabel(way[1])}» in Schritt ${n}` : list.endsWith('/then') ? `«Dann» in Schritt ${n}` : list.endsWith('/else') ? `«Sonst» in Schritt ${n}` : `der Schleife in Schritt ${n}`;
};

const RESULT_LABEL: Record<DryRunJson['result'], string> = { completed: 'würde erfolgreich enden', failed: 'würde scheitern', cancelled: 'würde abgebrochen', limit: 'würde an eine Grenze stossen' };

/**
 * Probelauf im Detailbereich: womit durchgespielt wird (Bezug, Ereignis, Eingabe als Formular), das Ergebnis und die
 * Angaben zum gewählten Schritt. Was je Schritt geschähe, zeigen die Karten im Ablauf.
 */
function DryRunPanel({ definition, meta, result, busy, error, selected, canRun, onStart, gate = null }: {
  definition: AutomationDefinition; meta: WorkflowMetaJson | undefined; result: DryRunJson | null; busy: boolean; error: Error | null;
  selected: string | null; canRun: boolean; onStart: (body: DryRunSetup) => void;
  /** Aktivieren hängt am Probelauf (`requireProbe`): noch nötig oder erfüllt. */
  gate?: 'needed' | 'ready' | null;
}) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const t = definition.trigger;
  const eventType = 'event' in t ? t.event : '';
  const [mode, setMode] = useState<'subject' | 'event'>('subject');
  const [type, setType] = useState('');
  const [chosen, setChosen] = useState<{ id: string; title: string } | null>(null);
  const [subjectId, setSubjectId] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; title: string }[] | null>(null);
  const [eventJson, setEventJson] = useState(() => JSON.stringify({ type: eventType, subject: null, data: {} }, null, 2));
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [jsonError, setJsonError] = useState<string | null>(null);
  const types = meta?.subjectTypes ?? [];
  const evSubject = meta?.events.find(e => e.type === eventType)?.subjectType;
  const subjectType = type || evSubject || types[0]?.type || '';
  const cfg = w.subjects[subjectType];
  const form = 'manual' in t ? t.manual.form ?? [] : [];
  const search = async () => { if (cfg?.search) setHits(await cfg.search(q)); };
  const start = () => {
    setJsonError(null);
    try {
      const body: DryRunSetup = {};
      if (mode === 'event') {
        const ev = JSON.parse(eventJson) as { type?: string; subject?: { type: string; id: string } | null; data?: Record<string, unknown> };
        if (!ev || typeof ev.type !== 'string') throw new Error('type');
        body.event = { type: ev.type, subject: ev.subject ?? null, data: ev.data ?? {} };
      } else {
        const sid = cfg?.search ? chosen?.id : subjectId;
        if (sid) body.subject = { type: subjectType, id: sid };
      }
      if ('manual' in t) body.input = input;
      onStart(body);
    } catch { setJsonError('Bitte gültiges JSON eingeben (beim Ereignis mit «type»).'); }
  };
  return (
    <section className="wf-section wf-dryrun" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Probelauf</h3>
      <p className="wf-hint">Spielt den Entwurf durch, ohne etwas zu ändern. Was geschähe, steht an den Schritten im Ablauf; bei Aufgaben und Genehmigungen wählst du dort das Ergebnis.</p>
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
      {form.length ? (
        <fieldset className="wf-field">
          <legend>Eingabe beim Start</legend>
          <FieldForm fields={form} value={input} onChange={setInput} />
        </fieldset>
      ) : null}
      <ui.Button variant={result ? 'default' : 'primary'} aria-disabled={busy || undefined} disabled={!canRun} onClick={() => { if (!busy) start(); }}>
        {busy ? 'Probelauf läuft …' : result ? 'Erneut durchspielen' : 'Probelauf starten'}
      </ui.Button>
      {jsonError ? <p className="wf-bad" role="alert">{jsonError}</p> : null}
      {error ? <ui.ErrorBox error={error} /> : null}
      {gate === 'needed' ? <p className="wf-hint">Aktivieren geht erst nach einem erfolgreichen Probelauf mit diesem Entwurf.</p> : null}
      {gate === 'ready' ? <p className="wf-ok">Probelauf erfolgreich: Jetzt lässt sich der Entwurf aktivieren.</p> : null}
      {result ? <DryRunSummary result={result} definition={definition} meta={meta} selected={selected} /> : null}
    </section>
  );
}

/** Ergebnis des Probelaufs: Gesamtergebnis, angenommene Ergebnisse, Angaben zum gewählten Schritt. */
function DryRunSummary({ result, definition, meta, selected }: { result: DryRunJson; definition: AutomationDefinition; meta: WorkflowMetaJson | undefined; selected: string | null }) {
  const at = selected ? result.steps.find(x => x.path === selected) : undefined;
  const step = selected ? stepAt(definition.steps, selected) : undefined;
  const assumed = result.steps.filter(x => x.outcome !== undefined && (x.outcomes?.length ?? 0) > 1);
  const name = (path: string) => `Schritt ${numberOf(path, definition.steps)}`;
  return (
    <div className="wf-dryrun-result" role="region" aria-label="Ergebnis des Probelaufs">
      {result.triggerMatches === false ? <p className="wf-bad">Das Ereignis passt nicht zum Filter: Der Workflow würde nicht starten.</p> : null}
      <p><b>Ergebnis:</b> {RESULT_LABEL[result.result]} · {plural(result.steps.length, 'Schritt', 'Schritte')} durchlaufen</p>
      {assumed.length ? <p className="wf-hint">{`Angenommen: ${assumed.map(x => `${name(x.path)} «${outcomeLabel(x.outcome)}»`).join(', ')}`}</p> : null}
      {selected ? (at ? (
        <div className="wf-dryrun-step">
          <h4>{`${name(selected)}${step ? ` · ${stepTitle(step, meta)}` : ''}`}</h4>
          <p>{at.summary}</p>
          {at.allowed === false ? <p className="wf-bad">Dem Akteur fehlen Rechte: {(at.missing ?? []).join(', ')}</p> : null}
          {at.error ? <p className="wf-bad">{at.error.message}</p> : null}
          {at.input !== undefined || at.output !== undefined ? (
            <details className="wf-json"><summary>Technische Details</summary><pre>{JSON.stringify({ eingabe: at.input, ausgabe: at.output }, null, 2)}</pre></details>
          ) : null}
        </div>
      ) : <p className="wf-muted">{`${name(selected)} wird in diesem Probelauf nicht erreicht.`}</p>) : <p className="wf-hint">Wähle im Ablauf einen Schritt, um Einzelheiten zu sehen.</p>}
      {Object.keys(result.variables).length ? <details className="wf-json"><summary>Variablen am Ende</summary><pre>{JSON.stringify(result.variables, null, 2)}</pre></details> : null}
    </div>
  );
}
