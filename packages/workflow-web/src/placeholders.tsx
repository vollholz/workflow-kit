/**
 * Daten im Ablauf (Konzept 4.3; UX-Neukonzept Etappe 3 «Daten als Chips»): welche Werte an einer Stelle der Definition
 * feststehen – Auslöser, Bezug, Eingabe, frühere Schritte, Variablen, Allgemeines – mit Bezeichnung. Dazu das Textfeld,
 * das Daten als Chips mit Bezeichnung zeigt («Schritt 2 · Begründung») statt als `{{pfad}}`.
 *
 * Regeln:
 * - Bezeichnungen kommen aus `/workflows/meta` (Ereignisse, Felder der Bezugstypen, Ausgabe-Schema der Aktionen) und der
 *   Definition; Schritte heissen nach Nummer und Titel, nie nach ihrer ID. Pfade folgen dem Kontext der Engine (`event`,
 *   `trigger`, `subject`, `steps`, `vars`, `input`, `actor`, `run`, `now`); der Filter eines Ereignis-Auslösers kennt nur
 *   `event`.
 * - An einer Stelle stehen nur Daten fest, die vorher sicher entstehen (`isBefore`): Schritte davor, umgebende Schritte
 *   (Wenn, Für jedes, Aufgabe mit Weg); der Eintrag einer Schleife nur in ihr.
 * - Gespeichert wird Text mit `{{pfad}}`; das Textfeld zeigt Chips. `{` oder «Daten» öffnet die Auswahl (Suche, ↓/↑,
 *   Enter, Esc); ein Chip lässt sich wie ein Zeichen löschen. Eingefügt wird nur Text ohne Formatierung.
 * - Daten, die an dieser Stelle nicht bekannt sind, erscheinen als markierter Chip mit dem Pfad.
 */
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { isBefore, stepNumberOfPath, stepTitle, walk, walkPaths } from './paths.ts';
import { useWorkflow } from './provider.tsx';
import type { AutomationDefinition, FieldDefJson, JsonSchema, WorkflowMetaJson } from './types.ts';

export { walk };

/** Ein Wert im Kontext mit Bezeichnung, Gruppe und Text des Chips (für Auswahl, Chips und Bedingungen). */
export interface ContextField { path: string; label: string; group: string; chip?: string; field?: FieldDefJson }

/** Alle Daten der Definition für die Bezeichnung von Chips (vom Editor gesetzt). */
export const DataLabels = createContext<ContextField[]>([]);

const props = (s: JsonSchema | null | undefined): [string, JsonSchema][] =>
  s && typeof s.properties === 'object' && s.properties ? Object.entries(s.properties as Record<string, JsonSchema>) : [];

/** Felder, nach denen der Filter eines Ereignis-Auslösers prüfen kann (nur `event.*`). */
export function eventFilterFields(meta: WorkflowMetaJson | undefined, eventType: string): ContextField[] {
  const ev = meta?.events.find(e => e.type === eventType);
  const out: ContextField[] = (ev?.filterFields ?? []).map(f => ({ path: `event.data.${f.key}`, label: f.label, group: 'Ereignis', field: f }));
  out.push({ path: 'event.subject.id', label: 'ID des Bezugs', group: 'Ereignis' });
  out.push({ path: 'event.actor.kind', label: 'Ausgelöst von (Person oder Maschinen-Client)', group: 'Ereignis', field: { key: 'kind', label: 'Art', type: 'choice', options: [{ value: 'person', label: 'Person' }, { value: 'client', label: 'Maschinen-Client' }] } });
  return out;
}

/**
 * Daten, die Schritte nutzen können; mit `at` (Pfad eines Schritts) nur die, die dort feststehen. Ohne `at` alle (für die
 * Bezeichnung von Chips).
 */
