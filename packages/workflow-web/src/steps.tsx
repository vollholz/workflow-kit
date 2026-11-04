/**
 * Formulare der Schritte (W4: Schrittliste statt Grafik) für den Detailbereich des Editors: je Art ein eigenes
 * Formular (Aktion aus dem Eingabe-Schema, Bedingung, Liste, Warten, Werte, Ende, Aufgabe, Genehmigung). Die Liste
 * selbst mit Wegen und «+» an jeder Stelle zeigt `flow.tsx`.
 *
 * Regeln:
 * - Wenn/Sonst und Für jedes zeigen hier nur ihre Bedingung bzw. Liste; ihre Schritte stehen im Ablauf.
 * - Jeder Schritt bekommt eine eindeutige ID (`s1`, `s2` …); Verweise `steps.<id>` bleiben beim Verschieben gültig.
 * - Meldungen der Prüfung (`POST /workflows/validate`) gehören zu dem Schritt, zu dem ihr Pfad gehört (`ownErrors`).
 * - Aufgabe und Genehmigung (Stufe 2) mit Titel, Zuständigen, Formular, Ergebnissen, Frist und Priorität bzw.
 *   Genehmigenden und Art; Unterabläufe (spätere Stufe) zeigt die Karte nur an.
 * - Ergebnisse sind Wege (Etappe 3): Eine Aufgabe mit zwei oder mehr Ergebnissen und jede Genehmigung haben je Ergebnis
 *   einen Weg (`branches`). Wird ein Ergebnis umbenannt, wandert sein Weg mit; eines mit Schritten im Weg lässt sich erst
 *   entfernen, wenn der Weg leer ist.
 * - Pfade mit Wegen: `/steps/1/branches/Nachbessern/0`. Nummern im Weg: erstes Ergebnis «2.1», weitere «2.b1», «2.c1».
 */
import { createContext, useContext, useId } from 'react';
import { useQueues } from './api.ts';
import { AssigneeInput, AssigneeText, describeAssignee } from './assignee.tsx';
import { ConditionBuilder, describeCondition } from './conditions.tsx';
import { SchemaForm } from './forms.tsx';
import { describeTemplate, TemplateInput, type ContextField } from './placeholders.tsx';
import { useWorkflow } from './provider.tsx';
import type { ApprovalMode, ApprovalStep, DefinitionError, FieldDefJson, OnError, Step, TaskPriority, TaskStep, WorkflowMetaJson } from './types.ts';
import { MODE_LABEL, outcomeLabel, plural, PRIORITY_LABEL } from './ui.tsx';
import { kindOf, outcomesOfStep, STEP_KIND_LABEL, stepTitle } from './paths.ts';

export {
  hasWays, kindOf, outcomesOfStep, pathHops, placeOfPath, STEP_KIND_LABEL, stepNumberOfPath, stepTitle, wayLetter,
} from './paths.ts';

export interface EditorContext {
  meta: WorkflowMetaJson | undefined;
  /** Daten, die an der aktuellen Stelle feststehen (im Detail eines Schritts: nur aus Auslöser und früheren Schritten). */
  fields: ContextField[];
  /** Alle Daten der Definition (Bezeichnungen der Chips, auch an Stellen, wo sie nicht feststehen). */
  allFields?: ContextField[];
  /** Daten an der Stelle eines Schritts. */
  fieldsAt?: (path: string) => ContextField[];
  errors: DefinitionError[];
  /** Hinweise der Prüfung, die nicht hindern (leerer Weg, Schritte nach «Beenden»). */
  warnings?: DefinitionError[];
  /** Schritte der Definition (für Nummern in Wegen). */
  steps?: Step[];
  readOnly: boolean;
  newId: () => string;
}
export const EditorCtx = createContext<EditorContext | null>(null);
export const useEditor = () => {
  const c = useContext(EditorCtx);
  if (!c) throw new Error('Schrittliste ohne Editor');
  return c;
};

