/**
 * Nachweis «app-agnostisch»: Die Mini-App «shop» (Bestellungen mit Zustandsfeld, ohne Anmeldung eines App-Pakets)
 * bindet den Baukasten nur über die Ports ein. Der Host lebt im Speicher und besteht aus wenigen Zeilen; die Datei ist
 * Teil der Typprüfung (`npm run typecheck`), damit die Ports aus Sicht einer App bedienbar bleiben.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  DEFAULT_LIMITS, WORKFLOW_EVENT_TYPES, WORKFLOW_PACKAGE_VERSION, workflow, workflowPermissions,
  type ActorRef, type AuditEntry, type EventSource, type Notice, type StateField, type Tx, type WorkflowAction,
  type WorkflowHost, type WorkflowMeta, type WorkflowOptions, type WorkflowStatus, type WorkflowSubject,
} from '../src/index.ts';

// ---------------------------------------------------------------------------------------------------------------
// Die App «shop»

interface Order { id: string; customer: string; total: number; state: 'new' | 'paid' | 'shipped' | 'cancelled'; shop: string }

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail?: string) { super(detail ?? code); this.status = status; this.code = code; }
}

function shop() {
  const orders = new Map<string, Order>([
    ['o1', { id: 'o1', customer: 'Anna', total: 120, state: 'new', shop: 'zurich' }],
    ['o2', { id: 'o2', customer: 'Ben', total: 80, state: 'paid', shop: 'bern' }],
  ]);
  const people: Record<string, { roles: string[]; perms: string[]; active: boolean }> = {
    anna: { roles: ['staff'], perms: ['workflow:read', 'order:write'], active: true },
    bot: { roles: [], perms: ['order:write'], active: true },
    gone: { roles: ['staff'], perms: [], active: false },
  };
  const audit: AuditEntry[] = [];
  const outbox: { type: string; subject: string | null; data: Record<string, unknown> }[] = [];
  const jobs: { kind: string; payload: unknown; runAt?: Date }[] = [];
  const notices: Notice[] = [];
  const queries: string[] = [];
  const tx: Tx = { async query(sql) { queries.push(sql); return { rows: [] }; } };

  const host = {
    async tx(_req, fn) { return fn(tx); },
    actor(req) {
      const id = (req as { headers: Record<string, string | undefined> }).headers['x-user'];
      if (!id || !people[id]) throw new HttpError(401, 'unauthenticated', 'Bitte anmelden');
      return { id, kind: id === 'bot' ? 'client' : 'person' };
    },
    async active(_tx, actor) { return people[actor.id]?.active ?? false; },
    async can(_tx, actor, perm, _on) { return people[actor.id]?.perms.includes(perm) ?? false; },
    async members(_tx, team) {
      return Object.entries(people).filter(([, p]) => team.type === 'role' && p.roles.includes(team.id)).map(([id]): ActorRef => ({ id, kind: 'person' }));
    },
    async audit(_tx, entry) { audit.push(entry); },
    async emit(_tx, type, subject, data) { outbox.push({ type, subject, data }); },
    jobs: { async enqueue(_tx, kind, payload, o) { jobs.push({ kind, payload, runAt: o?.runAt }); } },
    async notify(_tx, notice) { notices.push(notice); },
    error: (status: number, code: string, detail?: string) => new HttpError(status, code, detail),
  } satisfies WorkflowHost;

  const orderSubject: WorkflowSubject = {
    type: 'order',
    label: 'Bestellung',
    async load(_tx, id) {
      const o = orders.get(id);
      return o ? { id: o.id, title: `Bestellung ${o.id}`, scope: { type: 'shop', id: o.shop }, confidential: false, values: { ...o } } : null;
    },
    async fields() {
      return [
        { key: 'customer', label: 'Kundin/Kunde', type: 'text' },
        { key: 'total', label: 'Betrag', type: 'number' },
        { key: 'state', label: 'Zustand', type: 'choice' },
      ];
    },
  };

  const cancelOrder: WorkflowAction<{ order: string; reason: string }, { state: string }> = {
    key: 'order.cancel',
    label: 'Bestellung stornieren',
    group: 'Bestellungen',
    input: { type: 'object', required: ['order', 'reason'], properties: { order: { type: 'string' }, reason: { type: 'string' } } },
    output: { type: 'object', properties: { state: { type: 'string' } } },
    needs: input => [{ perm: 'order:write', resource: { type: 'order', id: input.order } }],
    async run(_ctx, input) {
      const o = orders.get(input.order);
      if (!o) throw host.error(404, 'not-found');
      o.state = 'cancelled';
      return { state: o.state };
    },
    async dryRun(_ctx, input) { return { summary: `würde Bestellung ${input.order} stornieren` }; },
  };

  const events: EventSource[] = [
    { type: 'order.created', label: 'Bestellung eingegangen', subjectType: 'order' },
    { type: 'order.updated', label: 'Bestellung geändert', subjectType: 'order', filterFields: [{ key: 'state', label: 'Zustand', type: 'choice' }] },
  ];

  const orderState: StateField = {
    subjectType: 'order',
    key: 'state',
    label: 'Zustand',
    async values() {
      return [
        { id: 'new', label: 'Neu', category: 'pending' }, { id: 'paid', label: 'Bezahlt' },
        { id: 'shipped', label: 'Versendet' }, { id: 'cancelled', label: 'Storniert', category: 'inactive' },
      ];
    },
  };

  const options: WorkflowOptions = {
    schema: 'shop',
    host,
    subjects: [orderSubject],
    actions: [cancelOrder as WorkflowAction],
    events,
    stateFields: [orderState],
    fields: [{ key: 'shop', label: 'Filiale', valueSchema: { type: 'string', enum: ['zurich', 'bern'] } }],
    limits: { stepsPerRun: 20 },
  };
  return { orders, host, options, audit, outbox, jobs, notices, queries, tx, cancelOrder };
}

// ---------------------------------------------------------------------------------------------------------------

test('shop bindet den Baukasten ein: Status-Route mit Anmeldung der App', async () => {
  const s = shop();
  const wf = workflow(s.options);
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => {
    const status = e instanceof HttpError ? e.status : 500;
    void reply.status(status).send({ title: e instanceof Error ? e.message : 'Fehler', status });
  });
  await app.register(wf.plugin);
  try {
    const ok = await app.inject({ method: 'GET', url: '/v1/workflows/status', headers: { 'x-user': 'anna' } });
    assert.equal(ok.statusCode, 200);
    const body = ok.json<WorkflowStatus>();
    assert.deepEqual(body, { configured: true, enabled: true, available: false, stage: 1, version: WORKFLOW_PACKAGE_VERSION });
    const anon = await app.inject({ method: 'GET', url: '/v1/workflows/status' });
    assert.equal(anon.statusCode, 401, 'Fehler der App');
  } finally { await app.close(); }
});

test('Meta-Route: angemeldete Ereignisse, Aktionen und Bezugstypen für den Editor', async () => {
  const s = shop();
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => { void reply.status(e instanceof HttpError ? e.status : 500).send({ title: e instanceof Error ? e.message : 'Fehler' }); });
  await app.register(workflow(s.options).plugin);
  try {
    const r = await app.inject({ method: 'GET', url: '/v1/workflows/meta?scopeType=shop&scopeId=zurich', headers: { 'x-user': 'anna' } });
    assert.equal(r.statusCode, 200, r.body);
    const meta = r.json<WorkflowMeta>();
    assert.deepEqual(meta.events.filter(e => !e.builtin).map(e => [e.type, e.label, e.subjectType]), [['order.created', 'Bestellung eingegangen', 'order'], ['order.updated', 'Bestellung geändert', 'order']]);
    assert.equal(meta.events.filter(e => e.builtin).length, WORKFLOW_EVENT_TYPES.length);
    assert.deepEqual(meta.actions.map(a => [a.key, a.label, a.group]), [['order.cancel', 'Bestellung stornieren', 'Bestellungen']]);
    assert.deepEqual(meta.actions[0]!.input.required, ['order', 'reason']);
    assert.deepEqual(meta.subjectTypes.map(t => [t.type, t.label, t.fields.map(f => f.key)]), [['order', 'Bestellung', ['customer', 'total', 'state']]]);
    assert.deepEqual(meta.stateFields, [{ subjectType: 'order', key: 'state', label: 'Zustand' }]);
    assert.deepEqual(meta.fieldKinds.map(f => f.key), ['shop']);
    assert.deepEqual(meta.stepKinds, ['action', 'if', 'foreach', 'wait', 'end', 'set']);
    assert.ok(meta.operators.includes('isSet') && meta.unaryOperators.includes('isSet') && meta.formatters.includes('date'));
    assert.equal(meta.canActAs, false);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/workflows/meta', headers: { 'x-user': 'bot' } })).statusCode, 403, 'ohne workflow:read');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/workflows/meta?scopeType=shop', headers: { 'x-user': 'anna' } })).statusCode, 422);
  } finally { await app.close(); }
});

test('Präfix und Laufzeit-Schalter', async () => {
  const s = shop();
  const app = Fastify();
  await app.register(workflow({ ...s.options, prefix: '/api', enabled: false }).plugin);
  try {
    const r = await app.inject({ method: 'GET', url: '/api/workflows/status', headers: { 'x-user': 'bot' } });
    assert.equal(r.json<WorkflowStatus>().enabled, false);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/workflows/status', headers: { 'x-user': 'bot' } })).statusCode, 404);
  } finally { await app.close(); }
});

test('dispatch kostet ohne Auslöser im Zwischenspeicher keine Abfrage; checkTransition erlaubt alles', async () => {
  const s = shop();
  const wf = workflow(s.options);
  const event = { type: 'order.updated', subject: { type: 'order', id: 'o1' }, data: { state: { from: 'new', to: 'paid' } } };
  await wf.dispatch(s.tx, event, { tenantId: 't1' });
  assert.equal(s.queries.length, 1, 'einmal Einstellungen des Mandanten (keine Zeile = ausgeschaltet)');
  const n = 20_000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await wf.dispatch(s.tx, event, { tenantId: 't1' });
  const perCall = (performance.now() - t0) / n;
  assert.equal(s.queries.length, 1, 'danach keine Abfrage');
  assert.ok(perCall < 0.1, `dispatch ohne Treffer ${perCall.toFixed(4)} ms je Aufruf (Ziel < 0,1 ms)`);
  // ohne Mandant: einmal je Transaktion den Mandanten lesen (hier keiner → nichts weiter)
  await wf.dispatch(s.tx, event);
  await wf.dispatch(s.tx, event);
  assert.equal(s.queries.length, 2);
  // zur Laufzeit ausgeschaltet: gar keine Abfrage
  const off = workflow({ ...s.options, enabled: false });
  await off.dispatch(s.tx, event, { tenantId: 't2' });
  assert.equal(s.queries.length, 2);
  assert.equal(await off.tick(s.tx), 0);
  const check = await wf.checkTransition(s.tx, { id: 'anna', kind: 'person' }, { type: 'order', id: 'o1' }, 'state', 'new', 'cancelled');
  assert.deepEqual(check, { allowed: true });
  assert.deepEqual([s.audit, s.outbox, s.jobs, s.notices], [[], [], [], []]);
  assert.deepEqual(wf.jobs.map(j => j.kind), ['workflow.step', 'workflow.start']);
  assert.equal(wf.limits.stepsPerRun, 20);
  assert.equal(wf.limits.chainDepth, DEFAULT_LIMITS.chainDepth);
});

test('Migrationen mit Schema, Rollen und Ausdrücken der App', () => {
  const wf = workflow(shop().options);
  const m = wf.migrations({ schema: 'shop', appRole: 'shop_app', schedRole: 'shop_worker', tenantExpr: "current_setting('shop.tenant')::uuid" });
  assert.deepEqual(m.map(x => x.name), ['workflow_001_core.sql']);
  assert.match(m[0]!.checksum, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(m[0]!.sql, /\{\{\w+\}\}/, 'alle Platzhalter ersetzt');
  assert.match(m[0]!.sql, /CREATE TABLE IF NOT EXISTS shop\.workflow_run/);
  assert.match(m[0]!.sql, /TO shop_app USING \(tenant_id = current_setting\('shop\.tenant'\)::uuid\)/);
  assert.match(m[0]!.sql, /TO shop_worker/);
  assert.throws(() => wf.migrations({ schema: 'shop; drop', appRole: 'a', schedRole: 'b' }), /kein gültiger Bezeichner/);
  assert.throws(() => wf.migrations({ schema: 'shop', appRole: 'a', schedRole: 'b', tenantExpr: '1; drop table x' }), /kein gültiger SQL-Ausdruck/);
});

test('Definition mit den Aktionen und Ereignissen der App prüfen', () => {
  const wf = workflow(shop().options);
  const def = {
    schemaVersion: 1,
    kind: 'automation',
    trigger: { event: 'order.updated', filter: { field: 'event.data.state.to', op: 'eq', value: 'paid' } },
    steps: [
      { id: 'big', if: { field: 'subject.values.total', op: 'gt', value: 100 }, then: [
        { id: 'ok', approval: { title: 'Grosse Bestellung {{subject.title}}', approvers: [{ team: { type: 'role', id: 'staff' } }], mode: 'majority' } },
        { id: 'no', if: { field: 'steps.ok.outcome', op: 'eq', value: 'rejected' }, then: [
          { id: 'cancel', action: 'order.cancel', input: { order: '{{subject.id}}', reason: '{{steps.ok.reason}}' } },
        ] },
      ] },
    ],
  };
  assert.deepEqual(wf.validate(def).errors, []);
  const wrong = { ...def, trigger: { event: 'invoice.paid' } };
  assert.deepEqual(wf.validate(wrong).errors, [{ path: '/trigger/event', message: 'Unbekannter Ereignistyp «invoice.paid»' }]);
});

test('Aktion der App über die Ports: Recht, Probelauf, Ausführung', async () => {
  const s = shop();
  const ctx = { tx: s.tx, host: s.host, actor: { id: 'bot', kind: 'client' } as const, run: { id: 'r1', workflowId: 'w1', version: 1 }, subject: { type: 'order', id: 'o1' }, vars: {}, idempotencyKey: 'r1:/steps/0:1', dryRun: true, log: () => {} };
  const input = { order: 'o1', reason: 'Test' };
  for (const n of s.cancelOrder.needs!(input)) assert.equal(await s.host.can(s.tx, ctx.actor, n.perm, { type: n.resource.type, id: n.resource.id! }), true);
  assert.equal((await s.cancelOrder.dryRun!(ctx, input)).summary, 'würde Bestellung o1 stornieren');
  assert.equal(s.orders.get('o1')!.state, 'new', 'Probelauf schreibt nichts');
  assert.deepEqual(await s.cancelOrder.run({ ...ctx, dryRun: false }, input), { state: 'cancelled' });
  assert.equal(await s.host.active(s.tx, { id: 'gone', kind: 'person' }), false);
  assert.deepEqual(await s.host.members(s.tx, { type: 'role', id: 'staff' }), [{ id: 'anna', kind: 'person' }, { id: 'gone', kind: 'person' }]);
});

test('widersprüchliche Einbindung wird beim Zusammenstecken abgelehnt', () => {
  const s = shop();
  const o = s.options;
  assert.throws(() => workflow({ ...o, actions: [...o.actions, ...o.actions] }), /Aktion «order.cancel» ist mehrfach angemeldet/);
  assert.throws(() => workflow({ ...o, schema: 'Shop-DB' }), /Schema «Shop-DB» ist kein gültiger Bezeichner/);
  assert.throws(() => workflow({ ...o, stateFields: [{ ...o.stateFields![0]!, subjectType: 'invoice' }] }), /unbekanntem Bezugstyp «invoice»/);
  assert.throws(() => workflow({ ...o, fields: [{ key: 'text', label: 'Text', valueSchema: {} }] }), /Feldart «text» ist im Paket schon vorhanden/);
  assert.throws(() => workflow({ ...o, limits: { chainDepth: 0 } }), /Limit «chainDepth»/);
  assert.throws(() => workflow({ ...o, events: [{ type: 'Order Created', label: 'x' }] }), /keinen gültigen Schlüssel/);
});

test('Rechte und Ereignistypen des Pakets', () => {
  const names = workflowPermissions.map(p => p.name);
  assert.deepEqual(names, [
    'workflow:read', 'workflow:manage', 'workflow:activate', 'workflow:run', 'workflow:operate', 'workflow:admin',
    'task:work', 'task:assign', 'queue:manage', 'case:create', 'case:read',
  ]);
  for (const p of workflowPermissions) assert.ok(p.label && p.description, p.name);
  const types = WORKFLOW_EVENT_TYPES.map(e => e.type);
  assert.equal(new Set(types).size, types.length, 'eindeutig');
  for (const t of types) assert.match(t, /^(workflow|task|case)\.[a-z_]+$/);
});

test('Version im Code wie in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(WORKFLOW_PACKAGE_VERSION, pkg.version);
});
