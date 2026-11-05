/**
 * Ablauf im Editor (UX-Neukonzept Etappe 2): Der Ablauf wächst Schritt für Schritt. Leer zeigt er nur «Ersten Schritt
 * hinzufügen» (der Auslöser); danach Karten für Auslöser und Schritte, verbunden durch eine Linie, mit «Schritt
 * hinzufügen» am Ende jedes Wegs und «+» zwischen zwei Schritten. Die Wege «Dann» und «Sonst» stehen nebeneinander (bei
 * wenig Platz untereinander), «Für jeden Eintrag» als eigener Weg. Neue Schritte wählt man im Sheet (`StepSheet`): erst
 * die Gruppe, dann den Schritt, mit «Zurück»; die Suche findet über alle Gruppen. Das Formular des gewählten Schritts
 * zeigt der Detailbereich (`StepDetail`).
 *
 * Regeln:
 * - Auswahl über Pfade: Auslöser (`trigger`), Schritt (`/steps/1/then/0`), Stelle zum Einfügen (Liste und Index).
 * - Tastatur auf den Karten: ↓/↑ oder J/K wechseln, Alt+↓/↑ verschiebt im eigenen Weg, Entf entfernt (Rückgängig bietet
 *   der Editor), + fügt danach ein, Ctrl+D dupliziert, Enter springt ins Formular.
 * - Die Definition ändert sich nur über die reinen Hilfen (`withList`, `listAt`, `stepAt`, `splitPath`).
 * - Ohne `workflow:manage` (nur lesbar) gibt es keine Stellen zum Einfügen; Karten lassen sich trotzdem öffnen.
 * - Das Sheet hält den Fokus, Esc oder ein Klick daneben schliesst es, danach geht der Fokus zurück an den Auslöser.
 * - Etappe 3: Eine Aufgabe mit zwei oder mehr Ergebnissen und jede Genehmigung zeigen je Ergebnis einen Weg; ein leerer
 *   Weg ohne Folgeschritt trägt den Hinweis «Hier geschieht nichts». Fehler und Hinweise der Prüfung stehen an der Karte.
 * - Probelauf im Ablauf (`run`): Jede Karte zeigt, was geschähe; nicht erreichte Schritte und Wege sind blass. Bei Aufgabe
 *   und Genehmigung lässt sich das angenommene Ergebnis wählen, der Probelauf läuft dann neu. Einfügen gibt es dabei nicht.
 * - Etappe 4: Derselbe Ablauf zeigt einen Lauf (`run.live`): was geschah, mit Zeiten und Namen; der Schritt, an dem der
 *   Lauf steht, ist hervorgehoben; ein Vorfall steht an seinem Schritt (`run.below`).
 */
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useWorkflow } from './provider.tsx';
import { branchesOf, hasWays, innerList, outcomesOfStep, pathHops, stepNumberOfPath, wayLetter } from './paths.ts';
import { describeTemplate, type ContextField } from './placeholders.tsx';
import {
  ADDABLE, CommonFields, EditorCtx, kindOf, newStep, ownErrors, STEP_KIND_LABEL, StepBody, StepSummary, stepTitle, useEditor, type StepKindName,
} from './steps.tsx';
import type { DryRunStepJson, Step, Trigger } from './types.ts';
import { outcomeLabel, plural } from './ui.tsx';

/** Was im Ablauf gewählt ist: der Auslöser, ein Schritt (Pfad) oder eine Stelle zum Einfügen. */
export type FlowSelection = { kind: 'trigger' } | { kind: 'step'; path: string } | { kind: 'insert'; list: string; index: number };


/** Pfad eines Schritts → Liste und Index (`/steps/1/then/0` → `/steps/1/then`, 0). */
export function splitPath(path: string): { list: string; index: number } {
  const i = path.lastIndexOf('/');
  return { list: path.slice(0, i), index: Number(path.slice(i + 1)) };
}

/** Schritte einer Liste (`/steps`, `/steps/1/then`, `/steps/2/steps`, `/steps/3/branches/ok`); ein fehlender Weg ist leer. */
export function listAt(steps: Step[], list: string): Step[] | undefined {
  let cur: Step[] | undefined = steps;
  for (const hop of pathHops(`${list}/0`).slice(0, -1)) {
    const st: Step | undefined = cur?.[hop.index];
    if (!st) return undefined;
    cur = innerList(st, hop) ?? [];
  }
  return cur;
}

