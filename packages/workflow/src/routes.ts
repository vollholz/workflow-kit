/**
 * REST-Routen des Baukastens unter `<prefix>` (Standard `/v1`): Workflows (Entwurf, Prüfen, Aktivieren, Pausieren,
 * Fortsetzen, Archivieren, Versionen), manueller Start, Probelauf, Läufe mit Schrittprotokoll, Vorfälle, Einstellungen, Status und
 * Angaben für den Editor (`meta`: angemeldete Ereignisse, Aktionen, Bezugstypen mit Feldern). Aufgaben, Warteschlangen und Kalender
 * (Stufe 2) stehen in `task-routes.ts` und nutzen dieselben Hilfen (`handle`, `need`, `fail`).
 *
 * Regeln:
 * - Jede Route liest den Akteur über `host.actor(req)` und arbeitet in genau einer Transaktion `host.tx(req, …)`.
 * - Rechte nur über `host.can` mit den Namen aus `workflowPermissions`, am Bereich des Workflows (Einstellungen und
 *   Läufe ohne Workflow am Bereich `tenantScope`). Läufe sieht nur, wer den Bezug sieht (RLS) und `workflow:read` hat.
 * - Fehler nur über `host.error(status, code, detail)` mit deutschem Text; Codes: `invalid`, `invalid-definition`,
 *   `forbidden`, `not-found`, `conflict`, `precondition-required`, `module-disabled`, `limit`.
 * - Ausser Status, Meta und Einstellungen antworten alle Routen mit 404 `module-disabled`, solange das Modul in der
 *   Umgebung oder im Mandanten ausgeschaltet ist (Meta und Einstellungen nur in der Umgebung).
 * - Jede Änderung geht ins Audit (`host.audit`); Aktivieren, Pausieren, Archivieren melden zusätzlich `workflow.*`.
 *   Fortsetzen startet die aktive Version wieder (keine neue Version, gleicher Akteur) und meldet `workflow.activated`
 *   mit `resumed: true`.
 * - Entwürfe mit optimistischer Sperre: `If-Match: "<revision>"` oder `revision` im Körper; die Antwort trägt `ETag`.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isValidTimeZone, nextCronTime } from './cron.ts';
import { DEFINITION_SCHEMA_VERSION, STEP_KINDS, validateDefinition, walkSteps, type DefinitionError, type WorkflowDefinition } from './definition.ts';
import { definitionChecksum, stageProblems, type Engine, type RunRow, type TenantSettings, type WorkflowRow } from './engine.ts';
import { WORKFLOW_EVENT_TYPES } from './events.ts';
import { CONDITION_OPS, FORMATTERS, UNARY_OPS } from './expressions.ts';
import { workflowPermissions } from './permissions.ts';
import { registerTaskRoutes } from './task-routes.ts';
import type {
  ActorRef, EventSource, FieldDef, FieldKind, JsonSchema, ScopeRef, StateField, SubjectRef, Tx, WorkflowAction, WorkflowHost, WorkflowLimits,
  WorkflowSubject,
} from './ports.ts';

export interface RouteOptions {
  engine: Engine;
  host: WorkflowHost;
  schema: string;
  prefix: string;
  enabled: boolean;
  stage: number;
  version: string;
  tenantScope: ScopeRef;
  subjects: WorkflowSubject[];
  actions: WorkflowAction[];
  events: EventSource[];
  stateFields: StateField[];
  fields: FieldKind[];
  validate(definition: unknown): ReturnType<typeof validateDefinition>;
}

/** Antwort von `GET <prefix>/workflows/status`. */
export interface WorkflowStatus {
  /** Modul ist eingebunden. */
  configured: true;
  /** Modul ist in dieser Umgebung eingeschaltet. */
  enabled: boolean;
  /** Engine steht bereit und der Mandant hat Workflows eingeschaltet. */
  available: boolean;
  stage: number;
  version: string;
}

/**
 * Antwort von `GET <prefix>/workflows/meta`: was die App angemeldet hat, für den Editor der Oberfläche. Felder der
 * Bezugstypen gelten für den angefragten Bereich (`scopeType`/`scopeId`, sonst `tenantScope`).
 */
export interface WorkflowMeta {
  stage: number;
  /** Ereignistypen der App, danach die des Baukastens (`builtin: true`, nur mit `includeWorkflowEvents` wirksam). */
  events: { type: string; label: string; description: string | null; subjectType: string | null; filterFields: FieldDef[]; builtin: boolean }[];
  actions: { key: string; label: string; group: string; input: JsonSchema; output: JsonSchema | null }[];
  subjectTypes: { type: string; label: string; fields: FieldDef[] }[];
  stateFields: { subjectType: string; key: string; label: string }[];
  fieldKinds: { key: string; label: string; valueSchema: JsonSchema }[];
  /** Schrittarten, die diese Stufe ausführt. */
  stepKinds: string[];
  operators: string[];
  unaryOperators: string[];
  formatters: string[];
  /** Kann beim Aktivieren ein anderer Akteur gewählt werden (`host.canActAs`)? */
  canActAs: boolean;
  /** Bietet die App eine Auswahl von Teams an (`host.teams`, `GET /queues/teams`)? */
  teams: boolean;
}

const LIMIT_KEYS = ['activeWorkflows', 'runsPerDay', 'stepsPerRun', 'foreachItems', 'httpCallsPerDay', 'chainDepth', 'runsPerSubjectPerMinute'] as const;
const PERM_LABEL = new Map<string, string>(workflowPermissions.map(p => [p.name, p.label]));

