# Changelog `@vollholz/workflow-web`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major. Vor 1.0.0 kann jede Minor-Version
Breaking Changes enthalten.

Jede Version beginnt mit **Für Nutzer** (allgemein verständlich, ohne Namen aus dem Code; übernimmt die App unverändert
in ihre Release Notes) und **Für den Betrieb** (Migrationen, Einstellungen, Wartungsläufe), sonst je «(keine)». Danach
folgen die Angaben für die Entwickler der App.

## [Unveröffentlicht]

## [0.3.0] – 2026-11-03

### Für Nutzer

- «Meine Arbeit»: Aufgaben für dich, für dein Team und – mit Recht – alle, mit Zählern für offene und überfällige
  Aufgaben, Frist-Anzeige, Sortierung nach Dringlichkeit, Frist oder Alter.
- Aufgabe öffnen: nehmen, zurücklegen, weitergeben, das Formular ausfüllen und mit einem Ergebnis erledigen;
  Genehmigungen genehmigen oder mit Begründung ablehnen, die Stimmen anderer sehen.
- Mehrere Aufgaben auf einmal zuweisen oder abbrechen.
- Warteschlangen und Kalender (Arbeitszeiten, Feiertage) verwalten, mit Vorschau, wann eine Frist abläuft.
- Im Editor lassen sich Aufgaben und Genehmigungen als Schritte einfügen; am Element erscheinen dessen offene Aufgaben.

### Für den Betrieb

- Braucht `@vollholz/workflow` 0.3.0 (Routen `/tasks`, `/queues`, `/calendars`).

### Hinzugefügt

- Bausteine `MyWork` (ersetzt den Platzhalter), `TaskDetail`, `DueBadge`, `QueueList`, `QueueView` (ersetzt den
  Platzhalter), `QueueEditor`, `CalendarList`, `CalendarEditor`, `AssigneeInput`, `TeamInput`.
- Hooks `useTasks`, `useTask`, `useTaskAction`, `useBulkTasks`, `useTaskCounts` (Zähler für die Navigation),
  `useQueues`, `useQueue`, `useQueueMembers`, `useSaveQueue`, `useDeleteQueue`, `useTeams`, `useCalendars`,
  `useCalendar`, `useSaveCalendar`, `useDeleteCalendar`, `useCalendarPreview`; Hilfen `fmtDue`, `parseHours`,
  `formatHours`, `describeAssignee`; Typen `TaskJson`, `TaskDetailJson`, `QueueJson`, `CalendarJson` u. a.
- Editor: Karten für `task` (Titel, Zuständig, Formularfelder, Ergebnisse, Frist, Priorität) und `approval`
  (Genehmigende, Art, Begründung bei Ablehnung); Dauer in Arbeitsstunden.
- `SubjectWorkflowBar`: offene Aufgaben zum Bezug, neue Angabe `onOpenTask`. Provider: `actors.search`.

### Geändert

- `CaseView` bleibt der einzige Platzhalter (Stufe 3).


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
