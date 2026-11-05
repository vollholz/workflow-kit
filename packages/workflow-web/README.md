# @vollholz/workflow-web

Oberfläche zu `@vollholz/workflow` (React 19, TanStack Query 5). Stand **Stufe 2**: Liste der Workflows,
Editor als Schrittliste mit Live-Prüfung und Probelauf (auch Aufgabe und Genehmigung), Protokoll mit Vorfällen,
Einstellungen des Mandanten, Leiste am Bezug mit offenen Aufgaben; «Meine Arbeit» mit Aufgaben-Detail, Genehmigen und
Ablehnen, Warteschlangen (Liste, Ansicht, Editor), Kalender (Liste, Editor) und Zähler für die Navigation. Fälle
(`CaseView`) zeigen bis Stufe 3 «noch nicht verfügbar». Braucht `@vollholz/workflow` 0.3.0 (auch für 0.3.1).

## Einbinden

```tsx
import '@vollholz/workflow-web/styles.css';
import { RunLog, SettingsPanel, StepListEditor, SubjectWorkflowBar, WorkflowList, WorkflowProvider } from '@vollholz/workflow-web';

<WorkflowProvider
  api={{ headers: () => ({ 'X-CSRF-Token': csrf }), onUnauthorized: () => login() }}   // gleiche Herkunft, Präfix /v1
  me={{ id: me.id, kind: 'person', label: me.name }}
  can={perm => rights.includes(perm)}                       // workflow:read, :manage, :activate, :run, :operate, :admin
  subjects={{ order: { label: 'Bestellung', search: q => searchOrders(q), href: id => `/orders/${id}`, Title: OrderTitle } }}
  actors={{ label: a => names.get(a.id), Name: PersonName, search: q => searchPeople(q), clients: () => myClients() }}
  scopeLabel={s => scopeNames.get(`${s.type}:${s.id}`) ?? s.id}
>
  <WorkflowList onOpen={id => navigate(`/workflows/${id}`)} scope={{ type: 'tenant', id: '*' }} />
  <StepListEditor workflowId={id} onShowRuns={id => navigate(`/workflows/${id}/runs`)} onDeleted={() => navigate('/workflows')} />
  <RunLog workflowId={id} onOpenWorkflow={id => navigate(`/workflows/${id}`)} />
  <SettingsPanel />
  <SubjectWorkflowBar subject={{ type: 'order', id }} onOpenRun={runId => navigate(`/runs/${runId}`)} onOpenTask={t => navigate(`/work?task=${t}`)} />
  <MyWork taskId={taskId} onOpenTask={t => navigate(t ? `/work?task=${t}` : '/work')} onOpenRun={runId => navigate(`/runs/${runId}`)} />
  <QueueList onOpen={q => navigate(`/queues/${q}`)} onEdit={q => navigate(`/queues/${q ?? 'neu'}/edit`)} />
  <QueueView queueId={queueId} />   <QueueEditor queueId={queueId} />   <CalendarList onEdit={…} />   <CalendarEditor calendarId={…} />
</WorkflowProvider>
```

`PersonName` und `OrderTitle` sind gewöhnliche Komponenten der App (`({ actor }) => …`, `({ id }) => …`) und dürfen
eigene Hooks nutzen; die Bausteine zeigen sie über `ActorName` und `SubjectTitle`, die auch die App selbst verwenden
kann.

Liegt bereits ein `QueryClientProvider` der App aussen herum, nutzen die Bausteine dessen Zwischenspeicher; sonst legt
der Provider einen eigenen an (oder nimmt `queryClient`).

## Provider

| Angabe | Pflicht | Zweck |
|---|---|---|
| `api` | ja | `{ baseUrl?, fetch?, headers?, onUnauthorized? }` – Herkunft (Standard: gleiche wie die Seite), eigener fetch der App, Header je Anfrage, Antwort 401 |
| `me` | ja | `{ id, kind: 'person' \| 'client', label? }` oder `null` |
| `can` | ja | Recht auf Ebene des Mandanten; blendet Knöpfe aus (der Server prüft jede Anfrage selbst) |
| `prefix` | | Präfix der Routen wie im Backend (Standard `/v1`) |
| `subjects` | | je Bezugstyp `label`, `search(q)` (Probelauf), `href(id)` oder `onOpen(id)`; `Title` (Baustein `{ id }`) zeigt den Titel eines Bezugs mit Hooks der App, sonst der Titel aus der API, sonst Bezeichnung und ID |
| `fields` | | Feldarten der App für Formulare (`{ label, Input }`) |
| `actors` | | `Name` (Baustein `{ actor }`) zeigt Namen mit Hooks der App, z. B. Person nachladen – überall, wo Akteure erscheinen; `label(actor)` liefert Namen als Text (synchron, für Auswahllisten, `title`; ohne `Name` auch für die Anzeige); `clients()` für die Wahl eines Maschinen-Clients beim Aktivieren (nur mit `canActAs` im Backend); `search(q)` für Personen beim Weitergeben einer Aufgabe und im Editor (Zuständig, Genehmigende; sonst Mitglieder der Warteschlange oder ID) |
| `scopeLabel` | | Bezeichnung eines Bereichs |
| `components` | | eigene `Button`, `Input`, `Select`, `Textarea`, `Dialog`, `Loading`, `ErrorBox`, `Empty` (müssen `id`, `aria-*`, `ref`, `disabled` weiterreichen) |
| `queryClient` | | eigener QueryClient |

