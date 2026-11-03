/**
 * Liste der Workflows (Konzept Abschnitt 10): Name, Art, Bereich, Zustand, letzte Läufe (ok/Fehler), Akteur; Filter
 * nach Zustand und Name; «Neu» legt einen Entwurf an (nur mit `workflow:manage`; ohne Name meldet der Dialog es am Feld). Leerzustände unterscheiden «noch
 * keine Workflows» und «kein Treffer». Ist das Modul nicht verfügbar, steht der Hinweis statt der Liste.
 */
import { useId, useRef, useState } from 'react';
import { useCreateWorkflow, useRuns, useWorkflows, useWorkflowStatus } from './api.ts';
import { ActorName, useWorkflow, type WorkflowScopeRef } from './provider.tsx';
import { StatusBanner } from './SettingsPanel.tsx';
import type { WorkflowState, WorkflowSummary } from './types.ts';
import { Badge, KIND_LABEL, STATE_LABEL, stateTone } from './ui.tsx';

export interface WorkflowListProps {
  /** Workflow öffnen (Editor). */
  onOpen: (workflowId: string) => void;
  /** Nur Workflows dieses Bereichs; neue Entwürfe entstehen hier (Standard `{ type: 'tenant', id: '*' }`). */
  scope?: WorkflowScopeRef;
  /** Nach dem Anlegen (Standard: `onOpen`). */
  onCreated?: (workflowId: string) => void;
}

const DEFAULT_SCOPE: WorkflowScopeRef = { type: 'tenant', id: '*' };

