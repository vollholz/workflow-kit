/**
 * Einstieg `@vollholz/workflow`: `workflow(options)` steckt den Baukasten aus den Ports der App zusammen.
 *
 * Stufe 1 (Automation): Engine (`engine.ts`) mit `dispatch`, Jobs `workflow.step` und `workflow.start`, `tick` für
 * Zeitpläne, Migrationen (`workflow_001_core.sql`) und die REST-Routen (`routes.ts`). Stufe 2 (Aufgaben und
 * Warteschlangen): Schritte `task` und `approval` (`tasks.ts`), Fristen nach Kalender (`calendar.ts`) mit Job
 * `workflow.sla`, Formulare (`forms.ts`), Migration `workflow_002_tasks.sql` und Routen `/tasks`, `/queues`,
 * `/calendars` (`task-routes.ts`). `checkTransition` erlaubt noch jeden Wechsel (Zustandsmodelle folgen in Stufe 4). Die Optionen werden beim Zusammenstecken vollständig geprüft
 * (Fehler der Einbindung als `Error`).
 *
 * Regel: Das Paket ist app-agnostisch. Es importiert nichts aus einer App oder einem App-Paket; alles Fachliche kommt
 * über die Ports in `ports.ts` (geprüft mit `npm run boundaries`). Fastify ist die einzige Rahmen-Annahme.
 */
import type { FastifyPluginAsync } from 'fastify';
import { validateDefinition, type DefinitionResult } from './definition.ts';
import { Engine } from './engine.ts';
import { WORKFLOW_EVENT_TYPES } from './events.ts';
import { ident, workflowMigrations } from './migrations.ts';
import { registerRoutes } from './routes.ts';
import type {
  CheckTransition, Dispatch, EventSource, FieldKind, Migration, MigrationOptions, ScopeRef, StateField, Tx, WorkflowAction,
  WorkflowHost, WorkflowJob, WorkflowLimits, WorkflowSubject,
} from './ports.ts';

export * from './ports.ts';
export * from './definition.ts';
export * from './expressions.ts';
export { workflowPermissions, type WorkflowPermission, type WorkflowPermissionName } from './permissions.ts';
export { WORKFLOW_EVENT_TYPES, type WorkflowEventType, type WorkflowEventTypeName } from './events.ts';
export {
  CronError, addDuration, isBusinessDuration, isValidTimeZone, nextCronTime, parseCron, parseDuration, type CronSchedule, type DurationParts,
} from './cron.ts';
export {
  DEFAULT_WORK_CALENDAR, WEEKDAY_KEYS, addWorkingTime, calendarProblems, isWorkingTime,
  type Holiday, type WeekdayKey, type WorkCalendar, type WorkWeek,
} from './calendar.ts';
export { workflowMigrations, WORKFLOW_MIGRATIONS_DIR } from './migrations.ts';
export {
  DEFAULT_RETRY, WORKFLOW_JOB_START, WORKFLOW_JOB_STEP, StepFailure, chainDecision, definitionChecksum, effectiveLimits, foreachLimit,
  redact, stageProblems, stepLimitReached,
  type DryRunResult, type DryRunStep, type RunState, type RunTrigger, type StepError, type TenantSettings, type TriggerKind,
} from './engine.ts';
export type { WorkflowMeta, WorkflowStatus } from './routes.ts';
export type { TaskActions } from './task-routes.ts';
export { FormChecker, type FormError, type FormResult } from './forms.ts';
export {
  ACTIVE_STATES, HIDDEN_TITLE, PRIORITIES, WORKFLOW_JOB_SLA, actorFrom, approvalOutcome, leastLoaded, nextRoundRobin, raisePriority, rotateAfter,
  type Decision, type QueueAssignment, type QueueSort, type TaskKind, type TaskState,
} from './tasks.ts';

/** Version des Pakets (gleich wie in package.json, geprüft im Test). */
export const WORKFLOW_PACKAGE_VERSION = '0.4.0';
/** Ausbaustufe nach Konzept Abschnitt 13. */
export const WORKFLOW_STAGE = 2;

