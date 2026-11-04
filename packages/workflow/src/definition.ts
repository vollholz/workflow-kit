/**
 * Definition eines Workflows: Typen, JSON-Schema und Prüfung beim Speichern (Konzept 4.1–4.4, 8.3).
 *
 * Eine Definition hat eine Art (`automation`, `case`, `state_model`), einen Auslöser und eine Schrittliste. Jeder
 * Schritt hat eine `id` und genau eine Art: `action`, `if`, `foreach`, `wait`, `task`, `approval`, `subflow`, `end` oder
 * `set`. Bedingungen sind strukturierte Ausdrücke (`expressions.ts`), Texte dürfen Platzhalter enthalten.
 *
 * Fassung 2 (UX-Neukonzept E2): Aufgabe und Genehmigung tragen Wege nach Ergebnis (`branches`, Ergebnis → Schritte);
 * nach dem Weg geht es nach dem Schritt weiter. Ergebnisse einer Aufgabe sind Text (z. B. «Nachbessern»), ohne «/» und
 * «~». Fassung 1 bleibt gültig, kennt aber keine Wege.
 *
 * Regeln:
 * - Das Schema ist versioniert (`schemaVersion`); eine neue Fassung bekommt eine neue Nummer, alte bleiben lesbar.
 * - `validateDefinition` prüft zuerst das Schema (ajv), dann den Inhalt (eindeutige Schritt-IDs, Verweise auf
 *   Schritte, Platzhalter, Zustände). Meldungen sind deutsch und tragen den Pfad als JSON Pointer (`/steps/0/if`).
 * - Dazu Hinweise (`warnings`), die nicht hindern: ein Weg, auf dem nichts geschieht, Schritte nach «Beenden», ein
 *   «Wenn» ohne Schritte.
 * - Fachliche Schlüssel (Aktionen, Ereignistypen) kennt das Paket nicht; wer sie prüfen will, übergibt sie in `known`.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { CONDITION_OPS, isValidPath, parseTemplate, UNARY_OPS, type Condition } from './expressions.ts';
import type { ActorRef, FieldDef, JsonSchema, TeamRef } from './ports.ts';

/** Aktuelle Fassung des Definitionsschemas (2: Wege nach Ergebnis). */
export const DEFINITION_SCHEMA_VERSION = 2;
/** Fassungen, die gelesen und geprüft werden. */
export type DefinitionSchemaVersion = 1 | 2;

export type WorkflowKind = 'automation' | 'case' | 'state_model';
/** Dauer nach ISO 8601, zusätzlich Arbeitstage `BD` und Arbeitsstunden `BH` (z. B. `P3BD`, `PT8BH`, `PT4H`). */
export type Duration = string;

export interface EventTrigger { event: string; filter?: Condition; includeWorkflowEvents?: boolean }
export interface ScheduleTrigger { schedule: { cron: string; timezone: string } }
export interface ManualTrigger { manual: { label?: string; form?: FieldDef[] } }
export interface TransitionTrigger { transition: { subjectType: string; field: string; from?: string[]; to?: string[] } }
export interface SubflowTrigger { subflow: { inputs?: FieldDef[]; outputs?: FieldDef[] } }
export type Trigger = EventTrigger | ScheduleTrigger | ManualTrigger | TransitionTrigger | SubflowTrigger;

/** Fehlerbehandlung je Schritt oder für die ganze Definition. */
export interface OnError {
  /** Wiederholungen bei vorübergehendem Fehler (0–10). */
  retry?: number;
  /** Danach: weiter, eigener Pfad oder Vorfall (Standard `incident`). */
  then?: 'continue' | 'path' | 'incident';
  /** Schritte des Fehlerpfads (nur mit `then: 'path'`). */
  steps?: Step[];
}

/**
 * Wer eine Aufgabe oder Genehmigung erhält: ein Akteur, ein Team (`host.members`), ein Pfad, der einen Akteur liefert
 * (z. B. `subject.values.owner`), oder eine Warteschlange (ID, Zuweisung nach ihrer Regel).
 */
export type Assignee = { actor: ActorRef } | { team: TeamRef } | { field: string } | { queue: string };

/** Eskalation bei Verzug: weitere Akteure benachrichtigen, Priorität um eine Stufe erhöhen, an eine Warteschlange umleiten. */
export interface Escalation { notify?: Assignee[]; raisePriority?: boolean; queue?: string }

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

