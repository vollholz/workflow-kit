# Changelog `@vollholz/workflow`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major. Vor 1.0.0 kann jede Minor-Version
Breaking Changes enthalten.

Jede Version beginnt mit **Für Nutzer** (allgemein verständlich, ohne Namen aus dem Code; übernimmt die App unverändert
in ihre Release Notes) und **Für den Betrieb** (Migrationen, Einstellungen, Wartungsläufe), sonst je «(keine)». Danach
folgen die Angaben für die Entwickler der App.

## [Unveröffentlicht]

## [0.8.0] – 2026-11-05

### Für Nutzer

- Wenn die App es verlangt, lässt sich ein Workflow erst aktivieren, nachdem ein Probelauf mit genau diesem Entwurf
  erfolgreich war; sonst meldet das Aktivieren «Vor dem Aktivieren braucht es einen erfolgreichen Probelauf mit genau
  diesem Entwurf.» Entspricht der Entwurf der aktiven bzw. zuletzt aktiven Fassung, braucht es keinen.

### Für den Betrieb

- Migration `workflow_003_dry_run` (vier Spalten an `workflow`, idempotent). Sie läuft mit den übrigen Migrationen des
  Baukastens.

### Hinzugefügt

- Option `requireDryRun` (Standard `false`): Ein erfolgreicher Probelauf eines Entwurfs merkt sich dessen Prüfsumme
  (`dry_run_checksum`, `dry_run_at`, `dry_run_by_*`, ohne Revision und `updated_at` zu ändern); `POST …/activate`
  antwortet sonst 409 `dry-run-required`. Ein Probelauf einer Version (`version`) gibt den Entwurf nicht frei.

## [0.7.0] – 2026-11-05

### Für Nutzer

- Die Liste der Workflows sagt je Workflow, wann er startet und wie viele Schritte er hat, ob der Entwurf von der aktiven
  Version abweicht und wie viele Läufe an einem Schritt anhalten.
- Wer Workflows in einem Bereich gestaltet, kann Teams als Zuständige wählen, auch ohne Warteschlangen zu verwalten.
- Die Prüfung meldet leere Pflichtfelder einer Aktion («Pflichtfeld «Status» ist leer») schon im Editor statt erst als
  Vorfall im Lauf.
- Lässt sich ein deaktivierter Workflow nicht fortsetzen, weil sein Akteur nicht mehr aktiv ist, sagt die Meldung:
  «Aktiviere den Workflow mit einem anderen Akteur» (ohne Versionsnummer).

### Für den Betrieb

- (keine)

### Hinzugefügt

- `GET /workflows`: je Eintrag `trigger` und `stepCount` dessen, was läuft (aktive Version, sonst Entwurf),
  `draftChanged` (Entwurf weicht von der aktiven Version ab) und `openIncidents` (Läufe im Zustand `incident`).
- `GET /queues/teams`: `scopeType`/`scopeId` (Bereich des Workflows).
- `walkSteps` ist exportiert (alle Schritte einer Liste mit Pfad, auch in Wegen).
- `ValidateOptions.known.inputs`: Pflichtfelder je Aktion; `workflow()` füllt sie aus den Eingabe-Schemas (`required`,
  Bezeichnung aus `title`).

### Geändert

- `GET /queues/teams` erlaubt neben `queue:manage` auch `workflow:manage` am angegebenen Bereich (ohne Bereich: am
  Bereich des Mandanten).
- Prüfung: fehlende oder leere Pflichtfelder einer Aktion sind Fehler (`/steps/n/input/<feld>`); bestehende Entwürfe
  mit solchen Lücken zeigen sie jetzt an und lassen sich erst nach dem Ausfüllen aktivieren.

## [0.6.0] – 2026-11-03

### Für Nutzer

- Aufgaben und Genehmigungen haben Wege nach Ergebnis: Nach «Genehmigt» oder «Abgelehnt», nach «Passt» oder
  «Nachbessern» laufen eigene Schritte, danach geht es nach der Aufgabe weiter.