## Bausteine

| Baustein | Inhalt |
|---|---|
| `WorkflowList` | Name mit dem Workflow als Satz (Auslöser, Zahl der Schritte), Art, Bereich, Zustand (Aktiv / Inaktiv / Archiviert) mit dem Marker «Entwurf» (führt zum Workflow) und offenen Vorfällen, letzter Run mit Datum und Zeit (`onOpenRun`) und sein Zustand; schmal nur Name, Zustand und Zustand des Runs; Filter über der Tabelle; «Neu» legt einen Entwurf an, leer oder aus einer Vorlage (`templates` der App, dazu `builtinTemplates`; `workflow:manage`; mit `showCreate={false}` stattdessen `NewWorkflowButton` in der Leiste der App); Hinweis, wenn das Modul nicht verfügbar ist |
| `WorkflowActions`, `WorkflowDraftMark`, `NewWorkflowButton` | Teile für eine Leiste der App (Kopf «Kontextleiste»): Zustand und Menü eines Workflows ausserhalb des Editors (`items` der App zuoberst, dann Aktivieren derselben Fassung, Verwerfen, Deaktivieren, Archivieren, Löschen; kein Aktivieren des Entwurfs), Marker «Entwurf» neben dem Namen (`onOpen` führt zum Editor), «Neu» mit Vorlagen. Im Editor füllt `StepListEditor` die Plätze selbst (`slots`, `menuItems`, `requireProbe`), in einem Run `RunView` (`slots`) |
| `StepListEditor` | Ablauf links, Schritt für Schritt aufgebaut (leer nur «Ersten Schritt hinzufügen», dann Auslöser, Schritte als Karten, Wege nebeneinander, «+» an jeder Stelle, Tastatur) mit Detailbereich rechts (Auslöser, Formular des Schritts, Probelauf als Modus); Auswahl neuer Schritte als Seitenleiste mit Gruppen, «Zurück» und Suche; Wege nach Ergebnis bei Aufgabe und Genehmigung; Probelauf auf den Karten mit wählbarem Ergebnis; «Änderungen ansehen»; Aktivieren-Dialog mit Änderungen und Stand des Probelaufs; Kopf nur mit `showTitle` (Name, Beschreibung); Leiste mit Zustand (ohne Versionsnummer) und Marker «Entwurf», Speicherstand, Zahl der Fehler und der Hinweise (springt zur Stelle), «Bearbeiten \| Probelauf» und einer Hauptaktion je Zustand («Aktivieren …», «Entwurf aktivieren …», «Aktivieren» nach dem Deaktivieren; bei offenem Vorfall «Vorfall ansehen» mit `onOpenRun` bzw. `onShowRuns`), Seltenes im Menü «Weitere Aktionen» (Verwerfen, Deaktivieren, Archivieren, Löschen, Name und Beschreibung, Runs, Tastenkürzel); mit `slots` stehen Zustand, Hauptaktion und Menü (mit `menuItems` der App) in der Leiste der App und «Entwurf» neben dem Namen; mit `requireProbe` gibt es Aktivieren erst nach einem erfolgreichen Probelauf mit diesem Entwurf; Tastenkürzel `P` (Bearbeiten ↔ Probelauf), `Ctrl`+`D` (duplizieren), `Ctrl`+`Z`/`Ctrl`+`Y` (rückgängig, wiederholen); Entwurf speichert sich selbst (`saveDelayMs`, `If-Match`, Konfliktdialog, Nachfrage beim Verlassen); Entfernen mit Rückgängig; Auslöser (Ereignis mit Filter in Klartext, Zeitplan mit Beschreibung, von Hand mit Formular); Schritte als Karten (Aktion mit Formular aus dem Eingabe-Schema, Wenn/Sonst, Für jedes, Warten, Werte setzen, Beenden), verschachtelt, mit Knöpfen verschieben; Daten als Chips mit Bezeichnung (`{` oder «Daten», nur was an der Stelle feststeht); Meldungen der Prüfung am Schritt; Probelauf mit Bezug oder Ereignis |
| `RunLog` | Runs mit Filter (Workflow, Bezug, Zustand; `state` als Anfangswert) und «Weitere laden»; ein Run öffnet sich als `RunView` an Stelle der Liste oder mit `onOpenRun` auf einer Seite der App |
| `RunView` | Run als Ablauf: derselbe Ablauf wie im Editor mit dem genommenen Weg, Zeiten und Namen; Schritt, an dem der Run steht, hervorgehoben; Vorfall am Schritt mit «Nochmals versuchen» und «Schritt überspringen», «Run abbrechen» im Menü (`workflow:operate`); daneben Angaben zum gewählten Schritt (Versuche, wer erledigt hat, Protokoll, Ein-/Ausgaben); lädt nach, solange der Run nicht beendet ist; mit `slots` Zustand und Menü in der Leiste der App (eigene Ebene, ohne Titel und «Zurück zur Liste») |
| `VersionList` | Aktivierte Versionen (die einzige Stelle mit Versionsnummern), darüber der Entwurf mit noch nicht wirksamen Änderungen (`onOpenDraft`); je Version Vergleich (mit der vorherigen, einer anderen oder dem Entwurf), Ablauf zum Ansehen und «Als Entwurf übernehmen …» (`workflow:manage`, `onAdopted`) |
| `SettingsPanel`, `StatusBanner` | Opt-in des Mandanten und Grenzen (`workflow:admin`), Zähler des Tages; Hinweis, wenn das Modul aus ist |
| `SubjectWorkflowBar` | Knöpfe der aktiven Workflows mit manuellem Auslöser (mit Formular), offene Aufgaben (`onOpenTask`) und letzte Läufe am Bezug; `filter(workflow)` grenzt die Knöpfe ein; nach einem Start lädt sie nach, solange der Lauf läuft (alle 2 s, höchstens 30 s) |
| `MyWork` | Reiter «Mir», «Mein Team», «Alle» mit Zählern offen/überfällig, Filter Zustand, Sortierung, nur überfällige; Tabelle mit Frist-Anzeige und Priorität; Massenaktionen (zuweisen, abbrechen) mit `task:assign`; daneben `TaskDetail`. Props `filter`, `queueId`, `taskId`/`onOpenTask` (gesteuert), `onOpenRun`, `title` |
| `TaskDetail` | Aufgabe mit Bezug, Frist, Ergebnis; Nehmen, Zurücklegen, Weitergeben (Mitglieder der Warteschlange mit offener Last, mit Recht auch andere Personen und Warteschlangen), Abbrechen; Formular und Ergebnis-Knöpfe; Genehmigung mit Stimmen, Genehmigen/Ablehnen mit Begründung. Welche Knöpfe erscheinen, sagt der Server (`actions`) |
| `QueueList`, `QueueView`, `QueueEditor` | Warteschlangen mit Zählern; Ansicht mit Kennzahlen und Aufgaben; Editor mit Team (Auswahl über `host.teams` der App, sonst Typ und ID), Zuweisung, Sortierung, Kalender, Frist, Eskalation (`queue:manage`) |
| `CalendarList`, `CalendarEditor` | Kalender mit Zeitzone, Arbeitszeiten je Wochentag («08:00-12:00, 13:00-17:00»), Feiertagen, Standard und Vorschau einer Frist (`queue:manage`) |

