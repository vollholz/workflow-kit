/** Protokoll (Filter, Cursor, Lauf mit Schritten, Vorfall-Aktionen nach Recht), Einstellungen (Schalter, Grenzen) und Leiste am Bezug. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunLog, SettingsPanel, SubjectWorkflowBar, type RunJson } from '../src/index.ts';
import { json, META, mockFetch, renderWith, STATUS, summary, WF } from './utils.tsx';

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
  const DEF = {
    schemaVersion: 1, kind: 'automation', trigger: { event: 'order.updated' },
    steps: [{ id: 's1', action: 'order.cancel', input: { order: '{{subject.id}}', reason: 'Zahlung fehlt' } }, { id: 's2', end: { result: 'completed' } }],
  };
  const detailRoutes = {
    [`GET /v1/workflows/${WF}`]: () => json({ ...summary({ name: 'Storno', state: 'active', activeVersion: 2 }), definition: DEF }),
    [`GET /v1/workflows/${WF}/versions/2`]: () => json({ version: 2, definition: DEF }),
    'GET /v1/workflows/meta': () => json(META),
  };

  it('Liste mit Filtern und Cursor; Lauf als Ablauf mit Vorfall am Schritt, «Nochmals versuchen»', async () => {
    let state: RunJson['state'] = 'incident';
    const { calls } = mockFetch({
      ...detailRoutes,
      'GET /v1/workflows': () => json({ items: [summary({ name: 'Storno' })] }),
      'GET /v1/workflow-runs': req => {
        const cursor = new URL(req.url).searchParams.get('cursor');
        return cursor === 'c2' ? json({ items: [run({ id: R3 })], nextCursor: null }) : json({ items: [run({ id: R1, state: 'incident', finishedAt: null }), run({ id: R2 })], nextCursor: 'c2' });
      },
      [`GET /v1/workflow-runs/${R1}`]: () => json({
        ...run({ id: R1, state, finishedAt: null, position: '/steps/0', error: state === 'incident' ? { code: 'action-failed', message: 'Bestellung ist gesperrt', path: '/steps/0' } : null }),
        steps: [{ id: 'st1', path: '/steps/0', stepId: 's1', kind: 'action', attempt: 3, state: 'failed', input: { order: 'o1', token: '[geschwärzt]' }, output: null, log: ['Versuch 3'], error: { code: 'action-failed', message: 'Bestellung ist gesperrt' }, startedAt: '2026-11-02T08:00:00.000Z', finishedAt: '2026-11-02T08:00:01.500Z' }],
      }),
      [`POST /v1/workflow-runs/${R1}/retry`]: () => { state = 'running'; return json(run({ id: R1, state: 'running', finishedAt: null })); },
    });
    renderWith(<RunLog />);
    const rows = await screen.findAllByRole('button', { name: /^Run vom/ });
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Vorfall', { selector: '.wf-badge' })).toBeInTheDocument();
    expect(screen.getAllByText('Storno').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Weitere Runs laden' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Run vom/ })).toHaveLength(3));
    await userEvent.selectOptions(screen.getByLabelText('Zustand'), 'incident');
    await waitFor(() => expect(calls.some(c => c.path === '/v1/workflow-runs' && c.search.includes('state=incident'))).toBe(true));
    // Die ganze Zeile öffnet den Lauf (hier ein Klick auf den Zustand)
    const first = (await screen.findAllByRole('button', { name: /^Run vom/ }))[0]!.closest('tr')!;
    expect(within(first).getByText('Vorfall', { selector: '.wf-badge' })).toHaveClass('bad');
    await userEvent.click(within(first).getByText('Vorfall', { selector: '.wf-badge' }));

    // Kopf: Zustand mit Ort, Version, Start durch das Ereignis; Ablauf aus der Version des Laufs
    expect(await screen.findByRole('heading', { name: 'Run von «Storno»' })).toBeInTheDocument();
    const bar = screen.getByRole('group', { name: 'Zustand des Runs' });
    expect(bar).toHaveTextContent('Vorfall');
    expect(await within(bar).findByText('hält an Schritt 1 an')).toBeInTheDocument();
    expect(screen.getByText('Gestartet').nextElementSibling).toHaveTextContent(/· bei «Bestellung geändert»$/);
    const card = await screen.findByRole('button', { name: 'Schritt 1: Aktion «Bestellung stornieren», im Run fehlgeschlagen' });
    expect(card).toHaveTextContent('Bestellung ist gesperrt');
    expect(screen.getByRole('button', { name: 'Schritt 2: Beenden, im Run noch nicht erreicht' })).toBeInTheDocument();
    // Vorfall am Schritt; gewählt ist dieser Schritt, mit Versuchen, Protokoll, Dauer und Technik
    const incident = screen.getByRole('group', { name: 'Vorfall an Schritt 1' });
    expect(incident).toHaveTextContent('Vorfall: Bestellung ist gesperrt');
    const side = screen.getByRole('complementary', { name: 'Schritt im Run' });
    expect(within(side).getByText('Versuche').nextElementSibling).toHaveTextContent('3');
    expect(within(side).getByText('Versuch 3')).toBeInTheDocument();
    expect(within(side).getByText(/1[.,]5 s/)).toBeInTheDocument();
    expect(within(side).getByText(/\[geschwärzt\]/)).toBeInTheDocument();
    expect(within(incident).getAllByRole('button').map(b => b.textContent)).toEqual(['Nochmals versuchen', 'Schritt überspringen …']);
    // «Lauf abbrechen» steht im Menü
    await userEvent.click(within(bar).getByRole('button', { name: 'Weitere Aktionen' }));
    expect(screen.getByRole('menuitem', { name: 'Run abbrechen …' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(incident).getByRole('button', { name: 'Nochmals versuchen' }));
    expect(await screen.findByText('Nochmals versuchen: Run ist jetzt «Läuft».')).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([`/v1/workflow-runs/${R1}/retry`]);
  });

  it('Lauf als Ablauf: Weg nach dem Entscheid mit Namen, der Lauf wartet am nächsten Schritt', async () => {
    const def = {
      schemaVersion: 2, kind: 'automation', trigger: { manual: {} },
      steps: [
        { id: 'ok', approval: { title: 'Freigabe', approvers: [{ actor: { id: 'cara', kind: 'person' } }], mode: 'first' }, branches: { rejected: [{ id: 'note', set: { grund: 'abgelehnt' } }] } },
        { id: 'fix', task: { title: 'Nachbessern', assignee: { actor: { id: 'ben', kind: 'person' } } } },
      ],
    };
    const step = (o: Record<string, unknown>) => ({ id: String(o.path), attempt: 1, input: null, output: null, log: [], error: null, startedAt: '2026-11-02T08:00:00.000Z', finishedAt: '2026-11-02T08:05:00.000Z', ...o });
    mockFetch({
      [`GET /v1/workflows/${WF}`]: () => json({ ...summary({ name: 'Freigabe', state: 'active', activeVersion: 2 }), definition: def }),
      [`GET /v1/workflows/${WF}/versions/2`]: () => json({ version: 2, definition: def }),
      'GET /v1/workflows/meta': () => json(META),
      [`GET /v1/workflow-runs/${R1}`]: () => json({
        ...run({ id: R1, triggerKind: 'manual', trigger: { manual: { by: { id: 'anna', kind: 'person' } } }, state: 'waiting', finishedAt: null, position: '/steps/1' }),
        steps: [
          step({ path: '/steps/0', stepId: 'ok', kind: 'approval', state: 'waiting', input: { title: 'Freigabe' } }),
          step({ path: '/steps/0', stepId: 'ok', kind: 'approval', state: 'completed', output: { outcome: 'rejected', reason: 'Budget fehlt', completedBy: { id: 'cara', kind: 'person' } } }),
          step({ path: '/steps/0/branches/rejected/0', stepId: 'note', kind: 'set', state: 'completed', output: { grund: 'abgelehnt' } }),
          step({ path: '/steps/1', stepId: 'fix', kind: 'task', state: 'waiting', input: { title: 'Nachbessern' }, finishedAt: null }),
        ],
      }),
    });
    const names: Record<string, string> = { anna: 'Anna Muster', cara: 'Cara Muster', ben: 'Ben Beispiel' };
    renderWith(<RunLog runId={R1} />, { props: { actors: { label: a => names[a.id] } } });
    const bar = await screen.findByRole('group', { name: 'Zustand des Runs' });
    expect(await within(bar).findByText('wartet an Schritt 2')).toBeInTheDocument();
    expect(screen.getByText('Gestartet').nextElementSibling).toHaveTextContent(/· von Anna Muster$/);
    const decided = await screen.findByRole('button', { name: 'Schritt 1: Genehmigung «Freigabe», im Run erledigt' });
    expect(decided).toHaveTextContent('«Abgelehnt» · Cara Muster');
    // Genommener Weg hervorgehoben, der andere blass
    expect(screen.getByText('Abgelehnt', { selector: '.wf-lane-label' }).closest('.wf-lane')).toHaveClass('taken');
    expect(screen.getByText('Genehmigt', { selector: '.wf-lane-label' }).closest('.wf-lane')).toHaveClass('wf-lane-skip');
    expect(screen.getByRole('button', { name: 'Schritt 1.b1: Werte setzen, im Run erledigt' })).toHaveTextContent('Gesetzt: grund');
    const waiting = screen.getByRole('button', { name: 'Schritt 2: Aufgabe «Nachbessern», im Run hier steht der Run' });
    expect(waiting).toHaveTextContent('Wartet auf die Erledigung');
    // Gewählt ist der Schritt, an dem der Lauf steht; ein Klick zeigt den Entscheid mit Begründung
    expect(screen.getByRole('complementary', { name: 'Schritt im Run' })).toHaveTextContent('Schritt 2 · Aufgabe');
    await userEvent.click(decided);
    const side = screen.getByRole('complementary', { name: 'Schritt im Run' });
    expect(within(side).getByText('Entschieden von').nextElementSibling).toHaveTextContent('Cara Muster');
    expect(within(side).getByText('Begründung').nextElementSibling).toHaveTextContent('Budget fehlt');
    expect(within(side).getByText('Ergebnis').nextElementSibling).toHaveTextContent('Abgelehnt');
  });

  it('Lauf wartet auf den Entscheid: kein Weg blass, Titel aus dem Lauf; danach ist der andere Weg nie erreicht, übersprungen heisst so', async () => {
    const def = {
      schemaVersion: 2, kind: 'automation', trigger: { manual: {} },
      steps: [{ id: 'ok', approval: { title: 'Ausmustern: {{subject.title}}', approvers: [{ actor: { id: 'cara', kind: 'person' } }], mode: 'first' },
        branches: { approved: [{ id: 'yes', action: 'order.cancel', input: {} }, { id: 'more', set: { a: 1 } }], rejected: [{ id: 'no', set: { grund: 'nein' } }] } }],
    };
    const step = (o: Record<string, unknown>) => ({ id: `${String(o.path)}:${String(o.state)}`, attempt: 1, input: null, output: null, log: [], error: null, startedAt: '2026-11-02T08:00:00.000Z', finishedAt: '2026-11-02T08:05:00.000Z', ...o });
    const asked = step({ path: '/steps/0', stepId: 'ok', kind: 'approval', state: 'waiting', input: { title: 'Ausmustern: Confluence' }, finishedAt: null });
    let body: Record<string, unknown> = { ...run({ id: R1, triggerKind: 'manual', trigger: { manual: { by: { id: 'anna', kind: 'person' } } }, state: 'waiting', finishedAt: null, position: '/steps/0' }), steps: [asked] };
    mockFetch({
      [`GET /v1/workflows/${WF}`]: () => json({ ...summary({ name: 'Ausmustern', state: 'active', activeVersion: 2 }), definition: def }),
      [`GET /v1/workflows/${WF}/versions/2`]: () => json({ version: 2, definition: def }),
      'GET /v1/workflows/meta': () => json(META),
      [`GET /v1/workflow-runs/${R1}`]: () => json(body),
    });
    const { unmount } = renderWith(<RunLog runId={R1} />);
    expect(await screen.findByRole('button', { name: 'Schritt 1: Genehmigung «Ausmustern: …», im Run hier steht der Run' })).toHaveTextContent('Wartet auf den Entscheid');
    for (const lane of ['Genehmigt', 'Abgelehnt']) expect(screen.getByText(lane, { selector: '.wf-lane-label' }).closest('.wf-lane')).not.toHaveClass('wf-lane-skip');
    expect(await screen.findByRole('button', { name: 'Schritt 1.1: Aktion «Bestellung stornieren», im Run noch nicht erreicht' })).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'Schritt im Run' })).getByRole('heading', { level: 3 })).toHaveTextContent('Ausmustern: Confluence');
    unmount();
    body = {
      ...body, state: 'running', position: '/steps/0/branches/approved/1',
      steps: [asked, step({ path: '/steps/0', stepId: 'ok', kind: 'approval', state: 'completed', output: { outcome: 'approved' } }),
        step({ path: '/steps/0/branches/approved/0', stepId: 'yes', kind: 'action', state: 'skipped', log: ['übersprungen'] })],
    };
    renderWith(<RunLog runId={R1} />);
    expect(await screen.findByRole('button', { name: 'Schritt 1.1: Aktion «Bestellung stornieren», im Run übersprungen' })).toHaveTextContent('Übersprungen');
    expect(screen.getByRole('button', { name: 'Schritt 1.b1: Werte setzen, im Run nicht erreicht' })).toHaveTextContent('Nicht erreicht');
    expect(screen.getByRole('button', { name: 'Schritt 1.2: Werte setzen, im Run hier steht der Run' })).toHaveTextContent('Als Nächstes');
  });

  it('Überspringen fragt nach; ohne workflow:operate keine Aktionen', async () => {
    const routes = {
      ...detailRoutes,
      'GET /v1/workflows': () => json({ items: [] }),
      [`GET /v1/workflow-runs/${R1}`]: () => json({ ...run({ id: R1, state: 'incident', error: { code: 'x', message: 'kaputt', path: '/steps/0' } }), steps: [] }),
      [`POST /v1/workflow-runs/${R1}/skip`]: () => json(run({ id: R1, state: 'running' })),
    };
    const { calls } = mockFetch(routes);
    const { unmount } = renderWith(<RunLog runId={R1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Schritt überspringen …' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Schritt überspringen?' });
    expect(within(dialog).getByRole('button', { name: 'Zurück' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schritt überspringen' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/skip'))).toBe(true));
    unmount();
    renderWith(<RunLog runId={R1} />, { perms: ['workflow:read'] });
    expect(await screen.findByText(/fehlt dir das Recht «Vorfälle bearbeiten»/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nochmals versuchen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Weitere Aktionen' })).toBeNull();
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
    const sw = await screen.findByRole('switch', { name: 'Workflows für diese Organisation einschalten' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    const steps = screen.getByLabelText('Schritte pro Run');
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
    expect(within(screen.getByRole('list', { name: 'Letzte Runs' })).getByText('Erfolgreich')).toBeInTheDocument();
    expect(calls.find(c => c.path === '/v1/workflow-runs')!.search).toBe('?subjectType=order&subjectId=o1&limit=5');
    await userEvent.click(start);
    const dialog = screen.getByRole('dialog', { name: 'Stornieren' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Starten' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Bitte ausfüllen: «Grund».');
    await userEvent.type(within(dialog).getByLabelText(/^Grund/), 'Kundin wünscht es');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Starten' }));
    expect(await screen.findByText('«Stornieren» gestartet.')).toBeInTheDocument();
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ subject: { type: 'order', id: 'o1' }, input: { reason: 'Kundin wünscht es' } });
    await userEvent.click(within(screen.getByRole('list', { name: 'Letzte Runs' })).getByRole('button', { name: 'Storno' }));
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
    expect(screen.getByText('Noch keine Runs zu diesem Bezug.')).toBeInTheDocument();
    unmount();
    mockFetch({ 'GET /v1/workflows/status': () => json({ ...STATUS, available: false }) });
    const { container } = renderWith(<SubjectWorkflowBar subject={{ type: 'order', id: 'o1' }} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
