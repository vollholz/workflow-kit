# Changelog `@vollholz/workflow-web`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major. Vor 1.0.0 kann jede Minor-Version
Breaking Changes enthalten.

Jede Version beginnt mit **Für Nutzer** (allgemein verständlich, ohne Namen aus dem Code; übernimmt die App unverändert
in ihre Release Notes) und **Für den Betrieb** (Migrationen, Einstellungen, Wartungsläufe), sonst je «(keine)». Danach
folgen die Angaben für die Entwickler der App.

## [Unveröffentlicht]

## [0.4.0] – 2026-11-03

### Für Nutzer

- Der Editor sagt immer, was gerade läuft: Eine Statusleiste nennt die aktive Version und ob der Entwurf davon
  abweicht, mit genau einer Hauptaktion – «Aktivieren …», «Version 2 aktivieren …» oder «Fortsetzen». Daneben stehen
  «Verwerfen …» (Entwurf zurück auf die aktive Version), «Pausieren», «Archivieren …» und «Löschen …».
- Der Entwurf speichert sich selbst; der Knopf «Speichern» entfällt. Solange etwas nicht gespeichert ist, fragt der
  Browser beim Verlassen nach.
- Ein pausierter Workflow läuft mit «Fortsetzen» weiter, ohne neue Version.
- Name und Beschreibung stehen im Kopf; ändern über «Name und Beschreibung …».
- Ein entfernter Schritt lässt sich mit «Rückgängig» zurückholen.
- Zuständige und Genehmigende wählst du in einem einzigen Feld mit Suche: Personen, Warteschlangen und Teams erscheinen
  gruppiert, eine Person erscheint nie als Team.
- Probelauf und Protokoll nennen Schritte mit Nummer und Titel («Schritt 1 · Aufgabe «Gerät prüfen»») statt mit ihrer
  Kennung; Eingaben und Ausgaben stehen unter «Technische Details». Der Lauf nennt den Workflow mit Namen.
- «Aktivieren» und «Entwurf anlegen» sind nicht mehr vorab gesperrt: Fehlt etwas, sagt der Dialog beim Absenden was.

### Für den Betrieb

- Braucht `@vollholz/workflow` 0.4.0 (Route `resume`).

### Hinzugefügt

- `StepListEditor`: `saveDelayMs` (Standard 800) und `showTitle` (Standard `true`; `false`, wenn die App den Namen im
  Seitenkopf zeigt).
- `useWorkflowLifecycle(id).resume`.
- `TeamOptionJson.group?`; `TeamInput` gruppiert die Teams danach.
- Hilfen `stepNumberOfPath`, `placeOfPath`, `stepTitle` (Schritte mit Nummer und Titel) und `fmtTime`.

### Geändert

- `AssigneeInput` ist eine Auswahl mit Suche (Combobox, ↓/↑, Enter, Esc) statt «Art wählen, dann Angabe»; ohne
  `actors.search` bietet sie «Person mit der ID …» an.
- `describeAssignee` nennt ein Team so, wie die App es bezeichnet (ohne Vorsilbe «Team», wenn die Bezeichnung bekannt
  ist).
- Der Editor zeigt das Feld «Name des Workflows» nur noch im Dialog «Name und Beschreibung».

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
