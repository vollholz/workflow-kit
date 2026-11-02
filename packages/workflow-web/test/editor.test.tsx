/** Editor: Aktion aus dem Schema, Wenn/Sonst verschachtelt, Platzhalter, Prüfung am Schritt, Konflikt beim Speichern, Aktivieren, Probelauf. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepListEditor, type AutomationDefinition, type WorkflowDetail } from '../src/index.ts';
import { json, META, mockFetch, renderWith, summary, WF } from './utils.tsx';

afterEach(() => vi.unstubAllGlobals());

const detail = (o: Partial<WorkflowDetail> = {}, def: Partial<AutomationDefinition> = {}): WorkflowDetail => ({
  ...summary(), definition: { schemaVersion: 1, kind: 'automation', trigger: { event: 'order.updated' }, steps: [], ...def }, ...o,
});

function routes(d: WorkflowDetail, over: Record<string, (req: Request) => Response | Promise<Response>> = {}) {
  return mockFetch({
    [`GET /v1/workflows/${WF}`]: () => json(d),
    'GET /v1/workflows/meta': () => json(META),
    [`GET /v1/workflows/${WF}/versions`]: () => json({ items: [] }),
    'POST /v1/workflows/validate': () => json({ ok: true, errors: [], stage: [] }),
    ...over,
  });
}

const put = (calls: { method: string; body: unknown; headers: Headers }[]) => calls.filter(c => c.method === 'PUT');

describe('StepListEditor', () => {
  it('Aktion hinzufügen: Formular aus dem Eingabe-Schema, Platzhalter mit Bezeichnung, Speichern mit If-Match', async () => {
    const { calls } = routes(detail(), {
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    expect(await screen.findByText('Noch keine Schritte.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Schritt hinzufügen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Aktion' }));
    const card = screen.getByRole('region', { name: /Schritt 1: Aktion/ });
    await userEvent.selectOptions(within(card).getByLabelText('Aktion'), 'Bestellung stornieren');
    expect(within(card).getByLabelText(/^Grund/)).toBeRequired();
    expect(within(card).getByText('Steht im Verlauf')).toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText(/^Grund/), 'Zahlung fehlt');
    await userEvent.click(within(card).getByLabelText('Kundschaft benachrichtigen'));
    await userEvent.click(within(card).getByRole('button', { name: 'Platzhalter einfügen in «Bestellung»' }));
    const picker = screen.getByRole('dialog', { name: 'Platzhalter wählen' });
    expect(within(picker).getByRole('group', { name: 'Ereignis' })).toHaveTextContent('Zustand');
    const subjectGroup = within(picker).getByRole('group', { name: 'Bezug: Bestellung' });
    await userEvent.click(within(subjectGroup).getByRole('button', { name: /^ID/ }));
    expect(within(card).getByLabelText(/^Bestellung/)).toHaveValue('{{subject.id}}');
    expect(screen.getByText('Ungespeichert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put(calls)).toHaveLength(1));
    expect(put(calls)[0]!.headers.get('if-match')).toBe('"1"');
    expect((put(calls)[0]!.body as { definition: AutomationDefinition }).definition.steps).toEqual([
      { id: 's1', action: 'order.cancel', input: { order: '{{subject.id}}', reason: 'Zahlung fehlt', notify: true } },
    ]);
    await waitFor(() => expect(screen.queryByText('Ungespeichert')).toBeNull());
  });

  it('Wenn/Sonst verschachtelt, Bedingung in Klartext, Verschieben per Tastatur', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', end: { result: 'completed' } }] }), {
      [`PUT /v1/workflows/${WF}`]: () => json(detail({ revision: 2 })),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    await screen.findByRole('region', { name: /Schritt 1: Beenden/ });
    await userEvent.click(screen.getByRole('button', { name: 'Schritt hinzufügen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Wenn / Sonst' }));
    const ifCard = screen.getByRole('region', { name: /Schritt 2: Wenn \/ Sonst/ });
    const row = within(ifCard).getByRole('group', { name: 'Schritt 2: Bedingung, Teil 1' });
    await userEvent.selectOptions(within(row).getByLabelText('Schritt 2: Bedingung, Teil 1: Feld'), 'Betrag');
    await userEvent.selectOptions(within(row).getByLabelText('Schritt 2: Bedingung, Teil 1: Vergleich'), 'ist grösser als');
    await userEvent.type(within(row).getByLabelText('Schritt 2: Bedingung, Teil 1: Wert'), '100');
    expect(within(ifCard).getAllByText('Wenn «Betrag» ist grösser als «100»').length).toBeGreaterThan(0);
    await userEvent.click(within(ifCard).getByRole('button', { name: 'Schritt hinzufügen (Dann in Schritt 2)' }));
    await userEvent.click(within(ifCard).getByRole('button', { name: 'Aktion' }));
    await userEvent.click(within(ifCard).getByRole('button', { name: 'Schritt hinzufügen (Sonst in Schritt 2)' }));
    await userEvent.click(within(ifCard).getByRole('button', { name: 'Beenden' }));
    expect(within(ifCard).getByRole('region', { name: /Schritt 2\.1: Aktion/ })).toBeInTheDocument();
    expect(within(ifCard).getByRole('region', { name: /Schritt 2\.s1: Beenden/ })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Schritt 2 nach oben' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('region', { name: /Schritt 1: Wenn \/ Sonst/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schritt 2 nach unten' })).toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put(calls)).toHaveLength(1));
    expect((put(calls)[0]!.body as { definition: AutomationDefinition }).definition.steps).toEqual([
      { id: 's2', if: { all: [{ field: 'subject.values.total', op: 'gt', value: 100 }] }, then: [{ id: 's3', action: '', input: {} }], else: [{ id: 's4', end: { result: 'completed' } }] },
      { id: 's1', end: { result: 'completed' } },
    ]);
  });

  it('zeigt Meldungen der Prüfung am Schritt und am Auslöser', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', action: 'order.cancel', input: {} }, { id: 's2', if: { field: 'steps.x.state', op: 'eq', value: 'a' }, then: [{ id: 's3', end: { result: 'completed' } }] }] }), {
      'POST /v1/workflows/validate': () => json({
        ok: false,
        errors: [
          { path: '/steps/0/input/reason', message: 'Pflichtangabe «reason» fehlt' },
          { path: '/steps/1/if/field', message: 'Verweis auf unbekannten Schritt «x»' },
          { path: '/steps/1/then/0/end/result', message: 'Erlaubt: «completed»' },
          { path: '/trigger/event', message: 'Unbekannter Ereignistyp «order.updated»' },
        ],
        stage: [],
      }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    const first = await screen.findByRole('list', { name: 'Hinweise zu Schritt 1' });
    expect(first).toHaveTextContent('Pflichtangabe «reason» fehlt');
    const second = screen.getByRole('list', { name: 'Hinweise zu Schritt 2' });
    expect(second).toHaveTextContent('Verweis auf unbekannten Schritt «x»');
    expect(second).not.toHaveTextContent('Erlaubt');
    expect(screen.getByRole('list', { name: 'Hinweise zu Schritt 2.1' })).toHaveTextContent('Erlaubt: «completed»');
    expect(screen.getByRole('list', { name: 'Hinweise zum Auslöser' })).toHaveTextContent('Unbekannter Ereignistyp');
    expect(screen.getByText(/4 Hinweise/)).toBeInTheDocument();
    expect(calls.find(c => c.path === '/v1/workflows/validate')!.body).toMatchObject({ definition: { kind: 'automation' } });
  });

  it('Konflikt beim Speichern (412/409): eigene Fassung über den neuen Stand speichern', async () => {
    let revision = 1;
    let attempts = 0;
    const { calls } = routes(detail(), {
      [`GET /v1/workflows/${WF}`]: () => json(detail({ revision })),
      [`PUT /v1/workflows/${WF}`]: req => {
        attempts++;
        if (attempts === 1) { revision = 4; return json({ code: 'conflict', title: 'Konflikt', detail: 'Der Workflow wurde inzwischen geändert (Stand 4, erwartet 1).' }, 412); }
        expect(req.headers.get('if-match')).toBe('"4"');
        return json(detail({ revision: 5, name: 'Mein Name' }));
      },
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    const name = await screen.findByLabelText('Name des Workflows');
    await userEvent.clear(name);
    await userEvent.type(name, 'Mein Name');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Inzwischen geändert' });
    expect(within(dialog).getByRole('button', { name: 'Neu laden' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Meine Fassung speichern' }));
    await waitFor(() => expect(put(calls)).toHaveLength(2));
    expect((put(calls)[1]!.body as { name: string }).name).toBe('Mein Name');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Aktivieren: Zusammenfassung mit Akteur und Zeitplan, danach aktive Version', async () => {
    const def: Partial<AutomationDefinition> = { trigger: { schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Zurich' } }, steps: [{ id: 's1', end: { result: 'completed' } }] };
    const { calls } = routes(detail({}, def), {
      [`POST /v1/workflows/${WF}/activate`]: () => json(detail({ state: 'active', activeVersion: 1, revision: 2, actor: { id: 'anna', kind: 'person' } }, def)),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    expect(await screen.findByText(/Läuft werktags \(Mo–Fr\) um 07:00/)).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Aktivieren …' });
    await userEvent.click(open);
    const dialog = screen.getByRole('dialog', { name: 'Workflow aktivieren' });
    expect(within(dialog).getByText('Nach Zeitplan: werktags (Mo–Fr) um 07:00 (Europe/Zurich)')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Ich selbst (Anna Muster)')).toBeChecked();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Aktivieren' })).toBeEnabled());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(open).toHaveFocus();
    await userEvent.click(open);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Workflow aktivieren' })).getByRole('button', { name: 'Aktivieren' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find(c => c.path.endsWith('/activate'))!.body).toEqual({ revision: 1 });
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    expect(screen.getByText(/Aktive Version 1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pausieren' })).toBeInTheDocument();
  });

  it('Aktivieren ist gesperrt, solange die Prüfung Fehler meldet', async () => {
    routes(detail({}, { steps: [{ id: 's1', action: '' }] }), {
      'POST /v1/workflows/validate': () => json({ ok: false, errors: [{ path: '/steps/0/action', message: 'Ungültige Schreibweise' }], stage: [] }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    await screen.findByRole('list', { name: 'Hinweise zu Schritt 1' });
    await userEvent.click(screen.getByRole('button', { name: 'Aktivieren …' }));
    const dialog = screen.getByRole('dialog', { name: 'Workflow aktivieren' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Zuerst die markierte Stelle beheben.');
    expect(within(dialog).getByRole('button', { name: 'Aktivieren' })).toBeDisabled();
  });

  it('Probelauf mit gesuchtem Bezug zeigt das Ergebnis je Schritt', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', action: 'order.cancel', input: { order: '{{subject.id}}', reason: 'x' } }] }), {
      [`POST /v1/workflows/${WF}/dry-run`]: () => json({
        triggerMatches: null, result: 'completed', variables: {},
        steps: [{ path: '/steps/0', stepId: 's1', kind: 'action', label: null, summary: 'würde Bestellung o1 stornieren', allowed: false, missing: ['order:write'], output: { state: 'cancelled' } }],
      }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    await userEvent.type(await screen.findByLabelText('Bestellung suchen'), 'o1');
    await userEvent.click(screen.getByRole('button', { name: 'Suchen' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Bestellung o1 o1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Probelauf starten' }));
    const result = await screen.findByRole('region', { name: 'Ergebnis des Probelaufs' });
    expect(result).toHaveTextContent('würde Bestellung o1 stornieren');
    expect(result).toHaveTextContent('Dem Akteur fehlen Rechte: order:write');
    expect(calls.find(c => c.path.endsWith('/dry-run'))!.body).toMatchObject({ subject: { type: 'order', id: 'o1' }, definition: { kind: 'automation' } });
  });

  it('ohne workflow:manage nur lesbar', async () => {
    routes(detail({}, { steps: [{ id: 's1', end: { result: 'completed' } }] }));
    renderWith(<StepListEditor workflowId={WF} />, { perms: ['workflow:read'] });
    expect(await screen.findByText(/Zum Bearbeiten fehlt dir das Recht «Workflows bearbeiten»/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schritt hinzufügen' })).toBeNull();
    expect(screen.getByLabelText('Name des Workflows')).toBeDisabled();
  });
});
