/**
 * Zeitpläne und Dauern ohne Abhängigkeit: Cron mit fünf Feldern und Zeitzone (über `Intl`), Dauern nach ISO 8601 mit
 * Arbeitstagen (`P3BD`).
 *
 * Cron: `Minute Stunde Tag Monat Wochentag` mit `*`, Listen (`1,15`), Bereichen (`1-5`), Schritten (`*\/15`, `8-18/2`)
 * und Namen (`JAN`–`DEC`, `SUN`–`SAT`; Wochentag 0 und 7 = Sonntag). Sind Tag und Wochentag beide eingeschränkt, genügt
 * einer von beiden (wie bei Vixie-Cron).
 *
 * Sommerzeit (Regeln, getestet):
 * - Eine Ortszeit, die es nicht gibt (Umstellung vorwärts), läuft um die Länge der Lücke später (02:30 → 03:30).
 * - Eine doppelte Ortszeit (Umstellung zurück) läuft einmal, beim ersten Mal; nur wenn die Stunde `*` ist, laufen die
 *   Minuten der wiederholten Stunde nochmals (wie cronie bei Platzhaltern).
 *
 * Dauern: `P1Y2M3W4DT5H6M7S`, dazu Arbeitstage `nBD` (Montag–Freitag in UTC; Feiertage und Kalender folgen mit den
 * Fristen in Stufe 2). Fehler werfen `CronError` mit deutscher Meldung.
 */

export class CronError extends Error {
  override name = 'CronError';
}

