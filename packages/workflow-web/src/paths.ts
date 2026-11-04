/**
 * Pfade, Nummern und Bezeichnungen von Schritten (rein, ohne React): gemeinsam für Ablauf, Formulare, Daten und Protokoll.
 *
 * Pfade sind JSON Pointer in die Definition: `/steps/1/then/0`, `/steps/2/steps/0` (Für jedes), `/steps/3/onError/steps/0`
 * und – Fassung 2 – Wege nach Ergebnis `/steps/1/branches/Nachbessern/0`.
 *
 * Nummern wie im Ablauf: «2.1» für «Dann», «2.s1» für «Sonst», im ersten Weg einer Aufgabe «2.1», in weiteren «2.b1»,
 * «2.c1». Ohne Definition (z. B. im Protokoll) zählt «rejected» als zweiter Weg, jedes andere Ergebnis als erster.
 */
import type { Step, WorkflowMetaJson } from './types.ts';

export const STEP_KIND_LABEL: Record<string, string> = {
  action: 'Aktion', if: 'Wenn / Sonst', foreach: 'Für jedes', wait: 'Warten', set: 'Werte setzen', end: 'Beenden',
  task: 'Aufgabe', approval: 'Genehmigung', subflow: 'Unterablauf',
};

export const kindOf = (s: Step): string => (['action', 'if', 'foreach', 'wait', 'set', 'end', 'task', 'approval', 'subflow'] as const).find(k => k in s) ?? 'unbekannt';

/** Text mit Daten ohne Pfade: `Prüfen {{subject.title}}` → «Prüfen …» (Bezeichnungen setzt `describeTemplate` ein). */
export const withoutData = (text: string) => text.replace(/\{\{[^{}]*\}\}/g, '…');

/** Art und Titel eines Schritts, z. B. «Aufgabe «Gerät prüfen»»; ohne Titel nur die Art. Daten im Titel als «…». */
export function stepTitle(s: Step, meta: WorkflowMetaJson | undefined): string {
  const kind = STEP_KIND_LABEL[kindOf(s)] ?? 'Schritt';
  const title = withoutData(s.label || ('task' in s ? s.task.title : 'approval' in s ? s.approval.title : 'action' in s ? meta?.actions.find(a => a.key === s.action)?.label : '') || '');
  return title && title !== kind ? `${kind} «${title}»` : kind;
}

/** Ergebnisse einer Aufgabe bzw. Genehmigung (ohne Angabe: «done»); andere Schritte haben keine. */
export function outcomesOfStep(s: Step | undefined): string[] {
  if (!s) return [];
  if ('approval' in s) return ['approved', 'rejected'];
  if ('task' in s) return s.task.outcomes?.length ? s.task.outcomes : ['done'];
  return [];
}

/** Wege eines Schritts (leer, wenn er keine hat). */
export const branchesOf = (s: Step | undefined): Record<string, Step[] | undefined> =>
  (s && ('task' in s || 'approval' in s) ? s.branches ?? {} : {}) as Record<string, Step[] | undefined>;

/** Hat der Schritt Wege nach Ergebnis (zwei oder mehr Ergebnisse, oder schon Schritte in einem Weg)? */
export function hasWays(s: Step): boolean {
  if (!('task' in s) && !('approval' in s)) return false;
  return outcomesOfStep(s).length > 1 || Object.values(branchesOf(s)).some(l => l?.length);
}

/** Buchstabe des Wegs in der Nummer: erstes Ergebnis keiner, dann «b», «c» … */
export const wayLetter = (k: number) => (k > 0 ? String.fromCharCode(97 + k) : '');

export interface PathHop { index: number; list?: string; outcome?: string }

/**
 * Pfad in Ebenen zerlegen: `/steps/1/branches/ok/0` → [{ index: 1, list: 'branches', outcome: 'ok' }, { index: 0 }]: je
 * Ebene der Index und – ausser beim letzten Schritt – die Liste darin (`then`, `else`, `steps`, `onError/steps`, `branches`).
 */
