/**
 * Arbeitszeitkalender für Fristen (SLA, Konzept 4.6): Zeitzone, Arbeitszeiten je Wochentag und Feiertage. Rein und
 * ohne Abhängigkeit; Ortszeiten über `Intl` (`cron.ts`), damit Sommerzeitwechsel stimmen.
 *
 * Regeln (getestet in `calendar.test.ts`):
 * - Kalenderteile einer Dauer (`P1D`, `PT4H` …) laufen wie bei `addDuration` ohne Rücksicht auf Arbeitszeit.
 * - Arbeitsstunden (`PT8BH`) zählen nur Zeit in den Arbeitszeiten, Feiertage und Tage ohne Arbeitszeit fallen weg.
 *   Gerechnet wird mit echten Zeitpunkten: Fällt ein Sommerzeitwechsel in eine Arbeitszeit, ist sie eine Stunde kürzer
 *   oder länger.
 * - Arbeitstage (`P3BD`): Zuerst zum nächsten Zeitpunkt in der Arbeitszeit (z. B. Freitag 18:00 → Montag 08:00), dann n
 *   Arbeitstage weiter zur gleichen Uhrzeit; liegt sie dort ausserhalb der Arbeitszeit, gilt der nächste Beginn bzw. das
 *   Ende des Tages.
 * - Reihenfolge bei gemischten Dauern: Kalenderteile, dann Arbeitstage, dann Arbeitsstunden.
 * - Ohne eigenen Kalender gilt `DEFAULT_WORK_CALENDAR` (Montag–Freitag 08:00–17:00 UTC, ohne Feiertage).
 */
import { addDurationParts, CronError, instantsOf, isValidTimeZone, localOf, parseDuration } from './cron.ts';

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** Arbeitszeiten: je Wochentag Zeitfenster `[«HH:MM», «HH:MM»]` (Ende ausschliesslich, «24:00» erlaubt). */
export type WorkWeek = Partial<Record<WeekdayKey, [string, string][]>>;

export interface Holiday { date: string; label?: string }

export interface WorkCalendar {
  /** IANA-Zeitzone, z. B. `Europe/Zurich`. */
  timezone: string;
  week: WorkWeek;
  holidays: Holiday[];
}

/** Vorgabe ohne eigenen Kalender. */
const OFFICE: [string, string][] = [['08:00', '17:00']];
export const DEFAULT_WORK_CALENDAR: Readonly<WorkCalendar> = Object.freeze({
  timezone: 'UTC',
  week: { mon: OFFICE, tue: OFFICE, wed: OFFICE, thu: OFFICE, fri: OFFICE },
  holidays: [],
});

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** So weit sucht die Rechnung nach Arbeitszeit (gut zehn Jahre). */
const MAX_DAYS = 3700;

const minutesOf = (t: string) => (t === '24:00' ? 1440 : Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));

/** Meldungen zu einem Kalender (leer = gültig), Pfade als JSON Pointer. */
export function calendarProblems(c: WorkCalendar): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (!c || typeof c !== 'object') return [{ path: '/', message: 'Kalender fehlt' }];
  if (typeof c.timezone !== 'string' || !isValidTimeZone(c.timezone)) out.push({ path: '/timezone', message: `Unbekannte Zeitzone «${String(c.timezone)}»` });
  let any = false;
  for (const [key, list] of Object.entries(c.week ?? {})) {
    if (!(WEEKDAY_KEYS as readonly string[]).includes(key)) { out.push({ path: `/week/${key}`, message: `Unbekannter Wochentag «${key}»` }); continue; }
    if (!Array.isArray(list)) { out.push({ path: `/week/${key}`, message: 'Erwartet: Liste von Zeitfenstern' }); continue; }
    let last = -1;
    for (const [i, w] of list.entries()) {
      const at = `/week/${key}/${i}`;
      if (!Array.isArray(w) || w.length !== 2 || !TIME.test(String(w[0])) || !TIME.test(String(w[1]))) { out.push({ path: at, message: 'Zeitfenster als [«HH:MM», «HH:MM»]' }); continue; }
      const [a, b] = [minutesOf(w[0]), minutesOf(w[1])];
      if (a >= b) out.push({ path: at, message: `Beginn ${w[0]} liegt nicht vor dem Ende ${w[1]}` });
      else if (a < last) out.push({ path: at, message: 'Zeitfenster überschneiden sich oder sind nicht aufsteigend' });
      else any = true;
      last = Math.max(last, b);
    }
  }
  if (!any) out.push({ path: '/week', message: 'Mindestens ein Zeitfenster mit Arbeitszeit' });
  const seen = new Set<string>();
  for (const [i, h] of (c.holidays ?? []).entries()) {
    const m = h && typeof h.date === 'string' ? DATE.exec(h.date) : null;
    const valid = m && new Date(`${h.date}T00:00:00Z`).toISOString().slice(0, 10) === h.date;
    if (!valid) out.push({ path: `/holidays/${i}/date`, message: `Ungültiges Datum «${String(h?.date)}» (JJJJ-MM-TT)` });
    else if (seen.has(h.date)) out.push({ path: `/holidays/${i}/date`, message: `Feiertag ${h.date} kommt mehrfach vor` });
    else seen.add(h.date);
  }
  return out;
}

