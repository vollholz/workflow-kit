/**
 * Ports zwischen Baukasten und App (Konzept Abschnitte 6a und 8.2).
 *
 * Der Baukasten ruft die App nur über diese Schnittstellen auf; die App ruft den Baukasten nur über `workflow()`,
 * `dispatch`, `checkTransition`, die Jobs und die Migrationen. Alle Typen gehören dem Paket: keine Typen aus einer App
 * oder aus einem App-Paket. Die Begriffe sind neutral – was sie in einer App bedeuten, legt die App fest:
 *
 * - **Akteur** (`ActorRef`): wer handelt, Person oder Maschinen-Client; die ID ist für das Paket undurchsichtig.
 * - **Bereich** (`ScopeRef`): wo ein Workflow gilt; nur zum Filtern und für `can`.
 * - **Bezug** (`SubjectRef`, Port `WorkflowSubject`): woran ein Lauf, Fall oder eine Aufgabe hängt.
 * - **Ereignis** (`WorkflowEvent`, `EventSource`): Auslöser; Typen und Filterfelder meldet die App.
 * - **Aktion** (`WorkflowAction`): fachlicher Schritt mit Ein- und Ausgabe-Schema.
 * - **Zustandsfeld** (`StateField`): Feld eines Bezugstyps mit endlicher Werteliste, Grundlage des Zustandsmodells.
 * - **Team** (`TeamRef`, `host.members`): wer zu einer Warteschlange oder Genehmigung gehört.
 * - **Feldart** (`FieldKind`): zusätzliche Feldarten für Aufgabenformulare.
 *
 * Regel: nur Typen, keine Laufzeit-Logik in dieser Datei.
 */

/** JSON-Schema (Draft 2020-12 oder 7) als einfache Struktur; das Paket prüft es mit ajv. */
export type JsonSchema = { [key: string]: unknown };

