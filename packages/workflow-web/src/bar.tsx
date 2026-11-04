/**
 * Teile für die Leiste einer App (UX-Neukonzept, Kopf «Kontextleiste»): eine Zeile mit Zurück, Name, «Entwurf», Reitern,
 * Zustand, Hauptaktion und Menü. Die App baut die Zeile; der Baukasten liefert, was am Workflow hängt:
 * - `WorkflowDraftMark`: der Marker «Entwurf» neben dem Namen, solange der gespeicherte Entwurf von der aktiven (bzw.
 *   zuletzt aktiven) Fassung abweicht oder der Workflow nie aktiv war; mit `onOpen` führt er zum Editor.
 * - `WorkflowActions`: Zustand und Menü ausserhalb des Editors (z. B. im Reiter «Runs»): Einträge der App (z. B.
 *   «Versionen …», «Einstellungen …»), dann Aktivieren (dieselbe Fassung), Änderungen verwerfen, Deaktivieren,
 *   Archivieren, Löschen. Eine Hauptaktion zum Aktivieren gibt es hier nicht: Den Entwurf aktiviert man im Editor.
 *
 * Im Editor füllt `StepListEditor` dieselben Plätze selbst (`slots`), weil Aktivieren, Verwerfen und der Probelauf am
 * Entwurf hängen, den er gerade bearbeitet.
 */
import { useState } from 'react';
import { useDeleteWorkflow, useSaveWorkflow, useWorkflowDetail, useWorkflowLifecycle, useWorkflowVersion } from './api.ts';
import { MoreMenu, type MenuItem } from './menu.tsx';
import { useWorkflow } from './provider.tsx';
import type { WorkflowDetail } from './types.ts';
import { Badge, canonical, DraftMark, hasDraft, STATE_LABEL, stateTone } from './ui.tsx';

export type { MenuItem as WorkflowMenuItem } from './menu.tsx';

/** Weicht der gespeicherte Entwurf von der aktiven bzw. zuletzt aktiven Fassung ab? `undefined`, solange sie lädt. */
export function useDraftDiffers(detail: WorkflowDetail | undefined): boolean | undefined {
  const version = useWorkflowVersion(detail?.id, detail && detail.state !== 'archived' ? detail.activeVersion : null);
  if (!detail) return undefined;
  if (detail.state === 'archived') return false;
  if (detail.activeVersion === null) return true;
  return version.data ? canonical(version.data.definition) !== canonical(detail.definition) : undefined;
}

/** Marker «Entwurf» neben dem Namen eines Workflows (ausserhalb des Editors); `onOpen` öffnet den Entwurf im Editor. */
export function WorkflowDraftMark({ workflowId, onOpen }: { workflowId: string; onOpen?: () => void }) {
  const detail = useWorkflowDetail(workflowId);
  const differs = useDraftDiffers(detail.data);
  if (!detail.data || differs === undefined || !hasDraft(detail.data, differs)) return null;
  return <DraftMark onOpen={onOpen} />;
}

export interface WorkflowActionsProps {
  workflowId: string;
  /** Einträge der App zuoberst im Menü (z. B. «Versionen …», «Einstellungen …»). */
  items?: MenuItem[];
  /** Nach dem Löschen eines Workflows, der nie aktiv war. */
  onDeleted?: () => void;
}

