/**
 * Werte aus dem Kontext eines Laufs mit Bezeichnung (Konzept 4.3): welche Pfade Bedingungen und Platzhalter
 * `{{pfad}}` an einer Stelle der Definition nutzen können – Auslöser, Bezug, Eingabe, vorherige Schritte, Variablen,
 * Akteur, Zeit. Dazu die Auswahl, die einen Platzhalter an der Schreibmarke einfügt, und ein Textfeld mit dieser
 * Auswahl.
 *
 * Regeln: Bezeichnungen kommen aus `/workflows/meta` (Ereignisse, Felder der Bezugstypen, Ausgabe-Schema der Aktionen)
 * und der Definition selbst; die Oberfläche zeigt Bezeichnungen, nicht nur Pfade. Pfade folgen dem Kontext der Engine
 * (`event`, `trigger`, `subject`, `steps`, `vars`, `input`, `actor`, `run`, `now`); der Filter eines Ereignis-Auslösers
 * kennt nur `event`.
 */
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useWorkflow } from './provider.tsx';
import type { AutomationDefinition, FieldDefJson, JsonSchema, Step, WorkflowMetaJson } from './types.ts';

/** Ein Wert im Kontext mit Bezeichnung und Gruppe (für Auswahl und Bedingungen). */
export interface ContextField { path: string; label: string; group: string; field?: FieldDefJson }

const props = (s: JsonSchema | null | undefined): [string, JsonSchema][] =>
  s && typeof s.properties === 'object' && s.properties ? Object.entries(s.properties as Record<string, JsonSchema>) : [];

/** Alle Schritte mit Verschachtelung (Wenn/Sonst, Für jedes, Fehlerpfad). */
export function* walk(list: Step[] | undefined): Generator<Step> {
  for (const s of list ?? []) {
    yield s;
    if ('if' in s) { yield* walk(s.then); yield* walk(s.else); }
    if ('foreach' in s) yield* walk(s.steps);
    yield* walk(s.onError?.steps);
  }
}

/** Felder, nach denen der Filter eines Ereignis-Auslösers prüfen kann (nur `event.*`). */
export function eventFilterFields(meta: WorkflowMetaJson | undefined, eventType: string): ContextField[] {
  const ev = meta?.events.find(e => e.type === eventType);
  const out: ContextField[] = (ev?.filterFields ?? []).map(f => ({ path: `event.data.${f.key}`, label: f.label, group: 'Ereignis', field: f }));
  out.push({ path: 'event.subject.id', label: 'ID des Bezugs', group: 'Ereignis' });
  out.push({ path: 'event.actor.kind', label: 'Ausgelöst von (Person oder Maschinen-Client)', group: 'Ereignis', field: { key: 'kind', label: 'Art', type: 'choice', options: [{ value: 'person', label: 'Person' }, { value: 'client', label: 'Maschinen-Client' }] } });
  return out;
}

/** Werte, die Schritte der Definition nutzen können. */
export function contextFields(def: AutomationDefinition, meta: WorkflowMetaJson | undefined, subjectLabel: (type: string) => string): ContextField[] {
  const out: ContextField[] = [];
  const t = def.trigger;
  let subjectTypes: string[] = [];
  if ('event' in t) {
    const ev = meta?.events.find(e => e.type === t.event);
    for (const f of ev?.filterFields ?? []) out.push({ path: `event.data.${f.key}`, label: f.label, group: 'Ereignis', field: f });
    out.push({ path: 'event.type', label: 'Art des Ereignisses', group: 'Ereignis' });
    subjectTypes = ev?.subjectType ? [ev.subjectType] : (meta?.subjectTypes.map(s => s.type) ?? []);
  } else if ('manual' in t) {
    for (const f of t.manual.form ?? []) out.push({ path: `input.${f.key}`, label: f.label, group: 'Eingabe beim Start', field: f });
    out.push({ path: 'trigger.manual.by.id', label: 'Gestartet von', group: 'Auslöser' });
    subjectTypes = meta?.subjectTypes.map(s => s.type) ?? [];
  } else if ('schedule' in t) {
    out.push({ path: 'trigger.schedule.at', label: 'Geplanter Zeitpunkt', group: 'Auslöser', field: { key: 'at', label: 'Zeitpunkt', type: 'date' } });
  }
  for (const type of subjectTypes) {
    const st = meta?.subjectTypes.find(s => s.type === type);
    const g = `Bezug: ${subjectLabel(type)}`;
    out.push({ path: 'subject.title', label: 'Bezeichnung', group: g }, { path: 'subject.id', label: 'ID', group: g });
    for (const f of st?.fields ?? []) out.push({ path: `subject.values.${f.key}`, label: f.label, group: g, field: f });
  }
  for (const s of walk(def.steps)) {
    const name = s.label || s.id;
    if ('action' in s) {
      const a = meta?.actions.find(x => x.key === s.action);
      const outProps = props(a?.output);
      if (outProps.length) for (const [k, p] of outProps) out.push({ path: `steps.${s.id}.${k}`, label: String(p.title ?? k), group: `Schritt «${name}»` });
      else out.push({ path: `steps.${s.id}`, label: 'Ergebnis', group: `Schritt «${name}»` });
    }
    if ('if' in s) out.push({ path: `steps.${s.id}.result`, label: 'Bedingung erfüllt (ja/nein)', group: `Schritt «${name}»` });
    if ('foreach' in s) {
      out.push({ path: `vars.${s.foreach.as}`, label: `Aktueller Eintrag (${s.foreach.as})`, group: 'Variablen' });
      out.push({ path: `steps.${s.id}.count`, label: 'Anzahl Einträge', group: `Schritt «${name}»` });
    }
    if ('set' in s) for (const k of Object.keys(s.set)) out.push({ path: `vars.${k}`, label: k, group: 'Variablen' });
  }
  for (const k of Object.keys(def.variables ?? {})) out.push({ path: `vars.${k}`, label: k, group: 'Variablen' });
  out.push(
    { path: 'now', label: 'Jetzt (Datum und Zeit)', group: 'Allgemein', field: { key: 'now', label: 'Jetzt', type: 'date' } },
    { path: 'actor.id', label: 'Akteur des Workflows', group: 'Allgemein' },
    { path: 'run.id', label: 'ID des Laufs', group: 'Allgemein' },
  );
  const seen = new Set<string>();
  return out.filter(f => (seen.has(f.path) ? false : (seen.add(f.path), true)));
}