export type StepKindName = 'action' | 'if' | 'foreach' | 'wait' | 'set' | 'end' | 'task' | 'approval';
export const ADDABLE: StepKindName[] = ['action', 'if', 'foreach', 'wait', 'task', 'approval', 'set', 'end'];

export function newStep(kind: StepKindName, id: string): Step {
  switch (kind) {
    case 'action': return { id, action: '', input: {} };
    case 'if': return { id, if: { all: [{ field: '', op: 'eq', value: '' }] }, then: [] };
    case 'foreach': return { id, foreach: { items: '', as: 'eintrag' }, steps: [] };
    case 'wait': return { id, wait: { duration: 'PT1H' } };
    case 'set': return { id, set: { wert: '' } };
    case 'end': return { id, end: { result: 'completed' } };
    case 'task': return { id, task: { title: '', assignee: { actor: { id: '', kind: 'person' } } } };
    case 'approval': return { id, approval: { title: '', approvers: [{ actor: { id: '', kind: 'person' } }], mode: 'first' } };
  }
}

// ---------------------------------------------------------------- Dauer (ISO 8601 mit Arbeitstagen)

const UNITS = [
  { key: 'M', label: 'Minuten', one: 'Minute', make: (n: number) => `PT${n}M`, re: /^PT(\d+)M$/ },
  { key: 'H', label: 'Stunden', one: 'Stunde', make: (n: number) => `PT${n}H`, re: /^PT(\d+)H$/ },
  { key: 'BH', label: 'Arbeitsstunden', one: 'Arbeitsstunde', make: (n: number) => `PT${n}BH`, re: /^PT(\d+)BH$/ },
  { key: 'D', label: 'Tage', one: 'Tag', make: (n: number) => `P${n}D`, re: /^P(\d+)D$/ },
  { key: 'BD', label: 'Arbeitstage', one: 'Arbeitstag', make: (n: number) => `P${n}BD`, re: /^P(\d+)BD$/ },
  { key: 'W', label: 'Wochen', one: 'Woche', make: (n: number) => `P${n}W`, re: /^P(\d+)W$/ },
] as const;

export function describeDuration(iso: string | undefined): string {
  if (!iso) return '';
  for (const u of UNITS) {
    const m = u.re.exec(iso);
    if (m) return plural(Number(m[1]), u.one, u.label);
  }
  return iso;
}