export const stepAt = (steps: Step[], path: string): Step | undefined => {
  const { list, index } = splitPath(path);
  return listAt(steps, list)?.[index];
};

/** Neue Schrittliste, in der die Liste `list` durch `fn` ersetzt ist; ein leeres «Sonst» und ein leerer Weg fallen weg. */
export function withList(steps: Step[], list: string, fn: (l: Step[]) => Step[]): Step[] {
  const hops = pathHops(`${list}/0`).slice(0, -1);
  const rec = (cur: Step[], depth: number): Step[] => {
    if (depth === hops.length) return fn(cur);
    const hop = hops[depth]!;
    return cur.map((st, j) => {
      if (j !== hop.index) return st;
      const next = rec(innerList(st, hop) ?? [], depth + 1);
      const out = { ...st } as unknown as Record<string, unknown>;
      if (hop.list === 'branches') {
        const ways: Record<string, Step[] | undefined> = { ...branchesOf(st), [hop.outcome!]: next };
        if (!next.length) delete ways[hop.outcome!];
        if (Object.keys(ways).length) out.branches = ways; else delete out.branches;
      } else if (hop.list === 'onError/steps') out.onError = { ...st.onError, steps: next };
      else if (hop.list === 'else' && !next.length) delete out.else;
      else out[hop.list!] = next;
      return out as unknown as Step;
    });
  };
  return rec(steps, 0);
}

/** Nummer eines Schritts wie im Ablauf («2.1», «2.s1», im zweiten Weg «2.b1»); mit den Schritten auch für Wege genau. */
export function numberOf(path: string, steps?: Step[]): string {
  return stepNumberOfPath(path, steps) ?? '';
}

const tone = (s: Step) => (('task' in s || 'approval' in s) ? 'human' : 'action' in s ? 'data' : 'flow');

/** Titel eines Schritts ohne Art: eigene Bezeichnung, Titel der Aufgabe bzw. Aktion, sonst die Art; Daten mit Bezeichnung. */
function titleOnly(s: Step, actions: { key: string; label: string }[] | undefined, fields: ContextField[]): string {
  const raw = s.label || ('task' in s ? s.task.title : 'approval' in s ? s.approval.title : 'action' in s ? actions?.find(a => a.key === s.action)?.label : '');
  return (raw ? describeTemplate(raw, fields) : '') || STEP_KIND_LABEL[kindOf(s)] || 'Schritt';
}

const TRIGGER_TITLE = (t: Trigger) => ('event' in t ? 'Bei einem Ereignis' : 'schedule' in t ? 'Nach Zeitplan' : 'manual' in t ? 'Von Hand' : 'Später verfügbar');

/** Untertitel der Auslöser-Karte: der Satz ohne das, was der Titel schon sagt («Von Hand» unter «Von Hand» entfällt). */
function triggerSub(title: string, text: ReactNode): ReactNode {
  if (typeof text !== 'string') return text;
  const lower = text.toLowerCase(), head = title.toLowerCase();
  if (lower === head) return null;
  if (!lower.startsWith(head)) return text;
  const rest = text.slice(title.length).replace(/^[:\s]+/, '');
  return rest ? rest[0]!.toUpperCase() + rest.slice(1) : null;
}

/** Ergebnis eines Schritts auf der Karte: aus dem Probelauf oder aus einem Lauf. */
export type FlowStepResult = DryRunStepJson & {
  /** Lauf: Hier steht der Lauf gerade (wartet oder läuft). */
  active?: boolean;
  /** Lauf: Der Schritt wurde nach einem Vorfall übersprungen. */
  skipped?: boolean;
  /** Lauf: Text der Karte mit Namen und Zeiten (statt `summary`). */
  text?: ReactNode;
};

/** Ergebnis je Schritt (Pfad) auf den Karten: Probelauf (was geschähe) oder Lauf (was geschah). */
export interface FlowRun {
  steps: Map<string, FlowStepResult>;
  triggerMatches: boolean | null;
  /** Probelauf: angenommenes Ergebnis einer Aufgabe/Genehmigung wählen. */
  onAssume?: (stepId: string, outcome: string) => void;
  busy?: boolean;
  /** Tatsächlicher Lauf statt Probelauf; `open`: Der Lauf ist noch nicht beendet. */
  live?: { open: boolean };
  /** Zusatz unter der Karte eines Schritts (z. B. «Vorfall lösen»). */
  below?: (path: string) => ReactNode;
}

