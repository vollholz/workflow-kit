/**
 * Kalender für Fristen: Liste und Editor (Zeitzone, Arbeitszeiten je Wochentag, Feiertage, Standard) mit Vorschau,
 * wann eine Frist ablaufen würde. Nur mit `queue:manage`.
 *
 * Regel: Arbeitszeiten als Text «08:00-12:00, 13:00-17:00» je Wochentag; die verbindliche Prüfung macht der Server.
 */
import { useId, useState } from 'react';
import { useCalendar, useCalendarPreview, useCalendars, useDeleteCalendar, useSaveCalendar } from './api.ts';
import { useWorkflow } from './provider.tsx';
import { DurationInput } from './steps.tsx';
import type { CalendarJson, WeekdayKey } from './types.ts';
import { Badge, fmtDateTime, MissingRight, WorkflowApiError } from './ui.tsx';

const DAYS: [WeekdayKey, string][] = [['mon', 'Montag'], ['tue', 'Dienstag'], ['wed', 'Mittwoch'], ['thu', 'Donnerstag'], ['fri', 'Freitag'], ['sat', 'Samstag'], ['sun', 'Sonntag']];
const SPAN = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/;
const pad = (t: string) => (t.length === 4 ? `0${t}` : t);

/** «08:00-12:00, 13:00-17:00» lesen; `null` bei Fehler. */
export function parseHours(text: string): [string, string][] | null {
  if (!text.trim()) return [];
  const out: [string, string][] = [];
  for (const part of text.split(',')) {
    const m = SPAN.exec(part);
    if (!m) return null;
    out.push([pad(m[1]!), pad(m[2]!)]);
  }
  return out;
}
export const formatHours = (list: [string, string][] | undefined) => (list ?? []).map(([a, b]) => `${a}-${b}`).join(', ');

export function CalendarList({ onEdit }: { onEdit?: (id: string | null) => void }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const cals = useCalendars(w.can('queue:manage'));
  if (!w.can('queue:manage')) return <MissingRight perm="queue:manage" lead="Für Kalender" />;
  const items = cals.data?.items ?? [];
  return (
    <section aria-labelledby={`${id}-h`}>
      <div className="wf-list-head">
        <h2 id={`${id}-h`}>Kalender</h2>
        {onEdit ? <ui.Button variant="primary" onClick={() => onEdit(null)}>Neuer Kalender</ui.Button> : null}
      </div>
      {cals.isPending ? <ui.Loading label="Kalender werden geladen …" /> : cals.isError ? <ui.ErrorBox error={cals.error} /> : items.length ? (
        <ul className="wf-plain" aria-label="Kalender">
          {items.map(c => (
            <li key={c.id} className="wf-row">
              {onEdit ? <button type="button" className="wf-link" onClick={() => onEdit(c.id)}>{c.name}</button> : <span>{c.name}</span>}
              <span className="wf-muted wf-small">{`${c.timezone}, ${c.holidays.length} Feiertage`}</span>
              {c.isDefault ? <Badge tone="accent">Standard</Badge> : null}
            </li>
          ))}
        </ul>
      ) : <ui.Empty title="Keine Kalender">Ohne Kalender gelten Montag bis Freitag, 08:00–17:00 (UTC), ohne Feiertage.</ui.Empty>}
    </section>
  );
}

export interface CalendarEditorProps {
  /** `null` = neuer Kalender. */
  calendarId: string | null;
  onSaved?: (c: CalendarJson) => void;
  onClose?: () => void;
}

export function CalendarEditor({ calendarId, onSaved, onClose }: CalendarEditorProps) {
  const w = useWorkflow();
  const existing = useCalendar(calendarId);
  if (!w.can('queue:manage')) return <MissingRight perm="queue:manage" lead="Zum Bearbeiten" />;
  if (calendarId && existing.isPending) return <w.ui.Loading label="Kalender wird geladen …" />;
  if (calendarId && existing.isError) return <w.ui.ErrorBox error={existing.error} />;
  return <CalendarForm key={existing.data?.revision ?? 'neu'} cal={existing.data ?? null} onSaved={onSaved} onClose={onClose} />;
}

