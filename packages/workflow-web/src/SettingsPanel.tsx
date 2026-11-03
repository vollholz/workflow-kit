/**
 * Einstellungen des Mandanten (Konzept 4.9): Opt-in (Schalter) und Grenzen (nur senken, höchstens die Vorgabe der
 * App), Zähler des Tages. Nur mit `workflow:admin`. Dazu `StatusBanner`: Hinweis, wenn das Modul in der Umgebung
 * ausgeschaltet oder für den Mandanten noch nicht eingeschaltet ist.
 */
import { useEffect, useId, useState } from 'react';
import { useSaveWorkflowSettings, useWorkflowSettings, useWorkflowStatus } from './api.ts';
import { useWorkflow } from './provider.tsx';
import type { WorkflowLimitsJson, WorkflowStatusJson } from './types.ts';
import { MissingRight, plural } from './ui.tsx';

const LIMIT_LABEL: Record<keyof WorkflowLimitsJson, string> = {
  activeWorkflows: 'Aktive Workflows', runsPerDay: 'Läufe pro Tag', stepsPerRun: 'Schritte pro Lauf', foreachItems: 'Einträge je «Für jedes»',
  httpCallsPerDay: 'Aufrufe nach aussen pro Tag', chainDepth: 'Kettentiefe (Workflow löst Workflow aus)', runsPerSubjectPerMinute: 'Läufe je Bezug und Minute',
};

/** Hinweis zum Zustand des Moduls; nichts, wenn alles verfügbar ist. */
export function StatusBanner({ status, onSetup }: { status: WorkflowStatusJson | undefined; onSetup?: () => void }) {
  const w = useWorkflow();
  if (!status || status.available) return null;
  return (
    <div className="wf-banner" role="status">
      {!status.enabled ? (
        <><b>Workflows sind in dieser Umgebung ausgeschaltet.</b><span>Die Betreiber der Anwendung können sie einschalten.</span></>
      ) : (
        <>
          <b>Workflows sind noch nicht eingeschaltet.</b>
          <span>{w.can('workflow:admin') ? 'Schalte sie in den Einstellungen ein, um Automationen zu nutzen.' : 'Die Administration kann sie in den Einstellungen einschalten.'}</span>
          {onSetup && w.can('workflow:admin') ? <w.ui.Button size="sm" onClick={onSetup}>Zu den Einstellungen</w.ui.Button> : null}
        </>
      )}
    </div>
  );
}

export function SettingsPanel() {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const admin = w.can('workflow:admin');
  const status = useWorkflowStatus();
  const settings = useWorkflowSettings(admin && !!status.data?.enabled);
  const save = useSaveWorkflowSettings();
  const [enabled, setEnabled] = useState(false);
  const [limits, setLimits] = useState<Partial<Record<keyof WorkflowLimitsJson, string>>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.enabled);
    setLimits(Object.fromEntries(Object.entries(settings.data.overrides).map(([k, v]) => [k, String(v)])));
  }, [settings.data]);
  if (status.isPending) return <ui.Loading label="Einstellungen werden geladen …" />;
  if (status.isError) return <ui.ErrorBox error={status.error} onRetry={() => void status.refetch()} />;
  const head = <h2 id={`${id}-h`}>Workflows einrichten</h2>;
  if (!status.data.enabled) return <section aria-labelledby={`${id}-h`} className="wf-settings">{head}<StatusBanner status={status.data} /></section>;
  if (!admin) return <section aria-labelledby={`${id}-h`} className="wf-settings">{head}<StatusBanner status={status.data} /><MissingRight perm="workflow:admin" lead="Zum Einrichten" /></section>;
  if (settings.isPending) return <ui.Loading label="Einstellungen werden geladen …" />;
  if (settings.isError) return <ui.ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />;
  const s = settings.data;
  const keys = Object.keys(LIMIT_LABEL) as (keyof WorkflowLimitsJson)[];
  const invalid = keys.filter(k => {
    const v = limits[k];
    return v !== undefined && v !== '' && (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > s.maxLimits[k]);
  });
  const submit = () => {
    setSaved(false);
    const out: Partial<WorkflowLimitsJson> = {};
    for (const k of keys) if (limits[k]) out[k] = Number(limits[k]);
    save.mutate({ enabled, revision: s.revision, limits: out }, { onSuccess: () => { setSaved(true); void status.refetch(); } });
  };
  return (
    <section className="wf-settings" aria-labelledby={`${id}-h`}>
      {head}
      <StatusBanner status={status.data} />
      <div className="wf-switch-row">
        <button type="button" role="switch" id={`${id}-on`} aria-checked={enabled} className={`wf-switch${enabled ? ' on' : ''}`} onClick={() => setEnabled(e => !e)}>
          <span aria-hidden="true" />
        </button>
        <label htmlFor={`${id}-on`}>Workflows für diesen Mandanten einschalten</label>
      </div>
      <p className="wf-hint">Ausgeschaltet starten keine Workflows mehr; Entwürfe, Versionen und Protokolle bleiben erhalten.</p>
      <fieldset className="wf-limits">
        <legend>Grenzen (leer = Vorgabe der Anwendung)</legend>
        {keys.map(k => (
          <div key={k} className="wf-field">
            <label htmlFor={`${id}-${k}`}>{LIMIT_LABEL[k]}</label>
            <ui.Input id={`${id}-${k}`} type="number" min={1} max={s.maxLimits[k]} className="wf-num" placeholder={String(s.maxLimits[k])}
              value={limits[k] ?? ''} aria-invalid={invalid.includes(k)} aria-describedby={`${id}-${k}-h`}
              onChange={e => setLimits(l => ({ ...l, [k]: e.target.value }))} />
            <span id={`${id}-${k}-h`} className="wf-hint">{`Höchstens ${s.maxLimits[k]}; wirksam ${s.limits[k]}`}</span>
          </div>
        ))}
      </fieldset>
      <p className="wf-hint">{`Heute: ${plural(s.usage.runs, 'Lauf', 'Läufe')} (${s.usage.runsRejected} abgewiesen), ${plural(s.usage.steps, 'Schritt', 'Schritte')}, ${plural(s.usage.httpCalls, 'Aufruf', 'Aufrufe')} nach aussen, ${plural(s.usage.activeWorkflows, 'aktiver Workflow', 'aktive Workflows')}.`}</p>
      <div className="wf-row">
        <ui.Button variant="primary" disabled={save.isPending || invalid.length > 0} onClick={submit}>{save.isPending ? 'Speichert …' : 'Speichern'}</ui.Button>
        <span role="status" aria-live="polite" className="wf-ok">{saved ? 'Gespeichert.' : ''}</span>
      </div>
      {save.isError ? <ui.ErrorBox error={save.error} /> : null}
    </section>
  );
}