const RUN_TEXT = {
  dry: { skip: 'wird nicht erreicht', active: 'durchlaufen', bad: 'würde scheitern', ok: 'durchlaufen', jumped: 'durchlaufen' },
  open: { skip: 'noch nicht erreicht', active: 'hier steht der Run', bad: 'fehlgeschlagen', ok: 'erledigt', jumped: 'übersprungen' },
  done: { skip: 'nicht erreicht', active: 'hier steht der Run', bad: 'fehlgeschlagen', ok: 'erledigt', jumped: 'übersprungen' },
} as const;
const RUN_ICON = { ok: '✓', bad: '✕', active: '…', jumped: '↷' } as const;

/** Eingabe einer neuen Aktion mit den Vorgabewerten ihres Schemas (z. B. `{{subject.id}}` für den Bezug). */
function defaultInput(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, { default?: unknown }>;
  return Object.fromEntries(Object.entries(props).filter(([, p]) => p && p.default !== undefined).map(([k, p]) => [k, p.default]));
}

export interface FlowViewProps {
  steps: Step[];
  /** Probelauf auf den Karten (Modus «Probelauf»); ohne Angabe der Ablauf zum Bearbeiten. */
  run?: FlowRun | null;
  /** Keine Stellen zum Einfügen und kein Verschieben (Probelauf, auch bevor ein Ergebnis da ist). */
  locked?: boolean;
  /** Auslöser und sein Satz; `null`, solange noch keiner gewählt ist (leerer Ablauf). */
  trigger: { value: Trigger; text: ReactNode } | null;
  sel: FlowSelection;
  onSelect: (s: FlowSelection) => void;
  /** Ersten Schritt hinzufügen: Auslöser wählen. */
  onAddFirst: () => void;
  /** Schritt im eigenen Weg verschieben; gibt den neuen Pfad zurück (oder null am Rand). */
  onMove: (path: string, delta: -1 | 1) => string | null;
  onRemove: (path: string) => void;
  /** Schritt duplizieren (Ctrl+D); die Kopie steht direkt danach. */
  onDuplicate?: (path: string) => void;
  /** Formular des gewählten Schritts fokussieren (Enter). */
  onOpen: () => void;
}

