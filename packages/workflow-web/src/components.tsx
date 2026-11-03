/**
 * Bausteine späterer Stufen (Konzept Abschnitt 13): Ihre Angaben stehen schon fest, damit eine App sie einbinden kann;
 * bis zu ihrer Stufe zeigen sie nur den Hinweis «noch nicht verfügbar». Fälle folgen in Stufe 3
 * («Meine Arbeit» und Warteschlangen gibt es seit Stufe 2 in `tasks.tsx` und `queues.tsx`).
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

/** Fall mit Phasen, Aufgaben, Bezügen und Verlauf (Stufe 3). */
export interface CaseViewProps { caseId: string }
export function CaseView(_props: CaseViewProps) {
  return <Unavailable name="CaseView" title="Fall" />;
}
