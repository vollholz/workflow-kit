/**
 * Typen der Antworten und Körper der REST-API von `@vollholz/workflow` (Stufe 1), wie sie über HTTP ankommen.
 *
 * Regel: Die Oberfläche hängt nicht von der Laufzeit des Backends ab und braucht auch dessen Typen nicht zu
 * installieren; die Typen hier beschreiben das JSON der Routen (README des Backends, Abschnitt «Routen»). Ändert sich
 * eine Route, wird dieser Typ mitgeführt.
 */

/** Akteur: Person oder Maschinen-Client (ID undurchsichtig). */
export interface ActorRefJson { id: string; kind: 'person' | 'client' }
/** Bereich oder Bezug `{ type, id }`. */
export interface RefJson { type: string; id: string }

export type JsonSchema = { [key: string]: unknown };

/** Feld für Bedingungen, Platzhalter und Formulare (`FieldDef` im Backend). */
export interface FieldDefJson {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  multiple?: boolean;
  options?: { value: string; label: string }[];
  description?: string;
}

// ---------------------------------------------------------------- Definition (Fassung 1)

export type ConditionOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'isSet' | 'isNotSet';
export interface FieldCondition { field: string; op: ConditionOp; value?: unknown }
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | FieldCondition;

export type Trigger =
  | { event: string; filter?: Condition; includeWorkflowEvents?: boolean }
  | { schedule: { cron: string; timezone: string } }
  | { manual: { label?: string; form?: FieldDefJson[] } }
  | { transition: { subjectType: string; field: string; from?: string[]; to?: string[] } }
  | { subflow: { inputs?: FieldDefJson[]; outputs?: FieldDefJson[] } };

export interface OnError { retry?: number; then?: 'continue' | 'path' | 'incident'; steps?: Step[] }

interface StepBase { id: string; label?: string; onError?: OnError }
export interface ActionStep extends StepBase { action: string; input?: Record<string, unknown> }
export interface IfStep extends StepBase { if: Condition; then: Step[]; else?: Step[] }
export interface ForeachStep extends StepBase { foreach: { items: string; as: string; limit?: number }; steps: Step[] }
export interface WaitStep extends StepBase { wait: { duration?: string; until?: string; event?: { type: string; condition?: Condition }; timeout?: string } }
export interface SetStep extends StepBase { set: Record<string, unknown> }
export interface EndStep extends StepBase { end: { result: 'completed' | 'cancelled' | 'failed'; message?: string } }
/** Schritte späterer Stufen (Aufgabe, Genehmigung, Unterablauf): der Editor zeigt sie nur an. */
export interface OtherStep extends StepBase { task?: unknown; approval?: unknown; subflow?: unknown }
export type Step = ActionStep | IfStep | ForeachStep | WaitStep | SetStep | EndStep | OtherStep;

export interface AutomationDefinition {
  schemaVersion: 1;
  kind: 'automation';
  name?: string;
  description?: string;
  variables?: Record<string, unknown>;
  onError?: OnError;
  trigger: Trigger;
  steps: Step[];
}
/** Definition, wie sie gespeichert ist (andere Arten zeigt der Editor nur an). */
export type WorkflowDefinition = AutomationDefinition | ({ schemaVersion: number; kind: 'case' | 'state_model' } & Record<string, unknown>);

export interface DefinitionError { path: string; message: string }

// ---------------------------------------------------------------- Routen

export type WorkflowState = 'draft' | 'active' | 'paused' | 'archived';
export type WorkflowKind = 'automation' | 'case' | 'state_model';

/** `GET /workflows/status`. */
export interface WorkflowStatusJson { configured: true; enabled: boolean; available: boolean; stage: number; version: string }

/** `GET /workflows/meta`. */
export interface WorkflowMetaJson {
  stage: number;
  events: { type: string; label: string; description: string | null; subjectType: string | null; filterFields: FieldDefJson[]; builtin: boolean }[];
  actions: { key: string; label: string; group: string; input: JsonSchema; output: JsonSchema | null }[];
  subjectTypes: { type: string; label: string; fields: FieldDefJson[] }[];
  stateFields: { subjectType: string; key: string; label: string }[];
  fieldKinds: { key: string; label: string; valueSchema: JsonSchema }[];
  stepKinds: string[];
  operators: string[];
  unaryOperators: string[];
  formatters: string[];
  canActAs: boolean;
}

export interface WorkflowLimitsJson {
  activeWorkflows: number; runsPerDay: number; stepsPerRun: number; foreachItems: number; httpCallsPerDay: number; chainDepth: number;
  runsPerSubjectPerMinute: number;
}

/** `GET`/`PUT /workflows/settings`. */
export interface WorkflowSettingsJson {
  enabled: boolean;
  limits: WorkflowLimitsJson;
  overrides: Partial<WorkflowLimitsJson>;
  maxLimits: WorkflowLimitsJson;
  revision: number;
  usage: { day: string; runs: number; runsRejected: number; steps: number; httpCalls: number; activeWorkflows: number };
}

/** Eintrag von `GET /workflows`. */
export interface WorkflowSummary {
  id: string; name: string; description: string | null; kind: WorkflowKind; scope: RefJson; state: WorkflowState; revision: number;
  activeVersion: number | null; actor: ActorRefJson | null; pausedReason: string | null; createdBy: ActorRefJson; createdAt: string; updatedAt: string;
}
/** `GET /workflows/:id` (Entwurf mit Definition); nach dem Speichern zusätzlich `validation`. */
export interface WorkflowDetail extends WorkflowSummary {
  definition: WorkflowDefinition;
  validation?: { ok: boolean; errors: DefinitionError[] };
}

/** `POST /workflows/validate`. */
export interface ValidationJson { ok: boolean; errors: DefinitionError[]; stage: DefinitionError[] }

export interface VersionJson {
  version: number; checksum: string; schemaVersion?: number; actor: ActorRefJson; activatedBy: ActorRefJson; activatedAt: string; active?: boolean;
  definition?: WorkflowDefinition;
}

export type RunState = 'running' | 'waiting' | 'completed' | 'failed' | 'incident' | 'cancelled';
export interface StepErrorJson { code: string; message: string; path?: string | null }

export interface RunJson {
  id: string; workflowId: string; version: number; triggerKind: 'event' | 'schedule' | 'manual';
  trigger: { event?: { type: string; subject: RefJson | null; data: Record<string, unknown> }; schedule?: { at: string }; manual?: { by: ActorRefJson } };
  subject: RefJson | null; actor: ActorRefJson; startedBy: ActorRefJson | null; state: RunState; position: string | null; attempts: number;
  stepCount: number; chainDepth: number; parentRunId: string | null; correlationId: string | null; variables: Record<string, unknown>;
  error: StepErrorJson | null; wakeAt: string | null; startedAt: string; updatedAt: string; finishedAt: string | null;
}
export interface RunStepJson {
  id: string; path: string; stepId: string; kind: string; attempt: number; state: string; input: unknown; output: unknown; log: string[];
  error: StepErrorJson | null; startedAt: string | null; finishedAt: string | null;
}
export interface RunDetailJson extends RunJson { steps: RunStepJson[] }
export interface RunPage { items: RunJson[]; nextCursor: string | null }

/** `POST /workflows/:id/dry-run`. */
export interface DryRunJson {
  triggerMatches: boolean | null;
  result: 'completed' | 'failed' | 'cancelled' | 'limit';
  steps: { path: string; stepId: string; kind: string; label: string | null; summary: string; input?: unknown; output?: unknown; allowed?: boolean; missing?: string[]; error?: StepErrorJson }[];
  variables: Record<string, unknown>;
}