export function contextFields(def: AutomationDefinition, meta: WorkflowMetaJson | undefined, subjectLabel: (type: string) => string, at?: string): ContextField[] {
  const out: ContextField[] = [];
  const add = (f: ContextField) => out.push({ ...f, chip: f.chip ?? `${f.group} · ${f.label}` });
  const t = def.trigger;
  let subjectTypes: string[] = [];
  if ('event' in t) {
    const ev = meta?.events.find(e => e.type === t.event);
    for (const f of ev?.filterFields ?? []) add({ path: `event.data.${f.key}`, label: f.label, group: 'Ereignis', field: f });
    add({ path: 'event.type', label: 'Art des Ereignisses', group: 'Ereignis' });
    subjectTypes = ev?.subjectType ? [ev.subjectType] : (meta?.subjectTypes.map(s => s.type) ?? []);
  } else if ('manual' in t) {
    for (const f of t.manual.form ?? []) add({ path: `input.${f.key}`, label: f.label, group: 'Eingabe beim Start', chip: `Eingabe · ${f.label}`, field: f });
    add({ path: 'trigger.manual.by.id', label: 'Gestartet von', group: 'Auslöser', chip: 'Gestartet von' });
    subjectTypes = meta?.subjectTypes.map(s => s.type) ?? [];
  } else if ('schedule' in t) {
    add({ path: 'trigger.schedule.at', label: 'Geplanter Zeitpunkt', group: 'Auslöser', chip: 'Geplanter Zeitpunkt', field: { key: 'at', label: 'Zeitpunkt', type: 'date' } });
  }
  for (const type of subjectTypes) {
    const st = meta?.subjectTypes.find(s => s.type === type);
    const name = subjectLabel(type);
    const g = `Bezug: ${name}`;
    add({ path: 'subject.title', label: 'Bezeichnung', group: g, chip: `${name} · Bezeichnung` });
    add({ path: 'subject.id', label: 'ID', group: g, chip: `${name} · ID` });
    for (const f of st?.fields ?? []) add({ path: `subject.values.${f.key}`, label: f.label, group: g, chip: `${name} · ${f.label}`, field: f });
  }
  for (const [s, path] of walkPaths(def.steps)) {
    if (at !== undefined && !isBefore(path, at)) continue;
    const n = `Schritt ${stepNumberOfPath(path, def.steps) ?? '?'}`;
    const group = `${n} · ${stepTitle(s, meta)}`;
    const step = (key: string, label: string, field?: FieldDefJson) => add({ path: key ? `steps.${s.id}.${key}` : `steps.${s.id}`, label, group, chip: `${n} · ${label}`, ...(field ? { field } : {}) });
    if ('action' in s) {
      const a = meta?.actions.find(x => x.key === s.action);
      const outProps = props(a?.output);
      if (outProps.length) for (const [k, p] of outProps) step(k, String(p.title ?? k));
      else step('', 'Ergebnis');
    }
    if ('if' in s) step('result', 'Bedingung erfüllt (ja/nein)');
    if ('foreach' in s) {
      step('count', 'Anzahl Einträge');
      if (at === undefined || at.startsWith(`${path}/`)) add({ path: `vars.${s.foreach.as}`, label: 'Aktueller Eintrag', group: 'Schleife', chip: 'Aktueller Eintrag' });
    }
    if ('set' in s) for (const k of Object.keys(s.set)) add({ path: `vars.${k}`, label: k, group: 'Variablen', chip: `Variable · ${k}` });
    if ('task' in s) {
      step('outcome', 'Ergebnis', { key: 'outcome', label: 'Ergebnis', type: 'choice', options: (s.task.outcomes ?? ['done']).map(o => ({ value: o, label: o === 'done' ? 'Erledigt' : o })) });
      for (const f of s.task.form ?? []) step(`values.${f.key}`, f.label, f);
      step('completedBy.id', 'Erledigt von');
    }
    if ('approval' in s) {
      step('outcome', 'Entscheid', { key: 'outcome', label: 'Entscheid', type: 'choice', options: [{ value: 'approved', label: 'Genehmigt' }, { value: 'rejected', label: 'Abgelehnt' }] });
      step('reason', 'Begründung');
      step('completedBy.id', 'Entschieden von');
    }
  }
  for (const k of Object.keys(def.variables ?? {})) add({ path: `vars.${k}`, label: k, group: 'Variablen', chip: `Variable · ${k}` });
  add({ path: 'now', label: 'Jetzt (Datum und Zeit)', group: 'Allgemein', chip: 'Jetzt', field: { key: 'now', label: 'Jetzt', type: 'date' } });
  add({ path: 'actor.id', label: 'Handelt als', group: 'Allgemein', chip: 'Handelt als' });
  add({ path: 'run.id', label: 'ID des Runs', group: 'Allgemein', chip: 'ID des Runs' });
  const seen = new Set<string>();
  return out.filter(f => (seen.has(f.path) ? false : (seen.add(f.path), true)));
}

