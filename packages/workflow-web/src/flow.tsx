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
 *   der Editor), + fügt danach ein, Enter springt ins Formular.
 * - Die Definition ändert sich nur über die reinen Hilfen (`withList`, `listAt`, `stepAt`, `splitPath`).
 * - Ohne `workflow:manage` (nur lesbar) gibt es keine Stellen zum Einfügen; Karten lassen sich trotzdem öffnen.
 * - Das Sheet hält den Fokus, Esc oder ein Klick daneben schliesst es, danach geht der Fokus zurück an den Auslöser.
 */
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useWorkflow } from './provider.tsx';
import {
  ADDABLE, CommonFields, kindOf, newStep, ownErrors, STEP_KIND_LABEL, StepBody, StepSummary, stepTitle, useEditor, type StepKindName,
} from './steps.tsx';
import type { Step, Trigger } from './types.ts';
import { plural } from './ui.tsx';

/** Was im Ablauf gewählt ist: der Auslöser, ein Schritt (Pfad) oder eine Stelle zum Einfügen. */
export type FlowSelection = { kind: 'trigger' } | { kind: 'step'; path: string } | { kind: 'insert'; list: string; index: number };

const segments = (p: string) => p.split('/').filter(Boolean);
type Lists = Record<string, Step[] | undefined>;

/** Pfad eines Schritts → Liste und Index (`/steps/1/then/0` → `/steps/1/then`, 0). */
export function splitPath(path: string): { list: string; index: number } {
  const i = path.lastIndexOf('/');
  return { list: path.slice(0, i), index: Number(path.slice(i + 1)) };
}

/** Schritte einer Liste (`/steps`, `/steps/1/then`, `/steps/2/steps`); ein fehlendes «Sonst» ist leer. */
export function listAt(steps: Step[], list: string): Step[] | undefined {
  const s = segments(list);
  let cur: Step[] | undefined = steps;
  for (let i = 1; i < s.length; i += 2) {
    const st: Step | undefined = cur?.[Number(s[i])];
    if (!st) return undefined;
    cur = (st as unknown as Lists)[s[i + 1]!] ?? [];
  }
  return cur;
}

export const stepAt = (steps: Step[], path: string): Step | undefined => {
  const { list, index } = splitPath(path);
  return listAt(steps, list)?.[index];
};

/** Neue Schrittliste, in der die Liste `list` durch `fn` ersetzt ist; ein leeres «Sonst» fällt weg. */
export function withList(steps: Step[], list: string, fn: (l: Step[]) => Step[]): Step[] {
  const rec = (cur: Step[], rest: string[]): Step[] => {
    if (!rest.length) return fn(cur);
    const [i, key, ...more] = rest as [string, string, ...string[]];
    return cur.map((st, j) => {
      if (j !== Number(i)) return st;
      const next = rec((st as unknown as Lists)[key] ?? [], more);
      const out = { ...st } as unknown as Record<string, unknown>;
      if (key === 'else' && !next.length) delete out.else; else out[key] = next;
      return out as unknown as Step;
    });
  };
  return rec(steps, segments(list).slice(1));
}

/** Nummer eines Schritts wie im Ablauf («2.1», «2.s1»). */
export function numberOf(path: string): string {
  const s = segments(path);
  let n = '';
  for (let i = 1; i < s.length; i += 2) {
    const k = Number(s[i]) + 1;
    n = n ? `${n}.${s[i - 1] === 'else' ? 's' : ''}${k}` : String(k);
  }
  return n;
}

const tone = (s: Step) => (('task' in s || 'approval' in s) ? 'human' : 'action' in s ? 'data' : 'flow');

