/**
 * Migrationen des Baukastens als SQL mit Platzhaltern (`migrations/workflow_NNN_*.sql`). `workflowMigrations` setzt
 * Schema, Rollen und die Ausdrücke für Mandant und Person ein und liefert die Migrationen mit Prüfsumme; jeder Runner
 * kann `migrations[i].sql` der Reihe nach ausführen.
 *
 * Regeln:
 * - Die Migrationen sind idempotent und lassen Bestehendes stehen (z. B. die Lesesicht nach `workflow_subjects`).
 * - Bezeichner (Schema, Rollen) nur aus a–z, 0–9 und «_»; Ausdrücke ohne `;` und Kommentare (sie stehen in Policies).
 * - Reihenfolge: vor der Migration der App, die `<schema>.workflow_subjects(...)` aufruft.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Migration, MigrationOptions } from './ports.ts';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Bezeichner prüfen (Schema, Rolle); wirft einen Fehler der Einbindung. */
export function ident(value: string, what: string): string {
  if (!IDENT.test(value)) throw new Error(`workflow: ${what} «${value}» ist kein gültiger Bezeichner (a–z, 0–9, «_»)`);
  return value;
}

/** SQL-Ausdruck ohne Semikolon, Kommentar und `%` (wird in Policies, Vorgaben und `format(…)` eingesetzt). */
function expression(value: string, what: string): string {
  if (!value.trim() || /;|--|\/\*|%|\$f\$/.test(value)) throw new Error(`workflow: ${what} «${value}» ist kein gültiger SQL-Ausdruck`);
  return value;
}

/** Platzhalter `{{name}}` einsetzen; unbekannte Platzhalter sind ein Fehler. */
export function renderSql(sql: string, vars: Record<string, string>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!Object.hasOwn(vars, k)) throw new Error(`workflow: unbekannter Platzhalter {{${k}}} in einer Migration`);
    return vars[k]!;
  });
}

/** Ordner der SQL-Vorlagen (im Paket neben `src` bzw. `dist`). */
export const WORKFLOW_MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Vorgabe für den Mandanten der Anfrage (wie bei den übrigen Bausteinen). */
export const DEFAULT_TENANT_EXPR = 'app.tenant_id()';
/** Vorgabe für die angemeldete Person. */
export const DEFAULT_PRINCIPAL_EXPR = 'app.principal_id()';

/** Migrationen mit eingesetzten Platzhaltern, nach Name sortiert, mit SHA-256-Prüfsumme. */
export function workflowMigrations(o: MigrationOptions): Migration[] {
  const vars = {
    schema: ident(o.schema, 'Schema'),
    app: ident(o.appRole, 'Rolle «appRole»'),
    sched: ident(o.schedRole, 'Rolle «schedRole»'),
    tenant: expression(o.tenantExpr ?? DEFAULT_TENANT_EXPR, 'Ausdruck «tenantExpr»'),
    principal: expression(o.principalExpr ?? DEFAULT_PRINCIPAL_EXPR, 'Ausdruck «principalExpr»'),
  };
  const files = readdirSync(WORKFLOW_MIGRATIONS_DIR).filter(f => /^workflow_\d{3}_[\w-]+\.sql$/.test(f)).sort();
  return files.map(f => {
    const sql = renderSql(readFileSync(join(WORKFLOW_MIGRATIONS_DIR, f), 'utf8'), vars).replace(/\r\n/g, '\n');
    return { name: f, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}