/** Bezeichnung zu einem Pfad, sonst der Pfad selbst. */
export const labelOf = (fields: ContextField[], path: string) => {
  const f = fields.find(x => x.path === path);
  return f ? (f.chip ?? `${f.group}: ${f.label}`) : path;
};

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Text mit `{{pfad}}` in Teile zerlegen (Text oder Pfad). */
export function templateParts(value: string): (string | { path: string })[] {
  const out: (string | { path: string })[] = [];
  let last = 0;
  for (const m of value.matchAll(TOKEN)) {
    if (m.index > last) out.push(value.slice(last, m.index));
    out.push({ path: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push(value.slice(last));
  return out;
}

/** Text mit Daten in Worten: `Gerät {{subject.title}}` → «Gerät «Gerät · Bezeichnung»». */
export function describeTemplate(value: string, fields: ContextField[]): string {
  return templateParts(value).map(p => (typeof p === 'string' ? p : `«${labelOf(fields, p.path)}»`)).join('');
}

// ---------------------------------------------------------------- Textfeld mit Chips

const ZW = '​';

function chipNode(path: string, known: ContextField[]): HTMLElement {
  const f = known.find(x => x.path === path);
  const tpl = document.createElement('template');
  tpl.innerHTML = '<span class="wf-chip" contenteditable="false"></span>';
  const el = tpl.content.firstElementChild as HTMLElement;
  if (!f) el.classList.add('unknown');
  el.dataset.path = path;
  el.textContent = f ? (f.chip ?? `${f.group} · ${f.label}`) : path;
  if (!f) el.title = 'Diese Daten stehen hier nicht fest';
  return el;
}

/** Inhalt des Textfelds → Text mit `{{pfad}}`. */
function serialize(root: Node): string {
  let out = '';
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType === 3) out += (n.textContent ?? '').replaceAll(ZW, '').replaceAll(' ', ' ');
    else if (n.nodeType === 1) {
      const el = n as HTMLElement;
      if (el.dataset.path) out += `{{${el.dataset.path}}}`;
      else if (el.tagName === 'BR') out += '\n';
      else { if ((el.tagName === 'DIV' || el.tagName === 'P') && out && !out.endsWith('\n')) out += '\n'; out += serialize(el); }
    }
  }
  return out;
}

function fill(root: HTMLElement, value: string, known: ContextField[]) {
  root.replaceChildren(...templateParts(value).map(p => (typeof p === 'string' ? document.createTextNode(p) : chipNode(p.path, known))));
}

/** Text mit Daten: zeigt Chips mit Bezeichnung, speichert `{{pfad}}`. `{` oder «Daten» fügt an der Schreibmarke ein. */
export function TemplateInput({ label, value, onChange, fields, multiline, required, hint, disabled, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; fields: ContextField[]; multiline?: boolean; required?: boolean; hint?: string;
  disabled?: boolean; placeholder?: string;
}) {
  const { ui } = useWorkflow();
  const labels = useContext(DataLabels);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const range = useRef<Range | null>(null);
  const [picker, setPicker] = useState(false);
  const known = [...fields, ...labels];
  const knownKey = known.map(f => `${f.path}\u0000${f.chip ?? ''}`).join('\u0001');
  const shownKey = useRef('');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Neu aufbauen nur bei einer Änderung von aussen oder neuen Bezeichnungen (nicht während der Eingabe).
    const relabel = shownKey.current !== knownKey && document.activeElement !== el;
    if (!relabel && (emitted.current === value || serialize(el) === value)) { emitted.current = value; return; }
    fill(el, value, known);
    emitted.current = value;
    shownKey.current = knownKey;
  });
  const emit = () => {
    const v = serialize(ref.current!);
    emitted.current = v;
    if (v !== value) onChange(v);
  };
  const saveRange = () => {
    const sel = window.getSelection();
    if (sel?.rangeCount && ref.current?.contains(sel.anchorNode)) range.current = sel.getRangeAt(0).cloneRange();
  };
  // «{» auch ohne Tastendruck (Bildschirmtastatur, Diktat, eingefügter Text): vor dem Einfügen abfangen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = (e: InputEvent) => {
      if (e.inputType !== 'insertText' || e.data !== '{') return;
      e.preventDefault();
      const sel = window.getSelection();
      if (sel?.rangeCount && el.contains(sel.anchorNode)) range.current = sel.getRangeAt(0).cloneRange();
      setPicker(true);
    };
    el.addEventListener('beforeinput', before);
    return () => el.removeEventListener('beforeinput', before);
  }, []);
  const insert = (nodes: Node[]) => {
    const el = ref.current!;
    let r = range.current;
    if (!r || !el.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(el); r.collapse(false); }
    r.deleteContents();
    for (const n of [...nodes].reverse()) r.insertNode(n);
    const lastNode = nodes[nodes.length - 1]!;
    r.setStartAfter(lastNode);
    r.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    range.current = r.cloneRange();
    emit();
  };
  const pick = (path: string) => {
    setPicker(false);
    ref.current?.focus();
    insert([chipNode(path, known), document.createTextNode(ZW)]);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === '{' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); saveRange(); setPicker(true); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (multiline) { saveRange(); insert([document.createTextNode('\n')]); }
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    saveRange();
    insert([document.createTextNode(multiline ? text : text.replace(/\s*\n\s*/g, ' '))]);
  };
  const describedBy = hint ? `${id}-hint` : undefined;
  return (
    <div className="wf-field wf-data">
      <span className="wf-label" id={`${id}-l`}>{label}{required ? <span className="wf-req" aria-hidden="true"> *</span> : null}</span>
      <div className="wf-row wf-data-row">
        <div ref={ref} id={id} className={`wf-input wf-data-text${multiline ? ' multi' : ''}`} role="textbox" aria-labelledby={`${id}-l`}
          aria-multiline={multiline || undefined} aria-required={required || undefined} aria-describedby={describedBy} aria-disabled={disabled || undefined}
          data-placeholder={placeholder} contentEditable={!disabled} suppressContentEditableWarning tabIndex={disabled ? -1 : 0}
          onInput={emit} onKeyDown={onKey} onPaste={onPaste} onKeyUp={saveRange} onMouseUp={saveRange} onBlur={saveRange} />
        {!disabled ? (
          <ui.Button size="sm" variant="ghost" aria-label={`Daten einfügen in «${label}»`} aria-haspopup="dialog" aria-expanded={picker}
            onMouseDown={saveRange} onClick={() => setPicker(o => !o)}>Daten</ui.Button>
        ) : null}
        {picker ? <DataPicker fields={fields} onPick={pick} onClose={() => { setPicker(false); ref.current?.focus(); }} /> : null}
      </div>
      {hint ? <div id={`${id}-hint`} className="wf-hint">{hint}</div> : null}
    </div>
  );
}

