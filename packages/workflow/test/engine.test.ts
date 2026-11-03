/** Engine ohne Datenbank: Bestimmen des nächsten Schritts, Grenzen, Schleifenschutz, Protokoll, Stufe-1-Prüfung. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advance, afterOutcome, definitionPath, END, END_FAILED, enter, listAt, loopBindings, stepAt, type Loops } from '../src/cursor.ts';
import {
  chainDecision, definitionChecksum, DEFAULT_LIMITS, effectiveLimits, foreachLimit, redact, stageProblems, stepLimitReached,
  type WorkflowDefinition,
} from '../src/index.ts';

const def = {
  schemaVersion: 1,
  kind: 'automation',
  trigger: { manual: {} },
  steps: [
    { id: 'a', set: { x: 1 } },
    {
      id: 'b', if: { field: 'vars.x', op: 'eq', value: 1 },
      then: [{ id: 'b1', set: { y: 1 } }, { id: 'b2', set: { y: 2 } }],
      else: [],
    },
    { id: 'c', foreach: { items: 'vars.list', as: 'item' }, steps: [{ id: 'c1', set: { z: 1 } }, { id: 'c2', end: { result: 'completed' }, onError: { then: 'path', steps: [{ id: 'c2e', set: { e: 1 } }] } }] },
    { id: 'd', action: 'x.y', onError: { then: 'path', steps: [{ id: 'd1', set: { failed: true } }] } },
  ],
  onError: { then: 'path', steps: [{ id: 'z', set: { bad: true } }] },
} as unknown as WorkflowDefinition;

test('Pfade: Schritt und Liste auflösen, Durchgang einer Schleife ausblenden', () => {
  assert.equal(stepAt(def, '/steps/1/then/1')?.id, 'b2');
  assert.equal(stepAt(def, '/steps/2/items/7/steps/0')?.id, 'c1');
  assert.equal(definitionPath('/steps/2/items/7/steps/0'), '/steps/2/steps/0');
  assert.equal(definitionPath('/steps/2/items/7/steps'), '/steps/2/steps');
  assert.equal(listAt(def, '/steps/3/onError/steps')?.[0]?.id, 'd1');
  assert.equal(stepAt(def, '/steps/9'), undefined);
  assert.equal(stepAt(def, '/steps/__proto__'), undefined);
});

test('nächster Schritt: Geschwister, Zweige, leere Zweige, Ende', () => {
  const none: Loops = {};
  assert.equal(enter(def, '/steps', none), '/steps/0');
  assert.equal(advance(def, '/steps/0', none), '/steps/1');
  assert.equal(enter(def, '/steps/1/then', none), '/steps/1/then/0');
  assert.equal(advance(def, '/steps/1/then/0', none), '/steps/1/then/1');
  assert.equal(advance(def, '/steps/1/then/1', none), '/steps/2', 'nach dem Zweig hinter dem Wenn-Schritt');
  assert.equal(enter(def, '/steps/1/else', none), '/steps/2', 'leerer Zweig');
  assert.equal(advance(def, '/steps/3', none), END);
});

test('nächster Schritt: Durchgänge einer Schleife, Fehlerpfade', () => {
  const loops: Loops = { '/steps/2': { items: ['p', 'q'], as: 'item' } };
  assert.equal(enter(def, '/steps/2/items/0/steps', loops), '/steps/2/items/0/steps/0');
  assert.equal(advance(def, '/steps/2/items/0/steps/1', loops), '/steps/2/items/1/steps/0', 'nächster Durchgang');
  assert.equal(advance(def, '/steps/2/items/1/steps/1', loops), '/steps/3', 'nach dem letzten Durchgang');
  assert.deepEqual(loopBindings('/steps/2/items/1/steps/0', loops), { item: 'q', itemIndex: 1 });
  assert.equal(advance(def, '/steps/2/items/0/steps/1/onError/steps/0', loops), '/steps/2/items/1/steps/0', 'Fehlerpfad im Durchgang, danach weiter');
  assert.equal(advance(def, '/steps/3/onError/steps/0', loops), END, 'nach dem Fehlerpfad des letzten Schritts');
  assert.equal(enter(def, '/onError/steps', loops), '/onError/steps/0');
  assert.equal(advance(def, '/onError/steps/0', loops), END_FAILED, 'Fehlerpfad der Definition endet als fehlgeschlagen');
  assert.throws(() => advance(def, '/steps/0/bogus/0', loops), /Unbekannte Liste/);
});

test('nächster Schritt: Wege nach Ergebnis, auch wenn ein Ergebnis wie eine Liste heisst', () => {
  const d = {
    schemaVersion: 2, kind: 'automation', trigger: { manual: {} },
    steps: [
      {
        id: 't', task: { title: 'x', assignee: { actor: { id: 'a', kind: 'person' } }, outcomes: ['then', 'items', 'leer'] },
        branches: { then: [{ id: 't1', set: { a: 1 } }, { id: 't2', set: { a: 2 } }], items: [{ id: 'l', foreach: { items: 'vars.list', as: 'x' }, steps: [{ id: 'l1', set: { b: 1 } }] }] },
      },
      { id: 'n', set: { c: 1 } },
    ],
  } as unknown as WorkflowDefinition;
  const none: Loops = {};
  const t = stepAt(d, '/steps/0') as Parameters<typeof afterOutcome>[2];
  assert.equal(afterOutcome(d, '/steps/0', t, 'then', none), '/steps/0/branches/then/0');
  assert.equal(afterOutcome(d, '/steps/0', t, 'leer', none), '/steps/1', 'leerer Weg: nach der Aufgabe weiter');
  assert.equal(afterOutcome(d, '/steps/0', t, 'cancelled', none), '/steps/1', 'abgebrochen: kein Weg');
  assert.equal(advance(d, '/steps/0/branches/then/0', none), '/steps/0/branches/then/1');
  assert.equal(advance(d, '/steps/0/branches/then/1', none), '/steps/1', 'nach dem Weg hinter der Aufgabe');
  assert.equal(definitionPath('/steps/0/branches/items/0/items/1/steps/0'), '/steps/0/branches/items/0/steps/0');
  const loops: Loops = { '/steps/0/branches/items/0': { items: ['p', 'q'], as: 'x' } };
  assert.equal(stepAt(d, '/steps/0/branches/items/0/items/1/steps/0')?.id, 'l1');
  assert.deepEqual(loopBindings('/steps/0/branches/items/0/items/1/steps/0', loops), { x: 'q', xIndex: 1 });
  assert.equal(advance(d, '/steps/0/branches/items/0/items/0/steps/0', loops), '/steps/0/branches/items/0/items/1/steps/0');
  assert.equal(advance(d, '/steps/0/branches/items/0/items/1/steps/0', loops), '/steps/1', 'nach Schleife und Weg');
});

test('Grenzen: Schritte je Lauf, Für-jedes, Mandant senkt nur', () => {
  assert.equal(stepLimitReached(49, DEFAULT_LIMITS), false);
  assert.equal(stepLimitReached(50, DEFAULT_LIMITS), true);
  assert.equal(foreachLimit({ foreach: {} }, DEFAULT_LIMITS), 100);
  assert.equal(foreachLimit({ foreach: { limit: 10 } }, DEFAULT_LIMITS), 10);
  assert.equal(foreachLimit({ foreach: { limit: 500 } }, DEFAULT_LIMITS), 100);
  const l = effectiveLimits(DEFAULT_LIMITS, { stepsPerRun: 10, runsPerDay: 99_999, chainDepth: 0 as number });
  assert.equal(l.stepsPerRun, 10);
  assert.equal(l.runsPerDay, DEFAULT_LIMITS.runsPerDay, 'höher als die App: Vorgabe der App');
  assert.equal(l.chainDepth, DEFAULT_LIMITS.chainDepth, 'ungültig: ignoriert');
});

test('Schleifenschutz: Kettentiefe zählt ab 1, über der Grenze kein Start', () => {
  assert.deepEqual(chainDecision(null, 5), { depth: 1, allowed: true });
  assert.deepEqual(chainDecision({ depth: 4 }, 5), { depth: 5, allowed: true });
  assert.deepEqual(chainDecision({ depth: 5 }, 5), { depth: 6, allowed: false });
});

test('Protokoll: Geheimnisse geschwärzt, gross gekürzt', () => {
  assert.deepEqual(redact({ user: 'a', password: 'x', nested: { apiKey: 'k', Authorization: 'Bearer t' }, list: [1, 2] }),
    { user: 'a', password: '[geschwärzt]', nested: { apiKey: '[geschwärzt]', Authorization: '[geschwärzt]' }, list: [1, 2] });
  const big = redact(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, 'x'.repeat(1900)]))) as { truncated: boolean; preview: string };
  assert.equal(big.truncated, true);
  assert.equal(big.preview.length, 8192);
  assert.equal(redact(undefined), null);
});

test('Prüfsumme unabhängig von der Reihenfolge der Schlüssel', () => {
  assert.equal(definitionChecksum({ a: 1, b: { c: 2, d: [1, 2] } }), definitionChecksum({ b: { d: [1, 2], c: 2 }, a: 1 }));
  assert.notEqual(definitionChecksum({ a: 1 }), definitionChecksum({ a: 2 }));
});

test('Stufe 2 führt Automationen, Aufgaben und Genehmigungen aus; Unterabläufe und Warten auf Ereignisse noch nicht', () => {
  assert.deepEqual(stageProblems(def), []);
  const later = {
    ...def,
    steps: [
      { id: 't', task: { title: 'x', assignee: { field: 'a' } } },
      { id: 'w', wait: { event: { type: 'x.y' }, timeout: 'PT1H' } },
      { id: 'i', if: { field: 'a', op: 'isSet' }, then: [{ id: 'ap', approval: { title: 'x', approvers: [{ field: 'a' }], mode: 'first' } }] },
    ],
  } as unknown as WorkflowDefinition;
  assert.deepEqual(stageProblems(later).map(p => p.path), ['/steps/1/wait/event']);
  assert.deepEqual(stageProblems({ ...def, kind: 'case' } as unknown as WorkflowDefinition).map(p => p.path), ['/kind']);
});
