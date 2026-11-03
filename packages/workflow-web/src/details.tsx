/**
 * Bausteine für die Reiter eines Workflows neben dem Ablauf (UX-Neukonzept Etappe 2): `VersionList` (aktivierte
 * Versionen mit Datum, wer aktiviert hat und in wessen Namen sie handeln) und `WorkflowSettings` (Name und
 * Beschreibung ändern; Art, Bereich, Akteur und Zustand zum Nachlesen).
 *
 * Regeln: Name und Beschreibung gehören nicht zur Version; Speichern wirkt sofort, mit `If-Match` wie der Entwurf. Ohne
 * `workflow:manage` oder archiviert ist alles nur lesbar. Fehlt der Name, meldet das Formular es am Feld.
 */
import { useId, useRef, useState } from 'react';
import { useSaveWorkflow, useWorkflowDetail, useWorkflowVersions } from './api.ts';
import { ActorName, useWorkflow } from './provider.tsx';
import { Badge, fmtDateTime, KIND_LABEL, MissingRight, STATE_LABEL, stateTone } from './ui.tsx';

/** Aktivierte Versionen eines Workflows, neueste zuerst. */
export function VersionList({ workflowId }: { workflowId: string }) {
  const { ui } = useWorkflow();
  const v = useWorkflowVersions(workflowId);
  if (v.isPending) return <ui.Loading label="Versionen werden geladen …" />;
  if (v.isError) return <ui.ErrorBox error={v.error} onRetry={() => void v.refetch()} />;
  if (!v.data.items.length) return <ui.Empty title="Noch keine Version">Eine Version entsteht beim Aktivieren des Entwurfs.</ui.Empty>;
  return (
    <table className="wf-table" aria-label="Versionen">
      <thead><tr><th scope="col">Version</th><th scope="col">Aktiviert</th><th scope="col">von</th><th scope="col">Handelt als</th></tr></thead>
      <tbody>
        {v.data.items.map(x => (
          <tr key={x.version}>
            <th scope="row">Version {x.version}{x.active ? <> <Badge tone="ok">aktiv</Badge></> : null}</th>
            <td>{fmtDateTime(x.activatedAt)}</td>
            <td><ActorName actor={x.activatedBy} /></td>
            <td><ActorName actor={x.actor} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Einstellungen eines Workflows: Name und Beschreibung, dazu Art, Bereich, Akteur und Zustand. */
export function WorkflowSettings({ workflowId }: { workflowId: string }) {
  const w = useWorkflow();
  const { ui } = w;
  const detail = useWorkflowDetail(workflowId);
  if (detail.isPending) return <ui.Loading label="Workflow wird geladen …" />;
  if (detail.isError) return <ui.ErrorBox error={detail.error} onRetry={() => void detail.refetch()} />;
  return <SettingsForm key={`${detail.data.id}:${detail.data.revision}`} workflowId={workflowId} name={detail.data.name} description={detail.data.description ?? ''} />;
}

function SettingsForm({ workflowId, name, description }: { workflowId: string; name: string; description: string }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const detail = useWorkflowDetail(workflowId);
  const save = useSaveWorkflow(workflowId);
  const [n, setN] = useState(name);
  const [d, setD] = useState(description);
  const [missing, setMissing] = useState(false);
  const [done, setDone] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const x = detail.data!;
  const readOnly = !w.can('workflow:manage') || x.state === 'archived';
  const submit = () => {
    if (save.isPending) return;
    if (!n.trim()) { setMissing(true); nameRef.current?.focus(); return; }
    setDone(false);
    save.mutate({ revision: x.revision, name: n.trim(), description: d.trim() || null }, { onSuccess: () => setDone(true) });
  };
  return (
    <section className="wf-settings" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="wf-sr">Einstellungen des Workflows</h2>
      {!w.can('workflow:manage') ? <MissingRight perm="workflow:manage" lead="Zum Ändern" /> : null}
      <form onSubmit={e => { e.preventDefault(); submit(); }} className="wf-editor-form">
        <fieldset className="wf-plain-fieldset" disabled={readOnly}>
          <div className="wf-field">
            <label htmlFor={`${id}-n`}>Name des Workflows</label>
            <ui.Input ref={nameRef} id={`${id}-n`} value={n} aria-invalid={missing || undefined} aria-describedby={missing ? `${id}-ne` : undefined}
              onChange={e => { setN(e.target.value); setMissing(false); setDone(false); }} />
            {missing ? <span id={`${id}-ne`} className="wf-field-error">Gib einen Namen ein.</span> : null}
          </div>
          <div className="wf-field">
            <label htmlFor={`${id}-d`}>Beschreibung</label>
            <ui.Textarea id={`${id}-d`} className="wf-prose" rows={3} value={d} onChange={e => { setD(e.target.value); setDone(false); }} />
            <span className="wf-hint">Name und Beschreibung gehören nicht zur Version: Speichern wirkt sofort.</span>
          </div>
          {!readOnly ? <ui.Button type="submit" variant="primary" aria-disabled={save.isPending || undefined}>{save.isPending ? 'Speichert …' : 'Speichern'}</ui.Button> : null}
        </fieldset>
      </form>
      <div role="status" aria-live="polite" className="wf-ok">{done ? 'Gespeichert.' : null}</div>
      {save.isError ? <ui.ErrorBox error={save.error} /> : null}
      <dl className="wf-summary">
        <dt>Zustand</dt><dd><Badge tone={stateTone(x.state)}>{STATE_LABEL[x.state]}</Badge>{x.activeVersion ? ` · Version ${x.activeVersion}` : ' · noch nie aktiviert'}</dd>
        <dt>Art</dt><dd>{KIND_LABEL[x.kind]}</dd>
        <dt>Bereich</dt><dd>{w.scopeLabel(x.scope)}</dd>
        <dt>Handelt als</dt><dd>{x.actor ? <ActorName actor={x.actor} /> : 'wird beim Aktivieren gewählt'}<span className="wf-hint"> – ändert sich nur mit einer neuen Version.</span></dd>
        <dt>Angelegt</dt><dd>{fmtDateTime(x.createdAt)} von <ActorName actor={x.createdBy} /></dd>
      </dl>
    </section>
  );
}
