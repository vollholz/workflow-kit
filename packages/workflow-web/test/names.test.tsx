/** 0.3.1: Namen von Akteuren und Titel von Bezügen über Bausteine der App, Personenauswahl im Editor, Einzahl/Mehrzahl, Leiste lädt nach dem Start nach. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActorName, MyWork, RunLog, StepListEditor, SubjectTitle, SubjectWorkflowBar, type RunJson, type TaskJson, type WorkflowActor, type WorkflowDetail,
} from '../src/index.ts';
import { describeDuration } from '../src/steps.tsx';
import { describeCron } from '../src/trigger.tsx';
import { plural } from '../src/ui.tsx';
import { ALL, json, META, mockFetch, renderWith, STATUS, summary, WF } from './utils.tsx';

afterEach(() => vi.unstubAllGlobals());

const PEOPLE: Record<string, string> = { ben: 'Ben Beispiel', cara: 'Cara Muster' };
/** Name der App: liest «asynchron» (hier sofort) aus ihrer eigenen Quelle, nicht aus `actors.label`. */
const Name = ({ actor }: { actor: WorkflowActor }) => <>{PEOPLE[actor.id] ?? `? ${actor.id}`}</>;
const Title = ({ id }: { id: string }) => <>{`Bestellung Nr. ${id.toUpperCase()}`}</>;

describe('ActorName und SubjectTitle', () => {
  it('nutzen die Bausteine der App, sonst Bezeichnung bzw. Titel der API, sonst Typ und ID', () => {
    const { unmount } = renderWith(
      <ul>
        <li data-testid="a1"><ActorName actor={{ id: 'ben', kind: 'person' }} /></li>
        <li data-testid="s1"><SubjectTitle type="order" id="o7" title="von der API" /></li>
      </ul>,
      { props: { actors: { Name, label: () => 'nicht gebraucht' }, subjects: { order: { label: 'Bestellung', Title } } } },
    );
    expect(screen.getByTestId('a1')).toHaveTextContent('Ben Beispiel');
    expect(screen.getByTestId('s1')).toHaveTextContent('Bestellung Nr. O7');
    unmount();
    renderWith(
      <ul>
        <li data-testid="a2"><ActorName actor={{ id: 'ben', kind: 'person' }} /></li>
        <li data-testid="a3"><ActorName actor={{ id: 'bot', kind: 'client' }} /></li>
        <li data-testid="s2"><SubjectTitle type="order" id="o7" title="von der API" /></li>
        <li data-testid="s3"><SubjectTitle type="order" id="o7" /></li>
        <li data-testid="s4"><SubjectTitle type="ticket" id="t1" /></li>
      </ul>,
      { props: { actors: { label: a => (a.id === 'ben' ? 'Ben (Text)' : undefined) } } },
    );
    expect(screen.getByTestId('a2')).toHaveTextContent('Ben (Text)');
    expect(screen.getByTestId('a3')).toHaveTextContent('Maschinen-Client bot');
    expect(screen.getByTestId('s2')).toHaveTextContent('von der API');
    expect(screen.getByTestId('s3')).toHaveTextContent('Bestellung o7');
    expect(screen.getByTestId('s4')).toHaveTextContent('ticket t1');
  });

  it('Protokoll zeigt Bezug und Akteure mit den Bausteinen der App, der Bezug bleibt ein Link', async () => {
    const R1 = '33333333-3333-4333-8333-333333333331';
    const r: RunJson = {
      id: R1, workflowId: WF, version: 1, triggerKind: 'manual', trigger: { manual: { by: { id: 'cara', kind: 'person' } } },
      subject: { type: 'order', id: 'o9' }, actor: { id: 'ben', kind: 'person' }, startedBy: null, state: 'completed', position: null, attempts: 0,
      stepCount: 0, chainDepth: 1, parentRunId: null, correlationId: null, variables: {}, error: null, wakeAt: null,
      startedAt: '2026-11-02T08:00:00.000Z', updatedAt: '2026-11-02T08:00:01.000Z', finishedAt: '2026-11-02T08:00:01.000Z',
    } as RunJson;
    mockFetch({
      'GET /v1/workflows': () => json({ items: [summary()] }),
      'GET /v1/workflow-runs': () => json({ items: [r], nextCursor: null }),
      [`GET /v1/workflow-runs/${R1}`]: () => json({ ...r, steps: [] }),
    });
    renderWith(<RunLog />, { props: { actors: { Name }, subjects: { order: { label: 'Bestellung', Title, href: id => `/orders/${id}` } } } });
    const link = await screen.findByRole('link', { name: 'Bestellung Nr. O9' });
    expect(link).toHaveAttribute('href', '/orders/o9');
    await userEvent.click(screen.getByRole('button', { name: /Lauf vom/ }));
    expect(await screen.findByText('Ben Beispiel')).toBeInTheDocument();
    expect(screen.getByText('Auslöser').nextElementSibling).toHaveTextContent('Von Hand · von Cara Muster');
    expect(screen.queryByText(/Objekt|o9$/)).toBeNull();
  });
});

