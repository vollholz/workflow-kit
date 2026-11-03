# workflow-kit

Workflows für eigene Apps als Baukasten: Automationen (Auslöser → Bedingung → Aktionen), Fälle mit Aufgaben und
Genehmigungen, Zustandsmodelle mit erlaubten Wechseln – mit Arbeitswarteschlangen, Fristen und Protokoll. Einmal
gebaut, in Apps nur angedockt. Eine App bindet den Baukasten ein, indem sie **Ports** bereitstellt und **Komponenten**
einbindet; ohne Baukasten läuft sie unverändert weiter.

| Paket | Inhalt |
|---|---|
| [`@vollholz/workflow`](packages/workflow) | Ports, Definition (JSON-Schema, Prüfung), Ausdrücke ohne Skripte, Engine für Automationen, Migrationen (PostgreSQL, RLS), Job-Handler, Fastify-Plugin |
| [`@vollholz/workflow-web`](packages/workflow-web) | React-Provider, Daten-Hooks und Bausteine (`WorkflowList`, `StepListEditor`, `RunLog`, `SettingsPanel`, `SubjectWorkflowBar`, `MyWork`, `TaskDetail`, `QueueList`, `QueueView`, `QueueEditor`, `CalendarEditor`; später `CaseView`) |

## Stand: Stufe 2 (Aufgaben und Warteschlangen)

`@vollholz/workflow` 0.2.0 führt Automationen aus: Auslöser Ereignis (`dispatch` im Schreibpfad der App), Zeitplan
(`tick`, Cron mit Zeitzone) und manuell; Schritte Aktion, Wenn/Sonst, Für jedes, Warten, Variablen, Ende; ein Schritt je
Job und Transaktion, Protokoll je Schritt, Wiederholung und Vorfall, Schleifenschutz über die Kettentiefe, Grenzen je
Mandant, Probelauf ohne Schreiben, Opt-in je Mandant. Tabellen `workflow_*` mit RLS (Mandant und Bezug), REST-Routen für
Entwürfe, Versionen, Läufe und Vorfälle, dazu `GET /workflows/meta` für den Editor. `checkTransition` erlaubt noch
jeden Wechsel. `@vollholz/workflow-web` 0.2.0 bringt die Oberfläche dazu: Liste, Editor als Schrittliste mit Live-Prüfung
und Probelauf, Protokoll mit Vorfällen, Einstellungen, Leiste am Bezug. Danach folgen Aufgaben und Warteschlangen (2),
Fälle (3), Zustandsmodelle (4).

Stufe 2 (`@vollholz/workflow` und `-web` 0.3.0): Schritte Aufgabe und Genehmigung (erste Antwort, alle, Mehrheit,
nacheinander), Formulare serverseitig geprüft, Warteschlangen mit Nehmen, Round Robin und geringster Last, Fristen in
Arbeitszeit nach Kalender mit Feiertagen, Verzug mit Eskalation, «Meine Arbeit», Zähler für die Navigation
(Migration `workflow_002_tasks`, Job `workflow.sla`, optionaler Host-Port `teams`).

## App-agnostisch

Vorgabe: Die Pakete kennen keine App und kein App-Paket. Sie sprechen nur in neutralen Begriffen; was diese in einer
App bedeuten, legt die App fest.

| Begriff | Im Paket |
|---|---|
| Akteur | `ActorRef { id, kind: 'person' \| 'client' }` – wer handelt; ID undurchsichtig |
| Bereich | `ScopeRef { type, id }` – wo ein Workflow gilt; zum Filtern und für `can` |
| Bezug | `SubjectRef { type, id }` + Port `WorkflowSubject` – woran ein Lauf, Fall oder eine Aufgabe hängt |
| Ereignis | `WorkflowEvent` + `EventSource` – Auslöser; Typen meldet die App |
| Aktion | `WorkflowAction` – fachlicher Schritt mit Ein-/Ausgabe-Schema, `needs`, `run`, `dryRun` |
| Zustandsfeld | `StateField` – Feld mit endlicher Werteliste, Grundlage des Zustandsmodells |
| Team | `TeamRef` + `host.members` – wer zu einer Warteschlange oder Genehmigung gehört |
| Feldart | `FieldKind` – zusätzliche Feldarten für Aufgabenformulare |

