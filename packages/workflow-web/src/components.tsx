/**
 * Bausteine der Oberfläche (Konzept Abschnitt 10). Stufe 0: Die Angaben jedes Bausteins stehen schon fest, damit eine
 * App ihn einbinden kann; bis zu seiner Stufe zeigt er nur den Hinweis «noch nicht verfügbar».
 */
import { useWorkflow, type WorkflowSubjectRef } from './provider.tsx';

function Unavailable({ name, title }: { name: string; title: string }) {
  useWorkflow();
  return (
    <div className="wf-unavailable" role="status" data-workflow-component={name}>
      <strong>{title}</strong>
      <span>noch nicht verfügbar</span>
    </div>
  );
}

/** Editor eines Workflows als Schrittliste. */
export interface StepListEditorProps { workflowId?: string }
export function StepListEditor(_props: StepListEditorProps) {
  return <Unavailable name="StepListEditor" title="Workflow bearbeiten" />;
}

/** «Meine Arbeit»: Aufgaben der Person und ihres Teams. */
export interface MyWorkProps { filter?: 'mine' | 'team' | 'all' }
export function MyWork(_props: MyWorkProps) {
  return <Unavailable name="MyWork" title="Meine Arbeit" />;
}

/** Warteschlange mit Aufgaben, Filtern und Massenaktionen. */
export interface QueueViewProps { queueId: string }
export function QueueView(_props: QueueViewProps) {
  return <Unavailable name="QueueView" title="Warteschlange" />;
}

/** Fall mit Phasen, Aufgaben, Bezügen und Verlauf. */
export interface CaseViewProps { caseId: string }
export function CaseView(_props: CaseViewProps) {
  return <Unavailable name="CaseView" title="Fall" />;
}

/** Protokoll der Läufe und Schritte. */
export interface RunLogProps { workflowId?: string; runId?: string }
export function RunLog(_props: RunLogProps) {
  return <Unavailable name="RunLog" title="Protokoll" />;
}

/** Leiste an einem Bezug: Zustandswechsel, manuelle Auslöser, offene Aufgaben und Fälle. */
export interface SubjectWorkflowBarProps { subject: WorkflowSubjectRef }
export function SubjectWorkflowBar(_props: SubjectWorkflowBarProps) {
  return <Unavailable name="SubjectWorkflowBar" title="Workflows" />;
}
