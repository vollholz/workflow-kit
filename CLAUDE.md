# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Überblick

npm-Workspace mit zwei Paketen, die Apps Workflows geben (Automationen, Fälle mit Aufgaben und Genehmigungen,
Zustandsmodelle, Warteschlangen):

- `packages/workflow` → `@vollholz/workflow`: Ports, Definition (JSON-Schema + Prüfung), Ausdrücke, Engine für
  Automationen, Migrationen (PostgreSQL, RLS), Job-Handler, Fastify-5-Plugin mit REST-Routen.
- `packages/workflow-web` → `@vollholz/workflow-web`: React-19-Provider, Daten-Hooks (TanStack Query) und Bausteine.

Stand: **0.5.0** (Editor nach dem UX-Neukonzept, Etappe 2: Ablauf mit Detailbereich in `flow.tsx`, Einfügen an jeder
Stelle, Zeitplan als Auswahl mit `schedule-preview`, `VersionList`, `WorkflowSettings`; Etappe 1 in 0.4.0: Statusleiste,
Entwurf speichert sich selbst, `resume`, Auswahl «Zuständig» mit Suche; Konzept `docs/konzepte/workflow-editor-ux.md` im Repository der ersten App) auf
**Stufe 2** (Aufgaben und Warteschlangen, 0.3.0: `tasks.ts`, `task-routes.ts`, `calendar.ts`, `forms.ts`,
Migration `workflow_002_tasks.sql`, Job `workflow.sla`; Oberfläche `tasks.tsx`, `queues.tsx`, `calendars.tsx`,
`assignee.tsx`) auf **Stufe 1** (Automation) im Backend (`@vollholz/workflow` 0.2.0): Engine, Migration `workflow_001_core.sql`,
Jobs `workflow.step`/`workflow.start`, `tick`, Routen (mit `GET /workflows/meta` für den Editor). `workflow-web` 0.2.0
setzt die Oberfläche der Stufe 1 um (Liste, Editor, Protokoll, Einstellungen, Leiste am Bezug);
`checkTransition` erlaubt jeden Wechsel (Stufe 4). Konzept: «Workflows als Baukasten» (Nr. 118) im Repository der ersten App
(`docs/konzepte/workflow-baukasten.md`); Abschnitte 6a (Schnitt Paket ↔ App), 8.2 (Ports), 13 (Stufen) sind massgebend.

Sprache im ganzen Repo ist Deutsch in Schweizer Rechtschreibung («ss» statt «ß», Anführungszeichen «»): Kommentare,
Fehlermeldungen, Texte der API, README, CHANGELOG und Commit-Messages. Jede Quelldatei beginnt mit einem Doc-Kommentar,
der Zweck und Regeln des Moduls beschreibt.

## Harte Regel: app-agnostisch

Die Pakete kennen keine App und kein App-Paket (Vorgabe des Users). Keine Abhängigkeit auf `@vollholz/*` ausser den
eigenen Paketen, keine Adapter für eine bestimmte App, keine Fachbegriffe einer App in Code, Schema oder Texten der
Oberfläche. Nur neutrale Begriffe: Akteur (`ActorRef`), Bereich (`ScopeRef`), Bezug (`SubjectRef`, `WorkflowSubject`),
Ereignis, Aktion (`WorkflowAction`), Zustandsfeld (`StateField`), Team (`TeamRef`), Feldart (`FieldKind`). Alles
Fachliche kommt über Ports und Registrierungen; Adapter entstehen auf der Seite der App.

`scripts/boundaries.ts` (`npm run boundaries`, Teil von `npm run check`) prüft das: erlaubte Importe je Paket,
`workflow-web` nur `react`, `react-dom`, `@tanstack/react-query` und Typen aus `@vollholz/workflow`, keine relativen Importe über die Paketgrenze, Begriffsliste `TERMS`
in `src`. Neue Abhängigkeit → Regel in `ALLOWED` bewusst erweitern, nie die Begriffsliste aufweichen.

## Befehle

Node ≥ 24 (`.nvmrc`). Node führt `.ts` direkt aus (Type Stripping): Build-Skripte, Tests und `scripts/` laufen ohne
Bundler.

```bash
npm install
npm run check               # Typprüfung, Build, Tests beider Pakete, Tests der Skripte, Grenzen (wie CI)
npm run typecheck | build | test | test:scripts | boundaries
```

Einzelne Tests:

