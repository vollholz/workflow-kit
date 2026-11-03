/** Reine Regeln der Stufe 2: Genehmigungsarten, Round Robin und geringste Last, Priorität, Formulare, Definition. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FormChecker, actorFrom, approvalOutcome, leastLoaded, nextRoundRobin, raisePriority, validateDefinition, type ActorRef, type Decision,
} from '../src/index.ts';

const votes = (...d: Decision[]) => d.map(decision => ({ decision }));
const p = (id: string): ActorRef => ({ id, kind: 'person' });

test('Genehmigungsarten: first, all, sequential, majority', () => {
  assert.equal(approvalOutcome('first', 3, []), null);
  assert.equal(approvalOutcome('first', 3, votes('rejected')), 'rejected');
  assert.equal(approvalOutcome('first', 3, votes('approved')), 'approved');
  assert.equal(approvalOutcome('all', 3, votes('approved', 'approved')), null);
  assert.equal(approvalOutcome('all', 3, votes('approved', 'approved', 'approved')), 'approved');
  assert.equal(approvalOutcome('all', 3, votes('approved', 'rejected')), 'rejected', 'eine Ablehnung genügt');
  assert.equal(approvalOutcome('sequential', 2, votes('approved')), null);
  assert.equal(approvalOutcome('sequential', 2, votes('rejected')), 'rejected');
  assert.equal(approvalOutcome('majority', 3, votes('approved')), null);
  assert.equal(approvalOutcome('majority', 3, votes('approved', 'approved')), 'approved', '2 von 3');
  assert.equal(approvalOutcome('majority', 3, votes('rejected', 'rejected')), 'rejected', 'Mehrheit nicht mehr erreichbar');
  assert.equal(approvalOutcome('majority', 4, votes('approved', 'approved', 'rejected')), null, '2 von 4 ist keine Mehrheit');
  assert.equal(approvalOutcome('majority', 4, votes('approved', 'rejected', 'rejected')), 'rejected', 'Mehrheit nicht mehr erreichbar');
  assert.equal(approvalOutcome('majority', 4, votes('approved', 'approved', 'approved')), 'approved');
  assert.equal(approvalOutcome('majority', 1, votes('approved')), 'approved');
});

test('Round Robin in fester Reihenfolge, geringste Last mit Round Robin bei Gleichstand', () => {
  const team = [p('carl'), p('ada'), p('bea'), p('ada')];
  assert.deepEqual(nextRoundRobin(team, null), p('ada'));
  assert.deepEqual(nextRoundRobin(team, 'person:ada'), p('bea'));
  assert.deepEqual(nextRoundRobin(team, 'person:carl'), p('ada'), 'wieder von vorn');
  assert.deepEqual(nextRoundRobin(team, 'person:weg'), p('ada'), 'unbekannter Zeiger');
  assert.equal(nextRoundRobin([], null), null);
  const load: Record<string, number> = { ada: 2, bea: 1, carl: 1 };
  assert.deepEqual(leastLoaded(team, a => load[a.id] ?? 0, null), p('bea'));
  assert.deepEqual(leastLoaded(team, a => load[a.id] ?? 0, 'person:bea'), p('carl'), 'Gleichstand: nächste nach dem Zeiger');
  assert.deepEqual(leastLoaded(team, () => 0, 'person:ada'), p('bea'));
});

test('Priorität und Akteur aus Feldwerten', () => {
  assert.deepEqual(['low', 'normal', 'high', 'urgent'].map(x => raisePriority(x as 'low')), ['normal', 'high', 'urgent', 'urgent']);
  assert.deepEqual(actorFrom('ada'), p('ada'));
  assert.deepEqual(actorFrom({ id: 'bot', kind: 'client' }), { id: 'bot', kind: 'client' });
  assert.equal(actorFrom(''), null);
  assert.equal(actorFrom(42), null);
});

test('Formulare serverseitig: Pflicht, Arten, Auswahl, Liste, Feldarten der App, unbekannte Felder', () => {
  const f = new FormChecker([{ key: 'branch', label: 'Filiale', valueSchema: { type: 'string', enum: ['zurich', 'bern'] } }]);
  const fields = [
    { key: 'note', label: 'Notiz', type: 'text', required: true },
    { key: 'n', label: 'Anzahl', type: 'number' },
    { key: 'd', label: 'Datum', type: 'date' },
    { key: 'c', label: 'Wahl', type: 'choice', options: [{ value: 'a', label: 'A' }], multiple: true },
    { key: 'who', label: 'Person', type: 'actor' },
    { key: 'ok', label: 'Ja/Nein', type: 'boolean', required: true },
    { key: 'b', label: 'Filiale', type: 'branch' },
    { key: 'n2', label: 'Leer', type: 'number' },
  ];
  const good = f.check(fields, { note: 'x', n: 2, d: '2026-11-03', c: ['a'], who: 'ada', ok: false, b: 'bern', n2: undefined } as Record<string, unknown>);
  assert.deepEqual(good, { ok: true, values: { note: 'x', n: 2, d: '2026-11-03', c: ['a'], who: { id: 'ada', kind: 'person' }, ok: false, b: 'bern' } });
  const bad = f.check(fields, { n: 'zwei', d: '3.11.2026', c: 'a', ok: true, b: 'genf', x: 1 });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual(bad.errors.map(e => e.key), ['x', 'note', 'n', 'd', 'c', 'b']);
    assert.equal(bad.errors[1]!.message, '«Notiz» ist Pflicht');
  }
  assert.deepEqual(f.check([{ key: 'u', label: 'U', type: 'unbekannt' }], { u: 1 }), { ok: false, errors: [{ key: 'u', message: '«U»: Unbekannte Feldart «unbekannt»' }] });
  assert.equal(f.check([], []).ok, false);
});

test('Definition: Warteschlange als Zuständige, Arbeitsstunden, Eskalation, Prüfung der Formulare', () => {
  const def = (task: Record<string, unknown>) => ({ schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 't', task: { title: 'x', ...task } }] });
  const q = '0b8f2e4a-7c3d-4e5f-9a1b-2c3d4e5f6a7b';
  assert.deepEqual(validateDefinition(def({ assignee: { queue: q }, due: 'PT8BH', escalation: { raisePriority: true, queue: q, notify: [{ team: { type: 'role', id: 'lead' } }] } })).errors, []);
  assert.deepEqual(validateDefinition(def({ assignee: { queue: 'nein' } })).errors.map(e => e.path), ['/steps/0/task/assignee/queue']);
  assert.deepEqual(validateDefinition(def({ assignee: { actor: { id: 'a', kind: 'person' } }, due: 'PT8BX' })).errors.map(e => e.path), ['/steps/0/task/due']);
  const content = validateDefinition(def({
    assignee: { field: 'subject.values.owner' }, outcomes: ['ok', 'ok', 'cancelled'],
    form: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'A2', type: 'text' }, { key: 'c', label: 'Wahl', type: 'choice' }],
  }));
  assert.deepEqual(content.errors.map(e => e.path), ['/steps/0/task/form/1/key', '/steps/0/task/form/2/options', '/steps/0/task/outcomes/1', '/steps/0/task/outcomes/2']);
  const approval = { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 'g', approval: { title: 'x', approvers: [{ queue: q }], mode: 'majority', priority: 'high', reasonOnReject: false } }] };
  assert.deepEqual(validateDefinition(approval).errors, []);
});
