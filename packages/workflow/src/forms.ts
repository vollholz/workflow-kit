/**
 * Formulare von Aufgaben (W11): Werte serverseitig gegen die Felder prüfen – Feldarten des Pakets (Text, Zahl, Datum,
 * Auswahl, Akteur, Ja/Nein, Datei) und die der App (`FieldKind.valueSchema`, geprüft mit ajv).
 *
 * Regeln: Unbekannte Felder sind ein Fehler, leere Werte (`undefined`, `null`, `''`, `[]`) gelten als nicht ausgefüllt
 * und fallen weg. Ein Akteur als Text wird zu `{ id, kind: 'person' }`. Meldungen deutsch mit Bezeichnung des Felds.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import type { FieldDef, FieldKind } from './ports.ts';

export interface FormError { key: string; message: string }
export type FormResult = { ok: true; values: Record<string, unknown> } | { ok: false; errors: FormError[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/;
const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Prüft Formularwerte; die Feldarten der App werden einmal übersetzt. */
export class FormChecker {
  private readonly kinds = new Map<string, ValidateFunction>();

  constructor(kinds: FieldKind[]) {
    const ajv = new Ajv({ allErrors: false, strict: false, logger: false });
    for (const k of kinds) {
      try { this.kinds.set(k.key, ajv.compile(k.valueSchema)); }
      catch (e) { throw new Error(`workflow: Feldart «${k.key}» hat kein gültiges Schema (${e instanceof Error ? e.message : String(e)})`); }
    }
  }

  /** Ein Wert einer Feldart; liefert den bereinigten Wert oder eine Meldung. */
  private one(f: FieldDef, v: unknown): { value: unknown } | { message: string } {
    switch (f.type) {
      case 'text':
        return typeof v === 'string' && v.length <= 10_000 ? { value: v } : { message: 'Erwartet: Text (höchstens 10 000 Zeichen)' };
      case 'number':
        return typeof v === 'number' && Number.isFinite(v) ? { value: v } : { message: 'Erwartet: Zahl' };
      case 'date':
        return typeof v === 'string' && (DATE.test(v) || DATE_TIME.test(v)) && !Number.isNaN(new Date(v).getTime()) ? { value: v } : { message: 'Erwartet: Datum (JJJJ-MM-TT)' };
      case 'choice': {
        const allowed = (f.options ?? []).map(o => o.value);
        return typeof v === 'string' && allowed.includes(v) ? { value: v } : { message: `Erlaubt: ${allowed.map(a => `«${a}»`).join(', ')}` };
      }
      case 'boolean':
        return typeof v === 'boolean' ? { value: v } : { message: 'Erwartet: Ja/Nein' };
      case 'actor':
        if (typeof v === 'string' && v) return { value: { id: v, kind: 'person' } };
        if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && ['person', 'client'].includes(String((v as { kind?: unknown }).kind))) {
          return { value: { id: (v as { id: string }).id, kind: (v as { kind: string }).kind } };
        }
        return { message: 'Erwartet: Person oder Maschinen-Client' };
      case 'file':
        if (typeof v === 'string' && v) return { value: v };
        if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return { value: v };
        return { message: 'Erwartet: Datei' };
      default: {
        const check = this.kinds.get(f.type);
        if (!check) return { message: `Unbekannte Feldart «${f.type}»` };
        return check(v) ? { value: v } : { message: `Ungültiger Wert (${check.errors?.[0]?.message ?? 'Schema'})` };
      }
    }
  }

  check(fields: FieldDef[], input: unknown): FormResult {
    if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) return { ok: false, errors: [{ key: '', message: 'Formularwerte als Angaben in {…}' }] };
    const values = (input ?? {}) as Record<string, unknown>;
    const errors: FormError[] = [];
    const out: Record<string, unknown> = {};
    const known = new Set(fields.map(f => f.key));
    for (const k of Object.keys(values)) if (!known.has(k)) errors.push({ key: k, message: `Unbekanntes Feld «${k}»` });
    for (const f of fields) {
      const v = values[f.key];
      if (empty(v)) {
        if (f.required) errors.push({ key: f.key, message: `«${f.label}» ist Pflicht` });
        continue;
      }
      if (f.multiple) {
        if (!Array.isArray(v)) { errors.push({ key: f.key, message: `«${f.label}»: Erwartet: Liste` }); continue; }
        const list: unknown[] = [];
        for (const x of v) {
          const r = this.one(f, x);
          if ('message' in r) { errors.push({ key: f.key, message: `«${f.label}»: ${r.message}` }); break; }
          list.push(r.value);
        }
        out[f.key] = list;
        continue;
      }
      const r = this.one(f, v);
      if ('message' in r) errors.push({ key: f.key, message: `«${f.label}»: ${r.message}` });
      else out[f.key] = r.value;
    }
    return errors.length ? { ok: false, errors } : { ok: true, values: out };
  }
}
