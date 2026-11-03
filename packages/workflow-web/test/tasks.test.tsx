/** Stufe 2: «Meine Arbeit» (Reiter, Zähler, Erledigen mit Formular), Genehmigen/Ablehnen, Massenaktion, Warteschlangen- und Kalender-Editor, Zähler-Hook, Editor-Karte «Aufgabe». */
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CalendarEditor, MyWork, parseHours, QueueEditor, StepListEditor, useTaskCounts, WorkflowProvider, type TaskDetailJson, type TaskJson, type WorkflowDetail,
} from '../src/index.ts';
import { ALL, json, META, ME, mockFetch, renderWith, STATUS, summary, WF } from './utils.tsx';

afterEach(() => vi.unstubAllGlobals());

const T1 = '55555555-5555-4555-8555-555555555551';
const T2 = '55555555-5555-4555-8555-555555555552';
const Q1 = '66666666-6666-4666-8666-666666666661';
const actions = { take: false, release: true, complete: true, decide: false, assign: false, handOver: true, cancel: false };
const task = (o: Partial<TaskJson> & { id: string }): TaskJson => ({
  kind: 'task', title: 'Bestellung prüfen', description: 'Betrag 100', hidden: false, subject: { type: 'order', id: 'o1', title: 'Bestellung Anna' },
  workflowId: WF, runId: 'r1', stepId: 'check', state: 'open', priority: 'normal', assignee: { id: 'anna', kind: 'person' }, queue: { id: Q1, name: 'Verkauf' },
  candidates: [], mode: null, reasonRequired: false, form: [], outcomes: ['done'], outcome: null, values: null, reason: null,
  dueAt: new Date(Date.now() - 3_600_000).toISOString(), breachedAt: null, overdue: true, createdAt: '2026-11-02T08:00:00.000Z', updatedAt: '2026-11-02T08:00:00.000Z',
  assignedAt: null, completedAt: null, completedBy: null, revision: 3, voted: false, actions, ...o,
});
const detail = (t: TaskJson, o: Partial<TaskDetailJson> = {}): TaskDetailJson => ({ ...t, votes: [], sla: null, ...o });
const COUNTS = { mine: { open: 2, overdue: 1 }, team: { open: 5, overdue: 1, unassigned: 3 } };

