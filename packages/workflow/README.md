# @vollholz/workflow

App-agnostischer Workflow-Baukasten für Fastify-Apps auf PostgreSQL: Ports, Definition von Workflows (JSON-Schema mit
Prüfung), Ausdrücke ohne Skripte, Engine für Automationen, Aufgaben und Warteschlangen, Migrationen mit RLS, Job-Handler
und REST-Routen. Stand **Stufe 2**:

- Automation (Stufe 1): Auslöser Ereignis, Zeitplan und manuell; Schritte Aktion, Wenn/Sonst, Für jedes, Warten (Dauer,
  Zeitpunkt), Variablen, Ende; Protokoll je Schritt, Vorfälle, Schleifenschutz, Grenzen, Probelauf, Opt-in je Mandant.
- Aufgaben und Warteschlangen (Stufe 2): Schritte `task` (Formular, Ergebnisse) und `approval` (erste Antwort, alle,
  Mehrheit, nacheinander; Begründung bei Ablehnung), Zuständige aus Akteur, Team (`host.members`), Feld des Bezugs oder
  Warteschlange (Nehmen, Round Robin, geringste offene Last), Nehmen/Zurücklegen/Weitergeben, Massenaktionen, Fristen in
  Arbeitszeit nach Kalender mit Feiertagen, Verzug mit Eskalation (benachrichtigen, Priorität, umleiten).

Fälle folgen in Stufe 3, Zustandsmodelle in Stufe 4.

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

Tabellen aus `workflow_001_core`: `workflow`, `workflow_version` (unveränderlich), `workflow_trigger`, `workflow_run`,
`workflow_step` (nur anhängen), `workflow_settings`, `workflow_usage`; aus `workflow_002_tasks`: `workflow_task`,
`workflow_task_vote` (nur anhängen), `workflow_queue`, `workflow_calendar`, `workflow_sla_timer`. Jede mit `tenant_id`,
RLS `ENABLE` + `FORCE` und Mandantentrennung.
Läufe sieht die Laufzeit-Rolle nur, wenn die Zeile ihres Bezugs unter der Lesesicht der App sichtbar ist; unbekannte
Bezugstypen sind unsichtbar, Läufe ohne Bezug sichtbar (das Recht `workflow:read` prüft die API). Keine Fremdschlüssel
in Tabellen der App. Bei Änderungen an Auslösern sendet die Datenbank `NOTIFY workflow_triggers` (Nutzlast: Mandant).
Der Ausdruck für den Mandanten darf Anführungszeichen enthalten, aber kein `;`, keine Kommentare und kein `%`.

**Lesesicht der Aufgaben** (Entscheid Stufe 2): Die Datenbank zeigt eine Aufgabe, wenn die Person zuständig ist
(`assignee_id = principalExpr`), zu den Kandidaten gehört (Genehmigende, Team ohne Warteschlange) oder der Lauf sichtbar
ist (also der Bezug, über `workflow_subjects` aus 001 – kein neuer Aufruf nötig). Wer zu einer Warteschlange gehört,
weiss nur die App (`host.members`); das prüfen die Routen, so wie sie bei Läufen `workflow:read` prüfen. Wer eine
Aufgabe sieht, den Bezug aber nicht, erhält statt Titel und Beschreibung «Aufgabe zu einem vertraulichen Bezug». Stimmen
und Fristen hängen an der Aufgabe. Der Worker liest fällige Fristen über alle Mandanten (nur mit `workflow.sched = on`).

### 2. Ports und Optionen

