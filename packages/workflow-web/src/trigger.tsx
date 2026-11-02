/**
 * Auslöser im Kopf des Editors (Konzept 4.2): Ereignis der App (Auswahl aus `/workflows/meta`, Filter als Bedingung in
 * Klartext), Zeitplan (Cron mit Zeitzone und Beschreibung in Worten) oder von Hand (Bezeichnung des Knopfs und
 * Eingabeformular). Zustandswechsel und Unterablauf folgen in späteren Stufen und werden nur angezeigt.
 *
 * Regel: Die nächsten Ausführungen eines Zeitplans berechnet der Server (Zeitzone, Sommerzeit); die Oberfläche
 * beschreibt einfache Muster in Worten und prüft nur die Zeitzone.
 */
import { useId } from 'react';
import { ConditionBuilder, describeCondition } from './conditions.tsx';
import { eventFilterFields } from './placeholders.tsx';
import { useWorkflow } from './provider.tsx';
import type { FieldDefJson, Trigger, WorkflowMetaJson } from './types.ts';

const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const two = (n: string) => n.padStart(2, '0');

/** Einfache Cron-Muster in Worten; sonst null. */
export function describeCron(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  const num = (v: string) => /^\d+$/.test(v);
  const every = /^\*\/(\d+)$/.exec(m);
  if (every && h === '*' && dom === '*' && mon === '*' && dow === '*') return `alle ${every[1]} Minuten`;
  if (num(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `stündlich zur Minute ${m}`;
  if (!num(m) || !(num(h) || /^\d+(,\d+)+$/.test(h)) || mon !== '*') return null;
  const at = `um ${h.split(',').map(x => `${two(x)}:${two(m)}`).join(' und ')}`;
  if (dom === '*' && dow === '*') return `täglich ${at}`;
  if (dom === '*' && dow === '1-5') return `werktags (Mo–Fr) ${at}`;
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) return `jeden ${dow.split(',').map(d => DAYS[Number(d)]).join(', ')} ${at}`;
  if (num(dom) && dow === '*') return `monatlich am ${dom}. ${at}`;
  return null;
}

export const validTimeZone = (tz: string) => {
  try { new Intl.DateTimeFormat('de-CH', { timeZone: tz }); return !!tz; } catch { return false; }
};
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Zurich'; } catch { return 'Europe/Zurich'; } };

/** Auslöser als Satz (Kopf, Zusammenfassung beim Aktivieren). */
export function describeTrigger(t: Trigger, meta: WorkflowMetaJson | undefined): string {
  if ('event' in t) {
    const ev = meta?.events.find(e => e.type === t.event);
    const base = `Bei «${ev?.label ?? (t.event || '…')}»`;
    return t.filter ? `${base}, wenn ${describeCondition(t.filter, eventFilterFields(meta, t.event))}` : base;
  }
  if ('schedule' in t) return `Nach Zeitplan: ${describeCron(t.schedule.cron) ?? `«${t.schedule.cron}»`} (${t.schedule.timezone})`;
  if ('manual' in t) return `Von Hand${t.manual.label ? ` über «${t.manual.label}»` : ''}${t.manual.form?.length ? ` mit ${t.manual.form.length} Eingabefeld(ern)` : ''}`;
  if ('transition' in t) return 'Bei einem Zustandswechsel (folgt in Stufe 4)';
  return 'Als Unterablauf (folgt in Stufe 3)';
}

const FIELD_TYPES = [['text', 'Text'], ['number', 'Zahl'], ['date', 'Datum'], ['boolean', 'Ja/Nein'], ['choice', 'Auswahl']] as const;

export function TriggerEditor({ trigger, onChange, meta, readOnly, errors }: {
  trigger: Trigger; onChange: (t: Trigger) => void; meta: WorkflowMetaJson | undefined; readOnly: boolean; errors: { path: string; message: string }[];
}) {
  const { ui } = useWorkflow();
  const id = useId();
  const kind = 'event' in trigger ? 'event' : 'schedule' in trigger ? 'schedule' : 'manual' in trigger ? 'manual' : 'other';
  const setKind = (k: string) => {
    if (k === 'event') onChange({ event: meta?.events.find(e => !e.builtin)?.type ?? '' });
    else if (k === 'schedule') onChange({ schedule: { cron: '0 7 * * 1-5', timezone: localZone() } });
    else onChange({ manual: {} });
  };
  const appEvents = meta?.events.filter(e => !e.builtin) ?? [];
  const ownEvents = meta?.events.filter(e => e.builtin) ?? [];
  return (
    <fieldset className="wf-trigger" disabled={readOnly}>
      <legend>Auslöser</legend>
      <div className="wf-field">
        <label htmlFor={`${id}-k`}>Starten</label>
        <ui.Select id={`${id}-k`} value={kind} onChange={e => setKind(e.target.value)}>
          <option value="event">bei einem Ereignis</option>
          <option value="schedule">nach Zeitplan</option>
          <option value="manual">von Hand</option>
          {kind === 'other' ? <option value="other">anders (spätere Stufe)</option> : null}
        </ui.Select>
      </div>
      {'event' in trigger ? (
        <>
          <div className="wf-field">
            <label htmlFor={`${id}-e`}>Ereignis</label>
            <ui.Select id={`${id}-e`} value={trigger.event} onChange={e => onChange({ event: e.target.value, ...(trigger.includeWorkflowEvents ? { includeWorkflowEvents: true } : {}) })}>
              <option value="">– Ereignis wählen –</option>
              <optgroup label="Ereignisse der Anwendung">{appEvents.map(e => <option key={e.type} value={e.type}>{e.label}</option>)}</optgroup>
              <optgroup label="Ereignisse der Workflows">{ownEvents.map(e => <option key={e.type} value={e.type}>{e.label}</option>)}</optgroup>
            </ui.Select>
            {meta?.events.find(e => e.type === trigger.event)?.description ? <div className="wf-hint">{meta.events.find(e => e.type === trigger.event)!.description}</div> : null}
          </div>
          <ConditionBuilder optional label="Filter des Auslösers" value={trigger.filter} fields={eventFilterFields(meta, trigger.event)} disabled={readOnly}
            onChange={filter => { const t = { ...trigger }; if (filter) t.filter = filter; else delete t.filter; onChange(t); }} />
          <div className="wf-check-row">
            <ui.Input id={`${id}-w`} type="checkbox" checked={!!trigger.includeWorkflowEvents}
              onChange={e => { const t = { ...trigger }; if (e.target.checked) t.includeWorkflowEvents = true; else delete t.includeWorkflowEvents; onChange(t); }} />
            <label htmlFor={`${id}-w`}>Auch Ereignisse, die ein Workflow ausgelöst hat (Vorsicht: Schleifen)</label>
          </div>
        </>
      ) : null}
      {'schedule' in trigger ? (
        <>
          <div className="wf-row">
            <div className="wf-field">
              <label htmlFor={`${id}-c`}>Zeitplan (Cron: Minute Stunde Tag Monat Wochentag)</label>
              <ui.Input id={`${id}-c`} value={trigger.schedule.cron} aria-describedby={`${id}-ch`} onChange={e => onChange({ schedule: { ...trigger.schedule, cron: e.target.value } })} />
            </div>
            <div className="wf-field">
              <label htmlFor={`${id}-z`}>Zeitzone</label>
              <ui.Input id={`${id}-z`} value={trigger.schedule.timezone} aria-invalid={!validTimeZone(trigger.schedule.timezone)} onChange={e => onChange({ schedule: { ...trigger.schedule, timezone: e.target.value } })} />
            </div>
          </div>
          <p id={`${id}-ch`} className="wf-hint" aria-live="polite">
            {describeCron(trigger.schedule.cron) ? `Läuft ${describeCron(trigger.schedule.cron)} (${trigger.schedule.timezone}).` : 'Eigener Zeitplan.'}
            {' '}Die nächsten Ausführungen berechnet der Server beim Aktivieren.
            {!validTimeZone(trigger.schedule.timezone) ? ' Unbekannte Zeitzone.' : ''}
          </p>
        </>
      ) : null}
      {'manual' in trigger ? <ManualEditor trigger={trigger} onChange={onChange} /> : null}
      {errors.length ? <ul className="wf-step-errors" aria-label="Hinweise zum Auslöser">{errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul> : null}
      <p className="wf-trigger-sum">{describeTrigger(trigger, meta)}</p>
    </fieldset>
  );
}

function ManualEditor({ trigger, onChange }: { trigger: { manual: { label?: string; form?: FieldDefJson[] } }; onChange: (t: Trigger) => void }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const form = trigger.manual.form ?? [];
  const setForm = (f: FieldDefJson[]) => onChange({ manual: { ...trigger.manual, form: f } });
  const types: (readonly [string, string])[] = [...FIELD_TYPES, ...Object.entries(w.fields).map(([k, f]) => [k, f.label] as const)];
  return (
    <>
      <div className="wf-field">
        <label htmlFor={`${id}-l`}>Beschriftung des Knopfs</label>
        <ui.Input id={`${id}-l`} value={trigger.manual.label ?? ''} placeholder="z. B. Jetzt prüfen"
          onChange={e => { const m = { ...trigger.manual }; if (e.target.value) m.label = e.target.value; else delete m.label; onChange({ manual: m }); }} />
      </div>
      <div className="wf-form" role="group" aria-label="Eingabeformular beim Start">
        {form.map((f, i) => (
          <div key={i} className="wf-row wf-form-row">
            <ui.Input aria-label={`Feld ${i + 1}: Bezeichnung`} value={f.label} placeholder="Bezeichnung" onChange={e => setForm(form.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <ui.Input aria-label={`Feld ${i + 1}: Name`} value={f.key} placeholder="name" onChange={e => setForm(form.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <ui.Select aria-label={`Feld ${i + 1}: Art`} value={f.type} onChange={e => setForm(form.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
              {types.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </ui.Select>
            <span className="wf-check-row">
              <ui.Input id={`${id}-r${i}`} type="checkbox" checked={!!f.required} onChange={e => setForm(form.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
              <label htmlFor={`${id}-r${i}`}>Pflicht</label>
            </span>
            <ui.Button size="sm" variant="ghost" aria-label={`Feld ${i + 1} entfernen`} onClick={() => setForm(form.filter((_, j) => j !== i))}>✕</ui.Button>
          </div>
        ))}
        <ui.Button size="sm" onClick={() => setForm([...form, { key: `feld${form.length + 1}`, label: '', type: 'text' }])}>Eingabefeld hinzufügen</ui.Button>
      </div>
    </>
  );
}
