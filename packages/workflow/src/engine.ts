/**
 * Engine der Automation (Stufe 1, Konzept 8.1, W2, W3, W6): Auslösen, Schritte ausführen, Warten, Fehler und Vorfälle,
 * Zeitpläne, Probelauf. Zustand liegt in den Tabellen `workflow_*` (Migration `workflow_001_core.sql`), ausgeführt wird
 * über die Job-Warteschlange der App (`host.jobs`).
 *
 * Regeln:
 * - `dispatch` liegt im Schreibpfad der App: Ohne passende Auslöser im Zwischenspeicher je Mandant (Typ → Auslöser)
 *   läuft keine Abfrage. Der Speicher verfällt nach `triggerCacheMs`; danach prüft eine Abfrage den Zähler
 *   `workflow_settings.version` und lädt nur bei einer Änderung neu. Aktivieren, Pausieren, Archivieren und Einstellungen
 *   erhöhen den Zähler (NOTIFY `workflow_triggers`) und leeren den Speicher im eigenen Prozess sofort.
 * - Ein Job führt genau **einen** Schritt in **einer** Transaktion aus: Lauf sperren, Grenzen, Akteur (`host.active`),
 *   Rechte (`host.can` für `needs` jeder Aktion), Aktion in einem Savepoint, Protokoll, nächsten Job anlegen. Doppelte
 *   oder veraltete Jobs erkennt die Folgenummer `seq` des Laufs.
 * - Ein Lauf handelt im Namen des Akteurs des Workflows (W6). Fehlt ein Recht oder ist der Akteur nicht mehr aktiv,
 *   entsteht ein Vorfall ohne Wiederholung (bei inaktivem Akteur wird der Workflow pausiert).
 * - Schleifenschutz: Ereignisse aus Läufen (an derselben `tx` erkannt oder über `causedBy`) lösen nur Auslöser mit
 *   `includeWorkflowEvents` aus; jede Stufe erhöht die Kettentiefe, über `limits.chainDepth` entsteht ein Lauf im Zustand
 *   `incident` ohne Job und ohne Ereignis (damit sich die Kette nicht über Ereignisse fortsetzt).
 * - Die Engine liest an der Lesesicht der Läufe vorbei (`workflow.engine = on`, lokal und danach zurückgesetzt).
 * - Probelauf: gleiche Schrittlogik, Aktionen nur über `dryRun`, alles in einem Savepoint, der zurückgerollt wird; weder
 *   `emit` noch `audit` noch Jobs. Aufgaben und Genehmigungen nimmt der Probelauf mit dem ersten Ergebnis als erledigt an.
 * - Aufgaben (Stufe 2, `tasks.ts`): Ein Schritt `task` oder `approval` legt die Aufgabe im Savepoint an und setzt den
 *   Lauf auf `waiting` ohne `wake_at` und ohne Job; `resumeAfterTask` setzt ihn beim Erledigen fort. Jobs für einen so
 *   wartenden Lauf werden ignoriert. Endet ein Lauf, bricht `finish` seine offenen Aufgaben ab.
 * - Warten mit Arbeitszeit (`P2BD`, `PT4BH`) rechnet nach dem Standardkalender des Mandanten (`calendar.ts`).
 * - Der Mandant wird je `Tx` zwischengespeichert: Die App gibt je Transaktion ein eigenes `Tx` (keine wiederverwendete
 *   Verbindung eines Pools).
 */
import { createHash, randomUUID } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { addWorkingTime } from './calendar.ts';
import { addDuration, isBusinessDuration, nextCronTime } from './cron.ts';
import { advance, END, END_FAILED, enter, loopBindings, stepAt, dropLoopsBelow, type Loops, type Position } from './cursor.ts';
import type { ApprovalStep, OnError, Step, TaskStep, WorkflowDefinition } from './definition.ts';
import { evaluateCondition, resolvePath, resolveValue, type Condition, type ExpressionContext } from './expressions.ts';
import { FormChecker } from './forms.ts';
import type {
  ActionContext, ActorRef, Causation, DispatchOptions, FieldKind, JobCtx, ScopeRef, SubjectRef, Tx, WorkflowAction, WorkflowEvent,
  WorkflowHost, WorkflowJob, WorkflowLimits, WorkflowSubject,
} from './ports.ts';
import { Tasks, WORKFLOW_JOB_SLA } from './tasks.ts';

/** Kinds der Jobs des Baukastens. */
export const WORKFLOW_JOB_STEP = 'workflow.step';
export const WORKFLOW_JOB_START = 'workflow.start';

/** Wiederholungen eines Schritts ohne eigene Angabe. */
export const DEFAULT_RETRY = 3;
/** Grösse von Ein- und Ausgaben im Protokoll (Bytes JSON), darüber gekürzt. */
export const LOG_MAX_BYTES = 8192;

export type RunState = 'running' | 'waiting' | 'completed' | 'failed' | 'incident' | 'cancelled';
export type TriggerKind = 'event' | 'schedule' | 'manual';

export interface EngineOptions {
  schema: string;
  host: WorkflowHost;
  subjects: WorkflowSubject[];
  actions: WorkflowAction[];
  limits: Readonly<WorkflowLimits>;
  enabled: boolean;
  /** Uhr (für Tests). */
  clock: () => Date;
  /** Grundwert der Wartezeit vor einer Wiederholung (verdoppelt je Versuch). */
  retryDelayMs: number;
  /** Lebensdauer des Zwischenspeichers der Auslöser je Mandant. */
  triggerCacheMs: number;
  /** Feldarten der App für Aufgabenformulare. */
  fields?: FieldKind[];
}

export interface WorkflowRow {
  tenant_id: string; id: string; name: string; description: string | null; kind: string; scope_type: string; scope_id: string;
  state: 'draft' | 'active' | 'paused' | 'archived'; draft: unknown; revision: number; active_version: number | null;
  actor_id: string | null; actor_kind: ActorRef['kind'] | null; paused_reason: string | null;
  created_by_id: string; created_by_kind: string; created_at: Date | string; updated_at: Date | string;
}

export interface RunRow {
  tenant_id: string; id: string; workflow_id: string; version: number; trigger_kind: TriggerKind; trigger: RunTrigger;
  subject_type: string | null; subject_id: string | null; actor_id: string; actor_kind: ActorRef['kind'];
  started_by_id: string | null; started_by_kind: string | null; state: RunState; cursor: string | null; seq: number;
  attempts: number; step_count: number; chain_depth: number; parent_run_id: string | null; correlation_id: string | null;
  variables: Record<string, unknown>; outputs: Record<string, unknown>; loops: Loops; input: Record<string, unknown> | null;
  error: StepError | null; wake_at: Date | string | null; started_at: Date | string; updated_at: Date | string; finished_at: Date | string | null;
}

/** Was einen Lauf ausgelöst hat (gespeichert im Lauf, im Kontext als `event` bzw. `trigger`). */
export interface RunTrigger {
  event?: { type: string; subject: SubjectRef | null; data: Record<string, unknown>; actor?: ActorRef | null };
  schedule?: { at: string };
  manual?: { by: ActorRef };
}

export interface StepError { code: string; message: string; path?: string | null }

/** Wirksame Einstellungen eines Mandanten (Opt-in und Grenzen). */
export interface TenantSettings {
  exists: boolean;
  enabled: boolean;
  /** Grenzen nach Optionen der App und Werten des Mandanten (das Kleinere gilt). */
  limits: WorkflowLimits;
  /** Werte des Mandanten. */
  overrides: Partial<WorkflowLimits>;
  version: number;
  revision: number;
}

/** Ergebnis eines Schritts im Probelauf. */
export interface DryRunStep {
  path: string;
  stepId: string;
  kind: string;
  label: string | null;
  summary: string;
  input?: unknown;
  output?: unknown;
  /** Fehlt dem Akteur ein Recht, das die Aktion braucht? */
  allowed?: boolean;
  missing?: string[];
  error?: StepError;
}