const ref = { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { type: 'string', minLength: 1, maxLength: 80 }, id: { type: 'string', minLength: 1, maxLength: 200 } } };
const actorRef = { type: 'object', required: ['id', 'kind'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, kind: { enum: ['person', 'client'] } } };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };

const iso = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : new Date(v).toISOString());

function workflowJson(w: WorkflowRow, withDefinition: boolean) {
  return {
    id: w.id, name: w.name, description: w.description, kind: w.kind, scope: { type: w.scope_type, id: w.scope_id }, state: w.state,
    revision: w.revision, activeVersion: w.active_version, actor: w.actor_id && w.actor_kind ? { id: w.actor_id, kind: w.actor_kind } : null,
    pausedReason: w.paused_reason, createdBy: { id: w.created_by_id, kind: w.created_by_kind }, createdAt: iso(w.created_at), updatedAt: iso(w.updated_at),
    ...(withDefinition ? { definition: w.draft } : {}),
  };
}

/**
 * Angaben für die Liste: Auslöser und Zahl der Schritte dessen, was läuft (aktive Version, sonst Entwurf), ob der Entwurf
 * von der aktiven Version abweicht, und die Zahl der Läufe mit offenem Vorfall.
 */
function listJson(w: WorkflowRow & { active_definition: unknown; active_checksum: string | null; open_incidents: number }) {
  const def = (w.active_definition ?? w.draft) as { trigger?: unknown; steps?: unknown } | null;
  const steps = def && Array.isArray(def.steps) ? [...walkSteps(def.steps as never, '/steps')].length : 0;
  return {
    ...workflowJson(w, false),
    trigger: def?.trigger ?? null, stepCount: steps,
    draftChanged: w.active_checksum !== null && definitionChecksum(w.draft) !== w.active_checksum,
    openIncidents: w.open_incidents,
  };
}

function runJson(r: RunRow) {
  return {
    id: r.id, workflowId: r.workflow_id, version: r.version, triggerKind: r.trigger_kind, trigger: r.trigger,
    subject: r.subject_type && r.subject_id ? { type: r.subject_type, id: r.subject_id } : null, actor: { id: r.actor_id, kind: r.actor_kind },
    startedBy: r.started_by_id ? { id: r.started_by_id, kind: r.started_by_kind } : null, state: r.state, position: r.cursor,
    attempts: r.attempts, stepCount: r.step_count, chainDepth: r.chain_depth, parentRunId: r.parent_run_id, correlationId: r.correlation_id,
    variables: r.variables, error: r.error, wakeAt: iso(r.wake_at), startedAt: iso(r.started_at), updatedAt: iso(r.updated_at), finishedAt: iso(r.finished_at),
  };
}

const encodeCursor = (at: Date | string, id: string) => Buffer.from(JSON.stringify([iso(at), id])).toString('base64url');
function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' ? [v[0], v[1]] : null;
  } catch { return null; }
}