```bash
# Backend (node:test)
node --test packages/workflow/test/definition.test.ts
node --test --test-name-pattern="Formatierer" packages/workflow/test/expressions.test.ts

# Oberfläche (Vitest, jsdom)
npm test -w @vollholz/workflow-web -- test/components.test.tsx -t "Provider"

# Release-Notes-Prüfung (läuft in CI)
node scripts/changelog.ts check --base origin/main
```

## Architektur

### Ports statt Abhängigkeiten

`src/ports.ts` enthält nur Typen. Die App liefert `WorkflowHost` (`tx`, `actor`, `active`, `can`, `members`, `audit`,
`emit`, `jobs`, optional `canActAs`, `notify`, `http`, und `error` als Fehlerfabrik – das Paket wirft im Request-Pfad nur
über `host.error`), Bezugstypen (`WorkflowSubject`), Aktionen (`WorkflowAction` mit `needs`, `run`, `dryRun`),
Ereignistypen (`EventSource`), Zustandsfelder (`StateField`) und Feldarten (`FieldKind`). Datenbankzugriff nur über
`Tx { query(sql, params) }`, keine Datenbank-Bibliothek im Paket.

`workflow(options)` (`src/index.ts`) prüft die Optionen beim Zusammenstecken (Fehler der Einbindung als `Error`) und
liefert `{ plugin, dispatch, checkTransition, jobs, tick, invalidateTriggers, migrations, limits, validate }`.
`dispatch` und `checkTransition` liegen im Schreibpfad der App: Sie müssen ohne aktive Workflows praktisch nichts
kosten (`dispatch` ohne Treffer im Zwischenspeicher: keine Abfrage, Test in `shop.test.ts`).

### Engine, Datenbank, Routen

- `src/engine.ts`: `dispatch` (Zwischenspeicher der Auslöser je Mandant, Zähler `workflow_settings.version`), Läufe
  anlegen (Grenzen, Kettentiefe), ein Schritt je Job und Transaktion (Aktion im Savepoint, Rechte über `needs`),
  Fehler/Wiederholung/Vorfall, `tick`, Probelauf (Savepoint, zurückgerollt). Die Engine liest an der Lesesicht vorbei
  (`workflow.engine = on`, lokal, danach zurückgesetzt); Ereignisse an derselben `tx` während einer Aktion gelten als
  Ereignisse aus dem Lauf (Schleifenschutz).
- `src/cursor.ts`: Position eines Laufs als Ausführungspfad (`/steps/1/items/3/steps/0`), rein und einzeln getestet.
- `src/cron.ts`: Cron (fünf Felder, Zeitzone über `Intl`, Sommerzeit) und Dauern (ISO 8601, `BD`).
- `migrations/workflow_NNN_*.sql` + `src/migrations.ts`: Platzhalter `{{schema}}`, `{{app}}`, `{{sched}}`, `{{tenant}}`,
  `{{principal}}`; idempotent; jede Tabelle RLS `ENABLE` + `FORCE`; Lesesicht der Läufe über
  `<schema>.workflow_subjects(jsonb)`. Neue Migration = neue Datei, bestehende nie ändern, sobald veröffentlicht.
- `src/routes.ts`: REST-Routen (JSON-Schema, deutsche Fehler über `host.error`, Rechte über `host.can`, Audit).

### Definition und Ausdrücke

`src/definition.ts`: Typen, `definitionSchema` (versioniert über `schemaVersion`) und `validateDefinition` (ajv, dann
Inhalt: eindeutige IDs, Verweise `steps.<id>`, Platzhalter, Zustände). Meldungen deutsch mit JSON-Pointer-Pfad. Eine
inkompatible Änderung am Schema braucht eine neue `schemaVersion`.

`src/expressions.ts`: strukturierte Bedingungen (`all`/`any`/`not`/`field`-`op`-`value`) und Platzhalter
`{{pfad | formatierer:arg}}` mit festen Formatierern. Nie `eval`, `Function` oder reguläre Ausdrücke aus Definitionen;
Pfade nur über eigene Eigenschaften, `__proto__`/`prototype`/`constructor` gesperrt.

### Oberfläche