describe('Einzahl und Mehrzahl', () => {
  it('Hilfen und Texte mit Zahl', () => {
    expect(plural(1, 'Person', 'Personen')).toBe('1 Person');
    expect(plural(0, 'Person', 'Personen')).toBe('0 Personen');
    expect(plural(3, 'Aufgabe', 'Aufgaben')).toBe('3 Aufgaben');
    expect(describeDuration('P1D')).toBe('1 Tag');
    expect(describeDuration('PT1BH')).toBe('1 Arbeitsstunde');
    expect(describeDuration('P2W')).toBe('2 Wochen');
    expect(describeCron('*/1 * * * *')).toBe('jede Minute');
    expect(describeCron('*/5 * * * *')).toBe('alle 5 Minuten');
  });

  it('Genehmigung mit einer Person: «1 Person» in der Liste, «1 Person kann entscheiden» und ihr Name im Detail', async () => {
    const T1 = '55555555-5555-4555-8555-555555555551';
    const ap = {
      id: T1, kind: 'approval', title: 'Freigabe', description: null, hidden: false, subject: { type: 'order', id: 'o1', title: null },
      workflowId: WF, runId: 'r1', stepId: 'ok', state: 'open', priority: 'normal', assignee: null, queue: null,
      candidates: [{ id: 'ben', kind: 'person' }], mode: 'first', reasonRequired: false, form: [], outcomes: [], outcome: null, values: null, reason: null,
      dueAt: null, breachedAt: null, overdue: false, createdAt: '2026-11-02T08:00:00.000Z', updatedAt: '2026-11-02T08:00:00.000Z',
      assignedAt: null, completedAt: null, completedBy: null, revision: 1, voted: false,
      actions: { take: false, release: false, complete: false, decide: true, assign: false, handOver: false, cancel: false },
    } as TaskJson;
    mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/tasks/counts': () => json({ mine: { open: 1, overdue: 0 }, team: { open: 1, overdue: 0, unassigned: 1 } }),
      'GET /v1/tasks': () => json({ items: [ap], total: 1, view: 'mine', sort: 'urgency' }),
      [`GET /v1/tasks/${T1}`]: () => json({ ...ap, votes: [], sla: null }),
    });
    renderWith(<MyWork />, { perms: [...ALL, 'task:work'], props: { actors: { Name }, subjects: { order: { label: 'Bestellung', Title } } } });
    const row = (await screen.findByRole('button', { name: 'Freigabe' })).closest('tr')!;
    expect(within(row).getByText('1 Person')).toBeInTheDocument();
    expect(within(row).getByText('Bestellung Nr. O1')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Freigabe' }));
    const panel = await screen.findByRole('complementary', { name: 'Freigabe' });
    expect(within(panel).getByText('Noch keine Stimmen (1 Person kann entscheiden).')).toBeInTheDocument();
    expect(within(panel).getByText('Ben Beispiel')).toBeInTheDocument();
  });
});