export function FlowView({ steps, run, locked, trigger, sel, onSelect, onAddFirst, onMove, onRemove, onDuplicate, onOpen }: FlowViewProps) {
  const ed = useEditor();
  const warnings = ed.warnings ?? [];
  const editable = !ed.readOnly && !run && !locked;
  const baseId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const focusKey = useRef<string | null>(null);
  useEffect(() => {
    const k = focusKey.current;
    if (!k) return;
    focusKey.current = null;
    ref.current?.querySelector<HTMLElement>(`[data-flow="${k}"]`)?.focus();
  });
  const onKey = (e: KeyboardEvent<HTMLElement>, key: string) => {
    const cards = [...(ref.current?.querySelectorAll<HTMLElement>('[data-flow]') ?? [])];
    const i = cards.findIndex(r => r.dataset.flow === key);
    const go = (j: number) => { const r = cards[j]; if (r && j !== i) { r.focus(); r.click(); } };
    const isStep = key.startsWith('/');
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (!isStep || !editable) return;
      e.preventDefault();
      const next = onMove(key, e.key === 'ArrowDown' ? 1 : -1);
      if (next) focusKey.current = next;
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(Math.min(cards.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); onSelect(isStep ? { kind: 'step', path: key } : { kind: 'trigger' }); onOpen(); return; }
    if (!editable) return;
    if (e.key === 'Delete' && isStep) { e.preventDefault(); onRemove(key); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'd' && isStep && onDuplicate) { e.preventDefault(); onDuplicate(key); focusKey.current = `${splitPath(key).list}/${splitPath(key).index + 1}`; return; }
    if (e.key === '+') {
      e.preventDefault();
      if (isStep) { const { list, index } = splitPath(key); onSelect({ kind: 'insert', list, index: index + 1 }); }
      else onSelect({ kind: 'insert', list: '/steps', index: 0 });
    }
  };
  const isSel = (k: string) => (k === 'trigger' ? sel.kind === 'trigger' : sel.kind === 'step' && sel.path === k);
  const isInsert = (list: string, index: number) => sel.kind === 'insert' && sel.list === list && sel.index === index;
  /** Verbindung vor einem Schritt, mit «+» zum Einfügen an dieser Stelle. */
  const link = (list: string, index: number, where: string) => (
    <li className="wf-flow-link" aria-hidden={!editable || undefined}>
      {editable ? (
        <button type="button" className="wf-flow-plus" aria-current={isInsert(list, index) || undefined} aria-label={`Schritt einfügen ${where}`} title="Schritt einfügen"
          onClick={() => onSelect({ kind: 'insert', list, index })}>+</button>
      ) : null}
    </li>
  );
  /** Ende eines Wegs: «Schritt hinzufügen». */
  const tail = (list: string, index: number, where: string) => (!editable ? null : (
    <li className="wf-flow-tail">
      <button type="button" className="wf-flow-add" aria-current={isInsert(list, index) || undefined} aria-label={`Schritt einfügen ${where}`}
        onClick={() => onSelect({ kind: 'insert', list, index })}>
        <span aria-hidden="true">+</span> Schritt hinzufügen
      </button>
    </li>
  ));
  /** `dead`: Weg, den der Lauf nicht genommen hat – was darin steht, wird nie erreicht. */
  const renderList = (list: string, items: Step[], prefix: string, label: string, firstWhere: string, dead = false): ReactNode => (
    <ol className="wf-flow" aria-label={label}>
      {items.map((s, i) => {
        const path = `${list}/${i}`;
        const n = `${prefix}${i + 1}`;
        const errs = run ? 0 : ownErrors(ed.errors, path).length;
        const hints = run ? 0 : ownErrors(warnings, path).length;
        const kind = STEP_KIND_LABEL[kindOf(s)] ?? 'Schritt', title = titleOnly(s, ed.meta?.actions, ed.allFields ?? ed.fields);
        const r = run?.steps.get(path);
        const runState = !run ? null : !r ? 'skip' : r.active ? 'active' : r.error || r.allowed === false ? 'bad' : r.skipped ? 'jumped' : 'ok';
        const texts = !run?.live ? RUN_TEXT.dry : run.live.open && !dead ? RUN_TEXT.open : RUN_TEXT.done;
        const runText = runState ? texts[runState] : '';
        const issues = [errs ? plural(errs, 'Fehler', 'Fehler') : '', hints ? plural(hints, 'Hinweis', 'Hinweise') : ''].filter(Boolean).join(', ');
        // Genommener Weg: erst nach dem Ergebnis (solange der Lauf auf den Entscheid wartet, ist keiner ausgeschlossen)
        const taken = (way: string) => (!run || !r || r.active ? undefined : 'if' in s ? (way === 'then') === ((r.output as { result?: unknown } | undefined)?.result === true)
          : r.outcome === undefined ? undefined : r.outcome === way);
        return (
          <Fragment key={s.id}>
            {link(list, i, i === 0 ? firstWhere : `nach Schritt ${prefix}${i}`)}
            <li className={`wf-flow-item t-${tone(s)}${runState ? ` run-${runState}` : ''}`}>
              <button type="button" className="wf-card" data-flow={path} aria-current={isSel(path) || undefined}
                aria-label={`Schritt ${n}: ${stepTitle(s, ed.meta)}${issues ? `, ${issues}` : ''}${runText ? `, ${run?.live ? 'im Run' : 'im Probelauf'} ${runText}` : ''}`} aria-describedby={`${baseId}-${path}`}
                onClick={() => onSelect({ kind: 'step', path })} onKeyDown={e => onKey(e, path)}>
                <span className="wf-card-icon" aria-hidden="true">{n}</span>
                <span className="wf-card-body" id={`${baseId}-${path}`}>
                  {title === kind ? null : <span className="wf-card-kind">{kind}</span>}
                  <span className="wf-card-title">{title}</span>
                  {run ? <span className="wf-card-sub">{r ? (r.error?.message ?? (r.allowed === false ? `Dem Akteur fehlen Rechte: ${(r.missing ?? []).join(', ')}` : r.text ?? r.summary)) : texts.skip[0]!.toUpperCase() + texts.skip.slice(1)}</span> : <FlowSub step={s} />}
                </span>
                {errs || hints || (runState && runState !== 'skip') ? (
                  <span className="wf-card-tags">
                    {errs ? <span className="wf-card-err">{plural(errs, 'Fehler', 'Fehler')}</span> : null}
                    {hints ? <span className="wf-card-warn">{plural(hints, 'Hinweis', 'Hinweise')}</span> : null}
                    {runState && runState !== 'skip' ? <span className={`wf-card-run ${runState}`} aria-hidden="true">{RUN_ICON[runState]}</span> : null}
                  </span>
                ) : null}
              </button>
              {run?.onAssume && r?.outcomes && r.outcomes.length > 1 ? (
                <div className="wf-assume" role="group" aria-label={`Angenommenes Ergebnis von Schritt ${n}`}>
                  <span className="wf-assume-label" aria-hidden="true">Angenommen:</span>
                  {r.outcomes.map(o => (
                    <button key={o} type="button" aria-pressed={r.outcome === o} aria-disabled={run.busy || undefined}
                      onClick={() => { if (!run.busy && r.outcome !== o) run.onAssume!(s.id, o); }}>{outcomeLabel(o)}</button>
                  ))}
                </div>
              ) : null}
              {run?.below?.(path)}
              {'if' in s ? (
                <div className="wf-flow-lanes">
                  <Lane title="Dann" taken={taken('then')}>{renderList(`${path}/then`, s.then, `${n}.`, `Dann in Schritt ${n}`, `am Anfang von «Dann» in Schritt ${n}`, dead || taken('then') === false)}</Lane>
                  <Lane title="Sonst" taken={taken('else')}>{renderList(`${path}/else`, s.else ?? [], `${n}.s`, `Sonst in Schritt ${n}`, `am Anfang von «Sonst» in Schritt ${n}`, dead || taken('else') === false)}</Lane>
                </div>
              ) : null}
              {'foreach' in s ? (
                <div className="wf-flow-lanes one">
                  <Lane title="Für jeden Eintrag">{renderList(`${path}/steps`, s.steps, `${n}.`, `Für jeden Eintrag in Schritt ${n}`, `am Anfang der Schleife in Schritt ${n}`, dead)}</Lane>
                </div>
              ) : null}
              {hasWays(s) ? (
                <div className="wf-flow-lanes">
                  {outcomesOfStep(s).map((o, k) => {
                    const lp = `${path}/branches/${o}`;
                    const label = outcomeLabel(o) || '…';
                    return (
                      <Lane key={`${k}:${o}`} title={label} taken={taken(o)} hint={!run && warnings.some(w => w.path === lp) ? 'Hier geschieht nichts' : undefined}>
                        {renderList(lp, branchesOf(s)[o] ?? [], `${n}.${wayLetter(k)}`, `Weg «${label}» in Schritt ${n}`, `am Anfang von «${label}» in Schritt ${n}`, dead || taken(o) === false)}
                      </Lane>
                    );
                  })}
                </div>
              ) : null}
            </li>
          </Fragment>
        );
      })}
      {tail(list, items.length, items.length ? `nach Schritt ${prefix}${items.length}` : firstWhere)}
    </ol>
  );
  if (!trigger) {
    return (
      <div className="wf-flowview" ref={ref}>
        {ed.readOnly ? <p className="wf-muted">Dieser Workflow hat noch keinen Schritt.</p> : (
          <button type="button" className="wf-flow-first" onClick={onAddFirst}>
            <span className="wf-flow-first-plus" aria-hidden="true">+</span>
            <span className="wf-flow-first-title">Ersten Schritt hinzufügen</span>
            <span className="wf-flow-first-hint">Wähle, wie der Workflow startet.</span>
          </button>
        )}
      </div>
    );
  }
  const triggerTitle = TRIGGER_TITLE(trigger.value);
  const triggerText = triggerSub(triggerTitle, trigger.text);
  return (
    <div className="wf-flowview" ref={ref}>
      <ol className="wf-flow" aria-label="Ablauf">
        <li className={`wf-flow-item t-start${run ? (run.triggerMatches === false ? ' run-bad' : ' run-ok') : ''}`}>
          <button type="button" className="wf-card" data-flow="trigger" aria-current={isSel('trigger') || undefined} aria-label="Auslöser" aria-describedby={`${baseId}-start`}
            onClick={() => onSelect({ kind: 'trigger' })} onKeyDown={e => onKey(e, 'trigger')}>
            <span className="wf-card-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16"><path d="M9 1.6L3.6 9h4.1l-1 5.4L12.4 7H8.2z" fill="currentColor" /></svg>
            </span>
            <span className="wf-card-body" id={`${baseId}-start`}>
              <span className="wf-card-kind">Auslöser</span>
              <span className="wf-card-title">{triggerTitle}</span>
              {run?.triggerMatches === false ? <span className="wf-card-sub">Das Ereignis passt nicht zum Filter: Der Workflow würde nicht starten.</span>
                : triggerText ? <span className="wf-card-sub">{triggerText}</span> : null}
            </span>
          </button>
        </li>
      </ol>
      {renderList('/steps', steps, '', 'Schritte', 'nach dem Auslöser')}
    </div>
  );
}

