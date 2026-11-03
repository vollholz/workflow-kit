/**
 * REST-Routen der Stufe 2 unter `<prefix>`: Aufgaben (`/tasks`: Ansichten, Zähler, lesen, nehmen, zurücklegen,
 * weitergeben, erledigen, entscheiden, abbrechen, Massenaktionen), Warteschlangen (`/queues`) und Kalender
 * (`/calendars`).
 *
 * Regeln:
 * - Wie `routes.ts`: Akteur über `host.actor`, eine Transaktion `host.tx`, Rechte über `host.can`, Fehler nur über
 *   `host.error`, 404 `module-disabled` solange das Modul aus ist, Audit über den Dienst `Tasks`.
 * - Lesesicht: Die Datenbank zeigt nur Aufgaben des Mandanten, deren Lauf (Bezug) sichtbar ist oder bei denen die
 *   Person zuständig bzw. Kandidatin ist (Migration 002). Hier kommt dazu, wer eine Aufgabe sehen und bearbeiten darf:
 *   zuständig, Kandidat:in, Mitglied der Warteschlange (`host.members`) oder `task:assign`. Wer den Bezug nicht sieht,
 *   bekommt statt Titel und Beschreibung den neutralen Hinweis `HIDDEN_TITLE`.
 * - Rechte am Bezug der Aufgabe (sonst `tenantScope`): `task:work` zum Nehmen, Zurücklegen, Erledigen, Entscheiden und
 *   Weitergeben der eigenen Aufgabe an Mitglieder derselben Warteschlange; `task:assign` für alles Übrige
 *   (Weitergeben an andere, Umleiten, Abbrechen, Massenaktionen, Ansicht «alle» ohne Beteiligung). Warteschlangen und
 *   Kalender ändern nur mit `queue:manage`.
 * - Optimistische Sperre: Aufgaben mit `If-Match` (freiwillig, sonst sperrt die Zeile), Warteschlangen und Kalender
 *   zwingend beim Ändern und Löschen; Antworten tragen `ETag`.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { addWorkingTime, calendarProblems, type WorkCalendar } from './calendar.ts';
import { parseDuration } from './cron.ts';
import type { Escalation } from './definition.ts';
import type { RouteOptions } from './routes.ts';
import {
  ACTIVE_STATES, HIDDEN_TITLE, TaskError, actorKey, type CalendarRow, type Decision, type QueueRow, type TaskRow, type TimerRow, type VoteRow,
} from './tasks.ts';
import type { ActorRef, ScopeRef, SubjectRef, TeamRef, Tx } from './ports.ts';

export interface TaskRouteHelpers {
  handle<T>(req: FastifyRequest, gate: boolean, fn: (tx: Tx, actor: ActorRef) => Promise<T>): Promise<T>;
  need(tx: Tx, actor: ActorRef, perm: string, on: ScopeRef | SubjectRef): Promise<void>;
  fail(status: number, code: string, detail: string): Error;
}

/** Was der Akteur mit einer Aufgabe tun darf (auch in der Antwort, für die Oberfläche). */
export interface TaskActions { take: boolean; release: boolean; complete: boolean; decide: boolean; assign: boolean; handOver: boolean; cancel: boolean }

const iso = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : new Date(v).toISOString());
const uuid = { type: 'string', format: 'uuid' };
const ref = { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { type: 'string', minLength: 1, maxLength: 80 }, id: { type: 'string', minLength: 1, maxLength: 200 } } };
const actorRef = { type: 'object', required: ['id', 'kind'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, kind: { enum: ['person', 'client'] } } };
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } };
const assigneeSchema = {
  type: 'object', minProperties: 1, maxProperties: 1, additionalProperties: false,
  properties: { actor: actorRef, team: ref, field: { type: 'string', minLength: 1, maxLength: 300 }, queue: uuid },
};
const escalationSchema = {
  type: 'object', additionalProperties: false,
  properties: { notify: { type: 'array', maxItems: 20, items: assigneeSchema }, raisePriority: { type: 'boolean' }, queue: uuid },
};
const weekSchema = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(k => [k, {
    type: 'array', maxItems: 8, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', maxLength: 5 } },
  }])),
};
const calendarFields = {
  timezone: { type: 'string', minLength: 1, maxLength: 100 },
  week: weekSchema,
  holidays: {
    type: 'array', maxItems: 500,
    items: { type: 'object', required: ['date'], additionalProperties: false, properties: { date: { type: 'string', maxLength: 10 }, label: { type: 'string', maxLength: 200 } } },
  },
};