interface StepBase { id: string; label?: string; onError?: OnError }
export interface ActionStep extends StepBase { action: string; input?: Record<string, unknown> }
export interface IfStep extends StepBase { if: Condition; then: Step[]; else?: Step[] }
export interface ForeachStep extends StepBase { foreach: { items: string; as: string; limit?: number }; steps: Step[] }
export interface WaitStep extends StepBase {
  wait: { duration?: Duration; until?: string; event?: { type: string; condition?: Condition }; timeout?: Duration };
}
export interface TaskStep extends StepBase {
  task: {
    title: string; description?: string; assignee: Assignee; form?: FieldDef[]; outcomes?: string[]; due?: Duration; priority?: TaskPriority;
    escalation?: Escalation;
  };
  /** Wege nach Ergebnis (Fassung 2): Schritte je Ergebnis, danach weiter nach der Aufgabe. */
  branches?: Record<string, Step[]>;
}
export type ApprovalMode = 'first' | 'all' | 'majority' | 'sequential';
export interface ApprovalStep extends StepBase {
  approval: {
    title: string; description?: string; approvers: Assignee[]; mode: ApprovalMode; due?: Duration; priority?: TaskPriority;
    /** Begründung bei Ablehnung Pflicht (Standard `true`). */
    reasonOnReject?: boolean; escalation?: Escalation;
  };
  /** Wege nach Ergebnis (Fassung 2). */
  branches?: { approved?: Step[]; rejected?: Step[] };
}
export interface SubflowStep extends StepBase { subflow: { workflow: string; input?: Record<string, unknown>; wait?: boolean } }
export interface EndStep extends StepBase { end: { result: 'completed' | 'cancelled' | 'failed'; message?: string } }
export interface SetStep extends StepBase { set: Record<string, unknown> }
export type Step = ActionStep | IfStep | ForeachStep | WaitStep | TaskStep | ApprovalStep | SubflowStep | EndStep | SetStep;

