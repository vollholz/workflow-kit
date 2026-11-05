# Changelog `@vollholz/workflow-web`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major. Vor 1.0.0 kann jede Minor-Version
Breaking Changes enthalten.

Jede Version beginnt mit **Für Nutzer** (allgemein verständlich, ohne Namen aus dem Code; übernimmt die App unverändert
in ihre Release Notes) und **Für den Betrieb** (Migrationen, Einstellungen, Wartungsläufe), sonst je «(keine)». Danach
folgen die Angaben für die Entwickler der App.

## [Unveröffentlicht]

## [0.8.0] – 2026-11-05

### Für Nutzer

- Ein Lauf erscheint als Ablauf: derselbe Ablauf wie im Editor mit dem Weg, den der Lauf genommen hat, mit Zeiten und
  Namen (wer erledigt oder entschieden hat). Der Schritt, an dem der Lauf steht, ist hervorgehoben; nicht erreichte
  Schritte und Wege sind blass. Ein Vorfall steht an seinem Schritt mit «Nochmals versuchen» und «Schritt überspringen»;
  «Lauf abbrechen» steht im Menü.
- Hält ein Lauf an einem Schritt an, sagt das die Leiste des Workflows («1 Lauf hält an»); die Hauptaktion ist dann
  «Vorfall ansehen».
- Versionen lassen sich vergleichen (mit der vorherigen, einer anderen Version oder dem Entwurf), ihr Ablauf ansehen und
  «Als Entwurf übernehmen»; wirksam wird das erst mit dem Aktivieren.
- «Neu» bietet Vorlagen an (Genehmigung einholen, Aufgabe mit Rückmeldung, regelmässig nach Zeitplan; dazu die der App).
- Die Liste zeigt jeden Workflow als Satz («Bei «Bestellung eingegangen» · 3 Schritte») und offene Vorfälle.
- Ein Workflow ist «Aktiv», «Inaktiv» (noch nie aktiviert oder deaktiviert) oder «Archiviert»; daneben steht «Entwurf»,
  solange Änderungen noch nicht wirken. Versionsnummern stehen nur noch unter «Versionen»; dort steht der Entwurf über
  den Versionen («wird Version 3»). Aus «Pausieren» wird «Deaktivieren», aus «Fortsetzen» «Aktivieren», aus «Version n
  aktivieren …» «Entwurf aktivieren …». Hat das System einen Workflow deaktiviert, weil sein Akteur nicht mehr aktiv
  ist, wählt man beim Aktivieren einen anderen. Die Liste filtert auch nach «Inaktiv» und «Mit Entwurf».
- Im Lauf steht keine Versionsnummer mehr; lief er mit einer früheren Fassung, steht «ältere Fassung».
- Den Entwurf eines aktiven oder deaktivierten Workflows verwirft «Änderungen verwerfen …»; «Workflow löschen …» gibt es,
  solange er nie aktiv war.
- Tastenkürzel im Ablauf: `P` wechselt zwischen Bearbeiten und Probelauf, `Ctrl`+`D` dupliziert einen Schritt,
  `Ctrl`+`Z` macht rückgängig, `Ctrl`+`Y` wiederholt; «Tastenkürzel» im Menü listet alle.
- Teams lassen sich als Zuständige auch ohne das Recht «Warteschlangen verwalten» wählen, wenn man Workflows gestaltet.
- Eine neue Aktion übernimmt die Vorgaben der App (z. B. den Bezug, um den es geht), statt leer zu starten.
- In den Listen der Workflows, Läufe und Versionen ist die ganze Zeile anklickbar; Links in Tabellen sind nicht mehr
  unterstrichen (erst beim Darüberfahren), die Startzeit eines Laufs ist nicht mehr fett.
- Farben der Zustände: Grün heisst nur noch «wirkt / erfolgreich»; «läuft», «wartet» und «in Arbeit» sind blau, «Inaktiv»
  und «Archiviert» grau, der Marker «Entwurf» ebenfalls grau. «Entwurf» in der Liste führt zum Editor.
- Aus «Lauf» wird «Run»: Runs eines Workflows, «Run abbrechen», «1 Run hält an», Grenzen «Runs pro Tag» und «Schritte
  pro Run». Workflows schaltet man «für diese Organisation» ein.
- Die Liste zeigt je Workflow den letzten Run mit Datum und Zeit (öffnet ihn) und seinen Zustand statt der Zähler der
  letzten Läufe und des Akteurs; schmal bleiben Name, Zustand und Zustand des Runs.
