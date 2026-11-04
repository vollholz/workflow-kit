/**
 * Bausteine für die Reiter eines Workflows neben dem Ablauf (UX-Neukonzept Etappen 2 und 4): `VersionList` (aktivierte
 * Versionen mit Datum, wer aktiviert hat und in wessen Namen sie handeln, darüber der Entwurf mit noch nicht wirksamen
 * Änderungen; je Version Vergleich, Ablauf und «Als Entwurf übernehmen») und `WorkflowSettings` (Name und Beschreibung
 * ändern; Art, Bereich, Akteur und Zustand zum Nachlesen). Versionsnummern stehen nur in `VersionList`.
 *
 * Regeln:
 * - Name und Beschreibung gehören nicht zur Version; Speichern wirkt sofort, mit `If-Match` wie der Entwurf. Ohne
 *   `workflow:manage` oder archiviert ist alles nur lesbar. Fehlt der Name, meldet das Formular es am Feld.
 * - Vergleich: Was eine Version gegenüber der vorherigen (oder einer anderen) geändert hat, oder was der Entwurf gegenüber
 *   ihr ändert – in denselben Worten wie «Änderungen ansehen».
 * - «Als Entwurf übernehmen …» ersetzt Auslöser und Schritte des Entwurfs durch die der Version (fragt nach, wenn der
 *   Entwurf abweicht); wirksam wird es erst mit dem Aktivieren. Die laufende Version bleibt unberührt.
 */
import { useId, useRef, useState } from 'react';
import { useSaveWorkflow, useWorkflowDetail, useWorkflowMeta, useWorkflowVersion, useWorkflowVersions } from './api.ts';
import { ChangesList, diffDefinitions } from './changes.tsx';
import { FlowView, type FlowSelection } from './flow.tsx';
import { contextFields, DataLabels } from './placeholders.tsx';
import { ActorName, useWorkflow } from './provider.tsx';
import { EditorCtx, type EditorContext } from './steps.tsx';
import { describeTrigger } from './trigger.tsx';
import type { AutomationDefinition, VersionJson, WorkflowDetail, WorkflowMetaJson } from './types.ts';
import { Badge, DraftMark, fmtDateTime, hasDraft, KIND_LABEL, MissingRight, rowLink, STATE_LABEL, stateTone } from './ui.tsx';

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, (x as Record<string, unknown>)[k]])) : x);
const isAutomation = (d: unknown): d is AutomationDefinition =>
  !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === 'automation' && Array.isArray((d as { steps?: unknown }).steps);

/**
 * Aktivierte Versionen eines Workflows, neueste zuerst – die einzige Stelle mit Versionsnummern. Darüber steht der
 * Entwurf, solange er Änderungen hat, die noch nicht wirken («wird Version n»). Eine Version öffnet Vergleich, Ablauf
 * und «Als Entwurf übernehmen».
 */
