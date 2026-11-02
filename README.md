# workflow-kit

Workflows für eigene Apps als Baukasten: Automationen (Auslöser → Bedingung → Aktionen), Fälle mit Aufgaben und
Genehmigungen, Zustandsmodelle mit erlaubten Wechseln – mit Arbeitswarteschlangen, Fristen und Protokoll. Einmal
gebaut, in Apps nur angedockt. Eine App bindet den Baukasten ein, indem sie **Ports** bereitstellt und **Komponenten**
einbindet; ohne Baukasten läuft sie unverändert weiter.

| Paket | Inhalt |
|---|---|
| [`@vollholz/workflow`](packages/workflow) | Ports, Definition (JSON-Schema, Prüfung), Ausdrücke ohne Skripte, Fastify-Plugin; später Engine, Migrationen, Job-Handler |
| [`@vollholz/workflow-web`](packages/workflow-web) | React-Provider und Bausteine (`StepListEditor`, `MyWork`, `QueueView`, `CaseView`, `RunLog`, `SubjectWorkflowBar`) |

## Stand: Stufe 0 (Gerüst)

Ports, Definitionsschema, Ausdrücke, Rechte- und Ereignisliste stehen; eine App kann ihre Einbindung fertig bauen.
`dispatch` und `checkTransition` tun noch nichts, es gibt noch keine Tabellen, Jobs oder Routen ausser
`GET <prefix>/workflows/status`; die Bausteine der Oberfläche zeigen «noch nicht verfügbar». Engine und Datenbank
folgen ab Stufe 1 (Automation), dann Aufgaben und Warteschlangen (2), Fälle (3), Zustandsmodelle (4).

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
`fastify` und `ajv`, nie `@vollholz/*`; `@vollholz/workflow-web` importiert vom Backend höchstens Typen; der Code
beider Pakete enthält keine Namen von Apps und keine Fachbegriffe einer App. Den Nachweis führt der Test
`packages/workflow/test/shop.test.ts`: eine Mini-App «shop» mit Bestellungen und Zustandsfeld, deren Host im Speicher
lebt.

## Einbindung in eine App

Backend (Fastify):

```ts
import { workflow, workflowPermissions } from '@vollholz/workflow';

const wf = workflow({
  schema: 'app',                 // Datenbank-Schema der App für die Tabellen workflow_*
  host,                          // WorkflowHost: actor, active, can, members, audit, emit, jobs, notify?, http?, error
  subjects: [orderSubject],      // WorkflowSubject je Bezugstyp
  actions: [cancelOrder],        // WorkflowAction der App
  events: EVENT_SOURCES,         // EventSource: Ereignistypen der App
  stateFields: [orderState],     // StateField (optional)
});
await app.register(wf.plugin);   // Routen unter /v1
// im Schreibpfad der App:  emit(…) → await wf.dispatch(tx, event)
// vor dem Schreiben eines Zustandsfelds:  await wf.checkTransition(tx, actor, subject, field, from, to, values)
// Jobs:  wf.jobs in die Job-Warteschlange der App hängen; Migrationen:  wf.migrations({ schema, appRole, schedRole })
// Rechte:  workflowPermissions ins Rechtemodell der App übernehmen
```

Oberfläche (React):

```tsx
import { WorkflowProvider, MyWork } from '@vollholz/workflow-web';
import '@vollholz/workflow-web/styles.css';

<WorkflowProvider api={{ baseUrl: '/v1' }} me={me} can={can} subjects={{ order: { label: 'Bestellung' } }}>
  <MyWork />
</WorkflowProvider>
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