- Ergebnisse einer Aufgabe dürfen normaler Text sein, auch mit Umlauten und Leerzeichen («Zurück an Absender»).
- Die Prüfung meldet neben Fehlern auch Hinweise, die das Aktivieren nicht hindern: ein Weg, auf dem nichts geschieht,
  Schritte nach «Beenden», ein «Wenn» ohne Schritte.
- Der Probelauf nimmt für Aufgaben und Genehmigungen das gewählte Ergebnis an und folgt dessen Weg.

### Für den Betrieb

- (keine)

### Hinzugefügt

- Definition Fassung 2 (`DEFINITION_SCHEMA_VERSION = 2`): `branches` an `task` (Ergebnis → Schritte) und `approval`
  (`approved`, `rejected`). Fassung 1 bleibt gültig; Wege brauchen Fassung 2. Pfade `/steps/n/branches/<Ergebnis>/i`.
- `validateDefinition` liefert `warnings` (auch bei Fehlern im Inhalt, nicht bei ungültigem Schema);
  `POST /workflows/validate` antwortet mit `{ ok, errors, stage, warnings }`.
- `POST /workflows/:id/dry-run`: `assume` (Schritt-ID → Ergebnis); je Schritt `outcomes` und `outcome`.
- `outcomesOf(step)`, `outcomeName(outcome)`; im Cursor `afterOutcome`.

### Geändert

- Ergebnisse einer Aufgabe: 1–64 Zeichen ohne «/» und «~», ohne Leerzeichen am Anfang oder Ende (bisher ein Name aus
  Buchstaben, Ziffern und «_»). Bestehende Ergebnisse bleiben gültig.
- `DefinitionResult` trägt `warnings`; `schemaVersion` ist `1 | 2`.
- Nach dem Erledigen einer Aufgabe setzt `resumeAfterTask` im Weg des Ergebnisses fort (ohne Weg wie bisher nach dem
  Schritt; «cancelled» hat keinen Weg).
- Probelauf: «Beenden» nennt das Ergebnis auf Deutsch («beendet den Lauf: erfolgreich»).

## [0.5.0] – 2026-11-03

### Für Nutzer

- Beim Zeitplan eines Workflows erscheinen die nächsten Ausführungen, berechnet in der gewählten Zeitzone.

### Für den Betrieb

- (keine)

### Hinzugefügt

- Route `POST /workflows/schedule-preview` (`{ cron, timezone, count? }` → `{ ok, error, next }`, höchstens 10 Termine):
  rechnet mit `nextCronTime` (Zeitzone, Sommerzeit); eine ungültige Angabe ist `ok: false` mit `error`, kein 422. Wie
  `validate` hinter dem Opt-in des Mandanten, ohne Recht am Bereich (liest keine Daten).

## [0.4.0] – 2026-11-03

### Für Nutzer

- Ein pausierter Workflow lässt sich fortsetzen: Er läuft mit derselben Version und im Namen desselben Akteurs weiter,
  ohne dass eine neue Version entsteht.

### Für den Betrieb

- (keine)

### Hinzugefügt

- Route `POST /workflows/:id/resume` (Recht `workflow:activate`): nur aus `paused` mit aktiver Version; prüft, ob der
  Akteur noch aktiv ist (sonst 422) und die Grenze der aktiven Workflows (409 `limit`); baut die Auslöser der aktiven
  Version neu auf. Meldet `workflow.activated` mit `resumed: true` und schreibt `workflow.resumed` ins Audit.
- `TeamOption.group?: string` (Port `teams`): Überschrift der Gruppe in der Auswahl der Oberfläche, z. B. «Rollen»;
  `GET /queues/teams` gibt sie weiter.

## [0.3.0] – 2026-11-03

### Für Nutzer

- Aufgaben im Ablauf: Ein Workflow kann eine Aufgabe an eine Person, ein Team oder eine Warteschlange geben (mit
  Formular, Ergebnis, Frist und Priorität) und wartet, bis sie erledigt ist. Danach geht er mit dem Ergebnis weiter.
