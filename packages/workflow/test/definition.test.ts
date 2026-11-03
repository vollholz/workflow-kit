/** Definitionen: Schema, deutsche Meldungen mit Pfad, Prüfung des Inhalts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitionSchema, validateDefinition, type DefinitionError } from '../src/index.ts';

/** Beispiel aus Konzept 8.3, mit neutralen Schlüsseln (Bezug «record», Aktionen der App «record.update», «state.set»). */
const example = {
  schemaVersion: 1,
  kind: 'automation',
  name: 'Ausmusterung genehmigen',
  trigger: {
    event: 'record.updated',
    filter: {
      all: [
        { field: 'event.data.changed.field', op: 'eq', value: 'state' },
        { field: 'event.data.changed.to', op: 'eq', value: 'retired' },
      ],
    },
  },
  steps: [
    {
      id: 's1',
      if: { all: [{ field: 'subject.values.owner', op: 'isSet' }] },
      then: [
        {
          id: 's2',
          approval: {
            approvers: [{ team: { type: 'role', id: 'leitung' } }], mode: 'first', title: 'Ausmusterung {{subject.title}}', due: 'P3BD',
          },
        },
        {
          id: 's3',
          if: { field: 'steps.s2.outcome', op: 'eq', value: 'approved' },
          then: [{ id: 's4', action: 'record.update', input: { values: { owner: null } } }],
          else: [{ id: 's5', action: 'state.set', input: { state: 'active' } }],
        },
      ],
    },
  ],
  onError: { retry: 3, then: 'incident' },
};

const clone = <T>(v: T): T => structuredClone(v);
const errs = (v: unknown, o?: Parameters<typeof validateDefinition>[1]): DefinitionError[] => {
  const r = validateDefinition(v, o);
  return r.ok ? [] : r.errors;
};
const has = (list: DefinitionError[], path: string, message: RegExp) =>
  assert.ok(list.some(e => e.path === path && message.test(e.message)), `erwartet ${path} ~ ${message}, erhalten:\n${JSON.stringify(list, null, 2)}`);

