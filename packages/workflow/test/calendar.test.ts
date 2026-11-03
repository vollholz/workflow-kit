/** Arbeitszeitkalender: Arbeitsstunden und -tage über Wochenende, Feiertage, Mittag und Sommerzeitwechsel (Abnahme 15). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addWorkingTime, calendarProblems, DEFAULT_WORK_CALENDAR, isWorkingTime, type WorkCalendar } from '../src/index.ts';

const office = (holidays: string[] = []): WorkCalendar => {
  const day: [string, string][] = [['08:00', '12:00'], ['13:00', '17:00']];
  return { timezone: 'Europe/Zurich', week: { mon: day, tue: day, wed: day, thu: day, fri: day }, holidays: holidays.map(date => ({ date })) };
};
const due = (cal: WorkCalendar, from: string, d: string) => addWorkingTime(cal, new Date(from), d).toISOString();

test('Arbeitsstunden über das Wochenende und einen Feiertag', () => {
  // Freitag 15:00 (MEZ = UTC+1): 2 h bis Feierabend, 2 h am Montag → Montag 10:00
  assert.equal(due(office(), '2026-11-06T14:00:00Z', 'PT4BH'), '2026-11-09T09:00:00.000Z');
  assert.equal(due(office(['2026-11-09']), '2026-11-06T14:00:00Z', 'PT4BH'), '2026-11-10T09:00:00.000Z', 'Montag Feiertag → Dienstag');
  // Weihnachten (Freitag) fällt weg: Donnerstag 16:00 + 2 h → Montag 09:00
  assert.equal(due(office(['2026-12-25']), '2026-12-24T15:00:00Z', 'PT2BH'), '2026-12-28T08:00:00.000Z');
  assert.equal(due(office(), '2026-11-09T05:00:00Z', 'PT1BH'), '2026-11-09T08:00:00.000Z', 'vor Arbeitsbeginn: ab 08:00');
  assert.equal(due(office(), '2026-11-09T10:30:00Z', 'PT1BH'), '2026-11-09T12:30:00.000Z', 'über den Mittag');
  assert.equal(due(office(), '2026-11-09T10:30:00Z', 'PT8BH'), '2026-11-10T10:30:00.000Z', 'ein ganzer Arbeitstag');
});

test('Arbeitstage: gleiche Uhrzeit n Arbeitstage später, Feiertage zählen nicht', () => {
  assert.equal(due(office(), '2026-11-05T09:00:00Z', 'P3BD'), '2026-11-10T09:00:00.000Z', 'Do 10:00 + 3 = Di 10:00');
  assert.equal(due(office(['2026-11-09']), '2026-11-05T09:00:00Z', 'P3BD'), '2026-11-11T09:00:00.000Z', 'mit Feiertag Mi');
  assert.equal(due(office(), '2026-11-06T17:00:00Z', 'P1BD'), '2026-11-10T07:00:00.000Z', 'Fr 18:00 → Mo 08:00 → Di 08:00');
  assert.equal(due(office(), '2026-11-05T11:30:00Z', 'P1BD'), '2026-11-06T12:00:00.000Z', 'Mittag → 13:00 am nächsten Tag');
  assert.equal(due(office(), '2026-11-07T10:00:00Z', 'P1BDT2BH'), '2026-11-10T09:00:00.000Z', 'Sa → Mo 08:00 → Di 08:00 + 2 h');
});

test('Sommerzeitwechsel: echte Zeitpunkte, Zeitfenster wird kürzer oder länger', () => {
  // Fr 27.3. 16:00 MEZ + 2 h → Mo 30.3. 09:00 MESZ (UTC+2)
  assert.equal(due(office(), '2026-03-27T15:00:00Z', 'PT2BH'), '2026-03-30T07:00:00.000Z');
  const night: WorkCalendar = { timezone: 'Europe/Zurich', week: { sun: [['00:00', '06:00']] }, holidays: [] };
  // 29.3.: 02:00–03:00 fehlt, das Fenster dauert 5 h; 00:00 MEZ + 4 h = 05:00 MESZ
  assert.equal(due(night, '2026-03-28T23:00:00Z', 'PT4BH'), '2026-03-29T03:00:00.000Z');
  assert.equal(due(night, '2026-03-28T23:00:00Z', 'PT6BH'), '2026-04-04T23:00:00.000Z', '5 h am 29.3., 1 h am 5.4. (MESZ)');
  // 25.10.: 02:00–03:00 doppelt, das Fenster dauert 7 h; 00:00 MESZ + 4 h = 03:00 MEZ
  assert.equal(due(night, '2026-10-24T22:00:00Z', 'PT4BH'), '2026-10-25T02:00:00.000Z');
});

test('Kalenderteile ohne Arbeitszeit; Vorgabe ohne eigenen Kalender', () => {
  assert.equal(due(office(), '2026-11-07T10:00:00Z', 'PT4H'), '2026-11-07T14:00:00.000Z', 'Samstag + 4 h bleibt Samstag');
  assert.equal(due(DEFAULT_WORK_CALENDAR, '2026-11-07T10:00:00Z', 'P1BD'), '2026-11-10T08:00:00.000Z', 'Sa → Mo 08:00 UTC → Di 08:00');
  assert.equal(due(DEFAULT_WORK_CALENDAR, '2026-11-09T16:00:00Z', 'PT2BH'), '2026-11-10T09:00:00.000Z');
  assert.equal(isWorkingTime(office(), new Date('2026-11-09T09:00:00Z')), true);
  assert.equal(isWorkingTime(office(), new Date('2026-11-09T11:30:00Z')), false, 'Mittag');
  assert.equal(isWorkingTime(office(['2026-11-09']), new Date('2026-11-09T09:00:00Z')), false, 'Feiertag');
});

test('Prüfung des Kalenders mit deutschen Meldungen', () => {
  assert.deepEqual(calendarProblems(office()), []);
  const bad: WorkCalendar = {
    timezone: 'Mars/Olympus', holidays: [{ date: '2026-02-30' }, { date: '2026-12-25' }, { date: '2026-12-25' }],
    week: { mon: [['09:00', '08:00']], tue: [['08:00', '12:00'], ['11:00', '13:00']], wed: [['8:00', '12:00']] },
  };
  assert.deepEqual(calendarProblems(bad).map(p => p.path), [
    '/timezone', '/week/mon/0', '/week/tue/1', '/week/wed/0', '/holidays/0/date', '/holidays/2/date',
  ]);
  assert.deepEqual(calendarProblems({ timezone: 'UTC', week: {}, holidays: [] }), [{ path: '/week', message: 'Mindestens ein Zeitfenster mit Arbeitszeit' }]);
  assert.throws(() => addWorkingTime({ timezone: 'UTC', week: {}, holidays: [] }, new Date(), 'PT1BH'), /Kalender ungültig/);
});