- Genehmigungen: erste Antwort, alle, Mehrheit oder nacheinander; eine Ablehnung braucht eine Begründung.
- Warteschlangen mit Team, Sortierung und Zuweisung (selbst nehmen, reihum oder an die Person mit den wenigsten offenen
  Aufgaben). Aufgaben lassen sich nehmen, zurücklegen, weitergeben und gesammelt zuweisen oder abbrechen.
- Fristen zählen Arbeitszeit nach einem Kalender mit Arbeitszeiten und Feiertagen. Bei Verzug werden die Zuständigen
  benachrichtigt; je nach Einstellung steigt die Priorität oder die Aufgabe geht an eine andere Warteschlange.
- Aufgaben zu einem Element, das jemand nicht sehen darf, zeigen nur einen neutralen Hinweis statt des Titels.

### Für den Betrieb

- Neue Migration `workflow_002_tasks` (Tabellen `workflow_task`, `workflow_task_vote`, `workflow_queue`,
  `workflow_calendar`, `workflow_sla_timer`; RLS mit `ENABLE` und `FORCE`, Worker-Policy für Fristen). Gleiche
  Parameter wie `workflow_001_core`; braucht PostgreSQL 15 oder neuer (`ON DELETE SET NULL (queue_id)`). Ein erneuter
  Aufruf von `workflow_subjects` ist nicht nötig.
- Neuer Job `workflow.sla` registrieren (Nutzlast `{ tenantId, timerId }`); `tick` markiert jetzt auch überschrittene
  Fristen und reiht dafür Jobs ein – den Worker unverändert regelmässig aufrufen.
- Neuer optionaler Host-Port `teams` (Auswahl von Teams in der Oberfläche); ohne ihn gibt man Typ und ID von Hand ein.
  Benachrichtigungen `task_assigned`, `approval_requested`, `sla_breached` kommen über den bestehenden Port `notify`.

### Hinzugefügt

- Schritte `task` und `approval` werden ausgeführt (`stageProblems` meldet sie nicht mehr): Aufgabe im Savepoint
  anlegen, Lauf `waiting` ohne Job, `Engine.resumeAfterTask` beim Erledigen; Ergebnis unter `steps.<id>` (`outcome`,
  `values`, `completedBy`, `completedAt`, bei Genehmigungen `votes`, `reason`); abgebrochene Aufgabe → `outcome:
  'cancelled'`; beendeter Lauf bricht offene Aufgaben ab. Probelauf nimmt das erste Ergebnis an.
- `Assignee` um `{ queue: <uuid> }`, Schritte um `escalation` (`notify`, `raisePriority`, `queue`) und Genehmigungen um
  `priority` erweitert; Dauern mit Arbeitsstunden `PT8BH` (Schema-Fassung bleibt 1, nur zusätzliche Werte).
- Kalender (`calendar.ts`): `addWorkingTime`, `isWorkingTime`, `calendarProblems`, `DEFAULT_WORK_CALENDAR`; Wochenende,
  Feiertage, Mittag und Sommerzeit getestet. `wait` mit `BD`/`BH` rechnet nach dem Standardkalender des Mandanten.
- Formulare serverseitig (`FormChecker`): Feldarten des Pakets und `FieldKind.valueSchema` der App.
- Reine Regeln: `approvalOutcome`, `nextRoundRobin`, `leastLoaded`, `rotateAfter`, `raisePriority`, `actorFrom`.
- Routen `/tasks` (Ansichten, Zähler, lesen, nehmen, zurücklegen, weitergeben, erledigen, entscheiden, abbrechen,
  Massenaktionen), `/queues` (CRUD, Mitglieder, Teams), `/calendars` (CRUD, Vorschau einer Frist); `meta.teams`.
- Ereignisse `task.created`, `task.assigned`, `task.decided`, `task.completed`, `task.cancelled`, `task.sla_breached`
  mit Herkunft des Laufs; Audit für Anlegen, Zuweisungen, Entscheide, Erledigen, Abbrechen, Verzug, Warteschlangen und
  Kalender.
