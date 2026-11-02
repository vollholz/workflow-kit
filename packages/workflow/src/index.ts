/**
 * Einstieg `@vollholz/workflow`: `workflow(options)` steckt den Baukasten aus den Ports der App zusammen.
 *
 * Stufe 0 (Gerüst): Das Plugin meldet nur `GET <prefix>/workflows/status`; `dispatch` und `checkTransition` tun
 * nichts und dürfen von der App bereits aufgerufen werden (Hooks im Schreibpfad), `jobs` ist leer und `migrations`
 * liefert noch keine Migrationen (Datenbank ab Stufe 1). Die Optionen werden trotzdem vollständig geprüft, damit eine
 * App ihre Einbindung schon jetzt fertig bauen kann.
 *
 * Regel: Das Paket ist app-agnostisch. Es importiert nichts aus einer App oder einem App-Paket; alles Fachliche kommt
 * über die Ports in `ports.ts` (geprüft mit `npm run boundaries`). Fastify ist die einzige Rahmen-Annahme.
 */
import type { FastifyPluginAsync } from 'fastify';
import { validateDefinition, type DefinitionResult } from './definition.ts';
import type {
  CheckTransition, Dispatch, EventSource, FieldKind, Migration, MigrationOptions, StateField, WorkflowAction, WorkflowHost,
  WorkflowJob, WorkflowLimits, WorkflowSubject,
} from './ports.ts';

export * from './ports.ts';
export * from './definition.ts';
export * from './expressions.ts';
export { workflowPermissions, type WorkflowPermission, type WorkflowPermissionName } from './permissions.ts';
export { WORKFLOW_EVENT_TYPES, type WorkflowEventType, type WorkflowEventTypeName } from './events.ts';

/** Version des Pakets (gleich wie in package.json, geprüft im Test). */
export const WORKFLOW_PACKAGE_VERSION = '0.1.0';
/** Ausbaustufe nach Konzept Abschnitt 13. */
export const WORKFLOW_STAGE = 0;

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
  /** Datenbank-Schema der App für die Tabellen `workflow_*`. */
  schema: string;
  host: WorkflowHost;
  subjects: WorkflowSubject[];
  actions: WorkflowAction[];
  events: EventSource[];
  stateFields?: StateField[];
  /** Zusätzliche Feldarten für Aufgabenformulare (W11). */
  fields?: FieldKind[];
  limits?: Partial<WorkflowLimits>;
  /** Präfix der Routen (Standard `/v1`). */
  prefix?: string;
  /** Zur Laufzeit ausgeschaltet: Status meldet `enabled: false`, `dispatch` tut nichts (Standard `true`). */
  enabled?: boolean;
}

/** Antwort von `GET <prefix>/workflows/status`. */
export interface WorkflowStatus {
  /** Modul ist eingebunden. */
  configured: true;
  /** Modul ist in dieser Umgebung eingeschaltet. */
  enabled: boolean;
  /** Engine steht bereit (ab Stufe 1). */
  available: boolean;
  stage: number;
  version: string;
}

export interface Workflow {
  plugin: FastifyPluginAsync;
  dispatch: Dispatch;
  checkTransition: CheckTransition;
  jobs: WorkflowJob[];
  migrations(o: MigrationOptions): Migration[];
  /** Grenzen nach Vorgaben und Optionen. */
  limits: Readonly<WorkflowLimits>;
  /** Definition prüfen, mit den Aktionen, Ereignissen und Bezugstypen dieser App. */
  validate(definition: unknown): DefinitionResult;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const KEY = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const BUILTIN_FIELD_TYPES = new Set(['text', 'number', 'date', 'choice', 'actor', 'boolean', 'file']);

function ident(value: string, what: string): string {
  if (!IDENT.test(value)) throw new Error(`workflow: ${what} «${value}» ist kein gültiger Bezeichner (a–z, 0–9, «_»)`);
  return value;
}

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
  return Object.freeze(limits);
}

/** Baukasten zusammenstecken. Wirft bei widersprüchlichen Optionen (Fehler der Einbindung, nicht der Laufzeit). */
export function workflow(o: WorkflowOptions): Workflow {
  const limits = checkOptions(o);
  const enabled = o.enabled ?? true;
  const prefix = o.prefix ?? '/v1';
  const known = {
    actions: o.actions.map(a => a.key),
    events: o.events.map(e => e.type),
    subjectTypes: o.subjects.map(s => s.type),
  };

  const plugin: FastifyPluginAsync = async app => {
    app.get(`${prefix}/workflows/status`, async req => {
      o.host.actor(req); // nur angemeldet; die App wirft ihren eigenen Fehler
      const status: WorkflowStatus = { configured: true, enabled, available: false, stage: WORKFLOW_STAGE, version: WORKFLOW_PACKAGE_VERSION };
      return status;
    });
  };

  // Stufe 0: keine aktiven Auslöser – ein Aufruf kostet nichts und schreibt nichts.
  const dispatch: Dispatch = async () => {};
  // Stufe 0: keine Zustandsmodelle – jeder Wechsel ist erlaubt (wie ohne Modul).
  const checkTransition: CheckTransition = async () => ({ allowed: true });

  return {
    plugin,
    dispatch,
    checkTransition,
    jobs: [],
    migrations(m: MigrationOptions): Migration[] {
      ident(m.schema, 'Schema');
      ident(m.appRole, 'Rolle «appRole»');
      ident(m.schedRole, 'Rolle «schedRole»');
      return [];
    },
    limits,
    validate: definition => validateDefinition(definition, { known, maxForeach: limits.foreachItems }),
  };
}
