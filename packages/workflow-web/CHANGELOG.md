# Changelog `@vollholz/workflow-web`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major. Vor 1.0.0 kann jede Minor-Version
Breaking Changes enthalten.

Jede Version beginnt mit **Für Nutzer** (allgemein verständlich, ohne Namen aus dem Code; übernimmt die App unverändert
in ihre Release Notes) und **Für den Betrieb** (Migrationen, Einstellungen, Wartungsläufe), sonst je «(keine)». Danach
folgen die Angaben für die Entwickler der App.

## [Unveröffentlicht]

## [0.2.0] – 2026-11-02

### Für Nutzer

- Workflows lassen sich in der Oberfläche anlegen und bearbeiten: Auslöser wählen (Ereignis mit Filter, Zeitplan oder
  von Hand mit Formular), Schritte als Liste zusammenstellen (Aktion, Wenn/Sonst, Für jedes, Warten, Werte setzen,
  Beenden), Werte aus dem Kontext mit Bezeichnung einfügen. Fehler zeigt der Editor direkt am Schritt.
- Probelauf mit einem gewählten Element oder Ereignis zeigt je Schritt, was geschähe, ohne etwas zu ändern.
- Aktivieren mit Zusammenfassung (in wessen Namen, Auslöser, Zeitplan); Pausieren und Archivieren. Hat jemand anderes
  inzwischen gespeichert, fragt der Editor, ob neu geladen oder die eigene Fassung gespeichert werden soll.
- Protokoll der Läufe mit Schritten, Fehlern und Zeiten; bei einem Vorfall nochmals versuchen, Schritt überspringen
  oder abbrechen.
- Workflows für die Organisation ein- und ausschalten und Grenzen senken (Administration).
- Am Element: Workflows von Hand starten (mit Formular) und die letzten Läufe sehen.

### Für den Betrieb

- (keine)

### Hinzugefügt

- Bausteine `WorkflowList`, `SettingsPanel`, `StatusBanner`; `StepListEditor`, `RunLog`, `SubjectWorkflowBar` sind
  jetzt umgesetzt (Stufe 1). Daten-Hooks für alle Routen der Stufe 1 (`useWorkflows`, `useSaveWorkflow` mit
  `If-Match`, `useValidateDefinition`, `useWorkflowLifecycle`, `useDryRun`, `useRuns` mit Cursor, `useIncidentAction`
  …), `wfKeys`, `wfRequest`, `WorkflowApiError`, Typen der Antworten.
- Provider: `prefix`, `actors` (`label`, `clients`), `scopeLabel`, `components` (ersetzbare Grundbausteine),
  `queryClient`; `subjects` mit `search` und `onOpen`; `me.label`.
- Braucht `GET /workflows/meta` aus `@vollholz/workflow` 0.2.0.

### Geändert

- **Breaking:** `api.baseUrl` ist die Herkunft (Standard: gleiche wie die Seite), das Präfix steht neu in `prefix`
  (Standard `/v1`); vorher war `baseUrl` z. B. `/v1`. `api` kann einen eigenen `fetch` mitgeben.
- **Breaking:** Peer-Abhängigkeit `@tanstack/react-query` ^5.90.
- `RunLogProps`, `StepListEditorProps`, `SubjectWorkflowBarProps` haben neue Angaben (`onOpenWorkflow`, `onShowRuns`,
  `filter`, `onOpenRun` …).

## [0.1.0] – 2026-11-02

### Für Nutzer

- (keine)

### Für den Betrieb

- (keine)

### Hinzugefügt

- Gerüst (Stufe 0): `WorkflowProvider` (`api`, `me`, `can`, optional `subjects`, `fields`) und `useWorkflow`;
  Bausteine `StepListEditor`, `MyWork`, `QueueView`, `CaseView`, `RunLog`, `SubjectWorkflowBar` zeigen vorerst nur
  «noch nicht verfügbar». Stylesheet `@vollholz/workflow-web/styles.css`.