- Port `WorkflowHost.teams?` und Typ `TeamOption`; Job `WORKFLOW_JOB_SLA`; `WORKFLOW_STAGE = 2`.

### Geändert

- `parseDuration` liefert zusätzlich `businessHours`; `addDuration` wirft bei Arbeitsstunden (dafür `addWorkingTime`).
- `tick` zählt die eingereihten Jobs für Zeitpläne und Fristen.
- `meta.stepKinds` enthält `task` und `approval`.

## [0.2.0] – 2026-11-02

### Für Nutzer

- Automationen: Ein Workflow startet bei einem Ereignis (mit Filter), nach Zeitplan oder von Hand (mit Formular) und
  führt Schritte aus – Aktionen, Wenn/Sonst, Für jedes, Warten, Werte setzen, Beenden. Er handelt im Namen der Person,
  die ihn aktiviert, oder eines Maschinen-Clients, den sie verwalten darf; fehlt dabei ein Recht, hält der Lauf an.
- Jeder Lauf hat ein Protokoll je Schritt (Eingaben gekürzt, Geheimnisse geschwärzt). Scheitert ein Schritt endgültig,
  entsteht ein Vorfall: nochmals versuchen, Schritt überspringen oder abbrechen.
- Probelauf: zeigt je Schritt, was geschähe, ohne etwas zu ändern.
- Schutz: Workflows, die sich gegenseitig auslösen, stoppen nach fünf Stufen; Grenzen für Läufe pro Tag, Schritte pro
  Lauf und Einträge in Schleifen.
- Workflows müssen für die Organisation eingeschaltet werden; Läufe sind nur für Personen sichtbar, die auch das
  zugehörige Element sehen.

### Für den Betrieb

- Neue Migration `workflow_001_core` (Tabellen `workflow`, `workflow_version`, `workflow_trigger`, `workflow_run`,
  `workflow_step`, `workflow_settings`, `workflow_usage`; RLS mit `ENABLE` und `FORCE`). Danach muss die App in einer
  eigenen Migration `<schema>.workflow_subjects('{…}')` mit allen Bezugstypen aufrufen, sonst sind Läufe mit Bezug
  unsichtbar.
- Worker: Jobs `workflow.step` und `workflow.start` registrieren (Nutzlast mit `tenantId`, im Mandantenkontext
  ausführen) und `tick` regelmässig aufrufen (z. B. jede Minute, Worker-Rolle).
- Opt-in je Mandant über `PUT /v1/workflows/settings` (Recht `workflow:admin`); ohne Opt-in antworten die Routen mit
  404 `module-disabled`. Optional `LISTEN workflow_triggers` → `invalidateTriggers(tenantId)` bei mehreren Prozessen.

### Hinzugefügt

- Engine (Stufe 1 des Konzepts): `dispatch(tx, event, { tenantId?, causedBy? })` mit Zwischenspeicher der Auslöser je
  Mandant (ohne Treffer keine Abfrage), Jobs `workflow.step` (ein Schritt je Transaktion, Aktion im Savepoint, Rechte
  über `needs`, Wiederholung nach `onError`, Fehlerpfad, Vorfall mit `notify` und `workflow.incident_opened`) und
  `workflow.start` (Zeitplan), `tick(tx)` mit `FOR UPDATE SKIP LOCKED`, Warten über `runAt`, Probelauf über
  `WorkflowAction.dryRun` (Savepoint, zurückgerollt).
- Schleifenschutz: Ereignisse aus Läufen (an derselben `tx` erkannt oder über `causedBy`) lösen nur Auslöser mit
  `includeWorkflowEvents` aus; Kettentiefe über `limits.chainDepth` ergibt einen Lauf im Zustand `incident`.
- Migrationen `workflowMigrations({ schema, appRole, schedRole, tenantExpr?, principalExpr? })` bzw.
  `wf.migrations(…)` (idempotent, mit Prüfsumme), Funktion `<schema>.workflow_subjects(jsonb)` für die Lesesicht.