export function registerTaskRoutes(app: FastifyInstance, o: RouteOptions, h: TaskRouteHelpers): void {
  const { engine, host, prefix } = o;
  const tasks = engine.tasks;
  const S = (name: string) => `${o.schema}.${name}`;
  const subjects = new Map(o.subjects.map(s => [s.type, s]));
  const { handle, need, fail } = h;
  const now = () => engine.o.clock();

  /** Fehler des Dienstes in Fehler der App übersetzen. */
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (e instanceof TaskError) throw fail(e.status, e.code, e.message);
      throw e;
    }
  }

  function ifMatch(req: FastifyRequest, current: number, what: string, required: boolean, body?: { revision?: number }): void {
    const header = req.headers['if-match'];
    const fromHeader = typeof header === 'string' ? /^(?:W\/)?"?(\d+)"?$/.exec(header.trim())?.[1] : undefined;
    const expected = fromHeader !== undefined ? Number(fromHeader) : body?.revision;
    if (expected === undefined) {
      if (required) throw fail(428, 'precondition-required', 'Bitte den Stand mitschicken (If-Match oder «revision»).');
      return;
    }
    if (expected !== current) throw fail(409, 'conflict', `${what} wurde inzwischen geändert (Stand ${current}, erwartet ${expected}). Bitte neu laden.`);
  }
  const etag = (reply: FastifyReply, revision: number) => reply.header('etag', `"${revision}"`);

  /** Rechte, Mitgliedschaften und Bezüge je Anfrage (zwischengespeichert). */
  function viewer(tx: Tx, actor: ActorRef) {
    const rights = new Map<string, Promise<boolean>>();
    const member = new Map<string, Promise<boolean>>();
    const shown = new Map<string, Promise<{ title: string } | null>>();
    const me = actorKey(actor);
    const can = (perm: string, on: ScopeRef | SubjectRef) => {
      const k = `${perm}\u0000${on.type}\u0000${on.id}`;
      if (!rights.has(k)) rights.set(k, host.can(tx, actor, perm, on));
      return rights.get(k)!;
    };
    const isMember = (queueId: string) => {
      if (!member.has(queueId)) {
        member.set(queueId, (async () => {
          const q = await tasks.queue(tx, queueId);
          return !!q && (await tasks.members(tx, { type: q.team_type, id: q.team_id })).some(m => actorKey(m) === me);
        })());
      }
      return member.get(queueId)!;
    };
    /** Bezug, wie die Person ihn sieht (null = unsichtbar). */
    const subjectOf = (t: TaskRow) => {
      if (!t.subject_type || !t.subject_id) return Promise.resolve(null);
      const k = `${t.subject_type}\u0000${t.subject_id}`;
      if (!shown.has(k)) {
        const def = subjects.get(t.subject_type);
        shown.set(k, def ? def.load(tx, t.subject_id).then(s => (s ? { title: s.title } : null)) : Promise.resolve(null));
      }
      return shown.get(k)!;
    };
    const scope = (t: TaskRow): ScopeRef | SubjectRef => tasks.subjectOf(t) ?? o.tenantScope;
    async function access(t: TaskRow, voted = false): Promise<{ read: boolean; actions: TaskActions; mine: boolean; member: boolean }> {
      const mine = !!t.assignee_id && `${t.assignee_kind}:${t.assignee_id}` === me;
      const candidate = t.candidates.some(c => actorKey(c) === me);
      const inQueue = t.queue_id ? await isMember(t.queue_id) : false;
      const assign = await can('task:assign', scope(t));
      const work = await can('task:work', scope(t));
      const done = !!t.completed_by_id && `${t.completed_by_kind}:${t.completed_by_id}` === me;
      const active = ACTIVE_STATES.includes(t.state);
      const isTask = t.kind === 'task';
      const free = !t.assignee_id && (candidate || inQueue);
      return {
        read: mine || candidate || inQueue || done || assign, mine, member: inQueue,
        actions: {
          take: active && isTask && work && (free || (mine && t.state === 'open') || (assign && !mine)),
          release: active && isTask && work && !!t.assignee_id && (mine || assign) && (!!t.queue_id || t.candidates.length > 0),
          complete: active && isTask && work && (mine || free),
          decide: active && !isTask && work && candidate && !voted && (t.mode !== 'sequential' || mine),
          assign: active && isTask && assign,
          handOver: active && isTask && work && mine,
          cancel: active && assign,
        },
      };
    }
    return { can, isMember, subjectOf, access, me, scope };
  }
  type Viewer = ReturnType<typeof viewer>;

  async function taskJson(v: Viewer, t: TaskRow & { voted?: boolean; queue_name?: string | null }, a?: Awaited<ReturnType<Viewer['access']>>) {
    const access = a ?? (await v.access(t, t.voted ?? false));
    const subject = t.subject_type && t.subject_id ? await v.subjectOf(t) : null;
    const hidden = !!t.subject_type && !subject;
    const overdue = ACTIVE_STATES.includes(t.state) && !!t.due_at && new Date(t.due_at) < now();
    return {
      id: t.id, kind: t.kind, title: hidden ? HIDDEN_TITLE : t.title, description: hidden ? null : t.description, hidden,
      subject: t.subject_type && t.subject_id ? { type: t.subject_type, id: t.subject_id, title: subject?.title ?? null } : null,
      workflowId: t.workflow_id, runId: t.run_id, stepId: t.step_id, state: t.state, priority: t.priority,
      assignee: t.assignee_id ? { id: t.assignee_id, kind: t.assignee_kind } : null,
      queue: t.queue_id ? { id: t.queue_id, name: t.queue_name ?? null } : null,
      candidates: t.candidates, mode: t.mode, reasonRequired: t.kind === 'approval' ? t.reason_required : false,
      form: t.form, outcomes: t.outcomes, outcome: t.outcome, values: hidden ? null : t.form_values, reason: t.reason,
      dueAt: iso(t.due_at), breachedAt: iso(t.breached_at), overdue,
      createdAt: iso(t.created_at), updatedAt: iso(t.updated_at), assignedAt: iso(t.assigned_at), completedAt: iso(t.completed_at),
      completedBy: t.completed_by_id ? { id: t.completed_by_id, kind: t.completed_by_kind } : null,
      revision: t.revision, voted: t.voted ?? false, actions: access.actions,
    };
  }

  /** Aufgabe laden und prüfen, ob der Akteur sie sehen darf (sonst 404, um nichts zu verraten). */
  async function readable(tx: Tx, v: Viewer, actor: ActorRef, id: string, lock = false) {
    const t = await tasks.load(tx, id, lock);
    if (!t) throw fail(404, 'not-found', 'Aufgabe nicht gefunden.');
    const voted = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${S('workflow_task_vote')} WHERE task_id = $1 AND actor_id = $2 AND actor_kind = $3`,
      [t.id, actor.id, actor.kind])).rows[0]!.n > 0;
    const access = await v.access(t, voted);
    if (!access.read) throw fail(404, 'not-found', 'Aufgabe nicht gefunden.');
    return { task: Object.assign(t, { voted }), access };
  }

  async function detail(tx: Tx, v: Viewer, t: TaskRow & { voted?: boolean }, access?: Awaited<ReturnType<Viewer['access']>>) {
    const q = t.queue_id ? await tasks.queue(tx, t.queue_id) : null;
    const votes: VoteRow[] = t.kind === 'approval' ? await tasks.votes(tx, t.id) : [];
    const timer: TimerRow | null = await tasks.timer(tx, t.id);
    const json = await taskJson(v, Object.assign(t, { queue_name: q?.name ?? null }), access);
    return {
      ...json,
      votes: votes.map(x => ({ actor: { id: x.actor_id, kind: x.actor_kind }, decision: x.decision, reason: x.reason, at: iso(x.created_at) })),
      sla: timer ? {
        target: timer.target, startedAt: iso(timer.started_at), dueAt: iso(timer.due_at), breachedAt: iso(timer.breached_at),
        escalatedAt: iso(timer.escalated_at), stoppedAt: iso(timer.stopped_at), calendarId: timer.calendar_id,
      } : null,
    };
  }

  /** Warteschlangen, in denen der Akteur Mitglied ist. */
  async function myQueues(tx: Tx, v: Viewer): Promise<string[]> {
    const rows = (await tx.query<{ id: string }>(`SELECT id FROM ${S('workflow_queue')} ORDER BY name, id`)).rows;
    const out: string[] = [];
    for (const r of rows) if (await v.isMember(r.id)) out.push(r.id);
    return out;
  }

  /** Parameter einer Abfrage; mit Schlüssel nur einmal (jeder Parameter muss vorkommen, sonst kennt PostgreSQL den Typ nicht). */
  function sqlParams() {
    const params: unknown[] = [];
    const memo = new Map<string, string>();
    const p = (x: unknown, key?: string): string => {
      if (key && memo.has(key)) return memo.get(key)!;
      params.push(x);
      const s = `$${params.length}`;
      if (key) memo.set(key, s);
      return s;
    };
    return { params, p };
  }
  type Param = ReturnType<typeof sqlParams>['p'];

  /** Bedingungen der Ansichten; ein Parameter entsteht erst, wenn eine Bedingung ihn braucht. */
  function views(actor: ActorRef, queues: string[], p: Param) {
    const me = () => `${p(actor.id, 'me')}::text`;
    const kind = () => `${p(actor.kind, 'kind')}::text`;
    const meJson = () => `${p(JSON.stringify([{ id: actor.id, kind: actor.kind }]), 'meJson')}::jsonb`;
    const notVoted = () => `NOT EXISTS (SELECT 1 FROM ${S('workflow_task_vote')} v WHERE v.tenant_id = t.tenant_id AND v.task_id = t.id AND v.actor_id = ${me()} AND v.actor_kind = ${kind()})`;
    const mineActive = () => `((t.assignee_id = ${me()} AND t.assignee_kind = ${kind()}) OR (t.kind = 'approval' AND t.assignee_id IS NULL AND t.candidates @> ${meJson()} AND ${notVoted()}))`;
    const mine = () => `(${mineActive()} OR (t.state IN ('done', 'cancelled') AND t.completed_by_id = ${me()} AND t.completed_by_kind = ${kind()}))`;
    const team = () => `(t.queue_id = ANY(${p(queues, 'queues')}::uuid[]) OR (t.kind = 'task' AND t.candidates @> ${meJson()}))`;
    const involved = () => `(${mine()} OR ${team()} OR t.candidates @> ${meJson()})`;
    return { mine, mineActive, team, involved };
  }
  const at = (p: Param) => `${p(now(), 'now')}::timestamptz`;

  const order = (sort: string, p: Param): string => {
    if (sort === 'due') return 't.due_at ASC NULLS LAST, t.created_at ASC, t.id';
    if (sort === 'age') return 't.created_at ASC, t.id';
    return `(t.breached_at IS NOT NULL OR (t.state IN ('open', 'in_progress') AND t.due_at < ${at(p)})) DESC,
      CASE t.priority WHEN 'urgent' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END DESC, t.due_at ASC NULLS LAST, t.created_at ASC, t.id`;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Aufgaben

  app.get(`${prefix}/tasks`, {
    attachValidation: true,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          view: { enum: ['mine', 'team', 'all'], default: 'mine' },
          state: { enum: ['active', 'open', 'in_progress', 'done', 'cancelled', 'any'], default: 'active' },
          queueId: uuid, kind: { enum: ['task', 'approval'] }, subjectType: { type: 'string' }, subjectId: { type: 'string' },
          overdue: { type: 'boolean' }, sort: { enum: ['urgency', 'due', 'age'] },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async req => handle(req, true, async (tx, actor) => {
    const q = req.query as { view: 'mine' | 'team' | 'all'; state: string; queueId?: string; kind?: string; subjectType?: string; subjectId?: string; overdue?: boolean; sort?: string; limit: number; offset: number };
    const v = viewer(tx, actor);
    const { params, p } = sqlParams();
    const where: string[] = [];
    if (q.state === 'active') where.push(`t.state IN ('open', 'in_progress')`);
    else if (q.state !== 'any') where.push(`t.state = ${p(q.state)}`);
    if (q.queueId) where.push(`t.queue_id = ${p(q.queueId)}`);
    if (q.kind) where.push(`t.kind = ${p(q.kind)}`);
    if (q.subjectType) where.push(`t.subject_type = ${p(q.subjectType)}`);
    if (q.subjectId) where.push(`t.subject_id = ${p(q.subjectId)}`);
    if (q.overdue) where.push(`t.state IN ('open', 'in_progress') AND t.due_at < ${at(p)}`);
    const all = q.view === 'all' && (await v.can('task:assign', o.tenantScope));
    if (!all) {
      const w = views(actor, q.view === 'mine' ? [] : await myQueues(tx, v), p);
      where.push(q.view === 'mine' ? w.mine() : q.view === 'team' ? w.team() : w.involved());
    }
    let sort = q.sort;
    if (!sort && q.queueId) sort = (await tasks.queue(tx, q.queueId))?.sort;
    const voted = `EXISTS (SELECT 1 FROM ${S('workflow_task_vote')} v WHERE v.tenant_id = t.tenant_id AND v.task_id = t.id AND v.actor_id = ${p(actor.id, 'me')}::text AND v.actor_kind = ${p(actor.kind, 'kind')}::text)`;
    const sql = `SELECT t.*, qu.name AS queue_name, count(*) OVER ()::int AS total, ${voted} AS voted
         FROM ${S('workflow_task')} t LEFT JOIN ${S('workflow_queue')} qu ON qu.tenant_id = t.tenant_id AND qu.id = t.queue_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${order(sort ?? 'urgency', p)} LIMIT ${p(q.limit)} OFFSET ${p(q.offset)}`;
    const rows = (await tx.query<TaskRow & { queue_name: string | null; voted: boolean; total: number }>(sql, params)).rows;
    const items = [];
    for (const r of rows) {
      const a = await v.access(r, r.voted);
      if (a.read) items.push(await taskJson(v, r, a));
    }
    return { items, total: rows[0]?.total ?? 0, view: q.view, sort: sort ?? 'urgency' };
  }));

  app.get(`${prefix}/tasks/counts`, async req => handle(req, true, async (tx, actor) => {
    const v = viewer(tx, actor);
    const { params, p } = sqlParams();
    const w = views(actor, await myQueues(tx, v), p);
    const [mine, team, late] = [w.mineActive(), w.team(), `t.due_at < ${at(p)}`];
    const r = (await tx.query<{ mine: number; mine_overdue: number; team: number; team_overdue: number; team_unassigned: number }>(
      `SELECT count(*) FILTER (WHERE ${mine})::int AS mine, count(*) FILTER (WHERE ${mine} AND ${late})::int AS mine_overdue,
              count(*) FILTER (WHERE ${team})::int AS team, count(*) FILTER (WHERE ${team} AND ${late})::int AS team_overdue,
              count(*) FILTER (WHERE ${team} AND t.assignee_id IS NULL)::int AS team_unassigned
         FROM ${S('workflow_task')} t WHERE t.state IN ('open', 'in_progress')`, params)).rows[0]!;
    return { mine: { open: r.mine, overdue: r.mine_overdue }, team: { open: r.team, overdue: r.team_overdue, unassigned: r.team_unassigned } };
  }));

  app.get(`${prefix}/tasks/:id`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    const v = viewer(tx, actor);
    const { task, access } = await readable(tx, v, actor, (req.params as { id: string }).id);
    etag(reply, task.revision);
    return detail(tx, v, task, access);
  }));

  /** Aktion auf einer Aufgabe: laden (gesperrt), sichtbar, Stand, Recht, ausführen, Antwort mit neuem Stand. */
  const action = (name: string, body: Record<string, unknown> | null,
    fn: (tx: Tx, actor: ActorRef, v: Viewer, t: TaskRow, a: TaskActions, b: Record<string, unknown>) => Promise<TaskRow>) => {
    app.post(`${prefix}/tasks/:id/${name}`, {
      attachValidation: true,
      schema: { params: idParams, ...(body ? { body: { type: ['object', 'null'], additionalProperties: false, properties: { ...body, revision: { type: 'integer' } } } } : {}) },
    }, async (req, reply) => handle(req, true, async (tx, actor) => {
      const v = viewer(tx, actor);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { task, access } = await readable(tx, v, actor, (req.params as { id: string }).id, true);
      ifMatch(req, task.revision, 'Die Aufgabe', false, b as { revision?: number });
      const after = await run(() => fn(tx, actor, v, task, access.actions, b));
      const fresh = viewer(tx, actor);
      const again = await readable(tx, fresh, actor, after.id).catch(() => null);
      etag(reply, after.revision);
      return again ? detail(tx, fresh, again.task, again.access) : { id: after.id, state: after.state, revision: after.revision };
    }));
  };

  const denied = (what: string) => fail(403, 'forbidden', what);
  action('take', null, async (tx, actor, v, t, a) => {
    if (!a.take) {
      if (!(await v.can('task:work', v.scope(t)))) throw denied('Dir fehlt das Recht «Aufgaben erledigen» (task:work).');
      throw fail(409, 'conflict', t.kind === 'approval' ? 'Genehmigungen werden entschieden, nicht genommen.' : 'Die Aufgabe ist schon jemandem zugewiesen.');
    }
    return tasks.take(tx, t, actor);
  });

  action('release', null, async (tx, actor, _v, t, a) => {
    if (!a.release) throw fail(409, 'conflict', 'Du kannst diese Aufgabe nicht zurücklegen (nicht dir zugewiesen oder ohne Warteschlange).');
    return tasks.release(tx, t, actor);
  });

  action('assign', { assignee: { anyOf: [actorRef, { type: 'null' }] }, queueId: { anyOf: [uuid, { type: 'null' }] } }, async (tx, actor, v, t, a, b) => {
    const to = { ...(b.assignee !== undefined ? { assignee: b.assignee as ActorRef | null } : {}), ...(b.queueId !== undefined ? { queueId: b.queueId as string | null } : {}) };
    if (to.assignee === undefined && to.queueId === undefined) throw fail(422, 'invalid', 'Bitte «assignee» oder «queueId» angeben.');
    if (!a.assign) {
      // eigene Aufgabe an jemanden aus derselben Warteschlange bzw. demselben Team weitergeben
      const target = to.assignee;
      let ok = a.handOver && to.queueId === undefined && !!target;
      if (ok && target) {
        const pool = t.queue_id ? await (async () => { const q = await tasks.queue(tx, t.queue_id!); return q ? tasks.members(tx, { type: q.team_type, id: q.team_id }) : []; })() : t.candidates;
        ok = pool.some(m => actorKey(m) === actorKey(target));
      }
      if (!ok) throw denied('Dir fehlt das Recht «Aufgaben zuweisen» (task:assign).');
    }
    return tasks.assign(tx, t, actor, to);
  });

  action('complete', { outcome: { type: 'string', minLength: 1, maxLength: 64 }, values: { type: 'object' } }, async (tx, actor, v, t, a, b) => {
    if (!a.complete) {
      if (!(await v.can('task:work', v.scope(t)))) throw denied('Dir fehlt das Recht «Aufgaben erledigen» (task:work).');
      throw fail(409, 'conflict', t.kind === 'approval' ? 'Genehmigungen werden über «Entscheiden» abgeschlossen.' : ACTIVE_STATES.includes(t.state) ? 'Die Aufgabe ist jemand anderem zugewiesen.' : 'Die Aufgabe ist schon erledigt oder abgebrochen.');
    }
    return tasks.complete(tx, t, actor, b.outcome as string | undefined, b.values ?? {});
  });

  action('decide', { decision: { enum: ['approved', 'rejected'] }, reason: { type: ['string', 'null'], maxLength: 4000 } }, async (tx, actor, v, t, a, b) => {
    if (!b.decision) throw fail(422, 'invalid', 'Bitte «decision» angeben («approved» oder «rejected»).');
    if (!a.decide) {
      if (!(await v.can('task:work', v.scope(t)))) throw denied('Dir fehlt das Recht «Aufgaben erledigen» (task:work).');
      if (t.kind !== 'approval') throw fail(409, 'conflict', 'Nur Genehmigungen werden entschieden.');
      if (!ACTIVE_STATES.includes(t.state)) throw fail(409, 'conflict', 'Die Genehmigung ist schon entschieden.');
    }
    return tasks.decide(tx, t, actor, b.decision as Decision, (b.reason as string | null | undefined) ?? null);
  });

  action('cancel', { reason: { type: ['string', 'null'], maxLength: 4000 } }, async (tx, actor, _v, t, a, b) => {
    if (!a.cancel) throw denied(ACTIVE_STATES.includes(t.state) ? 'Dir fehlt das Recht «Aufgaben zuweisen» (task:assign).' : 'Die Aufgabe ist schon erledigt oder abgebrochen.');
    return tasks.cancel(tx, t, actor, (b.reason as string | null | undefined) ?? null);
  });

  app.post(`${prefix}/tasks/bulk`, {
    attachValidation: true,
    schema: {
      body: {
        type: 'object', required: ['action', 'ids'], additionalProperties: false,
        properties: {
          action: { enum: ['assign', 'cancel'] }, ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: uuid },
          assignee: { anyOf: [actorRef, { type: 'null' }] }, queueId: { anyOf: [uuid, { type: 'null' }] }, reason: { type: ['string', 'null'], maxLength: 4000 },
        },
      },
    },
  }, async req => handle(req, true, async (tx, actor) => {
    const b = req.body as { action: 'assign' | 'cancel'; ids: string[]; assignee?: ActorRef | null; queueId?: string | null; reason?: string | null };
    await need(tx, actor, 'task:assign', o.tenantScope);
    if (b.action === 'assign' && b.assignee === undefined && b.queueId === undefined) throw fail(422, 'invalid', 'Bitte «assignee» oder «queueId» angeben.');
    const v = viewer(tx, actor);
    const results: { id: string; ok: boolean; code?: string; message?: string }[] = [];
    for (const id of b.ids) {
      await tx.query('SAVEPOINT workflow_bulk');
      try {
        const t = await tasks.load(tx, id, true);
        const a = t ? await v.access(t) : null;
        if (!t || !a?.read) throw new TaskError(404, 'not-found', 'Aufgabe nicht gefunden.');
        if (b.action === 'cancel') {
          if (!a.actions.cancel) throw new TaskError(409, 'conflict', 'Die Aufgabe ist schon erledigt oder abgebrochen.');
          await tasks.cancel(tx, t, actor, b.reason ?? null);
        } else {
          if (!a.actions.assign) throw new TaskError(409, 'conflict', t.kind === 'approval' ? 'Genehmigungen lassen sich nicht weitergeben.' : 'Die Aufgabe ist schon erledigt oder abgebrochen.');
          await tasks.assign(tx, t, actor, { ...(b.assignee !== undefined ? { assignee: b.assignee } : {}), ...(b.queueId !== undefined ? { queueId: b.queueId } : {}) });
        }
        await tx.query('RELEASE SAVEPOINT workflow_bulk');
        results.push({ id, ok: true });
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT workflow_bulk');
        if (!(e instanceof TaskError)) throw e;
        results.push({ id, ok: false, code: e.code, message: e.message });
      }
    }
    return { results, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  }));

  // ---------------------------------------------------------------------------------------------------------------
  // Warteschlangen

  const queueJson = (q: QueueRow, extra: Record<string, unknown> = {}) => ({
    id: q.id, name: q.name, description: q.description, team: { type: q.team_type, id: q.team_id }, sort: q.sort, assignment: q.assignment,
    calendarId: q.calendar_id, slaTarget: q.sla_target, escalation: q.escalation, revision: q.revision, createdAt: iso(q.created_at), updatedAt: iso(q.updated_at),
    ...extra,
  });

  const queueBody = {
    type: 'object', additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: ['string', 'null'], maxLength: 4000 }, team: ref,
      sort: { enum: ['urgency', 'due', 'age'] }, assignment: { enum: ['pull', 'round_robin', 'least_load'] },
      calendarId: { anyOf: [uuid, { type: 'null' }] }, slaTarget: { type: ['string', 'null'], maxLength: 40 },
      escalation: { anyOf: [escalationSchema, { type: 'null' }] }, revision: { type: 'integer' },
    },
  };

  /** Angaben einer Warteschlange prüfen (Frist, Kalender, Ziel der Eskalation). */
  async function checkQueue(tx: Tx, b: { slaTarget?: string | null; calendarId?: string | null; escalation?: Escalation | null }, self?: string): Promise<void> {
    if (b.slaTarget) {
      try { parseDuration(b.slaTarget); } catch (e) { throw fail(422, 'invalid', `Frist: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (b.calendarId && !(await tx.query(`SELECT 1 FROM ${S('workflow_calendar')} WHERE id = $1`, [b.calendarId])).rows.length) throw fail(422, 'invalid', 'Kalender nicht gefunden.');
    const target = b.escalation?.queue;
    if (target && target !== self && !(await tasks.queue(tx, target))) throw fail(422, 'invalid', 'Warteschlange für die Eskalation nicht gefunden.');
  }

  async function queueCounts(tx: Tx): Promise<Map<string, { open: number; overdue: number; unassigned: number }>> {
    const rows = (await tx.query<{ queue_id: string; open: number; overdue: number; unassigned: number }>(
      `SELECT queue_id, count(*)::int AS open, count(*) FILTER (WHERE due_at < $1)::int AS overdue, count(*) FILTER (WHERE assignee_id IS NULL)::int AS unassigned
         FROM ${S('workflow_task')} WHERE queue_id IS NOT NULL AND state IN ('open', 'in_progress') GROUP BY queue_id`, [now()])).rows;
    return new Map(rows.map(r => [r.queue_id, { open: r.open, overdue: r.overdue, unassigned: r.unassigned }]));
  }

  app.get(`${prefix}/queues`, async req => handle(req, true, async (tx, actor) => {
    const v = viewer(tx, actor);
    const overview = (await v.can('queue:manage', o.tenantScope)) || (await v.can('task:assign', o.tenantScope));
    const rows = (await tx.query<QueueRow>(`SELECT * FROM ${S('workflow_queue')} ORDER BY name, id`)).rows;
    const counts = await queueCounts(tx);
    const items = [];
    for (const q of rows) {
      const member = await v.isMember(q.id);
      if (overview || member) items.push(queueJson(q, { member, counts: counts.get(q.id) ?? { open: 0, overdue: 0, unassigned: 0 } }));
    }
    return { items };
  }));

  app.get(`${prefix}/queues/teams`, {
    attachValidation: true,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } } },
  }, async req => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const q = req.query as { q?: string; limit: number };
    if (!host.teams) return { available: false, items: [] };
    const items = await host.teams(tx, { search: q.q ?? '', limit: q.limit });
    return { available: true, items: items.slice(0, q.limit).map(t => ({ type: t.type, id: t.id, label: t.label })) };
  }));

  async function queueOr404(tx: Tx, v: Viewer, id: string, lock = false): Promise<{ q: QueueRow; member: boolean; manage: boolean; assign: boolean }> {
    const q = await tasks.queue(tx, id, lock);
    if (!q) throw fail(404, 'not-found', 'Warteschlange nicht gefunden.');
    const [member, manage, assign] = [await v.isMember(q.id), await v.can('queue:manage', o.tenantScope), await v.can('task:assign', o.tenantScope)];
    if (!member && !manage && !assign) throw fail(404, 'not-found', 'Warteschlange nicht gefunden.');
    return { q, member, manage, assign };
  }

  app.get(`${prefix}/queues/:id`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    const { q, member } = await queueOr404(tx, viewer(tx, actor), (req.params as { id: string }).id);
    etag(reply, q.revision);
    return queueJson(q, { member, counts: (await queueCounts(tx)).get(q.id) ?? { open: 0, overdue: 0, unassigned: 0 } });
  }));

  app.get(`${prefix}/queues/:id/members`, { attachValidation: true, schema: { params: idParams } }, async req => handle(req, true, async (tx, actor) => {
    const { q } = await queueOr404(tx, viewer(tx, actor), (req.params as { id: string }).id);
    const members = await tasks.members(tx, { type: q.team_type, id: q.team_id });
    const load = (await tx.query<{ assignee_id: string; assignee_kind: string; n: number }>(
      `SELECT assignee_id, assignee_kind, count(*)::int AS n FROM ${S('workflow_task')} WHERE state IN ('open', 'in_progress') AND assignee_id = ANY($1::text[])
        GROUP BY assignee_id, assignee_kind`, [members.map(m => m.id)])).rows;
    const byKey = new Map(load.map(r => [`${r.assignee_kind}:${r.assignee_id}`, r.n]));
    return { items: members.map(m => ({ id: m.id, kind: m.kind, open: byKey.get(actorKey(m)) ?? 0 })) };
  }));

  app.post(`${prefix}/queues`, { attachValidation: true, schema: { body: { ...queueBody, required: ['name', 'team'] } } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const b = req.body as { name: string; description?: string | null; team: TeamRef; sort?: string; assignment?: string; calendarId?: string | null; slaTarget?: string | null; escalation?: Escalation | null };
    await checkQueue(tx, b);
    const id = randomUUID();
    const q = (await tx.query<QueueRow>(
      `INSERT INTO ${S('workflow_queue')} (id, name, description, team_type, team_id, sort, assignment, calendar_id, sla_target, escalation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING *`,
      [id, b.name, b.description ?? null, b.team.type, b.team.id, b.sort ?? 'urgency', b.assignment ?? 'pull', b.calendarId ?? null, b.slaTarget ?? null,
        b.escalation ? JSON.stringify(b.escalation) : null])).rows[0]!;
    await host.audit(tx, { action: 'queue.created', actor, data: { queueId: id, name: b.name, team: b.team, assignment: q.assignment } });
    etag(reply, q.revision);
    void reply.status(201);
    return queueJson(q);
  }));

  app.put(`${prefix}/queues/:id`, { attachValidation: true, schema: { params: idParams, body: queueBody } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const b = (req.body ?? {}) as { name?: string; description?: string | null; team?: TeamRef; sort?: string; assignment?: string; calendarId?: string | null; slaTarget?: string | null; escalation?: Escalation | null; revision?: number };
    const { q } = await queueOr404(tx, viewer(tx, actor), (req.params as { id: string }).id, true);
    ifMatch(req, q.revision, 'Die Warteschlange', true, b);
    await checkQueue(tx, b, q.id);
    const pick = <T>(k: keyof typeof b, cur: T): T => (b[k] === undefined ? cur : (b[k] as T));
    const after = (await tx.query<QueueRow>(
      `UPDATE ${S('workflow_queue')} SET name = $2, description = $3, team_type = $4, team_id = $5, sort = $6, assignment = $7, calendar_id = $8, sla_target = $9,
         escalation = $10::jsonb, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [q.id, pick('name', q.name), pick('description', q.description), b.team?.type ?? q.team_type, b.team?.id ?? q.team_id, pick('sort', q.sort),
        pick('assignment', q.assignment), pick('calendarId', q.calendar_id), pick('slaTarget', q.sla_target),
        (() => { const e = pick<Escalation | null>('escalation', q.escalation); return e ? JSON.stringify(e) : null; })()])).rows[0]!;
    await host.audit(tx, { action: 'queue.updated', actor, data: { queueId: q.id, fields: Object.keys(b).filter(k => k !== 'revision') } });
    etag(reply, after.revision);
    return queueJson(after);
  }));

  app.delete(`${prefix}/queues/:id`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const { q } = await queueOr404(tx, viewer(tx, actor), (req.params as { id: string }).id, true);
    ifMatch(req, q.revision, 'Die Warteschlange', true);
    const open = (await engine.asEngine(tx, () => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${S('workflow_task')} WHERE queue_id = $1 AND state IN ('open', 'in_progress')`, [q.id]))).rows[0]!.n;
    if (open) throw fail(409, 'conflict', `In der Warteschlange sind noch ${open} offene Aufgabe(n); zuerst weitergeben oder abbrechen.`);
    const used = (await tx.query(`SELECT 1 FROM ${S('workflow_queue')} WHERE escalation->>'queue' = $1::text AND id <> $1::uuid`, [q.id])).rows.length;
    if (used) throw fail(409, 'conflict', 'Eine andere Warteschlange eskaliert in diese; zuerst dort ändern.');
    await tx.query(`DELETE FROM ${S('workflow_queue')} WHERE id = $1`, [q.id]);
    await host.audit(tx, { action: 'queue.deleted', actor, data: { queueId: q.id, name: q.name } });
    return reply.status(204).send();
  }));

  // ---------------------------------------------------------------------------------------------------------------
  // Kalender

  const calendarJson = (c: CalendarRow) => ({
    id: c.id, name: c.name, timezone: c.timezone, week: c.week, holidays: c.holidays, isDefault: c.is_default, revision: c.revision,
    createdAt: iso(c.created_at), updatedAt: iso(c.updated_at),
  });
  const calendarBody = {
    type: 'object', additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, ...calendarFields, isDefault: { type: 'boolean' }, revision: { type: 'integer' } },
  };
  const checkCalendar = (c: WorkCalendar) => {
    const p = calendarProblems(c);
    if (p.length) throw fail(422, 'invalid', `Kalender ungültig: ${p.slice(0, 5).map(x => `${x.path}: ${x.message}`).join('; ')}`);
  };
  async function calendarOr404(tx: Tx, id: string, lock = false): Promise<CalendarRow> {
    const c = (await tx.query<CalendarRow>(`SELECT * FROM ${S('workflow_calendar')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!c) throw fail(404, 'not-found', 'Kalender nicht gefunden.');
    return c;
  }

  app.get(`${prefix}/calendars`, async req => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    return { items: (await tx.query<CalendarRow>(`SELECT * FROM ${S('workflow_calendar')} ORDER BY is_default DESC, name, id`)).rows.map(calendarJson) };
  }));

  app.post(`${prefix}/calendars/preview`, {
    attachValidation: true,
    schema: {
      body: {
        type: 'object', required: ['duration'], additionalProperties: false,
        properties: {
          duration: { type: 'string', minLength: 2, maxLength: 40 }, from: { type: 'string', format: 'date-time' }, calendarId: uuid,
          calendar: { type: 'object', required: ['timezone', 'week'], additionalProperties: false, properties: calendarFields },
        },
      },
    },
  }, async req => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const b = req.body as { duration: string; from?: string; calendarId?: string; calendar?: WorkCalendar };
    const cal = b.calendar ? { ...b.calendar, holidays: b.calendar.holidays ?? [] } : (await tasks.calendar(tx, b.calendarId ?? null)).calendar;
    checkCalendar(cal);
    const from = b.from ? new Date(b.from) : now();
    try { return { from: from.toISOString(), dueAt: addWorkingTime(cal, from, b.duration).toISOString() }; }
    catch (e) { throw fail(422, 'invalid', e instanceof Error ? e.message : String(e)); }
  }));

  app.get(`${prefix}/calendars/:id`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const c = await calendarOr404(tx, (req.params as { id: string }).id);
    etag(reply, c.revision);
    return calendarJson(c);
  }));

  app.post(`${prefix}/calendars`, {
    attachValidation: true, schema: { body: { ...calendarBody, required: ['name', 'timezone', 'week'] } },
  }, async (req, reply) => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const b = req.body as { name: string; timezone: string; week: WorkCalendar['week']; holidays?: WorkCalendar['holidays']; isDefault?: boolean };
    checkCalendar({ timezone: b.timezone, week: b.week, holidays: b.holidays ?? [] });
    if (b.isDefault) await tx.query(`UPDATE ${S('workflow_calendar')} SET is_default = false, revision = revision + 1, updated_at = now() WHERE is_default`);
    const c = (await tx.query<CalendarRow>(
      `INSERT INTO ${S('workflow_calendar')} (id, name, timezone, week, holidays, is_default) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
      [randomUUID(), b.name, b.timezone, JSON.stringify(b.week), JSON.stringify(b.holidays ?? []), b.isDefault ?? false])).rows[0]!;
    await host.audit(tx, { action: 'calendar.created', actor, data: { calendarId: c.id, name: c.name, isDefault: c.is_default } });
    etag(reply, c.revision);
    void reply.status(201);
    return calendarJson(c);
  }));

  app.put(`${prefix}/calendars/:id`, { attachValidation: true, schema: { params: idParams, body: calendarBody } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const b = (req.body ?? {}) as { name?: string; timezone?: string; week?: WorkCalendar['week']; holidays?: WorkCalendar['holidays']; isDefault?: boolean; revision?: number };
    const c = await calendarOr404(tx, (req.params as { id: string }).id, true);
    ifMatch(req, c.revision, 'Der Kalender', true, b);
    const next = { timezone: b.timezone ?? c.timezone, week: b.week ?? c.week, holidays: b.holidays ?? c.holidays };
    checkCalendar(next);
    if (b.isDefault && !c.is_default) await tx.query(`UPDATE ${S('workflow_calendar')} SET is_default = false, revision = revision + 1, updated_at = now() WHERE is_default`);
    const after = (await tx.query<CalendarRow>(
      `UPDATE ${S('workflow_calendar')} SET name = $2, timezone = $3, week = $4::jsonb, holidays = $5::jsonb, is_default = $6, revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [c.id, b.name ?? c.name, next.timezone, JSON.stringify(next.week), JSON.stringify(next.holidays), b.isDefault ?? c.is_default])).rows[0]!;
    await host.audit(tx, { action: 'calendar.updated', actor, data: { calendarId: c.id, fields: Object.keys(b).filter(k => k !== 'revision') } });
    etag(reply, after.revision);
    return calendarJson(after);
  }));

  app.delete(`${prefix}/calendars/:id`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    await need(tx, actor, 'queue:manage', o.tenantScope);
    const c = await calendarOr404(tx, (req.params as { id: string }).id, true);
    ifMatch(req, c.revision, 'Der Kalender', true);
    const used = (await tx.query<{ name: string }>(`SELECT name FROM ${S('workflow_queue')} WHERE calendar_id = $1 ORDER BY name LIMIT 3`, [c.id])).rows;
    if (used.length) throw fail(409, 'conflict', `Der Kalender wird noch von Warteschlangen genutzt: ${used.map(u => `«${u.name}»`).join(', ')}.`);
    await tx.query(`DELETE FROM ${S('workflow_calendar')} WHERE id = $1`, [c.id]);
    await host.audit(tx, { action: 'calendar.deleted', actor, data: { calendarId: c.id, name: c.name } });
    return reply.status(204).send();
  }));
}
