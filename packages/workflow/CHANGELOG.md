# Changelog `@vollholz/workflow`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major. Vor 1.0.0 kann jede Minor-Version
Breaking Changes enthalten.

Jede Version beginnt mit **Für Nutzer** (allgemein verständlich, ohne Namen aus dem Code; übernimmt die App unverändert
in ihre Release Notes) und **Für den Betrieb** (Migrationen, Einstellungen, Wartungsläufe), sonst je «(keine)». Danach
folgen die Angaben für die Entwickler der App.

## [Unveröffentlicht]

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
