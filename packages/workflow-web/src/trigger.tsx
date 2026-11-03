/**
 * Auslöser im Detailbereich des Editors (Konzept 4.2; UX-Neukonzept Etappe 2): oben der Satz zum Auslöser, darunter
 * Ereignis der App (Auswahl aus `/workflows/meta`, Filter als Bedingung in Klartext), Zeitplan (Auswahl: täglich,
 * werktags, an Wochentagen, monatlich, stündlich; eigener Cron-Ausdruck als Ausweg) oder von Hand (Bezeichnung des
 * Knopfs und Eingabeformular). Zustandswechsel und Unterablauf folgen in späteren Stufen und werden nur angezeigt.
 *
 * Regel: Die nächsten Ausführungen eines Zeitplans berechnet der Server (`POST /workflows/schedule-preview`: Zeitzone,
 * Sommerzeit); die Oberfläche übersetzt nur zwischen Auswahl und Cron.
 */
import { useEffect, useId, useState } from 'react';
import { useSchedulePreview } from './api.ts';
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
  if (every && h === '*' && dom === '*' && mon === '*' && dow === '*') return every[1] === '1' ? 'jede Minute' : `alle ${every[1]} Minuten`;
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

/** Neuer Auslöser einer Art mit sinnvollen Vorgaben (erstes Ereignis der App, werktags 07:00, von Hand). */
export function triggerOfKind(kind: 'event' | 'schedule' | 'manual', meta: WorkflowMetaJson | undefined): Trigger {
  if (kind === 'event') return { event: meta?.events.find(e => !e.builtin)?.type ?? '' };
  if (kind === 'schedule') return { schedule: { cron: '0 7 * * 1-5', timezone: localZone() } };
  return { manual: {} };
}

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
  const setKind = (k: string) => onChange(triggerOfKind(k === 'event' || k === 'schedule' ? k : 'manual', meta));
  const appEvents = meta?.events.filter(e => !e.builtin) ?? [];
  const ownEvents = meta?.events.filter(e => e.builtin) ?? [];
  return (
    <fieldset className="wf-trigger" disabled={readOnly}>
      <legend>Auslöser</legend>
      <p className="wf-trigger-sum">{describeTrigger(trigger, meta)}</p>
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
      {'schedule' in trigger ? <ScheduleEditor schedule={trigger.schedule} onChange={schedule => onChange({ schedule })} /> : null}
      {'manual' in trigger ? <ManualEditor trigger={trigger} onChange={onChange} /> : null}
      {errors.length ? <ul className="wf-step-errors" aria-label="Hinweise zum Auslöser">{errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul> : null}
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
        <ui.Button size="sm" variant="ghost" className="wf-addlink" onClick={() => setForm([...form, { key: `feld${form.length + 1}`, label: '', type: 'text' }])}>Eingabefeld hinzufügen</ui.Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Zeitplan als Auswahl

type Rhythm = 'daily' | 'workdays' | 'weekly' | 'monthly' | 'hourly' | 'custom';
/** Zeitplan in der Auswahl: Rhythmus, Uhrzeit «HH:MM», Wochentage (Cron 0 = Sonntag), Tag im Monat, Minute. */
export interface SchedulePlan { rhythm: Rhythm; time: string; days: number[]; dom: number; minute: number }

const RHYTHM_LABEL: Record<Rhythm, string> = {
  daily: 'täglich', workdays: 'werktags (Mo–Fr)', weekly: 'an bestimmten Wochentagen', monthly: 'monatlich', hourly: 'stündlich', custom: 'eigener Cron-Ausdruck',
};
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_PLAN: SchedulePlan = { rhythm: 'workdays', time: '07:00', days: [1], dom: 1, minute: 0 };

/** Einfache Cron-Muster als Auswahl; alles andere ist «eigener Cron-Ausdruck». */
export function planOfCron(cron: string): SchedulePlan {
  const f = cron.trim().split(/\s+/);
  const custom = { ...DEFAULT_PLAN, rhythm: 'custom' as const };
  if (f.length !== 5) return custom;
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  const num = (v: string) => /^\d+$/.test(v);
  if (mon !== '*' || !num(m)) return custom;
  if (h === '*' && dom === '*' && dow === '*') return { ...DEFAULT_PLAN, rhythm: 'hourly', minute: Number(m) };
  if (!num(h)) return custom;
  const time = `${two(h)}:${two(m)}`;
  if (dom === '*' && dow === '*') return { ...DEFAULT_PLAN, rhythm: 'daily', time };
  if (dom === '*' && dow === '1-5') return { ...DEFAULT_PLAN, rhythm: 'workdays', time };
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) return { ...DEFAULT_PLAN, rhythm: 'weekly', time, days: [...new Set(dow.split(',').map(d => Number(d) % 7))] };
  if (num(dom) && dow === '*') return { ...DEFAULT_PLAN, rhythm: 'monthly', time, dom: Number(dom) };
  return custom;
}

/** Auswahl → Cron (fünf Felder); `custom` behält den bisherigen Ausdruck. */
export function cronOfPlan(p: SchedulePlan, current: string): string {
  const [h, m] = (/^(\d{1,2}):(\d{2})$/.exec(p.time) ?? [, '7', '00']).slice(1).map(Number) as [number, number];
  switch (p.rhythm) {
    case 'daily': return `${m} ${h} * * *`;
    case 'workdays': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${(p.days.length ? [...p.days].sort((a, b) => WEEK.indexOf(a) - WEEK.indexOf(b)) : [1]).join(',')}`;
    case 'monthly': return `${m} ${h} ${Math.min(31, Math.max(1, p.dom))} * *`;
    case 'hourly': return `${Math.min(59, Math.max(0, p.minute))} * * * *`;
    default: return current;
  }
}

function timeZones(current: string): string[] {
  const all = typeof (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf === 'function'
    ? (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone') : [];
  return all.includes(current) ? all : [current, ...all];
}

function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function ScheduleEditor({ schedule, onChange }: { schedule: { cron: string; timezone: string }; onChange: (s: { cron: string; timezone: string }) => void }) {
  const { ui } = useWorkflow();
  const id = useId();
  const [plan, setPlan] = useState<SchedulePlan>(() => planOfCron(schedule.cron));
  const cron = useDebouncedValue(schedule.cron, 300);
  const preview = useSchedulePreview(cron, schedule.timezone);
  const update = (p: SchedulePlan) => { setPlan(p); if (p.rhythm !== 'custom') onChange({ ...schedule, cron: cronOfPlan(p, schedule.cron) }); };
  const zones = timeZones(schedule.timezone);
  const fmt = (iso: string) => {
    try {
      return new Intl.DateTimeFormat('de-CH', { timeZone: schedule.timezone, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    } catch { return iso; }
  };
  return (
    <div className="wf-schedule">
      <div className="wf-row">
        <div className="wf-field">
          <label htmlFor={`${id}-r`}>Wiederholen</label>
          <ui.Select id={`${id}-r`} value={plan.rhythm} onChange={e => update({ ...plan, rhythm: e.target.value as Rhythm })}>
            {(Object.keys(RHYTHM_LABEL) as Rhythm[]).map(r => <option key={r} value={r}>{RHYTHM_LABEL[r]}</option>)}
          </ui.Select>
        </div>
        {plan.rhythm === 'monthly' ? (
          <div className="wf-field">
            <label htmlFor={`${id}-d`}>am Tag</label>
            <ui.Input id={`${id}-d`} type="number" min={1} max={31} className="wf-num" value={plan.dom} onChange={e => update({ ...plan, dom: Number(e.target.value) || 1 })} />
          </div>
        ) : null}
        {plan.rhythm === 'hourly' ? (
          <div className="wf-field">
            <label htmlFor={`${id}-m`}>zur Minute</label>
            <ui.Input id={`${id}-m`} type="number" min={0} max={59} className="wf-num" value={plan.minute} onChange={e => update({ ...plan, minute: Number(e.target.value) || 0 })} />
          </div>
        ) : null}
        {plan.rhythm !== 'hourly' && plan.rhythm !== 'custom' ? (
          <div className="wf-field">
            <label htmlFor={`${id}-t`}>um</label>
            <ui.Input id={`${id}-t`} type="time" value={plan.time} onChange={e => update({ ...plan, time: e.target.value || '07:00' })} />
          </div>
        ) : null}
      </div>
      {plan.rhythm === 'weekly' ? (
        <fieldset className="wf-field wf-days">
          <legend>an</legend>
          <div className="wf-row">
            {WEEK.map(d => (
              <span key={d} className="wf-check-row">
                <input type="checkbox" className="wf-check" id={`${id}-w${d}`} checked={plan.days.includes(d)}
                  onChange={e => update({ ...plan, days: e.target.checked ? [...plan.days, d] : plan.days.filter(x => x !== d) })} />
                <label htmlFor={`${id}-w${d}`}>{DAYS[d]}</label>
              </span>
            ))}
          </div>
        </fieldset>
      ) : null}
      {plan.rhythm === 'custom' ? (
        <div className="wf-field">
          <label htmlFor={`${id}-c`}>Cron-Ausdruck (Minute Stunde Tag Monat Wochentag)</label>
          <ui.Input id={`${id}-c`} value={schedule.cron} onChange={e => onChange({ ...schedule, cron: e.target.value })} />
        </div>
      ) : null}
      <div className="wf-field">
        <label htmlFor={`${id}-z`}>Zeitzone</label>
        {zones.length > 1 ? (
          <ui.Select id={`${id}-z`} value={schedule.timezone} onChange={e => onChange({ ...schedule, timezone: e.target.value })}>
            {zones.map(z => <option key={z} value={z}>{z}</option>)}
          </ui.Select>
        ) : (
          <ui.Input id={`${id}-z`} value={schedule.timezone} aria-invalid={!validTimeZone(schedule.timezone)} onChange={e => onChange({ ...schedule, timezone: e.target.value })} />
        )}
      </div>
      <div className="wf-next" aria-live="polite">
        {preview.data?.ok ? (
          <><span className="wf-label">Nächste Ausführungen</span><ul className="wf-plain">{preview.data.next.map(t => <li key={t}>{fmt(t)}</li>)}</ul></>
        ) : preview.data && !preview.data.ok ? <p className="wf-bad">{preview.data.error}</p>
          : preview.isError ? <p className="wf-hint">Die nächsten Ausführungen berechnet der Server beim Aktivieren.</p> : null}
      </div>
      {plan.rhythm !== 'custom' ? <details className="wf-step-more"><summary>Cron-Ausdruck</summary><code>{schedule.cron}</code></details> : null}
    </div>
  );
}
