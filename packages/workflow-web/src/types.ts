/**
 * Typen der Antworten und Körper der REST-API von `@vollholz/workflow` (Stufe 2), wie sie über HTTP ankommen.
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
/** Zuständig: Akteur, Team, Pfad zu einem Akteur oder Warteschlange (ID). */
export type AssigneeJson = { actor: ActorRefJson } | { team: RefJson } | { field: string } | { queue: string };
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ApprovalMode = 'first' | 'all' | 'majority' | 'sequential';
/** Eskalation bei Verzug. */
export interface EscalationJson { notify?: AssigneeJson[]; raisePriority?: boolean; queue?: string }
export interface TaskStep extends StepBase {
  task: {
    title: string; description?: string; assignee: AssigneeJson; form?: FieldDefJson[]; outcomes?: string[]; due?: string; priority?: TaskPriority;
    escalation?: EscalationJson;
  };
}
export interface ApprovalStep extends StepBase {
  approval: {
    title: string; description?: string; approvers: AssigneeJson[]; mode: ApprovalMode; due?: string; priority?: TaskPriority; reasonOnReject?: boolean;
    escalation?: EscalationJson;
  };
}
/** Schritte späterer Stufen (Unterablauf): der Editor zeigt sie nur an. */
export interface OtherStep extends StepBase { subflow?: unknown }
export type Step = ActionStep | IfStep | ForeachStep | WaitStep | SetStep | EndStep | TaskStep | ApprovalStep | OtherStep;

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
  /** Bietet die App eine Auswahl von Teams an (`GET /queues/teams`)? */
  teams?: boolean;
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

// ---------------------------------------------------------------- Aufgaben und Warteschlangen (Stufe 2)

export type TaskKind = 'task' | 'approval';
export type TaskState = 'open' | 'in_progress' | 'done' | 'cancelled';
export type TaskView = 'mine' | 'team' | 'all';
export type TaskSort = 'urgency' | 'due' | 'age';

/** Was die angemeldete Person mit einer Aufgabe tun darf (vom Server berechnet). */
export interface TaskActionsJson { take: boolean; release: boolean; complete: boolean; decide: boolean; assign: boolean; handOver: boolean; cancel: boolean }

/** Eintrag von `GET /tasks`. `hidden`: Bezug für dich nicht sichtbar, Titel neutral. */
export interface TaskJson {
  id: string; kind: TaskKind; title: string; description: string | null; hidden: boolean;
  subject: { type: string; id: string; title: string | null } | null;
  workflowId: string | null; runId: string | null; stepId: string | null; state: TaskState; priority: TaskPriority;
  assignee: ActorRefJson | null; queue: { id: string; name: string | null } | null; candidates: ActorRefJson[];
  mode: ApprovalMode | null; reasonRequired: boolean; form: FieldDefJson[]; outcomes: string[]; outcome: string | null;
  values: Record<string, unknown> | null; reason: string | null; dueAt: string | null; breachedAt: string | null; overdue: boolean;
  createdAt: string; updatedAt: string; assignedAt: string | null; completedAt: string | null; completedBy: ActorRefJson | null;
  revision: number; voted: boolean; actions: TaskActionsJson;
}
export interface VoteJson { actor: ActorRefJson; decision: 'approved' | 'rejected'; reason: string | null; at: string }
/** `GET /tasks/:id`. */
export interface TaskDetailJson extends TaskJson {
  votes: VoteJson[];
  sla: { target: string; startedAt: string; dueAt: string; breachedAt: string | null; escalatedAt: string | null; stoppedAt: string | null; calendarId: string | null } | null;
}
export interface TaskPage { items: TaskJson[]; total: number; view: TaskView; sort: TaskSort }
/** `GET /tasks/counts`. */
export interface TaskCountsJson { mine: { open: number; overdue: number }; team: { open: number; overdue: number; unassigned: number } }
/** `POST /tasks/bulk`. */
export interface BulkResultJson { results: { id: string; ok: boolean; code?: string; message?: string }[]; ok: number; failed: number }

export type QueueAssignment = 'pull' | 'round_robin' | 'least_load';
export interface QueueJson {
  id: string; name: string; description: string | null; team: RefJson; sort: TaskSort; assignment: QueueAssignment; calendarId: string | null;
  slaTarget: string | null; escalation: EscalationJson | null; revision: number; createdAt: string; updatedAt: string;
  member?: boolean; counts?: { open: number; overdue: number; unassigned: number };
}
export interface QueueBody {
  name?: string; description?: string | null; team?: RefJson; sort?: TaskSort; assignment?: QueueAssignment; calendarId?: string | null;
  slaTarget?: string | null; escalation?: EscalationJson | null;
}
export interface TeamOptionJson { type: string; id: string; label: string; /** Überschrift der Gruppe in der Auswahl (App). */ group?: string }
export interface MemberJson extends ActorRefJson { open: number }

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface CalendarJson {
  id: string; name: string; timezone: string; week: Partial<Record<WeekdayKey, [string, string][]>>; holidays: { date: string; label?: string }[];
  isDefault: boolean; revision: number; createdAt: string; updatedAt: string;
}
export type CalendarBody = Partial<Pick<CalendarJson, 'name' | 'timezone' | 'week' | 'holidays' | 'isDefault'>>;