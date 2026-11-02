# @vollholz/workflow

App-agnostischer Workflow-Baukasten für Fastify-Apps auf PostgreSQL: Ports, Definition von Workflows (JSON-Schema mit
Prüfung), Ausdrücke ohne Skripte, Engine für Automationen, Migrationen mit RLS, Job-Handler und REST-Routen. Stand
**Stufe 1** (Automation): Auslöser Ereignis, Zeitplan und manuell; Schritte Aktion, Wenn/Sonst, Für jedes, Warten (Dauer,
Zeitpunkt), Variablen, Ende; Protokoll je Schritt, Vorfälle, Schleifenschutz, Grenzen, Probelauf, Opt-in je Mandant.
Aufgaben und Genehmigungen folgen in Stufe 2, Fälle in Stufe 3, Zustandsmodelle in Stufe 4.

## Einbindung

### 1. Migrationen

```ts
const migrations = wf.migrations({
  schema: 'app',                         // Schema der App; Tabellen workflow_*
  appRole: 'app_api',                    // Laufzeit-Rolle (RLS-Policies TO appRole)
  schedRole: 'app_worker',               // Worker-Rolle (nur Zeitpläne über alle Mandanten)
  tenantExpr: 'app.tenant_id()',         // SQL-Ausdruck für den Mandanten der Transaktion (uuid), Standard wie links
  principalExpr: 'app.principal_id()',   // SQL-Ausdruck für die angemeldete Person (Standard wie links)
});
for (const m of migrations) await db.query(m.sql);   // { name, sql, checksum } – idempotent
```

Danach in einer Migration der App die Bezugstypen melden (immer alle; Tabelle mit Spalten `tenant_id` und `id`):

```sql
SELECT app.workflow_subjects('{"order": "app.sales_order"}');
```

Tabellen: `workflow`, `workflow_version` (unveränderlich), `workflow_trigger`, `workflow_run`, `workflow_step` (nur
anhängen), `workflow_settings`, `workflow_usage`. Jede mit `tenant_id`, RLS `ENABLE` + `FORCE` und Mandantentrennung.
Läufe sieht die Laufzeit-Rolle nur, wenn die Zeile ihres Bezugs unter der Lesesicht der App sichtbar ist; unbekannte
Bezugstypen sind unsichtbar, Läufe ohne Bezug sichtbar (das Recht `workflow:read` prüft die API). Keine Fremdschlüssel
in Tabellen der App. Bei Änderungen an Auslösern sendet die Datenbank `NOTIFY workflow_triggers` (Nutzlast: Mandant).
Der Ausdruck für den Mandanten darf Anführungszeichen enthalten, aber kein `;`, keine Kommentare und kein `%`.

### 2. Ports und Optionen

```ts
import { workflow, workflowPermissions, type WorkflowHost } from '@vollholz/workflow';

const host: WorkflowHost = {
  tx: (req, fn) => …,                    // Transaktion im Mandantenkontext der Anfrage (Rolle appRole, RLS)
  actor: req => …,                       // { id, kind: 'person' | 'client' }; wirft 401 der App
  active: (tx, actor) => …,              // noch handlungsfähig? sonst pausiert der Workflow mit Vorfall
  can: (tx, actor, perm, on) => …,       // Rechte aus workflowPermissions und WorkflowAction.needs
  canActAs: (tx, actor, target) => …,    // optional: darf actor einen Workflow im Namen von target aktivieren?
  members, audit, emit, jobs: { enqueue }, notify /* optional */, http /* optional */,
  error: (status, code, detail) => new HttpError(status, code, detail),
};

const wf = workflow({
  schema: 'app', host,
  subjects: [orderSubject],              // WorkflowSubject: load, fields
  actions: [cancelOrder],                // WorkflowAction: input-Schema, needs, run, dryRun
  events: EVENT_SOURCES,                 // EventSource: Ereignistypen der App
  limits: { runsPerDay: 5_000 },         // Obergrenzen der App (Mandanten können nur senken)
  prefix: '/v1',                         // Standard
  enabled: process.env.WORKFLOWS_ENABLED === 'true',
  tenantScope: { type: 'tenant', id: '*' },   // Bereich für workflow:admin (Standard)
  triggerCacheMs: 10_000,                // Zwischenspeicher der Auslöser je Mandant (Standard)
  retryDelayMs: 30_000,                  // erste Wartezeit vor einer Wiederholung, verdoppelt (Standard)
});
await app.register(wf.plugin);
```

### 3. Ereignisse (`dispatch`)

Im Schreibpfad der App, in derselben Transaktion wie `emit`:

```ts
await wf.dispatch(tx, { type: 'order.updated', subject: { type: 'order', id }, data, actor }, { tenantId });
```

Ohne passende Auslöser kostet das einen Map-Zugriff (keine Abfrage, gemessen < 0,1 ms). Ohne `tenantId` liest das Paket
den Mandanten einmal je Transaktion. Ereignisse, die eine Aktion an `ActionContext.tx` auslöst, gelten als Ereignisse
aus dem Lauf: Sie lösen nur Auslöser mit `includeWorkflowEvents` aus und erhöhen die Kettentiefe (Grenze
`chainDepth`, Standard 5; darüber entsteht ein Lauf im Zustand `incident` ohne Job). Läuft die Kette über eine andere
Transaktion (Webhook, Abgleich), gibt die App `{ causedBy: { runId, depth } }` mit. Mehrere Prozesse: Aktivieren in
einem Prozess wirkt in den anderen spätestens nach `triggerCacheMs`, sofort mit `LISTEN workflow_triggers` →
`wf.invalidateTriggers(tenantId)`.