- Für einen Kopf, der als eine Leiste stehen bleibt (wenn die App ihn so baut): Zustand, Hauptaktion und Menü des
  Workflows und des Runs stehen dort, «Entwurf» neben dem Namen; über dem Ablauf bleiben Speicherstand, Fehler und
  Hinweise und «Bearbeiten | Probelauf». Wenn die App es verlangt, lässt sich ein Entwurf erst nach einem erfolgreichen
  Probelauf aktivieren; der Probelauf sagt das.

### Für den Betrieb

- Braucht `@vollholz/workflow` 0.7.0 (Liste mit Auslöser, Schritten, Entwurf und Vorfällen; Teams mit Bereich).

### Hinzugefügt

- `RunView` (Lauf als Ablauf; `RunLog` nutzt ihn) mit `SubjectLink`; `RunLog` › `state` (Zustand am Anfang des Filters).
- `StepListEditor` › `onOpenRun`; `onShowRuns(workflowId, { state })`.
- `VersionList` › `onAdopted`, `onOpenDraft` (Zeile «Entwurf»); Vergleich, Ablauf und «Als Entwurf übernehmen» je Version.
- `hasDraft(workflow, differs?)` und `DraftMark` (Marker «Entwurf»); `BadgeTone` › `draft`.
- `WorkflowList` › `templates`, `builtinTemplates`; `WorkflowTemplate`, `builtinTemplates`.
- `FlowRun` für Läufe: `live`, `below`, `FlowStepResult` (`active`, `text`); `FlowView` › `onDuplicate`.
- `TeamScope` (Bereich für die Teams-Auswahl); `useTeams(q, enabled, scope)`, `useRun(id, { refetchInterval })`,
  `useWorkflowMeta(scope, enabled)`.
- Typen: `WorkflowSummary` › `trigger`, `stepCount`, `draftChanged`, `openIncidents` (nur in der Liste).
- `showTitle` an `WorkflowList`, `RunLog` und `SettingsPanel` (Standard `true`; `false` blendet die Überschrift nur
  sichtbar aus, wenn die App den Bereich im Seitenkopf nennt); `rowLink(open)` für ganz klickbare Tabellenzeilen.
- Kopf «Kontextleiste» (eine Leiste der App je Ebene): `StepListEditor` › `slots` (`draft`, `actions`: Plätze in der
  Leiste der App, gefüllt per Portal), `menuItems` (Einträge der App zuoberst im Menü), `requireProbe` (Aktivieren erst
  nach erfolgreichem Probelauf mit diesem Entwurf); `RunView` › `slots` (`actions`); `WorkflowActions` (Zustand und Menü
  ausserhalb des Editors: Aktivieren derselben Fassung, Verwerfen, Deaktivieren, Archivieren, Löschen),
  `WorkflowDraftMark` (Marker «Entwurf» mit `onOpen`), `useDraftDiffers`, `NewWorkflowButton` («Neu» für die Leiste);
  `WorkflowList` › `showCreate`, `onOpenRun(workflowId, runId)`; `RunLog` › `onOpenRun(runId)` (Run auf eigener Seite);
  `DraftMark` › `onOpen`; `MenuItem.separator`; Export `fmtDateTime`; Typ `WorkflowMenuItem`.

### Geändert

- `FlowRun.onAssume` ist optional (nur im Probelauf).
- Das Menü «Weitere Aktionen» liegt in `menu.tsx` (`MoreMenu`); der Editor enthält es weiter.
- `ChangesList` › `empty` (Text ohne Änderungen).
- `STATE_LABEL`: `draft` und `paused` heissen «Inaktiv» (bisher «Entwurf», «Pausiert»); `stateTone` liefert `ok` für
  `active`, sonst `muted`. Der Filter von `WorkflowList` bietet «Aktiv», «Inaktiv», «Archiviert» und «Mit Entwurf»
  (die beiden letzten filtert die Liste selbst).
- `runTone('running' | 'waiting')` und `taskTone('in_progress')` liefern `info` (bisher `accent`); `Badge` kennt den Ton
  `info` (`BadgeTone`).
- Neue Aktionen aus der Auswahl starten mit den `default`-Werten ihres Eingabe-Schemas (bisher leer).
- Nicht genommene Wege tragen die Klasse `wf-lane-skip` (bisher `skip`, die mit Klassen der App kollidieren konnte, z. B.
  einem Sprunglink «Zum Inhalt springen»; der Weg lag dann über dem anderen).