/** Weg unter einem Schritt; im Probelauf ist der nicht genommene Weg blass (`taken === false`). */
function Lane({ title, hint, taken, children }: { title: string; hint?: string | undefined; taken?: boolean | undefined; children: ReactNode }) {
  return (
    <div className={`wf-lane${taken === false ? ' wf-lane-skip' : taken ? ' taken' : ''}`}>
      <span className="wf-lane-label">{title}</span>
      {hint ? <span className="wf-lane-hint">{hint}</span> : null}
      {children}
    </div>
  );
}

/** Dritte Zeile einer Karte: was der Schritt tut, ohne den Titel zu wiederholen. */
function FlowSub({ step }: { step: Step }) {
  const ed = useEditor();
  if ('action' in step && step.action) return null;
  return <span className="wf-card-sub"><StepSummary step={step} meta={ed.meta} fields={ed.fields} short /></span>;
}

// ---------------------------------------------------------------- Sheet

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Sheet am rechten Rand: hält den Fokus, Esc oder Klick daneben schliesst, danach Fokus zurück an den Auslöser. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="wf-sheet-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="wf-sheet" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKey}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Auswahl im Sheet

interface PickItem { key: string; group: string; label: string; hint: string; make: () => Step }
interface PickGroup { name: string; hint: string; items: PickItem[] }

