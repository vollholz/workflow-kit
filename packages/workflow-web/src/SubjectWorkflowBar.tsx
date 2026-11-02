/**
 * Leiste an einem Bezug (Konzept Abschnitt 10, «Am Bezug»): Knöpfe der aktiven Workflows mit manuellem Auslöser
 * (mit Eingabeformular, falls definiert) und die letzten Läufe zu diesem Bezug. Zustandswechsel, offene Aufgaben und
 * Fälle kommen in späteren Stufen dazu.
 *
 * Regeln: Ohne verfügbares Modul zeigt die Leiste nichts. Die Liste der Knöpfe stammt aus den aktiven Versionen
 * (`GET /workflows?state=active`, danach je Workflow die aktive Version); welche davon zu diesem Bezug passen,
 * entscheidet die App mit `filter` (z. B. nach Bereich), sonst alle. Starten nur mit `workflow:run`.
 */
import { useQueries } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { missingRequired, FieldForm } from './forms.tsx';
import { useRuns, useStartRun, useWorkflows, useWorkflowStatus, wfKeys, wfRequest } from './api.ts';
import { useWorkflow, type WorkflowSubjectRef } from './provider.tsx';
import type { FieldDefJson, VersionJson, WorkflowSummary } from './types.ts';
import { Badge, fmtDateTime, RUN_STATE_LABEL, runTone } from './ui.tsx';

export interface SubjectWorkflowBarProps {
  subject: WorkflowSubjectRef;
  /** Welche Workflows an diesem Bezug angeboten werden (Standard: alle aktiven mit manuellem Auslöser). */
  filter?: (workflow: WorkflowSummary) => boolean;
  /** Lauf im Protokoll öffnen. */
  onOpenRun?: (runId: string) => void;
  /** Anzahl der letzten Läufe (Standard 5). */
  recent?: number;
}

interface ManualWorkflow { workflow: WorkflowSummary; label: string; form: FieldDefJson[] }

export function SubjectWorkflowBar({ subject, filter, onOpenRun, recent = 5 }: SubjectWorkflowBarProps) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const status = useWorkflowStatus();
  const available = !!status.data?.available;
  const active = useWorkflows({ state: 'active' }, available);
  const candidates = (active.data?.items ?? []).filter(x => x.kind === 'automation' && x.activeVersion !== null && (!filter || filter(x)));
  const versions = useQueries({
    queries: candidates.map(x => ({
      queryKey: wfKeys.version(x.id, x.activeVersion!), staleTime: Infinity,
      queryFn: ({ signal }: { signal: AbortSignal }) => wfRequest<VersionJson>(w, 'GET', `/workflows/${encodeURIComponent(x.id)}/versions/${x.activeVersion}`, { signal }),
    })),
  });
  const runs = useRuns({ subjectType: subject.type, subjectId: subject.id, limit: recent }, available);
  const start = useStartRun();
  const [open, setOpen] = useState<ManualWorkflow | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!available) return null;
  const manual: ManualWorkflow[] = [];
  candidates.forEach((x, i) => {
    const def = versions[i]?.data?.definition as { trigger?: { manual?: { label?: string; form?: FieldDefJson[] } } } | undefined;
    if (def?.trigger?.manual) manual.push({ workflow: x, label: def.trigger.manual.label || x.name, form: def.trigger.manual.form ?? [] });
  });
  const names = new Map((active.data?.items ?? []).map(x => [x.id, x.name]));
  const canRun = w.can('workflow:run');
  const run = (m: ManualWorkflow, input: Record<string, unknown> = {}) => start.mutate({ workflowId: m.workflow.id, subject, input }, {
    onSuccess: () => { setOpen(null); setDone(`«${m.label}» gestartet.`); },
  });
  const items = runs.data?.pages[0]?.items ?? [];
  return (
    <section className="wf-bar" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Workflows</h3>
      {manual.length ? (
        canRun ? (
          <div className="wf-row" role="group" aria-label="Von Hand starten">
            {manual.map(m => (
              <ui.Button key={m.workflow.id} size="sm" disabled={start.isPending} onClick={() => { setDone(null); if (m.form.length) setOpen(m); else run(m); }}>{m.label}</ui.Button>
            ))}
          </div>
        ) : <p className="wf-muted wf-small">Zum Starten fehlt dir das Recht «Workflows von Hand starten».</p>
      ) : active.isPending || versions.some(v => v.isPending) ? null : <p className="wf-muted wf-small">Kein Workflow lässt sich hier von Hand starten.</p>}
      <div role="status" aria-live="polite" className="wf-ok">{done}</div>
      {start.isError && !open ? <ui.ErrorBox error={start.error} /> : null}
      <h4>Letzte Läufe</h4>
      {runs.isPending ? <ui.Loading label="Läufe werden geladen …" /> : runs.isError ? <ui.ErrorBox error={runs.error} /> : items.length ? (
        <ul className="wf-plain" aria-label="Letzte Läufe">
          {items.map(r => (
            <li key={r.id} className="wf-row">
              <Badge tone={runTone(r.state)}>{RUN_STATE_LABEL[r.state]}</Badge>
              {onOpenRun ? <button type="button" className="wf-link" onClick={() => onOpenRun(r.id)}>{names.get(r.workflowId) ?? 'Workflow'}</button> : <span>{names.get(r.workflowId) ?? 'Workflow'}</span>}
              <span className="wf-muted wf-small">{fmtDateTime(r.startedAt)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="wf-muted wf-small">Noch keine Läufe zu diesem Bezug.</p>}
      {open ? <StartDialog m={open} busy={start.isPending} error={start.error} onClose={() => { setOpen(null); start.reset(); }} onStart={input => run(open, input)} /> : null}
    </section>
  );
}

function StartDialog({ m, busy, error, onClose, onStart }: { m: ManualWorkflow; busy: boolean; error: Error | null; onClose: () => void; onStart: (input: Record<string, unknown>) => void }) {
  const { ui } = useWorkflow();
  const [value, setValue] = useState<Record<string, unknown>>({});
  const [tried, setTried] = useState(false);
  const missing = missingRequired(m.form, value);
  const submit = () => { setTried(true); if (!missing.length) onStart(value); };
  return (
    <ui.Dialog title={m.label} onClose={onClose}
      footer={<><ui.Button onClick={onClose}>Abbrechen</ui.Button><ui.Button variant="primary" disabled={busy} onClick={submit}>{busy ? 'Wird gestartet …' : 'Starten'}</ui.Button></>}>
      <form onSubmit={e => { e.preventDefault(); submit(); }}>
        <FieldForm fields={m.form} value={value} onChange={setValue} />
      </form>
      {tried && missing.length ? <p className="wf-bad" role="alert">Bitte ausfüllen: {missing.map(l => `«${l}»`).join(', ')}.</p> : null}
      {error ? <ui.ErrorBox error={error} /> : null}
    </ui.Dialog>
  );
}
