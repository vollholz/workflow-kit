/**
 * Ablauf im Editor (UX-Neukonzept Etappe 2): kompakte Liste in Klartext mit Start, Schritten, Wegen (Dann, Sonst, Für
 * jeden Eintrag) und Ende; «+» an jeder Stelle öffnet die Auswahl der Schritte (`StepPicker`). Das Formular des
 * gewählten Schritts zeigt der Detailbereich (`StepDetail`).
 *
 * Regeln:
 * - Auswahl über Pfade: Start (`trigger`), Schritt (`/steps/1/then/0`), Stelle zum Einfügen (Liste und Index).
 * - Tastatur in der Liste: ↓/↑ oder J/K wechseln die Zeile, Alt+↓/↑ verschiebt den Schritt in seinem Weg, Entf entfernt
 *   (Rückgängig bietet der Editor), + öffnet die Auswahl nach dem Schritt, Enter springt ins Formular.
 * - Die Definition ändert sich nur über die reinen Hilfen (`withList`, `listAt`, `stepAt`, `splitPath`).
 * - Ohne `workflow:manage` (nur lesbar) gibt es keine Stellen zum Einfügen; Zeilen lassen sich trotzdem öffnen.
 */
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useWorkflow } from './provider.tsx';
import {
  ADDABLE, CommonFields, kindOf, newStep, ownErrors, STEP_KIND_LABEL, StepBody, StepSummary, stepTitle, useEditor, type StepKindName,
} from './steps.tsx';
import type { Step } from './types.ts';
import { plural } from './ui.tsx';

/** Was im Ablauf gewählt ist: der Start, ein Schritt (Pfad) oder eine Stelle zum Einfügen. */
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

/** Nummer eines Schritts wie in der Liste («2.1», «2.s1»). */
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

export interface FlowViewProps {
  steps: Step[];
  /** Satz zum Auslöser (Zeile «Start»). */
  trigger: ReactNode;
  sel: FlowSelection;
  onSelect: (s: FlowSelection) => void;
  /** Schritt im eigenen Weg verschieben; gibt den neuen Pfad zurück (oder null am Rand). */
  onMove: (path: string, delta: -1 | 1) => string | null;
  onRemove: (path: string) => void;
  /** Formular des gewählten Schritts fokussieren (Enter). */
  onOpen: () => void;
}

export function FlowView({ steps, trigger, sel, onSelect, onMove, onRemove, onOpen }: FlowViewProps) {
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
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[data-flow]') ?? [])];
    const i = rows.findIndex(r => r.dataset.flow === key);
    const go = (j: number) => { const r = rows[j]; if (r && j !== i) { r.focus(); r.click(); } };
    const isStep = key.startsWith('/');
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (!isStep || ed.readOnly) return;
      e.preventDefault();
      const next = onMove(key, e.key === 'ArrowDown' ? 1 : -1);
      if (next) focusKey.current = next;
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(Math.min(rows.length - 1, i + 1)); return; }
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
  const insertSlot = (list: string, index: number, where: string, empty = false) => {
    if (ed.readOnly) return null;
    const on = sel.kind === 'insert' && sel.list === list && sel.index === index;
    return (
      <li className={`wf-flow-ins${empty ? ' empty' : ''}`}>
        <button type="button" className="wf-flow-plus" aria-current={on || undefined} aria-label={`Schritt einfügen ${where}`} title={`Schritt einfügen ${where}`}
          onClick={() => onSelect({ kind: 'insert', list, index })}>
          <span aria-hidden="true">+</span>{empty ? <span className="wf-flow-plus-l">Schritt einfügen</span> : null}
        </button>
      </li>
    );
  };
  const renderList = (list: string, items: Step[], prefix: string, label: string, firstWhere: string): ReactNode => (
    <ol className="wf-flow" aria-label={label}>
      {items.length ? insertSlot(list, 0, firstWhere) : insertSlot(list, 0, firstWhere, true)}
      {items.map((s, i) => {
        const path = `${list}/${i}`;
        const n = `${prefix}${i + 1}`;
        const errs = ownErrors(ed.errors, path).length;
        return (
          <Fragment key={s.id}>
          <li className={`wf-flow-item t-${tone(s)}`}>
            <button type="button" className="wf-flow-row" data-flow={path} aria-current={isSel(path) || undefined}
              aria-label={`Schritt ${n}: ${stepTitle(s, ed.meta)}${errs ? `, ${plural(errs, 'Hinweis', 'Hinweise')}` : ''}`} aria-describedby={`${baseId}-${path}`}
              onClick={() => onSelect({ kind: 'step', path })} onKeyDown={e => onKey(e, path)}>
              <span className="wf-flow-no" aria-hidden="true">{n}</span>
              <span className="wf-flow-txt" id={`${baseId}-${path}`}>
                <span className="wf-flow-title">{stepTitle(s, ed.meta)}</span>
                <FlowSub step={s} />
              </span>
              {errs ? <span className="wf-flow-err">{plural(errs, 'Hinweis', 'Hinweise')}</span> : null}
            </button>
            {'if' in s ? (
              <div className="wf-flow-lanes">
                <Lane title="Dann">{renderList(`${path}/then`, s.then, `${n}.`, `Dann in Schritt ${n}`, `am Anfang von «Dann» in Schritt ${n}`)}</Lane>
                <Lane title="Sonst">{renderList(`${path}/else`, s.else ?? [], `${n}.s`, `Sonst in Schritt ${n}`, `am Anfang von «Sonst» in Schritt ${n}`)}</Lane>
              </div>
            ) : null}
            {'foreach' in s ? (
              <div className="wf-flow-lanes">
                <Lane title="Für jeden Eintrag">{renderList(`${path}/steps`, s.steps, `${n}.`, `Für jeden Eintrag in Schritt ${n}`, `am Anfang der Schleife in Schritt ${n}`)}</Lane>
              </div>
            ) : null}
          </li>
          {insertSlot(list, i + 1, `nach Schritt ${n}`)}
          </Fragment>
        );
      })}
    </ol>
  );
  return (
    <div className="wf-flowview" ref={ref}>
      <button type="button" className="wf-flow-row start" data-flow="trigger" aria-current={isSel('trigger') || undefined} aria-label="Start" aria-describedby={`${baseId}-start`}
        onClick={() => onSelect({ kind: 'trigger' })} onKeyDown={e => onKey(e, 'trigger')}>
        <span className="wf-flow-no" aria-hidden="true">▶</span>
        <span className="wf-flow-txt" id={`${baseId}-start`}><span className="wf-flow-title">Start</span><span className="wf-flow-sum">{trigger}</span></span>
      </button>
      {renderList('/steps', steps, '', 'Schritte', 'nach dem Start')}
      <div className="wf-flow-row end" aria-hidden="true"><span className="wf-flow-no">■</span><span className="wf-flow-txt"><span className="wf-flow-title">Ende</span></span></div>
    </div>
  );
}