export interface DryRunResult {
  /** Passt das Ereignis zum Filter des Auslösers (nur mit Ereignis und Ereignis-Auslöser)? */
  triggerMatches: boolean | null;
  result: 'completed' | 'failed' | 'cancelled' | 'limit';
  steps: DryRunStep[];
  variables: Record<string, unknown>;
}

/** Fehler eines Schritts mit Angabe, ob eine Wiederholung sinnvoll ist und ob sofort ein Vorfall entsteht. */
export class StepFailure extends Error {
  override name = 'StepFailure';
  readonly code: string;
  readonly retryable: boolean;
  readonly incident: boolean;
  constructor(code: string, message: string, o: { retryable?: boolean; incident?: boolean } = {}) {
    super(message);
    this.code = code;
    this.retryable = o.retryable ?? false;
    this.incident = o.incident ?? false;
  }
}

/** Kettentiefe eines neuen Laufs und ob er starten darf (Schleifenschutz, rein). */
export function chainDecision(causation: { depth: number } | null, maxDepth: number): { depth: number; allowed: boolean } {
  const depth = (causation?.depth ?? 0) + 1;
  return { depth, allowed: depth <= maxDepth };
}

/** Grenze für die Schritte eines Laufs (rein). */
export function stepLimitReached(stepCount: number, limits: Pick<WorkflowLimits, 'stepsPerRun'>): boolean {
  return stepCount >= limits.stepsPerRun;
}

/** Grenze für die Einträge einer Schleife (rein): Angabe im Schritt, höchstens die Grenze des Mandanten. */
export function foreachLimit(step: { foreach: { limit?: number } }, limits: Pick<WorkflowLimits, 'foreachItems'>): number {
  return Math.min(step.foreach.limit ?? limits.foreachItems, limits.foreachItems);
}

/** Wirksame Grenzen: je Schlüssel das Kleinere aus App und Mandant. */
export function effectiveLimits(app: Readonly<WorkflowLimits>, tenant: Partial<WorkflowLimits>): WorkflowLimits {
  const out = { ...app } as WorkflowLimits;
  for (const k of Object.keys(app) as (keyof WorkflowLimits)[]) {
    const v = tenant[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) out[k] = Math.min(v, app[k]);
  }
  return out;
}

const SECRET_KEY = /pass(word)?|secret|token|authori[sz]ation|api[-_]?key|cookie|private[-_]?key/i;

/** Ein- und Ausgaben fürs Protokoll: Geheimnisse geschwärzt, tiefe Strukturen und grosse Werte gekürzt. */
export function redact(value: unknown, maxBytes = LOG_MAX_BYTES): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (v === undefined) return null;
    if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
    if (v instanceof Date) return v.toISOString();
    if (depth > 8) return '[gekürzt]';
    if (Array.isArray(v)) return v.slice(0, 100).map(x => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[geschwärzt]' : walk(x, depth + 1);
    return out;
  };
  const clean = walk(value, 0);
  const json = JSON.stringify(clean);
  if (json !== undefined && json.length > maxBytes) return { truncated: true, preview: json.slice(0, maxBytes) };
  return clean;
}

/** Prüfsumme einer Definition (SHA-256 über JSON mit sortierten Schlüsseln). */
export function definitionChecksum(def: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(def))).digest('hex');
}

/** Schritte und Auslöser, die Stufe 1 ausführen kann (Meldungen mit Pfad; leer = ausführbar). */
export function stageProblems(def: WorkflowDefinition): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (def.kind !== 'automation') {
    out.push({ path: '/kind', message: def.kind === 'case' ? 'Fälle folgen in Stufe 3' : 'Zustandsmodelle folgen in Stufe 4' });
    return out;
  }
  const t = def.trigger;
  if ('transition' in t) out.push({ path: '/trigger/transition', message: 'Auslöser «Zustandswechsel» folgt in Stufe 4' });
  if ('subflow' in t) out.push({ path: '/trigger/subflow', message: 'Auslöser «Unterablauf» folgt in Stufe 3' });
  const walk = (list: Step[] | undefined, base: string) => {
    for (const [i, s] of (list ?? []).entries()) {
      const p = `${base}/${i}`;
      if ('subflow' in s) out.push({ path: `${p}/subflow`, message: 'Unterabläufe folgen in Stufe 3' });
      if ('wait' in s && s.wait.event) out.push({ path: `${p}/wait/event`, message: 'Warten auf ein Ereignis folgt in einer späteren Stufe (Warten auf Dauer oder Zeitpunkt geht)' });
      if ('if' in s) { walk(s.then, `${p}/then`); walk(s.else, `${p}/else`); }
      if ('foreach' in s) walk(s.steps, `${p}/steps`);
      walk(s.onError?.steps, `${p}/onError/steps`);
    }
  };
  walk(def.steps, '/steps');
  walk(def.onError?.steps, '/onError/steps');
  return out;
}

const kindOf = (s: Step): string => (['action', 'if', 'foreach', 'wait', 'task', 'approval', 'subflow', 'end', 'set'] as const).find(k => k in s) ?? 'unknown';

interface TriggerEntry { id: string; workflowId: string; version: number; filter: Condition | null; includeWorkflowEvents: boolean }
interface CacheEntry { loadedAt: number; version: number; enabled: boolean; byType: Map<string, TriggerEntry[]> }

/** Ergebnis eines Schritts (intern). */
interface StepResult {
  next: Position;
  input?: unknown;
  output?: unknown;
  /** Ausgabe unter `steps.<id>` im Kontext. */
  stepOutput?: unknown;
  variables?: Record<string, unknown>;
  loops?: Loops;
  wakeAt?: Date;
  end?: { state: 'completed' | 'cancelled' | 'failed'; message: string | null };
  summary?: string;
  allowed?: boolean;
  missing?: string[];
  /** Schritt hat eine Aufgabe angelegt: Lauf wartet, bis sie erledigt ist. */
  waitTask?: string;
}

interface StartArgs {
  tenantId?: string | null;
  workflowId: string;
  version: number;
  actor: ActorRef;
  triggerKind: TriggerKind;
  trigger: RunTrigger;
  subject: SubjectRef | null;
  input?: Record<string, unknown> | null;
  causation?: Causation | null;
  correlationId?: string | null;
  startedBy?: ActorRef | null;
  limits: WorkflowLimits;
}

export class Engine {
  readonly o: EngineOptions;
  private readonly S: string;
  private readonly actions: Map<string, WorkflowAction>;
  private readonly subjects: Map<string, WorkflowSubject>;
  private readonly inputValidators = new Map<string, ValidateFunction>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly tenants = new WeakMap<object, string | null>();
  private readonly causes = new WeakMap<object, Causation[]>();
  readonly jobs: WorkflowJob[];
  readonly tasks: Tasks;

  constructor(o: EngineOptions) {
    this.o = o;
    this.S = o.schema;
    this.actions = new Map(o.actions.map(a => [a.key, a]));
    this.subjects = new Map(o.subjects.map(s => [s.type, s]));
    // Eingabe-Schemas der App: gängige Formate geprüft, unbekannte still übergangen (keine Abhängigkeit auf ajv-formats)
    const ajv = new Ajv({
      allErrors: true, strict: false, logger: false,
      formats: {
        uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        date: /^\d{4}-\d{2}-\d{2}$/,
        'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
        email: /^[^\s@]+@[^\s@]+$/,
      },
    });
    for (const a of o.actions) {
      try { this.inputValidators.set(a.key, ajv.compile(a.input)); }
      catch (e) { throw new Error(`workflow: Aktion «${a.key}» hat kein gültiges Eingabe-Schema (${e instanceof Error ? e.message : String(e)})`); }
    }
    this.tasks = new Tasks(this, new FormChecker(o.fields ?? []));
    this.jobs = [
      { kind: WORKFLOW_JOB_STEP, handler: ctx => this.stepJob(ctx) },
      { kind: WORKFLOW_JOB_START, handler: ctx => this.startJob(ctx) },
      { kind: WORKFLOW_JOB_SLA, handler: ctx => this.slaJob(ctx) },
    ];
  }