```ts
import { workflow, workflowPermissions, type WorkflowHost } from '@vollholz/workflow';

const host: WorkflowHost = {
  tx: (req, fn) => …,                    // Transaktion im Mandantenkontext der Anfrage (Rolle appRole, RLS)
  actor: req => …,                       // { id, kind: 'person' | 'client' }; wirft 401 der App
  active: (tx, actor) => …,              // noch handlungsfähig? sonst pausiert der Workflow mit Vorfall
  can: (tx, actor, perm, on) => …,       // Rechte aus workflowPermissions und WorkflowAction.needs
  canActAs: (tx, actor, target) => …,    // optional: darf actor einen Workflow im Namen von target aktivieren?
  members: (tx, team) => …,              // Personen eines Teams (Warteschlange, Genehmigung, Eskalation)
  teams: (tx, { search, limit }) => …,   // optional: Teams mit Bezeichnung für die Auswahl in der Oberfläche
  audit, emit, jobs: { enqueue }, notify /* optional: task_assigned, approval_requested, sla_breached, run_failed */,
  http /* optional */,
  error: (status, code, detail) => new HttpError(status, code, detail),
};

const wf = workflow({
  schema: 'app', host,
  subjects: [orderSubject],              // WorkflowSubject: load, fields
  actions: [cancelOrder],                // WorkflowAction: input-Schema, needs, run, dryRun
  events: EVENT_SOURCES,                 // EventSource: Ereignistypen der App
  fields: [branchField],                 // FieldKind: Feldarten der App für Aufgabenformulare (Wert mit ajv geprüft)
  limits: { runsPerDay: 5_000 },         // Obergrenzen der App (Mandanten können nur senken)
  prefix: '/v1',                         // Standard
  enabled: process.env.WORKFLOWS_ENABLED === 'true',
  tenantScope: { type: 'tenant', id: '*' },   // Bereich für workflow:admin (Standard)
  triggerCacheMs: 10_000,                // Zwischenspeicher der Auslöser je Mandant (Standard)
  retryDelayMs: 30_000,                  // erste Wartezeit vor einer Wiederholung, verdoppelt (Standard)
  requireDryRun: true,                   // Aktivieren nur nach erfolgreichem Probelauf mit dem Entwurf (Standard false)
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
for (const job of wf.jobs) queue.register(job.kind, job.handler);   // workflow.step, workflow.start, workflow.sla
setInterval(() => worker.tx(tx => wf.tick(tx)), 60_000);           // fällige Zeitpläne und Fristen (SKIP LOCKED)
```

Jede Nutzlast trägt `tenantId`; der Worker führt den Job in einer Transaktion mit diesem Mandantenkontext und der
Laufzeit-Rolle aus. Ein Job führt genau einen Schritt aus (Lauf sperren, Grenzen, Akteur, Rechte, Aktion im Savepoint,
Protokoll, nächster Job mit `dedupeKey`); veraltete oder doppelte Jobs erkennt die Folgenummer des Laufs. `tick` mit
der Worker-Rolle setzt `workflow.sched = on` und arbeitet über alle Mandanten, mit der Laufzeit-Rolle nur im eigenen.
Cron mit fünf Feldern und Zeitzone (`Intl`, Sommerzeit getestet). Ist das Modul in der Umgebung ausgeschaltet, werfen
die Jobs `503 module-disabled`, damit die Warteschlange sie später nochmals versucht. `tick` markiert ausserdem fällige
Fristen (`breached_at`) und reiht je Frist einmal `workflow.sla` ein (Ereignis `task.sla_breached`, Benachrichtigung
`sla_breached` an Zuständige bzw. Mitglieder, Eskalation). Die App gibt je Transaktion ein eigenes `Tx`-Objekt (das
Paket merkt sich den Mandanten je `Tx`).

### 5. Aufgaben und Genehmigungen in Definitionen

```json
{ "id": "check", "task": {
    "title": "{{subject.title}} prüfen", "assignee": { "queue": "<id der Warteschlange>" }, "due": "P2BD", "priority": "high",
    "form": [{ "key": "note", "label": "Notiz", "type": "text", "required": true }], "outcomes": ["ok", "problem"],
    "escalation": { "raisePriority": true, "queue": "<andere Warteschlange>", "notify": [{ "team": { "type": "role", "id": "lead" } }] } } },
{ "id": "ok", "approval": { "title": "Freigabe", "approvers": [{ "field": "subject.values.owner" }, { "team": { "type": "role", "id": "lead" } }],
    "mode": "majority", "due": "PT8BH" } }
```

Zuständig (`Assignee`): `{ actor }`, `{ team }` (eine Person → zuständig, mehrere → Kandidaten, die nehmen),
`{ field }` (Pfad liefert Person-ID, `{ id, kind }` oder eine Liste) oder `{ queue }` (Regel der Warteschlange). Der
Lauf wartet (`waiting`), bis die Aufgabe erledigt ist; danach stehen `steps.<id>.outcome`, `.values`,
`.completedBy`, `.completedAt`, bei Genehmigungen `.votes` und `.reason` bereit. Eine abgebrochene Aufgabe liefert
`outcome: 'cancelled'`; bricht der Lauf ab, werden seine offenen Aufgaben abgebrochen. Erledigen und Entscheiden handeln
als die Person (W7, Audit mit ihr), die Folgeschritte wieder als Akteur des Workflows. Fristen: Dauer mit `BD`
(Arbeitstage) oder `BH` (Arbeitsstunden) nach dem Kalender der Warteschlange, sonst dem Standardkalender des
Mandanten, sonst `DEFAULT_WORK_CALENDAR` (Mo–Fr 08–17 UTC); ohne eigene Frist gilt `slaTarget` der Warteschlange.

### 6. Rechte

