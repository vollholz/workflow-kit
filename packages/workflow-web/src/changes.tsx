/**
 * Änderungen des Entwurfs gegenüber der aktiven Version (UX-Neukonzept Etappe 3): Auslöser, neue, entfernte, geänderte
 * und verschobene Schritte, in Worten mit Nummer und Titel. Für «Änderungen ansehen» und den Aktivieren-Dialog.
 *
 * Regeln:
 * - Schritte werden über ihre ID verglichen; ein Schritt gilt als geändert, wenn sich seine eigenen Angaben ändern (ohne
 *   die Schritte in seinen Wegen, die zählen für sich).
 * - Verschoben ist ein Schritt, der in einen anderen Weg wandert oder in seinem Weg die Reihenfolge wechselt; dass sich
 *   Nummern durch Einfügen davor ändern, zählt nicht.
 */
import { stepNumberOfPath, stepTitle, walkPaths } from './paths.ts';
import { describeTrigger } from './trigger.tsx';
import type { AutomationDefinition, Step, WorkflowMetaJson } from './types.ts';

export type ChangeKind = 'trigger' | 'added' | 'removed' | 'changed' | 'moved' | 'other';
export interface DefinitionChange { kind: ChangeKind; text: string }

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, (x as Record<string, unknown>)[k]])) : x);

/** Eigene Angaben eines Schritts ohne die Schritte in seinen Wegen. */
function own(s: Step): string {
  const o = { ...s } as Record<string, unknown>;
  delete o.then; delete o.else; delete o.branches;
  if ('foreach' in s) delete o.steps;
  if (s.onError) o.onError = { ...s.onError, steps: undefined };
  return canonical(o);
}

/** Liste, in der ein Schritt steht, benannt nach dem Schritt, dem sie gehört (`/steps/1/then/0` → `<id>/then`). */
function listKey(path: string, idAt: Map<string, string>): string {
  const list = path.slice(0, path.lastIndexOf('/'));
  if (list === '/steps') return '/steps';
  const m = /^(.*\/\d+)(\/.*)$/.exec(list);
  return m ? `${idAt.get(m[1]!) ?? m[1]}${m[2]}` : list;
}

interface Placed { step: Step; path: string; list: string }

function index(def: AutomationDefinition): Map<string, Placed> {
  const idAt = new Map<string, string>();
  const all = [...walkPaths(def.steps)];
  for (const [s, p] of all) idAt.set(p, s.id);
  return new Map(all.map(([s, p]) => [s.id, { step: s, path: p, list: listKey(p, idAt) }]));
}

/** Änderungen von `before` (aktive Version) zu `after` (Entwurf). */
export function diffDefinitions(before: AutomationDefinition, after: AutomationDefinition, meta: WorkflowMetaJson | undefined): DefinitionChange[] {
  const out: DefinitionChange[] = [];
  if (canonical(before.trigger) !== canonical(after.trigger)) {
    const a = describeTrigger(before.trigger, meta), b = describeTrigger(after.trigger, meta);
    out.push({ kind: 'trigger', text: a === b ? 'geändert' : `${a} → ${b}` });
  }
  const was = index(before), now = index(after);
  const name = (p: Placed, steps: Step[]) => `Schritt ${stepNumberOfPath(p.path, steps) ?? '?'} · ${stepTitle(p.step, meta)}`;
  // Reihenfolge je Liste: gemeinsame Schritte in derselben Liste, deren Reihenfolge wechselt
  const order = (m: Map<string, Placed>, list: string, ids: Set<string>) => [...m.values()].filter(p => p.list === list && ids.has(p.step.id))
    .sort((x, y) => Number(x.path.slice(x.path.lastIndexOf('/') + 1)) - Number(y.path.slice(y.path.lastIndexOf('/') + 1))).map(p => p.step.id);
  const reordered = new Set<string>();
  for (const list of new Set([...now.values()].map(p => p.list))) {
    const common = new Set([...now.values()].filter(p => p.list === list && was.get(p.step.id)?.list === list).map(p => p.step.id));
    const a = order(was, list, common), b = order(now, list, common);
    a.forEach((id, i) => { if (b[i] !== id) reordered.add(id); });
  }
  for (const p of now.values()) {
    const q = was.get(p.step.id);
    if (!q) { out.push({ kind: 'added', text: name(p, after.steps) }); continue; }
    if (own(q.step) !== own(p.step)) out.push({ kind: 'changed', text: name(p, after.steps) });
    else if (q.list !== p.list || reordered.has(p.step.id)) out.push({ kind: 'moved', text: name(p, after.steps) });
  }
  for (const q of was.values()) if (!now.has(q.step.id)) out.push({ kind: 'removed', text: `${stepTitle(q.step, meta)} (bisher Schritt ${stepNumberOfPath(q.path, before.steps) ?? '?'})` });
  if (canonical({ v: before.variables, e: before.onError }) !== canonical({ v: after.variables, e: after.onError })) {
    out.push({ kind: 'other', text: 'Variablen oder Fehlerbehandlung geändert' });
  }
  return out;
}

const KIND_LABEL: Record<ChangeKind, string> = { trigger: 'Auslöser', added: 'Neu', removed: 'Entfernt', changed: 'Geändert', moved: 'Verschoben', other: 'Weiteres' };

/** Liste der Änderungen; ohne Änderungen ein kurzer Satz. */
export function ChangesList({ changes, label = 'Änderungen' }: { changes: DefinitionChange[]; label?: string }) {
  if (!changes.length) return <p className="wf-muted">Keine Änderungen gegenüber der aktiven Version.</p>;
  return (
    <ul className="wf-changes" aria-label={label}>
      {changes.map((c, i) => <li key={i} className={`wf-change ${c.kind}`}><span className="wf-change-kind">{KIND_LABEL[c.kind]}</span> {c.text}</li>)}
    </ul>
  );
}
