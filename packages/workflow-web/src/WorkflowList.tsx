/**
 * Liste der Workflows (Konzept Abschnitt 10, UX-Neukonzept Etappe 4, Kopf «Kontextleiste»): Name mit dem Workflow als
 * Satz (Auslöser und Zahl der Schritte dessen, was läuft), Art, Bereich, Zustand (Aktiv / Inaktiv / Archiviert, ohne
 * Versionsnummer) mit dem Marker «Entwurf» (führt zum Editor) und offenen Vorfällen, der letzte Run (Datum und Zeit
 * öffnen ihn) und sein Zustand. Schmal (bis 760 px) bleiben Name, Zustand und Zustand des Runs. Filter nach Name,
 * Zustand und «Mit Entwurf» stehen über der Tabelle. «Neu» legt einen Entwurf an – leer oder aus einer Vorlage (nur mit
 * `workflow:manage`; ohne Name meldet der Dialog es am Feld); mit `showCreate={false}` setzt die App `NewWorkflowButton`
 * in ihre Leiste. Leerzustände unterscheiden «noch keine Workflows» und «kein Treffer». Ist das Modul nicht verfügbar,
 * steht der Hinweis statt der Liste.
 */
import { useId, useRef, useState } from 'react';
import { useCreateWorkflow, useRuns, useWorkflowMeta, useWorkflows, useWorkflowStatus } from './api.ts';
import { useWorkflow, type WorkflowScopeRef } from './provider.tsx';
import { StatusBanner } from './SettingsPanel.tsx';
import { builtinTemplates, type WorkflowTemplate } from './templates.ts';
import { describeTrigger } from './trigger.tsx';
import type { WorkflowMetaJson, WorkflowSummary } from './types.ts';
import { Badge, DraftMark, fmtDateTime, hasDraft, KIND_LABEL, plural, rowLink, RUN_STATE_LABEL, runTone, STATE_LABEL, stateTone } from './ui.tsx';

/** Filter der Liste: Zustand wie angezeigt (Inaktiv = nie aktiviert oder deaktiviert) oder «Mit Entwurf». */
type ListFilter = '' | 'active' | 'inactive' | 'archived' | 'draft';
const FILTER_LABEL: Record<Exclude<ListFilter, ''>, string> = { active: 'Aktiv', inactive: 'Inaktiv', archived: 'Archiviert', draft: 'Mit Entwurf' };

export interface WorkflowListProps {
  /** Workflow öffnen (Editor). */
  onOpen: (workflowId: string) => void;
  /** Nur Workflows dieses Bereichs; neue Entwürfe entstehen hier (Standard `{ type: 'tenant', id: '*' }`). */
  scope?: WorkflowScopeRef;
  /** Nach dem Anlegen (Standard: `onOpen`). */
  onCreated?: (workflowId: string) => void;
  /** Vorlagen der App für «Neu» (vor denen des Baukastens). */
  templates?: WorkflowTemplate[];
  /** Vorlagen des Baukastens anbieten (Standard `true`). */
  builtinTemplates?: boolean;
  /** Überschrift «Workflows» zeigen (Standard `true`); `false`, wenn die App sie im Seitenkopf zeigt (bleibt für Screenreader). */
  showTitle?: boolean;
  /** «Neu» über der Tabelle zeigen (Standard `true`); `false`, wenn die App `NewWorkflowButton` in ihre Leiste setzt. */
  showCreate?: boolean;
  /** Den letzten Run eines Workflows öffnen (Datum und Zeit in der Spalte «Letzter Run»); ohne Angabe nur Text. */
  onOpenRun?: (workflowId: string, runId: string) => void;
}

const DEFAULT_SCOPE: WorkflowScopeRef = { type: 'tenant', id: '*' };

