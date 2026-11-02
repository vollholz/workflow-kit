# Changelog `@vollholz/workflow`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major. Vor 1.0.0 kann jede Minor-Version
Breaking Changes enthalten.

Jede Version beginnt mit **Für Nutzer** (allgemein verständlich, ohne Namen aus dem Code; übernimmt die App unverändert
in ihre Release Notes) und **Für den Betrieb** (Migrationen, Einstellungen, Wartungsläufe), sonst je «(keine)». Danach
folgen die Angaben für die Entwickler der App.

## [Unveröffentlicht]

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
