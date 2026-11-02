# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Überblick

npm-Workspace mit zwei Paketen, die Apps Workflows geben (Automationen, Fälle mit Aufgaben und Genehmigungen,
Zustandsmodelle, Warteschlangen):

- `packages/workflow` → `@vollholz/workflow`: Ports, Definition (JSON-Schema + Prüfung), Ausdrücke, Fastify-5-Plugin;
  ab Stufe 1 Engine, Migrationen (PostgreSQL, RLS) und Job-Handler.
- `packages/workflow-web` → `@vollholz/workflow-web`: React-19-Provider und Bausteine.

Stand: **Stufe 0** (Gerüst). Konzept: «Workflows als Baukasten» (Nr. 118) im Repository der ersten App
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
`workflow-web` nur Typen aus `@vollholz/workflow`, keine relativen Importe über die Paketgrenze, Begriffsliste `TERMS`
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

`src/ports.ts` enthält nur Typen. Die App liefert `WorkflowHost` (`actor`, `active`, `can`, `members`, `audit`, `emit`,
`jobs`, optional `notify`, `http`, und `error` als Fehlerfabrik – das Paket wirft im Request-Pfad nur über
`host.error`), Bezugstypen (`WorkflowSubject`), Aktionen (`WorkflowAction` mit `needs`, `run`, `dryRun`),
Ereignistypen (`EventSource`), Zustandsfelder (`StateField`) und Feldarten (`FieldKind`). Datenbankzugriff nur über
`Tx { query(sql, params) }`, keine Datenbank-Bibliothek im Paket.

`workflow(options)` (`src/index.ts`) prüft die Optionen beim Zusammenstecken (Fehler der Einbindung als `Error`) und
liefert `{ plugin, dispatch, checkTransition, jobs, migrations, limits, validate }`. `dispatch` und `checkTransition`
liegen im Schreibpfad der App: Sie müssen ohne aktive Workflows praktisch nichts kosten.

### Definition und Ausdrücke

`src/definition.ts`: Typen, `definitionSchema` (versioniert über `schemaVersion`) und `validateDefinition` (ajv, dann
Inhalt: eindeutige IDs, Verweise `steps.<id>`, Platzhalter, Zustände). Meldungen deutsch mit JSON-Pointer-Pfad. Eine
inkompatible Änderung am Schema braucht eine neue `schemaVersion`.

`src/expressions.ts`: strukturierte Bedingungen (`all`/`any`/`not`/`field`-`op`-`value`) und Platzhalter
`{{pfad | formatierer:arg}}` mit festen Formatierern. Nie `eval`, `Function` oder reguläre Ausdrücke aus Definitionen;
Pfade nur über eigene Eigenschaften, `__proto__`/`prototype`/`constructor` gesperrt.

### Oberfläche

`workflow-web` spricht mit dem Backend nur über HTTP. `WorkflowProvider` verlangt `api`, `me`, `can`; `subjects` und
`fields` sind optional. Kein Quellmodul importiert CSS: Der Build kopiert `src/styles.css` nach `dist`.

## TypeScript-Konventionen

`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (Typen mit `import type`) und
`erasableSyntaxOnly`, weil Node die Dateien direkt ausführt: keine `enum`, keine `namespace`, keine
Parameter-Properties. Relative Imports tragen die Endung `.ts`/`.tsx`. Der Build schreibt sie auf `.js` um
(`rewriteRelativeImportExtensions`). Neue öffentliche Exporte gehören in `src/index.ts` des Pakets.

## Tests

- `workflow/test/definition.test.ts`, `expressions.test.ts`: Schema, Meldungen, Bedingungen, Platzhalter.
- `workflow/test/shop.test.ts`: Nachweis «app-agnostisch» – Mini-App «shop» mit Host im Speicher. Gute Referenz dafür,
  wie eine App das Paket einbindet; Teil der Typprüfung.
- `workflow-web/test/components.test.tsx`: Provider und Bausteine.
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