  private t(name: string): string { return `${this.S}.${name}`; }

  // -------------------------------------------------------------------------------------------------------------
  // Hilfen

  /** Lokal an der Lesesicht vorbei (Engine); der vorherige Wert wird wiederhergestellt. */
  async asEngine<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
    const r = await tx.query<{ prev: string | null }>(`SELECT current_setting('workflow.engine', true) AS prev, set_config('workflow.engine', 'on', true) AS on`);
    const prev = r.rows[0]?.prev ?? '';
    if (prev === 'on') return fn();
    let failed = false;
    try { return await fn(); }
    catch (e) { failed = true; throw e; }
    finally {
      if (!failed) await tx.query(`SELECT set_config('workflow.engine', $1, true)`, [prev]);
      else await tx.query(`SELECT set_config('workflow.engine', $1, true)`, [prev]).catch(() => {});
    }
  }

  /** Ereignisse an `tx` stammen während `fn` aus dem Lauf `c` (Schleifenschutz). */
  async withCausation<T>(tx: Tx, c: Causation, fn: () => Promise<T>): Promise<T> {
    const stack = this.causes.get(tx) ?? [];
    stack.push(c);
    this.causes.set(tx, stack);
    try { return await fn(); } finally { stack.pop(); }
  }

  private currentCause(tx: Tx): Causation | null { return this.causes.get(tx)?.at(-1) ?? null; }

  /** Ereignis aus einem Lauf (Herkunft für den Schleifenschutz). */
  async emitFor(tx: Tx, run: Pick<RunRow, 'id' | 'chain_depth' | 'subject_id'>, type: string, data: Record<string, unknown>): Promise<void> {
    await this.withCausation(tx, { runId: run.id, depth: run.chain_depth }, () => this.o.host.emit(tx, type, run.subject_id, data));
  }

  /** Mandant der Transaktion (einmal je `tx` gelesen). */
  async tenantOf(tx: Tx): Promise<string | null> {
    if (this.tenants.has(tx)) return this.tenants.get(tx) ?? null;
    const id = (await tx.query<{ id: string | null }>(`SELECT ${this.t('workflow_tenant')}()::text AS id`)).rows[0]?.id ?? null;
    this.tenants.set(tx, id);
    return id;
  }

  /** Zwischenspeicher der Auslöser leeren (eigener Prozess; z. B. nach NOTIFY `workflow_triggers`). */
  invalidate(tenantId?: string | null): void {
    if (tenantId) { const e = this.cache.get(tenantId); if (e) e.loadedAt = 0; }
    else for (const e of this.cache.values()) e.loadedAt = 0;
  }

  /** Einstellungen des Mandanten der Transaktion (ohne Zeile: ausgeschaltet, Grenzen der App). */
  async settings(tx: Tx): Promise<TenantSettings> {
    const row = (await tx.query<{ enabled: boolean; limits: Partial<WorkflowLimits>; version: string | number; revision: number }>(
      `SELECT enabled, limits, version, revision FROM ${this.t('workflow_settings')}`)).rows[0];
    const overrides = row?.limits ?? {};
    return {
      exists: !!row, enabled: row?.enabled ?? false, overrides, limits: effectiveLimits(this.o.limits, overrides),
      version: Number(row?.version ?? 0), revision: row?.revision ?? 0,
    };
  }

  async definition(tx: Tx, workflowId: string, version: number): Promise<WorkflowDefinition> {
    const key = `${workflowId}:${version}`;
    const hit = this.definitions.get(key);
    if (hit) return hit;
    const row = (await tx.query<{ definition: WorkflowDefinition }>(
      `SELECT definition FROM ${this.t('workflow_version')} WHERE workflow_id = $1 AND version = $2`, [workflowId, version])).rows[0];
    if (!row) throw new StepFailure('version-missing', `Version ${version} des Workflows fehlt`);
    this.definitions.set(key, row.definition);
    return row.definition;
  }

  private now(): Date { return this.o.clock(); }
  private day(): string { return this.now().toISOString().slice(0, 10); }

  // -------------------------------------------------------------------------------------------------------------
  // Auslöser: Zwischenspeicher und dispatch (W3)

  private async triggerEntry(tx: Tx, tenant: string): Promise<CacheEntry> {
    const now = Date.now();
    const hit = this.cache.get(tenant);
    if (hit && now - hit.loadedAt < this.o.triggerCacheMs) return hit;
    const s = (await tx.query<{ enabled: boolean; version: string | number }>(`SELECT enabled, version FROM ${this.t('workflow_settings')}`)).rows[0];
    const version = Number(s?.version ?? 0);
    const enabled = s?.enabled ?? false;
    if (hit && hit.version === version && hit.enabled === enabled) { hit.loadedAt = now; return hit; }
    const byType = new Map<string, TriggerEntry[]>();
    if (enabled) {
      const rows = (await tx.query<{ id: string; workflow_id: string; version: number; event_type: string; filter: Condition | null; include_workflow_events: boolean }>(
        `SELECT id, workflow_id, version, event_type, filter, include_workflow_events FROM ${this.t('workflow_trigger')} WHERE kind = 'event'`)).rows;
      for (const r of rows) {
        const list = byType.get(r.event_type) ?? [];
        list.push({ id: r.id, workflowId: r.workflow_id, version: r.version, filter: r.filter, includeWorkflowEvents: r.include_workflow_events });
        byType.set(r.event_type, list);
      }
    }
    const entry = { loadedAt: now, version, enabled, byType };
    this.cache.set(tenant, entry);
    return entry;
  }

  /** Ereignis der App prüfen und passende Läufe anlegen (gleiche Transaktion wie `emit`). */
  async dispatch(tx: Tx, event: WorkflowEvent, o: DispatchOptions = {}): Promise<void> {
    if (!this.o.enabled) return;
    const tenant = o.tenantId ?? (await this.tenantOf(tx));
    if (!tenant) return;
    const entry = await this.triggerEntry(tx, tenant);
    if (!entry.enabled) return;
    const candidates = entry.byType.get(event.type);
    if (!candidates?.length) return;

    let causation: Causation | { runId: string; depth: null } | null = o.causedBy ?? this.currentCause(tx)
      ?? (event.causedByRunId ? { runId: event.causedByRunId, depth: null } : null);
    const ctx: ExpressionContext = { event: { type: event.type, subject: event.subject, data: event.data, actor: event.actor ?? null } };
    const matched = candidates.filter(t => {
      if (causation && !t.includeWorkflowEvents) return false;
      if (!t.filter) return true;
      try { return evaluateCondition(t.filter, ctx); } catch { return false; }
    });
    if (!matched.length) return;

    await this.asEngine(tx, async () => {
      if (causation && causation.depth === null) {
        const depth = (await tx.query<{ chain_depth: number }>(`SELECT chain_depth FROM ${this.t('workflow_run')} WHERE id = $1`, [causation.runId])).rows[0]?.chain_depth;
        causation = { runId: causation.runId, depth: depth ?? 0 };
      }
      const settings = await this.settings(tx);
      for (const t of matched) {
        const wf = (await tx.query<Pick<WorkflowRow, 'state' | 'active_version' | 'actor_id' | 'actor_kind'>>(
          `SELECT state, active_version, actor_id, actor_kind FROM ${this.t('workflow')} WHERE id = $1`, [t.workflowId])).rows[0];
        if (!wf || wf.state !== 'active' || wf.active_version !== t.version || !wf.actor_id || !wf.actor_kind) continue;
        await this.startRun(tx, {
          tenantId: tenant, workflowId: t.workflowId, version: t.version, actor: { id: wf.actor_id, kind: wf.actor_kind },
          triggerKind: 'event', trigger: { event: { type: event.type, subject: event.subject, data: event.data, actor: event.actor ?? null } },
          subject: event.subject, causation: causation as Causation | null, correlationId: event.correlationId ?? null, limits: settings.limits,
        });
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Läufe anlegen

  /** Lauf anlegen und ersten Job einreihen. `null`, wenn eine Grenze das verhindert (gezählt in `runs_rejected`). */
  async startRun(tx: Tx, a: StartArgs): Promise<{ id: string; state: RunState } | null> {
    const def = await this.definition(tx, a.workflowId, a.version);
    const chain = chainDecision(a.causation ?? null, a.limits.chainDepth);
    const id = randomUUID();
    const now = this.now();
    const tenant = a.tenantId ?? null;
    const insert = (state: RunState, cursor: Position, error: StepError | null) => tx.query(
      `INSERT INTO ${this.t('workflow_run')} (tenant_id, id, workflow_id, version, trigger_kind, trigger, subject_type, subject_id, actor_id, actor_kind,
         started_by_id, started_by_kind, state, cursor, chain_depth, parent_run_id, correlation_id, variables, input, error, started_at, updated_at, finished_at)
       VALUES (coalesce($1::uuid, ${this.t('workflow_tenant')}()), $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb,
         $19::jsonb, $20::jsonb, $21, $21, NULL)`,
      [tenant, id, a.workflowId, a.version, a.triggerKind, JSON.stringify(a.trigger), a.subject?.type ?? null, a.subject?.id ?? null,
        a.actor.id, a.actor.kind, a.startedBy?.id ?? null, a.startedBy?.kind ?? null, state, cursor, chain.depth, a.causation?.runId ?? null,
        a.correlationId ?? null, JSON.stringify(def.variables ?? {}), a.input ? JSON.stringify(a.input) : null, error ? JSON.stringify(error) : null,
        now]);

    if (!chain.allowed) {
      // Schleifenschutz: sichtbar als Vorfall, aber ohne Job und ohne Ereignis
      await insert('incident', enter(def, '/steps', {}), {
        code: 'chain-depth', message: `Kettentiefe ${chain.depth} überschreitet die Grenze ${a.limits.chainDepth} (Workflows lösen sich gegenseitig aus)`,
      });
      return { id, state: 'incident' };
    }
    if (!(await this.countRun(tx, tenant, a.limits))) return null;
    if (a.subject) {
      const since = new Date(now.getTime() - 60_000);
      const n = (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${this.t('workflow_run')} WHERE workflow_id = $1 AND subject_type = $2 AND subject_id = $3 AND started_at > $4`,
        [a.workflowId, a.subject.type, a.subject.id, since])).rows[0]?.n ?? 0;
      if (n >= a.limits.runsPerSubjectPerMinute) { await this.reject(tx, tenant); return null; }
    }
    await insert('running', enter(def, '/steps', {}), null);
    const run = { id, chain_depth: chain.depth, subject_id: a.subject?.id ?? null };
    await this.emitFor(tx, run, 'workflow.run_started', { workflowId: a.workflowId, version: a.version, runId: id, trigger: a.triggerKind, subject: a.subject });
    await this.enqueueStep(tx, tenant ?? (await this.tenantOf(tx)), id, 1);
    return { id, state: 'running' };
  }

  /** Lauf zählen; über der Tagesgrenze zurücknehmen und als abgewiesen zählen. */
  private async countRun(tx: Tx, tenant: string | null, limits: WorkflowLimits): Promise<boolean> {
    const runs = (await tx.query<{ runs: number }>(
      `INSERT INTO ${this.t('workflow_usage')} AS u (tenant_id, day, runs) VALUES (coalesce($1::uuid, ${this.t('workflow_tenant')}()), $2::date, 1)
       ON CONFLICT (tenant_id, day) DO UPDATE SET runs = u.runs + 1 RETURNING runs`, [tenant, this.day()])).rows[0]?.runs ?? 1;
    if (runs <= limits.runsPerDay) return true;
    await tx.query(`UPDATE ${this.t('workflow_usage')} SET runs = runs - 1 WHERE day = $1::date AND tenant_id = coalesce($2::uuid, ${this.t('workflow_tenant')}())`, [this.day(), tenant]);
    await this.reject(tx, tenant);
    return false;
  }

  private async reject(tx: Tx, tenant: string | null): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.t('workflow_usage')} AS u (tenant_id, day, runs_rejected) VALUES (coalesce($1::uuid, ${this.t('workflow_tenant')}()), $2::date, 1)
       ON CONFLICT (tenant_id, day) DO UPDATE SET runs_rejected = u.runs_rejected + 1`, [tenant, this.day()]);
  }

  private async enqueueStep(tx: Tx, tenantId: string | null, runId: string, seq: number, runAt?: Date): Promise<void> {
    await this.o.host.jobs.enqueue(tx, WORKFLOW_JOB_STEP, { tenantId, runId, seq }, { dedupeKey: `workflow:${runId}:${seq}`, ...(runAt ? { runAt } : {}) });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Zeitpläne

  /**
   * Fällige Zeitpläne abholen (`FOR UPDATE SKIP LOCKED`), `next_at` weiterschieben und je Treffer einen Job
   * `workflow.start` im Mandanten einreihen. Mit der Worker-Rolle über alle Mandanten, mit der Laufzeit-Rolle für den
   * Mandanten der Transaktion. Liefert die Zahl der eingereihten Starts.
   */
  async tick(tx: Tx, o: { limit?: number } = {}): Promise<number> {
    if (!this.o.enabled) return 0;
    const prev = (await tx.query<{ prev: string | null }>(`SELECT current_setting('workflow.sched', true) AS prev, set_config('workflow.sched', 'on', true) AS on`)).rows[0]?.prev ?? '';
    try {
      const now = this.now();
      const due = (await tx.query<{ tenant_id: string; id: string; cron: string; timezone: string; next_at: Date | string; tenant_enabled: boolean }>(
        `SELECT t.tenant_id::text AS tenant_id, t.id, t.cron, t.timezone, t.next_at, coalesce(s.enabled, false) AS tenant_enabled
           FROM ${this.t('workflow_trigger')} t LEFT JOIN ${this.t('workflow_settings')} s ON s.tenant_id = t.tenant_id
          WHERE t.kind = 'schedule' AND t.next_at <= $1 ORDER BY t.next_at LIMIT $2 FOR UPDATE OF t SKIP LOCKED`,
        [now, o.limit ?? 100])).rows;
      let started = 0;
      for (const r of due) {
        let next: Date | null = null;
        try { next = nextCronTime(r.cron, r.timezone, now); } catch { next = null; }
        await tx.query(`UPDATE ${this.t('workflow_trigger')} SET next_at = $2 WHERE id = $1`, [r.id, next]);
        if (!r.tenant_enabled) continue;
        const at = new Date(r.next_at).toISOString();
        await this.o.host.jobs.enqueue(tx, WORKFLOW_JOB_START, { tenantId: r.tenant_id, triggerId: r.id, at }, { dedupeKey: `workflow:start:${r.id}:${at}` });
        started++;
      }
      // Fristen der Aufgaben: fällige markieren, Eskalation als Job
      started += await this.asEngine(tx, () => this.tasks.tickSla(tx, o));
      return started;
    } finally {
      await tx.query(`SELECT set_config('workflow.sched', $1, true)`, [prev]).catch(() => {});
    }
  }

  private async startJob(ctx: JobCtx): Promise<void> {
    if (!this.o.enabled) throw this.o.host.error(503, 'module-disabled', 'Workflows sind in dieser Umgebung ausgeschaltet');
    const p = ctx.payload as { tenantId: string; triggerId: string; at: string };
    await this.asEngine(ctx.tx, async () => {
      const row = (await ctx.tx.query<{ workflow_id: string; version: number; state: string; active_version: number | null; actor_id: string | null; actor_kind: ActorRef['kind'] | null }>(
        `SELECT t.workflow_id, t.version, w.state, w.active_version, w.actor_id, w.actor_kind
           FROM ${this.t('workflow_trigger')} t JOIN ${this.t('workflow')} w ON w.tenant_id = t.tenant_id AND w.id = t.workflow_id
          WHERE t.id = $1 AND t.kind = 'schedule'`, [p.triggerId])).rows[0];
      if (!row || row.state !== 'active' || row.active_version !== row.version || !row.actor_id || !row.actor_kind) return;
      const settings = await this.settings(ctx.tx);
      if (!settings.enabled) return;
      await this.startRun(ctx.tx, {
        tenantId: p.tenantId, workflowId: row.workflow_id, version: row.version, actor: { id: row.actor_id, kind: row.actor_kind },
        triggerKind: 'schedule', trigger: { schedule: { at: p.at } }, subject: null, limits: settings.limits,
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Auslöser einer aktiven Version

  /** Auslöser aus der aktiven Version neu anlegen (oder entfernen mit `def = null`) und den Zähler erhöhen. */
  async rebuildTriggers(tx: Tx, wf: Pick<WorkflowRow, 'tenant_id' | 'id'>, version: number | null, def: WorkflowDefinition | null): Promise<void> {
    await tx.query(`DELETE FROM ${this.t('workflow_trigger')} WHERE workflow_id = $1`, [wf.id]);
    if (def && version !== null && def.kind === 'automation') {
      const t = def.trigger;
      const id = randomUUID();
      if ('event' in t) {
        await tx.query(`INSERT INTO ${this.t('workflow_trigger')} (tenant_id, id, workflow_id, version, kind, event_type, filter, include_workflow_events)
          VALUES ($1, $2, $3, $4, 'event', $5, $6::jsonb, $7)`, [wf.tenant_id, id, wf.id, version, t.event, t.filter ? JSON.stringify(t.filter) : null, t.includeWorkflowEvents ?? false]);
      } else if ('schedule' in t) {
        const next = nextCronTime(t.schedule.cron, t.schedule.timezone, this.now());
        await tx.query(`INSERT INTO ${this.t('workflow_trigger')} (tenant_id, id, workflow_id, version, kind, cron, timezone, next_at)
          VALUES ($1, $2, $3, $4, 'schedule', $5, $6, $7)`, [wf.tenant_id, id, wf.id, version, t.schedule.cron, t.schedule.timezone, next]);
      } else if ('manual' in t) {
        await tx.query(`INSERT INTO ${this.t('workflow_trigger')} (tenant_id, id, workflow_id, version, kind) VALUES ($1, $2, $3, $4, 'manual')`,
          [wf.tenant_id, id, wf.id, version]);
      }
    }
    await tx.query(`UPDATE ${this.t('workflow_settings')} SET version = version + 1`);
    this.invalidate(wf.tenant_id);
  }

  /** Workflow pausieren (von Hand oder weil der Akteur nicht mehr handeln darf). */
  async pause(tx: Tx, wf: Pick<WorkflowRow, 'tenant_id' | 'id' | 'active_version'>, reason: string | null, by: ActorRef | null): Promise<void> {
    await tx.query(`UPDATE ${this.t('workflow')} SET state = 'paused', paused_reason = $2, updated_at = now(), revision = revision + 1 WHERE id = $1`, [wf.id, reason]);
    await this.rebuildTriggers(tx, wf, null, null);
    await this.o.host.emit(tx, 'workflow.paused', null, { workflowId: wf.id, version: wf.active_version, reason });
    await this.o.host.audit(tx, { action: 'workflow.paused', actor: by, workflowId: wf.id, data: { reason } });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Schritte ausführen

  private async stepJob(ctx: JobCtx): Promise<void> {
    if (!this.o.enabled) throw this.o.host.error(503, 'module-disabled', 'Workflows sind in dieser Umgebung ausgeschaltet');
    const p = ctx.payload as { tenantId: string | null; runId: string; seq: number };
    const tx = ctx.tx;
    await this.asEngine(tx, async () => {
      const run = (await tx.query<RunRow>(`SELECT * FROM ${this.t('workflow_run')} WHERE id = $1 FOR UPDATE`, [p.runId])).rows[0];
      if (!run || run.seq !== p.seq || (run.state !== 'running' && run.state !== 'waiting')) return; // erledigt, doppelt oder veraltet
      if (run.state === 'waiting' && !run.wake_at) return; // wartet auf eine Aufgabe; weiter geht es beim Erledigen
      const settings = await this.settings(tx);
      if (!settings.enabled) {
        await this.finish(tx, run, 'cancelled', { code: 'tenant-disabled', message: 'Workflows sind im Mandanten ausgeschaltet' });
        return;
      }
      if (run.state === 'waiting' && run.wake_at && new Date(run.wake_at) > this.now()) {
        await this.update(tx, run, { seq: run.seq + 1 });
        await this.enqueueStep(tx, p.tenantId, run.id, run.seq + 1, new Date(run.wake_at));
        return;
      }
      if (run.state === 'waiting') { run.state = 'running'; run.wake_at = null; }
      await this.execute(tx, run, p.tenantId, settings.limits);
    });
  }

  /** Spalten des Laufs schreiben (Werte auch in `run` übernommen). */
  private async update(tx: Tx, run: RunRow, set: Partial<RunRow>): Promise<void> {
    const json = new Set(['variables', 'outputs', 'loops', 'error', 'input', 'trigger']);
    const keys = Object.keys(set) as (keyof RunRow)[];
    Object.assign(run, set);
    const cols = keys.map((k, i) => `${k} = $${i + 2}${json.has(k) ? '::jsonb' : ''}`);
    await tx.query(`UPDATE ${this.t('workflow_run')} SET ${cols.join(', ')}, updated_at = now() WHERE id = $1`,
      [run.id, ...keys.map(k => (json.has(k) ? (set[k] === null ? null : JSON.stringify(set[k])) : set[k]))]);
  }

  private async finish(tx: Tx, run: RunRow, state: 'completed' | 'failed' | 'cancelled', error: StepError | null): Promise<void> {
    await this.update(tx, run, { state, cursor: null, wake_at: null, error: error ?? run.error, finished_at: this.now() });
    await this.tasks.cancelForRun(tx, run.id, state === 'completed' ? 'Lauf beendet' : state === 'cancelled' ? 'Lauf abgebrochen' : 'Lauf fehlgeschlagen');
    const type = state === 'completed' ? 'workflow.run_completed' : 'workflow.run_failed';
    await this.emitFor(tx, run, type, { workflowId: run.workflow_id, version: run.version, runId: run.id, state, error });
  }

  /** Vorfall: Lauf hält an, Benachrichtigung an den Akteur (Person) bzw. die Person, die den Workflow angelegt hat. */
  private async incident(tx: Tx, run: RunRow, error: StepError): Promise<void> {
    await this.update(tx, run, { state: 'incident', error, wake_at: null });
    await this.emitFor(tx, run, 'workflow.incident_opened', { workflowId: run.workflow_id, version: run.version, runId: run.id, error });
    if (this.o.host.notify) {
      const wf = (await tx.query<Pick<WorkflowRow, 'name' | 'created_by_id' | 'created_by_kind'>>(
        `SELECT name, created_by_id, created_by_kind FROM ${this.t('workflow')} WHERE id = $1`, [run.workflow_id])).rows[0];
      const recipient: ActorRef | null = run.actor_kind === 'person' ? { id: run.actor_id, kind: 'person' }
        : wf?.created_by_kind === 'person' ? { id: wf.created_by_id, kind: 'person' } : null;
      if (recipient) {
        await this.o.host.notify(tx, {
          kind: 'run_failed', recipient, title: `Workflow «${wf?.name ?? run.workflow_id}» braucht einen Entscheid: ${error.message}`,
          subject: run.subject_type && run.subject_id ? { type: run.subject_type, id: run.subject_id } : null,
          data: { workflowId: run.workflow_id, runId: run.id, code: error.code },
        });
      }
    }
  }

  private async subjectContext(tx: Tx, type: string | null, id: string | null): Promise<Record<string, unknown> | null> {
    if (!type || !id) return null;
    const s = this.subjects.get(type);
    const snap = s ? await s.load(tx, id) : null;
    return snap ? { type, ...snap } : { type, id };
  }

  /** Bezug als Kontext für Ausdrücke (an der Lesesicht vorbei). */
  subjectContextOf(tx: Tx, type: string | null, id: string | null): Promise<Record<string, unknown> | null> {
    return this.asEngine(tx, () => this.subjectContext(tx, type, id));
  }

  /** Angemeldeter Bezugstyp. */
  subjectType(type: string): WorkflowSubject | undefined { return this.subjects.get(type); }

  /** Fehler eines Schritts, der sofort zum Vorfall führt (z. B. niemand zuständig). */
  failure(code: string, message: string): StepFailure { return new StepFailure(code, message, { incident: true }); }

  /**
   * Wartenden Lauf nach einer erledigten Aufgabe fortsetzen: nur, wenn er noch genau an diesem Schritt mit dieser
   * Folgenummer wartet. Ergebnis unter `steps.<id>`, Protokoll des Schritts, nächster Job (wieder als Workflow-Akteur).
   */
  async resumeAfterTask(tx: Tx, at: { runId: string; path: string; seq: number }, output: Record<string, unknown>): Promise<boolean> {
    return this.asEngine(tx, async () => {
      const run = (await tx.query<RunRow>(`SELECT * FROM ${this.t('workflow_run')} WHERE id = $1 FOR UPDATE`, [at.runId])).rows[0];
      if (!run || run.state !== 'waiting' || run.wake_at || run.cursor !== at.path || run.seq !== at.seq) return false;
      const def = await this.definition(tx, run.workflow_id, run.version);
      const step = stepAt(def, at.path);
      if (!step) return false;
      const attempt = ((await tx.query<{ n: number }>(`SELECT coalesce(max(attempt), 0)::int AS n FROM ${this.t('workflow_step')} WHERE run_id = $1 AND path = $2`,
        [run.id, at.path])).rows[0]?.n ?? 0) + 1;
      await this.logStep(tx, run, at.path, step, attempt, 'completed', { output, startedAt: this.now() });
      await this.continueAt(tx, run, advance(def, at.path, run.loops), { attempts: 0, outputs: { ...run.outputs, [step.id]: output } }, run.tenant_id);
      return true;
    });
  }

  private async slaJob(ctx: JobCtx): Promise<void> {
    if (!this.o.enabled) throw this.o.host.error(503, 'module-disabled', 'Workflows sind in dieser Umgebung ausgeschaltet');
    await this.tasks.slaJob(ctx);
  }

  private expressionContext(run: Pick<RunRow, 'trigger' | 'variables' | 'outputs' | 'loops' | 'input' | 'id' | 'workflow_id' | 'version'>, cursor: string,
    subject: Record<string, unknown> | null, actor: ActorRef): ExpressionContext {
    return {
      event: run.trigger.event ?? null, trigger: run.trigger, subject, steps: run.outputs,
      vars: { ...run.variables, ...loopBindings(cursor, run.loops) }, input: run.input ?? {}, actor,
      run: { id: run.id, workflowId: run.workflow_id, version: run.version }, now: this.now().toISOString(),
    };
  }

  /** Einen Schritt des Laufs ausführen (Job), Ergebnis protokollieren, nächsten Job einreihen. */
  private async execute(tx: Tx, run: RunRow, tenantId: string | null, limits: WorkflowLimits): Promise<void> {
    const def = await this.definition(tx, run.workflow_id, run.version);
    if (run.cursor === END) { await this.finish(tx, run, 'completed', null); return; }
    if (run.cursor === END_FAILED) { await this.finish(tx, run, 'failed', run.error); return; }
    const cursor = run.cursor;
    if (stepLimitReached(run.step_count, limits)) {
      await this.incident(tx, run, { code: 'limit-steps', message: `Höchstens ${limits.stepsPerRun} Schritte je Lauf`, path: cursor });
      return;
    }
    const actor: ActorRef = { id: run.actor_id, kind: run.actor_kind };
    if (!(await this.o.host.active(tx, actor))) {
      const wf = (await tx.query<WorkflowRow>(`SELECT * FROM ${this.t('workflow')} WHERE id = $1`, [run.workflow_id])).rows[0];
      if (wf && wf.state === 'active') await this.pause(tx, wf, 'Der Akteur des Workflows ist nicht mehr aktiv', null);
      await this.incident(tx, run, { code: 'actor-inactive', message: 'Der Akteur des Workflows ist nicht mehr aktiv; Workflow pausiert', path: cursor });
      return;
    }
    const step = stepAt(def, cursor);
    if (!step) { await this.incident(tx, run, { code: 'invalid-position', message: `Kein Schritt unter «${cursor}»`, path: cursor }); return; }
    const scope = await this.scopeOf(tx, run.workflow_id);
    const attempt = ((await tx.query<{ n: number }>(`SELECT coalesce(max(attempt), 0)::int AS n FROM ${this.t('workflow_step')} WHERE run_id = $1 AND path = $2`,
      [run.id, cursor])).rows[0]?.n ?? 0) + 1;
    const startedAt = this.now();
    const subject = await this.subjectContext(tx, run.subject_type, run.subject_id);
    const ctx = this.expressionContext(run, cursor, subject, actor);
    const log: string[] = [];
    await tx.query(`INSERT INTO ${this.t('workflow_usage')} AS u (tenant_id, day, steps) VALUES (coalesce($1::uuid, ${this.t('workflow_tenant')}()), $2::date, 1)
      ON CONFLICT (tenant_id, day) DO UPDATE SET steps = u.steps + 1`, [tenantId, this.day()]);

    let result: StepResult;
    try {
      result = await this.runStep(tx, def, step, cursor, run, ctx, { actor, scope, attempt, limits, dry: false, log, full: run });
    } catch (e) {
      const f = e instanceof StepFailure ? e : new StepFailure('action-failed', e instanceof Error ? e.message : String(e), {
        retryable: !(e !== null && typeof e === 'object' && (e as { retryable?: unknown }).retryable === false),
      });
      const error: StepError = { code: f.code, message: f.message, path: cursor };
      await this.logStep(tx, run, cursor, step, attempt, 'failed', { error, log, startedAt });
      await this.update(tx, run, { step_count: run.step_count + 1 });
      await this.handleFailure(tx, run, def, step, cursor, f, error, tenantId);
      return;
    }
    if (result.waitTask) {
      // Aufgabe angelegt: Lauf wartet ohne Job, bis sie erledigt ist (resumeAfterTask)
      await this.logStep(tx, run, cursor, step, attempt, 'waiting', { input: result.input, output: result.output, log, startedAt });
      await this.update(tx, run, { step_count: run.step_count + 1, attempts: 0, state: 'waiting', seq: run.seq + 1, wake_at: null });
      return;
    }
    await this.logStep(tx, run, cursor, step, attempt, 'completed', { input: result.input, output: result.output, log, startedAt });
    const outputs = result.stepOutput !== undefined ? { ...run.outputs, [step.id]: result.stepOutput } : run.outputs;
    const set: Partial<RunRow> = {
      step_count: run.step_count + 1, attempts: 0, outputs,
      ...(result.variables ? { variables: result.variables } : {}), ...(result.loops ? { loops: result.loops } : {}),
    };
    if (result.end) {
      await this.update(tx, run, set);
      await this.finish(tx, run, result.end.state, result.end.state === 'completed' ? null
        : { code: `end-${result.end.state}`, message: result.end.message ?? 'Lauf durch einen Schritt «Ende» beendet', path: cursor });
      return;
    }
    await this.continueAt(tx, run, result.next, set, tenantId, result.wakeAt);
  }

  /** Lauf an `next` fortsetzen: Ende, Warten oder nächster Job. */
  private async continueAt(tx: Tx, run: RunRow, next: Position, set: Partial<RunRow>, tenantId: string | null, wakeAt?: Date): Promise<void> {
    if (next === END) { await this.update(tx, run, set); await this.finish(tx, run, 'completed', null); return; }
    if (next === END_FAILED) { await this.update(tx, run, set); await this.finish(tx, run, 'failed', run.error); return; }
    const seq = run.seq + 1;
    if (wakeAt && wakeAt > this.now()) {
      await this.update(tx, run, { ...set, state: 'waiting', cursor: next, seq, wake_at: wakeAt });
      await this.enqueueStep(tx, tenantId, run.id, seq, wakeAt);
      return;
    }
    await this.update(tx, run, { ...set, state: 'running', cursor: next, seq, wake_at: null });
    await this.enqueueStep(tx, tenantId, run.id, seq);
  }

  private async handleFailure(tx: Tx, run: RunRow, def: WorkflowDefinition, step: Step, cursor: string, f: StepFailure, error: StepError, tenantId: string | null): Promise<void> {
    if (f.incident) { await this.incident(tx, run, error); return; }
    const own = step.onError;
    const onError: OnError = own ?? def.onError ?? {};
    const retries = onError.retry ?? DEFAULT_RETRY;
    if (f.retryable && run.attempts < retries) {
      const delay = this.o.retryDelayMs * 2 ** run.attempts;
      const seq = run.seq + 1;
      await this.update(tx, run, { attempts: run.attempts + 1, seq, error });
      await this.enqueueStep(tx, tenantId, run.id, seq, delay > 0 ? new Date(this.now().getTime() + delay) : undefined);
      return;
    }
    const then = onError.then ?? 'incident';
    if (then === 'continue') {
      await this.continueAt(tx, run, advance(def, cursor, run.loops), { attempts: 0, error, outputs: { ...run.outputs, [step.id]: { error } } }, tenantId);
      return;
    }
    if (then === 'path') {
      const next = own?.then === 'path' ? enter(def, `${cursor}/onError/steps`, run.loops) : enter(def, '/onError/steps', run.loops);
      await this.continueAt(tx, run, next, { attempts: 0, error, outputs: { ...run.outputs, [step.id]: { error } } }, tenantId);
      return;
    }
    await this.incident(tx, run, error);
  }

  private async scopeOf(tx: Tx, workflowId: string): Promise<ScopeRef> {
    const r = (await tx.query<{ scope_type: string; scope_id: string }>(`SELECT scope_type, scope_id FROM ${this.t('workflow')} WHERE id = $1`, [workflowId])).rows[0];
    return { type: r?.scope_type ?? 'tenant', id: r?.scope_id ?? '' };
  }

  private async logStep(tx: Tx, run: Pick<RunRow, 'id' | 'tenant_id'>, path: string, step: Step, attempt: number, state: 'completed' | 'failed' | 'skipped' | 'waiting',
    o: { input?: unknown; output?: unknown; error?: StepError; log?: string[]; startedAt: Date }): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.t('workflow_step')} (tenant_id, id, run_id, path, step_id, kind, attempt, state, input, output, log, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)`,
      [run.tenant_id, randomUUID(), run.id, path, step.id, kindOf(step), attempt, state,
        o.input === undefined ? null : JSON.stringify(redact(o.input)), o.output === undefined ? null : JSON.stringify(redact(o.output)),
        o.log?.length ? JSON.stringify(o.log) : null, o.error ? JSON.stringify(o.error) : null, o.startedAt, this.now()]);
  }

  /** Logik eines Schritts, gemeinsam für Ausführung und Probelauf. */
  private async runStep(tx: Tx, def: WorkflowDefinition, step: Step, cursor: string,
    run: Pick<RunRow, 'id' | 'workflow_id' | 'version' | 'variables' | 'loops' | 'subject_type' | 'subject_id' | 'chain_depth'>, ctx: ExpressionContext,
    o: { actor: ActorRef; scope: ScopeRef; attempt: number; limits: WorkflowLimits; dry: boolean; log: string[]; full?: RunRow }): Promise<StepResult> {
    const loops = run.loops;
    const expr = <T>(fn: () => T): T => {
      try { return fn(); } catch (e) { throw new StepFailure('expression', e instanceof Error ? e.message : String(e)); }
    };

    if ('action' in step) {
      const action = this.actions.get(step.action);
      if (!action) throw new StepFailure('unknown-action', `Unbekannte Aktion «${step.action}»`);
      const input = expr(() => resolveValue(step.input ?? {}, ctx));
      const validate = this.inputValidators.get(action.key);
      if (validate && !validate(input)) {
        const first = validate.errors?.[0];
        throw new StepFailure('invalid-input', `Eingabe für «${action.label}» ungültig${first ? ` (${first.instancePath || '/'}: ${first.message ?? first.keyword})` : ''}`);
      }
      const missing: string[] = [];
      for (const n of action.needs?.(input) ?? []) {
        const on = n.resource.id !== undefined ? { type: n.resource.type, id: n.resource.id } : o.scope;
        if (!(await this.o.host.can(tx, o.actor, n.perm, on))) missing.push(n.perm);
      }
      const subject = run.subject_type && run.subject_id ? { type: run.subject_type, id: run.subject_id } : null;
      const actionCtx: ActionContext = {
        tx, host: this.o.host, actor: o.actor, run: { id: run.id, workflowId: run.workflow_id, version: run.version }, subject,
        vars: { ...(ctx.vars as Record<string, unknown>), steps: ctx.steps }, idempotencyKey: `${run.id}:${cursor}:${o.attempt}`, dryRun: o.dry,
        log: message => { if (o.log.length < 50) o.log.push(String(message).slice(0, 500)); },
      };
      if (o.dry) {
        const r = action.dryRun ? await action.dryRun(actionCtx, input) : { summary: `würde «${action.label}» ausführen` };
        return { next: advance(def, cursor, loops), input, output: r.output, stepOutput: r.output ?? null, summary: r.summary, allowed: !missing.length, missing };
      }
      if (missing.length) {
        throw new StepFailure('forbidden', `Dem Akteur des Workflows fehlt das Recht ${missing.map(m => `«${m}»`).join(', ')} für «${action.label}»`, { incident: true });
      }
      await tx.query('SAVEPOINT workflow_action');
      let output: unknown;
      try {
        output = await this.withCausation(tx, { runId: run.id, depth: run.chain_depth }, () => action.run(actionCtx, input));
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT workflow_action');
        throw e;
      }
      await tx.query('RELEASE SAVEPOINT workflow_action');
      return { next: advance(def, cursor, loops), input, output, stepOutput: output ?? null };
    }

    if ('if' in step) {
      const result = expr(() => evaluateCondition(step.if, ctx));
      return { next: enter(def, `${cursor}/${result ? 'then' : 'else'}`, loops), output: { result }, stepOutput: { result }, summary: result ? 'Bedingung erfüllt' : 'Bedingung nicht erfüllt' };
    }

    if ('foreach' in step) {
      const source = step.foreach.items;
      const items = expr(() => (source.includes('{{') ? resolveValue(source, ctx) : resolvePath(ctx, source)));
      if (!Array.isArray(items)) throw new StepFailure('foreach-items', `«Für jedes»: «${source}» ist keine Liste`);
      const max = foreachLimit(step, o.limits);
      if (items.length > max) throw new StepFailure('limit-foreach', `«Für jedes»: ${items.length} Einträge, höchstens ${max}`);
      const next = { ...dropLoopsBelow(loops, cursor), [cursor]: { items, as: step.foreach.as } };
      return {
        next: items.length ? enter(def, `${cursor}/items/0/steps`, next) : advance(def, cursor, next), loops: next,
        output: { count: items.length }, stepOutput: { count: items.length }, summary: `${items.length} Einträge`,
      };
    }

    if ('wait' in step) {
      if (step.wait.event) throw new StepFailure('unsupported', 'Warten auf ein Ereignis folgt in Stufe 2');
      let until: Date;
      if (step.wait.duration && isBusinessDuration(step.wait.duration)) {
        // Arbeitszeit nach dem Standardkalender des Mandanten (Feiertage)
        const cal = await this.tasks.calendar(tx, null);
        until = expr(() => addWorkingTime(cal.calendar, this.now(), step.wait.duration!));
      } else if (step.wait.duration) until = expr(() => addDuration(this.now(), step.wait.duration!));
      else {
        const v = expr(() => resolveValue(step.wait.until, ctx));
        until = v instanceof Date ? v : new Date(typeof v === 'string' || typeof v === 'number' ? v : NaN);
        if (Number.isNaN(until.getTime())) throw new StepFailure('invalid-wait', `«Warten bis»: «${String(step.wait.until)}» ergibt keinen Zeitpunkt`);
      }
      const output = { until: until.toISOString() };
      return { next: advance(def, cursor, loops), wakeAt: o.dry ? undefined : until, output, stepOutput: output, summary: `würde warten bis ${until.toISOString()}` };
    }

    if ('set' in step) {
      const values = expr(() => resolveValue(step.set, ctx)) as Record<string, unknown>;
      return { next: advance(def, cursor, loops), variables: { ...run.variables, ...values }, output: values, stepOutput: values, summary: `setzt ${Object.keys(values).join(', ')}` };
    }

    if ('end' in step) {
      const message = step.end.message ? expr(() => String(resolveValue(step.end.message, ctx))) : null;
      return { next: END, end: { state: step.end.result, message }, output: { result: step.end.result, message }, summary: `beendet den Lauf (${step.end.result})` };
    }

    if ('task' in step || 'approval' in step) {
      const spec = 'task' in step ? step.task : step.approval;
      const what = 'task' in step ? 'die Aufgabe' : 'die Genehmigung';
      const title = expr(() => String(resolveValue(spec.title, ctx) ?? ''));
      if (o.dry || !o.full) {
        const outcome = 'task' in step ? (step.task.outcomes?.[0] ?? 'done') : 'approved';
        const out = { taskId: null, outcome, values: {}, ...('approval' in step ? { votes: [], reason: null } : {}) };
        return { next: advance(def, cursor, loops), input: { title }, output: out, stepOutput: out, summary: `würde ${what} «${title}» anlegen und warten (angenommen: «${outcome}»)` };
      }
      const full = o.full;
      await tx.query('SAVEPOINT workflow_task');
      let task;
      try {
        task = await this.withCausation(tx, { runId: run.id, depth: run.chain_depth }, () => this.tasks.createFromStep(tx, full, step as TaskStep | ApprovalStep, cursor, ctx));
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT workflow_task');
        throw e;
      }
      await tx.query('RELEASE SAVEPOINT workflow_task');
      return {
        next: cursor, waitTask: task.id, input: { title }, summary: `wartet auf ${what} «${title}»`,
        output: { taskId: task.id, assignee: task.assignee_id ? { id: task.assignee_id, kind: task.assignee_kind } : null, queueId: task.queue_id, dueAt: task.due_at },
      };
    }

    throw new StepFailure('unsupported', `Schrittart «${kindOf(step)}» folgt in einer späteren Stufe`);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Vorfälle

  /** Vorfall lösen: nochmals versuchen, Schritt überspringen oder Lauf abbrechen. */
  async resolveIncident(tx: Tx, run: RunRow, action: 'retry' | 'skip' | 'cancel', by: ActorRef): Promise<void> {
    await this.asEngine(tx, async () => {
      const tenantId = run.tenant_id;
      if (action === 'cancel') {
        await this.finish(tx, run, 'cancelled', { code: 'cancelled', message: 'Von Hand abgebrochen', path: run.cursor });
      } else if (action === 'retry') {
        const seq = run.seq + 1;
        await this.update(tx, run, { state: 'running', attempts: 0, seq, error: null });
        await this.enqueueStep(tx, tenantId, run.id, seq);
      } else {
        const def = await this.definition(tx, run.workflow_id, run.version);
        const cursor = run.cursor;
        if (cursor && cursor !== END_FAILED) {
          const step = stepAt(def, cursor);
          if (step) {
            const attempt = ((await tx.query<{ n: number }>(`SELECT coalesce(max(attempt), 0)::int AS n FROM ${this.t('workflow_step')} WHERE run_id = $1 AND path = $2`,
              [run.id, cursor])).rows[0]?.n ?? 0) + 1;
            await this.logStep(tx, run, cursor, step, attempt, 'skipped', { startedAt: this.now(), log: [`übersprungen von ${by.kind} ${by.id}`] });
          }
          await this.continueAt(tx, run, advance(def, cursor, run.loops), { attempts: 0, error: null }, tenantId);
        } else {
          await this.continueAt(tx, run, END, { attempts: 0, error: null }, tenantId);
        }
      }
      await this.emitFor(tx, run, 'workflow.incident_resolved', { workflowId: run.workflow_id, runId: run.id, resolution: action });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Probelauf

  /** Definition gegen einen Bezug, ein Ereignis oder eine Eingabe durchspielen, ohne zu schreiben. */
  async dryRun(tx: Tx, a: {
    workflowId: string; definition: WorkflowDefinition; actor: ActorRef; scope: ScopeRef; subject: SubjectRef | null;
    event: WorkflowEvent | null; input: Record<string, unknown> | null; limits: WorkflowLimits;
  }): Promise<DryRunResult> {
    const def = a.definition;
    const steps: DryRunStep[] = [];
    let triggerMatches: boolean | null = null;
    const run = {
      id: 'dry-run', workflow_id: a.workflowId, version: 0, variables: { ...(def.variables ?? {}) } as Record<string, unknown>,
      outputs: {} as Record<string, unknown>, loops: {} as Loops, input: a.input, subject_type: a.subject?.type ?? null, subject_id: a.subject?.id ?? null,
      chain_depth: 1, trigger: (a.event ? { event: { type: a.event.type, subject: a.event.subject, data: a.event.data, actor: a.event.actor ?? null } } : { manual: { by: a.actor } }) as RunTrigger,
    };
    let result: DryRunResult['result'] = 'completed';
    await tx.query('SAVEPOINT workflow_dry_run');
    try {
      if (a.event && def.kind === 'automation' && 'event' in def.trigger) {
        const t = def.trigger;
        triggerMatches = a.event.type === t.event && (!t.filter || (() => {
          try { return evaluateCondition(t.filter!, { event: run.trigger.event }); } catch { return false; }
        })());
      }
      const subject = await this.subjectContext(tx, run.subject_type, run.subject_id);
      let cursor: Position = def.kind === 'automation' ? enter(def, '/steps', run.loops) : END;
      let count = 0;
      while (cursor !== END && cursor !== END_FAILED) {
        if (count++ >= a.limits.stepsPerRun) { result = 'limit'; break; }
        const step = stepAt(def, cursor);
        if (!step) { result = 'failed'; break; }
        const ctx = this.expressionContext(run, cursor, subject, a.actor);
        const entry: DryRunStep = { path: cursor, stepId: step.id, kind: kindOf(step), label: step.label ?? null, summary: '' };
        steps.push(entry);
        try {
          const r = await this.runStep(tx, def, step, cursor, run, ctx, { actor: a.actor, scope: a.scope, attempt: 1, limits: a.limits, dry: true, log: [] });
          entry.summary = r.summary ?? '';
          if (r.input !== undefined) entry.input = redact(r.input);
          if (r.output !== undefined) entry.output = redact(r.output);
          if (r.allowed !== undefined) { entry.allowed = r.allowed; if (r.missing?.length) entry.missing = r.missing; }
          if (r.stepOutput !== undefined) run.outputs[step.id] = r.stepOutput;
          if (r.variables) run.variables = r.variables;
          if (r.loops) run.loops = r.loops;
          if (r.end) { result = r.end.state; break; }
          cursor = r.next;
        } catch (e) {
          entry.error = { code: e instanceof StepFailure ? e.code : 'action-failed', message: e instanceof Error ? e.message : String(e), path: cursor };
          entry.summary = `würde scheitern: ${entry.error.message}`;
          result = 'failed';
          break;
        }
      }
      if (cursor === END_FAILED) result = 'failed';
    } finally {
      await tx.query('ROLLBACK TO SAVEPOINT workflow_dry_run');
      await tx.query('RELEASE SAVEPOINT workflow_dry_run');
    }
    return { triggerMatches, result, steps, variables: redact(run.variables) as Record<string, unknown> };
  }
}