export interface CronSchedule {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  /** Tag eingeschränkt (nicht `*`). */
  daysRestricted: boolean;
  /** Wochentag eingeschränkt (nicht `*`). */
  weekdaysRestricted: boolean;
  /** Stunde ist `*`: wiederholte Stunde bei der Umstellung zurück läuft nochmals. */
  everyHour: boolean;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const FIELDS = [
  { name: 'Minute', min: 0, max: 59 },
  { name: 'Stunde', min: 0, max: 23 },
  { name: 'Tag', min: 1, max: 31 },
  { name: 'Monat', min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: 'Wochentag', min: 0, max: 7, names: WEEKDAYS, offset: 0 },
] as const;

function parseField(text: string, f: (typeof FIELDS)[number]): number[] {
  const out = new Set<number>();
  const num = (s: string): number => {
    const upper = s.toUpperCase();
    if ('names' in f) {
      const i = (f.names as readonly string[]).indexOf(upper);
      if (i >= 0) return i + f.offset;
    }
    if (!/^\d+$/.test(s)) throw new CronError(`Zeitplan: «${s}» ist kein gültiger Wert für ${f.name}`);
    const n = Number(s);
    if (n < f.min || n > f.max) throw new CronError(`Zeitplan: ${f.name} ${n} liegt nicht zwischen ${f.min} und ${f.max}`);
    return n;
  };
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`Zeitplan: leerer Eintrag bei ${f.name}`);
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`Zeitplan: «${part}» hat mehr als einen Schritt`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || step < 1)) throw new CronError(`Zeitplan: Schritt «${stepText}» bei ${f.name} ungültig`);
    let lo: number, hi: number;
    if (range === '*') { lo = f.min; hi = f.max === 7 ? 6 : f.max; }
    else if (range!.includes('-')) {
      const [a, b] = range!.split('-');
      lo = num(a!); hi = num(b!);
      if (lo > hi) throw new CronError(`Zeitplan: Bereich «${range}» bei ${f.name} ist absteigend`);
    } else {
      lo = num(range!);
      hi = stepText === undefined ? lo : (f.max === 7 ? 6 : f.max);
    }
    for (let v = lo; v <= hi; v += step) out.add(f.max === 7 && v === 7 ? 0 : v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Cron-Ausdruck mit fünf Feldern lesen. */
export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('Zeitplan: fünf Felder erwartet (Minute Stunde Tag Monat Wochentag)');
  const [mi, h, d, mo, wd] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [number[], number[], number[], number[], number[]];
  return {
    minutes: mi, hours: h, days: d, months: mo, weekdays: wd,
    daysRestricted: parts[2] !== '*', weekdaysRestricted: parts[4] !== '*', everyHour: parts[1] === '*',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Zeitzonen über Intl

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Prüft, ob eine Zeitzone bekannt ist (IANA-Name). */
export function isValidTimeZone(tz: string): boolean {
  try { formatter(tz); return true; } catch { return false; }
}

interface Local { y: number; mo: number; d: number; h: number; mi: number }

function localOf(t: number, tz: string): Local {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}

/** Abstand der Ortszeit zu UTC in ms zum Zeitpunkt `t`. */
function offsetAt(t: number, tz: string): number {
  const l = localOf(t, tz);
  const s = new Date(t).getUTCSeconds();
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, s) - (t - (t % 1000));
}

/** Zeitpunkte (UTC, ms) einer Ortszeit: einer, zwei (doppelt) oder bei einer Lücke der um die Lücke verschobene. */
function instantsOf(l: Local, tz: string): { times: number[]; gap: boolean } {
  const guess = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  const offsets = new Set([offsetAt(guess - 86_400_000, tz), offsetAt(guess, tz), offsetAt(guess + 86_400_000, tz)]);
  const times: number[] = [];
  for (const o of offsets) {
    const t = guess - o;
    const back = localOf(t, tz);
    if (back.y === l.y && back.mo === l.mo && back.d === l.d && back.h === l.h && back.mi === l.mi) times.push(t);
  }
  if (times.length) return { times: [...new Set(times)].sort((a, b) => a - b), gap: false };
  return { times: [guess - offsetAt(guess - 86_400_000, tz)], gap: true };
}

const MAX_DAYS = 366 * 8 + 2;

/** Nächster Zeitpunkt nach `after` (ausschliesslich), an dem der Zeitplan in der Zeitzone fällig ist. */
export function nextCronTime(schedule: CronSchedule | string, timeZone: string, after: Date): Date {
  const s = typeof schedule === 'string' ? parseCron(schedule) : schedule;
  if (!isValidTimeZone(timeZone)) throw new CronError(`Zeitplan: unbekannte Zeitzone «${timeZone}»`);
  const afterMs = after.getTime();
  const start = localOf(afterMs, timeZone);
  let day = Date.UTC(start.y, start.mo - 1, start.d);
  for (let i = 0; i < MAX_DAYS; i++, day += 86_400_000) {
    const date = new Date(day);
    const y = date.getUTCFullYear(), mo = date.getUTCMonth() + 1, d = date.getUTCDate(), wd = date.getUTCDay();
    if (!s.months.includes(mo)) continue;
    const dayOk = s.days.includes(d), wdOk = s.weekdays.includes(wd);
    const match = s.daysRestricted && s.weekdaysRestricted ? dayOk || wdOk : s.daysRestricted ? dayOk : s.weekdaysRestricted ? wdOk : true;
    if (!match) continue;
    // Ortszeiten aufsteigend; zwei Stunden Spielraum für die Umstellung, sonst genügt der erste Treffer
    const startMinute = i === 0 ? start.h * 60 + start.mi - 120 : -1;
    let best: number | null = null, bestMinute = 0;
    outer: for (const h of s.hours) {
      for (const mi of s.minutes) {
        const minute = h * 60 + mi;
        if (minute < startMinute) continue;
        if (best !== null && minute > bestMinute + 120) break outer;
        const { times, gap } = instantsOf({ y, mo, d, h, mi }, timeZone);
        const candidates = gap || s.everyHour ? times : times.slice(0, 1);
        for (const t of candidates) if (t > afterMs && (best === null || t < best)) { best = t; bestMinute = minute; }
      }
    }
    if (best !== null) return new Date(best);
  }
  throw new CronError('Zeitplan: kein Zeitpunkt in den nächsten acht Jahren');
}

// ---------------------------------------------------------------------------------------------------------------
// Dauern

export interface DurationParts { years: number; months: number; weeks: number; days: number; businessDays: number; hours: number; minutes: number; seconds: number }

const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+B?D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

/** Dauer nach ISO 8601 (mit Arbeitstagen `BD`) lesen. */
export function parseDuration(text: string): DurationParts {
  const m = DURATION.exec(text);
  if (!m) throw new CronError(`Ungültige Dauer «${text}» (z. B. «PT4H», «P2D», «P3BD»)`);
  const n = (v: string | undefined) => (v ? Number.parseInt(v, 10) : 0);
  const dayPart = m[4] ?? '';
  return {
    years: n(m[1]), months: n(m[2]), weeks: n(m[3]),
    days: dayPart.includes('B') ? 0 : n(dayPart), businessDays: dayPart.includes('B') ? n(dayPart) : 0,
    hours: n(m[6]), minutes: n(m[7]), seconds: n(m[8]),
  };
}

/** Dauer zu einem Zeitpunkt addieren (Kalenderteile in UTC, Arbeitstage Montag–Freitag). */
export function addDuration(from: Date, text: string): Date {
  const p = parseDuration(text);
  const d = new Date(from.getTime());
  if (p.years) d.setUTCFullYear(d.getUTCFullYear() + p.years);
  if (p.months) d.setUTCMonth(d.getUTCMonth() + p.months);
  if (p.weeks || p.days) d.setUTCDate(d.getUTCDate() + p.weeks * 7 + p.days);
  for (let left = p.businessDays; left > 0;) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return new Date(d.getTime() + ((p.hours * 60 + p.minutes) * 60 + p.seconds) * 1000);
}
