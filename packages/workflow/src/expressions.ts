/**
 * Ausdrücke ohne Skripte (W5): strukturierte Bedingungen und Platzhalter `{{pfad | formatierer:arg}}`.
 *
 * Regeln:
 * - Kein `eval`, kein `Function`, keine regulären Ausdrücke aus Definitionen: Pfade werden Segment für Segment über
 *   eigene Eigenschaften aufgelöst; `__proto__`, `prototype` und `constructor` sind gesperrt.
 * - Platzhalter liefern Bezeichnungen statt IDs: Ein Wert mit `label`, `title` oder `name` wird als dieser Text
 *   ausgegeben.
 * - Feste Formatierer: `date` (`date`, `datetime`, `time`, `iso`), `number` (Nachkommastellen), `list` (Trenner),
 *   `default` (Ersatztext für leere Werte). Unbekannte Formatierer sind ein Fehler (`ExpressionError`).
 * - Fehlermeldungen auf Deutsch; `templateProblems` meldet sie ohne zu werfen (für die Prüfung beim Speichern).
 */

export const CONDITION_OPS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'contains', 'notContains', 'startsWith', 'endsWith', 'isSet', 'isNotSet',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
/** Vergleiche ohne Wert. */
export const UNARY_OPS: readonly ConditionOp[] = ['isSet', 'isNotSet'];

export interface FieldCondition { field: string; op: ConditionOp; value?: unknown }
/** Bedingung: Vergleich eines Felds oder Verknüpfung mit `all` (und), `any` (oder), `not` (nicht). */
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | FieldCondition;

export const FORMATTERS = ['date', 'number', 'list', 'default'] as const;
export type FormatterName = (typeof FORMATTERS)[number];

/** Kontext für Bedingungen und Platzhalter, z. B. `{ trigger, subject, steps, vars, actor, now }`. */
export type ExpressionContext = Record<string, unknown>;

export interface RenderOptions {
  /** Standard `de-CH`. */
  locale?: string;
  /** Standard `Europe/Zurich`. */
  timeZone?: string;
}

export class ExpressionError extends Error {
  override name = 'ExpressionError';
}

const MAX_DEPTH = 32;
const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);
const PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

/** Prüft die Schreibweise eines Pfads (`subject.values.owner`, `steps.s2.outcome`, `vars.items.0`). */
export function isValidPath(path: string): boolean {
  return PATH.test(path) && !path.split('.').some(s => BLOCKED.has(s));
}