export function WorkflowList({ onOpen, scope, onCreated }: WorkflowListProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const status = useWorkflowStatus();
  const [state, setState] = useState<WorkflowState | ''>('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const available = status.data?.available ?? false;
  const list = useWorkflows({ state: state || undefined, scopeType: scope?.type, scopeId: scope?.id }, available);
  if (status.isPending) return <ui.Loading label="Workflows werden geladen …" />;
  if (status.isError) return <ui.ErrorBox error={status.error} onRetry={() => void status.refetch()} />;
  if (!available) return <StatusBanner status={status.data} />;
  const items = (list.data?.items ?? []).filter(x => !q || x.name.toLowerCase().includes(q.toLowerCase()));
  const canCreate = w.can('workflow:manage');
  const filtered = !!state || !!q;
  return (
    <section className="wf-list" aria-labelledby={`${id}-h`}>
      <header className="wf-list-head">
        <h2 id={`${id}-h`}>Workflows</h2>
        <div className="wf-row">
          <label htmlFor={`${id}-q`} className="wf-sr">Nach Name filtern</label>
          <ui.Input id={`${id}-q`} type="search" placeholder="Name …" value={q} onChange={e => setQ(e.target.value)} />
          <label htmlFor={`${id}-s`} className="wf-sr">Zustand</label>
          <ui.Select id={`${id}-s`} value={state} onChange={e => setState(e.target.value as WorkflowState | '')}>
            <option value="">Alle Zustände</option>
            {(Object.keys(STATE_LABEL) as WorkflowState[]).map(s => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
          </ui.Select>
          {canCreate ? <ui.Button variant="primary" onClick={() => setCreating(true)}>Neu</ui.Button> : null}
        </div>
      </header>
      {list.isPending ? <ui.Loading label="Workflows werden geladen …" />
        : list.isError ? <ui.ErrorBox error={list.error} onRetry={() => void list.refetch()} />
          : !items.length ? (
            filtered ? <ui.Empty title="Kein Treffer">Kein Workflow passt zum Filter.</ui.Empty>
              : <ui.Empty title="Noch keine Workflows">{canCreate ? 'Lege mit «Neu» den ersten Workflow an: Auslöser wählen, Schritte hinzufügen, im Probelauf prüfen, aktivieren.' : 'Hier erscheinen die Workflows, sobald jemand mit dem Recht dazu einen anlegt.'}</ui.Empty>
          ) : (
            <table className="wf-table">
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Art</th><th scope="col">Bereich</th><th scope="col">Zustand</th><th scope="col">Letzte Läufe</th><th scope="col">Akteur</th></tr>
              </thead>
              <tbody>
                {items.map(x => (
                  <tr key={x.id}>
                    <th scope="row"><button type="button" className="wf-name" onClick={() => onOpen(x.id)}>{x.name}</button></th>
                    <td>{KIND_LABEL[x.kind] ?? x.kind}</td>
                    <td>{w.scopeLabel(x.scope)}</td>
                    <td><Badge tone={stateTone(x.state)}>{STATE_LABEL[x.state]}</Badge>{x.activeVersion ? <span className="wf-muted wf-small"> v{x.activeVersion}</span> : null}</td>
                    <td><LastRuns workflow={x} /></td>
                    <td>{x.actor ? <ActorName actor={x.actor} /> : <span className="wf-muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      {creating ? <CreateDialog scope={scope ?? DEFAULT_SCOPE} onClose={() => setCreating(false)} onCreated={newId => { setCreating(false); (onCreated ?? onOpen)(newId); }} /> : null}
    </section>
  );
}

/** Zähler der letzten Läufe eines Workflows (bis 20): erfolgreich und mit Fehler/Vorfall. */
function LastRuns({ workflow }: { workflow: WorkflowSummary }) {
  const runs = useRuns({ workflowId: workflow.id, limit: 20 }, workflow.activeVersion !== null);
  if (workflow.activeVersion === null) return <span className="wf-muted">–</span>;
  const items = runs.data?.pages[0]?.items;
  if (!items) return <span className="wf-muted">…</span>;
  if (!items.length) return <span className="wf-muted">noch keine</span>;
  const ok = items.filter(r => r.state === 'completed').length;
  const bad = items.filter(r => r.state === 'failed' || r.state === 'incident').length;
  return (
    <span className="wf-row wf-small" aria-label={`${ok} erfolgreich, ${bad} mit Fehler (letzte ${items.length})`}>
      <Badge tone="ok">{ok} ok</Badge>{bad ? <Badge tone="bad">{bad} Fehler</Badge> : null}
    </span>
  );
}

function CreateDialog({ scope, onClose, onCreated }: { scope: WorkflowScopeRef; onClose: () => void; onCreated: (id: string) => void }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const create = useCreateWorkflow();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [missing, setMissing] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const submit = () => {
    if (create.isPending) return;
    if (!name.trim()) { setMissing(true); nameRef.current?.focus(); return; }
    create.mutate({ name: name.trim(), description: description.trim() || undefined, scope }, { onSuccess: d => onCreated(d.id) });
  };
  return (
    <ui.Dialog title="Neuer Workflow" onClose={onClose}
      footer={<><ui.Button onClick={onClose}>Abbrechen</ui.Button><ui.Button variant="primary" aria-disabled={create.isPending || undefined} onClick={submit}>{create.isPending ? 'Wird angelegt …' : 'Entwurf anlegen'}</ui.Button></>}>
      <form onSubmit={e => { e.preventDefault(); submit(); }}>
        <div className="wf-field">
          <label htmlFor={`${id}-n`}>Name</label>
          <ui.Input ref={nameRef} id={`${id}-n`} data-autofocus required value={name} aria-invalid={missing || undefined} aria-describedby={missing ? `${id}-ne` : undefined}
            onChange={e => { setName(e.target.value); setMissing(false); }} />
          {missing ? <span id={`${id}-ne`} className="wf-field-error">Gib einen Namen ein.</span> : null}
        </div>
        <div className="wf-field">
          <label htmlFor={`${id}-d`}>Beschreibung (optional)</label>
          <ui.Textarea id={`${id}-d`} rows={2} value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <p className="wf-hint">Bereich: {w.scopeLabel(scope)}. Der Entwurf startet von Hand und hat noch keine Schritte.</p>
      </form>
      {create.isError ? <ui.ErrorBox error={create.error} /> : null}
    </ui.Dialog>
  );
}