/** Titel eines Schritts ohne Art: eigene Bezeichnung, Titel der Aufgabe bzw. Aktion, sonst die Art. */
function titleOnly(s: Step, actions: { key: string; label: string }[] | undefined): string {
  return s.label || ('task' in s ? s.task.title : 'approval' in s ? s.approval.title : 'action' in s ? actions?.find(a => a.key === s.action)?.label : '')
    || STEP_KIND_LABEL[kindOf(s)] || 'Schritt';
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

export interface FlowViewProps {
  steps: Step[];
  /** Auslöser und sein Satz; `null`, solange noch keiner gewählt ist (leerer Ablauf). */
  trigger: { value: Trigger; text: ReactNode } | null;
  sel: FlowSelection;
  onSelect: (s: FlowSelection) => void;
  /** Ersten Schritt hinzufügen: Auslöser wählen. */
  onAddFirst: () => void;
  /** Schritt im eigenen Weg verschieben; gibt den neuen Pfad zurück (oder null am Rand). */
  onMove: (path: string, delta: -1 | 1) => string | null;
  onRemove: (path: string) => void;
  /** Formular des gewählten Schritts fokussieren (Enter). */
  onOpen: () => void;
}

export function FlowView({ steps, trigger, sel, onSelect, onAddFirst, onMove, onRemove, onOpen }: FlowViewProps) {
  const ed = useEditor();
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
      if (!isStep || ed.readOnly) return;
      e.preventDefault();
      const next = onMove(key, e.key === 'ArrowDown' ? 1 : -1);
      if (next) focusKey.current = next;
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(Math.min(cards.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); onSelect(isStep ? { kind: 'step', path: key } : { kind: 'trigger' }); onOpen(); return; }
    if (ed.readOnly) return;
    if (e.key === 'Delete' && isStep) { e.preventDefault(); onRemove(key); return; }
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
    <li className="wf-flow-link" aria-hidden={ed.readOnly || undefined}>
      {!ed.readOnly ? (
        <button type="button" className="wf-flow-plus" aria-current={isInsert(list, index) || undefined} aria-label={`Schritt einfügen ${where}`} title="Schritt einfügen"
          onClick={() => onSelect({ kind: 'insert', list, index })}>+</button>
      ) : null}
    </li>
  );
  /** Ende eines Wegs: «Schritt hinzufügen». */
  const tail = (list: string, index: number, where: string) => (ed.readOnly ? null : (
    <li className="wf-flow-tail">
      <button type="button" className="wf-flow-add" aria-current={isInsert(list, index) || undefined} aria-label={`Schritt einfügen ${where}`}
        onClick={() => onSelect({ kind: 'insert', list, index })}>
        <span aria-hidden="true">+</span> Schritt hinzufügen
      </button>
    </li>
  ));
  const renderList = (list: string, items: Step[], prefix: string, label: string, firstWhere: string): ReactNode => (
    <ol className="wf-flow" aria-label={label}>
      {items.map((s, i) => {
        const path = `${list}/${i}`;
        const n = `${prefix}${i + 1}`;
        const errs = ownErrors(ed.errors, path).length;
        const kind = STEP_KIND_LABEL[kindOf(s)] ?? 'Schritt', title = titleOnly(s, ed.meta?.actions);
        return (
          <Fragment key={s.id}>
            {link(list, i, i === 0 ? firstWhere : `nach Schritt ${prefix}${i}`)}
            <li className={`wf-flow-item t-${tone(s)}`}>
              <button type="button" className="wf-card" data-flow={path} aria-current={isSel(path) || undefined}
                aria-label={`Schritt ${n}: ${stepTitle(s, ed.meta)}${errs ? `, ${plural(errs, 'Hinweis', 'Hinweise')}` : ''}`} aria-describedby={`${baseId}-${path}`}
                onClick={() => onSelect({ kind: 'step', path })} onKeyDown={e => onKey(e, path)}>
                <span className="wf-card-icon" aria-hidden="true">{n}</span>
                <span className="wf-card-body" id={`${baseId}-${path}`}>
                  {title === kind ? null : <span className="wf-card-kind">{kind}</span>}
                  <span className="wf-card-title">{title}</span>
                  <FlowSub step={s} />
                </span>
                {errs ? <span className="wf-card-err">{plural(errs, 'Hinweis', 'Hinweise')}</span> : null}
              </button>
              {'if' in s ? (
                <div className="wf-flow-lanes">
                  <Lane title="Dann">{renderList(`${path}/then`, s.then, `${n}.`, `Dann in Schritt ${n}`, `am Anfang von «Dann» in Schritt ${n}`)}</Lane>
                  <Lane title="Sonst">{renderList(`${path}/else`, s.else ?? [], `${n}.s`, `Sonst in Schritt ${n}`, `am Anfang von «Sonst» in Schritt ${n}`)}</Lane>
                </div>
              ) : null}
              {'foreach' in s ? (
                <div className="wf-flow-lanes one">
                  <Lane title="Für jeden Eintrag">{renderList(`${path}/steps`, s.steps, `${n}.`, `Für jeden Eintrag in Schritt ${n}`, `am Anfang der Schleife in Schritt ${n}`)}</Lane>
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
        <li className="wf-flow-item t-start">
          <button type="button" className="wf-card" data-flow="trigger" aria-current={isSel('trigger') || undefined} aria-label="Auslöser" aria-describedby={`${baseId}-start`}
            onClick={() => onSelect({ kind: 'trigger' })} onKeyDown={e => onKey(e, 'trigger')}>
            <span className="wf-card-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16"><path d="M9 1.6L3.6 9h4.1l-1 5.4L12.4 7H8.2z" fill="currentColor" /></svg>
            </span>
            <span className="wf-card-body" id={`${baseId}-start`}>
              <span className="wf-card-kind">Auslöser</span>
              <span className="wf-card-title">{triggerTitle}</span>
              {triggerText ? <span className="wf-card-sub">{triggerText}</span> : null}
            </span>
          </button>
        </li>
      </ol>
      {renderList('/steps', steps, '', 'Schritte', 'nach dem Auslöser')}
    </div>
  );
}

function Lane({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wf-lane">
      <span className="wf-lane-label">{title}</span>
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
  end: ['Ablauf steuern', 'Den Lauf hier beenden, mit Ergebnis.'],
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
        items.push({ key: `a:${a.key}`, group: a.group, label: a.label, hint, make: () => ({ id: ed.newId(), action: a.key, input: {} }) });
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
export function StepDetail({ step, path, last, onChange, onRemove, onMove }: {
  step: Step; path: string; /** Letzter Schritt seines Wegs? */ last: boolean; onChange: (s: Step) => void; onRemove: () => void; onMove: (delta: -1 | 1) => void;
}) {
  const ed = useEditor();
  const { ui } = useWorkflow();
  const number = numberOf(path);
  const name = `Schritt ${number}`;
  const errs = ownErrors(ed.errors, path);
  const { list, index } = splitPath(path);
  return (
    <section className="wf-detail-step" aria-label={`${name}: ${stepTitle(step, ed.meta)}`}>
      <header className="wf-detail-head">
        <div className="wf-grow">
          <p className="wf-detail-ey">{`${name} · ${STEP_KIND_LABEL[kindOf(step)] ?? 'Schritt'}`}{list !== '/steps' ? ` · ${laneOf(list)}` : ''}</p>
          <h3>{titleOnly(step, ed.meta?.actions)}</h3>
        </div>
        {!ed.readOnly ? (
          <div className="wf-step-tools">
            <ui.Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`${name} nach oben`}>↑</ui.Button>
            <ui.Button size="sm" variant="ghost" disabled={last} onClick={() => onMove(1)} aria-label={`${name} nach unten`}>↓</ui.Button>
            <ui.Button size="sm" variant="ghost" onClick={onRemove} aria-label={`${name} entfernen`}>✕</ui.Button>
          </div>
        ) : null}
      </header>
      {errs.length ? (
        <ul className="wf-step-errors" aria-label={`Hinweise zu ${name}`}>
          {errs.map((e, i) => <li key={i}>{e.message}</li>)}
        </ul>
      ) : null}
      <fieldset className="wf-step-body" disabled={ed.readOnly} aria-label={`${name} bearbeiten`}>
        <StepBody step={step} number={number} onChange={onChange} />
        <CommonFields step={step} onChange={onChange} name={name} />
      </fieldset>
    </section>
  );
}

const laneOf = (list: string) => (list.endsWith('/then') ? 'Weg «Dann»' : list.endsWith('/else') ? 'Weg «Sonst»' : 'für jeden Eintrag');