/** Arten von Schritten (Schlüssel, der die Art bestimmt). */
export const STEP_KINDS = ['action', 'if', 'foreach', 'wait', 'task', 'approval', 'subflow', 'end', 'set'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface Phase { id: string; label: string; steps: Step[] }
export interface StateTransition {
  id: string;
  name: string;
  /** Ausgangswerte oder `*` für jeden Wert. */
  from: string[] | '*';
  to: string;
  condition?: Condition;
  requiredFields?: string[];
  approval?: ApprovalStep['approval'];
  steps?: Step[];
}

interface DefinitionBase {
  schemaVersion: DefinitionSchemaVersion;
  name?: string;
  description?: string;
  variables?: Record<string, unknown>;
  onError?: OnError;
}
export interface AutomationDefinition extends DefinitionBase { kind: 'automation'; trigger: Trigger; steps: Step[] }
export interface CaseDefinition extends DefinitionBase { kind: 'case'; trigger?: Trigger; steps?: Step[]; phases?: Phase[] }
export interface StateModelDefinition extends DefinitionBase {
  kind: 'state_model';
  subjectType: string;
  field: string;
  states: { value: string; label?: string; initial?: boolean }[];
  transitions: StateTransition[];
}
export type WorkflowDefinition = AutomationDefinition | CaseDefinition | StateModelDefinition;

export interface DefinitionError { path: string; message: string }
/** Ergebnis der Prüfung; `warnings` sind Hinweise, die nicht hindern (nur bei gültigem Schema). */
export type DefinitionResult =
  | { ok: true; definition: WorkflowDefinition; errors: []; warnings: DefinitionError[] }
  | { ok: false; errors: DefinitionError[]; warnings: DefinitionError[] };

/** Ergebnisse einer Aufgabe bzw. Genehmigung (ohne Angabe bei der Aufgabe: `done`). */
export function outcomesOf(step: TaskStep | ApprovalStep): string[] {
  return 'approval' in step ? ['approved', 'rejected'] : (step.task.outcomes?.length ? step.task.outcomes : ['done']);
}

/** Bezeichnung eines Ergebnisses für Meldungen («done» → «Erledigt»). */
export function outcomeName(outcome: string): string {
  return ({ done: 'Erledigt', approved: 'Genehmigt', rejected: 'Abgelehnt', cancelled: 'Abgebrochen' } as Record<string, string>)[outcome] ?? outcome;
}

export interface ValidateOptions {
  /**
   * Bekannte Schlüssel; fehlt eine Liste, wird nicht dagegen geprüft. `inputs`: Pflichtfelder je Aktion (Schlüssel und
   * Bezeichnung) – ein fehlendes oder leeres Pflichtfeld ist ein Fehler.
   */
  known?: { actions?: Iterable<string>; events?: Iterable<string>; subjectTypes?: Iterable<string>; inputs?: Record<string, { key: string; title: string }[]> };
  /** Obergrenze für `foreach.limit` (Standard 1000). */
  maxForeach?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON-Schema

const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const steps = { type: 'array', items: ref('step') };
const text = { type: 'string', minLength: 1, maxLength: 2000 };
const common = { id: ref('id'), label: { type: 'string', maxLength: 200 }, onError: ref('onError') };
const kindOf = (key: string, own: Record<string, unknown>, required: string[] = [key]) => ({
  if: { required: [key] },
  then: { type: 'object', properties: { ...common, ...own }, required: ['id', ...required], additionalProperties: false },
});
const variant = (key: string, props: Record<string, unknown>, required: string[] = []) => ({
  if: { required: [key] },
  then: { properties: props, required: [key, ...required], additionalProperties: false },
});

/** JSON-Schema einer Workflow-Definition (Fassung `DEFINITION_SCHEMA_VERSION`). */
export const definitionSchema: JsonSchema = {
  $id: 'https://vollholz.ch/schemas/workflow-definition.json',
  title: 'Workflow-Definition',
  type: 'object',
  required: ['schemaVersion', 'kind'],
  additionalProperties: false,
  properties: {
    schemaVersion: { enum: [1, DEFINITION_SCHEMA_VERSION] },
    kind: { enum: ['automation', 'case', 'state_model'] },
    name: { type: 'string', maxLength: 200 },
    description: { type: 'string', maxLength: 4000 },
    variables: { type: 'object', propertyNames: ref('name') },
    onError: ref('onError'),
    trigger: ref('trigger'),
    steps,
    phases: { type: 'array', minItems: 1, items: ref('phase') },
    subjectType: ref('key'),
    field: ref('key'),
    states: { type: 'array', minItems: 1, items: ref('state') },
    transitions: { type: 'array', items: ref('transition') },
  },
  allOf: [
    { if: { properties: { kind: { const: 'automation' } } }, then: { required: ['trigger', 'steps'] } },
    {
      if: { properties: { kind: { const: 'case' } } },
      then: { description: 'Fall: entweder «steps» oder «phases»', oneOf: [{ required: ['steps'] }, { required: ['phases'] }] },
    },
    {
      if: { properties: { kind: { const: 'state_model' } } },
      then: { required: ['subjectType', 'field', 'states', 'transitions'] },
    },
  ],
  $defs: {
    id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$', description: 'ID: Buchstabe, dann Buchstaben, Ziffern, «_» oder «-» (höchstens 64 Zeichen)' },
    name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$', description: 'Name: Buchstabe oder «_», dann Buchstaben, Ziffern oder «_»' },
    key: { type: 'string', pattern: '^[a-z][a-z0-9_-]*(\\.[a-z0-9_-]+)*$', maxLength: 120, description: 'Schlüssel: Kleinbuchstaben, Ziffern, «_», «-», Teile mit «.» getrennt' },
    path: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_-]*(\\.[A-Za-z0-9_-]+)*$', maxLength: 300, description: 'Pfad: Teile mit «.» getrennt, z. B. «subject.values.owner»' },
    duration: {
      type: 'string',
      pattern: '^P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+B?D)?(T(?=\\d)(\\d+B?H)?(\\d+M)?(\\d+S)?)?$',
      description: 'Dauer nach ISO 8601, z. B. «PT4H», «P2D», «P3BD» (Arbeitstage) oder «PT8BH» (Arbeitsstunden)',
    },
    outcome: {
      type: 'string', pattern: '^[^/~\\s](?:[^/~]{0,62}[^/~\\s])?$',
      description: 'Ergebnis: 1–64 Zeichen ohne «/» und «~», ohne Leerzeichen am Anfang oder Ende',
    },
    uuid: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'ID im Format UUID' },
    priority: { enum: ['low', 'normal', 'high', 'urgent'] },
    escalation: {
      type: 'object', additionalProperties: false,
      properties: { notify: { type: 'array', items: ref('assignee') }, raisePriority: { type: 'boolean' }, queue: ref('uuid') },
    },
    actor: {
      type: 'object', required: ['id', 'kind'], additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1 }, kind: { enum: ['person', 'client'] } },
    },
    team: {
      type: 'object', required: ['type', 'id'], additionalProperties: false,
      properties: { type: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } },
    },
    assignee: {
      type: 'object',
      description: 'Zuständig: genau eines von «actor», «team», «field» oder «queue»',
      oneOf: [{ required: ['actor'] }, { required: ['team'] }, { required: ['field'] }, { required: ['queue'] }],
      allOf: [
        variant('actor', { actor: ref('actor') }), variant('team', { team: ref('team') }), variant('field', { field: ref('path') }),
        variant('queue', { queue: ref('uuid') }),
      ],
    },
    fieldDef: {
      type: 'object', required: ['key', 'label', 'type'], additionalProperties: false,
      properties: {
        key: ref('name'), label: text, type: { type: 'string', minLength: 1 }, required: { type: 'boolean' },
        multiple: { type: 'boolean' }, description: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'object', required: ['value', 'label'], additionalProperties: false, properties: { value: { type: 'string' }, label: { type: 'string' } } },
        },
      },
    },
    condition: {
      type: 'object',
      description: 'Bedingung: genau eines von «all», «any», «not» oder «field» mit «op»',
      oneOf: [{ required: ['all'] }, { required: ['any'] }, { required: ['not'] }, { required: ['field'] }],
      allOf: [
        variant('all', { all: { type: 'array', minItems: 1, items: ref('condition') } }),
        variant('any', { any: { type: 'array', minItems: 1, items: ref('condition') } }),
        variant('not', { not: ref('condition') }),
        variant('field', { field: ref('path'), op: { enum: [...CONDITION_OPS] }, value: {} }, ['op']),
        {
          if: { required: ['op'], properties: { op: { enum: [...UNARY_OPS] } } },
          then: { description: 'Dieser Vergleich braucht keinen Wert («value» weglassen)', not: { required: ['value'] } },
          else: { if: { required: ['op'] }, then: { required: ['value'] } },
        },
      ],
    },
    trigger: {
      type: 'object',
      description: 'Auslöser: genau eines von «event», «schedule», «manual», «transition» oder «subflow»',
      oneOf: [{ required: ['event'] }, { required: ['schedule'] }, { required: ['manual'] }, { required: ['transition'] }, { required: ['subflow'] }],
      allOf: [
        variant('event', { event: ref('key'), filter: ref('condition'), includeWorkflowEvents: { type: 'boolean' } }),
        variant('schedule', {
          schedule: {
            type: 'object', required: ['cron', 'timezone'], additionalProperties: false,
            properties: {
              cron: { type: 'string', pattern: '^\\S+( \\S+){4}$', description: 'Zeitplan: fünf Felder (Minute Stunde Tag Monat Wochentag)' },
              timezone: { type: 'string', minLength: 1 },
            },
          },
        }),
        variant('manual', {
          manual: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, form: { type: 'array', items: ref('fieldDef') } } },
        }),
        variant('transition', {
          transition: {
            type: 'object', required: ['subjectType', 'field'], additionalProperties: false,
            properties: { subjectType: ref('key'), field: ref('key'), from: { type: 'array', items: { type: 'string' } }, to: { type: 'array', items: { type: 'string' } } },
          },
        }),
        variant('subflow', {
          subflow: {
            type: 'object', additionalProperties: false,
            properties: { inputs: { type: 'array', items: ref('fieldDef') }, outputs: { type: 'array', items: ref('fieldDef') } },
          },
        }),
      ],
    },
    onError: {
      type: 'object', additionalProperties: false,
      properties: { retry: { type: 'integer', minimum: 0, maximum: 10 }, then: { enum: ['continue', 'path', 'incident'] }, steps },
      allOf: [
        { if: { required: ['then'], properties: { then: { const: 'path' } } }, then: { required: ['steps'] } },
        { if: { required: ['steps'] }, then: { description: '«steps» nur mit «then»: «path»', required: ['then'], properties: { then: { const: 'path' } } } },
      ],
    },
    approvalSpec: {
      type: 'object', required: ['title', 'approvers', 'mode'], additionalProperties: false,
      properties: {
        title: text, description: { type: 'string' }, approvers: { type: 'array', minItems: 1, items: ref('assignee') },
        mode: { enum: ['first', 'all', 'majority', 'sequential'] }, due: ref('duration'), priority: ref('priority'), reasonOnReject: { type: 'boolean' },
        escalation: ref('escalation'),
      },
    },
    step: {
      type: 'object',
      required: ['id'],
      description: `Schritt: genau eines von ${STEP_KINDS.map(k => `«${k}»`).join(', ')}`,
      oneOf: STEP_KINDS.map(k => ({ required: [k] })),
      allOf: [
        kindOf('action', { action: ref('key'), input: { type: 'object' } }),
        kindOf('if', { if: ref('condition'), then: steps, else: steps }, ['if', 'then']),
        kindOf('foreach', {
          foreach: {
            type: 'object', required: ['items', 'as'], additionalProperties: false,
            properties: { items: { type: 'string', minLength: 1 }, as: ref('name'), limit: { type: 'integer', minimum: 1, maximum: 1000 } },
          },
          steps,
        }, ['foreach', 'steps']),
        kindOf('wait', {
          wait: {
            type: 'object', additionalProperties: false,
            description: 'Warten: genau eines von «duration», «until» oder «event»',
            properties: {
              duration: ref('duration'), until: { type: 'string', minLength: 1 }, timeout: ref('duration'),
              event: { type: 'object', required: ['type'], additionalProperties: false, properties: { type: ref('key'), condition: ref('condition') } },
            },
            oneOf: [{ required: ['duration'] }, { required: ['until'] }, { required: ['event'] }],
            allOf: [
              { if: { required: ['event'] }, then: { required: ['timeout'] } },
              { if: { required: ['timeout'] }, then: { description: '«timeout» nur beim Warten auf ein Ereignis', required: ['event'] } },
            ],
          },
        }),
        kindOf('task', {
          task: {
            type: 'object', required: ['title', 'assignee'], additionalProperties: false,
            properties: {
              title: text, description: { type: 'string' }, assignee: ref('assignee'), form: { type: 'array', items: ref('fieldDef') },
              outcomes: { type: 'array', minItems: 1, maxItems: 10, items: ref('outcome') }, due: ref('duration'),
              priority: ref('priority'), escalation: ref('escalation'),
            },
          },
          branches: { type: 'object', propertyNames: ref('outcome'), additionalProperties: steps },
        }),
        kindOf('approval', {
          approval: ref('approvalSpec'),
          branches: { type: 'object', additionalProperties: false, properties: { approved: steps, rejected: steps } },
        }),
        kindOf('subflow', {
          subflow: {
            type: 'object', required: ['workflow'], additionalProperties: false,
            properties: { workflow: { type: 'string', minLength: 1 }, input: { type: 'object' }, wait: { type: 'boolean' } },
          },
        }),
        kindOf('end', {
          end: {
            type: 'object', required: ['result'], additionalProperties: false,
            properties: { result: { enum: ['completed', 'cancelled', 'failed'] }, message: { type: 'string' } },
          },
        }),
        kindOf('set', { set: { type: 'object', minProperties: 1, propertyNames: ref('name') } }),
      ],
    },
    phase: {
      type: 'object', required: ['id', 'label', 'steps'], additionalProperties: false,
      properties: { id: ref('id'), label: text, steps },
    },
    state: {
      type: 'object', required: ['value'], additionalProperties: false,
      properties: { value: { type: 'string', minLength: 1 }, label: { type: 'string' }, initial: { type: 'boolean' } },
    },
    transition: {
      type: 'object', required: ['id', 'name', 'from', 'to'], additionalProperties: false,
      properties: {
        id: ref('id'), name: text,
        from: { oneOf: [{ const: '*' }, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }], description: 'Ausgangswerte als Liste oder «*»' },
        to: { type: 'string', minLength: 1 }, condition: ref('condition'),
        requiredFields: { type: 'array', items: { type: 'string', minLength: 1 } }, approval: ref('approvalSpec'), steps,
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Prüfung

let compiled: ValidateFunction | null = null;
function schemaValidator(): ValidateFunction {
  compiled ??= new Ajv({ allErrors: true, verbose: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true }).compile(definitionSchema);
  return compiled;
}

const TYPE_NAMES: Record<string, string> = {
  string: 'Text', number: 'Zahl', integer: 'ganze Zahl', boolean: 'Ja/Nein (true/false)', object: 'Angaben in {…}', array: 'Liste', null: 'null',
};

function germanMessage(e: ErrorObject): DefinitionError | null {
  const at = e.instancePath || '';
  const p = e.params as Record<string, unknown>;
  const parent = e.parentSchema as { description?: string; oneOf?: unknown } | undefined;
  const desc = parent?.description;
  switch (e.keyword) {
    case 'required': return { path: `${at}/${String(p.missingProperty)}`, message: `Pflichtangabe «${String(p.missingProperty)}» fehlt${desc && !parent?.oneOf ? `. ${desc}` : ''}` };
    case 'additionalProperties': return { path: `${at}/${String(p.additionalProperty)}`, message: `Unbekannte Angabe «${String(p.additionalProperty)}»` };
    case 'type': return { path: at, message: `Erwartet: ${String(p.type).split(',').map(t => TYPE_NAMES[t] ?? t).join(' oder ')}` };
    case 'enum': return { path: at, message: `Erlaubt: ${(p.allowedValues as unknown[]).map(v => `«${String(v)}»`).join(', ')}` };
    case 'const': return { path: at, message: `Erwartet: «${String(p.allowedValue)}»` };
    case 'minimum': return { path: at, message: `Mindestens ${String(p.limit)}` };
    case 'maximum': return { path: at, message: `Höchstens ${String(p.limit)}` };
    case 'minItems': return { path: at, message: `Mindestens ${String(p.limit)} Eintrag/Einträge` };
    case 'maxItems': return { path: at, message: `Höchstens ${String(p.limit)} Einträge` };
    case 'minLength': return { path: at, message: p.limit === 1 ? 'Darf nicht leer sein' : `Mindestens ${String(p.limit)} Zeichen` };
    case 'maxLength': return { path: at, message: `Höchstens ${String(p.limit)} Zeichen` };
    case 'minProperties': return { path: at, message: `Mindestens ${String(p.limit)} Angabe(n)` };
    case 'pattern': return { path: at, message: desc ? `Ungültige Schreibweise. ${desc}` : 'Ungültige Schreibweise' };
    case 'propertyNames': return { path: at, message: `Ungültiger Name «${String(p.propertyName)}»` };
    case 'oneOf': return { path: at, message: desc ?? 'Genau eine Variante erwartet' };
    case 'not': return { path: at, message: desc ?? 'Diese Angabe ist hier nicht erlaubt' };
    case 'if': return null; // die Fehler des «then»-Teils stehen einzeln da
    default: return { path: at, message: `Ungültig (${e.keyword})` };
  }
}

/** Fehler aus ajv auf Deutsch, ohne Folgefehler der Varianten und ohne Doppel. */
function schemaErrors(errors: ErrorObject[]): DefinitionError[] {
  // Fehler in einer Variante von «oneOf» sind Folgefehler: Die Meldung des «oneOf» sagt, was gemeint ist.
  const variantNoise = (e: ErrorObject) => /\/oneOf\/\d+\//.test(e.schemaPath);
  const propertyNameNoise = (e: ErrorObject) => e.schemaPath.includes('/propertyNames/');
  const out = new Map<string, DefinitionError>();
  for (const e of errors) {
    if (variantNoise(e) || propertyNameNoise(e)) continue;
    const m = germanMessage(e);
    if (m) out.set(`${m.path}\u0000${m.message}`, { path: m.path || '/', message: m.message });
  }
  return [...out.values()];
}

/** Durchläuft alle Schritte (verschachtelt) mit ihrem Pfad. */
export function* walkSteps(list: Step[] | undefined, base: string): Generator<[Step, string]> {
  if (!Array.isArray(list)) return;
  for (const [i, step] of list.entries()) {
    const path = `${base}/${i}`;
    yield [step, path];
    if ('if' in step) { yield* walkSteps(step.then, `${path}/then`); yield* walkSteps(step.else, `${path}/else`); }
    if ('foreach' in step) yield* walkSteps(step.steps, `${path}/steps`);
    if (('task' in step || 'approval' in step) && step.branches) {
      for (const [k, list] of Object.entries(step.branches)) yield* walkSteps(list, `${path}/branches/${k}`);
    }
    yield* walkSteps(step.onError?.steps, `${path}/onError/steps`);
  }
}

function* allSteps(d: WorkflowDefinition): Generator<[Step, string]> {
  yield* walkSteps(d.onError?.steps, '/onError/steps');
  if (d.kind === 'state_model') {
    for (const [i, t] of d.transitions.entries()) yield* walkSteps(t.steps, `/transitions/${i}/steps`);
    return;
  }
  yield* walkSteps(d.steps, '/steps');
  if (d.kind === 'case') for (const [i, ph] of (d.phases ?? []).entries()) yield* walkSteps(ph.steps, `/phases/${i}/steps`);
}

/** Alle Texte der Definition mit Pfad (für die Prüfung der Platzhalter). */
function* strings(v: unknown, path: string): Generator<[string, string]> {
  if (typeof v === 'string') yield [v, path];
  else if (Array.isArray(v)) for (const [i, x] of v.entries()) yield* strings(x, `${path}/${i}`);
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) yield* strings(x, `${path}/${k}`);
}

