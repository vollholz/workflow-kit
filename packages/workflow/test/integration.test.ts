/**
 * Einbindung gegen PostgreSQL: die Mini-App «shop» mit Bestellungen (eigenes Schema, eigene Rollen, eigene Ausdrücke für
 * Mandant und Person, Lesesicht mit vertraulichen Bestellungen), einer Job-Warteschlange im Speicher (Jobs erst nach
 * dem Commit sichtbar) und einem Host aus wenigen Zeilen. Prüft Migrationen (zweimal), RLS je Tabelle, Mandant und
 * Bezug, Opt-in, Ereignis → Lauf → Aktion, Akteur ohne Recht → Vorfall, Schleife zweier Workflows, Probelauf, Zeitplan,
 * manuellen Start mit Maschinen-Client, Wiederholung und Vorfall-Aktionen.
 *
 * Datenbank: TEST_POSTGRES_URL (Superuser) oder POSTGRES_SUPERUSER_PASSWORD (+ POSTGRES_PORT, Standard 5433); sonst
 * werden die Tests sichtbar übersprungen.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  workflow, type ActorRef, type AuditEntry, type Notice, type Tx, type Workflow, type WorkflowAction, type WorkflowHost, type WorkflowSubject,
} from '../src/index.ts';

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

describe('Automation in der App «shop» (PostgreSQL)', { skip }, () => {
  const suffix = randomBytes(4).toString('hex');
  const db = `wk_test_${suffix}`, appRole = `wk_app_${suffix}`, schedRole = `wk_sched_${suffix}`;
  let admin: pg.Client, pool: pg.Pool, app: FastifyInstance, wf: Workflow;
  const A = randomUUID(), B = randomUUID();
  const ALL = ['workflow:read', 'workflow:manage', 'workflow:activate', 'workflow:run', 'workflow:operate', 'workflow:admin'];
  const rights: Record<string, string[]> = {
    ada: [...ALL, 'order:write'], bea: ['workflow:read', 'workflow:run'], carl: ['workflow:read', 'workflow:manage', 'workflow:activate', 'workflow:operate', 'workflow:run'],
    gus: [...ALL, 'order:write'], bot: ['order:write'],
  };
  const tenantOf: Record<string, string> = { ada: A, bea: A, carl: A, bot: A, gus: B };
  const active: Record<string, boolean> = { ada: true, bea: true, carl: true, bot: true, gus: true };
  let now = new Date();

  // Was die App festhält (nach dem Commit)
  const queue: Job[] = [];
  const outbox: Pending['outbox'] = [];
  const audit: AuditEntry[] = [];
  const notices: Notice[] = [];
  const failures: unknown[] = [];
  const pending = new WeakMap<object, Pending>();
  const orders: Record<string, string> = {};
  let flaky = 0;

  /** Transaktion mit Rolle und Kontext; Jobs, Outbox, Audit erst nach dem Commit. */
  async function withTx<T>(o: { tenant: string | null; principal: string | null; role?: string }, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    const p: Pending = { jobs: [], outbox: [], audit: [], notices: [] };
    pending.set(c, p);
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL ROLE ${o.role ?? appRole}`);
      await c.query(`SELECT set_config('shop.tenant', $1, true), set_config('shop.principal', $2, true)`, [o.tenant ?? '', o.principal ?? '']);
      const r = await fn(c);
      await c.query('COMMIT');
      for (const j of p.jobs) if (!j.dedupeKey || !queue.some(q => q.dedupeKey === j.dedupeKey)) queue.push(j);
      outbox.push(...p.outbox); audit.push(...p.audit); notices.push(...p.notices);
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { pending.delete(c); c.release(); }
  }
  const asUser = <T>(who: string, fn: (tx: pg.PoolClient) => Promise<T>) => withTx({ tenant: tenantOf[who]!, principal: who }, fn);
  const pendingOf = (tx: Tx) => { const p = pending.get(tx); if (!p) throw new Error('Transaktion ohne Puffer'); return p; };

  /** Ereignis der App: Outbox und dispatch in derselben Transaktion (W3). */
  async function appEmit(tx: Tx, type: string, order: string | null, data: Record<string, unknown>) {
    pendingOf(tx).outbox.push({ type, subject: order, data });
    await wf.dispatch(tx, { type, subject: order ? { type: 'order', id: order } : null, data }, {});
  }

  const host: WorkflowHost = {
    async tx(req, fn) { const who = host.actor(req).id; return asUser(who, c => fn(c)); },
    actor(req) {
      const id = (req as { headers: Record<string, string | undefined> }).headers['x-user'];
      if (!id || !tenantOf[id]) throw new HttpError(401, 'unauthenticated', 'Bitte anmelden');
      return { id, kind: id === 'bot' ? 'client' : 'person' };
    },
    async active(_tx, actor) { return active[actor.id] ?? false; },
    async can(_tx, actor, perm) { return rights[actor.id]?.includes(perm) ?? false; },
    async canActAs(_tx, actor, target) { return actor.id === 'ada' && target.id === 'bot' && target.kind === 'client'; },
    async members() { return []; },
    async audit(tx, entry) { pendingOf(tx).audit.push(entry); },
    async emit(tx, type, subject, data) { await appEmit(tx, type, null, { ...data, subject }); },
    jobs: { async enqueue(tx, kind, payload, o) { pendingOf(tx).jobs.push({ kind, payload: payload as Job['payload'], runAt: o?.runAt, dedupeKey: o?.dedupeKey }); } },
    async notify(tx, notice) { pendingOf(tx).notices.push(notice); },
    error: (status, code, detail) => new HttpError(status, code, detail),
  };

  const orderSubject: WorkflowSubject = {
    type: 'order', label: 'Bestellung',
    async load(tx, id) {
      const r = (await tx.query<{ id: string; customer: string; total: number; state: string }>('SELECT id, customer, total, state FROM shop.orders WHERE id = $1', [id])).rows[0];
      return r ? { id: r.id, title: `Bestellung ${r.customer}`, scope: { type: 'shop', id: 'main' }, confidential: false, values: { ...r } } : null;
    },
    async fields() { return [{ key: 'total', label: 'Betrag', type: 'number' }]; },
  };
  const orderAction = (key: string, sql: string, event: string | null): WorkflowAction<{ order: string; reason?: string }> => ({
    key, label: key, group: 'Bestellungen',
    input: { type: 'object', required: ['order'], properties: { order: { type: 'string', format: 'uuid' }, reason: { type: 'string' } } },
    needs: input => [{ perm: 'order:write', resource: { type: 'order', id: input.order } }],
    async run(ctx, input) {
      const r = await ctx.tx.query<{ state: string }>(sql, [input.order]);
      ctx.log(`${key} ${input.order}`);
      if (event) await appEmit(ctx.tx, event, input.order, { reason: input.reason ?? null, state: { to: r.rows[0]?.state ?? null } });
      return { rows: r.rowCount };
    },
    async dryRun(_ctx, input) { return { summary: `würde ${key} für ${input.order} ausführen` }; },
  });
  const actions = [
    orderAction('order.cancel', `UPDATE shop.orders SET state = 'cancelled' WHERE id = $1 RETURNING state`, 'order.updated'),
    orderAction('order.touch', 'UPDATE shop.orders SET touched = touched + 1 WHERE id = $1 RETURNING state', 'order.touched'),
    orderAction('order.note', 'UPDATE shop.orders SET notes = notes + 1 WHERE id = $1 RETURNING state', 'order.noted'),
    {
      key: 'shop.flaky', label: 'Unzuverlässig', group: 'Test', input: { type: 'object' },
      async run() { flaky++; if (flaky <= 2) throw new Error(`Gegenstelle antwortet nicht (${flaky})`); return { ok: true }; },
    } satisfies WorkflowAction,
  ] as WorkflowAction[];

  /** Jobs ausführen, die fällig sind (oder alle), im Mandanten des Jobs ohne angemeldete Person. */
  async function drain(o: { all?: boolean } = {}): Promise<number> {
    let n = 0;
    for (let i = 0; i < 500; i++) {
      const idx = queue.findIndex(j => o.all || !j.runAt || j.runAt <= now);
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
  const count = async (sql: string, params: unknown[] = []) => Number((await admin.query(sql, params)).rows[0].n);

  async function newOrder(tenant: string, customer: string, total: number, secret = false): Promise<string> {
    return (await admin.query(`INSERT INTO shop.orders (tenant_id, customer, total, secret) VALUES ($1, $2, $3, $4) RETURNING id`, [tenant, customer, total, secret])).rows[0].id;
  }
  /** Workflow anlegen und aktivieren; liefert die ID. */
  async function activeWorkflow(who: string, name: string, definition: unknown, actor?: ActorRef): Promise<string> {
    const created = ok(await call(who, 'POST', '/v1/workflows', { name, scope: { type: 'shop', id: 'main' }, definition }), 201);
    ok(await call(who, 'POST', `/v1/workflows/${created.id}/activate`, actor ? { actor } : {}));
    return created.id as string;
  }

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
        state text NOT NULL DEFAULT 'new', secret boolean NOT NULL DEFAULT false, touched int NOT NULL DEFAULT 0, notes int NOT NULL DEFAULT 0);
      ALTER TABLE shop.orders ENABLE ROW LEVEL SECURITY;
      CREATE POLICY t ON shop.orders TO ${appRole} USING (tenant_id = ${TENANT} AND (NOT secret OR ${PRINCIPAL} = 'ada')) WITH CHECK (tenant_id = ${TENANT});
      GRANT SELECT, INSERT, UPDATE ON shop.orders TO ${appRole};`);
    wf = workflow({
      schema: 'shop', host, subjects: [orderSubject], actions,
      events: ['order.created', 'order.updated', 'order.touched', 'order.noted'].map(type => ({ type, label: type, subjectType: 'order' })),
      retryDelayMs: 0, triggerCacheMs: 60_000, clock: () => now,
    });
    for (const m of wf.migrations({ schema: 'shop', appRole, schedRole, tenantExpr: TENANT, principalExpr: PRINCIPAL })) await admin.query(m.sql);
    await admin.query(`SELECT shop.workflow_subjects('{"order": "shop.orders"}')`);
    pool = new pg.Pool({ connectionString: withDb(superUrl!, db), max: 4 });
    app = Fastify();
    app.setErrorHandler((e, _req, reply) => {
      const status = e instanceof HttpError ? e.statusCode : (e as { statusCode?: number }).statusCode ?? 500;
      void reply.status(status).send({ code: e instanceof HttpError ? e.code : 'error', message: e instanceof Error ? e.message : 'Fehler' });
    });
    await app.register(wf.plugin);
    await app.ready();
    orders.big = await newOrder(A, 'Anna', 150);
    orders.small = await newOrder(A, 'Ben', 50);
    orders.secret = await newOrder(A, 'Geheim', 70, true);
    orders.other = await newOrder(B, 'Gina', 500);
  });
  after(async () => {
    await app?.close(); await pool?.end(); await admin?.end();
    const su = new pg.Client({ connectionString: superUrl! });
    await su.connect();
    await su.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await su.query(`DROP ROLE IF EXISTS ${appRole}; DROP ROLE IF EXISTS ${schedRole}`);
    await su.end();
  });

  test('Migrationen sind idempotent; jede Tabelle mit RLS (ENABLE und FORCE); Lesesicht der App bleibt', async () => {
    const qual = async () => (await admin.query(`SELECT qual FROM pg_policies WHERE schemaname = 'shop' AND tablename = 'workflow_run' AND policyname = 'subject_read'`)).rows[0].qual as string;
    const before = await qual();
    for (const m of wf.migrations({ schema: 'shop', appRole, schedRole, tenantExpr: TENANT, principalExpr: PRINCIPAL })) await admin.query(m.sql);
    assert.equal(await qual(), before);
    assert.match(before, /shop\.orders/);
    const tables = (await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'shop' AND c.relkind = 'r' AND relname LIKE 'workflow%' ORDER BY relname`)).rows;
    assert.deepEqual(tables.map(t => t.relname), [
      'workflow', 'workflow_calendar', 'workflow_queue', 'workflow_run', 'workflow_settings', 'workflow_sla_timer', 'workflow_step', 'workflow_task',
      'workflow_task_vote', 'workflow_trigger', 'workflow_usage', 'workflow_version',
    ]);
    for (const t of tables) assert.ok(t.relrowsecurity && t.relforcerowsecurity, `${t.relname}: RLS`);
  });

  test('Opt-in je Mandant: ohne Einschalten 404 module-disabled; nur workflow:admin schaltet ein', async () => {
    assert.equal(ok(await call('ada', 'GET', '/v1/workflows/status')).available, false);
    const off = await call('ada', 'GET', '/v1/workflows');
    assert.equal(off.status, 404);
    assert.equal(off.body.code, 'module-disabled');
    assert.equal((await call('bea', 'PUT', '/v1/workflows/settings', { enabled: true })).status, 403);
    assert.equal((await call('ada', 'PUT', '/v1/workflows/settings', { enabled: true, limits: { chainDepth: 99 } })).status, 422);
    const s = ok(await call('ada', 'PUT', '/v1/workflows/settings', { enabled: true }));
    assert.equal(s.enabled, true);
    ok(await call('gus', 'PUT', '/v1/workflows/settings', { enabled: true }));
    const status = ok(await call('ada', 'GET', '/v1/workflows/status'));
    assert.deepEqual([status.available, status.stage, status.version], [true, 2, '0.7.0']);
    assert.ok(audit.some(e => e.action === 'workflow.settings_changed'));
  });

  let cancelWf = '';
  test('Entwurf mit optimistischer Sperre, Prüfung, Aktivieren mit Version', async () => {
    const created = ok(await call('ada', 'POST', '/v1/workflows', { name: 'Grosse Bestellungen stornieren', scope: { type: 'shop', id: 'main' } }), 201);
    cancelWf = created.id;
    assert.equal(created.revision, 1);
    const definition = {
      schemaVersion: 1, kind: 'automation',
      trigger: { event: 'order.updated', filter: { field: 'event.data.state.to', op: 'eq', value: 'paid' } },
      steps: [{ id: 'big', if: { field: 'subject.values.total', op: 'gt', value: 100 }, then: [
        { id: 'cancel', action: 'order.cancel', input: { order: '{{subject.id}}', reason: 'zu gross: {{subject.title}}' } },
      ] }],
    };
    assert.equal((await call('ada', 'PUT', `/v1/workflows/${cancelWf}`, { definition })).status, 428, 'ohne Stand');
    assert.equal((await call('ada', 'PUT', `/v1/workflows/${cancelWf}`, { definition }, { 'if-match': '"7"' })).status, 409);
    assert.equal((await call('bea', 'PUT', `/v1/workflows/${cancelWf}`, { definition }, { 'if-match': '"1"' })).status, 403);
    const saved = ok(await call('ada', 'PUT', `/v1/workflows/${cancelWf}`, { definition }, { 'if-match': '"1"' }));
    assert.deepEqual([saved.revision, saved.validation.ok], [2, true]);
    const invalid = ok(await call('ada', 'POST', '/v1/workflows/validate', { definition: { ...definition, steps: [{ id: 'x', action: 'order.unknown' }] } }));
    assert.deepEqual(invalid.errors, [{ path: '/steps/0/action', message: 'Unbekannte Aktion «order.unknown»' }]);
    const later = ok(await call('ada', 'POST', '/v1/workflows/validate', { definition: { ...definition, steps: [{ id: 'w', wait: { event: { type: 'order.created' }, timeout: 'PT1H' } }] } }));
    assert.deepEqual([later.ok, later.stage[0].path], [false, '/steps/0/wait/event']);
    const activated = ok(await call('ada', 'POST', `/v1/workflows/${cancelWf}/activate`, {}));
    assert.deepEqual([activated.state, activated.activeVersion, activated.actor], ['active', 1, { id: 'ada', kind: 'person' }]);
    const versions = ok(await call('bea', 'GET', `/v1/workflows/${cancelWf}/versions`));
    assert.equal(versions.items.length, 1);
    assert.match(versions.items[0].checksum, /^[0-9a-f]{64}$/);
    assert.deepEqual(ok(await call('bea', 'GET', `/v1/workflows/${cancelWf}/versions/1`)).definition.trigger, definition.trigger);
    assert.equal((await call('ada', 'DELETE', `/v1/workflows/${cancelWf}`, undefined, { 'if-match': '"3"' })).status, 409, 'aktiv: nur archivieren');
    assert.ok(outbox.some(e => e.type === 'workflow.activated'));
    assert.ok(audit.some(e => e.action === 'workflow.activated' && e.workflowId === cancelWf));
    assert.equal((await call('gus', 'GET', `/v1/workflows/${cancelWf}`)).status, 404, 'anderer Mandant');
  });

  test('Ereignis → Lauf → Aktion; Ereignisse der Aktion lösen ohne Opt-in nichts aus', async () => {
    const pay = (order: string) => asUser('ada', async tx => {
      await tx.query(`UPDATE shop.orders SET state = 'paid' WHERE id = $1`, [order]);
      await appEmit(tx, 'order.updated', order, { state: { from: 'new', to: 'paid' } });
    });
    await pay(orders.big!);
    await pay(orders.small!);
    assert.equal(queue.filter(j => j.kind === 'workflow.step').length, 2, 'je Lauf ein Job');
    await drain();
    assert.deepEqual(failures, []);
    const state = async (id: string) => (await admin.query('SELECT state FROM shop.orders WHERE id = $1', [id])).rows[0].state;
    assert.equal(await state(orders.big!), 'cancelled');
    assert.equal(await state(orders.small!), 'paid');
    const runs = (await admin.query(`SELECT subject_id, state, step_count, chain_depth FROM shop.workflow_run WHERE workflow_id = $1 ORDER BY step_count DESC`, [cancelWf])).rows;
    assert.deepEqual(runs.map(r => [r.subject_id, r.state, r.step_count, r.chain_depth]), [[orders.big, 'completed', 2, 1], [orders.small, 'completed', 1, 1]]);
    const steps = (await admin.query(`SELECT s.path, s.state, s.input, s.log FROM shop.workflow_step s JOIN shop.workflow_run r ON r.id = s.run_id
      WHERE r.subject_id = $1 ORDER BY s.seq`, [orders.big])).rows;
    assert.deepEqual(steps.map(s => [s.path, s.state]), [['/steps/0', 'completed'], ['/steps/0/then/0', 'completed']]);
    assert.deepEqual(steps[1].input, { order: orders.big, reason: 'zu gross: Bestellung Anna' });
    assert.deepEqual(steps[1].log, [`order.cancel ${orders.big}`]);
    assert.equal(outbox.filter(e => e.type === 'workflow.run_completed').length, 2);
    assert.equal(await count(`SELECT count(*) AS n FROM shop.workflow_run`), 2, 'Stornierung (order.updated aus dem Lauf) startet keinen weiteren Lauf');
    assert.equal(await count(`SELECT runs AS n FROM shop.workflow_usage WHERE tenant_id = $1`, [A]), 2);
  });

  test('Lesesicht: Läufe nur im eigenen Mandanten und nur mit sichtbarem Bezug; Seiten mit Cursor', async () => {
    await asUser('ada', tx => appEmit(tx, 'order.updated', orders.secret!, { state: { from: 'new', to: 'paid' } }));
    await drain();
    const ids = (who: string) => call(who, 'GET', '/v1/workflow-runs').then(r => ok(r).items.map((x: { subject: { id: string } }) => x.subject.id).sort());
    assert.deepEqual(await ids('ada'), [orders.big, orders.secret, orders.small].sort());
    assert.deepEqual(await ids('bea'), [orders.big, orders.small].sort(), 'vertrauliche Bestellung unsichtbar');
    assert.deepEqual(await ids('gus'), [], 'anderer Mandant');
    const secretRun = (await admin.query(`SELECT id FROM shop.workflow_run WHERE subject_id = $1`, [orders.secret])).rows[0].id;
    assert.equal((await call('bea', 'GET', `/v1/workflow-runs/${secretRun}`)).status, 404);
    const detail = ok(await call('ada', 'GET', `/v1/workflow-runs/${secretRun}`));
    assert.deepEqual(detail.steps.map((s: { stepId: string }) => s.stepId), ['big']);
    // unbekannter Bezugstyp: unsichtbar; ohne Bezug: sichtbar (Recht prüft die API)
    await admin.query(`INSERT INTO shop.workflow_run (tenant_id, id, workflow_id, version, trigger_kind, subject_type, subject_id, actor_id, actor_kind, state)
      VALUES ($1, $2, $3, 1, 'event', 'ghost', 'x', 'ada', 'person', 'completed'), ($1, $4, $3, 1, 'manual', NULL, NULL, 'ada', 'person', 'completed')`,
    [A, randomUUID(), cancelWf, randomUUID()]);
    const visible = await withTx({ tenant: A, principal: 'ada' }, async tx => (await tx.query(`SELECT subject_type FROM shop.workflow_run ORDER BY subject_type NULLS FIRST`)).rows.map(r => r.subject_type));
    assert.deepEqual(visible, [null, 'order', 'order', 'order']);
    const page1 = ok(await call('ada', 'GET', '/v1/workflow-runs?limit=2'));
    const page2 = ok(await call('ada', 'GET', `/v1/workflow-runs?limit=2&cursor=${page1.nextCursor}`));
    const page3 = ok(await call('ada', 'GET', `/v1/workflow-runs?limit=2&cursor=${page2.nextCursor}`));
    assert.equal(page1.items.length + page2.items.length + page3.items.length, 4);
    assert.equal(new Set([...page1.items, ...page2.items, ...page3.items].map((r: { id: string }) => r.id)).size, 4);
  });

  test('Akteur ohne Recht: Vorfall ohne Wiederholung, nichts geschrieben, Benachrichtigung; Vorfall abbrechen', async () => {
    const id = await activeWorkflow('carl', 'Neue Bestellungen markieren', {
      schemaVersion: 1, kind: 'automation', trigger: { event: 'order.created' },
      steps: [{ id: 'touch', action: 'order.touch', input: { order: '{{event.subject.id}}' } }],
    });
    const order = await newOrder(A, 'Carla', 10);
    await asUser('ada', tx => appEmit(tx, 'order.created', order, {}));
    await drain();
    const run = (await admin.query(`SELECT id, state, error FROM shop.workflow_run WHERE workflow_id = $1`, [id])).rows[0];
    assert.equal(run.state, 'incident');
    assert.equal(run.error.code, 'forbidden');
    assert.match(run.error.message, /order:write/);
    assert.equal(await count(`SELECT touched AS n FROM shop.orders WHERE id = $1`, [order]), 0, 'nichts geschrieben');
    assert.equal(await count(`SELECT count(*) AS n FROM shop.workflow_step WHERE run_id = $1`, [run.id]), 1, 'ein Versuch');
    assert.ok(notices.some(n => n.kind === 'run_failed' && n.recipient.id === 'carl'));
    assert.ok(outbox.some(e => e.type === 'workflow.incident_opened'));
    assert.equal((await call('bea', 'POST', `/v1/workflow-runs/${run.id}/cancel`)).status, 403);
    const cancelled = ok(await call('carl', 'POST', `/v1/workflow-runs/${run.id}/cancel`));
    assert.equal(cancelled.state, 'cancelled');
    ok(await call('carl', 'POST', `/v1/workflows/${id}/pause`));
  });

  test('Schleife zweier Workflows bricht bei Kettentiefe 5 ab (Vorfall sichtbar)', async () => {
    const w1 = await activeWorkflow('ada', 'Berührt → Notiz', {
      schemaVersion: 1, kind: 'automation', trigger: { event: 'order.touched', includeWorkflowEvents: true },
      steps: [{ id: 'n', action: 'order.note', input: { order: '{{event.subject.id}}' } }],
    });
    const w2 = await activeWorkflow('ada', 'Notiz → berührt', {
      schemaVersion: 1, kind: 'automation', trigger: { event: 'order.noted', includeWorkflowEvents: true },
      steps: [{ id: 't', action: 'order.touch', input: { order: '{{event.subject.id}}' } }],
    });
    const order = await newOrder(A, 'Lou', 1);
    await asUser('ada', tx => appEmit(tx, 'order.touched', order, {}));
    await drain();
    assert.deepEqual(failures, []);
    const runs = (await admin.query(`SELECT chain_depth, state, error FROM shop.workflow_run WHERE workflow_id IN ($1, $2) ORDER BY chain_depth`, [w1, w2])).rows;
    assert.deepEqual(runs.map(r => [r.chain_depth, r.state]), [[1, 'completed'], [2, 'completed'], [3, 'completed'], [4, 'completed'], [5, 'completed'], [6, 'incident']]);
    assert.equal(runs[5].error.code, 'chain-depth');
    const o = (await admin.query('SELECT touched, notes FROM shop.orders WHERE id = $1', [order])).rows[0];
    assert.deepEqual([o.touched, o.notes], [2, 3], 'fünf Aktionen');
    assert.equal(queue.length, 0, 'keine Jobs mehr');
    ok(await call('ada', 'POST', `/v1/workflows/${w1}/pause`));
    ok(await call('ada', 'POST', `/v1/workflows/${w2}/archive`));
  });

  test('Probelauf schreibt nichts und meldet je Schritt, was geschähe', async () => {
    const order = await newOrder(A, 'Dora', 300);
    const before = [await count('SELECT count(*) AS n FROM shop.workflow_run'), await count('SELECT count(*) AS n FROM shop.workflow_step'), outbox.length, audit.length, queue.length];
    const r = ok(await call('ada', 'POST', `/v1/workflows/${cancelWf}/dry-run`, { event: { type: 'order.updated', subject: { type: 'order', id: order }, data: { state: { to: 'paid' } } } }));
    assert.equal(r.triggerMatches, true);
    assert.equal(r.result, 'completed');
    assert.deepEqual(r.steps.map((s: { stepId: string; summary: string; allowed?: boolean }) => [s.stepId, s.summary, s.allowed]), [
      ['big', 'Bedingung erfüllt', undefined], ['cancel', `würde order.cancel für ${order} ausführen`, true],
    ]);
    const asCarl = ok(await call('ada', 'POST', `/v1/workflows/${cancelWf}/dry-run`, {
      definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 'w', wait: { duration: 'PT2H' } }, { id: 's', set: { done: '{{subject.values.customer}}' } }] },
      subject: { type: 'order', id: order },
    }));
    assert.deepEqual(asCarl.steps.map((s: { stepId: string }) => s.stepId), ['w', 's']);
    assert.deepEqual(asCarl.variables, { done: 'Dora' });
    const after = [await count('SELECT count(*) AS n FROM shop.workflow_run'), await count('SELECT count(*) AS n FROM shop.workflow_step'), outbox.length, audit.length, queue.length];
    assert.deepEqual(after, before);
    assert.equal((await admin.query('SELECT state FROM shop.orders WHERE id = $1', [order])).rows[0].state, 'new');
    assert.equal((await call('bea', 'POST', `/v1/workflows/${cancelWf}/dry-run`, {})).status, 403);
  });

  test('Zeitplan: tick mit der Worker-Rolle startet fällige Läufe; Warten über runAt', async () => {
    const id = await activeWorkflow('ada', 'Alle fünf Minuten', {
      schemaVersion: 1, kind: 'automation', trigger: { schedule: { cron: '*/5 * * * *', timezone: 'Europe/Zurich' } },
      steps: [{ id: 'a', set: { first: true } }, { id: 'w', wait: { duration: 'PT1H' } }, { id: 'b', set: { second: '{{vars.first}}' } }],
    });
    const trigger = (await admin.query(`SELECT id, next_at FROM shop.workflow_trigger WHERE workflow_id = $1`, [id])).rows[0];
    assert.ok(trigger.next_at > now && trigger.next_at.getTime() - now.getTime() <= 5 * 60_000);
    await admin.query(`UPDATE shop.workflow_trigger SET next_at = $2 WHERE id = $1`, [trigger.id, new Date(now.getTime() - 60_000)]);
    const tick = () => withTx({ tenant: null, principal: null, role: schedRole }, tx => wf.tick(tx));
    assert.equal(await tick(), 1);
    assert.equal(await tick(), 0, 'schon weitergeschoben');
    const moved = (await admin.query(`SELECT next_at FROM shop.workflow_trigger WHERE id = $1`, [trigger.id])).rows[0].next_at;
    assert.ok(moved > now);
    assert.deepEqual(queue.map(j => [j.kind, j.payload.tenantId]), [['workflow.start', A]]);
    await drain();
    const run = (await admin.query(`SELECT id, state, wake_at, trigger_kind FROM shop.workflow_run WHERE workflow_id = $1`, [id])).rows[0];
    assert.deepEqual([run.state, run.trigger_kind], ['waiting', 'schedule']);
    assert.equal(await drain(), 0, 'Warten: noch nicht fällig');
    now = new Date(now.getTime() + 2 * 3_600_000);
    await drain();
    const done = (await admin.query(`SELECT state, variables FROM shop.workflow_run WHERE id = $1`, [run.id])).rows[0];
    assert.deepEqual([done.state, done.variables], ['completed', { first: true, second: true }]);
    ok(await call('ada', 'POST', `/v1/workflows/${id}/pause`));
  });

  test('Manueller Start mit Formular im Namen eines Maschinen-Clients (W6)', async () => {
    const created = ok(await call('ada', 'POST', '/v1/workflows', {
      name: 'Von Hand stornieren', scope: { type: 'shop', id: 'main' },
      definition: {
        schemaVersion: 1, kind: 'automation', trigger: { manual: { form: [{ key: 'reason', label: 'Grund', type: 'text', required: true }] } },
        steps: [{ id: 'c', action: 'order.cancel', input: { order: '{{subject.id}}', reason: '{{input.reason}}' } }],
      },
    }), 201);
    assert.equal((await call('carl', 'POST', `/v1/workflows/${created.id}/activate`, { actor: { id: 'bot', kind: 'client' } })).status, 403, 'darf den Client nicht wählen');
    const activated = ok(await call('ada', 'POST', `/v1/workflows/${created.id}/activate`, { actor: { id: 'bot', kind: 'client' } }));
    assert.deepEqual(activated.actor, { id: 'bot', kind: 'client' });
    const order = await newOrder(A, 'Max', 20);
    assert.equal((await call('bea', 'POST', `/v1/workflows/${created.id}/runs`, { subject: { type: 'order', id: order } })).status, 422, 'Pflichtfeld');
    assert.equal((await call('bea', 'POST', `/v1/workflows/${created.id}/runs`, { subject: { type: 'order', id: orders.secret }, input: { reason: 'x' } })).status, 404, 'Bezug unsichtbar');
    const run = ok(await call('bea', 'POST', `/v1/workflows/${created.id}/runs`, { subject: { type: 'order', id: order }, input: { reason: 'Kundenwunsch' } }), 201);
    assert.deepEqual([run.state, run.actor, run.startedBy], ['running', { id: 'bot', kind: 'client' }, { id: 'bea', kind: 'person' }]);
    await drain();
    assert.equal((await admin.query('SELECT state FROM shop.orders WHERE id = $1', [order])).rows[0].state, 'cancelled');
    assert.equal(ok(await call('bea', 'GET', `/v1/workflow-runs/${run.id}`)).state, 'completed');
    ok(await call('ada', 'POST', `/v1/workflows/${created.id}/pause`));
  });

  test('Fortsetzen: pausierter Workflow läuft mit derselben Version und demselben Akteur weiter', async () => {
    const id = await activeWorkflow('ada', 'Pausieren und fortsetzen', {
      schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 'm', set: { ok: true } }],
    });
    assert.equal((await call('ada', 'POST', `/v1/workflows/${id}/resume`)).status, 409, 'nur pausierte');
    ok(await call('ada', 'POST', `/v1/workflows/${id}/pause`));
    const resumed = ok(await call('ada', 'POST', `/v1/workflows/${id}/resume`));
    assert.deepEqual([resumed.state, resumed.activeVersion, resumed.pausedReason, resumed.actor], ['active', 1, null, { id: 'ada', kind: 'person' }]);
    assert.equal(ok(await call('ada', 'GET', `/v1/workflows/${id}/versions`)).items.length, 1, 'keine neue Version');
    const run = ok(await call('ada', 'POST', `/v1/workflows/${id}/runs`, {}), 201);
    await drain();
    assert.equal(ok(await call('ada', 'GET', `/v1/workflow-runs/${run.id}`)).state, 'completed');
    ok(await call('ada', 'POST', `/v1/workflows/${id}/pause`));
  });

  test('Zeitplan-Vorschau: nächste Ausführungen in der Zeitzone, Fehler als Text statt 422', async () => {
    const p = ok(await call('ada', 'POST', '/v1/workflows/schedule-preview', { cron: '0 7 * * 1-5', timezone: 'Europe/Zurich', count: 3 }));
    assert.equal(p.ok, true);
    assert.equal(p.next.length, 3);
    const zurich = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    for (const t of p.next) assert.match(zurich.format(new Date(t)), /^(Mo|Di|Mi|Do|Fr)\.?,? 07:00$/);
    const bad = ok(await call('ada', 'POST', '/v1/workflows/schedule-preview', { cron: 'jeden Morgen', timezone: 'Europe/Zurich' }));
    assert.deepEqual([bad.ok, bad.next], [false, []]);
    assert.ok(bad.error);
    assert.match(ok(await call('ada', 'POST', '/v1/workflows/schedule-preview', { cron: '0 7 * * *', timezone: 'Mars/Basis' })).error, /Unbekannte Zeitzone/);
  });

  test('Fehler: Wiederholung nach onError, dann Vorfall; «überspringen» setzt fort', async () => {
    const id = await activeWorkflow('ada', 'Unzuverlässig', {
      schemaVersion: 1, kind: 'automation', trigger: { manual: {} },
      steps: [{ id: 'f', action: 'shop.flaky', onError: { retry: 1 } }, { id: 'e', set: { ok: true } }],
    });
    const run = ok(await call('ada', 'POST', `/v1/workflows/${id}/runs`, {}), 201);
    await drain();
    const mid = ok(await call('ada', 'GET', `/v1/workflow-runs/${run.id}`));
    assert.equal(mid.state, 'incident');
    assert.deepEqual(mid.steps.map((s: { attempt: number; state: string }) => [s.attempt, s.state]), [[1, 'failed'], [2, 'failed']]);
    assert.match(mid.error.message, /Gegenstelle antwortet nicht \(2\)/);
    const skipped = ok(await call('ada', 'POST', `/v1/workflow-runs/${run.id}/skip`));
    assert.equal(skipped.state, 'running');
    await drain();
    const final = ok(await call('ada', 'GET', `/v1/workflow-runs/${run.id}`));
    assert.equal(final.state, 'completed');
    assert.deepEqual(final.steps.map((s: { stepId: string; attempt: number; state: string }) => [s.stepId, s.attempt, s.state]),
      [['f', 1, 'failed'], ['f', 2, 'failed'], ['f', 3, 'skipped'], ['e', 1, 'completed']]);
    // nochmals: neuer Lauf scheitert nicht mehr (Gegenstelle wieder da)
    const again = ok(await call('ada', 'POST', `/v1/workflows/${id}/runs`, {}), 201);
    await drain();
    assert.equal(ok(await call('ada', 'GET', `/v1/workflow-runs/${again.id}`)).state, 'completed');
    assert.equal((await call('ada', 'POST', `/v1/workflow-runs/${again.id}/retry`)).status, 409, 'kein Vorfall');
  });

  test('Vorfall «nochmals»: gleicher Schritt mit neuem Versuch', async () => {
    flaky = 0;
    const id = await activeWorkflow('ada', 'Unzuverlässig ohne Wiederholung', {
      schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 'f', action: 'shop.flaky', onError: { retry: 0 } }],
    });
    const run = ok(await call('ada', 'POST', `/v1/workflows/${id}/runs`, {}), 201);
    await drain();
    assert.equal(ok(await call('ada', 'GET', `/v1/workflow-runs/${run.id}`)).state, 'incident');
    assert.equal(ok(await call('ada', 'GET', '/v1/workflows')).items.find((w: { id: string }) => w.id === id).openIncidents, 1, 'Liste zählt offene Vorfälle');
    ok(await call('ada', 'POST', `/v1/workflow-runs/${run.id}/retry`));
    await drain();
    assert.equal(ok(await call('ada', 'GET', `/v1/workflow-runs/${run.id}`)).state, 'incident', 'zweiter Fehler');
    ok(await call('ada', 'POST', `/v1/workflow-runs/${run.id}/retry`));
    await drain();
    const final = ok(await call('ada', 'GET', `/v1/workflow-runs/${run.id}`));
    assert.equal(final.state, 'completed');
    assert.deepEqual(final.steps.map((s: { attempt: number; state: string }) => [s.attempt, s.state]), [[1, 'failed'], [2, 'failed'], [3, 'completed']]);
    assert.ok(outbox.some(e => e.type === 'workflow.incident_resolved'));
  });

  test('Mandant schaltet aus: keine Läufe, Routen 404', async () => {
    const order = await newOrder(A, 'Zoe', 999);
    const runs = await count('SELECT count(*) AS n FROM shop.workflow_run');
    ok(await call('ada', 'PUT', '/v1/workflows/settings', { enabled: false }));
    await asUser('ada', tx => appEmit(tx, 'order.updated', order, { state: { from: 'new', to: 'paid' } }));
    assert.equal(queue.length, 0);
    assert.equal(await count('SELECT count(*) AS n FROM shop.workflow_run'), runs);
    assert.equal((await call('ada', 'GET', '/v1/workflows')).status, 404);
    assert.equal(ok(await call('ada', 'GET', '/v1/workflows/status')).available, false);
    assert.deepEqual(failures, []);
  });
});