function Lane({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wf-flow-lane">
      <p className="wf-flow-lane-h">{title}</p>
      {children}
    </div>
  );
}

/** Zweite Zeile eines Schritts: was er tut, ohne den Titel zu wiederholen. */
function FlowSub({ step }: { step: Step }) {
  const ed = useEditor();
  if ('action' in step && step.action) return null;
  return <span className="wf-flow-sum"><StepSummary step={step} meta={ed.meta} fields={ed.fields} short /></span>;
}

// ---------------------------------------------------------------- Auswahl der Schritte

interface PickItem { key: string; group: string; label: string; hint: string; make: () => Step }

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

/** Auswahl eines neuen Schritts mit Suche: Menschen einbeziehen, Aktionen der App nach Gruppe, Ablauf steuern. */
export function StepPicker({ where, onPick, onCancel }: { where: string; onPick: (s: Step) => void; onCancel: () => void }) {
  const ed = useEditor();
  const { ui } = useWorkflow();
  const id = useId();
  const [q, setQ] = useState('');
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
  const needle = q.trim().toLowerCase();
  const shown = items.filter(x => !needle || `${x.label} ${x.hint} ${x.group}`.toLowerCase().includes(needle));
  const groups = [...new Set(shown.map(x => x.group))];
  return (
    <section className="wf-picker" aria-label={where} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}>
      <p className="wf-detail-ey">Schritt einfügen</p>
      <h3>{where}</h3>
      <label htmlFor={`${id}-q`} className="wf-sr">Schritt suchen</label>
      <ui.Input id={`${id}-q`} type="search" autoFocus placeholder="Suchen: Status, Genehmigung, warten …" value={q} onChange={e => setQ(e.target.value)} />
      {groups.length ? groups.map(g => (
        <div key={g} className="wf-picker-group" role="group" aria-label={g}>
          <p className="wf-picker-h">{g}</p>
          {shown.filter(x => x.group === g).map(x => (
            <button key={x.key} type="button" className="wf-picker-item" onClick={() => onPick(x.make())}>
              <b>{x.label}</b>{x.hint ? <span>{x.hint}</span> : null}
            </button>
          ))}
        </div>
      )) : <p className="wf-muted wf-small">Kein Schritt passt zur Suche.</p>}
    </section>
  );
}

// ---------------------------------------------------------------- Detail eines Schritts

/** Formular des gewählten Schritts mit Nummer, Titel, Werkzeugen (↑, ↓, entfernen) und Hinweisen der Prüfung. */
export function StepDetail({ step, path, last, onChange, onRemove, onMove }: {
  step: Step; path: string; /** Letzter Schritt seines Wegs? */ last: boolean; onChange: (s: Step) => void; onRemove: () => void; onMove: (delta: -1 | 1) => void;
}) {
  const ed = useEditor();
  const { ui } = useWorkflow();
  const id = useId();
  const number = numberOf(path);
  const name = `Schritt ${number}`;
  const errs = ownErrors(ed.errors, path);
  const { list, index } = splitPath(path);
  return (
    <section className="wf-detail-step" aria-label={`${name}: ${stepTitle(step, ed.meta)}`}>
      <header className="wf-detail-head">
        <div className="wf-grow">
          <p className="wf-detail-ey">{`${name} · ${STEP_KIND_LABEL[kindOf(step)] ?? 'Schritt'}`}{list !== '/steps' ? ` · ${laneOf(list)}` : ''}</p>
          <h3>{stepTitle(step, ed.meta)}</h3>
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