function CalendarForm({ cal, onSaved, onClose }: { cal: CalendarJson | null; onSaved?: (c: CalendarJson) => void; onClose?: () => void }) {
  const { ui } = useWorkflow();
  const id = useId();
  const save = useSaveCalendar();
  const del = useDeleteCalendar();
  const preview = useCalendarPreview();
  const [name, setName] = useState(cal?.name ?? '');
  const [timezone, setTimezone] = useState(cal?.timezone ?? 'Europe/Zurich');
  const [isDefault, setDefault] = useState(cal?.isDefault ?? false);
  const [hours, setHours] = useState<Record<WeekdayKey, string>>(() => Object.fromEntries(DAYS.map(([k]) => [k, cal ? formatHours(cal.week[k]) : ['sat', 'sun'].includes(k) ? '' : '08:00-12:00, 13:00-17:00'])) as Record<WeekdayKey, string>);
  const [holidays, setHolidays] = useState(cal?.holidays ?? []);
  const [duration, setDuration] = useState('P1BD');
  const [msg, setMsg] = useState<string | null>(null);
  const parsed = DAYS.map(([k]) => [k, parseHours(hours[k])] as const);
  const bad = parsed.filter(([, v]) => v === null).map(([k]) => k);
  const week = Object.fromEntries(parsed.filter(([, v]) => v && v.length)) as CalendarJson['week'];
  const body = { name, timezone, week, holidays, isDefault };
  const submit = () => {
    if (bad.length || !name.trim()) return;
    save.mutate({ ...body, ...(cal ? { id: cal.id, revision: cal.revision } : {}) }, { onSuccess: c => { setMsg('Gespeichert.'); onSaved?.(c); } });
  };
  return (
    <form className="wf-form wf-editor-form" aria-labelledby={`${id}-h`} onSubmit={e => { e.preventDefault(); submit(); }}>
      <h2 id={`${id}-h`}>{cal ? `Kalender «${cal.name}»` : 'Neuer Kalender'}</h2>
      <div className="wf-row">
        <div className="wf-field">
          <label htmlFor={`${id}-n`}>Name<span className="wf-req" aria-hidden="true"> *</span></label>
          <ui.Input id={`${id}-n`} required value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="wf-field">
          <label htmlFor={`${id}-z`}>Zeitzone</label>
          <ui.Input id={`${id}-z`} value={timezone} list={`${id}-zl`} onChange={e => setTimezone(e.target.value)} />
          <datalist id={`${id}-zl`}>{['Europe/Zurich', 'Europe/Berlin', 'Europe/Vienna', 'UTC'].map(z => <option key={z} value={z} />)}</datalist>
        </div>
        <label className="wf-check-row"><ui.Input type="checkbox" checked={isDefault} onChange={e => setDefault(e.target.checked)} /> Standard für Fristen ohne eigenen Kalender</label>
      </div>
      <fieldset className="wf-field">
        <legend>Arbeitszeiten</legend>
        {DAYS.map(([k, label]) => (
          <div key={k} className="wf-row">
            <label htmlFor={`${id}-${k}`} className="wf-day">{label}</label>
            <ui.Input id={`${id}-${k}`} value={hours[k]} placeholder="frei" aria-label={`${label}: Arbeitszeiten`} aria-invalid={bad.includes(k)} aria-describedby={`${id}-wh`}
              onChange={e => setHours({ ...hours, [k]: e.target.value })} />
          </div>
        ))}
        <span id={`${id}-wh`} className="wf-hint">z. B. 08:00-12:00, 13:00-17:00; leer = kein Arbeitstag.</span>
        {bad.length ? <div className="wf-field-error" role="alert">{`Bitte als «08:00-12:00» schreiben: ${bad.map(b => DAYS.find(d => d[0] === b)![1]).join(', ')}.`}</div> : null}
      </fieldset>
      <fieldset className="wf-field">
        <legend>Feiertage</legend>
        {holidays.map((h, i) => (
          <div key={i} className="wf-row">
            <ui.Input type="date" aria-label={`Feiertag ${i + 1}: Datum`} value={h.date} onChange={e => setHolidays(holidays.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
            <ui.Input aria-label={`Feiertag ${i + 1}: Bezeichnung`} placeholder="Bezeichnung" value={h.label ?? ''} onChange={e => setHolidays(holidays.map((x, j) => (j === i ? { ...x, label: e.target.value || undefined } : x)))} />
            <ui.Button size="sm" variant="ghost" aria-label={`Feiertag ${i + 1} entfernen`} onClick={() => setHolidays(holidays.filter((_, j) => j !== i))}>✕</ui.Button>
          </div>
        ))}
        <ui.Button size="sm" onClick={() => setHolidays([...holidays, { date: '' }])}>Feiertag hinzufügen</ui.Button>
      </fieldset>
      <fieldset className="wf-field">
        <legend>Vorschau</legend>
        <div className="wf-row">
          <DurationInput label="Frist ab jetzt" value={duration} onChange={setDuration} />
          <ui.Button size="sm" disabled={!!bad.length || preview.isPending} onClick={() => preview.mutate({ duration, calendar: { timezone, week, holidays: holidays.filter(h => h.date) } })}>Berechnen</ui.Button>
        </div>
        <div role="status">{preview.data ? `Fällig am ${fmtDateTime(preview.data.dueAt)}` : null}</div>
        {preview.isError ? <ui.ErrorBox error={preview.error} /> : null}
      </fieldset>
      <div className="wf-row">
        <ui.Button type="submit" variant="primary" disabled={!!bad.length || !name.trim() || save.isPending}>{save.isPending ? 'Wird gespeichert …' : 'Speichern'}</ui.Button>
        {onClose ? <ui.Button onClick={onClose}>Schliessen</ui.Button> : null}
        {cal ? <ui.Button variant="ghost" disabled={del.isPending} onClick={() => del.mutate({ id: cal.id, revision: cal.revision }, { onSuccess: () => onClose?.() })}>Löschen</ui.Button> : null}
        <span role="status" className="wf-ok">{msg}</span>
      </div>
      {save.error instanceof WorkflowApiError && save.error.conflict ? <p className="wf-bad" role="alert">Jemand hat den Kalender inzwischen geändert. Lade neu und speichere nochmals.</p> : save.isError ? <ui.ErrorBox error={save.error} /> : null}
      {del.isError ? <ui.ErrorBox error={del.error} /> : null}
    </form>
  );
}