/** Dauer mit Anzahl und Zeitraum (auch Arbeitstage und -stunden); andere Schreibweisen als ISO-Text. */
export function DurationInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { ui } = useWorkflow();
  const id = useId();
  const unit = UNITS.find(u => u.re.test(value));
  if (!unit) {
    return (
      <div className="wf-field">
        <label htmlFor={id}>{label} (ISO 8601, z. B. PT4H oder P3BD)</label>
        <ui.Input id={id} value={value} onChange={e => onChange(e.target.value)} />
      </div>
    );
  }
  const n = Number(unit.re.exec(value)![1]);
  return (
    <div className="wf-field">
      <span className="wf-label" id={`${id}-l`}>{label}</span>
      <div className="wf-row" role="group" aria-labelledby={`${id}-l`}>
        <ui.Input aria-label={`${label}: Anzahl`} type="number" min={1} value={n} className="wf-num" onChange={e => onChange(unit.make(Math.max(1, Number(e.target.value) || 1)))} />
        <ui.Select aria-label={`${label}: Zeitraum`} value={unit.key} onChange={e => onChange(UNITS.find(u => u.key === e.target.value)!.make(n))}>
          {UNITS.map(u => <option key={u.key} value={u.key}>{u.label}</option>)}
        </ui.Select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Liste

/** Meldungen genau dieses Schritts (ohne die verschachtelter Schritte; ein leerer Weg gehört zum Schritt). */
export function ownErrors(errors: DefinitionError[], path: string): DefinitionError[] {
  return errors.filter(e => {
    if (e.path !== path && !e.path.startsWith(`${path}/`)) return false;
    const rest = e.path.slice(path.length);
    return !/^\/(then|else|steps|onError\/steps|branches\/[^/]+)\/\d+/.test(rest);
  });
}

export function summary(s: Step, meta: WorkflowMetaJson | undefined, fields: ContextField[]): string {
  if ('action' in s) return s.action ? (meta?.actions.find(a => a.key === s.action)?.label ?? s.action) : 'Aktion noch nicht gewählt';
  if ('if' in s) return `Wenn ${describeCondition(s.if, fields)}`;
  if ('foreach' in s) return `Für jeden Eintrag in ${s.foreach.items ? describeTemplate(s.foreach.items, fields) : '…'}`;
  if ('wait' in s) return s.wait.duration ? `Warten: ${describeDuration(s.wait.duration)}` : s.wait.until ? `Warten bis ${describeTemplate(s.wait.until, fields)}` : 'Warten auf ein Ereignis';
  if ('set' in s) return `Setzt ${Object.keys(s.set).join(', ') || '…'}`;
  if ('end' in s) return `Run beenden: ${END_LABEL[s.end.result]}`;
  if ('task' in s) return `Aufgabe «${s.task.title || '…'}» für ${describeAssignee(s.task.assignee)}${s.task.due ? `, Frist ${describeDuration(s.task.due)}` : ''}`;
  if ('approval' in s) return `Genehmigung «${s.approval.title || '…'}» bei ${s.approval.approvers.map(a => describeAssignee(a)).join(', ')}`;
  return `${STEP_KIND_LABEL[kindOf(s)] ?? 'Schritt'} (folgt in einer späteren Stufe)`;
}

/**
 * Zusammenfassung eines Schritts; bei Aufgabe und Genehmigung mit Namen der Zuständigen (Person, Team, Warteschlange).
 * `short`: ohne Art und Titel (zweite Zeile im Ablauf, unter dem Titel), z. B. «für Warteschlange Support, Frist 2 Arbeitstage».
 */
export function StepSummary({ step, meta, fields, short }: { step: Step; meta: WorkflowMetaJson | undefined; fields: ContextField[]; short?: boolean }) {
  if ('task' in step) {
    const t = step.task;
    if (short && 'actor' in t.assignee && !t.assignee.actor.id) return <>Noch niemand zuständig{t.due ? `, Frist ${describeDuration(t.due)}` : ''}</>;
    return <>{short ? 'für ' : `Aufgabe «${t.title || '…'}» für `}<AssigneeText value={t.assignee} />{t.due ? `, Frist ${describeDuration(t.due)}` : ''}</>;
  }
  if ('approval' in step) {
    const a = step.approval;
    return <>{short ? 'bei ' : `Genehmigung «${a.title || '…'}» bei `}{a.approvers.map((x, i) => <span key={i}>{i ? ', ' : ''}<AssigneeText value={x} /></span>)}{short ? ` · ${MODE_LABEL[a.mode]}` : ''}</>;
  }
  return <>{summary(step, meta, fields)}</>;
}
const END_LABEL = { completed: 'erfolgreich', cancelled: 'abgebrochen', failed: 'fehlgeschlagen' } as const;

export function CommonFields({ step, onChange, name }: { step: Step; onChange: (s: Step) => void; name: string }) {
  const { ui } = useWorkflow();
  const id = useId();
  const oe: OnError = step.onError ?? {};
  const setOe = (o: OnError) => {
    const next = { ...step };
    if (!o.retry && (!o.then || o.then === 'incident')) delete next.onError; else next.onError = o;
    onChange(next);
  };
  const kind = kindOf(step);
  return (
    <details className="wf-step-more">
      <summary>Weitere Angaben</summary>
      <div className="wf-field">
        <label htmlFor={`${id}-l`}>Bezeichnung (optional)</label>
        <ui.Input id={`${id}-l`} value={step.label ?? ''} onChange={e => { const n = { ...step }; if (e.target.value) n.label = e.target.value; else delete n.label; onChange(n); }} />
      </div>
      <div className="wf-hint">ID für Verweise: <code>{`steps.${step.id}`}</code></div>
      {kind === 'action' ? (
        <div className="wf-row">
          <div className="wf-field">
            <label htmlFor={`${id}-r`}>Bei Fehler wiederholen</label>
            <ui.Select id={`${id}-r`} value={String(oe.retry ?? '')} onChange={e => setOe({ ...oe, retry: e.target.value === '' ? undefined : Number(e.target.value) })}>
              <option value="">Standard</option>
              {[0, 1, 2, 3, 5, 10].map(n => <option key={n} value={n}>{n === 0 ? 'nie' : `${n}×`}</option>)}
            </ui.Select>
          </div>
          <div className="wf-field">
            <label htmlFor={`${id}-t`}>Danach</label>
            <ui.Select id={`${id}-t`} value={oe.then ?? 'incident'} aria-describedby={`${id}-th`} onChange={e => setOe({ ...oe, then: e.target.value as OnError['then'] })}>
              <option value="incident">Vorfall: Run hält an</option>
              <option value="continue">Weiter mit dem nächsten Schritt</option>
              {oe.then === 'path' ? <option value="path">Eigener Fehlerpfad</option> : null}
            </ui.Select>
            <span id={`${id}-th`} className="wf-sr">{`${name}: Verhalten nach dem letzten Versuch`}</span>
          </div>
        </div>
      ) : null}
    </details>
  );
}

/** Formular eines Schritts; verschachtelte Schritte (Dann, Sonst, Für jeden Eintrag) zeigt der Ablauf. */
export function StepBody({ step, number, onChange }: { step: Step; number: string; onChange: (s: Step) => void }) {
  const ed = useEditor();
  const { ui } = useWorkflow();
  const id = useId();
  const name = `Schritt ${number}`;
  if ('action' in step) {
    const action = ed.meta?.actions.find(a => a.key === step.action);
    const groups = [...new Set((ed.meta?.actions ?? []).map(a => a.group))];
    return (
      <>
        <div className="wf-field">
          <label htmlFor={id}>Aktion</label>
          <ui.Select id={id} value={step.action} onChange={e => onChange({ ...step, action: e.target.value, input: {} })}>
            <option value="">– Aktion wählen –</option>
            {groups.map(g => (
              <optgroup key={g} label={g}>
                {ed.meta!.actions.filter(a => a.group === g).map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
              </optgroup>
            ))}
            {step.action && !action ? <option value={step.action}>{step.action} (unbekannt)</option> : null}
          </ui.Select>
        </div>
        {action ? <SchemaForm key={action.key} schema={action.input} value={step.input ?? {}} onChange={input => onChange({ ...step, input })} fields={ed.fields} disabled={ed.readOnly} /> : null}
      </>
    );
  }
  if ('if' in step) {
    return (
      <>
        <ConditionBuilder label={`${name}: Bedingung`} value={step.if} fields={ed.fields} disabled={ed.readOnly}
          onChange={c => onChange({ ...step, if: c ?? { all: [{ field: '', op: 'eq', value: '' }] } })} />
        <p className="wf-hint">Die Schritte für «Dann» und «Sonst» stehen im Ablauf unter diesem Schritt.</p>
      </>
    );
  }
  if ('foreach' in step) {
    return (
      <>
        <TemplateInput label="Liste" value={step.foreach.items} fields={ed.fields} required
          hint="Daten, die eine Liste enthalten; jeder Eintrag durchläuft die Schritte im Weg «Für jeden Eintrag»."
          onChange={items => onChange({ ...step, foreach: { ...step.foreach, items } })} />
        <div className="wf-row">
          <div className="wf-field">
            <label htmlFor={`${id}-as`}>Name des Eintrags</label>
            <ui.Input id={`${id}-as`} value={step.foreach.as} aria-describedby={`${id}-ash`} onChange={e => onChange({ ...step, foreach: { ...step.foreach, as: e.target.value } })} />
            <span id={`${id}-ash`} className="wf-hint">{`Im Schritt als {{vars.${step.foreach.as || '…'}}}`}</span>
          </div>
          <div className="wf-field">
            <label htmlFor={`${id}-lim`}>Höchstens</label>
            <ui.Input id={`${id}-lim`} type="number" min={1} className="wf-num" value={step.foreach.limit ?? ''} placeholder="Grenze"
              onChange={e => { const f = { ...step.foreach }; if (e.target.value) f.limit = Number(e.target.value); else delete f.limit; onChange({ ...step, foreach: f }); }} />
          </div>
        </div>
        <p className="wf-hint">Die Schritte für jeden Eintrag stehen im Ablauf unter diesem Schritt.</p>
      </>
    );
  }
  if ('wait' in step) {
    const mode = step.wait.until !== undefined ? 'until' : step.wait.event ? 'event' : 'duration';
    return (
      <>
        <div className="wf-field">
          <label htmlFor={`${id}-m`}>Warten</label>
          <ui.Select id={`${id}-m`} value={mode} onChange={e => onChange({ ...step, wait: e.target.value === 'until' ? { until: '' } : { duration: 'PT1H' } })}>
            <option value="duration">eine Dauer lang</option>
            <option value="until">bis zu einem Zeitpunkt</option>
            {mode === 'event' ? <option value="event">auf ein Ereignis (spätere Stufe)</option> : null}
          </ui.Select>
        </div>
        {mode === 'duration' ? <DurationInput label="Dauer" value={step.wait.duration ?? ''} onChange={duration => onChange({ ...step, wait: { duration } })} /> : null}
        {mode === 'until' ? (
          <TemplateInput label="Zeitpunkt" value={step.wait.until ?? ''} fields={ed.fields} required hint="Datum und Zeit (z. B. 2026-12-31T08:00) oder Daten"
            onChange={until => onChange({ ...step, wait: { until } })} />
        ) : null}
      </>
    );
  }
  if ('set' in step) return <SetEditor step={step} onChange={onChange} name={name} />;
  if ('task' in step) return <TaskEditor step={step} onChange={onChange} name={name} />;
  if ('approval' in step) return <ApprovalEditor step={step} onChange={onChange} name={name} />;
  if ('end' in step) {
    return (
      <>
        <div className="wf-field">
          <label htmlFor={`${id}-r`}>Ergebnis</label>
          <ui.Select id={`${id}-r`} value={step.end.result} onChange={e => onChange({ ...step, end: { ...step.end, result: e.target.value as 'completed' } })}>
            <option value="completed">erfolgreich</option>
            <option value="cancelled">abgebrochen</option>
            <option value="failed">fehlgeschlagen</option>
          </ui.Select>
        </div>
        <TemplateInput label="Meldung (optional)" value={step.end.message ?? ''} fields={ed.fields}
          onChange={message => { const end = { ...step.end }; if (message) end.message = message; else delete end.message; onChange({ ...step, end }); }} />
      </>
    );
  }
  return <p className="wf-muted wf-small">Diese Schrittart folgt in einer späteren Stufe; sie lässt sich hier nur ansehen.</p>;
}

function SetEditor({ step, onChange, name }: { step: Step & { set: Record<string, unknown> }; onChange: (s: Step) => void; name: string }) {
  const ed = useEditor();
  const { ui } = useWorkflow();
  const entries = Object.entries(step.set);
  const write = (list: [string, unknown][]) => onChange({ ...step, set: Object.fromEntries(list) });
  return (
    <div className="wf-form">
      {entries.map(([k, v], i) => (
        <div key={i} className="wf-row wf-set-row">
          <div className="wf-field">
            <label htmlFor={`${step.id}-k${i}`}>Name</label>
            <ui.Input id={`${step.id}-k${i}`} value={k} onChange={e => write(entries.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
          </div>
          <TemplateInput label={`Wert von «${k || '…'}»`} value={typeof v === 'string' ? v : JSON.stringify(v)} fields={ed.fields}
            onChange={nv => write(entries.map((x, j) => (j === i ? [x[0], nv] : x)))} />
          {entries.length > 1 ? <ui.Button size="sm" variant="ghost" aria-label={`${name}: «${k}» entfernen`} onClick={() => write(entries.filter((_, j) => j !== i))}>✕</ui.Button> : null}
        </div>
      ))}
      <ui.Button size="sm" variant="ghost" className="wf-addlink" onClick={() => {
        let n = entries.length + 1;
        while (`wert${n}` in step.set) n++;
        write([...entries, [`wert${n}`, '']]);
      }}>Wert hinzufügen</ui.Button>
    </div>
  );
}

// ---------------------------------------------------------------- Aufgabe und Genehmigung (Stufe 2)

const FIELD_TYPES: [string, string][] = [['text', 'Text'], ['number', 'Zahl'], ['date', 'Datum'], ['choice', 'Auswahl'], ['boolean', 'Ja/Nein'], ['actor', 'Person'], ['file', 'Datei']];

/** Frist und Priorität; ohne eigene Frist gilt die der Warteschlange (`queueId`), sonst keine. */
function PriorityAndDue({ due, priority, onChange, name, queueId }: {
  due?: string; priority?: TaskPriority; onChange: (v: { due?: string; priority?: TaskPriority }) => void; name: string; queueId?: string;
}) {
  const { ui } = useWorkflow();
  const id = useId();
  const queues = useQueues(!!queueId);
  const queue = queueId ? queues.data?.items.find(q => q.id === queueId) : undefined;
  const inherited = !queueId ? 'keine Frist' : queue ? `wie Warteschlange: ${queue.slaTarget ? describeDuration(queue.slaTarget) : 'keine Frist'}` : 'wie Warteschlange';
  return (
    <div className="wf-row">
      <div className="wf-field">
        <label htmlFor={`${id}-d`}>Frist</label>
        <ui.Select id={`${id}-d`} value={due ? 'yes' : ''} onChange={e => onChange({ due: e.target.value ? 'P1BD' : undefined, priority })}>
          <option value="">{inherited}</option>
          <option value="yes">festlegen</option>
        </ui.Select>
      </div>
      {due ? <DurationInput label={`${name}: Frist`} value={due} onChange={d => onChange({ due: d, priority })} /> : null}
      <div className="wf-field">
        <label htmlFor={`${id}-p`}>Priorität</label>
        <ui.Select id={`${id}-p`} value={priority ?? 'normal'} onChange={e => onChange({ due, priority: e.target.value as TaskPriority })}>
          {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </ui.Select>
      </div>
    </div>
  );
}

/** Felder des Formulars einer Aufgabe. */
function FormFieldsEditor({ fields, onChange, name }: { fields: FieldDefJson[]; onChange: (f: FieldDefJson[]) => void; name: string }) {
  const w = useWorkflow();
  const { ui } = w;
  const set = (i: number, f: FieldDefJson) => onChange(fields.map((x, j) => (j === i ? f : x)));
  const kinds = [...FIELD_TYPES, ...Object.entries(w.fields).map(([k, v]): [string, string] => [k, v.label])];
  return (
    <fieldset className="wf-field">
      <legend>Formular</legend>
      {fields.length ? null : <p className="wf-muted wf-small">Ohne Felder: nur ein Ergebnis wählen.</p>}
      {fields.map((f, i) => (
        <div key={i} className="wf-row wf-set-row">
          <ui.Input aria-label={`${name}: Feld ${i + 1} Schlüssel`} placeholder="schluessel" value={f.key} onChange={e => set(i, { ...f, key: e.target.value })} />
          <ui.Input aria-label={`${name}: Feld ${i + 1} Bezeichnung`} placeholder="Bezeichnung" value={f.label} onChange={e => set(i, { ...f, label: e.target.value })} />
          <ui.Select aria-label={`${name}: Feld ${i + 1} Art`} value={f.type} onChange={e => set(i, { ...f, type: e.target.value })}>
            {kinds.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </ui.Select>
          {f.type === 'choice' ? (
            <ui.Input aria-label={`${name}: Feld ${i + 1} Werte`} placeholder="wert=Bezeichnung, …" value={(f.options ?? []).map(o => `${o.value}=${o.label}`).join(', ')}
              onChange={e => set(i, { ...f, options: e.target.value.split(',').map(s => s.trim()).filter(Boolean).map(s => { const [v, l] = s.split('='); return { value: v!.trim(), label: (l ?? v!).trim() }; }) })} />
          ) : null}
          <label className="wf-check-row"><ui.Input type="checkbox" checked={!!f.required} onChange={e => set(i, { ...f, required: e.target.checked || undefined })} /> Pflicht</label>
          <ui.Button size="sm" variant="ghost" aria-label={`${name}: Feld ${i + 1} entfernen`} onClick={() => onChange(fields.filter((_, j) => j !== i))}>✕</ui.Button>
        </div>
      ))}
      <ui.Button size="sm" variant="ghost" className="wf-addlink" onClick={() => onChange([...fields, { key: `feld${fields.length + 1}`, label: '', type: 'text' }])}>Feld hinzufügen</ui.Button>
    </fieldset>
  );
}

function TaskEditor({ step, onChange, name }: { step: TaskStep; onChange: (s: Step) => void; name: string }) {
  const ed = useEditor();
  const t = step.task;
  const set = (patch: Partial<TaskStep['task']>) => {
    const next = { ...t, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined || (Array.isArray(next[k]) && !(next[k] as unknown[]).length)) delete next[k];
    onChange({ ...step, task: next as TaskStep['task'] });
  };
  return (
    <>
      <TemplateInput label="Titel" required value={t.title} fields={ed.fields} onChange={title => set({ title })} />
      <TemplateInput label="Beschreibung (optional)" value={t.description ?? ''} fields={ed.fields} onChange={d => set({ description: d || undefined })} />
      <AssigneeInput label="Zuständig" value={t.assignee} onChange={assignee => set({ assignee })} />
      <FormFieldsEditor name={name} fields={t.form ?? []} onChange={form => set({ form })} />
      <OutcomesEditor step={step} onChange={onChange} name={name} />
      <PriorityAndDue name={name} due={t.due} priority={t.priority} onChange={v => set(v)} queueId={'queue' in t.assignee ? t.assignee.queue : undefined} />
    </>
  );
}

/**
 * Ergebnisse einer Aufgabe als Liste: ohne Angabe gibt es eines («Erledigt»). Umbenennen nimmt den Weg mit; ein Ergebnis
 * mit Schritten im Weg lässt sich erst entfernen, wenn der Weg leer ist.
 */
function OutcomesEditor({ step, onChange, name }: { step: TaskStep; onChange: (s: Step) => void; name: string }) {
  const { ui } = useWorkflow();
  const ed = useEditor();
  const id = useId();
  const outcomes = outcomesOfStep(step);
  const branches = (step.branches ?? {}) as Record<string, Step[] | undefined>;
  const write = (next: string[], ways: Record<string, Step[] | undefined>) => {
    const task = { ...step.task } as TaskStep['task'];
    if (next.length === 1 && next[0] === 'done') delete task.outcomes; else task.outcomes = next;
    const kept = Object.fromEntries(Object.entries(ways).filter(([k, l]) => next.includes(k) && l?.length)) as Record<string, Step[]>;
    const out: TaskStep = { ...step, task };
    if (Object.keys(kept).length) out.branches = kept; else delete out.branches;
    onChange(out);
  };
  const rename = (i: number, text: string) => {
    const old = outcomes[i]!;
    const ways = { ...branches };
    if (old in ways) { ways[text] = ways[old]; delete ways[old]; }
    write(outcomes.map((o, j) => (j === i ? text : o)), ways);
  };
  const add = () => {
    let n = outcomes.length + 1;
    while (outcomes.includes(`Ergebnis ${n}`)) n++;
    write([...outcomes, `Ergebnis ${n}`], branches);
  };
  return (
    <fieldset className="wf-field wf-outcomes" aria-describedby={`${id}-h`}>
      <legend>Ergebnisse</legend>
      {outcomes.map((o, i) => {
        const busy = !!branches[o]?.length;
        return (
          <div key={i} className="wf-row">
            <ui.Input aria-label={`Ergebnis ${i + 1}`} value={outcomeLabel(o)} disabled={ed.readOnly} onChange={e => rename(i, e.target.value)} />
            {outcomes.length > 1 && !ed.readOnly ? (
              <ui.Button size="sm" variant="ghost" aria-label={`${name}: Ergebnis «${outcomeLabel(o)}» entfernen`} aria-disabled={busy || undefined}
                title={busy ? 'Zuerst die Schritte im Weg entfernen' : undefined}
                onClick={() => { if (!busy) write(outcomes.filter((_, j) => j !== i), branches); }}>✕</ui.Button>
            ) : null}
          </div>
        );
      })}
      {!ed.readOnly ? <ui.Button size="sm" variant="ghost" className="wf-addlink" onClick={add}>Ergebnis hinzufügen</ui.Button> : null}
      <span id={`${id}-h`} className="wf-hint">
        {outcomes.length > 1 ? 'Wer die Aufgabe erledigt, wählt eines. Jedes Ergebnis hat im Ablauf einen eigenen Weg.' : 'Mit zwei oder mehr Ergebnissen entstehen im Ablauf Wege, z. B. «Passt» und «Nachbessern».'}
      </span>
    </fieldset>
  );
}

function ApprovalEditor({ step, onChange, name }: { step: ApprovalStep; onChange: (s: Step) => void; name: string }) {
  const ed = useEditor();
  const { ui } = useWorkflow();
  const id = useId();
  const a = step.approval;
  const set = (patch: Partial<ApprovalStep['approval']>) => {
    const next = { ...a, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange({ ...step, approval: next as ApprovalStep['approval'] });
  };
  return (
    <>
      <TemplateInput label="Titel" required value={a.title} fields={ed.fields} onChange={title => set({ title })} />
      <TemplateInput label="Beschreibung (optional)" value={a.description ?? ''} fields={ed.fields} onChange={d => set({ description: d || undefined })} />
      {a.approvers.map((x, i) => (
        <div key={i} className="wf-row">
          <AssigneeInput label={`Genehmigend ${i + 1}`} value={x} onChange={v => set({ approvers: a.approvers.map((y, j) => (j === i ? v : y)) })} />
          {a.approvers.length > 1 ? <ui.Button size="sm" variant="ghost" aria-label={`${name}: Genehmigend ${i + 1} entfernen`} onClick={() => set({ approvers: a.approvers.filter((_, j) => j !== i) })}>✕</ui.Button> : null}
        </div>
      ))}
      <ui.Button size="sm" variant="ghost" className="wf-addlink" onClick={() => set({ approvers: [...a.approvers, { actor: { id: '', kind: 'person' } }] })}>Genehmigende hinzufügen</ui.Button>
      <div className="wf-field">
        <label htmlFor={`${id}-m`}>Art</label>
        <ui.Select id={`${id}-m`} value={a.mode} onChange={e => set({ mode: e.target.value as ApprovalMode })}>
          {(Object.keys(MODE_LABEL) as ApprovalMode[]).map(m => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </ui.Select>
      </div>
      <label className="wf-check-row"><ui.Input type="checkbox" checked={a.reasonOnReject !== false} onChange={e => set({ reasonOnReject: e.target.checked ? undefined : false })} /> Begründung bei Ablehnung verlangen</label>
      <span className="wf-hint">Danach geht es im Ablauf auf dem Weg «Genehmigt» oder «Abgelehnt» weiter.</span>
      <PriorityAndDue name={name} due={a.due} priority={a.priority} onChange={v => set(v)} queueId={a.approvers.map(x => ('queue' in x ? x.queue : '')).find(Boolean)} />
    </>
  );
}