/** Pfade in Bedingungen (`field`) mit ihrer Fundstelle. */
function* conditionFields(v: unknown, path: string): Generator<[string, string]> {
  if (Array.isArray(v)) { for (const [i, x] of v.entries()) yield* conditionFields(x, `${path}/${i}`); return; }
  if (v === null || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  if (typeof o.field === 'string' && typeof o.op === 'string') yield [o.field, `${path}/field`];
  for (const [k, x] of Object.entries(o)) if (k !== 'field') yield* conditionFields(x, `${path}/${k}`);
}

function contentErrors(d: WorkflowDefinition, o: ValidateOptions): DefinitionError[] {
  const errors: DefinitionError[] = [];
  const ids = new Map<string, string>();
  const known = {
    actions: o.known?.actions ? new Set(o.known.actions) : null,
    events: o.known?.events ? new Set(o.known.events) : null,
    subjectTypes: o.known?.subjectTypes ? new Set(o.known.subjectTypes) : null,
  };
  const maxForeach = o.maxForeach ?? 1000;

  for (const [step, path] of allSteps(d)) {
    const first = ids.get(step.id);
    if (first) errors.push({ path: `${path}/id`, message: `Schritt-ID «${step.id}» kommt mehrfach vor (zuerst bei ${first})` });
    else ids.set(step.id, path);
    if ('action' in step && known.actions && !known.actions.has(step.action)) {
      errors.push({ path: `${path}/action`, message: `Unbekannte Aktion «${step.action}»` });
    }
    if ('action' in step) {
      const input = (step.input ?? {}) as Record<string, unknown>;
      for (const f of o.known?.inputs?.[step.action] ?? []) {
        const v = input[f.key];
        if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) errors.push({ path: `${path}/input/${f.key}`, message: `Pflichtfeld «${f.title}» ist leer` });
      }
    }
    if ('foreach' in step && step.foreach.limit !== undefined && step.foreach.limit > maxForeach) {
      errors.push({ path: `${path}/foreach/limit`, message: `Höchstens ${maxForeach} Einträge je «foreach»` });
    }
    if ('wait' in step && step.wait.event && known.events && !known.events.has(step.wait.event.type)) {
      errors.push({ path: `${path}/wait/event/type`, message: `Unbekannter Ereignistyp «${step.wait.event.type}»` });
    }
    if ('task' in step) {
      const keys = new Set<string>();
      for (const [i, f] of (step.task.form ?? []).entries()) {
        if (keys.has(f.key)) errors.push({ path: `${path}/task/form/${i}/key`, message: `Feld «${f.key}» kommt mehrfach vor` });
        keys.add(f.key);
        if (f.type === 'choice' && !f.options?.length) errors.push({ path: `${path}/task/form/${i}/options`, message: `Auswahl «${f.label}» braucht Werte («options»)` });
      }
      const outcomes = new Set<string>();
      for (const [i, out] of (step.task.outcomes ?? []).entries()) {
        if (outcomes.has(out)) errors.push({ path: `${path}/task/outcomes/${i}`, message: `Ergebnis «${out}» kommt mehrfach vor` });
        if (out === 'cancelled') errors.push({ path: `${path}/task/outcomes/${i}`, message: 'Ergebnis «cancelled» ist für abgebrochene Aufgaben reserviert' });
        outcomes.add(out);
      }
      const known = new Set(outcomesOf(step));
      for (const k of Object.keys(step.branches ?? {})) {
        if (!known.has(k)) errors.push({ path: `${path}/branches/${k}`, message: `Weg «${outcomeName(k)}» gehört zu keinem Ergebnis der Aufgabe` });
      }
    }
    if (('task' in step || 'approval' in step) && step.branches && d.schemaVersion < 2) {
      errors.push({ path: `${path}/branches`, message: 'Wege nach Ergebnis brauchen Fassung 2 der Definition («schemaVersion»: 2)' });
    }
  }

  if (d.kind !== 'state_model' && d.trigger) {
    if ('event' in d.trigger && known.events && !known.events.has(d.trigger.event)) {
      errors.push({ path: '/trigger/event', message: `Unbekannter Ereignistyp «${d.trigger.event}»` });
    }
    if ('transition' in d.trigger && known.subjectTypes && !known.subjectTypes.has(d.trigger.transition.subjectType)) {
      errors.push({ path: '/trigger/transition/subjectType', message: `Unbekannter Bezugstyp «${d.trigger.transition.subjectType}»` });
    }
  }

  if (d.kind === 'case' && d.phases) {
    const seen = new Set<string>();
    for (const [i, ph] of d.phases.entries()) {
      if (seen.has(ph.id)) errors.push({ path: `/phases/${i}/id`, message: `Phasen-ID «${ph.id}» kommt mehrfach vor` });
      seen.add(ph.id);
    }
  }

  if (d.kind === 'state_model') {
    if (known.subjectTypes && !known.subjectTypes.has(d.subjectType)) errors.push({ path: '/subjectType', message: `Unbekannter Bezugstyp «${d.subjectType}»` });
    const values = new Set<string>();
    for (const [i, s] of d.states.entries()) {
      if (values.has(s.value)) errors.push({ path: `/states/${i}/value`, message: `Zustand «${s.value}» kommt mehrfach vor` });
      values.add(s.value);
    }
    if (d.states.filter(s => s.initial).length > 1) errors.push({ path: '/states', message: 'Höchstens ein Anfangszustand («initial»)' });
    const tids = new Set<string>();
    for (const [i, t] of d.transitions.entries()) {
      if (tids.has(t.id)) errors.push({ path: `/transitions/${i}/id`, message: `Übergangs-ID «${t.id}» kommt mehrfach vor` });
      tids.add(t.id);
      if (!values.has(t.to)) errors.push({ path: `/transitions/${i}/to`, message: `Unbekannter Zustand «${t.to}»` });
      if (Array.isArray(t.from)) for (const [j, f] of t.from.entries()) {
        if (!values.has(f)) errors.push({ path: `/transitions/${i}/from/${j}`, message: `Unbekannter Zustand «${f}»` });
      }
    }
  }

  // Platzhalter und Verweise auf Schritte (`steps.<id>…`)
  const stepRef = (p: string, at: string) => {
    const m = /^steps\.([^.]+)/.exec(p);
    if (m && !ids.has(m[1]!)) errors.push({ path: at, message: `Verweis auf unbekannten Schritt «${m[1]}»` });
  };
  for (const [s, at] of strings(d, '')) {
    if (!s.includes('{{') && !s.includes('}}')) continue;
    try {
      for (const part of parseTemplate(s)) if (typeof part !== 'string') stepRef(part.path, at);
    } catch (e) {
      errors.push({ path: at, message: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const [field, at] of conditionFields(d, '')) if (isValidPath(field)) stepRef(field, at);
  return errors;
}

/** Liste, in der ein Schritt steht, und sein Index (`/steps/1/branches/ok/0` → `/steps/1/branches/ok`, 0). */
function place(path: string): { list: string; index: number } {
  const i = path.lastIndexOf('/');
  return { list: path.slice(0, i), index: Number(path.slice(i + 1)) };
}

/** Schritt, dem eine Liste gehört (`/steps/1/then` → `/steps/1`), oder `null` für die Listen der Definition. */
function ownerOf(list: string): string | null {
  const segs = list.split('/');
  if (segs.at(-2) === 'branches' || (segs.at(-1) === 'steps' && segs.at(-2) === 'onError')) return segs.length > 3 ? segs.slice(0, -2).join('/') : null;
  return segs.length > 2 ? segs.slice(0, -1).join('/') : null;
}

function listOf(d: WorkflowDefinition, list: string): Step[] {
  let cur: unknown = d;
  for (const seg of list.split('/').slice(1)) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined;
  return Array.isArray(cur) ? (cur as Step[]) : [];
}

/** Folgt nach dem Schritt `index` der Liste `list` noch ein Schritt, in dieser oder einer umgebenden Liste? */
function followedAfter(d: WorkflowDefinition, list: string, index: number): boolean {
  for (let l: string | null = list, i = index; l !== null;) {
    if (i + 1 < listOf(d, l).length) return true;
    const owner = ownerOf(l);
    if (owner === null) return false;
    ({ list: l, index: i } = place(owner));
  }
  return false;
}

/** Hinweise, die nicht hindern (nur Automationen): leere Wege, Schritte nach «Beenden», «Wenn» ohne Schritte. */
function contentHints(d: WorkflowDefinition): DefinitionError[] {
  if (d.kind !== 'automation') return [];
  const hints: DefinitionError[] = [];
  for (const [step, path] of walkSteps(d.steps, '/steps')) {
    const { list, index } = place(path);
    if ('end' in step && index + 1 < listOf(d, list).length) {
      hints.push({ path: `${list}/${index + 1}`, message: 'Wird nie ausgeführt: Der Schritt davor beendet den Lauf' });
    }
    if ('if' in step && !step.then.length && !step.else?.length) hints.push({ path: `${path}/then`, message: 'Auf keinem Weg geschieht etwas' });
    if ('task' in step || 'approval' in step) {
      const outcomes = outcomesOf(step);
      if (outcomes.length < 2 || followedAfter(d, list, index)) continue;
      const branches = (step.branches ?? {}) as Record<string, Step[] | undefined>;
      for (const o of outcomes) {
        if (!branches[o]?.length) hints.push({ path: `${path}/branches/${o}`, message: `Nach «${outcomeName(o)}» geschieht nichts` });
      }
    }
  }
  return hints;
}

/** Prüft eine Definition (Schema, dann Inhalt). Meldungen auf Deutsch mit Pfad; dazu Hinweise, die nicht hindern. */
export function validateDefinition(input: unknown, options: ValidateOptions = {}): DefinitionResult {
  const validate = schemaValidator();
  if (!validate(input)) return { ok: false, errors: schemaErrors(validate.errors ?? []), warnings: [] };
  const definition = input as WorkflowDefinition;
  const errors = contentErrors(definition, options);
  const warnings = contentHints(definition);
  return errors.length ? { ok: false, errors, warnings } : { ok: true, definition, errors: [], warnings };
}