describe('MyWork', () => {
  it('Reiter mit Zählern, Frist-Anzeige, Aufgabe öffnen und mit Formular erledigen', async () => {
    const t1 = task({ id: T1, form: [{ key: 'note', label: 'Notiz', type: 'text', required: true }], outcomes: ['ok', 'problem'] });
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/tasks/counts': () => json(COUNTS),
      'GET /v1/tasks': req => json({ items: new URL(req.url).searchParams.get('view') === 'team' ? [t1, task({ id: T2, title: 'Zweite' })] : [t1], total: 1, view: 'mine', sort: 'urgency' }),
      [`GET /v1/tasks/${T1}`]: () => json(detail(t1)),
      [`POST /v1/tasks/${T1}/complete`]: () => json(detail({ ...t1, state: 'done', outcome: 'problem', actions: { ...actions, complete: false, release: false, handOver: false } })),
    });
    renderWith(<MyWork />, { perms: [...ALL, 'task:work'] });
    const mine = await screen.findByRole('tab', { name: /Mir/ });
    expect(mine).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(mine).toHaveTextContent('2'));
    expect(screen.getByText(/überfällig seit/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Alle auswählen' })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: /Mein Team/ }));
    await waitFor(() => expect(calls.some(c => c.path === '/v1/tasks' && c.search.includes('view=team'))).toBe(true));
    expect(await screen.findByRole('button', { name: 'Zweite' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Bestellung prüfen' }));
    const panel = await screen.findByRole('complementary', { name: 'Bestellung prüfen' });
    expect(within(panel).getByText('Bestellung Anna')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Erledigen: problem' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('Bitte ausfüllen: «Notiz»');
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
    await userEvent.type(within(panel).getByLabelText(/Notiz/), 'Adresse fehlt');
    await userEvent.click(within(panel).getByRole('button', { name: 'Erledigen: problem' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST')).toHaveLength(1));
    const post = calls.find(c => c.method === 'POST')!;
    expect(post.body).toEqual({ outcome: 'problem', values: { note: 'Adresse fehlt' } });
    expect(post.headers.get('if-match')).toBe('"3"');
    expect(await within(panel).findByText('Erledigt: problem.')).toBeInTheDocument();
  });

  it('Genehmigung: Ablehnen nur mit Begründung; Massenaktion mit task:assign', async () => {
    const ap = task({ id: T1, kind: 'approval', title: 'Freigabe', mode: 'first', reasonRequired: true, assignee: null, candidates: [{ id: 'anna', kind: 'person' }, { id: 'ben', kind: 'person' }], actions: { ...actions, decide: true, complete: false, release: false, handOver: false } });
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/tasks/counts': () => json(COUNTS),
      'GET /v1/tasks': () => json({ items: [ap], total: 1, view: 'mine', sort: 'urgency' }),
      [`GET /v1/tasks/${T1}`]: () => json(detail(ap)),
      [`POST /v1/tasks/${T1}/decide`]: () => json(detail({ ...ap, state: 'done', outcome: 'rejected', reason: 'Budget' })),
      'POST /v1/tasks/bulk': () => json({ results: [{ id: T1, ok: true }], ok: 1, failed: 0 }),
    });
    renderWith(<MyWork taskId={T1} />, { perms: [...ALL, 'task:work', 'task:assign'] });
    const panel = await screen.findByRole('complementary', { name: 'Freigabe' });
    expect(within(panel).getByText('Noch keine Stimmen (2 Personen können entscheiden).')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Ablehnen' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('Bitte begründe die Ablehnung.');
    await userEvent.type(within(panel).getByLabelText(/Begründung/), 'Budget');
    await userEvent.click(within(panel).getByRole('button', { name: 'Ablehnen' }));
    await waitFor(() => expect(calls.find(c => c.path.endsWith('/decide'))?.body).toEqual({ decision: 'rejected', reason: 'Budget' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: '«Freigabe» auswählen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen …' }));
    const dialog = screen.getByRole('alertdialog', { name: '1 Aufgabe abbrechen?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(calls.find(c => c.path === '/v1/tasks/bulk')?.body).toEqual({ action: 'cancel', ids: [T1], reason: null }));
  });
});

describe('Warteschlangen und Kalender', () => {
  it('Warteschlange anlegen mit Team aus der App, Regel und Frist', async () => {
    const { calls } = mockFetch({
      'GET /v1/calendars': () => json({ items: [] }),
      'GET /v1/queues': () => json({ items: [] }),
      'GET /v1/queues/teams': () => json({ available: true, items: [{ type: 'role', id: 'sales', label: 'Verkauf' }] }),
      'POST /v1/queues': async req => json({ id: Q1, revision: 1, ...(await req.json() as object) }, 201),
    });
    const onSaved = vi.fn();
    renderWith(<QueueEditor queueId={null} onSaved={onSaved} />, { perms: ['queue:manage'] });
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Verkauf');
    await userEvent.selectOptions(await screen.findByLabelText('Team'), 'Verkauf');
    await userEvent.selectOptions(screen.getByLabelText('Zuweisung'), 'round_robin');
    await userEvent.click(screen.getByLabelText('Frist setzen'));
    await userEvent.click(screen.getByLabelText('Priorität erhöhen'));
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({
      name: 'Verkauf', description: null, team: { type: 'role', id: 'sales' }, sort: 'urgency', assignment: 'round_robin', calendarId: null, slaTarget: 'P1BD', escalation: { raisePriority: true },
    });
  });

  it('Kalender: Arbeitszeiten als Text, Feiertag, Vorschau; ohne Recht ein Hinweis', async () => {
    expect(parseHours('8:00-12:00, 13:00 - 17:00')).toEqual([['08:00', '12:00'], ['13:00', '17:00']]);
    expect(parseHours('morgens')).toBeNull();
    const { calls } = mockFetch({
      'POST /v1/calendars/preview': () => json({ from: '2026-11-06T14:00:00.000Z', dueAt: '2026-11-10T09:00:00.000Z' }),
      'POST /v1/calendars': async req => json({ id: 'c1', revision: 1, ...(await req.json() as object) }, 201),
    });
    const { unmount } = renderWith(<CalendarEditor calendarId={null} />, { perms: ['queue:manage'] });
    await userEvent.type(screen.getByLabelText(/^Name/), 'Büro');
    await userEvent.clear(screen.getByLabelText('Freitag'));
    await userEvent.type(screen.getByLabelText('Freitag'), 'morgens');
    expect(screen.getByRole('alert')).toHaveTextContent('Freitag');
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Freitag'));
    await userEvent.type(screen.getByLabelText('Freitag'), '08:00-12:00');
    await userEvent.click(screen.getByRole('button', { name: 'Feiertag hinzufügen' }));
    await userEvent.type(screen.getByLabelText('Feiertag 1: Datum'), '2026-12-25');
    await userEvent.click(screen.getByRole('button', { name: 'Berechnen' }));
    expect(await screen.findByText(/Fällig am 10\.11\.2026/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some(c => c.path === '/v1/calendars')).toBe(true));
    const body = calls.find(c => c.path === '/v1/calendars')!.body as { week: Record<string, unknown>; holidays: unknown[] };
    expect(body.week.fri).toEqual([['08:00', '12:00']]);
    expect(body.week.sat).toBeUndefined();
    expect(body.holidays).toEqual([{ date: '2026-12-25' }]);
    unmount();
    renderWith(<CalendarEditor calendarId={null} />, { perms: [] });
    expect(screen.getByText(/fehlt dir das Recht «Warteschlangen verwalten»/)).toBeInTheDocument();
  });
});

it('useTaskCounts fragt erst, wenn das Modul verfügbar ist', async () => {
  const { calls } = mockFetch({ 'GET /v1/workflows/status': () => json(STATUS), 'GET /v1/tasks/counts': () => json(COUNTS) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}><WorkflowProvider api={{}} me={ME} can={() => true}>{children}</WorkflowProvider></QueryClientProvider>
  );
  const { result } = renderHook(() => useTaskCounts({ refetchInterval: false }), { wrapper });
  await waitFor(() => expect(result.current.data).toEqual(COUNTS));
  expect(calls.map(c => c.path)).toEqual(['/v1/workflows/status', '/v1/tasks/counts']);
});

it('Editor: Schritt «Aufgabe» mit Zuständiger Warteschlange, Formularfeld und Frist in Arbeitsstunden', async () => {
  const d: WorkflowDetail = { ...summary(), definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [] } };
  const { calls } = mockFetch({
    [`GET /v1/workflows/${WF}`]: () => json(d),
    'GET /v1/workflows/meta': () => json({ ...META, stepKinds: [...META.stepKinds, 'task', 'approval'] }),
    [`GET /v1/workflows/${WF}/versions`]: () => json({ items: [] }),
    'POST /v1/workflows/validate': () => json({ ok: true, errors: [], stage: [] }),
    'GET /v1/queues': () => json({ items: [{ id: Q1, name: 'Verkauf', team: { type: 'role', id: 'sales' }, sort: 'urgency', assignment: 'pull', calendarId: null, slaTarget: null, escalation: null, revision: 1, createdAt: '', updatedAt: '' }] }),
    [`PUT /v1/workflows/${WF}`]: async req => json({ ...d, revision: 2, definition: ((await req.json()) as { definition: unknown }).definition }),
  });
  renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
  await userEvent.click(await screen.findByRole('button', { name: /Ersten Schritt hinzufügen/ }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Wie startet der Workflow?' })).getByRole('button', { name: /^Von Hand/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Schritt einfügen nach dem Auslöser' }));
  const sheet = screen.getByRole('dialog', { name: 'Schritt hinzufügen' });
  await userEvent.click(within(sheet).getByRole('button', { name: /^Menschen einbeziehen/ }));
  await userEvent.click(within(within(sheet).getByRole('group', { name: 'Menschen einbeziehen' })).getByRole('button', { name: /^Aufgabe/ }));
  const card = screen.getByRole('region', { name: /Schritt 1: Aufgabe/ });
  expect(within(card).getByLabelText('Frist')).toHaveDisplayValue('keine Frist');
  await userEvent.type(within(card).getByLabelText(/^Titel/), 'Prüfen');
  await userEvent.click(within(card).getByRole('combobox', { name: 'Zuständig: suchen' }));
  await userEvent.click(await within(card).findByRole('option', { name: 'Verkauf' }));
  await userEvent.click(within(card).getByRole('button', { name: 'Feld hinzufügen' }));
  await userEvent.type(within(card).getByLabelText('Schritt 1: Feld 1 Bezeichnung'), 'Notiz');
  await userEvent.selectOptions(within(card).getByLabelText('Frist'), 'yes');
  await userEvent.selectOptions(within(card).getByLabelText('Schritt 1: Frist: Zeitraum'), 'BH');
  await waitFor(() => expect((calls.filter(c => c.method === 'PUT').at(-1)?.body as { definition: { steps: unknown[] } } | undefined)?.definition.steps)
    .toEqual([{ id: 's1', task: { title: 'Prüfen', assignee: { queue: Q1 }, form: [{ key: 'feld1', label: 'Notiz', type: 'text' }], due: 'PT1BH' } }]));
});