/** Bezeichnung zu einem Pfad, sonst der Pfad selbst. */
export const labelOf = (fields: ContextField[], path: string) => {
  const f = fields.find(x => x.path === path);
  return f ? `${f.group}: ${f.label}` : path;
};

/** Auswahl eines Platzhalters: Knopf öffnet eine Liste mit Suche; Esc schliesst, Fokus zurück an den Knopf. */
export function PlaceholderPicker({ fields, onPick, target }: { fields: ContextField[]; onPick: (path: string) => void; target: string }) {
  const { ui } = useWorkflow();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => { setOpen(false); setQ(''); btn.current?.focus(); };
  const shown = fields.filter(f => !q || `${f.group} ${f.label} ${f.path}`.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(shown.map(f => f.group))];
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  return (
    <span className="wf-ph">
      <ui.Button ref={btn} size="sm" variant="ghost" aria-label={`Platzhalter einfügen in «${target}»`} aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}>{'{{…}}'}</ui.Button>
      {open ? (
        <div id={id} className="wf-ph-pop" role="dialog" aria-label="Platzhalter wählen" onKeyDown={onKey}>
          <ui.Input autoFocus aria-label="Platzhalter suchen" placeholder="Suchen …" value={q} onChange={e => setQ(e.target.value)} />
          <div className="wf-ph-list">
            {groups.length ? groups.map(g => (
              <div key={g} role="group" aria-label={g}>
                <div className="wf-ph-group">{g}</div>
                {shown.filter(f => f.group === g).map(f => (
                  <button key={f.path} type="button" className="wf-ph-item" onClick={() => { onPick(f.path); close(); }}>
                    <span>{f.label}</span><code>{f.path}</code>
                  </button>
                ))}
              </div>
            )) : <p className="wf-muted wf-small">Keine Treffer.</p>}
          </div>
        </div>
      ) : null}
    </span>
  );
}

/** Text mit Platzhaltern: fügt `{{pfad}}` an der Schreibmarke ein. */
export function TemplateInput({ label, value, onChange, fields, multiline, required, hint, disabled, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; fields: ContextField[]; multiline?: boolean; required?: boolean; hint?: string;
  disabled?: boolean; placeholder?: string;
}) {
  const { ui } = useWorkflow();
  const id = useId();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (path: string) => {
    const el = ref.current;
    const token = `{{${path}}}`;
    const start = el?.selectionStart ?? value.length, end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
  };
  const common = { id, value, disabled, placeholder, required, 'aria-describedby': hint ? `${id}-hint` : undefined };
  return (
    <div className="wf-field">
      <label htmlFor={id}>{label}{required ? <span className="wf-req" aria-hidden="true"> *</span> : null}</label>
      <div className="wf-row">
        {multiline
          ? <ui.Textarea ref={ref} rows={3} {...common} onChange={e => onChange(e.target.value)} />
          : <ui.Input ref={ref} {...common} onChange={e => onChange(e.target.value)} />}
        {!disabled ? <PlaceholderPicker fields={fields} onPick={insert} target={label} /> : null}
      </div>
      {hint ? <div id={`${id}-hint`} className="wf-hint">{hint}</div> : null}
    </div>
  );
}