/** Datenbank-Zugriff der App in einer Transaktion im Mandantenkontext (die App setzt den Kontext für RLS). */
export interface Tx {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** Akteur: Person oder Maschinen-Client. Die ID ist undurchsichtig; auflösen kann sie nur die App. */
export interface ActorRef {
  id: string;
  kind: 'person' | 'client';
}

/** Bereich, in dem ein Workflow gilt (z. B. Mandant oder ein Teil davon); Typen legt die App fest. */
export interface ScopeRef {
  type: string;
  id: string;
}

/** Bezug eines Laufs, Falls oder einer Aufgabe; `type` ist ein registrierter `WorkflowSubject.type`. */
export interface SubjectRef {
  type: string;
  id: string;
}

/** Team einer Warteschlange oder Genehmigung; was ein Team ist, entscheidet die App (`host.members`). */
export interface TeamRef {
  type: string;
  id: string;
}

/** Team mit Bezeichnung (Auswahl in der Oberfläche, Port `teams`). */
export interface TeamOption extends TeamRef {
  label: string;
  /** Überschrift der Gruppe in der Auswahl (z. B. «Rollen»); ohne Angabe «Teams». */
  group?: string;
}

/** Eintrag im Audit der App. */
export interface AuditEntry {
  /** z. B. `workflow.activated`, `task.completed`. */
  action: string;
  /** Wer gehandelt hat; null für den Baukasten selbst (z. B. Fristablauf). */
  actor: ActorRef | null;
  /** In wessen Namen ein Lauf gehandelt hat (Akteur des Workflows). */
  onBehalfOf?: ActorRef | null;
  subject?: SubjectRef | null;
  workflowId?: string | null;
  runId?: string | null;
  data?: Record<string, unknown>;
}

/** Arten von Benachrichtigungen, die der Baukasten verschickt. */
export type NoticeKind = 'task_assigned' | 'approval_requested' | 'sla_breached' | 'run_failed';

/** Benachrichtigung an einen Akteur (Port `notify`). */
export interface Notice {
  kind: NoticeKind;
  recipient: ActorRef;
  title: string;
  subject?: SubjectRef | null;
  /** Pfad in der Oberfläche der App, falls bekannt. */
  link?: string | null;
  data?: Record<string, unknown>;
}

/** Ausgehender HTTP-Aufruf; Zugangsdaten und erlaubte Ziele verwaltet die App. */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Undurchsichtiger Verweis auf einen Zugang der App; die App setzt Geheimnisse selbst ein. */
  authRef?: string | null;
  /** Idempotenzschlüssel `run_id:path:attempt`. */
  idempotencyKey: string;
  timeoutMs?: number;
  /** Obergrenze der Antwortgrösse in Bytes. */
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Ausgehende Aufrufe (optional): ohne Port bietet der Baukasten die Aktion «HTTP-Aufruf» nicht an. */
export interface HttpPort {
  request(tx: Tx, req: HttpRequest, actor: ActorRef): Promise<HttpResponse>;
}

/** Job-Warteschlange der App: trägt Schritte und Wartezeiten. */
export interface JobsPort {
  enqueue(tx: Tx, kind: string, payload: unknown, o?: { runAt?: Date; dedupeKey?: string }): Promise<void>;
}

/** Was die App dem Baukasten bereitstellt. */
export interface WorkflowHost {
  /**
   * Transaktion im Mandantenkontext der Anfrage (die App setzt Rolle und Kontext für RLS); alle Routen des Baukastens
   * lesen und schreiben nur darin. Wirft den Fehler der App, wenn niemand angemeldet ist.
   */
  tx<T>(req: unknown, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Wer die Anfrage stellt (aus dem Request der App); wirft den Fehler der App, wenn niemand angemeldet ist. */
  actor(req: unknown): ActorRef;
  /** Ist der Akteur noch handlungsfähig? false = nicht mehr Mitglied oder gesperrt → Workflow pausieren. */
  active(tx: Tx, actor: ActorRef): Promise<boolean>;
  /** Recht des Akteurs prüfen; Rechtenamen aus `workflowPermissions` oder `WorkflowAction.needs`. */
  can(tx: Tx, actor: ActorRef, perm: string, on: ScopeRef | SubjectRef): Promise<boolean>;
  /**
   * Darf `actor` einen Workflow im Namen von `target` aktivieren (W6, z. B. einen Maschinen-Client, den die Person
   * verwalten darf)? Ohne diese Methode kann nur die aktivierende Person selbst Akteur werden.
   */
  canActAs?(tx: Tx, actor: ActorRef, target: ActorRef): Promise<boolean>;
  /** Mitglieder eines Teams (Warteschlange, Genehmigung); was ein Team ist, entscheidet die App. */
  members(tx: Tx, team: TeamRef): Promise<ActorRef[]>;
  /**
   * Teams zur Auswahl (optional, z. B. im Editor einer Warteschlange): Suche nach Text, höchstens `limit` Treffer mit
   * Bezeichnung. Ohne diese Methode gibt man Typ und ID eines Teams von Hand ein.
   */
  teams?(tx: Tx, query: { search: string; limit: number }): Promise<TeamOption[]>;
  audit(tx: Tx, entry: AuditEntry): Promise<void>;
  /** Ereignis in die Outbox der App schreiben (gleiche Transaktion). */
  emit(tx: Tx, type: string, subject: string | null, data: Record<string, unknown>): Promise<void>;
  jobs: JobsPort;
  notify?(tx: Tx, notice: Notice): Promise<void>;
  http?: HttpPort;
  /** Fehler der App (z. B. deren HTTP-Fehlerklasse) – das Paket wirft nur über diese Fabrik. */
  error(status: number, code: string, detail?: string): Error;
}

/** Feldarten des Pakets für Aufgabenformulare (W11); weitere liefert die App über `FieldKind`. */
export type BuiltinFieldType = 'text' | 'number' | 'date' | 'choice' | 'actor' | 'boolean' | 'file';

/** Feld für Bedingungen, Platzhalter und Formulare – immer mit Bezeichnung, nie nur mit ID. */
export interface FieldDef {
  key: string;
  label: string;
  /** Feldart des Pakets oder `FieldKind.key` der App. */
  type: BuiltinFieldType | (string & {});
  required?: boolean;
  multiple?: boolean;
  /** Auswahlwerte bei `choice`. */
  options?: { value: string; label: string }[];
  description?: string;
}

/** Feldart, die eine App für Aufgabenformulare beisteuert (Port `fields`). */
export interface FieldKind {
  key: string;
  label: string;
  /** Schema eines Werts dieser Feldart. */
  valueSchema: JsonSchema;
}

/** Stand eines Bezugs, wie ihn die App liefert. */
export interface SubjectSnapshot {
  id: string;
  title: string;
  scope: ScopeRef;
  /** Vertraulich: Aufgaben zeigen dann nur einen neutralen Hinweis statt des Titels. */
  confidential: boolean;
  /** Werte für Bedingungen und Platzhalter, Schlüssel wie in `fields`. */
  values: Record<string, unknown>;
}

/** Bezugstyp: laden (null = für diesen Kontext unsichtbar), Bezeichnung, Felder für Bedingungen und Platzhalter. */
export interface WorkflowSubject {
  type: string;
  label: string;
  load(tx: Tx, id: string): Promise<SubjectSnapshot | null>;
  fields(tx: Tx, scope: ScopeRef): Promise<FieldDef[]>;
}

/** Feld eines Bezugstyps mit endlicher Werteliste – Grundlage des Zustandsmodells. */
export interface StateField {
  subjectType: string;
  key: string;
  label: string;
  /** Erlaubte Werte im Bereich. */
  values(tx: Tx, scope: ScopeRef): Promise<{ id: string; label: string; category?: string }[]>;
}

/** Ereignistyp, den eine App als Auslöser anbietet. */
export interface EventSource {
  type: string;
  label: string;
  description?: string;
  /** Bezugstyp der Ereignisse dieses Typs, falls immer derselbe. */
  subjectType?: string;
  /** Felder in `data`, nach denen ein Auslöser filtern kann. */
  filterFields?: FieldDef[];
}

/** Ereignis der App, wie es `dispatch` erhält. */
export interface WorkflowEvent {
  type: string;
  subject: SubjectRef | null;
  data: Record<string, unknown>;
  /** Wer das Ereignis ausgelöst hat. */
  actor?: ActorRef | null;
  /** Kette über Läufe, Webhooks und Abgleiche hinweg (Schleifenschutz). */
  correlationId?: string | null;
  /** Lauf, der das Ereignis erzeugt hat (Ereignisse aus Workflows lösen standardmässig nichts aus). */
  causedByRunId?: string | null;
}

/** Kontext einer Aktion bei Ausführung oder Probelauf. */
export interface ActionContext {
  tx: Tx;
  host: WorkflowHost;
  /** In wessen Namen der Lauf handelt (W6) bzw. wer die Aufgabe erledigt (W7). */
  actor: ActorRef;
  run: { id: string; workflowId: string; version: number };
  subject: SubjectRef | null;
  /** Variablen und Ergebnisse vorheriger Schritte. */
  vars: Record<string, unknown>;
  /** `run_id:path:attempt` – für Aufrufe nach aussen. */
  idempotencyKey: string;
  dryRun: boolean;
  /** Zeile ins Schrittprotokoll schreiben (gekürzt, höchstens 50 je Schritt). */
  log(message: string): void;
}

/** Fachliche Aktion, die eine App anmeldet. */
export interface WorkflowAction<I = unknown, O = unknown> {
  /** Eindeutiger Schlüssel, z. B. `order.cancel`. */
  key: string;
  /** Für die Auswahl im Editor. */
  label: string;
  group: string;
  input: JsonSchema;
  output?: JsonSchema;
  /** Rechte, die der Akteur für diese Aktion braucht (geprüft bei jedem Schritt). */
  needs?(input: I): { perm: string; resource: { type: string; id?: string } }[];
  run(ctx: ActionContext, input: I): Promise<O>;
  /** Probelauf: beschreiben statt ausführen. */
  dryRun?(ctx: ActionContext, input: I): Promise<{ summary: string; output?: O }>;
}

/** Grenzen je Mandant (Konzept 4.9). */
export interface WorkflowLimits {
  activeWorkflows: number;
  runsPerDay: number;
  stepsPerRun: number;
  foreachItems: number;
  httpCallsPerDay: number;
  chainDepth: number;
  runsPerSubjectPerMinute: number;
}

/** Herkunft eines Ereignisses aus einem Lauf (Schleifenschutz): Lauf und dessen Kettentiefe. */
export interface Causation {
  runId: string;
  /** Kettentiefe des auslösenden Laufs (1 = von einem Ereignis ausserhalb eines Workflows gestartet). */
  depth: number;
}

export interface DispatchOptions {
  /**
   * Mandant der Transaktion. Mit Angabe kostet `dispatch` ohne passende Auslöser keine Abfrage; ohne Angabe liest das
   * Paket den Mandanten einmal je Transaktion aus der Datenbank (`<schema>.workflow_tenant()`).
   */
  tenantId?: string;
  /**
   * Ereignis stammt aus einem Lauf. Nur nötig, wenn die Kette über eine andere Transaktion läuft (Webhook, Abgleich);
   * Ereignisse, die eine Aktion in ihrer Transaktion (`ActionContext.tx`) auslöst, erkennt das Paket selbst.
   */
  causedBy?: Causation;
}

/** Ereignis an die Engine weiterreichen; die App ruft das in derselben Transaktion wie `emit` auf (W3). */
export type Dispatch = (tx: Tx, event: WorkflowEvent, o?: DispatchOptions) => Promise<void>;

/** Ergebnis einer Prüfung eines Zustandswechsels. */
export type TransitionCheck =
  | { allowed: true }
  | { allowed: false; code: string; reason: string; requiredFields?: string[] };

/** Zustandswechsel prüfen; die App ruft das vor dem Schreiben eines Zustandsfelds auf (W8). */
export type CheckTransition = (
  tx: Tx, actor: ActorRef, subject: SubjectRef, field: string, from: string | null, to: string,
  values?: Record<string, unknown>,
) => Promise<TransitionCheck>;

/**
 * Kontext eines Jobs des Baukastens. Die App führt jeden Job in einer Transaktion mit dem Mandantenkontext von
 * `payload.tenantId` aus (Laufzeit-Rolle, wie eine Anfrage ohne angemeldete Person).
 */
export interface JobCtx {
  tx: Tx;
  payload: unknown;
  attempt: number;
}

/** Nutzlast der Jobs des Baukastens; `tenantId` trägt jeder Job. */
export type WorkflowJobPayload =
  | { tenantId: string; runId: string; seq: number }
  | { tenantId: string; triggerId: string; at: string }
  | { tenantId: string; timerId: string };

export interface WorkflowJob {
  kind: string;
  handler(ctx: JobCtx): Promise<void>;
}

/** Migration als SQL mit Prüfsumme (wie bei den übrigen Bausteinen). */
export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationOptions {
  /** Datenbank-Schema der App, in dem die Tabellen `workflow_*` liegen. */
  schema: string;
  /** Laufzeit-Rolle der App. */
  appRole: string;
  /** Rolle des Workers. */
  schedRole: string;
  /** SQL-Ausdruck für den Mandanten der Anfrage (Standard `app.tenant_id()`); Typ `uuid`. */
  tenantExpr?: string;
  /** SQL-Ausdruck für die angemeldete Person (Standard `app.principal_id()`). */
  principalExpr?: string;
}