describe('Editor: Personen und Namen', () => {
  const Q1 = '66666666-6666-4666-8666-666666666661';
  const queue = { id: Q1, name: 'Verkauf', team: { type: 'role', id: 'sales' }, sort: 'urgency', assignment: 'pull', calendarId: null, slaTarget: null, escalation: null, revision: 1, createdAt: '', updatedAt: '' };
  const setup = (steps: unknown[]) => {
    const d: WorkflowDetail = { ...summary(), definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps } } as WorkflowDetail;
    return mockFetch({
      [`GET /v1/workflows/${WF}`]: () => json(d),
      'GET /v1/workflows/meta': () => json({ ...META, stepKinds: [...META.stepKinds, 'task', 'approval'] }),
      [`GET /v1/workflows/${WF}/versions`]: () => json({ items: [] }),
      'POST /v1/workflows/validate': () => json({ ok: true, errors: [], stage: [] }),
      'GET /v1/queues': () => json({ items: [queue] }),
      'GET /v1/queues/teams': () => json({ available: true, items: [{ type: 'role', id: 'sales', label: 'Team Verkauf' }] }),
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...d, revision: 2, definition: ((await req.json()) as { definition: unknown }).definition }),
    });
  };

  it('Zusammenfassung mit Namen von Warteschlange, Team und Person statt IDs', async () => {
    setup([
      { id: 's1', task: { title: 'Prüfen', assignee: { queue: Q1 } } },
      { id: 's2', approval: { title: 'Freigabe', approvers: [{ actor: { id: 'ben', kind: 'person' } }, { team: { type: 'role', id: 'sales' } }], mode: 'all' } },
    ]);
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />, { perms: [...ALL, 'queue:manage'], props: { actors: { Name } } });
    expect(await screen.findByText('Aufgabe «Prüfen» für Warteschlange Verkauf')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Genehmigung «Freigabe» bei/)).toHaveTextContent('Genehmigung «Freigabe» bei Ben Beispiel, Team Verkauf'));
    expect(screen.queryByText(new RegExp(Q1))).toBeNull();
  });

  it('Zuständig: eine Auswahl mit Suche, gruppiert; Personen nie zusätzlich als Team; ohne Suche der App per ID', async () => {
    const { calls } = setup([{ id: 's1', task: { title: 'Prüfen', assignee: { actor: { id: '', kind: 'person' } } } }]);
    const search = vi.fn(async (q: string) => [{ id: 'ben', kind: 'person' as const, label: `Ben (${q})` }, { id: 'cara', kind: 'person' as const }]);
    const { unmount } = renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />, { perms: [...ALL, 'queue:manage'], props: { actors: { Name, search } } });
    const card = await screen.findByRole('region', { name: /Schritt 1: Aufgabe/ });
    const group = await within(card).findByRole('group', { name: 'Zuständig' });
    expect(within(group).getByText('Noch niemand gewählt.')).toBeInTheDocument();
    expect(within(card).queryByLabelText('Zuständig: ID der Person')).toBeNull();
    await userEvent.type(within(group).getByRole('combobox', { name: 'Zuständig: suchen' }), 'be');
    const list = await within(group).findByRole('listbox', { name: 'Zuständig: Auswahl' });
    expect(search).toHaveBeenLastCalledWith('be');
    await waitFor(() => expect(within(list).getByRole('group', { name: 'Personen' })).toHaveTextContent('Cara Muster'));
    expect(within(list).getByRole('group', { name: 'Weitere' })).toHaveTextContent('Person aus einem Feld …');
    await userEvent.click(within(list).getByRole('option', { name: 'Cara Muster' }));
    expect(within(group).getByText(/^Person: Cara Muster$/)).toBeInTheDocument();
    expect(within(group).queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Aufgabe «Prüfen» für Cara Muster')).toBeInTheDocument();
    await waitFor(() => expect((calls.filter(c => c.method === 'PUT').at(-1)?.body as { definition: { steps: unknown[] } } | undefined)?.definition.steps)
      .toEqual([{ id: 's1', task: { title: 'Prüfen', assignee: { actor: { id: 'cara', kind: 'person' } } } }]));
    unmount();
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    const card2 = await screen.findByRole('region', { name: /Schritt 1: Aufgabe/ });
    await userEvent.type(within(card2).getByRole('combobox', { name: 'Zuständig: suchen' }), 'cara');
    expect(await within(card2).findByRole('option', { name: 'Person mit der ID «cara»' })).toBeInTheDocument();
  });

  it('Zuständig per Tastatur: Team aus der Gruppe der App wählen', async () => {
    const { calls } = setup([{ id: 's1', task: { title: 'Prüfen', assignee: { actor: { id: '', kind: 'person' } } } }]);
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />, { perms: [...ALL, 'queue:manage'] });
    const card = await screen.findByRole('region', { name: /Schritt 1: Aufgabe/ });
    const box = within(card).getByRole('combobox', { name: 'Zuständig: suchen' });
    await userEvent.type(box, 'verk');
    const list = await within(card).findByRole('listbox', { name: 'Zuständig: Auswahl' });
    await waitFor(() => expect(within(list).getByRole('group', { name: 'Teams' })).toHaveTextContent('Team Verkauf'));
    expect(within(list).getByRole('group', { name: 'Warteschlangen' })).toHaveTextContent('Verkauf');
    await userEvent.keyboard('{ArrowDown}');
    expect(within(list).getByRole('option', { name: 'Team Verkauf' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect((calls.filter(c => c.method === 'PUT').at(-1)?.body as { definition: { steps: { task: { assignee: unknown } }[] } } | undefined)?.definition.steps[0]!.task.assignee)
      .toEqual({ team: { type: 'role', id: 'sales' } }));
  });
});