- `WorkflowList`: Spalten «Letzter Run» und «Run-Status» statt «Letzte Läufe» und «Akteur»; Art, Bereich und Datum
  des Runs haben die Klasse `wf-col-wide` (bis 760 px ausgeblendet). Die Überschrift von `RunLog` heisst «Runs».
- Mit `slots` entfallen im Menü des Editors «Name und Beschreibung …» und «Runs ansehen» (die App hat Einstellungen
  und Reiter); ohne `slots` heisst der Eintrag «Runs ansehen» (bisher «Läufe ansehen»).

## [0.7.0] – 2026-11-03

### Für Nutzer

- Ergebnisse sind Wege: Eine Genehmigung zeigt im Ablauf die Wege «Genehmigt» und «Abgelehnt», eine Aufgabe mit zwei
  oder mehr Ergebnissen je Ergebnis einen Weg. Ein Weg, auf dem nichts geschieht, trägt den Hinweis «Hier geschieht
  nichts».
- Ergebnisse einer Aufgabe stehen als Liste («Ergebnis hinzufügen», umbenennen, entfernen) statt «mit Komma
  getrennt»; beim Umbenennen wandert der Weg mit.
- Der Probelauf läuft im Ablauf: Jede Karte zeigt, was geschähe; nicht erreichte Schritte und Wege sind blass. Bei
  Aufgaben und Genehmigungen wählst du an der Karte das Ergebnis, der Probelauf folgt dann diesem Weg. Die Eingabe beim
  Start ist ein Formular statt JSON.