`workflowPermissions` ins Rechtemodell der App übernehmen. Aktionen prüfen bei jedem Schritt `needs` gegen die
aktuellen Rechte des Akteurs des Workflows (W6); fehlt ein Recht, entsteht ein Vorfall ohne Wiederholung. Aufgaben:
`task:work` am Bezug der Aufgabe (ohne Bezug am `tenantScope`) zum Nehmen, Zurücklegen, Erledigen, Entscheiden und zum
Weitergeben der eigenen Aufgabe an Mitglieder derselben Warteschlange; `task:assign` für Weitergeben an andere, Umleiten,
Abbrechen, Massenaktionen und die Ansicht «alle»; `queue:manage` (am `tenantScope`) für Warteschlangen und Kalender.

## Routen (unter `prefix`, Standard `/v1`)

| Methode und Pfad | Recht | Zweck |
|---|---|---|
| `GET /workflows/status` | angemeldet | `{ configured, enabled, available, stage, version }` |
| `GET /workflows/meta` | `workflow:read` (am Bereich `scopeType`/`scopeId`, sonst `tenantScope`) | Für den Editor: `{ stage, events, actions, subjectTypes (mit fields), stateFields, fieldKinds, stepKinds, operators, unaryOperators, formatters, canActAs, teams }` (Typ `WorkflowMeta`) |
| `GET`, `PUT /workflows/settings` | `workflow:admin` | Opt-in des Mandanten, Grenzen (nur senken), Zähler des Tages |
| `GET /workflows` · `POST /workflows` | `workflow:read` · `workflow:manage` | Liste (Filter `state`, `scopeType`, `scopeId`; je Eintrag `trigger` und `stepCount` dessen, was läuft, `draftChanged`, `openIncidents`) · Entwurf anlegen (mit `definition`, z. B. aus einer Vorlage) |
| `GET`, `PUT`, `DELETE /workflows/:id` | `workflow:read` · `workflow:manage` | Entwurf lesen, ändern (`If-Match`), löschen (nur nie aktiv) |
| `POST /workflows/validate` | angemeldet | `{ ok, errors, stage, warnings }`; `warnings` hindern nicht (leerer Weg, Schritte nach «Beenden») |
| `POST /workflows/:id/activate` | `workflow:activate` | Version anlegen, Auslöser neu; `actor` wahlweise (W6, `canActAs`) |
| `POST /workflows/:id/pause`, `/archive` | `workflow:activate` | Auslöser entfernen |
| `POST /workflows/schedule-preview` | Opt-in | nächste Ausführungen von Cron und Zeitzone (`ok`, `error`, `next`) |
| `POST /workflows/:id/resume` | `workflow:activate` | pausiert → aktiv mit derselben Version und demselben Akteur; Auslöser neu; meldet `workflow.activated` mit `resumed: true` |
| `GET /workflows/:id/versions`, `/versions/:version` | `workflow:read` | Versionen mit Prüfsumme und Definition |
| `POST /workflows/:id/runs` | `workflow:run` | manueller Start mit Bezug und Eingabe |
| `POST /workflows/:id/dry-run` | `workflow:manage` | Probelauf ohne zu schreiben (Entwurf, Definition oder Version); `assume` (Schritt-ID → Ergebnis) wählt den Weg von Aufgabe und Genehmigung |
| `GET /workflow-runs` | `workflow:read` | Läufe (Filter `workflowId`, `subjectType`, `subjectId`, `state`; `cursor`, `limit`) |
| `GET /workflow-runs/:id` | `workflow:read` | Lauf mit Schrittprotokoll |
| `POST /workflow-runs/:id/retry`, `/skip`, `/cancel` | `workflow:operate` | Vorfall lösen |
| `GET /tasks` | beteiligt; «alle» ohne Beteiligung `task:assign` | Ansicht `view=mine\|team\|all`, Filter `state` (`active` Standard, `open`, `in_progress`, `done`, `cancelled`, `any`), `queueId`, `kind`, `subjectType`, `subjectId`, `overdue`; `sort=urgency\|due\|age` (Standard: der Warteschlange bzw. Dringlichkeit); `limit`, `offset`; Antwort `{ items, total }`, je Aufgabe `actions` |
| `GET /tasks/counts` | angemeldet | `{ mine: { open, overdue }, team: { open, overdue, unassigned } }` für die Navigation |
| `GET /tasks/:id` | beteiligt oder `task:assign` | Aufgabe mit Formular, Stimmen, Frist (`sla`), `actions`; `ETag` |
| `POST /tasks/:id/take`, `/release` | `task:work` | Nehmen, Zurücklegen (in Warteschlange bzw. an das Team) |
| `POST /tasks/:id/assign` | `task:assign` (eigene Aufgabe an Mitglieder derselben Warteschlange: `task:work`) | `{ assignee?, queueId? }`; nur Warteschlange → deren Regel |
| `POST /tasks/:id/complete` | `task:work`, zuständig oder frei | `{ outcome?, values }`; Formular serverseitig geprüft (422 mit Meldung) |
| `POST /tasks/:id/decide` | `task:work`, unter den Genehmigenden | `{ decision: 'approved'\|'rejected', reason? }`; Begründung Pflicht bei Ablehnung (ausser `reasonOnReject: false`) |
| `POST /tasks/:id/cancel` | `task:assign` | `{ reason? }`; Lauf geht mit `outcome: 'cancelled'` weiter |
| `POST /tasks/bulk` | `task:assign` | `{ action: 'assign'\|'cancel', ids (≤ 100), assignee?, queueId?, reason? }` → `{ results, ok, failed }` |
| `GET /queues`, `GET /queues/:id` | Mitglied, `task:assign` oder `queue:manage` | Warteschlangen mit `member` und `counts` |
| `GET /queues/:id/members` | wie oben | Mitglieder (`host.members`) mit offener Last – für «Weitergeben» |
| `GET /queues/teams?q=&scopeType=&scopeId=` | `queue:manage` oder `workflow:manage` am Bereich | Teams zur Auswahl (`host.teams`; ohne Port `{ available: false }`) |
| `POST /queues`, `PUT`, `DELETE /queues/:id` | `queue:manage` | Name, Team, Sortierung, Regel (`pull`, `round_robin`, `least_load`), Kalender, `slaTarget`, `escalation`; Ändern und Löschen mit `If-Match`; Löschen nur ohne offene Aufgaben |
| `GET`, `POST /calendars`, `GET`, `PUT`, `DELETE /calendars/:id` | `queue:manage` | Zeitzone, Arbeitszeiten je Wochentag, Feiertage, `isDefault`; `If-Match`; Löschen nur, wenn keine Warteschlange ihn nutzt |
| `POST /calendars/preview` | `queue:manage` | `{ duration, from?, calendarId? \| calendar? }` → `{ dueAt }` |

