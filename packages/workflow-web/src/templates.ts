/**
 * Vorlagen für neue Workflows (UX-Neukonzept Etappe 4: «Neu» mit Vorlagen oder leer). Der Baukasten bringt Vorlagen
 * ohne Begriffe einer App mit (Genehmigung, Aufgabe mit Ergebnissen, nach Zeitplan); die App ergänzt eigene
 * (`WorkflowList` › `templates`), die ihre Aktionen und Ereignisse nutzen.
 *
 * Regeln:
 * - Eine Vorlage ist ein Anfang, kein fertiger Workflow: Zuständige, Bedingungen und Werte ergänzt man im Editor; die
 *   Prüfung nennt, was fehlt.
 * - `build` liefert `null`, wenn die Vorlage im Bereich nicht passt (z. B. fehlt eine Aktion oder ein Ereignis); dann
 *   erscheint sie nicht.
 */
import { triggerOfKind } from './trigger.tsx';
import type { AutomationDefinition, WorkflowDefinition, WorkflowMetaJson } from './types.ts';

export interface WorkflowTemplate {
  key: string;
  /** Titel der Vorlage, zugleich Vorschlag für den Namen. */
  name: string;
  /** Ein Satz: was der Workflow tut. */
  description: string;
  /** Definition des Entwurfs; `null`, wenn die Vorlage im Bereich nicht passt. */
  build: (meta: WorkflowMetaJson | undefined) => WorkflowDefinition | null;
}

const automation = (d: Omit<AutomationDefinition, 'kind' | 'schemaVersion'>): AutomationDefinition =>
  ({ schemaVersion: 2, kind: 'automation', ...d });
const has = (meta: WorkflowMetaJson | undefined, kind: string) => !meta || meta.stepKinds.includes(kind);

/** Vorlagen des Baukastens (ohne Begriffe einer App). */
export const builtinTemplates: WorkflowTemplate[] = [
  {
    key: 'approval', name: 'Genehmigung einholen', description: 'Von Hand starten, jemand genehmigt oder lehnt ab; je Entscheid ein eigener Weg.',
    build: meta => (has(meta, 'approval') ? automation({
      trigger: { manual: {} },
      steps: [{ id: 's1', approval: { title: 'Freigabe', approvers: [{ actor: { id: '', kind: 'person' } }], mode: 'first', reasonOnReject: true } }],
    }) : null),
  },
  {
    key: 'task', name: 'Aufgabe mit Rückmeldung', description: 'Von Hand starten, jemand erledigt eine Aufgabe und meldet «Erledigt» oder «Nicht möglich».',
    build: meta => (has(meta, 'task') ? automation({
      trigger: { manual: {} },
      steps: [{ id: 's1', task: { title: 'Aufgabe', assignee: { actor: { id: '', kind: 'person' } }, outcomes: ['Erledigt', 'Nicht möglich'] } }],
    }) : null),
  },
  {
    key: 'schedule', name: 'Regelmässig nach Zeitplan', description: 'Werktags um 7 Uhr starten; die Schritte wählst du danach.',
    build: meta => automation({ trigger: triggerOfKind('schedule', meta), steps: [] }),
  },
];