export function VersionList({ workflowId, onAdopted, onOpenDraft }: {
  workflowId: string;
  /** Nach «Als Entwurf übernehmen» (z. B. zum Editor wechseln). */
  onAdopted?: () => void;
  /** Klick auf die Zeile «Entwurf» (z. B. zum Editor wechseln). */
  onOpenDraft?: () => void;
}) {
  const { ui } = useWorkflow();
  const v = useWorkflowVersions(workflowId);
  const detail = useWorkflowDetail(workflowId);
  const active = useWorkflowVersion(workflowId, detail.data?.activeVersion ?? null);
  const [open, setOpen] = useState<number | null>(null);
  if (v.isPending) return <ui.Loading label="Versionen werden geladen …" />;
  if (v.isError) return <ui.ErrorBox error={v.error} onRetry={() => void v.refetch()} />;
  if (!v.data.items.length) return <ui.Empty title="Noch keine Version">Eine Version entsteht beim Aktivieren des Entwurfs.</ui.Empty>;
  const items = v.data.items;
  const d = detail.data;
  const draftRow = !!d && !!active.data && hasDraft(d, canonical(active.data.definition) !== canonical(d.definition));
  const next = Math.max(...items.map(x => x.version)) + 1;
  return (
    <div className="wf-versions">
      <table className="wf-table" aria-label="Versionen">
        <thead><tr><th scope="col">Version</th><th scope="col">Aktiviert</th><th scope="col">von</th><th scope="col">Handelt als</th></tr></thead>
        <tbody>
          {draftRow ? (
            <tr {...(onOpenDraft ? rowLink(onOpenDraft) : {})}>
              <th scope="row">{onOpenDraft ? <button type="button" className="wf-name" onClick={onOpenDraft}><DraftMark /></button> : <DraftMark />}</th>
              <td className="wf-muted">{`noch nicht aktiv · wird Version ${next}`}</td>
              <td className="wf-muted">–</td>
              <td className="wf-muted">–</td>
            </tr>
          ) : null}
          {items.map(x => (
            <tr key={x.version} aria-current={open === x.version || undefined} {...rowLink(() => setOpen(o => (o === x.version ? null : x.version)))}>
              <th scope="row">
                <button type="button" className="wf-name" aria-expanded={open === x.version} onClick={() => setOpen(o => (o === x.version ? null : x.version))}>Version {x.version}</button>
                {x.active ? <> <Badge tone="ok">Aktiv</Badge></> : d && d.state !== 'active' && d.activeVersion === x.version ? <> <Badge tone="muted">zuletzt aktiv</Badge></> : null}
              </th>
              <td>{fmtDateTime(x.activatedAt)}</td>
              <td><ActorName actor={x.activatedBy} /></td>
              <td><ActorName actor={x.actor} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {open === null ? null : detail.data ? <VersionDetail key={open} detail={detail.data} version={open} versions={items} onAdopted={onAdopted} />
        : detail.isError ? <ui.ErrorBox error={detail.error} onRetry={() => void detail.refetch()} /> : <ui.Loading label="Version wird geladen …" />}
    </div>
  );
}

type Against = { kind: 'version'; version: number } | { kind: 'draft' };

/** Eine Version: Vergleich (mit einer anderen Version oder dem Entwurf), Ablauf zum Ansehen, «Als Entwurf übernehmen …». */
function VersionDetail({ detail, version, versions, onAdopted }: { detail: WorkflowDetail; version: number; versions: VersionJson[]; onAdopted?: () => void }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const others = versions.map(x => x.version).filter(n => n !== version);
  const previous = others.filter(n => n < version).sort((a, b) => b - a)[0];
  const [against, setAgainst] = useState<Against>(previous !== undefined ? { kind: 'version', version: previous } : { kind: 'draft' });
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const mine = useWorkflowVersion(detail.id, version);
  const other = useWorkflowVersion(detail.id, against.kind === 'version' ? against.version : null);
  const active = useWorkflowVersion(detail.id, detail.activeVersion);
  const meta = useWorkflowMeta(detail.scope);
  const save = useSaveWorkflow(detail.id);
  const def = mine.data?.definition;
  const draft = detail.definition;
  const same = !!def && canonical(def) === canonical(draft);
  // Gehen Änderungen verloren? Ja, wenn der Entwurf von der aktiven Version abweicht (ohne aktive Version: wenn er Schritte hat).
  const loses = detail.activeVersion === null ? isAutomation(draft) && draft.steps.length > 0 : !!active.data && canonical(active.data.definition) !== canonical(draft);
  const canAdopt = w.can('workflow:manage') && detail.state !== 'archived';
  const before = against.kind === 'draft' ? def : other.data?.definition;
  const after = against.kind === 'draft' ? draft : def;
  const changes = isAutomation(before) && isAutomation(after) ? diffDefinitions(before, after, meta.data) : null;
  const adopt = () => {
    if (!def) return;
    save.mutate({ revision: detail.revision, definition: def }, {
      onSuccess: () => { setAsking(false); setDone(`Der Entwurf entspricht jetzt Version ${version}. Er wirkt erst nach dem Aktivieren.`); onAdopted?.(); },
    });
  };
  const value = against.kind === 'draft' ? 'draft' : String(against.version);
  return (
    <section className="wf-version" aria-labelledby={`${id}-h`}>
      <header className="wf-version-head">
        <h3 id={`${id}-h`}>Version {version}</h3>
        {canAdopt && def ? (same
          ? <span className="wf-muted wf-small">Der Entwurf entspricht dieser Version.</span>
          : <ui.Button size="sm" onClick={() => setAsking(true)}>Als Entwurf übernehmen …</ui.Button>) : null}
      </header>
      <div role="status" aria-live="polite" className="wf-ok">{done}</div>
      {mine.isPending ? <ui.Loading label="Version wird geladen …" /> : mine.isError ? <ui.ErrorBox error={mine.error} onRetry={() => void mine.refetch()} /> : (
        <>
          <div className="wf-field wf-version-against">
            <label htmlFor={`${id}-a`}>Vergleichen</label>
            <ui.Select id={`${id}-a`} value={value} onChange={e => setAgainst(e.target.value === 'draft' ? { kind: 'draft' } : { kind: 'version', version: Number(e.target.value) })}>
              {others.map(n => <option key={n} value={String(n)}>{n < version ? `Version ${version} gegenüber Version ${n}` : `Version ${version} gegenüber der neueren Version ${n}`}</option>)}
              <option value="draft">{`Entwurf gegenüber Version ${version}`}</option>
            </ui.Select>
          </div>
          {against.kind === 'version' && other.isPending ? <ui.Loading label="Version wird geladen …" />
            : changes ? <ChangesList changes={changes} label={against.kind === 'draft' ? `Entwurf gegenüber Version ${version}` : `Version ${version} gegenüber Version ${against.version}`}
              empty={against.kind === 'draft' ? `Der Entwurf entspricht Version ${version}.` : 'Keine Unterschiede.'} />
              : <p className="wf-muted">Diese Art von Workflow lässt sich noch nicht vergleichen.</p>}
          {isAutomation(def) ? (
            <details className="wf-version-flow">
              <summary>{`Ablauf von Version ${version} ansehen`}</summary>
              <VersionFlow definition={def} meta={meta.data} />
            </details>
          ) : null}
        </>
      )}
      {asking ? (
        <ui.Dialog title={`Version ${version} als Entwurf übernehmen?`} role="alertdialog" onClose={() => setAsking(false)}
          footer={<><ui.Button data-autofocus onClick={() => setAsking(false)}>Abbrechen</ui.Button>
            <ui.Button variant="primary" aria-disabled={save.isPending || undefined} onClick={() => { if (!save.isPending) adopt(); }}>{save.isPending ? 'Wird übernommen …' : 'Übernehmen'}</ui.Button></>}>
          <p>{`Auslöser und Schritte des Entwurfs werden durch die von Version ${version} ersetzt.${loses ? ' Bisherige Änderungen am Entwurf gehen verloren.' : ''}`}</p>
          <p className="wf-hint">{detail.activeVersion !== null ? `Wirksam wird es erst mit dem Aktivieren; bis dahin läuft Version ${detail.activeVersion} unverändert weiter.` : 'Wirksam wird es erst mit dem Aktivieren.'}</p>
          {save.isError ? <ui.ErrorBox error={save.error} /> : null}
        </ui.Dialog>
      ) : null}
    </section>
  );
}

/** Ablauf einer Version, nur zum Ansehen (Karten öffnen nichts). */
function VersionFlow({ definition, meta }: { definition: AutomationDefinition; meta: WorkflowMetaJson | undefined }) {
  const w = useWorkflow();
  // Zum Ansehen: anfangs ist nichts gewählt
  const [sel, setSel] = useState<FlowSelection>({ kind: 'insert', list: '', index: -1 });
  const subjectLabel = (type: string) => w.subjects[type]?.label ?? meta?.subjectTypes.find(s => s.type === type)?.label ?? type;
  const fields = contextFields(definition, meta, subjectLabel);
  const ctx: EditorContext = { meta, fields, allFields: fields, errors: [], warnings: [], readOnly: true, steps: definition.steps, newId: () => '' };
  return (
    <EditorCtx.Provider value={ctx}>
      <DataLabels.Provider value={fields}>
        <FlowView steps={definition.steps} trigger={{ value: definition.trigger, text: describeTrigger(definition.trigger, meta) }} sel={sel} locked
          onSelect={s => { if (s.kind !== 'insert') setSel(s); }} onAddFirst={() => {}} onMove={() => null} onRemove={() => {}} onOpen={() => {}} />
      </DataLabels.Provider>
    </EditorCtx.Provider>
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
            <span className="wf-hint">Name und Beschreibung wirken sofort, ohne Aktivieren.</span>
          </div>
          {!readOnly ? <ui.Button type="submit" variant="primary" aria-disabled={save.isPending || undefined}>{save.isPending ? 'Speichert …' : 'Speichern'}</ui.Button> : null}
        </fieldset>
      </form>
      <div role="status" aria-live="polite" className="wf-ok">{done ? 'Gespeichert.' : null}</div>
      {save.isError ? <ui.ErrorBox error={save.error} /> : null}
      <dl className="wf-summary">
        <dt>Zustand</dt><dd><Badge tone={stateTone(x.state)}>{STATE_LABEL[x.state]}</Badge>{x.activeVersion === null ? ' · noch nie aktiviert' : ''}</dd>
        <dt>Art</dt><dd>{KIND_LABEL[x.kind]}</dd>
        <dt>Bereich</dt><dd>{w.scopeLabel(x.scope)}</dd>
        <dt>Handelt als</dt><dd>{x.actor ? <ActorName actor={x.actor} /> : 'wird beim Aktivieren gewählt'}<span className="wf-hint"> – ändert sich nur beim Aktivieren.</span></dd>
        <dt>Angelegt</dt><dd>{fmtDateTime(x.createdAt)} von <ActorName actor={x.createdBy} /></dd>
      </dl>
    </section>
  );
}