export function WorkflowList({ onOpen, scope, onCreated, templates = [], builtinTemplates: builtin = true, showTitle = true, showCreate = true, onOpenRun }: WorkflowListProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const status = useWorkflowStatus();
  const [state, setState] = useState<ListFilter>('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const available = status.data?.available ?? false;
  const list = useWorkflows({ state: state === 'active' || state === 'archived' ? state : undefined, scopeType: scope?.type, scopeId: scope?.id }, available);
  const meta = useWorkflowMeta(scope ?? DEFAULT_SCOPE, available);
  if (status.isPending) return <ui.Loading label="Workflows werden geladen …" />;
  if (status.isError) return <ui.ErrorBox error={status.error} onRetry={() => void status.refetch()} />;
  if (!available) return <StatusBanner status={status.data} />;
  const items = (list.data?.items ?? []).filter(x => (!q || x.name.toLowerCase().includes(q.toLowerCase()))
    && (state === 'inactive' ? x.state === 'draft' || x.state === 'paused' : state === 'draft' ? hasDraft(x) : true));
  const canCreate = w.can('workflow:manage');
  const filtered = !!state || !!q;
  return (
    <section className="wf-list" aria-labelledby={`${id}-h`}>
      <header className="wf-list-head">
        <h2 id={`${id}-h`} className={showTitle ? undefined : 'wf-sr'}>Workflows</h2>
        <div className="wf-row">
          <label htmlFor={`${id}-q`} className="wf-sr">Nach Name filtern</label>
          <ui.Input id={`${id}-q`} type="search" placeholder="Name …" value={q} onChange={e => setQ(e.target.value)} />
          <label htmlFor={`${id}-s`} className="wf-sr">Zustand</label>
          <ui.Select id={`${id}-s`} value={state} onChange={e => setState(e.target.value as ListFilter)}>
            <option value="">Alle Zustände</option>
            {(Object.keys(FILTER_LABEL) as Exclude<ListFilter, ''>[]).map(s => <option key={s} value={s}>{FILTER_LABEL[s]}</option>)}
          </ui.Select>
          {canCreate && showCreate ? <ui.Button variant="primary" onClick={() => setCreating(true)}>Neu</ui.Button> : null}
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
                <tr><th scope="col">Name</th><th scope="col" className="wf-col-wide">Art</th><th scope="col" className="wf-col-wide">Bereich</th><th scope="col">Zustand</th><th scope="col" className="wf-col-wide">Letzter Run</th><th scope="col">Run-Status</th></tr>
              </thead>
              <tbody>
                {items.map(x => (
                  <tr key={x.id} {...rowLink(() => onOpen(x.id))}>
                    <th scope="row">
                      <button type="button" className="wf-name" onClick={() => onOpen(x.id)}>{x.name}</button>
                      <Sentence workflow={x} meta={meta.data} />
                    </th>
                    <td className="wf-col-wide">{KIND_LABEL[x.kind] ?? x.kind}</td>
                    <td className="wf-col-wide">{w.scopeLabel(x.scope)}</td>
                    <td>
                      <span className="wf-list-state">
                        <Badge tone={stateTone(x.state)}>{STATE_LABEL[x.state]}</Badge>
                        {hasDraft(x) ? <DraftMark onOpen={() => onOpen(x.id)} /> : null}
                        {x.openIncidents ? <Badge tone="bad">{plural(x.openIncidents, 'Vorfall', 'Vorfälle')}</Badge> : null}
                      </span>
                      {x.state === 'paused' && x.pausedReason ? <span className="wf-list-note" title={x.pausedReason}>automatisch deaktiviert</span> : null}
                    </td>
                    <LastRun workflow={x} onOpenRun={onOpenRun} />
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      {creating ? (
        <CreateDialog scope={scope ?? DEFAULT_SCOPE} meta={meta.data} templates={[...templates, ...(builtin ? builtinTemplates : [])]}
          onClose={() => setCreating(false)} onCreated={newId => { setCreating(false); (onCreated ?? onOpen)(newId); }} />
      ) : null}
    </section>
  );
}

/** Der Workflow als Satz: Auslöser und Zahl der Schritte dessen, was läuft (aktive Version, sonst Entwurf). */
function Sentence({ workflow, meta }: { workflow: WorkflowSummary; meta: WorkflowMetaJson | undefined }) {
  if (!workflow.trigger) return null;
  const steps = workflow.stepCount ?? 0;
  return <span className="wf-list-sentence">{`${describeTrigger(workflow.trigger, meta)} · ${steps ? plural(steps, 'Schritt', 'Schritte') : 'noch ohne Schritte'}`}</span>;
}

/** Letzter Run eines Workflows: Datum und Zeit (öffnen ihn) und sein Zustand; zwei Zellen. */
function LastRun({ workflow, onOpenRun }: { workflow: WorkflowSummary; onOpenRun?: (workflowId: string, runId: string) => void }) {
  // Nie aktivierte Workflows haben keine Runs (ein Probelauf zählt nicht).
  const ran = workflow.activeVersion !== null;
  const runs = useRuns({ workflowId: workflow.id, limit: 1 }, ran);
  const r = runs.data?.pages[0]?.items[0];
  if (!ran || (runs.data && !r)) return <><td className="wf-col-wide wf-muted">–</td><td className="wf-muted">–</td></>;
  if (!r) return <><td className="wf-col-wide wf-muted">…</td><td /></>;
  const at = fmtDateTime(r.startedAt);
  return (
    <>
      <td className="wf-col-wide">{onOpenRun ? <button type="button" className="wf-link" aria-label={`Run vom ${at} öffnen`} onClick={() => onOpenRun(workflow.id, r.id)}>{at}</button> : at}</td>
      <td><Badge tone={runTone(r.state)}>{RUN_STATE_LABEL[r.state]}</Badge></td>
    </>
  );
}

export interface NewWorkflowButtonProps {
  /** Nach dem Anlegen, z. B. den Editor öffnen. */
  onCreated: (workflowId: string) => void;
  /** Bereich der neuen Entwürfe (Standard `{ type: 'tenant', id: '*' }`). */
  scope?: WorkflowScopeRef;
  /** Vorlagen der App (vor denen des Baukastens). */
  templates?: WorkflowTemplate[];
  /** Vorlagen des Baukastens anbieten (Standard `true`). */
  builtinTemplates?: boolean;
}

/** «Neu» für die Leiste der App (statt über der Liste): nur mit `workflow:manage` und wenn Workflows verfügbar sind. */
export function NewWorkflowButton({ onCreated, scope, templates = [], builtinTemplates: builtin = true }: NewWorkflowButtonProps) {
  const w = useWorkflow();
  const status = useWorkflowStatus();
  const available = status.data?.available ?? false;
  const meta = useWorkflowMeta(scope ?? DEFAULT_SCOPE, available);
  const [creating, setCreating] = useState(false);
  if (!available || !w.can('workflow:manage')) return null;
  return (
    <>
      <w.ui.Button variant="primary" onClick={() => setCreating(true)}>Neu</w.ui.Button>
      {creating ? (
        <CreateDialog scope={scope ?? DEFAULT_SCOPE} meta={meta.data} templates={[...templates, ...(builtin ? builtinTemplates : [])]}
          onClose={() => setCreating(false)} onCreated={newId => { setCreating(false); onCreated(newId); }} />
      ) : null}
    </>
  );
}

function CreateDialog({ scope, meta, templates, onClose, onCreated }: {
  scope: WorkflowScopeRef; meta: WorkflowMetaJson | undefined; templates: WorkflowTemplate[]; onClose: () => void; onCreated: (id: string) => void;
}) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const create = useCreateWorkflow();
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [description, setDescription] = useState('');
  const [missing, setMissing] = useState(false);
  const [chosen, setChosen] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  // Nur Vorlagen, die im Bereich passen; die Definition entsteht beim Anlegen.
  const usable = templates.filter(t => t.build(meta) !== null);
  const template = usable.find(t => t.key === chosen);
  const pick = (key: string) => {
    setChosen(key);
    const t = usable.find(x => x.key === key);
    if (!named) setName(t?.name ?? '');
  };
  const submit = () => {
    if (create.isPending) return;
    if (!name.trim()) { setMissing(true); nameRef.current?.focus(); return; }
    const definition = template?.build(meta) ?? undefined;
    create.mutate({ name: name.trim(), description: description.trim() || undefined, scope, ...(definition ? { definition } : {}) }, { onSuccess: d => onCreated(d.id) });
  };
  return (
    <ui.Dialog title="Neuer Workflow" onClose={onClose} width={usable.length ? 760 : undefined}
      footer={<><ui.Button onClick={onClose}>Abbrechen</ui.Button><ui.Button variant="primary" aria-disabled={create.isPending || undefined} onClick={submit}>{create.isPending ? 'Wird angelegt …' : 'Entwurf anlegen'}</ui.Button></>}>
      <form onSubmit={e => { e.preventDefault(); submit(); }}>
        {usable.length ? (
          <fieldset className="wf-field wf-templates">
            <legend>Beginnen mit</legend>
            {[{ key: '', name: 'Leer', description: 'Von Hand, noch ohne Schritte: Du wählst Auslöser und Schritte selbst.' }, ...usable].map(t => (
              <label key={t.key || 'leer'} className={`wf-template${chosen === t.key ? ' chosen' : ''}`}>
                <input type="radio" className="wf-check" name={`${id}-t`} value={t.key} checked={chosen === t.key} onChange={() => pick(t.key)} />
                <span><b>{t.name}</b><span>{t.description}</span></span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="wf-field">
          <label htmlFor={`${id}-n`}>Name</label>
          <ui.Input ref={nameRef} id={`${id}-n`} data-autofocus required value={name} aria-invalid={missing || undefined} aria-describedby={missing ? `${id}-ne` : undefined}
            onChange={e => { setName(e.target.value); setNamed(!!e.target.value); setMissing(false); }} />
          {missing ? <span id={`${id}-ne`} className="wf-field-error">Gib einen Namen ein.</span> : null}
        </div>
        <div className="wf-field">
          <label htmlFor={`${id}-d`}>Beschreibung (optional)</label>
          <ui.Textarea id={`${id}-d`} rows={2} value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <p className="wf-hint">Bereich: {w.scopeLabel(scope)}. {template ? 'Was noch fehlt (z. B. wer zuständig ist), nennt der Editor.' : 'Der Entwurf startet von Hand und hat noch keine Schritte.'}</p>
      </form>
      {create.isError ? <ui.ErrorBox error={create.error} /> : null}
    </ui.Dialog>
  );
}
