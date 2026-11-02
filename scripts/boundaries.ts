/**
 * Grenzen der Pakete (Vorgabe: app-agnostisch, Konzept Abschnitt 6a). Prüft alle Quelldateien der Pakete:
 *
 * - `packages/workflow/src`: nur relative Importe innerhalb von `src`, `node:*`, `fastify` und `ajv`. Kein
 *   `@vollholz/*`, kein App-Paket.
 * - `packages/workflow-web/src`: nur relative Importe innerhalb von `src`, `react`, `react-dom` und
 *   `@tanstack/react-query` (Peer, wie bei den übrigen Oberflächen-Paketen); vom Backend-Paket `@vollholz/workflow`
 *   höchstens Typen (`import type`), nie dessen Laufzeit.
 * - Tests und Skripte der Pakete: kein `@vollholz/*` ausser den Paketen dieses Repos, kein Import aus einem anderen
 *   Paket über relative Pfade.
 * - `src` beider Pakete: keine Namen von Apps oder App-Paketen und keine Fachbegriffe einer App (Liste `TERMS`).
 *
 *   node scripts/boundaries.ts      Exit 0 ok, 1 Befund
 *
 * Gleichwertig zu einer dependency-cruiser-Regel, aber ohne weitere Abhängigkeit und mit Prüfung der Begriffe.
 * Importe werden mit dem TypeScript-Parser gelesen (auch `export … from`, `import()` und `require()`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dirname, '..');

export interface ImportRef { spec: string; typeOnly: boolean; line: number }
export interface Finding { file: string; line: number; message: string }

/** Begriffe, die im Code der Pakete nicht vorkommen dürfen (Gross-/Kleinschreibung egal). */
export const TERMS: { pattern: RegExp; label: string }[] = [
  { pattern: /@vollholz\/(?!workflow(?:-web)?\b)[a-z-]+/i, label: 'App-Paket @vollholz/*' },
  { pattern: /\bassets\b/i, label: 'App «Assets»' },
  { pattern: /\biam\b/i, label: 'iam' },
  { pattern: /discussion/i, label: 'discussion' },
  { pattern: /objekt/i, label: 'Objekt' },
  { pattern: /attribut/i, label: 'Attribut' },
  { pattern: /status_def|statusmodell|statuswert/i, label: 'Status-Begriff einer App' },
  { pattern: /einheit/i, label: 'Einheit' },
  { pattern: /credential/i, label: 'Credential' },
  { pattern: /konnektor|connector/i, label: 'Konnektor' },
];

const ALLOWED: Record<string, (spec: string, typeOnly: boolean) => string | null> = {
  workflow: (spec) => {
    if (spec.startsWith('node:') || spec === 'fastify' || spec === 'ajv') return null;
    if (spec.startsWith('@vollholz/')) return `«${spec}»: @vollholz/workflow darf kein Paket @vollholz/* importieren`;
    return `«${spec}»: nicht erlaubte Abhängigkeit (erlaubt: node:*, fastify, ajv)`;
  },
  'workflow-web': (spec, typeOnly) => {
    if (spec === 'react' || spec.startsWith('react/') || spec === 'react-dom' || spec.startsWith('react-dom/')) return null;
    if (spec === '@tanstack/react-query') return null;
    if (spec === '@vollholz/workflow') return typeOnly ? null : '«@vollholz/workflow»: nur Typen erlaubt (import type), nie die Laufzeit des Backends';
    if (spec.startsWith('@vollholz/')) return `«${spec}»: @vollholz/workflow-web darf kein anderes Paket @vollholz/* importieren`;
    return `«${spec}»: nicht erlaubte Abhängigkeit (erlaubt: react, react-dom, @tanstack/react-query, Typen aus @vollholz/workflow)`;
  },
};

/** Importe einer Quelldatei mit Angabe, ob nur Typen geholt werden. */
export function importsOf(fileName: string, source: string): ImportRef[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: ImportRef[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings)
        && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every(e => e.isTypeOnly)));
      out.push({ spec: n.moduleSpecifier.text, typeOnly, line: line(n) });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const typeOnly = n.isTypeOnly || (!!n.exportClause && ts.isNamedExports(n.exportClause)
        && n.exportClause.elements.length > 0 && n.exportClause.elements.every(e => e.isTypeOnly));
      out.push({ spec: n.moduleSpecifier.text, typeOnly, line: line(n) });
    } else if (ts.isCallExpression(n) && n.arguments.length && ts.isStringLiteralLike(n.arguments[0]!)
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      out.push({ spec: n.arguments[0].text, typeOnly: false, line: line(n) });
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push({ spec: n.argument.literal.text, typeOnly: true, line: line(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Befunde zu einer Datei. `pkg` ist der Ordnername unter `packages/`, `area` der Teil (`src`, `test`, `scripts`),
 * `file` der absolute Pfad.
 */
export function checkFile(pkg: string, area: string, file: string, source: string): Finding[] {
  const found: Finding[] = [];
  const rel = relative(root, file).replaceAll(sep, '/');
  const pkgDir = join(root, 'packages', pkg);
  const own = area === 'src' ? join(pkgDir, 'src') : pkgDir;
  for (const imp of importsOf(file, source)) {
    if (imp.spec.startsWith('.')) {
      const target = resolve(dirname(file), imp.spec);
      if (target !== own && !target.startsWith(own + sep)) {
        found.push({ file: rel, line: imp.line, message: `«${imp.spec}» zeigt aus ${area === 'src' ? `packages/${pkg}/src` : `packages/${pkg}`} hinaus` });
      }
      continue;
    }
    if (area === 'src') {
      const rule = ALLOWED[pkg];
      const problem = rule ? rule(imp.spec, imp.typeOnly) : `Paket «${pkg}» ohne Regel in scripts/boundaries.ts`;
      if (problem) found.push({ file: rel, line: imp.line, message: problem });
    } else if (imp.spec.startsWith('@vollholz/') && !/^@vollholz\/workflow(?:-web)?(?:\/|$)/.test(imp.spec)) {
      found.push({ file: rel, line: imp.line, message: `«${imp.spec}»: kein Paket einer App, auch nicht in Tests` });
    }
  }
  if (area === 'src') {
    for (const [i, text] of source.split(/\r?\n/).entries()) {
      for (const t of TERMS) if (t.pattern.test(text)) found.push({ file: rel, line: i + 1, message: `Begriff einer App im Paket: ${t.label} («${text.trim().slice(0, 80)}»)` });
    }
  }
  return found;
}

function* files(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) yield p;
  }
}

/** Alle Befunde im Repository. */
export function checkAll(): Finding[] {
  const found: Finding[] = [];
  const base = join(root, 'packages');
  for (const pkg of readdirSync(base)) {
    for (const area of ['src', 'test', 'scripts']) {
      for (const f of files(join(base, pkg, area))) found.push(...checkFile(pkg, area, f, readFileSync(f, 'utf8')));
    }
  }
  return found;
}

if (import.meta.main) {
  const found = checkAll();
  for (const f of found) console.error(`::error file=${f.file},line=${f.line}::${f.message}`);
  if (found.length) {
    console.error(`${found.length} Befund(e). Regel: Pakete sind app-agnostisch (README, Abschnitt «App-agnostisch»).`);
    process.exit(1);
  }
  console.log('ok: Grenzen der Pakete eingehalten (keine App-Pakete, keine Backend-Laufzeit in workflow-web, keine App-Begriffe)');
}