/** Wert unter einem Pfad; `undefined`, wenn es ihn nicht gibt. Nur eigene Eigenschaften. */
export function resolvePath(ctx: unknown, path: string): unknown {
  if (!isValidPath(path)) throw new ExpressionError(`Ungültiger Pfad «${path}»`);
  let cur: unknown = ctx;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (typeof cur === 'object') {
      if (!Object.hasOwn(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function order(a: unknown, b: unknown): number | null {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/** Wertet eine Bedingung aus. Werte, die Text mit Platzhaltern sind, werden vorher eingesetzt. */
export function evaluateCondition(cond: Condition, ctx: ExpressionContext, depth = 0): boolean {
  if (depth > MAX_DEPTH) throw new ExpressionError(`Bedingung zu tief verschachtelt (höchstens ${MAX_DEPTH} Ebenen)`);
  if (cond === null || typeof cond !== 'object') throw new ExpressionError('Bedingung muss aus Angaben in {…} bestehen');
  if ('all' in cond) return cond.all.every(c => evaluateCondition(c, ctx, depth + 1));
  if ('any' in cond) return cond.any.some(c => evaluateCondition(c, ctx, depth + 1));
  if ('not' in cond) return !evaluateCondition(cond.not, ctx, depth + 1);
  const left = resolvePath(ctx, cond.field);
  const right = typeof cond.value === 'string' ? resolveValue(cond.value, ctx) : cond.value;
  switch (cond.op) {
    case 'isSet': return !isEmpty(left);
    case 'isNotSet': return isEmpty(left);
    case 'eq': return same(left, right);
    case 'ne': return !same(left, right);
    case 'gt': { const o = order(left, right); return o !== null && o > 0; }
    case 'gte': { const o = order(left, right); return o !== null && o >= 0; }
    case 'lt': { const o = order(left, right); return o !== null && o < 0; }
    case 'lte': { const o = order(left, right); return o !== null && o <= 0; }
    case 'in': return Array.isArray(right) && right.some(r => same(left, r));
    case 'notIn': return Array.isArray(right) && !right.some(r => same(left, r));
    case 'contains':
    case 'notContains': {
      const hit = Array.isArray(left) ? left.some(l => same(l, right))
        : typeof left === 'string' && right !== null && right !== undefined && left.includes(String(right));
      return cond.op === 'contains' ? hit : !hit;
    }
    case 'startsWith': return typeof left === 'string' && typeof right === 'string' && left.startsWith(right);
    case 'endsWith': return typeof left === 'string' && typeof right === 'string' && left.endsWith(right);
    default: throw new ExpressionError(`Unbekannter Vergleich «${String((cond as { op: unknown }).op)}»`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Platzhalter

export interface FormatterCall { name: FormatterName; arg: string | null }
export interface Placeholder { path: string; formatters: FormatterCall[] }
export type TemplatePart = string | Placeholder;

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0]) return t.slice(1, -1);
  return t;
}

/** Teilt an `|`, ausser in Anführungszeichen. */
function splitPipes(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '|') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (quote) throw new ExpressionError('Anführungszeichen im Platzhalter nicht geschlossen');
  out.push(cur);
  return out;
}

function parsePlaceholder(inner: string): Placeholder {
  const [head, ...rest] = splitPipes(inner);
  const path = (head ?? '').trim();
  if (!path) throw new ExpressionError('Leerer Platzhalter «{{}}»');
  if (!isValidPath(path)) throw new ExpressionError(`Ungültiger Pfad «${path}» im Platzhalter`);
  const formatters = rest.map(f => {
    const i = f.indexOf(':');
    const name = (i < 0 ? f : f.slice(0, i)).trim();
    if (!(FORMATTERS as readonly string[]).includes(name)) {
      throw new ExpressionError(`Unbekannter Formatierer «${name}» (erlaubt: ${FORMATTERS.join(', ')})`);
    }
    return { name: name as FormatterName, arg: i < 0 ? null : unquote(f.slice(i + 1)) };
  });
  return { path, formatters };
}

/** Zerlegt Text in feste Teile und Platzhalter; wirft `ExpressionError` bei falscher Schreibweise. */
export function parseTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{{', i);
    if (start < 0) { parts.push(text.slice(i)); break; }
    if (start > i) parts.push(text.slice(i, start));
    const end = text.indexOf('}}', start + 2);
    if (end < 0) throw new ExpressionError('Platzhalter nicht geschlossen («}}» fehlt)');
    parts.push(parsePlaceholder(text.slice(start + 2, end)));
    i = end + 2;
  }
  return parts;
}

/** Fehler in den Platzhaltern eines Texts (leer: in Ordnung). */
export function templateProblems(text: string): string[] {
  try { parseTemplate(text); return []; } catch (e) { return [e instanceof Error ? e.message : String(e)]; }
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
  return null;
}

function applyFormatter(value: unknown, f: FormatterCall, o: Required<RenderOptions>): unknown {
  switch (f.name) {
    case 'default': return isEmpty(value) ? (f.arg ?? '') : value;
    case 'list': {
      const items = Array.isArray(value) ? value : isEmpty(value) ? [] : [value];
      return items.map(x => text(x, o)).join(f.arg ?? ', ');
    }
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isFinite(n)) return value;
      const digits = f.arg === null ? null : Number(f.arg);
      if (digits !== null && !(Number.isInteger(digits) && digits >= 0 && digits <= 10)) {
        throw new ExpressionError(`Formatierer «number»: Nachkommastellen 0–10 erwartet, nicht «${f.arg}»`);
      }
      return new Intl.NumberFormat(o.locale, digits === null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
    }
    case 'date': {
      const d = toDate(value);
      if (!d) return value;
      const style = f.arg ?? 'date';
      if (style === 'iso') return d.toISOString();
      const opts: Record<string, Intl.DateTimeFormatOptions> = {
        date: { dateStyle: 'medium' }, datetime: { dateStyle: 'medium', timeStyle: 'short' }, time: { timeStyle: 'short' },
      };
      const opt = opts[style];
      if (!opt) throw new ExpressionError(`Formatierer «date»: «date», «datetime», «time» oder «iso» erwartet, nicht «${style}»`);
      return new Intl.DateTimeFormat(o.locale, { ...opt, timeZone: o.timeZone }).format(d);
    }
  }
}

/** Text eines Werts: Bezeichnung statt ID, Listen mit Komma, Datum lesbar. */
function text(v: unknown, o: Required<RenderOptions>): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return String(applyFormatter(v, { name: 'date', arg: 'datetime' }, o));
  if (Array.isArray(v)) return v.map(x => text(x, o)).join(', ');
  if (typeof v === 'object') {
    for (const k of ['label', 'title', 'name']) {
      if (Object.hasOwn(v, k) && typeof (v as Record<string, unknown>)[k] === 'string') return (v as Record<string, string>)[k]!;
    }
    return JSON.stringify(v);
  }
  return '';
}

const defaults = (o: RenderOptions = {}): Required<RenderOptions> => ({ locale: o.locale ?? 'de-CH', timeZone: o.timeZone ?? 'Europe/Zurich' });

function evaluatePlaceholder(p: Placeholder, ctx: ExpressionContext, o: Required<RenderOptions>): unknown {
  return p.formatters.reduce<unknown>((v, f) => applyFormatter(v, f, o), resolvePath(ctx, p.path));
}

/** Setzt alle Platzhalter eines Texts ein; das Ergebnis ist immer Text. */
export function renderTemplate(template: string, ctx: ExpressionContext, options?: RenderOptions): string {
  const o = defaults(options);
  return parseTemplate(template).map(p => (typeof p === 'string' ? p : text(evaluatePlaceholder(p, ctx, o), o))).join('');
}

/**
 * Setzt Platzhalter in einem Wert ein (rekursiv in Listen und Strukturen). Ein Text, der nur aus einem Platzhalter
 * ohne Formatierer besteht, liefert den Wert selbst (z. B. eine Liste oder Zahl), sonst entsteht Text.
 */
export function resolveValue(value: unknown, ctx: ExpressionContext, options?: RenderOptions, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new ExpressionError(`Wert zu tief verschachtelt (höchstens ${MAX_DEPTH} Ebenen)`);
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value;
    const parts = parseTemplate(value);
    const only = parts.length === 1 ? parts[0] : undefined;
    if (only !== undefined && typeof only !== 'string' && !only.formatters.length) return resolvePath(ctx, only.path);
    return renderTemplate(value, ctx, options);
  }
  if (Array.isArray(value)) return value.map(v => resolveValue(v, ctx, options, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!BLOCKED.has(k)) out[k] = resolveValue(v, ctx, options, depth + 1);
    return out;
  }
  return value;
}