Ausser Status, Meta und Einstellungen antworten alle Routen `404 module-disabled`, solange das Modul in der Umgebung oder
im Mandanten ausgeschaltet ist (Meta und Einstellungen nur, wenn es in der Umgebung ausgeschaltet ist). Fehler nur über `host.error` (deutsche Texte). Jede Änderung geht ins Audit; Aktivieren,
Pausieren, Archivieren und Läufe melden `workflow.*` über `host.emit`, Aufgaben `task.created`, `task.assigned`,
`task.decided`, `task.completed`, `task.cancelled`, `task.sla_breached` (mit Herkunft des Laufs, also nur mit
`includeWorkflowEvents` als Auslöser). Audit-Aktionen: `task.created`, `task.assigned`, `task.taken`, `task.released`,
`task.decided`, `task.completed`, `task.cancelled`, `task.sla_breached`, `queue.*`, `calendar.*`.

## Exporte

`workflow`, `workflowMigrations`, `validateDefinition`, `definitionSchema`, Ausdrücke (`evaluateCondition`,
`renderTemplate`, `resolveValue`, `resolvePath`, `parseTemplate`, `templateProblems`), Zeit (`parseCron`, `nextCronTime`,
`isValidTimeZone`, `parseDuration`, `addDuration`, `isBusinessDuration`), Kalender (`addWorkingTime`, `isWorkingTime`,
`calendarProblems`, `DEFAULT_WORK_CALENDAR`, `WEEKDAY_KEYS`), Engine-Hilfen (`stageProblems`, `chainDecision`,
`effectiveLimits`, `redact`, `definitionChecksum`, `StepFailure`, `WORKFLOW_JOB_STEP`, `WORKFLOW_JOB_START`,
`WORKFLOW_JOB_SLA`), Aufgaben (`approvalOutcome`, `nextRoundRobin`, `leastLoaded`, `rotateAfter`, `raisePriority`,
`actorFrom`, `FormChecker`, `PRIORITIES`, `ACTIVE_STATES`, `HIDDEN_TITLE`), `workflowPermissions`, `WORKFLOW_EVENT_TYPES`,
`DEFAULT_LIMITS` und die Typen der Ports (neu `TeamOption`, `WorkflowHost.teams`).

Abhängigkeiten: `ajv`; `fastify` ^5 als Peer. Keine Abhängigkeit auf eine App, keine Datenbank-Bibliothek. Siehe README
des Repos.

Lizenz: Apache-2.0.