interface Day { y: number; mo: number; d: number; wd: number; key: string }

function dayAt(utcMidnight: number): Day {
  const x = new Date(utcMidnight);
  const y = x.getUTCFullYear(), mo = x.getUTCMonth() + 1, d = x.getUTCDate();
  return { y, mo, d, wd: x.getUTCDay(), key: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** Zeitpunkt einer Ortszeit (Minuten ab Mitternacht, 1440 = Mitternacht des Folgetags). */
function instant(day: Day, minutes: number, tz: string): number {
  if (minutes >= 1440) return instant(dayAt(Date.UTC(day.y, day.mo - 1, day.d) + DAY_MS), minutes - 1440, tz);
  return instantsOf({ y: day.y, mo: day.mo, d: day.d, h: Math.floor(minutes / 60), mi: minutes % 60 }, tz).times[0]!;
}

class Calc {
  private readonly holidays: Set<string>;
  private readonly windows: Map<number, [number, number][]>;
  readonly cal: WorkCalendar;
  constructor(cal: WorkCalendar) {
    this.cal = cal;
    const problems = calendarProblems(cal);
    if (problems.length) throw new CronError(`Kalender ungültig: ${problems.map(p => `${p.path}: ${p.message}`).join('; ')}`);
    this.holidays = new Set((cal.holidays ?? []).map(h => h.date));
    this.windows = new Map(WEEKDAY_KEYS.map((k, i) => [i, (cal.week[k] ?? []).map(([a, b]): [number, number] => [minutesOf(a), minutesOf(b)])]));
  }

  /** Zeitfenster eines Tags in Minuten (leer an Feiertagen). */
  minutes(day: Day): [number, number][] {
    return this.holidays.has(day.key) ? [] : this.windows.get(day.wd) ?? [];
  }

  /** Zeitfenster eines Tags als Zeitpunkte (UTC, ms). */
  windowsOn(day: Day): [number, number][] {
    return this.minutes(day).map(([a, b]) => [instant(day, a, this.cal.timezone), instant(day, b, this.cal.timezone)]);
  }

  /** Tage ab dem Ortsdatum von `t`. */
  *days(t: number): Generator<Day> {
    const l = localOf(t, this.cal.timezone);
    const start = Date.UTC(l.y, l.mo - 1, l.d) - DAY_MS; // Vortag: Fenster bis nach Mitternacht
    for (let i = 0; i < MAX_DAYS; i++) yield dayAt(start + i * DAY_MS);
    throw new CronError('Kalender: keine Arbeitszeit in den nächsten zehn Jahren');
  }

  /** Nächster Zeitpunkt in der Arbeitszeit ab `t` (einschliesslich). */
  nextWorking(t: number): number {
    for (const day of this.days(t)) for (const [s, e] of this.windowsOn(day)) if (t < e) return Math.max(s, t);
    throw new CronError('Kalender: keine Arbeitszeit gefunden');
  }

  addMinutes(t: number, minutes: number): number {
    let left = minutes * 60_000;
    if (left <= 0) return t;
    for (const day of this.days(t)) {
      for (const [s, e] of this.windowsOn(day)) {
        const from = Math.max(s, t);
        if (from >= e) continue;
        if (left <= e - from) return from + left;
        left -= e - from;
      }
    }
    throw new CronError('Kalender: keine Arbeitszeit gefunden');
  }

  addDays(t: number, n: number): number {
    if (n <= 0) return t;
    const start = this.nextWorking(t);
    const l = localOf(start, this.cal.timezone);
    const clock = l.h * 60 + l.mi;
    const startKey = `${l.y}-${String(l.mo).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`;
    let count = 0;
    let passed = false;
    for (const day of this.days(start)) {
      if (!passed) { passed = day.key === startKey; continue; } // erst die Tage nach dem Start zählen
      const windows = this.minutes(day);
      if (!windows.length) continue;
      if (++count < n) continue;
      let at = windows[windows.length - 1]![1];
      for (const [a, b] of windows) {
        if (clock < a) { at = a; break; }
        if (clock < b) { at = clock; break; }
      }
      // Sekunden des Starts bleiben erhalten (Ortszeit ohne Sekunden)
      return instant(day, at, this.cal.timezone) + (at === clock ? start % 60_000 : 0);
    }
    throw new CronError('Kalender: keine Arbeitszeit gefunden');
  }
}

/**
 * Dauer nach Arbeitszeit des Kalenders zu `from` addieren (Frist einer Aufgabe). Ohne Arbeitszeitteile (`BD`, `BH`)
 * wie `addDuration`.
 */
export function addWorkingTime(cal: WorkCalendar, from: Date, duration: string): Date {
  const p = parseDuration(duration);
  let t = addDurationParts(from, { ...p, businessDays: 0, businessHours: 0 }).getTime();
  if (!p.businessDays && !p.businessHours) return new Date(t);
  const c = new Calc(cal);
  if (p.businessDays) t = c.addDays(t, p.businessDays);
  if (p.businessHours) t = c.addMinutes(t, p.businessHours * 60);
  return new Date(t);
}

/** Liegt `at` in der Arbeitszeit des Kalenders? */
export function isWorkingTime(cal: WorkCalendar, at: Date): boolean {
  const c = new Calc(cal);
  return c.nextWorking(at.getTime()) === at.getTime();
}
