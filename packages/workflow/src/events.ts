/**
 * Ereignistypen, die der Baukasten über `host.emit` meldet (Konzept 4.9): `workflow.*`, `task.*`, `case.*`. Die App
 * bietet sie z. B. für Webhook-Abonnements an. Ereignisse aus Workflows lösen standardmässig keine Workflows aus
 * (Schleifenschutz, Opt-in je Auslöser mit `includeWorkflowEvents`).
 */

export interface WorkflowEventType {
  type: string;
  description: string;
}

export const WORKFLOW_EVENT_TYPES = [
  { type: 'workflow.activated', description: 'Eine Version eines Workflows wurde aktiviert.' },
  { type: 'workflow.paused', description: 'Ein Workflow wurde pausiert (von Hand oder weil der Akteur nicht mehr handeln darf).' },
  { type: 'workflow.archived', description: 'Ein Workflow wurde archiviert.' },
  { type: 'workflow.run_started', description: 'Ein Lauf hat begonnen.' },
  { type: 'workflow.run_completed', description: 'Ein Lauf ist erfolgreich beendet.' },
  { type: 'workflow.run_failed', description: 'Ein Lauf ist fehlgeschlagen oder wurde abgebrochen.' },
  { type: 'workflow.incident_opened', description: 'Ein Lauf hält wegen eines Fehlers an und braucht einen Entscheid.' },
  { type: 'workflow.incident_resolved', description: 'Ein Vorfall wurde gelöst (nochmals, übersprungen oder abgebrochen).' },
  { type: 'workflow.custom', description: 'Eigenes Ereignis, ausgelöst durch einen Schritt eines Workflows.' },
  { type: 'task.created', description: 'Eine Aufgabe oder Genehmigung wurde erstellt.' },
  { type: 'task.assigned', description: 'Eine Aufgabe wurde einer Person oder Warteschlange zugewiesen.' },
  { type: 'task.decided', description: 'Bei einer Genehmigung wurde abgestimmt.' },
  { type: 'task.completed', description: 'Eine Aufgabe wurde erledigt.' },
  { type: 'task.cancelled', description: 'Eine Aufgabe wurde abgebrochen.' },
  { type: 'task.sla_breached', description: 'Die Frist einer Aufgabe wurde verletzt.' },
  { type: 'case.created', description: 'Ein Fall wurde angelegt.' },
  { type: 'case.phase_changed', description: 'Ein Fall ist in eine andere Phase gewechselt.' },
  { type: 'case.closed', description: 'Ein Fall wurde abgeschlossen.' },
] as const satisfies readonly WorkflowEventType[];

export type WorkflowEventTypeName = (typeof WORKFLOW_EVENT_TYPES)[number]['type'];