Daten-Hooks für eigene Ansichten: `useWorkflowStatus`, `useWorkflowMeta`, `useWorkflowSettings`,
`useSaveWorkflowSettings`, `useWorkflows`, `useWorkflowDetail`, `useCreateWorkflow`, `useSaveWorkflow`,
`useDeleteWorkflow`, `useValidateDefinition`, `useWorkflowLifecycle` (`activate`, `pause`, `resume`, `archive`),
`useWorkflowVersions`, `useWorkflowVersion`, `useStartRun`, `useDryRun`, `useRuns` (Cursor), `useRun`,
`useIncidentAction`; Stufe 2: `useTasks`, `useTask`, `useTaskAction`, `useBulkTasks`, `useTaskCounts` (Zähler für
die Navigation der App: `{ mine: { open, overdue }, team: { open, overdue, unassigned } }`, fragt erst bei verfügbarem
Modul, Standard alle 60 s), `useQueues`, `useQueue`, `useQueueMembers`, `useSaveQueue`, `useDeleteQueue`, `useTeams`,
`useCalendars`, `useCalendar`, `useSaveCalendar`, `useDeleteCalendar`, `useCalendarPreview`; Schlüssel `wfKeys`, Anfrage `wfRequest`, Fehler `WorkflowApiError` (`conflict`,
`moduleDisabled`). Typen der Antworten (`WorkflowSummary`, `WorkflowDetail`, `RunJson` …) beschreiben das JSON der
Routen; das Paket importiert nichts aus dem Backend.

Der Editor braucht die Route `GET /workflows/meta` (ab `@vollholz/workflow` 0.2.0). Die nächsten Ausführungen eines
Zeitplans berechnet der Server; die Oberfläche beschreibt einfache Cron-Muster in Worten.

## Aussehen

Farben über die Tokens der App (`--surface`, `--line`, `--accent`, `--ok`, `--warn`, `--bad` …) oder die
`--wf-*`-Variablen; Klassen mit Präfix `wf-`. Texte deutsch in Du-Form, ohne Fachbegriffe einer App: Bezeichnungen
kommen aus `subjects` und aus `/workflows/meta`.

Lizenz: Apache-2.0.