/** Vorgaben für die Grenzen je Mandant (Konzept 4.9). */
export const DEFAULT_LIMITS: Readonly<WorkflowLimits> = Object.freeze({
  activeWorkflows: 50,
  runsPerDay: 10_000,
  stepsPerRun: 50,
  foreachItems: 100,
  httpCallsPerDay: 1_000,
  chainDepth: 5,
  runsPerSubjectPerMinute: 10,
});

export interface WorkflowOptions {
  /** Datenbank-Schema der App für die Tabellen `workflow_*` (wie in `migrations({ schema })`). */
  schema: string;
  host: WorkflowHost;
  subjects: WorkflowSubject[];
  actions: WorkflowAction[];
  events: EventSource[];
  stateFields?: StateField[];
  /** Zusätzliche Feldarten für Aufgabenformulare (W11). */
  fields?: FieldKind[];
  /** Obergrenzen der App; ein Mandant kann sie in den Einstellungen nur senken. */
  limits?: Partial<WorkflowLimits>;
  /** Präfix der Routen (Standard `/v1`). */
  prefix?: string;
  /** Zur Laufzeit ausgeschaltet: Routen 404 `module-disabled`, `dispatch` und `tick` tun nichts (Standard `true`). */
  enabled?: boolean;
  /** Bereich für Rechte, die den ganzen Mandanten betreffen (Einstellungen); Standard `{ type: 'tenant', id: '*' }`. */
  tenantScope?: ScopeRef;
  /** Lebensdauer des Zwischenspeichers der Auslöser je Mandant in ms (Standard 10 000). */
  triggerCacheMs?: number;
  /** Wartezeit vor der ersten Wiederholung eines Schritts in ms, verdoppelt je Versuch (Standard 30 000). */
  retryDelayMs?: number;
  /** Uhr (für Tests; Standard `() => new Date()`). */
  clock?: () => Date;
}

export interface Workflow {
  plugin: FastifyPluginAsync;
  /** Ereignis der App prüfen; in derselben Transaktion wie `emit` (W3). */
  dispatch: Dispatch;
  checkTransition: CheckTransition;
  /** Job-Handler `workflow.step`, `workflow.start` und `workflow.sla` für die Job-Warteschlange der App. */
  jobs: WorkflowJob[];
  /**
   * Fällige Zeitpläne starten und überschrittene Fristen markieren (der Worker der App ruft das regelmässig auf, z. B.
   * jede Minute); liefert die Zahl der eingereihten Jobs (`workflow.start` und `workflow.sla`). Mit der Worker-Rolle über
   * alle Mandanten, mit der Laufzeit-Rolle für den Mandanten der `tx`.
   */
  tick(tx: Tx, o?: { limit?: number }): Promise<number>;
  /** Zwischenspeicher der Auslöser verwerfen (alle oder ein Mandant), z. B. nach `LISTEN workflow_triggers`. */
  invalidateTriggers(tenantId?: string): void;
  migrations(o: MigrationOptions): Migration[];
  /** Grenzen nach Vorgaben und Optionen. */
  limits: Readonly<WorkflowLimits>;
  /** Definition prüfen, mit den Aktionen, Ereignissen und Bezugstypen dieser App. */
  validate(definition: unknown): DefinitionResult;
}

const KEY = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const BUILTIN_FIELD_TYPES = new Set(['text', 'number', 'date', 'choice', 'actor', 'boolean', 'file']);

function unique(values: string[], what: string): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) throw new Error(`workflow: ${what} «${v}» ist mehrfach angemeldet`);
    seen.add(v);
  }
}