`npm run boundaries` (Teil von `npm run check`) setzt die Regeln durch: `@vollholz/workflow` importiert nur `node:*`,
`fastify` und `ajv`, nie `@vollholz/*`; `@vollholz/workflow-web` importiert nur React, TanStack Query und vom Backend höchstens Typen; der Code
beider Pakete enthält keine Namen von Apps und keine Fachbegriffe einer App. Den Nachweis führt der Test
`packages/workflow/test/shop.test.ts`: eine Mini-App «shop» mit Bestellungen und Zustandsfeld, deren Host im Speicher
lebt.

## Einbindung in eine App

Backend (Fastify):

```ts
import { workflow, workflowPermissions } from '@vollholz/workflow';

const wf = workflow({
  schema: 'app',                 // Datenbank-Schema der App für die Tabellen workflow_*
  host,                          // WorkflowHost: tx, actor, active, can, canActAs?, members, audit, emit, jobs, notify?, http?, error
  subjects: [orderSubject],      // WorkflowSubject je Bezugstyp
  actions: [cancelOrder],        // WorkflowAction der App
  events: EVENT_SOURCES,         // EventSource: Ereignistypen der App
  stateFields: [orderState],     // StateField (optional)
});
await app.register(wf.plugin);   // Routen unter /v1 (Workflows, Versionen, Läufe, Vorfälle, Einstellungen)
// im Schreibpfad der App:  emit(…) → await wf.dispatch(tx, event, { tenantId })
// vor dem Schreiben eines Zustandsfelds:  await wf.checkTransition(tx, actor, subject, field, from, to, values)
// Jobs:  wf.jobs in die Job-Warteschlange der App hängen; Worker:  wf.tick(tx) jede Minute
// Migrationen:  wf.migrations({ schema, appRole, schedRole, tenantExpr, principalExpr }), danach in der App
//   SELECT <schema>.workflow_subjects('{"order": "<schema>.sales_order"}')
// Rechte:  workflowPermissions ins Rechtemodell der App übernehmen
// Einzelheiten: packages/workflow/README.md
```

Oberfläche (React):

```tsx
import { StepListEditor, SubjectWorkflowBar, WorkflowList, WorkflowProvider } from '@vollholz/workflow-web';
import '@vollholz/workflow-web/styles.css';

// Peer: @tanstack/react-query 5 (QueryClientProvider der App wird genutzt, sonst ein eigener)
<WorkflowProvider api={{ headers: () => ({ 'X-CSRF-Token': csrf }) }} me={me} can={can}
  subjects={{ order: { label: 'Bestellung', search: q => searchOrders(q), href: id => `/orders/${id}` } }}>
  <WorkflowList onOpen={id => navigate(`/workflows/${id}`)} />
  <StepListEditor workflowId={id} />
  <SubjectWorkflowBar subject={{ type: 'order', id }} />
</WorkflowProvider>
// Einzelheiten: packages/workflow-web/README.md
```

Abschalten: im Build das Paket weglassen (Hooks bleiben leer), zur Laufzeit `workflow({ …, enabled: false })`.

## Entwicklung

```bash
npm install
npm run check        # Typprüfung, Build, Tests, Tests der Skripte, Grenzen der Pakete
```

Neue Version: `version` in `packages/<paket>/package.json` erhöhen, Abschnitt in `CHANGELOG.md` schreiben, per PR
mergen. Der Workflow `release.yml` veröffentlicht jede Version, die noch nicht auf GitHub Packages liegt, mit Tag
`<paket>-v<version>` und GitHub Release.

## Release Notes

Jeder Versionsabschnitt in `packages/<paket>/CHANGELOG.md` beginnt mit `### Für Nutzer` (allgemein verständlich, ohne
Namen aus dem Code; die App übernimmt den Text unverändert) und `### Für den Betrieb` (Migrationen, Einstellungen,
Wartungsläufe), bei nichts zu sagen je `- (keine)`. Danach folgen die Rubriken nach Keep a Changelog für die Entwickler
der App. `node scripts/changelog.ts check` (CI) lässt keine Version ohne diesen Abschnitt durch. Gleiche Regeln wie im
discussion-kit.

Lizenz: Apache-2.0 (LICENSE, NOTICE).