export function registerRoutes(app: FastifyInstance, o: RouteOptions): void {
  const { engine, host, prefix } = o;
  const S = (name: string) => `${o.schema}.${name}`;
  const subjects = new Map(o.subjects.map(s => [s.type, s]));
  const fail = (status: number, code: string, detail: string) => host.error(status, code, detail);

  const problems = (errors: DefinitionError[]) => errors.slice(0, 5).map(e => `${e.path}: ${e.message}`).join('; ') + (errors.length > 5 ? ` (und ${errors.length - 5} weitere)` : '');

  async function need(tx: Tx, actor: ActorRef, perm: string, on: ScopeRef | SubjectRef): Promise<void> {
    if (!(await host.can(tx, actor, perm, on))) throw fail(403, 'forbidden', `Dir fehlt das Recht «${PERM_LABEL.get(perm) ?? perm}» (${perm}).`);
  }

  /** Transaktion mit Akteur; mit `gate` nur, wenn das Modul in Umgebung und Mandant eingeschaltet ist. */
  async function handle<T>(req: FastifyRequest, gate: boolean, fn: (tx: Tx, actor: ActorRef, settings: TenantSettings | null) => Promise<T>): Promise<T> {
    const actor = host.actor(req);
    if (req.validationError) {
      const v = req.validationError as { validation?: { instancePath?: string; message?: string }[] };
      const first = v.validation?.[0];
      throw fail(422, 'invalid', `Ungültige Eingabe${first ? ` bei «${first.instancePath || '/'}»: ${first.message ?? ''}` : ''}`.trim());
    }
    if (gate && !o.enabled) throw fail(404, 'module-disabled', 'Workflows sind in dieser Umgebung ausgeschaltet.');
    return host.tx(req, async tx => {
      let settings: TenantSettings | null = null;
      if (gate) {
        settings = await engine.settings(tx);
        if (!settings.enabled) throw fail(404, 'module-disabled', 'Workflows sind für diesen Mandanten nicht eingeschaltet.');
      }
      return fn(tx, actor, settings);
    });
  }

  async function loadWorkflow(tx: Tx, id: string, lock = false): Promise<WorkflowRow> {
    const w = (await tx.query<WorkflowRow>(`SELECT * FROM ${S('workflow')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!w) throw fail(404, 'not-found', 'Workflow nicht gefunden.');
    return w;
  }
  const scopeOf = (w: WorkflowRow): ScopeRef => ({ type: w.scope_type, id: w.scope_id });

  /** Workflow lesen, wenn der Akteur ihn sehen darf (sonst 404, um nichts zu verraten). */
  async function readable(tx: Tx, actor: ActorRef, id: string): Promise<WorkflowRow> {
    const w = await loadWorkflow(tx, id);
    if (!(await host.can(tx, actor, 'workflow:read', scopeOf(w)))) throw fail(404, 'not-found', 'Workflow nicht gefunden.');
    return w;
  }

  function expectRevision(req: FastifyRequest, body: { revision?: number } | undefined, current: number): void {
    const header = req.headers['if-match'];
    const fromHeader = typeof header === 'string' ? /^(?:W\/)?"?(\d+)"?$/.exec(header.trim())?.[1] : undefined;
    const expected = fromHeader !== undefined ? Number(fromHeader) : body?.revision;
    if (expected === undefined) throw fail(428, 'precondition-required', 'Bitte den Stand mitschicken (If-Match oder «revision»).');
    if (expected !== current) throw fail(409, 'conflict', `Der Workflow wurde inzwischen geändert (Stand ${current}, erwartet ${expected}). Bitte neu laden.`);
  }

  const etag = (reply: FastifyReply, w: WorkflowRow) => reply.header('etag', `"${w.revision}"`);

  async function audit(tx: Tx, action: string, actor: ActorRef, w: Pick<WorkflowRow, 'id'> | null, data: Record<string, unknown> = {}, runId?: string) {
    await host.audit(tx, { action, actor, workflowId: w?.id ?? null, runId: runId ?? null, data });
  }

  /** Bezug prüfen: registrierter Typ und für den Akteur sichtbar (`load` ≠ null). */
  async function subjectOrFail(tx: Tx, s: SubjectRef): Promise<SubjectRef> {
    const def = subjects.get(s.type);
    if (!def || !(await def.load(tx, s.id))) throw fail(404, 'not-found', 'Bezug nicht gefunden.');
    return { type: s.type, id: s.id };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Status und Einstellungen

  app.get(`${prefix}/workflows/status`, async req => {
    host.actor(req); // nur angemeldet; die App wirft ihren eigenen Fehler
    const tenantEnabled = o.enabled ? await host.tx(req, async tx => (await engine.settings(tx)).enabled) : false;
    const status: WorkflowStatus = { configured: true, enabled: o.enabled, available: o.enabled && tenantEnabled, stage: o.stage, version: o.version };
    return status;
  });

  app.get(`${prefix}/workflows/meta`, {
    attachValidation: true,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { scopeType: { type: 'string', minLength: 1 }, scopeId: { type: 'string', minLength: 1 } } } },
  }, async req => handle(req, false, async (tx, actor) => {
    if (!o.enabled) throw fail(404, 'module-disabled', 'Workflows sind in dieser Umgebung ausgeschaltet.');
    const q = req.query as { scopeType?: string; scopeId?: string };
    if ((q.scopeType === undefined) !== (q.scopeId === undefined)) throw fail(422, 'invalid', 'Bitte «scopeType» und «scopeId» zusammen angeben.');
    const scope: ScopeRef = q.scopeType && q.scopeId ? { type: q.scopeType, id: q.scopeId } : o.tenantScope;
    await need(tx, actor, 'workflow:read', scope);
    const subjectTypes = [];
    for (const s of o.subjects) subjectTypes.push({ type: s.type, label: s.label, fields: await s.fields(tx, scope) });
    const meta: WorkflowMeta = {
      stage: o.stage,
      events: [
        ...o.events.map(e => ({ type: e.type, label: e.label, description: e.description ?? null, subjectType: e.subjectType ?? null, filterFields: e.filterFields ?? [], builtin: false })),
        ...WORKFLOW_EVENT_TYPES.map(e => ({ type: e.type, label: e.description, description: null, subjectType: null, filterFields: [], builtin: true })),
      ],
      actions: o.actions.map(a => ({ key: a.key, label: a.label, group: a.group, input: a.input, output: a.output ?? null })),
      subjectTypes,
      stateFields: o.stateFields.map(f => ({ subjectType: f.subjectType, key: f.key, label: f.label })),
      fieldKinds: o.fields.map(f => ({ key: f.key, label: f.label, valueSchema: f.valueSchema })),
      stepKinds: STEP_KINDS.filter(k => k !== 'subflow'),
      operators: [...CONDITION_OPS], unaryOperators: [...UNARY_OPS], formatters: [...FORMATTERS],
      canActAs: typeof host.canActAs === 'function',
      teams: typeof host.teams === 'function',
    };
    return meta;
  }));

  const settingsJson = async (tx: Tx, s: TenantSettings) => {
    const usage = (await tx.query<{ runs: number; runs_rejected: number; steps: number; http_calls: number }>(
      `SELECT runs, runs_rejected, steps, http_calls FROM ${S('workflow_usage')} WHERE day = $1::date`, [new Date().toISOString().slice(0, 10)])).rows[0];
    const active = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${S('workflow')} WHERE state = 'active'`)).rows[0]?.n ?? 0;
    return {
      enabled: s.enabled, limits: s.limits, overrides: s.overrides, maxLimits: engine.o.limits, revision: s.revision,
      usage: { day: new Date().toISOString().slice(0, 10), runs: usage?.runs ?? 0, runsRejected: usage?.runs_rejected ?? 0, steps: usage?.steps ?? 0, httpCalls: usage?.http_calls ?? 0, activeWorkflows: active },
    };
  };

  app.get(`${prefix}/workflows/settings`, async req => handle(req, false, async (tx, actor) => {
    if (!o.enabled) throw fail(404, 'module-disabled', 'Workflows sind in dieser Umgebung ausgeschaltet.');
    await need(tx, actor, 'workflow:admin', o.tenantScope);
    return settingsJson(tx, await engine.settings(tx));
  }));

  app.put(`${prefix}/workflows/settings`, {
    attachValidation: true,
    schema: {
      body: {
        type: 'object', required: ['enabled'], additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' }, revision: { type: 'integer' },
          limits: { type: 'object', additionalProperties: false, properties: Object.fromEntries(LIMIT_KEYS.map(k => [k, { type: 'integer', minimum: 1 }])) },
        },
      },
    },
  }, async req => handle(req, false, async (tx, actor) => {
    if (!o.enabled) throw fail(404, 'module-disabled', 'Workflows sind in dieser Umgebung ausgeschaltet.');
    await need(tx, actor, 'workflow:admin', o.tenantScope);
    const body = req.body as { enabled: boolean; revision?: number; limits?: Partial<WorkflowLimits> };
    const current = await engine.settings(tx);
    if (body.revision !== undefined && current.exists && body.revision !== current.revision) {
      throw fail(409, 'conflict', `Die Einstellungen wurden inzwischen geändert (Stand ${current.revision}). Bitte neu laden.`);
    }
    const limits = body.limits ?? current.overrides;
    for (const [k, v] of Object.entries(limits)) {
      const max = engine.o.limits[k as keyof WorkflowLimits];
      if (typeof v === 'number' && v > max) throw fail(422, 'invalid', `Grenze «${k}» höchstens ${max} (Vorgabe der App).`);
    }
    await tx.query(
      `INSERT INTO ${S('workflow_settings')} AS s (enabled, limits, updated_by_id) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = $1, limits = $2::jsonb, updated_by_id = $3, updated_at = now(),
         revision = s.revision + 1, version = s.version + 1`,
      [body.enabled, JSON.stringify(limits), actor.id]);
    const tenant = await engine.tenantOf(tx);
    engine.invalidate(tenant);
    await host.audit(tx, { action: 'workflow.settings_changed', actor, data: { enabled: body.enabled, limits, before: { enabled: current.enabled, limits: current.overrides } } });
    return settingsJson(tx, await engine.settings(tx));
  }));

  // ---------------------------------------------------------------------------------------------------------------
  // Workflows

  app.post(`${prefix}/workflows/validate`, {
    attachValidation: true,
    schema: { body: { type: 'object', required: ['definition'], properties: { definition: {} } } },
  }, async req => handle(req, true, async () => {
    const r = o.validate((req.body as { definition: unknown }).definition);
    if (!r.ok) return { ok: false, errors: r.errors, stage: [], warnings: r.warnings };
    const stage = stageProblems(r.definition);
    return { ok: !stage.length, errors: [], stage, warnings: r.warnings };
  }));

  // Nächste Ausführungen eines Zeitplans (Editor): Zeitzone und Sommerzeit rechnet nur der Server.
  app.post(`${prefix}/workflows/schedule-preview`, {
    attachValidation: true,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['cron', 'timezone'],
        properties: { cron: { type: 'string', maxLength: 200 }, timezone: { type: 'string', maxLength: 100 }, count: { type: 'integer', minimum: 1, maximum: 10, default: 5 } },
      },
    },
  }, async req => handle(req, true, async () => {
    const b = req.body as { cron: string; timezone: string; count: number };
    if (!isValidTimeZone(b.timezone)) return { ok: false, error: `Unbekannte Zeitzone «${b.timezone}»`, next: [] };
    const next: string[] = [];
    try {
      let at = new Date();
      for (let i = 0; i < b.count; i++) { at = nextCronTime(b.cron, b.timezone, at); next.push(at.toISOString()); }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), next: [] };
    }
    return { ok: true, error: null, next };
  }));

  app.get(`${prefix}/workflows`, {
    attachValidation: true,
    schema: { querystring: { type: 'object', properties: { state: { enum: ['draft', 'active', 'paused', 'archived'] }, scopeType: { type: 'string' }, scopeId: { type: 'string' } } } },
  }, async req => handle(req, true, async (tx, actor) => {
    const q = req.query as { state?: string; scopeType?: string; scopeId?: string };
    const rows = (await tx.query<WorkflowRow & { active_definition: unknown; active_checksum: string | null; open_incidents: number }>(
      `SELECT w.*, v.definition AS active_definition, v.checksum AS active_checksum,
              (SELECT count(*)::int FROM ${S('workflow_run')} r WHERE r.workflow_id = w.id AND r.state = 'incident') AS open_incidents
         FROM ${S('workflow')} w LEFT JOIN ${S('workflow_version')} v ON v.workflow_id = w.id AND v.version = w.active_version
        WHERE ($1::text IS NULL OR w.state = $1) AND ($2::text IS NULL OR w.scope_type = $2) AND ($3::text IS NULL OR w.scope_id = $3)
        ORDER BY w.name, w.id`, [q.state ?? null, q.scopeType ?? null, q.scopeId ?? null])).rows;
    const allowed = new Map<string, boolean>();
    const items = [];
    for (const w of rows) {
      const key = `${w.scope_type}\u0000${w.scope_id}`;
      if (!allowed.has(key)) allowed.set(key, await host.can(tx, actor, 'workflow:read', scopeOf(w)));
      if (allowed.get(key)) items.push(listJson(w));
    }
    return { items };
  }));

  app.post(`${prefix}/workflows`, {
    attachValidation: true,
    schema: {
      body: {
        type: 'object', required: ['name', 'scope'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 4000 }, scope: ref, definition: { type: 'object' } },
      },
    },
  }, async (req, reply) => handle(req, true, async (tx, actor) => {
    const body = req.body as { name: string; description?: string; scope: ScopeRef; definition?: Record<string, unknown> };
    await need(tx, actor, 'workflow:manage', body.scope);
    const definition = body.definition ?? { schemaVersion: DEFINITION_SCHEMA_VERSION, kind: 'automation', trigger: { manual: {} }, steps: [] };
    const kind = typeof definition.kind === 'string' && ['automation', 'case', 'state_model'].includes(definition.kind) ? definition.kind : 'automation';
    const id = randomUUID();
    await tx.query(
      `INSERT INTO ${S('workflow')} (id, name, description, kind, scope_type, scope_id, draft, created_by_id, created_by_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [id, body.name, body.description ?? null, kind, body.scope.type, body.scope.id, JSON.stringify(definition), actor.id, actor.kind]);
    await audit(tx, 'workflow.created', actor, { id }, { name: body.name, scope: body.scope });
    const w = await loadWorkflow(tx, id);
    etag(reply, w);
    void reply.status(201);
    return { ...workflowJson(w, true), validation: o.validate(definition) };
  }));

  app.get(`${prefix}/workflows/:id`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    const w = await readable(tx, actor, (req.params as { id: string }).id);
    etag(reply, w);
    return workflowJson(w, true);
  }));

  app.put(`${prefix}/workflows/:id`, {
    attachValidation: true,
    schema: {
      params: idParams,
      body: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: ['string', 'null'], maxLength: 4000 }, definition: { type: 'object' }, revision: { type: 'integer' } },
      },
    },
  }, async (req, reply) => handle(req, true, async (tx, actor) => {
    const body = (req.body ?? {}) as { name?: string; description?: string | null; definition?: Record<string, unknown>; revision?: number };
    const w = await readable(tx, actor, (req.params as { id: string }).id);
    await need(tx, actor, 'workflow:manage', scopeOf(w));
    const locked = await loadWorkflow(tx, w.id, true);
    expectRevision(req, body, locked.revision);
    if (locked.state === 'archived') throw fail(409, 'conflict', 'Ein archivierter Workflow kann nicht mehr geändert werden.');
    const definition = body.definition ?? (locked.draft as Record<string, unknown>);
    const kind = typeof definition.kind === 'string' && ['automation', 'case', 'state_model'].includes(definition.kind) ? definition.kind : locked.kind;
    await tx.query(
      `UPDATE ${S('workflow')} SET name = $2, description = $3, draft = $4::jsonb, kind = $5, revision = revision + 1, updated_at = now() WHERE id = $1`,
      [w.id, body.name ?? locked.name, body.description === undefined ? locked.description : body.description, JSON.stringify(definition), kind]);
    await audit(tx, 'workflow.updated', actor, w, { revision: locked.revision + 1, fields: Object.keys(body).filter(k => k !== 'revision') });
    const after = await loadWorkflow(tx, w.id);
    etag(reply, after);
    return { ...workflowJson(after, true), validation: o.validate(definition) };
  }));

  app.delete(`${prefix}/workflows/:id`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor) => {
    const w = await readable(tx, actor, (req.params as { id: string }).id);
    await need(tx, actor, 'workflow:manage', scopeOf(w));
    if (w.state !== 'draft' || w.active_version !== null) throw fail(409, 'conflict', 'Nur Entwürfe, die nie aktiv waren, lassen sich löschen; sonst archivieren.');
    expectRevision(req, undefined, w.revision);
    await tx.query(`DELETE FROM ${S('workflow')} WHERE id = $1`, [w.id]);
    await audit(tx, 'workflow.deleted', actor, w, { name: w.name });
    return reply.status(204).send();
  }));

  app.post(`${prefix}/workflows/:id/activate`, {
    attachValidation: true,
    schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { actor: actorRef, revision: { type: 'integer' } } } },
  }, async (req, reply) => handle(req, true, async (tx, actor, settings) => {
    const body = (req.body ?? {}) as { actor?: ActorRef; revision?: number };
    const w = await readable(tx, actor, (req.params as { id: string }).id);
    await need(tx, actor, 'workflow:activate', scopeOf(w));
    const locked = await loadWorkflow(tx, w.id, true);
    if (body.revision !== undefined || req.headers['if-match']) expectRevision(req, body, locked.revision);
    if (locked.state === 'archived') throw fail(409, 'conflict', 'Ein archivierter Workflow kann nicht aktiviert werden.');
    const target = body.actor ?? actor;
    if (target.id !== actor.id || target.kind !== actor.kind) {
      if (!host.canActAs || !(await host.canActAs(tx, actor, target))) {
        throw fail(403, 'forbidden', 'Du darfst diesen Akteur nicht wählen; nur dich selbst oder einen Maschinen-Client, den du verwalten darfst.');
      }
    }
    if (!(await host.active(tx, target))) throw fail(422, 'invalid', 'Der gewählte Akteur ist nicht aktiv.');
    const r = o.validate(locked.draft);
    if (!r.ok) throw fail(422, 'invalid-definition', `Die Definition ist ungültig: ${problems(r.errors)}`);
    const stage = stageProblems(r.definition);
    if (stage.length) throw fail(422, 'invalid-definition', `Noch nicht ausführbar: ${problems(stage)}`);
    const def: WorkflowDefinition = r.definition;
    if (def.kind === 'automation' && 'schedule' in def.trigger) {
      if (!isValidTimeZone(def.trigger.schedule.timezone)) throw fail(422, 'invalid-definition', `/trigger/schedule/timezone: Unbekannte Zeitzone «${def.trigger.schedule.timezone}»`);
      try { nextCronTime(def.trigger.schedule.cron, def.trigger.schedule.timezone, new Date()); }
      catch (e) { throw fail(422, 'invalid-definition', `/trigger/schedule/cron: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (locked.state !== 'active') {
      const active = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${S('workflow')} WHERE state = 'active'`)).rows[0]?.n ?? 0;
      if (active >= settings!.limits.activeWorkflows) throw fail(409, 'limit', `Höchstens ${settings!.limits.activeWorkflows} aktive Workflows je Mandant.`);
    }
    const version = ((await tx.query<{ n: number }>(`SELECT coalesce(max(version), 0)::int AS n FROM ${S('workflow_version')} WHERE workflow_id = $1`, [w.id])).rows[0]?.n ?? 0) + 1;
    const checksum = definitionChecksum(def);
    await tx.query(
      `INSERT INTO ${S('workflow_version')} (tenant_id, workflow_id, version, definition, schema_version, checksum, actor_id, actor_kind, activated_by_id, activated_by_kind)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
      [locked.tenant_id, w.id, version, JSON.stringify(def), def.schemaVersion, checksum, target.id, target.kind, actor.id, actor.kind]);
    await tx.query(
      `UPDATE ${S('workflow')} SET state = 'active', active_version = $2, actor_id = $3, actor_kind = $4, paused_reason = NULL, kind = $5,
         revision = revision + 1, updated_at = now() WHERE id = $1`, [w.id, version, target.id, target.kind, def.kind]);
    await engine.rebuildTriggers(tx, locked, version, def);
    await host.emit(tx, 'workflow.activated', null, { workflowId: w.id, version, actor: target });
    await host.audit(tx, { action: 'workflow.activated', actor, onBehalfOf: target, workflowId: w.id, data: { version, checksum } });
    const after = await loadWorkflow(tx, w.id);
    etag(reply, after);
    return workflowJson(after, true);
  }));

  for (const action of ['pause', 'archive'] as const) {
    app.post(`${prefix}/workflows/:id/${action}`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor) => {
      const w = await readable(tx, actor, (req.params as { id: string }).id);
      await need(tx, actor, 'workflow:activate', scopeOf(w));
      const locked = await loadWorkflow(tx, w.id, true);
      if (action === 'pause') {
        if (locked.state !== 'active') throw fail(409, 'conflict', 'Nur aktive Workflows lassen sich pausieren.');
        await engine.pause(tx, locked, null, actor);
      } else {
        if (locked.state === 'archived') throw fail(409, 'conflict', 'Der Workflow ist schon archiviert.');
        await tx.query(`UPDATE ${S('workflow')} SET state = 'archived', revision = revision + 1, updated_at = now() WHERE id = $1`, [w.id]);
        await engine.rebuildTriggers(tx, locked, null, null);
        await host.emit(tx, 'workflow.archived', null, { workflowId: w.id, version: locked.active_version });
        await audit(tx, 'workflow.archived', actor, w);
      }
      const after = await loadWorkflow(tx, w.id);
      etag(reply, after);
      return workflowJson(after, true);
    }));
  }

  app.post(`${prefix}/workflows/:id/resume`, { attachValidation: true, schema: { params: idParams } }, async (req, reply) => handle(req, true, async (tx, actor, settings) => {
    const w = await readable(tx, actor, (req.params as { id: string }).id);
    await need(tx, actor, 'workflow:activate', scopeOf(w));
    const locked = await loadWorkflow(tx, w.id, true);
    if (locked.state !== 'paused' || locked.active_version === null || !locked.actor_id || !locked.actor_kind) {
      throw fail(409, 'conflict', 'Nur pausierte Workflows mit einer aktiven Version lassen sich fortsetzen.');
    }
    const target: ActorRef = { id: locked.actor_id, kind: locked.actor_kind };
    if (!(await host.active(tx, target))) throw fail(422, 'invalid', 'Der Akteur des Workflows ist nicht mehr aktiv. Aktiviere den Workflow mit einem anderen Akteur.');
    const active = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${S('workflow')} WHERE state = 'active'`)).rows[0]?.n ?? 0;
    if (active >= settings!.limits.activeWorkflows) throw fail(409, 'limit', `Höchstens ${settings!.limits.activeWorkflows} aktive Workflows je Mandant.`);
    const v = (await tx.query<{ definition: WorkflowDefinition }>(
      `SELECT definition FROM ${S('workflow_version')} WHERE workflow_id = $1 AND version = $2`, [w.id, locked.active_version])).rows[0];
    if (!v) throw fail(409, 'conflict', 'Die aktive Version fehlt.');
    await tx.query(`UPDATE ${S('workflow')} SET state = 'active', paused_reason = NULL, revision = revision + 1, updated_at = now() WHERE id = $1`, [w.id]);
    await engine.rebuildTriggers(tx, locked, locked.active_version, v.definition);
    await host.emit(tx, 'workflow.activated', null, { workflowId: w.id, version: locked.active_version, actor: target, resumed: true });
    await host.audit(tx, { action: 'workflow.resumed', actor, onBehalfOf: target, workflowId: w.id, data: { version: locked.active_version } });
    const after = await loadWorkflow(tx, w.id);
    etag(reply, after);
    return workflowJson(after, true);
  }));

  app.get(`${prefix}/workflows/:id/versions`, { attachValidation: true, schema: { params: idParams } }, async req => handle(req, true, async (tx, actor) => {
    const w = await readable(tx, actor, (req.params as { id: string }).id);
    const rows = (await tx.query<{ version: number; checksum: string; schema_version: number; actor_id: string; actor_kind: string; activated_by_id: string; activated_by_kind: string; activated_at: Date }>(
      `SELECT version, checksum, schema_version, actor_id, actor_kind, activated_by_id, activated_by_kind, activated_at
         FROM ${S('workflow_version')} WHERE workflow_id = $1 ORDER BY version DESC`, [w.id])).rows;
    return {
      items: rows.map(v => ({
        version: v.version, checksum: v.checksum, schemaVersion: v.schema_version, actor: { id: v.actor_id, kind: v.actor_kind },
        activatedBy: { id: v.activated_by_id, kind: v.activated_by_kind }, activatedAt: iso(v.activated_at), active: w.active_version === v.version && w.state === 'active',
      })),
    };
  }));

  app.get(`${prefix}/workflows/:id/versions/:version`, {
    attachValidation: true,
    schema: { params: { type: 'object', required: ['id', 'version'], properties: { id: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1 } } } },
  }, async req => handle(req, true, async (tx, actor) => {
    const p = req.params as { id: string; version: number };
    const w = await readable(tx, actor, p.id);
    const v = (await tx.query<{ version: number; checksum: string; definition: unknown; actor_id: string; actor_kind: string; activated_by_id: string; activated_by_kind: string; activated_at: Date }>(
      `SELECT * FROM ${S('workflow_version')} WHERE workflow_id = $1 AND version = $2`, [w.id, p.version])).rows[0];
    if (!v) throw fail(404, 'not-found', 'Version nicht gefunden.');
    return {
      version: v.version, checksum: v.checksum, definition: v.definition, actor: { id: v.actor_id, kind: v.actor_kind },
      activatedBy: { id: v.activated_by_id, kind: v.activated_by_kind }, activatedAt: iso(v.activated_at),
    };
  }));

  // ---------------------------------------------------------------------------------------------------------------
  // Manueller Start und Probelauf

  app.post(`${prefix}/workflows/:id/runs`, {
    attachValidation: true,
    schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { subject: ref, input: { type: 'object' } } } },
  }, async (req, reply) => handle(req, true, async (tx, actor, settings) => {
    const body = (req.body ?? {}) as { subject?: SubjectRef; input?: Record<string, unknown> };
    const w = await readable(tx, actor, (req.params as { id: string }).id);
    const subject = body.subject ? await subjectOrFail(tx, body.subject) : null;
    await need(tx, actor, 'workflow:run', subject ?? scopeOf(w));
    if (w.state !== 'active' || w.active_version === null || !w.actor_id || !w.actor_kind) throw fail(409, 'conflict', 'Der Workflow ist nicht aktiv.');
    const def = await engine.definition(tx, w.id, w.active_version);
    if (def.kind !== 'automation' || !('manual' in def.trigger)) throw fail(409, 'conflict', 'Dieser Workflow lässt sich nicht von Hand starten.');
    const input = body.input ?? {};
    const missing = (def.trigger.manual.form ?? []).filter(f => f.required && (input[f.key] === undefined || input[f.key] === null || input[f.key] === ''));
    if (missing.length) throw fail(422, 'invalid', `Pflichtfelder fehlen: ${missing.map(f => `«${f.label}»`).join(', ')}.`);
    const started = await engine.asEngine(tx, () => engine.startRun(tx, {
      workflowId: w.id, version: w.active_version!, actor: { id: w.actor_id!, kind: w.actor_kind! }, triggerKind: 'manual',
      trigger: { manual: { by: actor } }, subject, input, startedBy: actor, limits: settings!.limits,
    }));
    if (!started) throw fail(429, 'limit', 'Grenze für Läufe erreicht (je Tag oder je Bezug und Minute).');
    await audit(tx, 'workflow.run_started', actor, w, { subject, manual: true }, started.id);
    const run = (await engine.asEngine(tx, () => tx.query<RunRow>(`SELECT * FROM ${S('workflow_run')} WHERE id = $1`, [started.id]))).rows[0]!;
    void reply.status(201);
    return runJson(run);
  }));

  app.post(`${prefix}/workflows/:id/dry-run`, {
    attachValidation: true,
    schema: {
      params: idParams,
      body: {
        type: ['object', 'null'], additionalProperties: false,
        properties: {
          definition: { type: 'object' }, version: { type: 'integer', minimum: 1 }, subject: ref, input: { type: 'object' },
          assume: { type: 'object', maxProperties: 200, additionalProperties: { type: 'string', minLength: 1, maxLength: 64 } },
          event: { type: 'object', required: ['type'], additionalProperties: false, properties: { type: { type: 'string', minLength: 1 }, subject: { anyOf: [ref, { type: 'null' }] }, data: { type: 'object' } } },
        },
      },
    },
  }, async req => handle(req, true, async (tx, actor, settings) => {
    const body = (req.body ?? {}) as {
      definition?: unknown; version?: number; subject?: SubjectRef; input?: Record<string, unknown>; assume?: Record<string, string>;
      event?: { type: string; subject?: SubjectRef | null; data?: Record<string, unknown> };
    };
    const w = await readable(tx, actor, (req.params as { id: string }).id);
    await need(tx, actor, 'workflow:manage', scopeOf(w));
    let def: WorkflowDefinition;
    if (body.version !== undefined) {
      const v = (await tx.query<{ definition: WorkflowDefinition }>(`SELECT definition FROM ${S('workflow_version')} WHERE workflow_id = $1 AND version = $2`, [w.id, body.version])).rows[0];
      if (!v) throw fail(404, 'not-found', 'Version nicht gefunden.');
      def = v.definition;
    } else {
      const r = o.validate(body.definition ?? w.draft);
      if (!r.ok) throw fail(422, 'invalid-definition', `Die Definition ist ungültig: ${problems(r.errors)}`);
      def = r.definition;
    }
    const subject = body.subject ? await subjectOrFail(tx, body.subject) : body.event?.subject ? await subjectOrFail(tx, body.event.subject) : null;
    const event = body.event ? { type: body.event.type, subject: body.event.subject ?? subject, data: body.event.data ?? {}, actor } : null;
    const result = await engine.dryRun(tx, {
      workflowId: w.id, definition: def, actor: w.actor_id && w.actor_kind && w.state === 'active' ? { id: w.actor_id, kind: w.actor_kind } : actor,
      scope: scopeOf(w), subject, event, input: body.input ?? null, limits: settings!.limits, ...(body.assume ? { assume: body.assume } : {}),
    });
    return result;
  }));

  // ---------------------------------------------------------------------------------------------------------------
  // Läufe und Vorfälle

  /** Darf der Akteur Läufe dieses Workflows sehen? (je Anfrage zwischengespeichert) */
  const runReader = (tx: Tx, actor: ActorRef) => {
    const seen = new Map<string, ScopeRef | null>();
    return async (workflowId: string): Promise<ScopeRef | null> => {
      if (!seen.has(workflowId)) {
        const w = (await tx.query<WorkflowRow>(`SELECT * FROM ${S('workflow')} WHERE id = $1`, [workflowId])).rows[0];
        seen.set(workflowId, w && (await host.can(tx, actor, 'workflow:read', scopeOf(w))) ? scopeOf(w) : null);
      }
      return seen.get(workflowId) ?? null;
    };
  };

  app.get(`${prefix}/workflow-runs`, {
    attachValidation: true,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          workflowId: { type: 'string', format: 'uuid' }, subjectType: { type: 'string' }, subjectId: { type: 'string' },
          state: { enum: ['running', 'waiting', 'completed', 'failed', 'incident', 'cancelled'] }, cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async req => handle(req, true, async (tx, actor) => {
    const q = req.query as { workflowId?: string; subjectType?: string; subjectId?: string; state?: string; cursor?: string; limit?: number };
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !after) throw fail(422, 'invalid', 'Ungültiger «cursor».');
    const limit = q.limit ?? 50;
    const rows = (await tx.query<RunRow>(
      `SELECT * FROM ${S('workflow_run')}
        WHERE ($1::uuid IS NULL OR workflow_id = $1) AND ($2::text IS NULL OR subject_type = $2) AND ($3::text IS NULL OR subject_id = $3)
          AND ($4::text IS NULL OR state = $4) AND ($5::timestamptz IS NULL OR (started_at, id) < ($5::timestamptz, $6::uuid))
        ORDER BY started_at DESC, id DESC LIMIT $7`,
      [q.workflowId ?? null, q.subjectType ?? null, q.subjectId ?? null, q.state ?? null, after?.[0] ?? null, after?.[1] ?? null, limit])).rows;
    const can = runReader(tx, actor);
    const items = [];
    for (const r of rows) if (await can(r.workflow_id)) items.push(runJson(r));
    const last = rows.at(-1);
    return { items, nextCursor: rows.length === limit && last ? encodeCursor(last.started_at, last.id) : null };
  }));

  async function visibleRun(tx: Tx, actor: ActorRef, id: string, lock = false): Promise<{ run: RunRow; scope: ScopeRef }> {
    const run = (await tx.query<RunRow>(`SELECT * FROM ${S('workflow_run')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    const scope = run ? await runReader(tx, actor)(run.workflow_id) : null;
    if (!run || !scope) throw fail(404, 'not-found', 'Lauf nicht gefunden.');
    return { run, scope };
  }

  app.get(`${prefix}/workflow-runs/:id`, { attachValidation: true, schema: { params: idParams } }, async req => handle(req, true, async (tx, actor) => {
    const { run } = await visibleRun(tx, actor, (req.params as { id: string }).id);
    const steps = (await tx.query<{ id: string; path: string; step_id: string; kind: string; attempt: number; state: string; input: unknown; output: unknown; log: string[] | null; error: unknown; started_at: Date; finished_at: Date }>(
      `SELECT * FROM ${S('workflow_step')} WHERE run_id = $1 ORDER BY seq`, [run.id])).rows;
    return {
      ...runJson(run),
      steps: steps.map(s => ({
        id: s.id, path: s.path, stepId: s.step_id, kind: s.kind, attempt: s.attempt, state: s.state, input: s.input, output: s.output,
        log: s.log ?? [], error: s.error, startedAt: iso(s.started_at), finishedAt: iso(s.finished_at),
      })),
    };
  }));

  for (const action of ['retry', 'skip', 'cancel'] as const) {
    app.post(`${prefix}/workflow-runs/:id/${action}`, { attachValidation: true, schema: { params: idParams } }, async req => handle(req, true, async (tx, actor) => {
      const { run, scope } = await visibleRun(tx, actor, (req.params as { id: string }).id, true);
      await need(tx, actor, 'workflow:operate', scope);
      const allowed = action === 'cancel' ? ['incident', 'running', 'waiting'] : ['incident'];
      if (!allowed.includes(run.state)) throw fail(409, 'conflict', action === 'cancel' ? 'Der Lauf ist schon beendet.' : 'Der Lauf hat keinen offenen Vorfall.');
      await engine.resolveIncident(tx, run, action, actor);
      await audit(tx, `workflow.run_${action === 'retry' ? 'retried' : action === 'skip' ? 'step_skipped' : 'cancelled'}`, actor, { id: run.workflow_id }, { state: run.state }, run.id);
      const after = (await tx.query<RunRow>(`SELECT * FROM ${S('workflow_run')} WHERE id = $1`, [run.id])).rows[0]!;
      return runJson(after);
    }));
  }

  registerTaskRoutes(app, o, { handle, need, fail });
}