### 4. Jobs und Zeitpläne

```ts
for (const job of wf.jobs) queue.register(job.kind, job.handler);   // workflow.step, workflow.start
setInterval(() => worker.tx(tx => wf.tick(tx)), 60_000);           // fällige Zeitpläne (SKIP LOCKED)
```

Jede Nutzlast trägt `tenantId`; der Worker führt den Job in einer Transaktion mit diesem Mandantenkontext und der
Laufzeit-Rolle aus. Ein Job führt genau einen Schritt aus (Lauf sperren, Grenzen, Akteur, Rechte, Aktion im Savepoint,
Protokoll, nächster Job mit `dedupeKey`); veraltete oder doppelte Jobs erkennt die Folgenummer des Laufs. `tick` mit
der Worker-Rolle setzt `workflow.sched = on` und arbeitet über alle Mandanten, mit der Laufzeit-Rolle nur im eigenen.
Cron mit fünf Feldern und Zeitzone (`Intl`, Sommerzeit getestet). Ist das Modul in der Umgebung ausgeschaltet, werfen
die Jobs `503 module-disabled`, damit die Warteschlange sie später nochmals versucht.

### 5. Rechte

`workflowPermissions` ins Rechtemodell der App übernehmen. Aktionen prüfen bei jedem Schritt `needs` gegen die
aktuellen Rechte des Akteurs des Workflows (W6); fehlt ein Recht, entsteht ein Vorfall ohne Wiederholung.

## Routen (unter `prefix`, Standard `/v1`)

| Methode und Pfad | Recht | Zweck |
|---|---|---|
| `GET /workflows/status` | angemeldet | `{ configured, enabled, available, stage, version }` |
| `GET /workflows/meta` | `workflow:read` (am Bereich `scopeType`/`scopeId`, sonst `tenantScope`) | Für den Editor: `{ stage, events, actions, subjectTypes (mit fields), stateFields, fieldKinds, stepKinds, operators, unaryOperators, formatters, canActAs }` (Typ `WorkflowMeta`) |
| `GET`, `PUT /workflows/settings` | `workflow:admin` | Opt-in des Mandanten, Grenzen (nur senken), Zähler des Tages |
| `GET /workflows` · `POST /workflows` | `workflow:read` · `workflow:manage` | Liste (Filter `state`, `scopeType`, `scopeId`) · Entwurf anlegen |
| `GET`, `PUT`, `DELETE /workflows/:id` | `workflow:read` · `workflow:manage` | Entwurf lesen, ändern (`If-Match`), löschen (nur nie aktiv) |
| `POST /workflows/validate` | angemeldet | `{ ok, errors, stage }` |
| `POST /workflows/:id/activate` | `workflow:activate` | Version anlegen, Auslöser neu; `actor` wahlweise (W6, `canActAs`) |
| `POST /workflows/:id/pause`, `/archive` | `workflow:activate` | Auslöser entfernen |
| `GET /workflows/:id/versions`, `/versions/:version` | `workflow:read` | Versionen mit Prüfsumme und Definition |
| `POST /workflows/:id/runs` | `workflow:run` | manueller Start mit Bezug und Eingabe |
| `POST /workflows/:id/dry-run` | `workflow:manage` | Probelauf ohne zu schreiben (Entwurf, Definition oder Version) |
| `GET /workflow-runs` | `workflow:read` | Läufe (Filter `workflowId`, `subjectType`, `subjectId`, `state`; `cursor`, `limit`) |
| `GET /workflow-runs/:id` | `workflow:read` | Lauf mit Schrittprotokoll |
| `POST /workflow-runs/:id/retry`, `/skip`, `/cancel` | `workflow:operate` | Vorfall lösen |

Ausser Status, Meta und Einstellungen antworten alle Routen `404 module-disabled`, solange das Modul in der Umgebung oder
im Mandanten ausgeschaltet ist (Meta und Einstellungen nur, wenn es in der Umgebung ausgeschaltet ist). Fehler nur über `host.error` (deutsche Texte). Jede Änderung geht ins Audit; Aktivieren,
Pausieren, Archivieren und Läufe melden `workflow.*` über `host.emit`.

## Exporte

`workflow`, `workflowMigrations`, `validateDefinition`, `definitionSchema`, Ausdrücke (`evaluateCondition`,
`renderTemplate`, `resolveValue`, `resolvePath`, `parseTemplate`, `templateProblems`), Zeit (`parseCron`, `nextCronTime`,
`isValidTimeZone`, `parseDuration`, `addDuration`), Engine-Hilfen (`stageProblems`, `chainDecision`, `effectiveLimits`,
`redact`, `definitionChecksum`, `StepFailure`, `WORKFLOW_JOB_STEP`, `WORKFLOW_JOB_START`), `workflowPermissions`,
`WORKFLOW_EVENT_TYPES`, `DEFAULT_LIMITS` und die Typen der Ports.

Abhängigkeiten: `ajv`; `fastify` ^5 als Peer. Keine Abhängigkeit auf eine App, keine Datenbank-Bibliothek. Siehe README
des Repos.

Lizenz: Apache-2.0.