/** Zustand und Menü eines Workflows in der Leiste der App, wenn der Editor nicht offen ist. */
export function WorkflowActions({ workflowId, items = [], onDeleted }: WorkflowActionsProps) {
  const w = useWorkflow();
  const { ui } = w;
  const detail = useWorkflowDetail(workflowId);
  const d = detail.data;
  const differs = useDraftDiffers(d);
  const life = useWorkflowLifecycle(workflowId);
  const save = useSaveWorkflow(workflowId);
  const active = useWorkflowVersion(workflowId, d && d.state !== 'archived' ? d.activeVersion : null);
  const [dialog, setDialog] = useState<null | 'discard' | 'archive' | 'delete'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!d) return items.length ? <MoreMenu items={items} /> : null;
  const canLife = w.can('workflow:activate'), canManage = w.can('workflow:manage');
  const paused = d.state === 'paused';
  const own: MenuItem[] = [];
  if (d.state !== 'archived') {
    if (d.activeVersion === null) {
      if (canManage) own.push({ label: 'Workflow löschen …', danger: true, onSelect: () => setDialog('delete') });
    } else {
      // Dieselbe Fassung wieder aktivieren; braucht es einen anderen Akteur, geht das nur im Editor (Dialog).
      if (paused && !d.pausedReason && canLife) own.push({ label: differs ? 'Ohne Änderungen aktivieren' : 'Aktivieren', onSelect: () => life.resume.mutate(undefined, { onSuccess: () => setNotice('Workflow ist wieder aktiv.') }) });
      if (differs && canManage) own.push({ label: 'Änderungen verwerfen …', onSelect: () => setDialog('discard') });
      if (!paused && canLife) own.push({ label: 'Deaktivieren', onSelect: () => life.pause.mutate(undefined, { onSuccess: () => setNotice('Workflow deaktiviert; er startet keine neuen Runs mehr.') }) });
      if (canLife) own.push({ label: 'Archivieren …', danger: true, onSelect: () => setDialog('archive') });
    }
  }
  const firstSafe = own.findIndex(x => !x.danger);
  if (items.length && firstSafe >= 0) own[firstSafe] = { ...own[firstSafe]!, separator: true };
  const menu = [...items, ...own];
  const failed = life.pause.error ?? life.resume.error;
  return (
    <>
      <Badge tone={stateTone(d.state)}>{STATE_LABEL[d.state]}</Badge>
      {menu.length ? <MoreMenu items={menu} /> : null}
      <span role="status" aria-live="polite" className="wf-sr">{notice}</span>
      {failed && !dialog ? (
        <ui.Dialog title="Das ging nicht" role="alertdialog" onClose={() => { life.pause.reset(); life.resume.reset(); }}
          footer={<ui.Button data-autofocus onClick={() => { life.pause.reset(); life.resume.reset(); }}>Schliessen</ui.Button>}>
          <ui.ErrorBox error={failed} />
        </ui.Dialog>
      ) : null}
      {dialog === 'discard' && active.data ? (
        <DiscardDialog paused={paused} busy={save.isPending} error={save.error} onClose={() => { setDialog(null); save.reset(); }}
          onConfirm={() => save.mutate({ revision: d.revision, definition: active.data.definition }, {
            onSuccess: () => { setDialog(null); setNotice(paused ? 'Änderungen verworfen; es gilt wieder die zuletzt aktive Fassung.' : 'Änderungen verworfen; es gilt wieder die aktive Fassung.'); },
          })} />
      ) : null}
      {dialog === 'archive' ? <ArchiveDialog workflowId={workflowId} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setNotice('Workflow archiviert.'); }} /> : null}
      {dialog === 'delete' ? <DeleteDialog detail={d} onClose={() => setDialog(null)} onDeleted={() => { setDialog(null); onDeleted?.(); }} /> : null}
    </>
  );
}

/** Rückfrage vor «Änderungen verwerfen»: Der Entwurf übernimmt wieder die aktive bzw. zuletzt aktive Fassung. */
export function DiscardDialog({ paused, busy, error, onClose, onConfirm }: { paused: boolean; busy?: boolean; error?: Error | null; onClose: () => void; onConfirm: () => void }) {
  const { ui } = useWorkflow();
  return (
    <ui.Dialog title="Änderungen verwerfen?" role="alertdialog" onClose={onClose}
      footer={<><ui.Button data-autofocus onClick={onClose}>Abbrechen</ui.Button><ui.Button variant="danger" disabled={busy} onClick={onConfirm}>Verwerfen</ui.Button></>}>
      <p>{paused ? 'Deine Änderungen an Auslöser und Schritten gehen verloren; es gilt wieder die zuletzt aktive Fassung.'
        : 'Deine Änderungen an Auslöser und Schritten gehen verloren; es gilt wieder die aktive Fassung, die unverändert weiterläuft.'}</p>
      {error ? <ui.ErrorBox error={error} /> : null}
    </ui.Dialog>
  );
}

/** Rückfrage vor dem Archivieren; archiviert danach selbst. */
export function ArchiveDialog({ workflowId, onClose, onDone }: { workflowId: string; onClose: () => void; onDone: (d: WorkflowDetail) => void }) {
  const { ui } = useWorkflow();
  const life = useWorkflowLifecycle(workflowId);
  return (
    <ui.Dialog title="Workflow archivieren?" role="alertdialog" onClose={onClose}
      footer={<><ui.Button data-autofocus onClick={onClose}>Abbrechen</ui.Button>
        <ui.Button variant="danger" disabled={life.archive.isPending} onClick={() => life.archive.mutate(undefined, { onSuccess: onDone })}>Archivieren</ui.Button></>}>
      <p>Der Workflow startet danach nicht mehr; laufende Runs enden mit ihrer Fassung. Archivierte Workflows lassen sich nicht mehr ändern.</p>
      {life.archive.isError ? <ui.ErrorBox error={life.archive.error} /> : null}
    </ui.Dialog>
  );
}

/** Rückfrage vor dem Löschen eines Workflows, der nie aktiv war; löscht danach selbst. */
export function DeleteDialog({ detail, onClose, onDeleted }: { detail: WorkflowDetail; onClose: () => void; onDeleted: () => void }) {
  const { ui } = useWorkflow();
  const del = useDeleteWorkflow(detail.id);
  return (
    <ui.Dialog title="Workflow löschen?" role="alertdialog" onClose={onClose}
      footer={<><ui.Button data-autofocus onClick={onClose}>Abbrechen</ui.Button>
        <ui.Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(detail.revision, { onSuccess: onDeleted })}>Löschen</ui.Button></>}>
      <p>Der Workflow «{detail.name}» wird endgültig gelöscht. Das geht nur, solange er nie aktiv war.</p>
      {del.isError ? <ui.ErrorBox error={del.error} /> : null}
    </ui.Dialog>
  );
}