- Daten erscheinen als Chips mit Bezeichnung («Schritt 2 · Begründung», «Bestellung · ID») statt `{{…}}`; einfügen mit
  «{» oder «Daten». Die Auswahl zeigt nur Daten, die an der Stelle feststehen.
- «Änderungen ansehen» vergleicht den Entwurf mit der aktiven Version (neu, geändert, verschoben, entfernt, Auslöser).
  Der Aktivieren-Dialog zeigt die Änderungen, den Stand des Probelaufs und die Hinweise der Prüfung.
- Fehler und Hinweise stehen getrennt: Fehler hindern das Aktivieren, Hinweise nicht.

### Für den Betrieb

- Braucht `@vollholz/workflow` 0.6.0 (Wege, Hinweise, Probelauf mit Annahmen).

### Hinzugefügt

- `TemplateInput` zeigt Daten als Chips (`contenteditable`, gespeichert bleibt `{{pfad}}`); `DataPicker`, `DataLabels`,
  `describeTemplate`, `templateParts`.
- `ContextField.chip`; `contextFields(def, meta, subjectLabel, at?)` mit Daten an einer Stelle.
- Modul `paths.ts` (Pfade mit Wegen, Nummern «2.b1»), `changes.tsx` (`diffDefinitions`, `ChangesList`).
- Typen: `branches`, `ValidationJson.warnings`, `DryRunStepJson` (`outcomes`, `outcome`), `DryRunBody.assume`.

### Geändert

- Leiste: «n Fehler» und «n Hinweise» getrennt (bisher «n Hinweise» für Fehler); Liste am Auslöser «Fehler am
  Auslöser».
- Der Editor hebt eine Definition beim ersten Weg nach Ergebnis auf Fassung 2.
- `PlaceholderPicker` entfällt (ersetzt durch `DataPicker`).

## [0.6.0] – 2026-11-03

### Für Nutzer

- Der Ablauf entsteht Schritt für Schritt: Ein neuer Workflow zeigt nur «Ersten Schritt hinzufügen». Zuerst wählst du,
  wie er startet (wenn etwas passiert, nach Zeitplan, von Hand), danach fügt «+ Schritt hinzufügen» den nächsten Schritt
  an. «Start» und «Ende» stehen nicht mehr vorab da.
- Der Ablauf erscheint als Kette von Karten mit Verbindungslinie, mittig und mit ruhigen Abständen; «Dann» und «Sonst»
  stehen nebeneinander. Das «+» zwischen zwei Schritten erscheint beim Darüberfahren oder mit der Tastatur.
- Die Auswahl neuer Schritte öffnet sich als Seitenleiste. Sie zeigt zuerst nur die Gruppen; eine Gruppe öffnet ihre
  Schritte, «Zurück» führt zu den Gruppen. Die Suche findet Schritte über alle Gruppen.
- Der Kopf des Editors ist aufgeräumt: eine Leiste mit dem Zustand (Entwurf, Aktiv · Version n, Pausiert,
  Archiviert), dem Speicherstand, der Zahl der Hinweise (ein Klick springt zur Stelle), «Bearbeiten | Probelauf» und
  genau einer Hauptaktion. Seltenes – Verwerfen, Pausieren, Archivieren, Löschen, Name und Beschreibung, Läufe – steht
  unter «Weitere Aktionen», Archivieren und Löschen abgetrennt zuletzt. Der Satz zum Auslöser, «Keine Fehler gefunden» und die erklärenden Texte entfallen; ein
  pausierter Workflow nennt den Grund als Meldung.
- Namen in der Liste der Workflows sind nicht mehr unterstrichen.
- Karten nennen die Art nur, wenn der Titel etwas anderes sagt; eine Aufgabe ohne Zuständige zeigt «Noch niemand
  zuständig».

### Für den Betrieb

- (keine)

### Geändert

- `StepListEditor`: Der Kopf zeigt mit `showTitle` nur noch Name und Beschreibung; Satz, Bereich und Akteur sowie die
  Knöpfe «Name und Beschreibung …» und «Läufe ansehen» entfallen dort. Beide Aktionen stehen im Menü «Weitere
  Aktionen»; `onShowRuns` und `onOpenSettings` wirken wie bisher.
- Ein Workflow ohne Schritte mit dem Auslöser von Hand (der Standard eines neuen Entwurfs) gilt als «noch ohne
  Auslöser»: Der Ablauf zeigt «Ersten Schritt hinzufügen» und fragt zuerst nach dem Auslöser.
- Klassen: `wf-life`, `wf-editor-sentence`, `wf-editor-tools` und `wf-validation` entfallen; neu sind `wf-bar`,
  `wf-menu`, `wf-sheet`, `wf-card`, `wf-flow-*` und `wf-name` (Name in `WorkflowList`, statt `wf-link`). Apps mit
  eigenen Regeln für die alten Klassen passen sie an.

## [0.5.0] – 2026-11-03

### Für Nutzer

- Der Editor zeigt den Ablauf als kompakte Liste: Start, Schritte mit Nummer und Titel, eingerückte Wege für «Dann»,
  «Sonst» und «Für jeden Eintrag», Ende. Das Formular des gewählten Schritts steht rechts im Detailbereich.
- Neue Schritte lassen sich an jeder Stelle einfügen («+» zwischen den Schritten und am Anfang jedes Wegs). Die Auswahl
  zeigt konkrete Schritte mit kurzer Erklärung und Suche: Aufgabe und Genehmigung, die Aktionen der App nach Gruppe,
  Wenn / Sonst, Für jedes, Warten, Werte setzen, Beenden.
- Tastatur im Ablauf: ↓/↑ (oder J/K) wechselt den Schritt, Alt+↓/↑ verschiebt ihn, Entf entfernt ihn (mit
  Rückgängig), + fügt danach ein, Enter springt ins Formular.
- Zeitplan als Auswahl: täglich, werktags, an bestimmten Wochentagen, monatlich, stündlich, mit Uhrzeit und Zeitzone
  und den nächsten Ausführungen; der Cron-Ausdruck bleibt als Ausweg.
- Der Satz zum Auslöser steht oben; ohne eigene Frist nennt eine Aufgabe die Frist ihrer Warteschlange.
- Der Probelauf ist ein eigener Modus («Bearbeiten | Probelauf») neben dem Ablauf.
- Neue Bausteine für die Reiter eines Workflows: Versionen und Einstellungen (Name, Beschreibung, Angaben).

### Für den Betrieb

- Braucht `@vollholz/workflow` 0.5.0 (Route `schedule-preview`); ohne sie fehlen nur die nächsten Ausführungen.

### Hinzugefügt

- `VersionList` (`{ workflowId }`) und `WorkflowSettings` (`{ workflowId }`).
- `StepListEditor`: `onOpenSettings` – «Name und Beschreibung …» öffnet dann die Einstellungen der App statt des
  Dialogs.
- `useSchedulePreview(cron, timezone)`.

### Geändert

- Der Editor zeigt Schritte nicht mehr als aufgeklappte Karten, sondern im Ablauf mit Detailbereich; «Schritt
  hinzufügen» am Ende jeder Liste entfällt zugunsten von «+» an jeder Stelle. Versionen stehen nicht mehr im Editor.
- Knöpfe zum Hinzufügen in Formularen (Feld, Wert, Genehmigende, Eingabefeld) erscheinen als Link-Knöpfe.

### Behoben

- Die Meldung nach einer Aktion («Workflow pausiert.») verschwindet nach einigen Sekunden.

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