- REST-Routen: Workflows (Liste, Entwurf anlegen/ändern mit `If-Match`/löschen, prüfen, aktivieren, pausieren,
  archivieren, Versionen), manueller Start, Probelauf, Läufe mit Cursor und Schrittprotokoll, Vorfälle (`retry`,
  `skip`, `cancel`), Einstellungen (Opt-in, Grenzen, Zähler).
- Cron mit fünf Feldern und Zeitzone ohne Abhängigkeit (`parseCron`, `nextCronTime`, Sommerzeit getestet), Dauern mit
  Arbeitstagen (`parseDuration`, `addDuration`).
- `WorkflowHost.canActAs?` (W6: Akteur beim Aktivieren wählen), `ActionContext.log`, `DispatchOptions`, `Causation`,
  `WorkflowJobPayload`, `invalidateTriggers`, `stageProblems`, `chainDecision`, `effectiveLimits`, `redact`,
  `definitionChecksum`, `StepFailure`.
- Optionen `tenantScope`, `triggerCacheMs`, `retryDelayMs`, `clock`.
- Route `GET /workflows/meta` (Recht `workflow:read`, Typ `WorkflowMeta`): angemeldete Ereignistypen (mit
  Filterfeldern, dazu die des Baukastens), Aktionen mit Ein-/Ausgabe-Schema, Bezugstypen mit Feldern im angefragten
  Bereich, Zustandsfelder, Feldarten, ausführbare Schrittarten, Vergleiche, Formatierer, `canActAs` – für den Editor
  von `@vollholz/workflow-web`.

### Geändert

- **Breaking:** `WorkflowHost.tx(req, fn)` ist Pflicht (Transaktion im Mandantenkontext für die Routen).
- **Breaking:** `ActionContext.log` ist Pflicht (betrifft nur Code, der selbst einen `ActionContext` baut, z. B. Tests).
- `GET /workflows/status`: `available` heisst jetzt «Engine bereit und Mandant eingeschaltet», `stage` ist 1.
- Auslöser dürfen auch auf Ereignisse des Baukastens (`workflow.*`) hören.

## [0.1.0] – 2026-11-02

### Für Nutzer

- (keine)

### Für den Betrieb

- (keine)

### Hinzugefügt

- Gerüst (Stufe 0 des Konzepts «Workflows als Baukasten»): Ports `WorkflowHost`, `WorkflowSubject`, `WorkflowAction`,
  `StateField`, `EventSource`, `FieldKind`, `Tx`, `Migration` u. a. mit neutralen Begriffen (Akteur, Bereich, Bezug,
  Ereignis, Aktion, Zustandsfeld, Team, Feldart).
- Definition eines Workflows als JSON-Schema (`definitionSchema`, `schemaVersion` 1) mit Prüfung `validateDefinition`
  (deutsche Meldungen mit Pfad): Arten `automation`, `case`, `state_model`; Auslöser Ereignis, Zeitplan, manuell,
  Zustandswechsel, Unterablauf; Schritte Aktion, Wenn/Sonst, Für jedes (begrenzt), Warten, Aufgabe, Genehmigung (erste
  Antwort, alle, Mehrheit, nacheinander), Unterablauf, Ende, Variablen setzen; Fehlerbehandlung je Schritt.
- Ausdrücke ohne Skripte: `evaluateCondition` (strukturierte Bedingungen), `renderTemplate`/`resolveValue`
  (Platzhalter `{{…}}` mit Formatierern `date`, `number`, `list`, `default`).
- `workflow(options)` mit Status-Route `GET <prefix>/workflows/status`; `dispatch` und `checkTransition` tun noch
  nichts, `jobs` und `migrations()` sind leer (Datenbank und Engine ab Stufe 1). `workflowPermissions`,
  `WORKFLOW_EVENT_TYPES`, `DEFAULT_LIMITS`.