export function pathHops(path: string): PathHop[] {
  const s = path.split('/').filter(Boolean);
  if (s[0] !== 'steps') return [];
  s.shift();
  const out: PathHop[] = [];
  for (let i = 0; i < s.length;) {
    if (!/^\d+$/.test(s[i]!)) break;
    const hop: PathHop = { index: Number(s[i]) };
    const key = s[i + 1];
    if (key === 'branches' && s[i + 2] !== undefined) { hop.list = 'branches'; hop.outcome = s[i + 2]!; i += 3; }
    else if (key === 'onError' && s[i + 2] === 'steps') { hop.list = 'onError/steps'; i += 3; }
    else if (key !== undefined) { hop.list = key; i += 2; }
    else i += 1;
    out.push(hop);
  }
  return out;
}

/** Liste in einem Schritt (`then`, `else`, `steps`, `onError/steps`, `branches` mit Ergebnis). */
export function innerList(st: Step | undefined, hop: PathHop): Step[] | undefined {
  if (!st || !hop.list) return undefined;
  if (hop.list === 'branches') return branchesOf(st)[hop.outcome!];
  if (hop.list === 'onError/steps') return st.onError?.steps;
  return (st as unknown as Record<string, Step[] | undefined>)[hop.list];
}

/** Nummer eines Schritts aus seinem Pfad, wie der Ablauf sie zeigt («2.1», «2.s1», «2.b1»). */
export function stepNumberOfPath(path: string, steps?: Step[]): string | null {
  let n = '';
  let list: Step[] | undefined = steps;
  let prefix = '';
  for (const hop of pathHops(path)) {
    n = n ? `${n}.${prefix}${hop.index + 1}` : String(hop.index + 1);
    if (!hop.list) break;
    const st: Step | undefined = list?.[hop.index];
    if (hop.list === 'branches') {
      const k = st ? outcomesOfStep(st).indexOf(hop.outcome!) : hop.outcome === 'rejected' ? 1 : 0;
      prefix = wayLetter(Math.max(0, k));
    } else prefix = hop.list === 'else' ? 's' : '';
    list = innerList(st, hop);
  }
  return n || null;
}

/** Pfad eines ausgeführten Schritts → Pfad in der Definition: Einträge einer Schleife fallen weg (`/steps/2/items/0/steps/1` → `/steps/2/steps/1`). */
export const definitionPathOf = (path: string) => path.replace(/(?<=\/\d+)\/items\/\d+(?=\/steps(?:\/|$))/g, '');

/** Wo eine Meldung der Prüfung hingehört, in Worten («Auslöser», «Schritt 2.1»). */
export function placeOfPath(path: string, steps?: Step[]): string {
  if (path.startsWith('/trigger')) return 'Auslöser';
  const n = stepNumberOfPath(path, steps);
  return n ? `Schritt ${n}` : 'Workflow';
}

/** Alle Schritte mit Pfad (Wenn/Sonst, Für jedes, Wege, Fehlerpfad). */
export function* walkPaths(list: Step[] | undefined, base = '/steps'): Generator<[Step, string]> {
  for (const [i, s] of (list ?? []).entries()) {
    const path = `${base}/${i}`;
    yield [s, path];
    if ('if' in s) { yield* walkPaths(s.then, `${path}/then`); yield* walkPaths(s.else, `${path}/else`); }
    if ('foreach' in s) yield* walkPaths(s.steps, `${path}/steps`);
    for (const [k, l] of Object.entries(branchesOf(s))) yield* walkPaths(l, `${path}/branches/${k}`);
    yield* walkPaths(s.onError?.steps, `${path}/onError/steps`);
  }
}

/** Alle Schritte (verschachtelt). */
export function* walk(list: Step[] | undefined): Generator<Step> {
  for (const [s] of walkPaths(list)) yield s;
}

/**
 * Steht die Ausgabe des Schritts `a` an der Stelle `at` (Pfad eines Schritts) sicher fest? Ja für umgebende Schritte und
 * für Schritte davor im selben Weg oder in einem umgebenden – aber nicht, wenn `a` selbst in einem Weg, einer Schleife oder
 * einem Fehlerpfad liegt, der nicht sicher durchlaufen wurde.
 */
export function isBefore(a: string, at: string): boolean {
  if (a === at) return false;
  if (at.startsWith(`${a}/`)) return true;
  const sa = a.split('/'), sb = at.split('/');
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  if (i >= sa.length || i >= sb.length) return false;
  if (!/^\d+$/.test(sa[i]!) || !/^\d+$/.test(sb[i]!) || Number(sa[i]) >= Number(sb[i])) return false;
  return !sa.slice(i + 1).some(seg => ['then', 'else', 'branches', 'steps', 'onError'].includes(seg));
}
