# @vollholz/workflow-web

Oberfläche zu `@vollholz/workflow` (React 19, TanStack Query 5). Stand **Stufe 1** (Automation): Liste der Workflows,
Editor als Schrittliste mit Live-Prüfung und Probelauf, Protokoll mit Vorfällen, Einstellungen des Mandanten, Leiste am
Bezug. Aufgaben, Warteschlangen und Fälle (`MyWork`, `QueueView`, `CaseView`) zeigen bis zu ihrer Stufe «noch nicht
verfügbar».

## Einbinden

```tsx
import '@vollholz/workflow-web/styles.css';
import { RunLog, SettingsPanel, StepListEditor, SubjectWorkflowBar, WorkflowList, WorkflowProvider } from '@vollholz/workflow-web';

<WorkflowProvider
  api={{ headers: () => ({ 'X-CSRF-Token': csrf }), onUnauthorized: () => login() }}   // gleiche Herkunft, Präfix /v1
  me={{ id: me.id, kind: 'person', label: me.name }}
  can={perm => rights.includes(perm)}                       // workflow:read, :manage, :activate, :run, :operate, :admin
  subjects={{ order: { label: 'Bestellung', search: q => searchOrders(q), href: id => `/orders/${id}` } }}
  actors={{ label: a => names.get(a.id), clients: () => myClients() }}
  scopeLabel={s => scopeNames.get(`${s.type}:${s.id}`) ?? s.id}
>
  <WorkflowList onOpen={id => navigate(`/workflows/${id}`)} scope={{ type: 'tenant', id: '*' }} />
  <StepListEditor workflowId={id} onShowRuns={id => navigate(`/workflows/${id}/runs`)} onDeleted={() => navigate('/workflows')} />
  <RunLog workflowId={id} onOpenWorkflow={id => navigate(`/workflows/${id}`)} />
  <SettingsPanel />
  <SubjectWorkflowBar subject={{ type: 'order', id }} onOpenRun={runId => navigate(`/runs/${runId}`)} />
</WorkflowProvider>
```

Liegt bereits ein `QueryClientProvider` der App aussen herum, nutzen die Bausteine dessen Zwischenspeicher; sonst legt
der Provider einen eigenen an (oder nimmt `queryClient`).

## Provider

| Angabe | Pflicht | Zweck |
|---|---|---|
| `api` | ja | `{ baseUrl?, fetch?, headers?, onUnauthorized? }` – Herkunft (Standard: gleiche wie die Seite), eigener fetch der App, Header je Anfrage, Antwort 401 |
| `me` | ja | `{ id, kind: 'person' \| 'client', label? }` oder `null` |
| `can` | ja | Recht auf Ebene des Mandanten; blendet Knöpfe aus (der Server prüft jede Anfrage selbst) |
| `prefix` | | Präfix der Routen wie im Backend (Standard `/v1`) |
| `subjects` | | je Bezugstyp `label`, `search(q)` (Probelauf), `href(id)` oder `onOpen(id)` |
| `fields` | | Feldarten der App für Formulare (`{ label, Input }`) |
| `actors` | | `label(actor)` für Namen; `clients()` für die Wahl eines Maschinen-Clients beim Aktivieren (nur mit `canActAs` im Backend) |
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
| `SubjectWorkflowBar` | Knöpfe der aktiven Workflows mit manuellem Auslöser (mit Formular) und letzte Läufe am Bezug; `filter(workflow)` grenzt die Knöpfe ein |

Daten-Hooks für eigene Ansichten: `useWorkflowStatus`, `useWorkflowMeta`, `useWorkflowSettings`,
`useSaveWorkflowSettings`, `useWorkflows`, `useWorkflowDetail`, `useCreateWorkflow`, `useSaveWorkflow`,
`useDeleteWorkflow`, `useValidateDefinition`, `useWorkflowLifecycle` (`activate`, `pause`, `archive`),
`useWorkflowVersions`, `useWorkflowVersion`, `useStartRun`, `useDryRun`, `useRuns` (Cursor), `useRun`,
`useIncidentAction`; Schlüssel `wfKeys`, Anfrage `wfRequest`, Fehler `WorkflowApiError` (`conflict`,
`moduleDisabled`). Typen der Antworten (`WorkflowSummary`, `WorkflowDetail`, `RunJson` …) beschreiben das JSON der
Routen; das Paket importiert nichts aus dem Backend.

Der Editor braucht die Route `GET /workflows/meta` (ab `@vollholz/workflow` 0.2.0). Die nächsten Ausführungen eines
Zeitplans berechnet der Server; die Oberfläche beschreibt einfache Cron-Muster in Worten.

## Aussehen

Farben über die Tokens der App (`--surface`, `--line`, `--accent`, `--ok`, `--warn`, `--bad` …) oder die
`--wf-*`-Variablen; Klassen mit Präfix `wf-`. Texte deutsch in Du-Form, ohne Fachbegriffe einer App: Bezeichnungen
kommen aus `subjects` und aus `/workflows/meta`.

Lizenz: Apache-2.0.
