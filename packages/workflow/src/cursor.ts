/**
 * Position eines Laufs in der Definition (Konzept 8.1 «nächsten Schritt nach Pfad bestimmen»). Reine Funktionen ohne
 * Datenbank, darum einzeln getestet.
 *
 * Ein **Ausführungspfad** ist ein JSON Pointer in die Definition, ergänzt um den Durchgang einer «Für jedes»-Schleife:
 * `/steps/2`, `/steps/0/then/1`, `/steps/1/items/3/steps/0` (Schritt 0 im vierten Durchgang der Schleife `/steps/1`),
 * `/steps/4/onError/steps/0` (Fehlerpfad eines Schritts), `/onError/steps/0` (Fehlerpfad der Definition). Der Pfad ist
 * im Schrittprotokoll mit dem Versuch eindeutig.
 *
 * Regeln:
 * - Nach dem letzten Schritt eines Zweigs (`then`/`else`) geht es nach dem Wenn-Schritt weiter, nach einem Durchgang
 *   mit dem nächsten Durchgang oder nach der Schleife, nach dem Fehlerpfad eines Schritts nach diesem Schritt.
 * - Nach dem Fehlerpfad der Definition endet der Lauf als fehlgeschlagen (`END_FAILED`).
 * - Die Einträge einer Schleife stehen im Lauf (`loops[<Pfad der Schleife>]`), nicht im Pfad.
 */
import type { Step, WorkflowDefinition } from './definition.ts';

/** Lauf ist zu Ende (erfolgreich). */
export const END = null;
/** Lauf endet nach dem Fehlerpfad der Definition als fehlgeschlagen. */
export const END_FAILED = '#failed';
export type Position = string | null;

/** Einträge je Schleife (Schlüssel: Ausführungspfad des Für-jedes-Schritts). */
export type Loops = Record<string, { items: unknown[]; as: string }>;

const isIndex = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);

/** Ausführungspfad → Pfad in der Definition (ohne `items/<n>`). */
export function definitionPath(execPath: string): string {
  return execPath.replace(/\/items\/\d+(?=\/steps(?:\/|$))/g, '');
}

/** Liste von Schritten unter einem Listenpfad (`/steps`, `/steps/0/then`, `/steps/1/items/2/steps`, …). */
export function listAt(def: WorkflowDefinition, listPath: string): Step[] | undefined {
  const segs = definitionPath(listPath).split('/').slice(1);
  let cur: unknown = def;
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) { if (!isIndex(seg)) return undefined; cur = cur[Number(seg)]; continue; }
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return Array.isArray(cur) ? (cur as Step[]) : undefined;
}

/** Schritt unter einem Ausführungspfad. */
export function stepAt(def: WorkflowDefinition, execPath: string): Step | undefined {
  const i = execPath.lastIndexOf('/');
  const index = execPath.slice(i + 1);
  if (!isIndex(index)) return undefined;
  return listAt(def, execPath.slice(0, i))?.[Number(index)];
}

/** Erste Position in einer Liste; ist sie leer, die Position nach der Liste. */
export function enter(def: WorkflowDefinition, listPath: string, loops: Loops): Position {
  const list = listAt(def, listPath);
  if (list && list.length) return `${listPath}/0`;
  return afterList(def, listPath, loops);
}

/** Position nach dem Schritt unter `execPath` (Geschwister, sonst nach der umgebenden Liste). */
export function advance(def: WorkflowDefinition, execPath: string, loops: Loops): Position {
  const i = execPath.lastIndexOf('/');
  const listPath = execPath.slice(0, i);
  const index = Number(execPath.slice(i + 1));
  const list = listAt(def, listPath) ?? [];
  if (index + 1 < list.length) return `${listPath}/${index + 1}`;
  return afterList(def, listPath, loops);
}

/** Position, wenn die Liste unter `listPath` fertig ist. */
function afterList(def: WorkflowDefinition, listPath: string, loops: Loops): Position {
  if (listPath === '/steps') return END;
  if (listPath === '/onError/steps') return END_FAILED;
  const segs = listPath.split('/');
  const last = segs.at(-1);
  if (last === 'then' || last === 'else') return advance(def, segs.slice(0, -1).join('/'), loops);
  if (last === 'steps' && segs.at(-3) === 'items' && isIndex(segs.at(-2))) {
    const owner = segs.slice(0, -3).join('/');
    const n = Number(segs.at(-2));
    const loop = loops[owner];
    if (loop && n + 1 < loop.items.length) return enter(def, `${owner}/items/${n + 1}/steps`, loops);
    return advance(def, owner, loops);
  }
  if (last === 'steps' && segs.at(-2) === 'onError') return advance(def, segs.slice(0, -2).join('/'), loops);
  throw new Error(`Unbekannte Liste «${listPath}» in der Definition`);
}

/** Schleifen, deren Pfad unter `execPath` liegt, entfernen (nach dem Ende einer Schleife). */
export function dropLoopsBelow(loops: Loops, execPath: string): Loops {
  const out: Loops = {};
  for (const [k, v] of Object.entries(loops)) if (!(k === execPath || k.startsWith(`${execPath}/`))) out[k] = v;
  return out;
}

/** Durchgang und Element der innersten Schleife eines Pfads (für den Kontext eines Schritts). */
export function loopBindings(execPath: string, loops: Loops): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const re = /\/items\/(\d+)(?=\/steps\/)/g;
  for (let m = re.exec(execPath); m; m = re.exec(execPath)) {
    const owner = execPath.slice(0, m.index);
    const loop = loops[owner];
    if (loop) { vars[loop.as] = loop.items[Number(m[1])]; vars[`${loop.as}Index`] = Number(m[1]); }
  }
  return vars;
}
