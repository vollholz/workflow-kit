/**
 * Stufe 2 gegen PostgreSQL in der Mini-App «shop»: Kalender und Warteschlangen (CRUD mit Sperre), Aufgabe aus einem
 * Lauf mit Round Robin, Formular serverseitig geprüft, Erledigen als Person und Folgeschritt als Workflow-Akteur (W7),
 * Genehmigungen «first», «all» und «sequential» mit Begründung bei Ablehnung, Nehmen/Zurücklegen/Weitergeben,
 * Massenaktionen, Frist über Wochenende und Feiertag mit Verzug und Eskalation, Lesesicht (vertraulicher Bezug) und
 * Mandantentrennung der Aufgaben, Abbruch des Laufs bricht offene Aufgaben ab.
 *
 * Datenbank: TEST_POSTGRES_URL (Superuser) oder POSTGRES_SUPERUSER_PASSWORD (+ POSTGRES_PORT, Standard 5433); sonst
 * werden die Tests sichtbar übersprungen.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { HIDDEN_TITLE, workflow, type AuditEntry, type Notice, type Tx, type Workflow, type WorkflowAction, type WorkflowHost, type WorkflowSubject } from '../src/index.ts';

const superUrl = process.env.TEST_POSTGRES_URL
  ?? (process.env.POSTGRES_SUPERUSER_PASSWORD ? `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_SUPERUSER_PASSWORD)}@localhost:${process.env.POSTGRES_PORT ?? '5433'}/postgres` : null);

async function available(): Promise<boolean> {
  if (!superUrl) return false;
  const c = new pg.Client({ connectionString: superUrl, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const skip = !(await available()) && 'PostgreSQL nicht erreichbar (TEST_POSTGRES_URL oder POSTGRES_SUPERUSER_PASSWORD)';

const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const TENANT = "(nullif(current_setting('shop.tenant', true), ''))::uuid";
const PRINCIPAL = "nullif(current_setting('shop.principal', true), '')";

class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(status: number, code: string, detail?: string) { super(detail ?? code); this.statusCode = status; this.code = code; }
}

interface Job { kind: string; payload: { tenantId: string }; runAt?: Date; dedupeKey?: string }
interface Pending { jobs: Job[]; outbox: { type: string; subject: string | null; data: Record<string, unknown> }[]; audit: AuditEntry[]; notices: Notice[] }

describe('Aufgaben und Warteschlangen in der App «shop» (PostgreSQL)', { skip }, () => {
  const suffix = randomBytes(4).toString('hex');
  const db = `wk_tasks_${suffix}`, appRole = `wk_app_${suffix}`, schedRole = `wk_sched_${suffix}`;
  let admin: pg.Client, pool: pg.Pool, app: FastifyInstance, wf: Workflow;
  const A = randomUUID(), B = randomUUID();
  const WF = ['workflow:read', 'workflow:manage', 'workflow:activate', 'workflow:run', 'workflow:operate', 'workflow:admin'];
  const rights: Record<string, string[]> = {
    ada: [...WF, 'order:write', 'task:work', 'task:assign', 'queue:manage'],
    bea: ['workflow:read', 'task:work'], carl: ['task:work'], dora: ['task:work'], eve: [],
    gus: [...WF, 'order:write', 'task:work', 'task:assign', 'queue:manage'],
  };
  const tenantOf: Record<string, string> = { ada: A, bea: A, carl: A, dora: A, eve: A, gus: B };
  const teams: Record<string, string[]> = { sales: ['bea', 'ada'], lead: ['carl', 'dora'], 'sales-b': ['gus'] };
  let now = new Date('2026-11-02T08:00:00Z');

  const queue: Job[] = [];
  const outbox: Pending['outbox'] = [];
  const audit: AuditEntry[] = [];
  const notices: Notice[] = [];
  const failures: unknown[] = [];
  const pending = new WeakMap<object, Pending>();
  const orders: Record<string, string> = {};

  /** Transaktion mit Rolle und Kontext; je Transaktion ein eigenes `Tx` (der Baukasten merkt sich den Mandanten je `Tx`). */
  async function withTx<T>(o: { tenant: string | null; principal: string | null; role?: string }, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    const p: Pending = { jobs: [], outbox: [], audit: [], notices: [] };
    const tx: Tx = { query: (sql, params) => c.query(sql, params as unknown[]) as never };
    pending.set(tx, p);
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL ROLE ${o.role ?? appRole}`);
      await c.query(`SELECT set_config('shop.tenant', $1, true), set_config('shop.principal', $2, true)`, [o.tenant ?? '', o.principal ?? '']);
      const r = await fn(tx);
      await c.query('COMMIT');
      for (const j of p.jobs) if (!j.dedupeKey || !queue.some(q => q.dedupeKey === j.dedupeKey)) queue.push(j);
      outbox.push(...p.outbox); audit.push(...p.audit); notices.push(...p.notices);
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { pending.delete(tx); c.release(); }
  }
  const asUser = <T>(who: string, fn: (tx: Tx) => Promise<T>) => withTx({ tenant: tenantOf[who]!, principal: who }, fn);
  const pendingOf = (tx: Tx) => { const p = pending.get(tx); if (!p) throw new Error('Transaktion ohne Puffer'); return p; };

  const host: WorkflowHost = {
    async tx(req, fn) { return asUser(host.actor(req).id, fn); },
    actor(req) {
      const id = (req as { headers: Record<string, string | undefined> }).headers['x-user'];
      if (!id || !tenantOf[id]) throw new HttpError(401, 'unauthenticated', 'Bitte anmelden');
      return { id, kind: 'person' };
    },
    async active() { return true; },
    async can(_tx, actor, perm) { return rights[actor.id]?.includes(perm) ?? false; },
    async members(_tx, team) { return (team.type === 'role' ? teams[team.id] ?? [] : []).map(id => ({ id, kind: 'person' as const })); },
    async teams(_tx, q) { return Object.keys(teams).filter(t => t.includes(q.search)).slice(0, q.limit).map(id => ({ type: 'role', id, label: `Rolle ${id}` })); },
    async audit(tx, entry) { pendingOf(tx).audit.push(entry); },
    async emit(tx, type, subject, data) {
      pendingOf(tx).outbox.push({ type, subject, data });
      await wf.dispatch(tx, { type, subject: null, data });
    },
    jobs: { async enqueue(tx, kind, payload, o) { pendingOf(tx).jobs.push({ kind, payload: payload as Job['payload'], runAt: o?.runAt, dedupeKey: o?.dedupeKey }); } },
    async notify(tx, notice) { pendingOf(tx).notices.push(notice); },
    error: (status, code, detail) => new HttpError(status, code, detail),
  };

  const orderSubject: WorkflowSubject = {
    type: 'order', label: 'Bestellung',
    async load(tx, id) {
      const r = (await tx.query<{ id: string; customer: string; total: number; state: string; owner: string | null; secret: boolean }>(
        'SELECT id, customer, total, state, owner, secret FROM shop.orders WHERE id = $1', [id])).rows[0];
      return r ? { id: r.id, title: `Bestellung ${r.customer}`, scope: { type: 'shop', id: 'main' }, confidential: r.secret, values: { ...r } } : null;
    },
    async fields() { return [{ key: 'total', label: 'Betrag', type: 'number' }, { key: 'owner', label: 'Verantwortlich', type: 'actor' }]; },
  };
  const cancelOrder: WorkflowAction<{ order: string; reason?: string }> = {
    key: 'order.cancel', label: 'Stornieren', group: 'Bestellungen',
    input: { type: 'object', required: ['order'], properties: { order: { type: 'string' }, reason: { type: 'string' } } },
    needs: input => [{ perm: 'order:write', resource: { type: 'order', id: input.order } }],
    async run(ctx, input) {
      await ctx.tx.query(`UPDATE shop.orders SET state = 'cancelled', note = $2 WHERE id = $1`, [input.order, input.reason ?? null]);
      return { by: ctx.actor };
    },
  };

  async function drain(): Promise<number> {
    let n = 0;
    for (let i = 0; i < 500; i++) {
      const idx = queue.findIndex(j => !j.runAt || j.runAt <= now);
      if (idx < 0) break;
      const job = queue.splice(idx, 1)[0]!;
      const handler = wf.jobs.find(j => j.kind === job.kind)!;
      try { await withTx({ tenant: job.payload.tenantId, principal: null }, tx => handler.handler({ tx, payload: job.payload, attempt: 1 })); }
      catch (e) { failures.push(e); }
      n++;
    }
    return n;
  }

  const call = async (who: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: method as 'GET', url, headers: { ...(who ? { 'x-user': who } : {}), ...headers }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
  };
  const ok = (r: { status: number; body: unknown }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body as Record<string, any>; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const status = (r: { status: number; body: { code?: string } | null }, s: number, code?: string) => { assert.equal(r.status, s, JSON.stringify(r.body)); if (code) assert.equal(r.body?.code, code); };

  async function newOrder(tenant: string, customer: string, o: { secret?: boolean; owner?: string } = {}): Promise<string> {
    return (await admin.query(`INSERT INTO shop.orders (tenant_id, customer, total, secret, owner) VALUES ($1, $2, 100, $3, $4) RETURNING id`,
      [tenant, customer, o.secret ?? false, o.owner ?? null])).rows[0].id;
  }
  async function activeWorkflow(who: string, name: string, steps: unknown[]): Promise<string> {
    const created = ok(await call(who, 'POST', '/v1/workflows', { name, scope: { type: 'shop', id: 'main' }, definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps } }), 201);
    ok(await call(who, 'POST', `/v1/workflows/${created.id}/activate`, {}));
    return created.id as string;
  }
  /** Lauf von Hand starten, Jobs abarbeiten; liefert Lauf und die Aufgabe, auf die er wartet. */
  async function startWithTask(who: string, workflowId: string, order: string) {
    const r = ok(await call(who, 'POST', `/v1/workflows/${workflowId}/runs`, { subject: { type: 'order', id: order } }), 201);
    await drain();
    assert.deepEqual(failures, []);
    const task = (await admin.query(`SELECT * FROM shop.workflow_task WHERE run_id = $1`, [r.id])).rows[0];
    return { runId: r.id as string, task };
  }
  const runOf = async (id: string) => (await admin.query(`SELECT state, outputs, variables, error FROM shop.workflow_run WHERE id = $1`, [id])).rows[0];

  before(async () => {
    const su = new pg.Client({ connectionString: superUrl! });
    await su.connect();
    await su.query(`CREATE DATABASE ${db}`);
    await su.query(`CREATE ROLE ${appRole} NOLOGIN; CREATE ROLE ${schedRole} NOLOGIN`);
    await su.end();
    admin = new pg.Client({ connectionString: withDb(superUrl!, db) });
    await admin.connect();
    await admin.query(`
      CREATE SCHEMA shop; GRANT USAGE ON SCHEMA shop TO ${appRole}, ${schedRole};
      CREATE TABLE shop.orders (tenant_id uuid NOT NULL, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer text NOT NULL, total int NOT NULL,
        state text NOT NULL DEFAULT 'new', secret boolean NOT NULL DEFAULT false, owner text, note text);
      ALTER TABLE shop.orders ENABLE ROW LEVEL SECURITY;
      CREATE POLICY t ON shop.orders TO ${appRole} USING (tenant_id = ${TENANT} AND (NOT secret OR ${PRINCIPAL} = 'ada')) WITH CHECK (tenant_id = ${TENANT});
      GRANT SELECT, INSERT, UPDATE ON shop.orders TO ${appRole};`);
    wf = workflow({
      schema: 'shop', host, subjects: [orderSubject], actions: [cancelOrder as WorkflowAction], events: [{ type: 'order.updated', label: 'geändert', subjectType: 'order' }],
      retryDelayMs: 0, triggerCacheMs: 60_000, clock: () => now,
    });
    for (const m of wf.migrations({ schema: 'shop', appRole, schedRole, tenantExpr: TENANT, principalExpr: PRINCIPAL })) await admin.query(m.sql);
    await admin.query(`SELECT shop.workflow_subjects('{"order": "shop.orders"}')`);
    pool = new pg.Pool({ connectionString: withDb(superUrl!, db), max: 4 });
    app = Fastify();
    app.setErrorHandler((e, _req, reply) => {
      const s = e instanceof HttpError ? e.statusCode : (e as { statusCode?: number }).statusCode ?? 500;
      void reply.status(s).send({ code: e instanceof HttpError ? e.code : 'error', message: e instanceof Error ? e.message : 'Fehler' });
    });
    await app.register(wf.plugin);
    await app.ready();
    ok(await call('ada', 'PUT', '/v1/workflows/settings', { enabled: true }));
    ok(await call('gus', 'PUT', '/v1/workflows/settings', { enabled: true }));
  });
  after(async () => {
    await app?.close(); await pool?.end(); await admin?.end();
    const su = new pg.Client({ connectionString: superUrl! });
    await su.connect();
    await su.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await su.query(`DROP ROLE IF EXISTS ${appRole}; DROP ROLE IF EXISTS ${schedRole}`);
    await su.end();
  });

  test('Migration 002 idempotent; neue Tabellen mit RLS (ENABLE und FORCE)', async () => {
    for (const m of wf.migrations({ schema: 'shop', appRole, schedRole, tenantExpr: TENANT, principalExpr: PRINCIPAL })) await admin.query(m.sql);
    const tables = (await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'shop' AND c.relkind = 'r' AND relname IN ('workflow_task', 'workflow_task_vote', 'workflow_queue', 'workflow_calendar', 'workflow_sla_timer')`)).rows;
    assert.equal(tables.length, 5);
    for (const t of tables) assert.ok(t.relrowsecurity && t.relforcerowsecurity, `${t.relname}: RLS`);
  });

  let calendarId = '', salesQ = '', leadQ = '';
  test('Kalender und Warteschlangen: nur queue:manage, Prüfung, optimistische Sperre', async () => {
    const day = [['08:00', '12:00'], ['13:00', '17:00']];
    const week = { mon: day, tue: day, wed: day, thu: day, fri: day };
    status(await call('bea', 'POST', '/v1/calendars', { name: 'Büro', timezone: 'Europe/Zurich', week }), 403, 'forbidden');
    status(await call('ada', 'POST', '/v1/calendars', { name: 'Büro', timezone: 'Mars/Base', week }), 422, 'invalid');
    const cal = ok(await call('ada', 'POST', '/v1/calendars', { name: 'Büro Zürich', timezone: 'Europe/Zurich', week, holidays: [{ date: '2026-11-09', label: 'Betriebsferien' }], isDefault: true }), 201);
    calendarId = cal.id;
    const preview = ok(await call('ada', 'POST', '/v1/calendars/preview', { calendarId, from: '2026-11-06T14:00:00Z', duration: 'PT4BH' }));
    assert.equal(preview.dueAt, '2026-11-10T09:00:00.000Z', 'Fr 15:00 + 4 Arbeitsstunden, Montag frei → Di 10:00');
    status(await call('ada', 'PUT', `/v1/calendars/${calendarId}`, { name: 'x' }), 428, 'precondition-required');
    ok(await call('ada', 'PUT', `/v1/calendars/${calendarId}`, { name: 'Büro ZH' }, { 'if-match': '"1"' }));
    status(await call('ada', 'PUT', `/v1/calendars/${calendarId}`, { name: 'y' }, { 'if-match': '"1"' }), 409, 'conflict');

    const lead = ok(await call('ada', 'POST', '/v1/queues', { name: 'Leitung', team: { type: 'role', id: 'lead' } }), 201);
    leadQ = lead.id;
    status(await call('ada', 'POST', '/v1/queues', { name: 'Falsch', team: { type: 'role', id: 'sales' }, slaTarget: '3 Tage' }), 422, 'invalid');
    status(await call('bea', 'POST', '/v1/queues', { name: 'Verkauf', team: { type: 'role', id: 'sales' } }), 403);
    const sales = ok(await call('ada', 'POST', '/v1/queues', { name: 'Verkauf', team: { type: 'role', id: 'sales' }, assignment: 'round_robin', calendarId }), 201);
    salesQ = sales.id;
    assert.deepEqual([sales.assignment, sales.sort, sales.revision], ['round_robin', 'urgency', 1]);
    status(await call('ada', 'DELETE', `/v1/calendars/${calendarId}`, undefined, { 'if-match': '"2"' }), 409, 'conflict');
    const teamsList = ok(await call('ada', 'GET', '/v1/queues/teams?q=sal'));
    assert.deepEqual(teamsList, { available: true, items: [{ type: 'role', id: 'sales', label: 'Rolle sales' }, { type: 'role', id: 'sales-b', label: 'Rolle sales-b' }] });
    // Sichtbarkeit: Mitglieder sehen ihre Warteschlangen, ohne Recht und ohne Mitgliedschaft nichts
    assert.deepEqual(ok(await call('bea', 'GET', '/v1/queues')).items.map((q: { name: string; member: boolean }) => [q.name, q.member]), [['Verkauf', true]]);
    assert.deepEqual(ok(await call('ada', 'GET', '/v1/queues')).items.map((q: { name: string }) => q.name), ['Leitung', 'Verkauf']);
    assert.deepEqual(ok(await call('eve', 'GET', '/v1/queues')).items, []);
    status(await call('eve', 'GET', `/v1/queues/${salesQ}`), 404);
    assert.deepEqual(ok(await call('bea', 'GET', `/v1/queues/${salesQ}/members`)).items.map((m: { id: string }) => m.id), ['bea', 'ada']);
    assert.ok(audit.some(e => e.action === 'queue.created') && audit.some(e => e.action === 'calendar.updated'));
  });

  let taskWf = '';
  const taskIds: string[] = [];
  test('Aufgabe aus dem Lauf: Round Robin, Benachrichtigung, Lauf wartet', async () => {
    taskWf = await activeWorkflow('ada', 'Bestellung prüfen', [
      { id: 'check', task: {
        title: '{{subject.title}} prüfen', description: 'Betrag {{subject.values.total}}', assignee: { queue: salesQ }, outcomes: ['ok', 'problem'],
        form: [{ key: 'note', label: 'Notiz', type: 'text', required: true }, { key: 'amount', label: 'Betrag', type: 'number' }],
      } },
      { id: 'decide', if: { field: 'steps.check.outcome', op: 'eq', value: 'problem' }, then: [
        { id: 'cancel', action: 'order.cancel', input: { order: '{{subject.id}}', reason: '{{steps.check.values.note}}' } },
      ] },
    ]);
    orders.o1 = await newOrder(A, 'Anna');
    orders.o2 = await newOrder(A, 'Ben');
    const first = await startWithTask('ada', taskWf, orders.o1);
    const second = await startWithTask('ada', taskWf, orders.o2);
    taskIds.push(first.task.id, second.task.id);
    assert.deepEqual([first.task.assignee_id, second.task.assignee_id], ['ada', 'bea'], 'Round Robin in fester Reihenfolge');
    assert.deepEqual([first.task.title, first.task.description, first.task.state, first.task.queue_id], ['Bestellung Anna prüfen', 'Betrag 100', 'open', salesQ]);
    assert.equal((await runOf(first.runId)).state, 'waiting');
    assert.equal(queue.length, 0, 'kein Job, solange die Aufgabe offen ist');
    assert.ok(notices.some(n => n.kind === 'task_assigned' && n.recipient.id === 'bea' && n.title === 'Neue Aufgabe: Bestellung Ben prüfen'));
    assert.ok(outbox.some(e => e.type === 'task.created') && outbox.some(e => e.type === 'task.assigned'));
    const steps = (await admin.query(`SELECT state, output FROM shop.workflow_step WHERE run_id = $1 ORDER BY seq`, [first.runId])).rows;
    assert.deepEqual(steps.map(s => s.state), ['waiting']);
    assert.equal(steps[0].output.taskId, first.task.id);
  });

  test('Ansichten, Zähler und Lesesicht in den Routen', async () => {
    const mine = ok(await call('bea', 'GET', '/v1/tasks?view=mine'));
    assert.deepEqual(mine.items.map((t: { id: string }) => t.id), [taskIds[1]]);
    assert.deepEqual(mine.items[0].actions, { take: true, release: true, complete: true, decide: false, assign: false, handOver: true, cancel: false });
    assert.equal(mine.items[0].queue.name, 'Verkauf');
    const team = ok(await call('bea', 'GET', '/v1/tasks?view=team'));
    assert.equal(team.items.length, 2, 'beide Aufgaben der Warteschlange');
    assert.deepEqual(ok(await call('bea', 'GET', '/v1/tasks/counts')), { mine: { open: 1, overdue: 0 }, team: { open: 2, overdue: 0, unassigned: 0 } });
    status(await call('carl', 'GET', `/v1/tasks/${taskIds[0]}`), 404, 'not-found');
    assert.deepEqual(ok(await call('carl', 'GET', '/v1/tasks?view=all')).items, []);
    assert.equal(ok(await call('ada', 'GET', '/v1/tasks?view=all')).total, 2, 'task:assign sieht alle');
    const detail = await call('bea', 'GET', `/v1/tasks/${taskIds[1]}`);
    assert.equal(ok(detail).form.length, 2);
    assert.equal(detail.headers.etag, '"1"');
  });

  test('Erledigen: Formular serverseitig, als Person (W7), Folgeschritt als Workflow-Akteur', async () => {
    const t = taskIds[1]!;
    status(await call('ada', 'POST', `/v1/tasks/${t}/complete`, { outcome: 'ok', values: { note: 'x' } }), 409, 'conflict');
    status(await call('bea', 'POST', `/v1/tasks/${t}/complete`, { outcome: 'ok', values: {} }), 422, 'invalid');
    status(await call('bea', 'POST', `/v1/tasks/${t}/complete`, { outcome: 'vielleicht', values: { note: 'x' } }), 422, 'invalid');
    status(await call('bea', 'POST', `/v1/tasks/${t}/complete`, { outcome: 'ok', values: { note: 'x', amount: 'viel' } }), 422, 'invalid');
    status(await call('bea', 'POST', `/v1/tasks/${t}/complete`, { outcome: 'ok', values: { note: 'x', extra: 1 } }), 422, 'invalid');
    status(await call('bea', 'POST', `/v1/tasks/${t}/complete`, { outcome: 'problem', values: { note: 'Adresse fehlt' } }, { 'if-match': '"9"' }), 409, 'conflict');
    const done = ok(await call('bea', 'POST', `/v1/tasks/${t}/complete`, { outcome: 'problem', values: { note: 'Adresse fehlt', amount: 99 } }, { 'if-match': '"1"' }));
    assert.deepEqual([done.state, done.outcome, done.values, done.completedBy], ['done', 'problem', { note: 'Adresse fehlt', amount: 99 }, { id: 'bea', kind: 'person' }]);
    assert.ok(audit.some(e => e.action === 'task.completed' && e.actor?.id === 'bea'), 'Audit mit der erledigenden Person');
    await drain();
    assert.deepEqual(failures, []);
    const o = (await admin.query('SELECT state, note FROM shop.orders WHERE id = $1', [orders.o2])).rows[0];
    assert.deepEqual([o.state, o.note], ['cancelled', 'Adresse fehlt'], 'Folgeschritt mit order:write des Workflow-Akteurs (bea hat das Recht nicht)');
    const run = (await admin.query(`SELECT state, outputs FROM shop.workflow_run WHERE id = (SELECT run_id FROM shop.workflow_task WHERE id = $1)`, [t])).rows[0];
    assert.equal(run.state, 'completed');
    assert.deepEqual([run.outputs.check.outcome, run.outputs.check.values, run.outputs.cancel.by], ['problem', { note: 'Adresse fehlt', amount: 99 }, { id: 'ada', kind: 'person' }]);
    assert.ok(outbox.some(e => e.type === 'task.completed' && e.data.taskId === t));
    status(await call('bea', 'POST', `/v1/tasks/${t}/complete`, { outcome: 'ok', values: { note: 'x' } }), 409);
  });

  test('Genehmigung «first»: Team über members, Ablehnung nur mit Begründung', async () => {
    const id = await activeWorkflow('ada', 'Freigabe (erste Antwort)', [
      { id: 'ok', approval: { title: 'Freigabe {{subject.title}}', approvers: [{ team: { type: 'role', id: 'lead' } }], mode: 'first' } },
      { id: 'save', set: { result: '{{steps.ok.outcome}}', why: '{{steps.ok.reason}}' } },
    ]);
    const { runId, task } = await startWithTask('ada', id, orders.o1!);
    assert.deepEqual(task.candidates.map((c: { id: string }) => c.id), ['carl', 'dora']);
    assert.deepEqual(notices.filter(n => n.kind === 'approval_requested' && n.data?.taskId === task.id).map(n => n.recipient.id), ['carl', 'dora']);
    const carlMine = ok(await call('carl', 'GET', '/v1/tasks?view=mine'));
    assert.deepEqual(carlMine.items.map((t: { id: string; actions: { decide: boolean } }) => [t.id, t.actions.decide]), [[task.id, true]]);
    status(await call('dora', 'POST', `/v1/tasks/${task.id}/decide`, { decision: 'rejected' }), 422, 'invalid');
    status(await call('bea', 'POST', `/v1/tasks/${task.id}/decide`, { decision: 'approved' }), 404, 'not-found');
    const decided = ok(await call('dora', 'POST', `/v1/tasks/${task.id}/decide`, { decision: 'rejected', reason: 'Budget fehlt' }));
    assert.deepEqual([decided.state, decided.outcome, decided.reason, decided.votes.length], ['done', 'rejected', 'Budget fehlt', 1]);
    status(await call('carl', 'POST', `/v1/tasks/${task.id}/decide`, { decision: 'approved' }), 409);
    await drain();
    const run = await runOf(runId);
    assert.deepEqual([run.state, run.variables], ['completed', { result: 'rejected', why: 'Budget fehlt' }]);
    assert.equal(run.outputs.ok.votes[0].actor.id, 'dora');
    assert.ok(audit.some(e => e.action === 'task.decided' && e.actor?.id === 'dora' && e.data?.reason === 'Budget fehlt'));
  });

  test('Genehmigung «all» und «sequential»: alle müssen zustimmen, Reihenfolge zählt', async () => {
    const allWf = await activeWorkflow('ada', 'Freigabe (alle)', [
      { id: 'ok', approval: { title: 'Alle', approvers: [{ actor: { id: 'carl', kind: 'person' } }, { actor: { id: 'dora', kind: 'person' } }], mode: 'all' } },
    ]);
    const all = await startWithTask('ada', allWf, orders.o1!);
    const half = ok(await call('carl', 'POST', `/v1/tasks/${all.task.id}/decide`, { decision: 'approved' }));
    assert.deepEqual([half.state, half.voted], ['in_progress', true]);
    assert.deepEqual(ok(await call('carl', 'GET', '/v1/tasks?view=mine')).items, [], 'nach der Stimme nicht mehr bei «mir»');
    assert.equal((await runOf(all.runId)).state, 'waiting');
    ok(await call('dora', 'POST', `/v1/tasks/${all.task.id}/decide`, { decision: 'approved' }));
    await drain();
    const run = await runOf(all.runId);
    assert.deepEqual([run.state, run.outputs.ok.outcome, run.outputs.ok.votes.map((v: { actor: { id: string } }) => v.actor.id)], ['completed', 'approved', ['carl', 'dora']]);

    const seqWf = await activeWorkflow('ada', 'Freigabe (nacheinander)', [
      { id: 'ok', approval: { title: 'Nacheinander', approvers: [{ actor: { id: 'dora', kind: 'person' } }, { actor: { id: 'carl', kind: 'person' } }], mode: 'sequential' } },
    ]);
    const seq = await startWithTask('ada', seqWf, orders.o1!);
    assert.equal(seq.task.assignee_id, 'dora');
    status(await call('carl', 'POST', `/v1/tasks/${seq.task.id}/decide`, { decision: 'approved' }), 409);
    const next = ok(await call('dora', 'POST', `/v1/tasks/${seq.task.id}/decide`, { decision: 'approved' }));
    assert.deepEqual(next.assignee, { id: 'carl', kind: 'person' });
    assert.ok(notices.some(n => n.kind === 'approval_requested' && n.recipient.id === 'carl' && n.data?.taskId === seq.task.id));
    ok(await call('carl', 'POST', `/v1/tasks/${seq.task.id}/decide`, { decision: 'approved' }));
    await drain();
    assert.equal((await runOf(seq.runId)).outputs.ok.outcome, 'approved');
  });

  test('Nehmen, Zurücklegen, Weitergeben; Massenaktionen nur mit task:assign', async () => {
    const t = taskIds[0]!; // gehört ada (Verkauf)
    const released = ok(await call('ada', 'POST', `/v1/tasks/${t}/release`));
    assert.deepEqual([released.state, released.assignee], ['open', null]);
    const taken = ok(await call('bea', 'POST', `/v1/tasks/${t}/take`));
    assert.deepEqual([taken.state, taken.assignee], ['in_progress', { id: 'bea', kind: 'person' }]);
    status(await call('bea', 'POST', `/v1/tasks/${t}/assign`, { assignee: { id: 'carl', kind: 'person' } }), 403, 'forbidden');
    const handed = ok(await call('bea', 'POST', `/v1/tasks/${t}/assign`, { assignee: { id: 'ada', kind: 'person' } }));
    assert.deepEqual([handed.assignee, handed.state], [{ id: 'ada', kind: 'person' }, 'open'], 'an ein Mitglied derselben Warteschlange');
    const moved = ok(await call('ada', 'POST', `/v1/tasks/${t}/assign`, { queueId: leadQ }));
    assert.deepEqual([moved.queue.id, moved.assignee], [leadQ, null], 'umgeleitet; Leitung nimmt selbst');
    assert.ok(audit.some(e => e.action === 'task.released') && audit.some(e => e.action === 'task.taken'));
    status(await call('bea', 'GET', `/v1/tasks/${t}`), 404, 'not-found'); // nicht mehr in ihrer Warteschlange
    ok(await call('carl', 'POST', `/v1/tasks/${t}/take`));
    status(await call('dora', 'POST', `/v1/tasks/${t}/take`), 409, 'conflict');

    status(await call('bea', 'POST', '/v1/tasks/bulk', { action: 'cancel', ids: [t] }), 403);
    const ghost = randomUUID();
    const bulk = ok(await call('ada', 'POST', '/v1/tasks/bulk', { action: 'cancel', ids: [t, ghost], reason: 'doppelt' }));
    assert.deepEqual(bulk.results.map((r: { ok: boolean; code?: string }) => [r.ok, r.code ?? null]), [[true, null], [false, 'not-found']]);
    await drain();
    const run = (await admin.query(`SELECT state, outputs FROM shop.workflow_run WHERE id = (SELECT run_id FROM shop.workflow_task WHERE id = $1)`, [t])).rows[0];
    assert.deepEqual([run.state, run.outputs.check.outcome, run.outputs.check.reason], ['completed', 'cancelled', 'doppelt'], 'Lauf geht mit «cancelled» weiter');
  });

  test('Frist über Wochenende und Feiertag: Verzug, Ereignis, Benachrichtigung, Eskalation', async () => {
    const q = ok(await call('ada', 'GET', `/v1/queues/${salesQ}`));
    ok(await call('ada', 'PUT', `/v1/queues/${salesQ}`, { slaTarget: 'PT4BH', escalation: { raisePriority: true, notify: [{ actor: { id: 'carl', kind: 'person' } }], queue: leadQ } }, { 'if-match': `"${q.revision}"` }));
    now = new Date('2026-11-06T14:00:00Z'); // Freitag 15:00 in Zürich
    const order = await newOrder(A, 'Frist');
    const { task } = await startWithTask('ada', taskWf, order);
    assert.equal(new Date(task.due_at).toISOString(), '2026-11-10T09:00:00.000Z', 'Montag ist Feiertag → Dienstag 10:00');
    const tick = () => withTx({ tenant: null, principal: null, role: schedRole }, tx => wf.tick(tx));
    now = new Date('2026-11-10T08:30:00Z');
    assert.equal(await tick(), 0, 'noch nicht fällig');
    now = new Date('2026-11-10T09:30:00Z');
    assert.equal(await tick(), 1);
    assert.equal(await tick(), 0, 'einmal je Frist');
    const overdue = ok(await call(task.assignee_id, 'GET', '/v1/tasks/counts'));
    assert.equal(overdue.mine.overdue, 1);
    await drain();
    assert.deepEqual(failures, []);
    const after = (await admin.query(`SELECT priority, queue_id, assignee_id, breached_at FROM shop.workflow_task WHERE id = $1`, [task.id])).rows[0];
    assert.deepEqual([after.priority, after.queue_id, after.assignee_id], ['high', leadQ, null], 'Priorität erhöht, an die Leitung umgeleitet');
    assert.ok(after.breached_at);
    assert.ok(outbox.some(e => e.type === 'task.sla_breached' && e.data.taskId === task.id));
    assert.deepEqual(notices.filter(n => n.kind === 'sla_breached' && n.data?.taskId === task.id).map(n => n.recipient.id).sort(), ['carl', 'dora']);
    const timer = (await admin.query(`SELECT breached_at, escalated_at FROM shop.workflow_sla_timer WHERE task_id = $1`, [task.id])).rows[0];
    assert.ok(timer.breached_at && timer.escalated_at);
    const view = ok(await call('carl', 'GET', '/v1/tasks?view=team&sort=urgency'));
    assert.equal(view.items[0].id, task.id, 'überfällig zuerst');
    assert.equal(view.items[0].overdue, true);
    ok(await call('ada', 'POST', `/v1/tasks/${task.id}/cancel`, { reason: 'Test' }));
    await drain();
  });

  test('Lesesicht: vertraulicher Bezug zeigt neutralen Titel; andere sehen die Aufgabe gar nicht', async () => {
    const id = await activeWorkflow('ada', 'Vertraulich', [
      { id: 'c', task: { title: 'Lieferung prüfen', assignee: { actor: { id: 'bea', kind: 'person' } } } },
    ]);
    const secret = await newOrder(A, 'Geheim', { secret: true });
    const r = ok(await call('ada', 'POST', `/v1/workflows/${id}/runs`, { subject: { type: 'order', id: secret } }), 201);
    await drain();
    const task = (await admin.query(`SELECT id, title FROM shop.workflow_task WHERE run_id = $1`, [r.id])).rows[0];
    assert.ok(notices.some(n => n.data?.taskId === task.id && n.title === `Neue Aufgabe: ${HIDDEN_TITLE}`), 'Benachrichtigung neutral');
    const bea = ok(await call('bea', 'GET', `/v1/tasks/${task.id}`));
    assert.deepEqual([bea.title, bea.hidden, bea.subject.title], [HIDDEN_TITLE, true, null]);
    const adaView = ok(await call('ada', 'GET', `/v1/tasks/${task.id}`));
    assert.deepEqual([adaView.title, adaView.subject.title], ['Lieferung prüfen', 'Bestellung Geheim'], 'wer den Bezug sieht, sieht alles');
    const visible = (who: string) => withTx({ tenant: A, principal: who }, async tx => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM shop.workflow_task WHERE id = $1`, [task.id])).rows[0]!.n);
    assert.equal(await visible('bea'), 1, 'zuständig');
    assert.equal(await visible('carl'), 0, 'weder zuständig noch Bezug sichtbar (RLS)');
    ok(await call('bea', 'POST', `/v1/tasks/${task.id}/complete`, {}));
  });

  test('Mandantentrennung: Aufgaben, Warteschlangen und Kalender nur im eigenen Mandanten', async () => {
    const gq = ok(await call('gus', 'POST', '/v1/queues', { name: 'Verkauf B', team: { type: 'role', id: 'sales-b' } }), 201);
    const id = await activeWorkflow('gus', 'B prüfen', [{ id: 'c', task: { title: 'B', assignee: { queue: gq.id } } }]);
    const order = await newOrder(B, 'Gina');
    const r = ok(await call('gus', 'POST', `/v1/workflows/${id}/runs`, { subject: { type: 'order', id: order } }), 201);
    await drain();
    assert.deepEqual(failures, []);
    const b = (await admin.query(`SELECT id FROM shop.workflow_task WHERE run_id = $1`, [r.id])).rows[0];
    assert.deepEqual(ok(await call('gus', 'GET', '/v1/tasks?view=all&state=any')).items.map((t: { id: string }) => t.id), [b.id]);
    assert.ok(!ok(await call('ada', 'GET', '/v1/tasks?view=all&state=any')).items.some((t: { id: string }) => t.id === b.id));
    status(await call('ada', 'GET', `/v1/tasks/${b.id}`), 404);
    status(await call('gus', 'GET', `/v1/tasks/${taskIds[0]}`), 404);
    assert.deepEqual(ok(await call('gus', 'GET', '/v1/queues')).items.map((q: { name: string }) => q.name), ['Verkauf B']);
    assert.deepEqual(ok(await call('gus', 'GET', '/v1/calendars')).items, []);
    status(await call('gus', 'POST', `/v1/tasks/${taskIds[0]}/cancel`, {}), 404);
    const counts = await withTx({ tenant: B, principal: 'gus' }, async tx => (await tx.query(`SELECT
      (SELECT count(*) FROM shop.workflow_task)::int AS tasks, (SELECT count(*) FROM shop.workflow_task_vote)::int AS votes,
      (SELECT count(*) FROM shop.workflow_queue)::int AS queues, (SELECT count(*) FROM shop.workflow_calendar)::int AS calendars`)).rows[0]);
    assert.deepEqual(counts, { tasks: 1, votes: 0, queues: 1, calendars: 0 });
  });

  test('Abbruch des Laufs bricht offene Aufgaben ab; Warteschlange mit offenen Aufgaben lässt sich nicht löschen', async () => {
    const order = await newOrder(A, 'Abbruch');
    const { runId, task } = await startWithTask('ada', taskWf, order);
    const q = ok(await call('ada', 'GET', `/v1/queues/${salesQ}`));
    status(await call('ada', 'DELETE', `/v1/queues/${salesQ}`, undefined, { 'if-match': `"${q.revision}"` }), 409, 'conflict');
    ok(await call('ada', 'POST', `/v1/workflow-runs/${runId}/cancel`));
    const t = (await admin.query(`SELECT state, outcome FROM shop.workflow_task WHERE id = $1`, [task.id])).rows[0];
    assert.deepEqual([t.state, t.outcome], ['cancelled', 'cancelled']);
    assert.ok(outbox.some(e => e.type === 'task.cancelled' && e.data.taskId === task.id));
    assert.equal(await drain(), 0);
    assert.equal((await runOf(runId)).state, 'cancelled');
    status(await call('ada', 'POST', `/v1/tasks/${task.id}/take`), 409);
    const empty = ok(await call('ada', 'POST', '/v1/queues', { name: 'Leer', team: { type: 'role', id: 'sales' } }), 201);
    const del = await app.inject({ method: 'DELETE', url: `/v1/queues/${empty.id}`, headers: { 'x-user': 'ada', 'if-match': '"1"' } });
    assert.equal(del.statusCode, 204);
    assert.deepEqual(failures, []);
  });
});