/** Auswahl der Daten: Suche, Gruppen; ↓/↑ wechseln, Enter wählt, Esc oder Klick daneben schliesst. */
export function DataPicker({ fields, onPick, onClose }: { fields: ContextField[]; onPick: (path: string) => void; onClose: () => void }) {
  const { ui } = useWorkflow();
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const shown = fields.filter(f => !needle || `${f.group} ${f.label} ${f.chip ?? ''}`.toLowerCase().includes(needle));
  const groups = [...new Set(shown.map(f => f.group))];
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [onClose]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>('.wf-ph-item') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) box.current?.querySelector<HTMLElement>('input')?.focus(); else items[i - 1]?.focus(); }
    else if (e.key === 'Enter' && i < 0 && shown[0]) { e.preventDefault(); onPick(shown[0].path); }
  };
  return (
    <div ref={box} className="wf-ph-pop" role="dialog" aria-label="Daten wählen" onKeyDown={onKey}>
      <ui.Input autoFocus aria-label="Daten suchen" placeholder="Suchen …" value={q} onChange={e => setQ(e.target.value)} />
      <div className="wf-ph-list">
        {groups.length ? groups.map(g => (
          <div key={g} role="group" aria-label={g}>
            <div className="wf-ph-group">{g}</div>
            {shown.filter(f => f.group === g).map(f => (
              <button key={f.path} type="button" className="wf-ph-item" onClick={() => onPick(f.path)}>{f.label}</button>
            ))}
          </div>
        )) : <p className="wf-muted wf-small">{fields.length ? 'Keine Treffer.' : 'An dieser Stelle stehen noch keine Daten fest.'}</p>}
      </div>
    </div>
  );
}
