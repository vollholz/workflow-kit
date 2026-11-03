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
| `WorkflowList` | Name, Art, Bereich, Zustand, letzte Läufe (ok/Fehler), Akteur; Filter; «Neu» legt einen Entwurf an (`workflow:manage`); Hinweis, wenn das Modul nicht verfügbar ist |
| `StepListEditor` | Kopf (Name, Zustand, Entwurf ↔ aktive Version, Speichern mit `If-Match` und Konfliktdialog, «Aktivieren …» mit Zusammenfassung und Akteur, Pausieren, Archivieren, Löschen eines Entwurfs); Auslöser (Ereignis mit Filter in Klartext, Zeitplan mit Beschreibung, von Hand mit Formular); Schritte als Karten (Aktion mit Formular aus dem Eingabe-Schema, Wenn/Sonst, Für jedes, Warten, Werte setzen, Beenden), verschachtelt, mit Knöpfen verschieben; Platzhalter-Auswahl mit Bezeichnungen; Meldungen der Prüfung am Schritt; Probelauf mit Bezug oder Ereignis |
| `RunLog` | Läufe mit Filter (Workflow, Bezug, Zustand) und «Weitere laden»; Lauf mit Schritten, Ein-/Ausgaben, Fehlern, Zeiten; «Nochmals versuchen», «Schritt überspringen», «Lauf abbrechen» (`workflow:operate`) |
| `SettingsPanel`, `StatusBanner` | Opt-in des Mandanten und Grenzen (`workflow:admin`), Zähler des Tages; Hinweis, wenn das Modul aus ist |
| `SubjectWorkflowBar` | Knöpfe der aktiven Workflows mit manuellem Auslöser (mit Formular), offene Aufgaben (`onOpenTask`) und letzte Läufe am Bezug; `filter(workflow)` grenzt die Knöpfe ein; nach einem Start lädt sie nach, solange der Lauf läuft (alle 2 s, höchstens 30 s) |
| `MyWork` | Reiter «Mir», «Mein Team», «Alle» mit Zählern offen/überfällig, Filter Zustand, Sortierung, nur überfällige; Tabelle mit Frist-Anzeige und Priorität; Massenaktionen (zuweisen, abbrechen) mit `task:assign`; daneben `TaskDetail`. Props `filter`, `queueId`, `taskId`/`onOpenTask` (gesteuert), `onOpenRun`, `title` |
| `TaskDetail` | Aufgabe mit Bezug, Frist, Ergebnis; Nehmen, Zurücklegen, Weitergeben (Mitglieder der Warteschlange mit offener Last, mit Recht auch andere Personen und Warteschlangen), Abbrechen; Formular und Ergebnis-Knöpfe; Genehmigung mit Stimmen, Genehmigen/Ablehnen mit Begründung. Welche Knöpfe erscheinen, sagt der Server (`actions`) |
| `QueueList`, `QueueView`, `QueueEditor` | Warteschlangen mit Zählern; Ansicht mit Kennzahlen und Aufgaben; Editor mit Team (Auswahl über `host.teams` der App, sonst Typ und ID), Zuweisung, Sortierung, Kalender, Frist, Eskalation (`queue:manage`) |
| `CalendarList`, `CalendarEditor` | Kalender mit Zeitzone, Arbeitszeiten je Wochentag («08:00-12:00, 13:00-17:00»), Feiertagen, Standard und Vorschau einer Frist (`queue:manage`) |

Daten-Hooks für eigene Ansichten: `useWorkflowStatus`, `useWorkflowMeta`, `useWorkflowSettings`,
`useSaveWorkflowSettings`, `useWorkflows`, `useWorkflowDetail`, `useCreateWorkflow`, `useSaveWorkflow`,
`useDeleteWorkflow`, `useValidateDefinition`, `useWorkflowLifecycle` (`activate`, `pause`, `archive`),
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
