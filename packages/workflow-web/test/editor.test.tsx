/**
 * Editor: Aktion aus dem Schema, Wenn/Sonst verschachtelt, Platzhalter, Prüfung am Schritt, Entwurf speichert sich
 * selbst, Konflikt beim Speichern, Statusleiste (Aktivieren, Version n aktivieren, Verwerfen, Fortsetzen), Entfernen mit
 * Rückgängig, Probelauf mit Schrittnamen.
 */
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

type Call = { method: string; body: unknown; headers: Headers };
const put = (calls: Call[]) => calls.filter(c => c.method === 'PUT');
const lastSteps = (calls: Call[]) => (put(calls).at(-1)?.body as { definition: AutomationDefinition } | undefined)?.definition.steps;

describe('StepListEditor', () => {
  it('Aktion hinzufügen: Formular aus dem Eingabe-Schema, Platzhalter mit Bezeichnung; der Entwurf speichert sich mit If-Match', async () => {
    const { calls } = routes(detail(), {
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    expect(await screen.findByText('Noch keine Schritte.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(screen.getByText('Alle Änderungen gespeichert')).toBeInTheDocument();
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
    await waitFor(() => expect(lastSteps(calls)).toEqual([
      { id: 's1', action: 'order.cancel', input: { order: '{{subject.id}}', reason: 'Zahlung fehlt', notify: true } },
    ]));
    expect(put(calls)[0]!.headers.get('if-match')).toBe('"1"');
    expect(await screen.findByText(/^Gespeichert um \d\d:\d\d$/)).toBeInTheDocument();
  });

  it('Wenn/Sonst verschachtelt, Bedingung in Klartext, Verschieben per Tastatur', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', end: { result: 'completed' } }] }), {
      [`PUT /v1/workflows/${WF}`]: () => json(detail({ revision: 2 })),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
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
    await waitFor(() => expect(lastSteps(calls)).toEqual([
      { id: 's2', if: { all: [{ field: 'subject.values.total', op: 'gt', value: 100 }] }, then: [{ id: 's3', action: '', input: {} }], else: [{ id: 's4', end: { result: 'completed' } }] },
      { id: 's1', end: { result: 'completed' } },
    ]));
  });

  it('Entfernen mit Rückgängig: Hinweis mit Fokus, Schritt kommt zurück', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', end: { result: 'completed' } }, { id: 's2', set: { a: '1' } }] }), {
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    await screen.findByRole('region', { name: /Schritt 2: Werte setzen/ });
    await userEvent.click(screen.getByRole('button', { name: 'Schritt 1 entfernen' }));
    expect(screen.queryByRole('region', { name: /Beenden/ })).toBeNull();
    const undo = screen.getByRole('button', { name: 'Rückgängig' });
    expect(screen.getByText('Schritt 1 (Beenden) entfernt.')).toBeInTheDocument();
    await waitFor(() => expect(undo).toHaveFocus());
    await userEvent.click(undo);
    expect(screen.getByRole('region', { name: /Schritt 1: Beenden/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rückgängig' })).toBeNull();
    await waitFor(() => expect(lastSteps(calls)).toEqual([{ id: 's1', end: { result: 'completed' } }, { id: 's2', set: { a: '1' } }]));
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
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Name und Beschreibung …' }));
    const details = screen.getByRole('dialog', { name: 'Name und Beschreibung' });
    const name = within(details).getByLabelText('Name des Workflows');
    await userEvent.clear(name);
    await userEvent.click(within(details).getByRole('button', { name: 'Übernehmen' }));
    expect(within(details).getByText('Gib einen Namen ein.')).toBeInTheDocument();
    expect(name).toHaveFocus();
    await userEvent.type(name, 'Mein Name');
    await userEvent.click(within(details).getByRole('button', { name: 'Übernehmen' }));
    expect(screen.getByRole('heading', { name: 'Mein Name' })).toBeInTheDocument();
    const dialog = await screen.findByRole('alertdialog', { name: 'Inzwischen geändert' });
    expect(within(dialog).getByRole('button', { name: 'Neu laden' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Meine Fassung speichern' }));
    await waitFor(() => expect(put(calls)).toHaveLength(2));
    expect((put(calls)[1]!.body as { name: string }).name).toBe('Mein Name');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(put(calls)).toHaveLength(2);
  });

  it('Aktivieren: Zusammenfassung mit Akteur und Zeitplan, danach Statusleiste mit aktiver Version', async () => {
    const def: Partial<AutomationDefinition> = { trigger: { schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Zurich' } }, steps: [{ id: 's1', end: { result: 'completed' } }] };
    const { calls } = routes(detail({}, def), {
      [`POST /v1/workflows/${WF}/activate`]: () => json(detail({ state: 'active', activeVersion: 1, revision: 2, actor: { id: 'anna', kind: 'person' } }, def)),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    expect(await screen.findByText(/Läuft werktags \(Mo–Fr\) um 07:00/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Zustand des Workflows' })).toHaveTextContent('Noch nie aktiviert.');
    expect(screen.getByText(/handelt als: wird beim Aktivieren gewählt/)).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Aktivieren …' });
    await userEvent.click(open);
    const dialog = screen.getByRole('dialog', { name: 'Workflow aktivieren' });
    expect(within(dialog).getByText('Nach Zeitplan: werktags (Mo–Fr) um 07:00 (Europe/Zurich)')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Ich selbst (Anna Muster)')).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Aktivieren' })).toBeEnabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(open).toHaveFocus();
    await userEvent.click(open);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Workflow aktivieren' })).getByRole('button', { name: 'Aktivieren' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find(c => c.path.endsWith('/activate'))!.body).toEqual({ revision: 1 });
    expect(screen.getByText('Aktiv · Version 1')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Zustand des Workflows' })).toHaveTextContent('Aktiv mit Version 1. Keine offenen Änderungen.');
    expect(screen.getByRole('button', { name: 'Pausieren' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /aktivieren …/i })).toBeNull();
  });

  it('Entwurf weicht von der aktiven Version ab: «Version 2 aktivieren …», Verwerfen setzt ihn zurück', async () => {
    const v1: AutomationDefinition = { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 's1', end: { result: 'completed' } }] };
    const changed = { ...v1, steps: [...v1.steps, { id: 's2', set: { a: '1' } }] };
    const { calls } = routes(detail({ state: 'active', activeVersion: 1, actor: { id: 'anna', kind: 'person' } }, changed), {
      [`GET /v1/workflows/${WF}/versions/1`]: () => json({ version: 1, checksum: 'x', actor: { id: 'anna', kind: 'person' }, activatedBy: { id: 'anna', kind: 'person' }, activatedAt: '2026-11-01T08:00:00.000Z', definition: v1 }),
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ state: 'active', activeVersion: 1, revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    const bar = await screen.findByRole('group', { name: 'Zustand des Workflows' });
    await waitFor(() => expect(bar).toHaveTextContent('Der Entwurf weicht von Version 1 ab und wirkt erst nach dem Aktivieren.'));
    expect(within(bar).getByRole('button', { name: 'Version 2 aktivieren …' })).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Verwerfen …' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Entwurf verwerfen?' });
    expect(within(confirm).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(bar).toHaveTextContent('Aktiv mit Version 1. Keine offenen Änderungen.'));
    await waitFor(() => expect(lastSteps(calls)).toEqual(v1.steps));
  });

  it('Pausiert: «Fortsetzen» ohne neue Version', async () => {
    const def: Partial<AutomationDefinition> = { trigger: { manual: {} }, steps: [{ id: 's1', end: { result: 'completed' } }] };
    const { calls } = routes(detail({ state: 'paused', activeVersion: 3, pausedReason: 'Von Hand', actor: { id: 'anna', kind: 'person' } }, def), {
      [`POST /v1/workflows/${WF}/resume`]: () => json(detail({ state: 'active', activeVersion: 3, revision: 2, actor: { id: 'anna', kind: 'person' } }, def)),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    const bar = await screen.findByRole('group', { name: 'Zustand des Workflows' });
    expect(bar).toHaveTextContent('Pausiert: Von Hand. Version 3 startet keine neuen Läufe.');
    await userEvent.click(within(bar).getByRole('button', { name: 'Fortsetzen' }));
    await waitFor(() => expect(bar).toHaveTextContent('Aktiv mit Version 3.'));
    expect(calls.some(c => c.path.endsWith('/resume'))).toBe(true);
    expect(calls.some(c => c.path.endsWith('/activate'))).toBe(false);
  });

  it('Aktivieren ist nicht vorab gesperrt: offene Stellen erscheinen beim Absenden im Dialog', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', action: '' }] }), {
      'POST /v1/workflows/validate': () => json({ ok: false, errors: [{ path: '/steps/0/action', message: 'Ungültige Schreibweise' }], stage: [] }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    await screen.findByRole('list', { name: 'Hinweise zu Schritt 1' });
    await userEvent.click(screen.getByRole('button', { name: 'Aktivieren …' }));
    const dialog = screen.getByRole('dialog', { name: 'Workflow aktivieren' });
    expect(within(dialog).getByText('Die Prüfung meldet noch 1 offene Stelle.')).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Aktivieren' });
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Zuerst diese Stelle beheben:Schritt 1: Ungültige Schreibweise');
    expect(calls.some(c => c.path.endsWith('/activate'))).toBe(false);
  });

  it('Probelauf mit gesuchtem Bezug zeigt das Ergebnis je Schritt mit Nummer und Titel', async () => {
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
    expect(screen.queryByRole('list', { name: 'Treffer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ändern' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Probelauf starten' }));
    const result = await screen.findByRole('region', { name: 'Ergebnis des Probelaufs' });
    expect(result).toHaveTextContent('Schritt 1 · Aktion «Bestellung stornieren»: würde Bestellung o1 stornieren');
    expect(result).not.toHaveTextContent('s1:');
    expect(result).toHaveTextContent('Dem Akteur fehlen Rechte: order:write');
    expect(within(result).getByText('Technische Details')).toBeInTheDocument();
    expect(calls.find(c => c.path.endsWith('/dry-run'))!.body).toMatchObject({ subject: { type: 'order', id: 'o1' }, definition: { kind: 'automation' } });
  });

  it('ohne workflow:manage nur lesbar', async () => {
    routes(detail({}, { steps: [{ id: 's1', end: { result: 'completed' } }] }));
    renderWith(<StepListEditor workflowId={WF} />, { perms: ['workflow:read'] });
    expect(await screen.findByText(/Zum Bearbeiten fehlt dir das Recht «Workflows bearbeiten»/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Storno bei Zahlungsausfall' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Name und Beschreibung …' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schritt hinzufügen' })).toBeNull();
    expect(screen.queryByText('Alle Änderungen gespeichert')).toBeNull();
  });

  it('ohne Titel, wenn die App den Namen im Seitenkopf zeigt', async () => {
    routes(detail());
    renderWith(<StepListEditor workflowId={WF} showTitle={false} />);
    await screen.findByRole('group', { name: 'Zustand des Workflows' });
    expect(screen.queryByRole('heading', { name: 'Storno bei Zahlungsausfall' })).toBeNull();
  });
});
