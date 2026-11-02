/**
 * Bausteine späterer Stufen (Konzept Abschnitt 13): Ihre Angaben stehen schon fest, damit eine App sie einbinden kann;
 * bis zu ihrer Stufe zeigen sie nur den Hinweis «noch nicht verfügbar». Aufgaben und Warteschlangen folgen in Stufe 2,
 * Fälle in Stufe 3.
 */
import { useWorkflow } from './provider.tsx';

function Unavailable({ name, title }: { name: string; title: string }) {
  useWorkflow();
  return (
    <div className="wf-unavailable" role="status" data-workflow-component={name}>
      <strong>{title}</strong>
      <span>noch nicht verfügbar</span>
    </div>
  );
}

/** «Meine Arbeit»: Aufgaben der Person und ihres Teams (Stufe 2). */
export interface MyWorkProps { filter?: 'mine' | 'team' | 'all' }
export function MyWork(_props: MyWorkProps) {
  return <Unavailable name="MyWork" title="Meine Arbeit" />;
}

/** Warteschlange mit Aufgaben, Filtern und Massenaktionen (Stufe 2). */
export interface QueueViewProps { queueId: string }
export function QueueView(_props: QueueViewProps) {
  return <Unavailable name="QueueView" title="Warteschlange" />;
}

/** Fall mit Phasen, Aufgaben, Bezügen und Verlauf (Stufe 3). */
export interface CaseViewProps { caseId: string }
export function CaseView(_props: CaseViewProps) {
  return <Unavailable name="CaseView" title="Fall" />;
}