function checkOptions(o: WorkflowOptions): Readonly<WorkflowLimits> {
  ident(o.schema, 'Schema');
  if (!o.host) throw new Error('workflow: «host» fehlt');
  unique(o.subjects.map(s => s.type), 'Bezugstyp');
  unique(o.actions.map(a => a.key), 'Aktion');
  unique(o.events.map(e => e.type), 'Ereignistyp');
  for (const a of o.actions) if (!KEY.test(a.key)) throw new Error(`workflow: Aktion «${a.key}» hat keinen gültigen Schlüssel`);
  for (const e of o.events) if (!KEY.test(e.type)) throw new Error(`workflow: Ereignistyp «${e.type}» hat keinen gültigen Schlüssel`);
  const types = new Set(o.subjects.map(s => s.type));
  for (const f of o.stateFields ?? []) {
    if (!types.has(f.subjectType)) throw new Error(`workflow: Zustandsfeld «${f.key}» gehört zu unbekanntem Bezugstyp «${f.subjectType}»`);
  }
  unique((o.stateFields ?? []).map(f => `${f.subjectType}.${f.key}`), 'Zustandsfeld');
  for (const k of o.fields ?? []) if (BUILTIN_FIELD_TYPES.has(k.key)) throw new Error(`workflow: Feldart «${k.key}» ist im Paket schon vorhanden`);
  unique((o.fields ?? []).map(k => k.key), 'Feldart');
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  for (const [k, v] of Object.entries(limits)) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`workflow: Limit «${k}» muss eine ganze Zahl ≥ 1 sein`);
  }
  if (o.prefix !== undefined && !/^(\/[A-Za-z0-9_-]+)*$/.test(o.prefix)) throw new Error(`workflow: Präfix «${o.prefix}» ist ungültig`);
  for (const [k, v] of [['triggerCacheMs', o.triggerCacheMs], ['retryDelayMs', o.retryDelayMs]] as const) {
    if (v !== undefined && !(Number.isInteger(v) && v >= 0)) throw new Error(`workflow: «${k}» muss eine ganze Zahl ≥ 0 sein`);
  }
  return Object.freeze(limits);
}

/** Baukasten zusammenstecken. Wirft bei widersprüchlichen Optionen (Fehler der Einbindung, nicht der Laufzeit). */
export function workflow(o: WorkflowOptions): Workflow {
  const limits = checkOptions(o);
  const enabled = o.enabled ?? true;
  const prefix = o.prefix ?? '/v1';
  const known = {
    actions: o.actions.map(a => a.key),
    // Ereignisse des Baukastens (`workflow.*`) sind als Auslöser erlaubt (mit `includeWorkflowEvents`)
    events: [...o.events.map(e => e.type), ...WORKFLOW_EVENT_TYPES.map(e => e.type)],
    subjectTypes: o.subjects.map(s => s.type),
  };
  const validate = (definition: unknown) => validateDefinition(definition, { known, maxForeach: limits.foreachItems });
  const engine = new Engine({
    schema: o.schema, host: o.host, subjects: o.subjects, actions: o.actions, limits, enabled,
    clock: o.clock ?? (() => new Date()), retryDelayMs: o.retryDelayMs ?? 30_000, triggerCacheMs: o.triggerCacheMs ?? 10_000, fields: o.fields ?? [],
  });

  const plugin: FastifyPluginAsync = async app => {
    registerRoutes(app, {
      engine, host: o.host, schema: o.schema, prefix, enabled, stage: WORKFLOW_STAGE, version: WORKFLOW_PACKAGE_VERSION,
      tenantScope: o.tenantScope ?? { type: 'tenant', id: '*' }, subjects: o.subjects, actions: o.actions, events: o.events,
      stateFields: o.stateFields ?? [], fields: o.fields ?? [], validate,
    });
  };

  // Stufe 1: noch keine Zustandsmodelle – jeder Wechsel ist erlaubt (wie ohne Modul).
  const checkTransition: CheckTransition = async () => ({ allowed: true });

  return {
    plugin,
    dispatch: (tx, event, d) => engine.dispatch(tx, event, d),
    checkTransition,
    jobs: engine.jobs,
    tick: (tx, t) => engine.tick(tx, t),
    invalidateTriggers: tenantId => engine.invalidate(tenantId),
    migrations: m => workflowMigrations(m),
    limits,
    validate,
  };
}
