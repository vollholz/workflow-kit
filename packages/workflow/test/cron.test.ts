/** Zeitpläne (Cron mit Zeitzone, auch über die Sommerzeit-Umstellung) und Dauern. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDuration, CronError, nextCronTime, parseCron, parseDuration } from '../src/index.ts';

const at = (iso: string) => new Date(iso);
const next = (cron: string, tz: string, after: string) => nextCronTime(cron, tz, at(after)).toISOString();
/** Folge der nächsten `n` Zeitpunkte. */
const series = (cron: string, tz: string, after: string, n: number) => {
  const out: string[] = [];
  let t = at(after);
  for (let i = 0; i < n; i++) { t = nextCronTime(cron, tz, t); out.push(t.toISOString()); }
  return out;
};

test('Cron lesen: Listen, Bereiche, Schritte, Namen, Sonntag 0 und 7', () => {
  const s = parseCron('*/15 8-18/2 1,15 JAN-MAR mon-fri');
  assert.deepEqual(s.minutes, [0, 15, 30, 45]);
  assert.deepEqual(s.hours, [8, 10, 12, 14, 16, 18]);
  assert.deepEqual(s.days, [1, 15]);
  assert.deepEqual(s.months, [1, 2, 3]);
  assert.deepEqual(s.weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron('0 0 * * 7').weekdays, [0]);
  assert.deepEqual(parseCron('0 0 * * 5/1').weekdays, [5, 6]);
  for (const [bad, msg] of [
    ['* * * *', /fünf Felder/], ['60 * * * *', /Minute 60/], ['* 24 * * *', /Stunde 24/], ['* * 0 * *', /Tag 0/],
    ['* * * 13 *', /Monat 13/], ['*/0 * * * *', /Schritt «0»/], ['5-1 * * * *', /absteigend/], ['x * * * *', /«x»/], ['1,,2 * * * *', /leerer Eintrag/],
  ] as const) assert.throws(() => parseCron(bad), (e: unknown) => e instanceof CronError && msg.test(e.message), bad);
});

test('nächster Zeitpunkt in UTC und in Zürich', () => {
  assert.equal(next('*/5 * * * *', 'UTC', '2026-11-02T10:02:30Z'), '2026-11-02T10:05:00.000Z');
  assert.equal(next('*/5 * * * *', 'UTC', '2026-11-02T10:05:00Z'), '2026-11-02T10:10:00.000Z', 'ausschliesslich');
  assert.equal(next('0 7 * * *', 'Europe/Zurich', '2026-11-02T10:00:00Z'), '2026-11-03T06:00:00.000Z', 'Winterzeit UTC+1');
  assert.equal(next('0 7 * * *', 'Europe/Zurich', '2026-07-01T10:00:00Z'), '2026-07-02T05:00:00.000Z', 'Sommerzeit UTC+2');
  assert.equal(next('0 9 * * MON', 'Europe/Zurich', '2026-11-02T10:00:00Z'), '2026-11-09T08:00:00.000Z', 'nächster Montag');
  assert.equal(next('0 0 29 2 *', 'UTC', '2026-03-01T00:00:00Z'), '2028-02-29T00:00:00.000Z', 'Schalttag');
  // Tag und Wochentag eingeschränkt: einer genügt (1. des Monats oder Freitag)
  assert.equal(next('0 12 1 * FRI', 'UTC', '2026-11-02T00:00:00Z'), '2026-11-06T12:00:00.000Z');
  assert.equal(next('0 12 1 * FRI', 'UTC', '2026-11-28T00:00:00Z'), '2026-12-01T12:00:00.000Z');
  assert.equal(next('30 23 * * *', 'America/New_York', '2026-11-02T00:00:00Z'), '2026-11-02T04:30:00.000Z', '1.11. 23:30 Winterzeit UTC-5');
});

test('Sommerzeit vorwärts (Zürich, 29.3.2026): fehlende Ortszeit läuft eine Stunde später, einmal', () => {
  // 02:00 → 03:00; 02:30 gibt es nicht
  assert.equal(next('30 2 * * *', 'Europe/Zurich', '2026-03-28T12:00:00Z'), '2026-03-29T01:30:00.000Z', '= 03:30 Sommerzeit');
  assert.equal(next('30 2 * * *', 'Europe/Zurich', '2026-03-29T01:30:00Z'), '2026-03-30T00:30:00.000Z', 'am Tag danach wieder 02:30');
  assert.deepEqual(series('0 * * * *', 'Europe/Zurich', '2026-03-29T00:30:00Z', 3), [
    '2026-03-29T01:00:00.000Z', // 02:00 gibt es nicht → 03:00 Sommerzeit
    '2026-03-29T02:00:00.000Z', // 04:00
    '2026-03-29T03:00:00.000Z',
  ]);
});

test('Sommerzeit zurück (Zürich, 25.10.2026): feste Zeit einmal, stündlich in beiden Durchgängen', () => {
  // 03:00 → 02:00; 02:30 gibt es zweimal (00:30Z und 01:30Z)
  assert.deepEqual(series('30 2 * * *', 'Europe/Zurich', '2026-10-24T12:00:00Z', 2), ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
  assert.deepEqual(series('30 * * * *', 'Europe/Zurich', '2026-10-24T23:00:00Z', 4), [
    '2026-10-24T23:30:00.000Z', // 01:30 Sommerzeit
    '2026-10-25T00:30:00.000Z', // 02:30 Sommerzeit
    '2026-10-25T01:30:00.000Z', // 02:30 Winterzeit (Stunde ist «*»)
    '2026-10-25T02:30:00.000Z', // 03:30 Winterzeit
  ]);
});

test('unbekannte Zeitzone', () => {
  assert.throws(() => nextCronTime('* * * * *', 'Mars/Olympus', new Date()), /unbekannte Zeitzone/);
});

test('Dauern mit Arbeitstagen', () => {
  assert.deepEqual(parseDuration('P3BD'), { years: 0, months: 0, weeks: 0, days: 0, businessDays: 3, hours: 0, businessHours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(parseDuration('PT8BH30M'), { years: 0, months: 0, weeks: 0, days: 0, businessDays: 0, hours: 0, businessHours: 8, minutes: 30, seconds: 0 });
  assert.throws(() => addDuration(at('2026-11-02T10:00:00Z'), 'PT8BH'), /brauchen einen Kalender/);
  assert.equal(addDuration(at('2026-11-02T10:00:00Z'), 'PT4H').toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(addDuration(at('2026-11-02T10:00:00Z'), 'P1DT30M').toISOString(), '2026-11-03T10:30:00.000Z');
  assert.equal(addDuration(at('2026-11-05T10:00:00Z'), 'P3BD').toISOString(), '2026-11-10T10:00:00.000Z', 'Do + 3 Arbeitstage = Di');
  assert.equal(addDuration(at('2026-01-31T00:00:00Z'), 'P1M').toISOString(), '2026-03-03T00:00:00.000Z');
  assert.throws(() => parseDuration('P'), /Ungültige Dauer/);
  assert.throws(() => parseDuration('4h'), /Ungültige Dauer/);
});