describe('SubjectWorkflowBar nach dem Start', () => {
  it('lädt Aufgaben und Läufe nach, solange der neue Lauf läuft', async () => {
    const R2 = '33333333-3333-4333-8333-333333333332';
    const MANUAL = summary({ id: WF, name: 'Prüfen', state: 'active', activeVersion: 2 });
    let runState: 'none' | 'running' | 'waiting' = 'none';
    let runsFetched = 0;
    const run = (state: RunJson['state']) => ({
      id: R2, workflowId: WF, version: 2, triggerKind: 'manual', trigger: { manual: { by: { id: 'anna', kind: 'person' } } }, subject: { type: 'order', id: 'o1' },
      actor: { id: 'anna', kind: 'person' }, startedBy: null, state, position: null, attempts: 0, stepCount: 0, chainDepth: 1, parentRunId: null, correlationId: null,
      variables: {}, error: null, wakeAt: null, startedAt: '2026-11-02T08:00:00.000Z', updatedAt: '2026-11-02T08:00:00.000Z', finishedAt: null,
    });
    const task = { id: 't1', kind: 'task', title: 'Neue Aufgabe', state: 'open', priority: 'normal', assignee: { id: 'ben', kind: 'person' }, queue: null, dueAt: null, candidates: [] };
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows': () => json({ items: [MANUAL] }),
      [`GET /v1/workflows/${WF}/versions/2`]: () => json({ version: 2, definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: { label: 'Prüfen lassen' } }, steps: [] } }),
      'GET /v1/workflow-runs': () => {
        if (runState === 'running' && ++runsFetched >= 2) runState = 'waiting';
        return json({ items: runState === 'none' ? [] : [run(runState)], nextCursor: null });
      },
      'GET /v1/tasks': () => json({ items: runState === 'waiting' ? [task] : [], total: runState === 'waiting' ? 1 : 0, view: 'all', sort: 'urgency' }),
      [`POST /v1/workflows/${WF}/runs`]: () => { runState = 'running'; return json(run('running'), 201); },
    });
    renderWith(<SubjectWorkflowBar subject={{ type: 'order', id: 'o1' }} />, { props: { actors: { Name } } });
    expect(await screen.findByText('Keine offenen Aufgaben.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Prüfen lassen' }));
    const list = await screen.findByRole('list', { name: 'Offene Aufgaben' }, { timeout: 5000 });
    expect(within(list).getByText('Neue Aufgabe')).toBeInTheDocument();
    expect(within(list).getByText('Ben Beispiel')).toBeInTheDocument();
    const before = calls.filter(c => c.path === '/v1/workflow-runs').length;
    await new Promise(r => setTimeout(r, 2500));
    expect(calls.filter(c => c.path === '/v1/workflow-runs').length).toBe(before);
  }, 15_000);
});