`workflow-web` spricht mit dem Backend nur über HTTP; die Typen in `src/types.ts` beschreiben das JSON der Routen (kein
Import aus dem Backend nötig). `WorkflowProvider` verlangt `api`, `me`, `can`; optional `prefix`, `subjects` (mit
`search`), `fields`, `actors`, `scopeLabel`, `components` (ersetzbare Grundbausteine), `queryClient`. Daten über
TanStack Query (`src/api.ts`, Peer; ohne QueryClient der App ein eigener). Aufbau: `editor.tsx` (Kopf, Aktivieren,
Probelauf), `steps.tsx` (Schrittkarten), `trigger.tsx`, `conditions.tsx`, `placeholders.tsx` (Kontext mit
Bezeichnungen), `forms.tsx` (Formular aus JSON-Schema bzw. `FieldDef`), `WorkflowList.tsx`, `RunLog.tsx`,
`SettingsPanel.tsx`, `SubjectWorkflowBar.tsx`. Texte in Du-Form; die Begriffsliste `TERMS` gilt auch hier (z. B. kein
«Einheit», kein `credentials`, keine `*HTMLAttributes`-Typen – `ComponentPropsWithRef` nehmen). Kein Quellmodul
importiert CSS: Der Build kopiert `src/styles.css` nach `dist`.

## TypeScript-Konventionen

`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (Typen mit `import type`) und
`erasableSyntaxOnly`, weil Node die Dateien direkt ausführt: keine `enum`, keine `namespace`, keine
Parameter-Properties. Relative Imports tragen die Endung `.ts`/`.tsx`. Der Build schreibt sie auf `.js` um
(`rewriteRelativeImportExtensions`). Neue öffentliche Exporte gehören in `src/index.ts` des Pakets.

## Tests

- `workflow/test/definition.test.ts`, `expressions.test.ts`: Schema, Meldungen, Bedingungen, Platzhalter.
- `workflow/test/shop.test.ts`: Nachweis «app-agnostisch» – Mini-App «shop» mit Host im Speicher. Gute Referenz dafür,
  wie eine App das Paket einbindet; Teil der Typprüfung. Misst auch `dispatch` ohne Treffer.
- `workflow/test/cron.test.ts`, `engine.test.ts`: Cron und Sommerzeit, Schrittauflösung, Grenzen, Schleifenschutz.
- `workflow/test/integration.test.ts`: «shop» gegen PostgreSQL (Migrationen, RLS, Ereignis → Lauf → Aktion, Vorfälle,
  Schleife, Probelauf, Zeitplan, manueller Start, Opt-in). Braucht `TEST_POSTGRES_URL` (Superuser), sonst sichtbar
  übersprungen; lokal z. B. `docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17` und
  `TEST_POSTGRES_URL=postgres://postgres:test@localhost:55432/postgres npm test -w @vollholz/workflow`. CI startet
  PostgreSQL als Service.
- `workflow-web/test/*.test.tsx` (Vitest, jsdom, `mockFetch` in `test/utils.tsx`): Provider (`components`), Liste
  (`list`), Editor (`editor`: Schema-Formular, Wenn/Sonst, Prüfung, Konflikt, Aktivieren, Probelauf), Protokoll,
  Einstellungen und Leiste am Bezug (`runs`).
- `scripts/*.test.ts`: Release-Notes-Prüfung und Grenzen.

## Versionen und Release

Neue Version eines Pakets:

1. `version` in `packages/<paket>/package.json` erhöhen (SemVer, Breaking = Major; vor 1.0.0 Breaking = Minor). Bei
   `@vollholz/workflow` auch `WORKFLOW_PACKAGE_VERSION` in `src/index.ts` (Test prüft Gleichheit).
2. In `packages/<paket>/CHANGELOG.md` einen Abschnitt `## [x.y.z] – JJJJ-MM-TT` unter `## [Unveröffentlicht]` anlegen.
   Er beginnt mit `### Für Nutzer` und `### Für den Betrieb`, bei nichts zu sagen je `- (keine)`. Danach folgen die
   Rubriken nach Keep a Changelog. Regeln: README, Abschnitt «Release Notes».
3. Per PR mergen.

CI (`scripts/changelog.ts check`) lässt keine Version ohne Abschnitt und ohne die beiden Unterabschnitte durch und
keine kleinere als auf der Basis. `release.yml` veröffentlicht nach dem Merge jede Version, die noch nicht auf GitHub
Packages liegt, mit Tag `<paket>-v<version>` und GitHub Release. Commit-Messages folgen dem Muster
`<paket> <version>: <was sich ändert>`.