const KIND_HINT: Partial<Record<StepKindName, [string, string]>> = {
  task: ['Menschen einbeziehen', 'Jemand erledigt etwas und meldet ein Ergebnis.'],
  approval: ['Menschen einbeziehen', 'Jemand entscheidet: genehmigt oder abgelehnt.'],
  if: ['Ablauf steuern', 'Nur weiter, wenn eine Bedingung zutrifft; sonst ein anderer Weg.'],
  foreach: ['Ablauf steuern', 'Schritte für jeden Eintrag einer Liste.'],
  wait: ['Ablauf steuern', 'Eine Dauer lang oder bis zu einem Zeitpunkt warten.'],
  set: ['Ablauf steuern', 'Werte für spätere Schritte merken.'],
  end: ['Ablauf steuern', 'Den Run hier beenden, mit Ergebnis.'],
  action: ['Aktionen', 'Aktion später wählen.'],
};

/** Gruppen der Auswahl: Menschen einbeziehen, Aktionen der App nach Gruppe, Ablauf steuern. */
function usePickGroups(): PickGroup[] {
  const ed = useEditor();
  const kinds = ADDABLE.filter(k => !ed.meta || ed.meta.stepKinds.includes(k));
  const items: PickItem[] = [];
  const kindItem = (k: StepKindName) => {
    const [group, hint] = KIND_HINT[k] ?? ['Ablauf steuern', ''];
    items.push({
      key: k, group, label: STEP_KIND_LABEL[k] ?? k, hint,
      make: () => {
        const step = newStep(k, ed.newId());
        if ('if' in step && 'all' in step.if) step.if = { all: [{ field: ed.fields[0]?.path ?? '', op: 'eq', value: '' }] };
        return step;
      },
    });
  };
  for (const k of ['task', 'approval'] as const) if (kinds.includes(k)) kindItem(k);
  if (kinds.includes('action')) {
    if (ed.meta?.actions.length) {
      for (const a of ed.meta.actions) {
        const hint = typeof a.input?.description === 'string' ? a.input.description : '';
        items.push({ key: `a:${a.key}`, group: a.group, label: a.label, hint, make: () => ({ id: ed.newId(), action: a.key, input: defaultInput(a.input) }) });
      }
    } else kindItem('action');
  }
  for (const k of ['if', 'foreach', 'wait', 'set', 'end'] as const) if (kinds.includes(k)) kindItem(k);
  const names = [...new Set(items.map(x => x.group))];
  return names.map(name => {
    const list = items.filter(x => x.group === name);
    return { name, items: list, hint: list.map(x => x.label).join(', ') };
  });
}

