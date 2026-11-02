/** Protokoll (Filter, Cursor, Lauf mit Schritten, Vorfall-Aktionen nach Recht), Einstellungen (Schalter, Grenzen) und Leiste am Bezug. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunLog, SettingsPanel, SubjectWorkflowBar, type RunJson } from '../src/index.ts';
import { json, mockFetch, renderWith, STATUS, summary, WF } from './utils.tsx';

afterEach(() => vi.unstubAllGlobals());

const run = (o: Partial<RunJson> & { id: string }): RunJson => ({
  workflowId: WF, version: 2, triggerKind: 'event', trigger: { event: { type: 'order.updated', subject: { type: 'order', id: 'o1' }, data: {} } },
  subject: { type: 'order', id: 'o1' }, actor: { id: 'bot', kind: 'client' }, startedBy: null, state: 'completed', position: null, attempts: 0,
  stepCount: 1, chainDepth: 1, parentRunId: null, correlationId: null, variables: {}, error: null, wakeAt: null,
  startedAt: '2026-11-02T08:00:00.000Z', updatedAt: '2026-11-02T08:00:02.000Z', finishedAt: '2026-11-02T08:00:02.000Z', ...o,
});
const R1 = '33333333-3333-4333-8333-333333333331';
const R2 = '33333333-3333-4333-8333-333333333332';
const R3 = '33333333-3333-4333-8333-333333333333';

describe('RunLog', () => {
  it('Liste mit Filtern und Cursor, Lauf mit Schritten, Vorfall «Nochmals versuchen»', async () => {
    let state: RunJson['state'] = 'incident';
    const { calls } = mockFetch({
      'GET /v1/workflows': () => json({ items: [summary({ name: 'Storno' })] }),
      'GET /v1/workflow-runs': req => {
        const cursor = new URL(req.url).searchParams.get('cursor');
        return cursor === 'c2' ? json({ items: [run({ id: R3 })], nextCursor: null }) : json({ items: [run({ id: R1, state: 'incident', finishedAt: null }), run({ id: R2 })], nextCursor: 'c2' });
      },
      [`GET /v1/workflow-runs/${R1}`]: () => json({
        ...run({ id: R1, state, finishedAt: null, error: state === 'incident' ? { code: 'action-failed', message: 'Bestellung ist gesperrt', path: '/steps/0' } : null }),
        steps: [{ id: 'st1', path: '/steps/0', stepId: 's1', kind: 'action', attempt: 3, state: 'failed', input: { order: 'o1', token: '[geschwärzt]' }, output: null, log: ['Versuch 3'], error: { code: 'action-failed', message: 'Bestellung ist gesperrt' }, startedAt: '2026-11-02T08:00:00.000Z', finishedAt: '2026-11-02T08:00:01.500Z' }],
      }),
      [`POST /v1/workflow-runs/${R1}/retry`]: () => { state = 'running'; return json(run({ id: R1, state: 'running', finishedAt: null })); },
    });
    renderWith(<RunLog />);
    const rows = await screen.findAllByRole('button', { name: /^Lauf vom/ });
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Vorfall', { selector: '.wf-badge' })).toBeInTheDocument();
    expect(screen.getAllByText('Storno').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Weitere Läufe laden' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Lauf vom/ })).toHaveLength(3));
    await userEvent.selectOptions(screen.getByLabelText('Zustand'), 'incident');
    await waitFor(() => expect(calls.some(c => c.path === '/v1/workflow-runs' && c.search.includes('state=incident'))).toBe(true));
    await userEvent.click((await screen.findAllByRole('button', { name: /^Lauf vom/ }))[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Bestellung ist gesperrt');
    expect(screen.getByText('Versuch 3', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/1[.,]5 s/)).toBeInTheDocument();
    expect(screen.getByText(/\[geschwärzt\]/)).toBeInTheDocument();
    const actions = screen.getByRole('group', { name: 'Vorfall lösen' });
    expect(within(actions).getAllByRole('button').map(b => b.textContent)).toEqual(['Nochmals versuchen', 'Schritt überspringen', 'Lauf abbrechen']);
    await userEvent.click(within(actions).getByRole('button', { name: 'Nochmals versuchen' }));
    expect(await screen.findByText('Nochmals versuchen: Lauf ist jetzt «Läuft».')).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([`/v1/workflow-runs/${R1}/retry`]);
  });

  it('Überspringen fragt nach; ohne workflow:operate keine Aktionen', async () => {
    const routes = {
      'GET /v1/workflows': () => json({ items: [] }),
      [`GET /v1/workflow-runs/${R1}`]: () => json({ ...run({ id: R1, state: 'incident', error: { code: 'x', message: 'kaputt' } }), steps: [] }),
      [`POST /v1/workflow-runs/${R1}/skip`]: () => json(run({ id: R1, state: 'running' })),
    };
    const { calls } = mockFetch(routes);
    const { unmount } = renderWith(<RunLog runId={R1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Schritt überspringen' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Schritt überspringen?' });
    expect(within(dialog).getByRole('button', { name: 'Zurück' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schritt überspringen' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/skip'))).toBe(true));
    unmount();
    renderWith(<RunLog runId={R1} />, { perms: ['workflow:read'] });
    expect(await screen.findByText(/fehlt dir das Recht «Vorfälle bearbeiten»/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nochmals versuchen' })).toBeNull();
  });
});

describe('SettingsPanel', () => {
  const settings = {
    enabled: false, revision: 3, overrides: {}, usage: { day: '2026-11-02', runs: 0, runsRejected: 0, steps: 0, httpCalls: 0, activeWorkflows: 0 },
    limits: { activeWorkflows: 50, runsPerDay: 10000, stepsPerRun: 50, foreachItems: 100, httpCallsPerDay: 1000, chainDepth: 5, runsPerSubjectPerMinute: 10 },
    maxLimits: { activeWorkflows: 50, runsPerDay: 10000, stepsPerRun: 50, foreachItems: 100, httpCallsPerDay: 1000, chainDepth: 5, runsPerSubjectPerMinute: 10 },
  };

  it('Schalter und Grenzen speichern (nur mit workflow:admin)', async () => {
    let available = false;
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json({ ...STATUS, available }),
      'GET /v1/workflows/settings': () => json(settings),
      'PUT /v1/workflows/settings': async req => { available = true; return json({ ...settings, ...((await req.json()) as object), revision: 4 }); },
    });
    renderWith(<SettingsPanel />);
    expect(await screen.findByText('Workflows sind noch nicht eingeschaltet.')).toBeInTheDocument();
    const sw = await screen.findByRole('switch', { name: 'Workflows für diesen Mandanten einschalten' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    const steps = screen.getByLabelText('Schritte pro Lauf');
    await userEvent.type(steps, '80');
    expect(steps).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await userEvent.clear(steps);
    await userEvent.type(steps, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Gespeichert.')).toBeInTheDocument();
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ enabled: true, revision: 3, limits: { stepsPerRun: 20 } });
    await waitFor(() => expect(screen.queryByText('Workflows sind noch nicht eingeschaltet.')).toBeNull());
  });

  it('ohne workflow:admin: Hinweis statt Formular; in der Umgebung ausgeschaltet: nur Hinweis', async () => {
    mockFetch({ 'GET /v1/workflows/status': () => json({ ...STATUS, available: false }) });
    const { unmount } = renderWith(<SettingsPanel />, { perms: ['workflow:read'] });
    expect(await screen.findByText(/Zum Einrichten fehlt dir das Recht «Workflows einrichten»/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    unmount();
    mockFetch({ 'GET /v1/workflows/status': () => json({ ...STATUS, enabled: false, available: false }) });
    renderWith(<SettingsPanel />);
    expect(await screen.findByText('Workflows sind in dieser Umgebung ausgeschaltet.')).toBeInTheDocument();
  });
});

describe('SubjectWorkflowBar', () => {
  const MANUAL = summary({ id: WF, name: 'Storno', state: 'active', activeVersion: 2 });
  const EVENT = summary({ id: '44444444-4444-4444-8444-444444444444', name: 'Automatisch', state: 'active', activeVersion: 1 });

  it('startet einen manuellen Workflow mit Formular am Bezug und zeigt die letzten Läufe', async () => {
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows': () => json({ items: [MANUAL, EVENT] }),
      [`GET /v1/workflows/${WF}/versions/2`]: () => json({ version: 2, definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: { label: 'Stornieren', form: [{ key: 'reason', label: 'Grund', type: 'text', required: true }] } }, steps: [] } }),
      [`GET /v1/workflows/${EVENT.id}/versions/1`]: () => json({ version: 1, definition: { schemaVersion: 1, kind: 'automation', trigger: { event: 'order.updated' }, steps: [] } }),
      'GET /v1/workflow-runs': () => json({ items: [run({ id: R1 })], nextCursor: null }),
      [`POST /v1/workflows/${WF}/runs`]: () => json(run({ id: R2, state: 'running' }), 201),
    });
    const onOpenRun = vi.fn();
    renderWith(<SubjectWorkflowBar subject={{ type: 'order', id: 'o1' }} onOpenRun={onOpenRun} />);
    const start = await screen.findByRole('button', { name: 'Stornieren' });
    expect(screen.queryByRole('button', { name: 'Automatisch' })).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Letzte Läufe' })).getByText('Erfolgreich')).toBeInTheDocument();
    expect(calls.find(c => c.path === '/v1/workflow-runs')!.search).toBe('?subjectType=order&subjectId=o1&limit=5');
    await userEvent.click(start);
    const dialog = screen.getByRole('dialog', { name: 'Stornieren' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Starten' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Bitte ausfüllen: «Grund».');
    await userEvent.type(within(dialog).getByLabelText(/^Grund/), 'Kundin wünscht es');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Starten' }));
    expect(await screen.findByText('«Stornieren» gestartet.')).toBeInTheDocument();
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ subject: { type: 'order', id: 'o1' }, input: { reason: 'Kundin wünscht es' } });
    await userEvent.click(within(screen.getByRole('list', { name: 'Letzte Läufe' })).getByRole('button', { name: 'Storno' }));
    expect(onOpenRun).toHaveBeenCalledWith(R1);
  });

  it('ohne workflow:run keine Knöpfe; ohne verfügbares Modul nichts', async () => {
    mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows': () => json({ items: [MANUAL] }),
      [`GET /v1/workflows/${WF}/versions/2`]: () => json({ version: 2, definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [] } }),
      'GET /v1/workflow-runs': () => json({ items: [], nextCursor: null }),
    });
    const { unmount } = renderWith(<SubjectWorkflowBar subject={{ type: 'order', id: 'o1' }} />, { perms: ['workflow:read'] });
    expect(await screen.findByText(/fehlt dir das Recht «Workflows von Hand starten»/)).toBeInTheDocument();
    expect(screen.getByText('Noch keine Läufe zu diesem Bezug.')).toBeInTheDocument();
    unmount();
    mockFetch({ 'GET /v1/workflows/status': () => json({ ...STATUS, available: false }) });
    const { container } = renderWith(<SubjectWorkflowBar subject={{ type: 'order', id: 'o1' }} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
