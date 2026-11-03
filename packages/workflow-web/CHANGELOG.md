# Changelog `@vollholz/workflow-web`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major. Vor 1.0.0 kann jede Minor-Version
Breaking Changes enthalten.

Jede Version beginnt mit **Für Nutzer** (allgemein verständlich, ohne Namen aus dem Code; übernimmt die App unverändert
in ihre Release Notes) und **Für den Betrieb** (Migrationen, Einstellungen, Wartungsläufe), sonst je «(keine)». Danach
folgen die Angaben für die Entwickler der App.

## [Unveröffentlicht]

## [0.3.1] – 2026-11-03

### Für Nutzer

- Personen erscheinen überall mit ihrem Namen statt einer langen Kennung: bei Zuständigen, Genehmigenden, Stimmen,
  im Protokoll, in der Liste der Workflows und beim Weitergeben einer Aufgabe.
- Bezüge erscheinen im Protokoll und bei Aufgaben mit ihrem Titel statt einer Kennung.
- Im Editor wählst du Zuständige und Genehmigende über eine Personensuche; die Zusammenfassung eines Schritts nennt
  Warteschlange, Team und Person mit Namen.
- Korrekte Einzahl und Mehrzahl, z. B. «1 Person kann entscheiden», «1 Aufgabe zuweisen», «1 Tag».
- Nach dem Start eines Workflows an einem Element erscheinen neue Aufgaben und der Lauf ohne Neuladen.
- Kalender: Die Felder der Arbeitszeiten nennen für Bildschirmleser ihren Wochentag.

### Für den Betrieb

(keine) – braucht weiterhin `@vollholz/workflow` 0.3.0.

### Hinzugefügt

- Provider: `actors.Name?: ComponentType<{ actor: WorkflowActor }>` und `subjects.<typ>.Title?: ComponentType<{ id: string }>`
  (beide optional; Komponenten der App, die eigene Hooks nutzen dürfen). Ohne Angabe wie bisher `actors.label` bzw.
  der Titel aus der API, sonst Bezeichnung und ID.
- Bausteine `ActorName` (`{ actor }`), `SubjectTitle` (`{ type, id, title? }`), `PersonInput` (Person wählen mit
  `actors.search`, sonst ID) und `AssigneeText` (Zuständigkeit mit Namen).
- `useRuns` und `useTasks` nehmen als dritte Angabe `{ refetchInterval }` (Zahl, `false` oder Funktion); Typ
  `RefetchInterval`.

### Geändert

- Alle Anzeigen von Akteuren nutzen `ActorName`, alle Anzeigen von Bezügen `SubjectTitle` (Links bleiben Links).
  `actorName()` bleibt für Texte (z. B. `title`, `aria-label`).
- Editor: `AssigneeInput` wählt Personen mit `PersonInput`; Zusammenfassung von Aufgabe und Genehmigung mit Namen der
  Warteschlange (aus `useQueues`) und des Teams (aus `useTeams`, falls die App Teams anbietet). `describeAssignee`
  nimmt optional `teamName`.
- Weitergeben: Personen als Optionsfelder mit `ActorName` statt Auswahlliste.
- `useStartRun` lädt nach dem Start auch Aufgaben und Zähler neu; `SubjectWorkflowBar` lädt Läufe und Aufgaben alle
  2 s nach, solange ein Lauf des Bezugs `running` ist (höchstens 30 s nach dem Start).
- Texte mit Zahl in Einzahl/Mehrzahl (Aufgaben, Personen, Dauer, Zeitplan, Zähler des Tages).
- Kalender-Editor: Wochentagsfelder mit `aria-label` «<Wochentag>: Arbeitszeiten».

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