/** Sheet «Schritt hinzufügen»: Gruppen, dann Schritte der Gruppe mit «Zurück»; die Suche findet über alle Gruppen. */
export function StepSheet({ where, onPick, onClose }: { where: string; onPick: (s: Step) => void; onClose: () => void }) {
  const { ui } = useWorkflow();
  const id = useId();
  const groups = usePickGroups();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const lastGroup = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  useEffect(() => {
    if (needle) return;
    if (open) listRef.current?.querySelector<HTMLElement>('.wf-sheet-back')?.focus();
    else if (lastGroup.current) [...(listRef.current?.querySelectorAll<HTMLElement>('[data-group]') ?? [])].find(b => b.dataset.group === lastGroup.current)?.focus();
  }, [open, needle]);
  const item = (x: PickItem) => (
    <button key={x.key} type="button" className="wf-sheet-item" onClick={() => onPick(x.make())}>
      <b>{x.label}</b>{x.hint ? <span>{x.hint}</span> : null}
    </button>
  );
  const group = groups.find(g => g.name === open);
  const found = needle ? groups.map(g => ({ ...g, items: g.items.filter(x => `${x.label} ${x.hint} ${g.name}`.toLowerCase().includes(needle)) })).filter(g => g.items.length) : [];
  return (
    <Sheet title="Schritt hinzufügen" onClose={onClose}>
      <header className="wf-sheet-head">
        <div className="wf-grow">
          <h2>Schritt hinzufügen</h2>
          <p className="wf-hint">{where.charAt(0).toUpperCase() + where.slice(1)}</p>
        </div>
        <ui.Button size="sm" variant="ghost" aria-label="Schliessen" onClick={onClose}>✕</ui.Button>
      </header>
      <label htmlFor={`${id}-q`} className="wf-sr">Schritt suchen</label>
      <ui.Input id={`${id}-q`} type="search" data-autofocus placeholder="Suchen: Status, Genehmigung, warten …" value={q} onChange={e => setQ(e.target.value)} />
      <div ref={listRef} className="wf-sheet-list">
        {needle ? (
          found.length ? found.map(g => (
            <div key={g.name} role="group" aria-label={g.name} className="wf-sheet-group">
              <p className="wf-sheet-group-h">{g.name}</p>
              {g.items.map(item)}
            </div>
          )) : <p className="wf-muted wf-small">Kein Schritt passt zur Suche.</p>
        ) : group ? (
          <div role="group" aria-label={group.name} className="wf-sheet-group">
            <button type="button" className="wf-sheet-back" onClick={() => setOpen(null)}>← Zurück</button>
            <h3 className="wf-sheet-group-title">{group.name}</h3>
            {group.items.map(item)}
          </div>
        ) : (
          <ul className="wf-sheet-groups" aria-label="Gruppen">
            {groups.map(g => (
              <li key={g.name}>
                <button type="button" className="wf-sheet-gbtn" data-group={g.name} onClick={() => { lastGroup.current = g.name; setOpen(g.name); }}>
                  <span><b>{g.name}</b><span>{g.hint}</span></span>
                  <span className="wf-sheet-count" aria-hidden="true">{g.items.length} ›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

/** Sheet «Wie startet der Workflow?» für den ersten Schritt. */
export function TriggerSheet({ onPick, onClose }: { onPick: (kind: 'event' | 'schedule' | 'manual') => void; onClose: () => void }) {
  const { ui } = useWorkflow();
  const options: ['event' | 'schedule' | 'manual', string, string][] = [
    ['event', 'Wenn etwas passiert', 'Bei einem Ereignis der App, z. B. wenn sich etwas ändert.'],
    ['schedule', 'Nach Zeitplan', 'Täglich, werktags, an Wochentagen, monatlich oder stündlich.'],
    ['manual', 'Von Hand', 'Mit einem Knopf, auf Wunsch mit Eingabeformular.'],
  ];
  return (
    <Sheet title="Wie startet der Workflow?" onClose={onClose}>
      <header className="wf-sheet-head">
        <div className="wf-grow">
          <h2>Wie startet der Workflow?</h2>
          <p className="wf-hint">Der erste Schritt ist der Auslöser.</p>
        </div>
        <ui.Button size="sm" variant="ghost" aria-label="Schliessen" onClick={onClose}>✕</ui.Button>
      </header>
      <div className="wf-sheet-list">
        {options.map(([k, label, hint], i) => (
          <button key={k} type="button" className="wf-sheet-item" data-autofocus={i === 0 || undefined} onClick={() => onPick(k)}>
            <b>{label}</b><span>{hint}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Detail eines Schritts

/** Formular des gewählten Schritts mit Nummer, Titel, Werkzeugen (↑, ↓, entfernen) und Hinweisen der Prüfung. */
export function StepDetail({ step, path, last, onChange, onRemove, onMove, onDuplicate }: {
  step: Step; path: string; /** Letzter Schritt seines Wegs? */ last: boolean; onChange: (s: Step) => void; onRemove: () => void; onMove: (delta: -1 | 1) => void;
  onDuplicate?: () => void;
}) {
  const ed = useEditor();
  const { ui } = useWorkflow();
  const number = numberOf(path, ed.steps);
  const name = `Schritt ${number}`;
  const errs = ownErrors(ed.errors, path);
  const hints = ownErrors(ed.warnings ?? [], path);
  const { list, index } = splitPath(path);
  const here = ed.fieldsAt ? { ...ed, fields: ed.fieldsAt(path) } : ed;
  return (
    <section className="wf-detail-step" aria-label={`${name}: ${stepTitle(step, ed.meta)}`}>
      <header className="wf-detail-head">
        <div className="wf-grow">
          <p className="wf-detail-ey">{`${name} · ${STEP_KIND_LABEL[kindOf(step)] ?? 'Schritt'}`}{list !== '/steps' ? ` · ${laneOf(list)}` : ''}</p>
          <h3>{titleOnly(step, ed.meta?.actions, ed.allFields ?? ed.fields)}</h3>
        </div>
        {!ed.readOnly ? (
          <div className="wf-step-tools">
            <ui.Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`${name} nach oben`}>↑</ui.Button>
            <ui.Button size="sm" variant="ghost" disabled={last} onClick={() => onMove(1)} aria-label={`${name} nach unten`}>↓</ui.Button>
            {onDuplicate ? <ui.Button size="sm" variant="ghost" onClick={onDuplicate} aria-label={`${name} duplizieren`} title="Duplizieren (Ctrl+D)">⧉</ui.Button> : null}
            <ui.Button size="sm" variant="ghost" onClick={onRemove} aria-label={`${name} entfernen`}>✕</ui.Button>
          </div>
        ) : null}
      </header>
      {errs.length ? (
        <ul className="wf-step-errors" aria-label={`Fehler in ${name}`}>
          {errs.map((e, i) => <li key={i}>{e.message}</li>)}
        </ul>
      ) : null}
      {hints.length ? (
        <ul className="wf-step-hints" aria-label={`Hinweise zu ${name}`}>
          {hints.map((e, i) => <li key={i}>{e.message}</li>)}
        </ul>
      ) : null}
      <EditorCtx.Provider value={here}>
        <fieldset className="wf-step-body" disabled={ed.readOnly} aria-label={`${name} bearbeiten`}>
          <StepBody step={step} number={number} onChange={onChange} />
          <CommonFields step={step} onChange={onChange} name={name} />
        </fieldset>
      </EditorCtx.Provider>
    </section>
  );
}

const laneOf = (list: string) => {
  const way = /\/branches\/([^/]+)$/.exec(list);
  return way ? `Weg «${outcomeLabel(way[1])}»` : list.endsWith('/then') ? 'Weg «Dann»' : list.endsWith('/else') ? 'Weg «Sonst»' : 'für jeden Eintrag';
};
