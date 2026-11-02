/** Bedingungen und Platzhalter ohne Skripte. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCondition, ExpressionError, renderTemplate, resolvePath, resolveValue, templateProblems, type Condition } from '../src/index.ts';

const ctx = {
  subject: { title: 'Bestellung 42', values: { total: 1234.5, owner: { id: 'p-7', label: 'Anna Muster' }, tags: ['eilig', 'neu'], note: '', due: '2026-11-02T09:30:00Z' } },
  steps: { s2: { outcome: 'approved' } },
  vars: { limit: 1000, list: [1, 2, 3] },
};

test('Pfade: verschachtelt, Listen, nur eigene Eigenschaften', () => {
  assert.equal(resolvePath(ctx, 'subject.values.total'), 1234.5);
  assert.equal(resolvePath(ctx, 'subject.values.tags.1'), 'neu');
  assert.equal(resolvePath(ctx, 'subject.missing.deep'), undefined);
  assert.equal(resolvePath(ctx, 'subject.title.length'), undefined, 'keine Eigenschaften von Text');
  assert.equal(resolvePath(ctx, 'vars.list.toString'), undefined, 'keine geerbten Eigenschaften');
  assert.throws(() => resolvePath(ctx, 'subject.__proto__'), ExpressionError);
  assert.throws(() => resolvePath(ctx, 'constructor.name'), ExpressionError);
  assert.throws(() => resolvePath(ctx, 'a[0]'), ExpressionError);
});

test('Bedingungen: Vergleiche', () => {
  const c = (cond: Condition) => evaluateCondition(cond, ctx);
  assert.equal(c({ field: 'steps.s2.outcome', op: 'eq', value: 'approved' }), true);
  assert.equal(c({ field: 'steps.s2.outcome', op: 'ne', value: 'approved' }), false);
  assert.equal(c({ field: 'subject.values.total', op: 'gt', value: 1000 }), true);
  assert.equal(c({ field: 'subject.values.total', op: 'gt', value: '{{vars.limit}}' }), true, 'Wert aus Platzhalter');
  assert.equal(c({ field: 'subject.values.total', op: 'lte', value: 1000 }), false);
  assert.equal(c({ field: 'subject.values.total', op: 'gt', value: 'viel' }), false, 'Zahl und Text sind nicht vergleichbar');
  assert.equal(c({ field: 'subject.values.due', op: 'lt', value: '2026-12-01' }), true, 'ISO-Datum als Text');
  assert.equal(c({ field: 'steps.s2.outcome', op: 'in', value: ['approved', 'rejected'] }), true);
  assert.equal(c({ field: 'steps.s2.outcome', op: 'notIn', value: ['approved'] }), false);
  assert.equal(c({ field: 'subject.values.tags', op: 'contains', value: 'eilig' }), true);
  assert.equal(c({ field: 'subject.title', op: 'contains', value: '42' }), true);
  assert.equal(c({ field: 'subject.title', op: 'notContains', value: '43' }), true);
  assert.equal(c({ field: 'subject.title', op: 'startsWith', value: 'Bestellung' }), true);
  assert.equal(c({ field: 'subject.title', op: 'endsWith', value: '42' }), true);
  assert.equal(c({ field: 'subject.values.owner', op: 'isSet' }), true);
  assert.equal(c({ field: 'subject.values.note', op: 'isSet' }), false, 'leerer Text gilt als nicht gesetzt');
  assert.equal(c({ field: 'subject.values.nothing', op: 'isNotSet' }), true);
  assert.equal(c({ field: 'subject.values.owner', op: 'eq', value: { id: 'p-7', label: 'Anna Muster' } }), true);
});

test('Bedingungen: und, oder, nicht; unbekannter Vergleich', () => {
  const yes: Condition = { field: 'steps.s2.outcome', op: 'eq', value: 'approved' };
  const no: Condition = { field: 'steps.s2.outcome', op: 'eq', value: 'rejected' };
  assert.equal(evaluateCondition({ all: [yes, { not: no }] }, ctx), true);
  assert.equal(evaluateCondition({ any: [no, { all: [yes, no] }] }, ctx), false);
  assert.throws(() => evaluateCondition({ field: 'x', op: 'like' } as unknown as Condition, ctx), /Unbekannter Vergleich «like»/);
  let deep: Condition = yes;
  for (let i = 0; i < 40; i++) deep = { not: deep };
  assert.throws(() => evaluateCondition(deep, ctx), /zu tief verschachtelt/);
});

test('Platzhalter: Bezeichnung statt ID, Listen, fehlende Werte', () => {
  assert.equal(renderTemplate('Für {{subject.values.owner}}: {{subject.title}}', ctx), 'Für Anna Muster: Bestellung 42');
  assert.equal(renderTemplate('Tags: {{ subject.values.tags }}', ctx), 'Tags: eilig, neu');
  assert.equal(renderTemplate('[{{subject.nothing}}]', ctx), '[]');
  assert.equal(renderTemplate('ohne Platzhalter', ctx), 'ohne Platzhalter');
});

test('Formatierer: date, number, list, default', () => {
  assert.equal(renderTemplate('{{subject.values.due | date}}', ctx), '02.11.2026');
  assert.equal(renderTemplate('{{subject.values.due | date:datetime}}', ctx), '02.11.2026, 10:30');
  assert.equal(renderTemplate('{{subject.values.due | date:time}}', ctx, { timeZone: 'UTC' }), '09:30');
  assert.equal(renderTemplate('{{subject.values.due | date:iso}}', ctx), '2026-11-02T09:30:00.000Z');
  assert.match(renderTemplate('{{subject.values.total | number:2}}', ctx), /^1['’]234\.50$/, 'Tausendertrennzeichen nach de-CH (je nach ICU Apostroph oder ’)');
  assert.equal(renderTemplate('{{subject.values.total | number}}', ctx, { locale: 'en-US' }), '1,234.5');
  assert.equal(renderTemplate('{{subject.values.tags | list:" / "}}', ctx), 'eilig / neu');
  assert.equal(renderTemplate('{{subject.values.note | default:"(leer)"}}', ctx), '(leer)');
  assert.equal(renderTemplate('{{subject.title | date}}', ctx), 'Bestellung 42', 'kein Datum: unverändert');
  assert.throws(() => renderTemplate('{{subject.values.total | number:x}}', ctx), /Nachkommastellen/);
  assert.throws(() => renderTemplate('{{subject.values.due | date:long}}', ctx), /«date», «datetime», «time» oder «iso»/);
});

test('Platzhalter: Schreibfehler auf Deutsch', () => {
  assert.deepEqual(templateProblems('Hallo {{subject.title}}'), []);
  assert.match(templateProblems('{{subject.title | upper}}')[0]!, /Unbekannter Formatierer «upper»/);
  assert.match(templateProblems('{{subject.title')[0]!, /nicht geschlossen/);
  assert.match(templateProblems('{{ }}')[0]!, /Leerer Platzhalter/);
  assert.match(templateProblems('{{subject.title | default:"x}}')[0]!, /Anführungszeichen/);
  assert.match(templateProblems('{{a + b}}')[0]!, /Ungültiger Pfad/);
});

test('Werte einsetzen: einzelner Platzhalter behält den Typ', () => {
  const out = resolveValue({ n: '{{vars.limit}}', list: '{{vars.list}}', text: 'Total {{subject.values.total | number:0 | default:x}}', nested: ['{{steps.s2.outcome}}'], keep: 5 }, ctx);
  assert.deepEqual({ ...(out as object), text: undefined }, { n: 1000, list: [1, 2, 3], text: undefined, nested: ['approved'], keep: 5 });
  assert.match((out as { text: string }).text, /^Total 1['’]235$/);
  assert.deepEqual(resolveValue(JSON.parse('{"__proto__": {"x": 1}, "a": 1}'), ctx), { a: 1 });
});