test('Beispiel aus dem Konzept ist gültig', () => {
  const r = validateDefinition(example, { known: { actions: ['record.update', 'state.set'], events: ['record.updated'] } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('Schema ist versioniert und als Objekt exportiert', () => {
  assert.deepEqual((definitionSchema.properties as Record<string, { enum?: number[] }>).schemaVersion!.enum, [1, 2]);
  assert.deepEqual(errs({ ...example, schemaVersion: 2 }), []);
  has(errs({ ...example, schemaVersion: 3 }), '/schemaVersion', /Erlaubt: «1», «2»/);
});

const task = (extra: Record<string, unknown> = {}) => ({ id: 't', task: { title: 'Prüfen', assignee: { actor: { id: 'anna', kind: 'person' } }, ...extra } });
const approval = { id: 'g', approval: { title: 'Freigeben', approvers: [{ actor: { id: 'bea', kind: 'person' } }], mode: 'first' } };
const flow = (steps: unknown[], schemaVersion = 2) => ({ schemaVersion, kind: 'automation', trigger: { manual: {} }, steps });

test('Wege nach Ergebnis (Fassung 2): Aufgabe mit eigenen Ergebnissen, Genehmigung mit genehmigt/abgelehnt', () => {
  const ok = flow([
    { ...task({ outcomes: ['Passt', 'Nachbessern'] }), branches: { Passt: [{ id: 'a', set: { x: 1 } }], Nachbessern: [{ id: 'b', end: { result: 'cancelled' } }] } },
    { ...approval, branches: { approved: [{ id: 'c', set: { y: 1 } }], rejected: [] } },
  ]);
  const r = validateDefinition(ok);
  assert.deepEqual(r.errors, []);
  has(errs(flow([{ ...task(), branches: { done: [] } }], 1)), '/steps/0/branches', /Fassung 2/);
  has(errs(flow([{ ...task({ outcomes: ['Passt'] }), branches: { Anders: [] } }])), '/steps/0/branches/Anders', /keinem Ergebnis/);
  has(errs(flow([{ ...approval, branches: { maybe: [] } }])), '/steps/0/branches/maybe', /Unbekannte Angabe/);
  has(errs(flow([{ ...approval, branches: { approved: [{ id: 'g', set: { x: 1 } }] } }])), '/steps/0/branches/approved/0/id', /mehrfach/);
  assert.deepEqual(errs(flow([task({ outcomes: ['Geprüft', 'Zurück an Absender'] })])), [], 'Text mit Umlauten und Leerzeichen');
  has(errs(flow([task({ outcomes: ['a/b'] })])), '/steps/0/task/outcomes/0', /ohne «\/»/);
  has(errs(flow([task({ outcomes: [' x'] })])), '/steps/0/task/outcomes/0', /Leerzeichen/);
});

test('Hinweise: leerer Weg ohne Folgeschritt, Schritte nach «Beenden», «Wenn» ohne Schritte', () => {
  const hints = (steps: unknown[]) => validateDefinition(flow(steps)).warnings;
  assert.deepEqual(hints([approval]).map(h => [h.path, h.message]), [
    ['/steps/0/branches/approved', 'Nach «Genehmigt» geschieht nichts'], ['/steps/0/branches/rejected', 'Nach «Abgelehnt» geschieht nichts'],
  ]);
  assert.deepEqual(hints([{ ...approval, branches: { approved: [{ id: 'a', set: { x: 1 } }] } }]).map(h => h.path), ['/steps/0/branches/rejected']);
  assert.deepEqual(hints([approval, { id: 'n', set: { x: 1 } }]), [], 'danach folgt ein Schritt');
  assert.deepEqual(hints([{ id: 'w', if: { field: 'vars.x', op: 'isSet' }, then: [approval] }, { id: 'n', set: { x: 1 } }]), [], 'nach dem Wenn folgt ein Schritt');
  assert.deepEqual(hints([task()]), [], 'ein Ergebnis ist kein Weg');
  assert.deepEqual(hints([task({ outcomes: ['Passt', 'Nachbessern'] })]).map(h => h.message), ['Nach «Passt» geschieht nichts', 'Nach «Nachbessern» geschieht nichts']);
  assert.deepEqual(hints([{ id: 'e', end: { result: 'completed' } }, { id: 'n', set: { x: 1 } }]).map(h => [h.path, h.message]), [['/steps/1', 'Wird nie ausgeführt: Der Schritt davor beendet den Lauf']]);
  assert.deepEqual(hints([{ id: 'w', if: { field: 'vars.x', op: 'isSet' }, then: [] }, { id: 'n', set: { x: 1 } }]).map(h => h.path), ['/steps/0/then']);
  const bad = validateDefinition(flow([approval, { id: 'g', set: { x: 1 } }]));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.warnings, [], 'Hinweise auch bei Fehlern im Inhalt');
  assert.deepEqual(validateDefinition({}).warnings, [], 'kein Hinweis bei ungültigem Schema');
});

test('Pflichtangaben und unbekannte Angaben mit Pfad', () => {
  const d = clone(example) as Record<string, unknown>;
  delete d.trigger;
  d.extra = true;
  const e = errs(d);
  has(e, '/trigger', /Pflichtangabe «trigger» fehlt/);
  has(e, '/extra', /Unbekannte Angabe «extra»/);
});

test('Schritt braucht genau eine Art', () => {
  const d = clone(example);
  (d.steps[0] as Record<string, unknown>).action = 'record.update';
  has(errs(d), '/steps/0', /Schritt: genau eines von «action», «if»/);
  has(errs({ ...example, steps: [{ id: 'x' }] }), '/steps/0', /genau eines von/);
});

test('falsche Werte: Art, Genehmigungsart, Dauer, Vergleich', () => {
  has(errs({ ...example, kind: 'flow' }), '/kind', /Erlaubt: «automation», «case», «state_model»/);
  const d = clone(example);
  const approval = (d.steps[0]!.then![0] as { approval: Record<string, unknown> }).approval;
  approval.mode = 'some';
  approval.due = '3 Tage';
  const e = errs(d);
  has(e, '/steps/0/then/0/approval/mode', /Erlaubt: «first», «all», «majority», «sequential»/);
  has(e, '/steps/0/then/0/approval/due', /Dauer nach ISO 8601/);
  has(errs({ ...example, steps: [{ id: 'a', if: { field: 'x', op: 'like', value: 1 }, then: [] }] }), '/steps/0/if/op', /Erlaubt: «eq»/);
});

test('Vergleich ohne bzw. mit Wert', () => {
  has(errs({ ...example, steps: [{ id: 'a', if: { field: 'x', op: 'eq' }, then: [] }] }), '/steps/0/if/value', /Pflichtangabe «value» fehlt/);
  has(errs({ ...example, steps: [{ id: 'a', if: { field: 'x', op: 'isSet', value: 1 }, then: [] }] }), '/steps/0/if', /braucht keinen Wert/);
});

test('alle Schrittarten in einem Fall mit Phasen', () => {
  const d = {
    schemaVersion: 1,
    kind: 'case',
    trigger: { manual: { label: 'Fall eröffnen', form: [{ key: 'reason', label: 'Grund', type: 'text', required: true }] } },
    phases: [
      {
        id: 'intake', label: 'Antrag',
        steps: [
          { id: 'v', set: { count: 0, title: '{{trigger.form.reason}}' } },
          { id: 'f', foreach: { items: 'subject.values.lines', as: 'line', limit: 50 }, steps: [{ id: 'n', action: 'line.check', input: { line: '{{line}}' } }] },
          { id: 't', task: { title: 'Prüfen', assignee: { team: { type: 'queue', id: 'q1' } }, outcomes: ['done', 'rejected'], due: 'PT4H', priority: 'high' } },
        ],
      },
      {
        id: 'review', label: 'Prüfung',
        steps: [
          { id: 'a', approval: { title: 'Freigabe', approvers: [{ actor: { id: 'p1', kind: 'person' } }, { field: 'subject.values.manager' }], mode: 'sequential' } },
          { id: 'w1', wait: { duration: 'P1D' } },
          { id: 'w2', wait: { until: '{{subject.values.due}}' } },
          { id: 'w3', wait: { event: { type: 'record.updated' }, timeout: 'P2D' } },
          { id: 'sf', subflow: { workflow: 'wf-2', input: { x: 1 }, wait: true }, onError: { retry: 2, then: 'path', steps: [{ id: 'e', end: { result: 'failed', message: 'Unterablauf fehlgeschlagen' } }] } },
          { id: 'z', end: { result: 'completed' } },
        ],
      },
    ],
  };
  assert.deepEqual(errs(d), []);
});

test('Warten: genau eine Art, Ereignis nur mit Zeitüberschreitung', () => {
  const step = (wait: unknown) => errs({ ...example, steps: [{ id: 'w', wait }] });
  has(step({ duration: 'P1D', until: 'x' }), '/steps/0/wait', /genau eines von «duration», «until» oder «event»/);
  has(step({ event: { type: 'a.b' } }), '/steps/0/wait/timeout', /Pflichtangabe «timeout» fehlt/);
  has(step({ duration: 'P1D', timeout: 'P1D' }), '/steps/0/wait/event', /Pflichtangabe «event» fehlt. «timeout» nur beim Warten auf ein Ereignis/);
});

test('Auslöser: Zeitplan, Statusübergang, Unterablauf', () => {
  const t = (trigger: unknown) => errs({ ...example, trigger });
  assert.deepEqual(t({ schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Zurich' } }), []);
  assert.deepEqual(t({ transition: { subjectType: 'record', field: 'state', to: ['retired'] } }), []);
  assert.deepEqual(t({ subflow: { inputs: [{ key: 'x', label: 'X', type: 'number' }] } }), []);
  has(t({ schedule: { cron: '0 7 * *', timezone: 'Europe/Zurich' } }), '/trigger/schedule/cron', /fünf Felder/);
  has(t({ event: 'a', manual: {} }), '/trigger', /Auslöser: genau eines von/);
});

test('Fehlerpfad: Schritte nur mit «path»', () => {
  has(errs({ ...example, onError: { then: 'path' } }), '/onError/steps', /Pflichtangabe «steps» fehlt/);
  has(errs({ ...example, onError: { retry: 11 } }), '/onError/retry', /Höchstens 10/);
});

test('Inhalt: doppelte IDs, unbekannte Aktion und Ereignis, Verweise, Platzhalter, Limit', () => {
  const d = clone(example);
  (d.steps[0]!.then![1] as { then: { id: string }[] }).then[0]!.id = 's2';
  const known = { actions: ['state.set'], events: ['record.created'] };
  const e = errs(d, { known });
  has(e, '/steps/0/then/1/then/0/id', /Schritt-ID «s2» kommt mehrfach vor/);
  has(e, '/steps/0/then/1/then/0/action', /Unbekannte Aktion «record.update»/);
  has(e, '/trigger/event', /Unbekannter Ereignistyp «record.updated»/);

  const refs = errs({ ...example, steps: [{ id: 'a', if: { field: 'steps.nope.outcome', op: 'isSet' }, then: [{ id: 'b', action: 'x', input: { t: 'Hallo {{steps.gone.x}}' } }] }] });
  has(refs, '/steps/0/if/field', /unbekannten Schritt «nope»/);
  has(refs, '/steps/0/then/0/input/t', /unbekannten Schritt «gone»/);

  has(errs({ ...example, name: 'Hallo {{subject.title | upper}}' }), '/name', /Unbekannter Formatierer «upper»/);
  has(errs({ ...example, name: 'Hallo {{subject.title' }), '/name', /nicht geschlossen/);
  has(errs({ ...example, steps: [{ id: 'f', foreach: { items: 'x', as: 'y', limit: 500 }, steps: [] }] }, { maxForeach: 100 }), '/steps/0/foreach/limit', /Höchstens 100/);
});

test('Zustandsmodell: Zustände und Übergänge', () => {
  const sm = {
    schemaVersion: 1,
    kind: 'state_model',
    subjectType: 'order',
    field: 'state',
    states: [{ value: 'new', initial: true }, { value: 'paid' }, { value: 'shipped' }, { value: 'cancelled' }],
    transitions: [
      { id: 'pay', name: 'Bezahlen', from: ['new'], to: 'paid' },
      { id: 'ship', name: 'Versenden', from: ['paid'], to: 'shipped', requiredFields: ['tracking'] },
      { id: 'cancel', name: 'Stornieren', from: '*', to: 'cancelled', approval: { title: 'Storno', approvers: [{ team: { type: 'role', id: 'lead' } }], mode: 'all' } },
    ],
  };
  assert.deepEqual(errs(sm, { known: { subjectTypes: ['order'] } }), []);
  const bad = clone(sm);
  bad.transitions[0]!.to = 'lost';
  (bad.transitions[1]!.from as string[])[0] = 'nowhere';
  bad.transitions[2]!.id = 'pay';
  bad.states[1]!.initial = true;
  const e = errs(bad, { known: { subjectTypes: ['shipment'] } });
  has(e, '/transitions/0/to', /Unbekannter Zustand «lost»/);
  has(e, '/transitions/1/from/0', /Unbekannter Zustand «nowhere»/);
  has(e, '/transitions/2/id', /Übergangs-ID «pay» kommt mehrfach vor/);
  has(e, '/states', /Höchstens ein Anfangszustand/);
  has(e, '/subjectType', /Unbekannter Bezugstyp «order»/);
});

test('keine Angaben: Meldung an der Wurzel', () => {
  has(errs(null), '/', /Erwartet: Angaben in {…}/);
});
