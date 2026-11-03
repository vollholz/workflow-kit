/**
 * Editor: Ablauf wächst Schritt für Schritt (leer nur «Ersten Schritt hinzufügen», Auslöser im Sheet), Einfügen an jeder
 * Stelle über das Sheet (Gruppen, Zurück, Suche), Wege, Tastatur, Aktion aus dem Schema, Platzhalter, Prüfung am
 * Schritt, Entwurf speichert sich selbst, Konflikt beim Speichern, Werkzeugleiste (Zustand, Hauptaktion, Menü «Weitere
 * Aktionen»), Entfernen mit Rückgängig, Zeitplan als Auswahl, Probelauf mit Schrittnamen; dazu die reinen Hilfen für
 * Pfade und Zeitpläne.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAt, numberOf, splitPath, stepAt, withList } from '../src/flow.tsx';
import { StepListEditor, type AutomationDefinition, type Step, type WorkflowDetail } from '../src/index.ts';
import { cronOfPlan, planOfCron } from '../src/trigger.tsx';
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
const lastDef = (calls: Call[]) => (put(calls).at(-1)?.body as { definition: AutomationDefinition } | undefined)?.definition;
const lastSteps = (calls: Call[]) => lastDef(calls)?.steps;
const detailPane = () => screen.getByRole('complementary', { name: 'Detail' });
const row = (name: RegExp) => screen.getByRole('button', { name });
const bar = () => screen.getByRole('group', { name: 'Zustand des Workflows' });
/** Schritt im Sheet wählen: Gruppe öffnen, dann den Schritt. */
async function pick(group: string, step: RegExp) {
  const sheet = screen.getByRole('dialog', { name: 'Schritt hinzufügen' });
  await userEvent.click(within(sheet).getByRole('button', { name: new RegExp(`^${group}`) }));
  await userEvent.click(within(within(sheet).getByRole('group', { name: group })).getByRole('button', { name: step }));
}
async function menu(item: string) {
  await userEvent.click(within(bar()).getByRole('button', { name: 'Weitere Aktionen' }));
  await userEvent.click(screen.getByRole('menuitem', { name: item }));
}

describe('Pfade im Ablauf', () => {
  const steps: Step[] = [
    { id: 'a', end: { result: 'completed' } },
    { id: 'b', if: { field: 'x', op: 'isSet' }, then: [{ id: 'c', set: { v: 1 } }] },
  ];
  it('lesen, ändern, nummerieren; ein leeres «Sonst» fällt weg', () => {
    expect(splitPath('/steps/1/then/0')).toEqual({ list: '/steps/1/then', index: 0 });
    expect(stepAt(steps, '/steps/1/then/0')?.id).toBe('c');
    expect(listAt(steps, '/steps/1/else')).toEqual([]);
    expect(numberOf('/steps/1/then/0')).toBe('2.1');
    expect(numberOf('/steps/1/else/0')).toBe('2.s1');
    const added = withList(steps, '/steps/1/else', l => [...l, { id: 'd', end: { result: 'failed' } }]);
    expect(stepAt(added, '/steps/1/else/0')?.id).toBe('d');
    expect(steps[1]).not.toHaveProperty('else');
    const cleared = withList(added, '/steps/1/else', () => []);
    expect(cleared[1]).not.toHaveProperty('else');
  });
});

describe('Zeitplan als Auswahl', () => {
  it('übersetzt einfache Muster in beide Richtungen; anderes bleibt eigener Ausdruck', () => {
    expect(planOfCron('0 7 * * 1-5')).toMatchObject({ rhythm: 'workdays', time: '07:00' });
    expect(planOfCron('30 6 * * 1,5')).toMatchObject({ rhythm: 'weekly', time: '06:30', days: [1, 5] });
    expect(planOfCron('15 * * * *')).toMatchObject({ rhythm: 'hourly', minute: 15 });
    expect(planOfCron('0 8 1 * *')).toMatchObject({ rhythm: 'monthly', dom: 1 });
    expect(planOfCron('*/5 9-17 * * *').rhythm).toBe('custom');
    expect(cronOfPlan({ rhythm: 'weekly', time: '07:00', days: [5, 1], dom: 1, minute: 0 }, '')).toBe('0 7 * * 1,5');
    expect(cronOfPlan({ rhythm: 'custom', time: '07:00', days: [], dom: 1, minute: 0 }, '1 2 3 4 5')).toBe('1 2 3 4 5');
  });
});

describe('StepListEditor', () => {
  it('leerer Ablauf: «Ersten Schritt hinzufügen» wählt den Auslöser im Sheet, danach wächst der Ablauf', async () => {
    const { calls } = routes(detail({}, { trigger: { manual: {} }, steps: [] }), {
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
      'POST /v1/workflows/schedule-preview': () => json({ ok: true, error: null, next: [] }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    const first = await screen.findByRole('button', { name: /Ersten Schritt hinzufügen/ });
    expect(screen.queryByRole('button', { name: 'Auslöser' })).toBeNull();
    expect(screen.queryByText('Ende')).toBeNull();
    expect(within(detailPane()).getByText('Noch kein Schritt')).toBeInTheDocument();
    await userEvent.click(first);
    const sheet = screen.getByRole('dialog', { name: 'Wie startet der Workflow?' });
    expect(within(sheet).getByRole('button', { name: /^Wenn etwas passiert/ })).toHaveFocus();
    await userEvent.click(within(sheet).getByRole('button', { name: /^Nach Zeitplan/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(row(/^Auslöser$/)).toHaveTextContent('Nach Zeitplan');
    expect(within(detailPane()).getByLabelText('Wiederholen')).toHaveValue('workdays');
    expect(screen.getByRole('button', { name: 'Schritt einfügen nach dem Auslöser' })).toHaveTextContent('Schritt hinzufügen');
    await waitFor(() => expect(lastDef(calls)?.trigger).toMatchObject({ schedule: { cron: '0 7 * * 1-5' } }));
  });

  it('Einfügen nach dem Auslöser: Sheet mit Gruppen, Zurück und Suche; Aktion aus dem Schema; der Entwurf speichert sich mit If-Match', async () => {
    const { calls } = routes(detail(), {
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    expect(await screen.findByRole('button', { name: 'Auslöser' })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(within(bar()).getByText('Gespeichert')).toBeInTheDocument();
    const plus = screen.getByRole('button', { name: 'Schritt einfügen nach dem Auslöser' });
    await userEvent.click(plus);
    const sheet = screen.getByRole('dialog', { name: 'Schritt hinzufügen' });
    const search = within(sheet).getByRole('searchbox', { name: 'Schritt suchen' });
    expect(search).toHaveFocus();
    const groups = within(sheet).getByRole('list', { name: 'Gruppen' });
    expect(within(groups).getAllByRole('button').map(b => b.textContent)).toEqual([
      expect.stringMatching(/^BestellungenBestellung stornieren/), expect.stringMatching(/^Ablauf steuernWenn \/ Sonst/),
    ]);
    await userEvent.click(within(groups).getByRole('button', { name: /^Ablauf steuern/ }));
    expect(within(sheet).getByRole('button', { name: '← Zurück' })).toHaveFocus();
    await userEvent.click(within(sheet).getByRole('button', { name: '← Zurück' }));
    await waitFor(() => expect(within(sheet).getByRole('button', { name: /^Ablauf steuern/ })).toHaveFocus());
    await userEvent.type(search, 'xyz');
    expect(within(sheet).getByText('Kein Schritt passt zur Suche.')).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'storn');
    expect(within(sheet).queryByRole('button', { name: /^Wenn/ })).toBeNull();
    await userEvent.click(within(within(sheet).getByRole('group', { name: 'Bestellungen' })).getByRole('button', { name: /^Bestellung stornieren/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const card = within(detailPane()).getByRole('region', { name: /Schritt 1: Aktion «Bestellung stornieren»/ });
    expect(row(/^Schritt 1: Aktion «Bestellung stornieren»/)).toHaveAttribute('aria-current', 'true');
    expect(within(card).getByLabelText(/^Grund/)).toBeRequired();
    await userEvent.type(within(card).getByLabelText(/^Grund/), 'Zahlung fehlt');
    await userEvent.click(within(card).getByLabelText('Kundschaft benachrichtigen'));
    await userEvent.click(within(card).getByRole('button', { name: 'Platzhalter einfügen in «Bestellung»' }));
    const ph = screen.getByRole('dialog', { name: 'Platzhalter wählen' });
    await userEvent.click(within(within(ph).getByRole('group', { name: 'Bezug: Bestellung' })).getByRole('button', { name: /^ID/ }));
    expect(within(card).getByLabelText(/^Bestellung/)).toHaveValue('{{subject.id}}');
    await waitFor(() => expect(lastSteps(calls)).toEqual([
      { id: 's1', action: 'order.cancel', input: { order: '{{subject.id}}', reason: 'Zahlung fehlt', notify: true } },
    ]));
    expect(put(calls)[0]!.headers.get('if-match')).toBe('"1"');
  });

  it('Sheet schliesst mit Esc und gibt den Fokus an «+» zurück', async () => {
    routes(detail());
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    const plus = await screen.findByRole('button', { name: 'Schritt einfügen nach dem Auslöser' });
    await userEvent.click(plus);
    expect(screen.getByRole('dialog', { name: 'Schritt hinzufügen' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(plus).toHaveFocus();
  });

  it('Wenn/Sonst: Bedingung im Detail, Schritte in den Wegen einfügen, Tastatur wechselt und verschiebt', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', end: { result: 'completed' } }] }), {
      [`PUT /v1/workflows/${WF}`]: () => json(detail({ revision: 2 })),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    const start = await screen.findByRole('button', { name: 'Auslöser' });
    start.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(row(/^Schritt 1: Beenden/)).toHaveFocus();
    expect(row(/^Schritt 1: Beenden/)).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Schritt einfügen nach Schritt 1' }));
    await pick('Ablauf steuern', /^Wenn \/ Sonst/);
    const ifCard = within(detailPane()).getByRole('region', { name: /Schritt 2: Wenn \/ Sonst/ });
    const cond = within(ifCard).getByRole('group', { name: 'Schritt 2: Bedingung, Teil 1' });
    await userEvent.selectOptions(within(cond).getByLabelText('Schritt 2: Bedingung, Teil 1: Feld'), 'Betrag');
    await userEvent.selectOptions(within(cond).getByLabelText('Schritt 2: Bedingung, Teil 1: Vergleich'), 'ist grösser als');
    await userEvent.type(within(cond).getByLabelText('Schritt 2: Bedingung, Teil 1: Wert'), '100');
    expect(row(/^Schritt 2: Wenn \/ Sonst/)).toHaveTextContent('Wenn «Betrag» ist grösser als «100»');
    await userEvent.click(screen.getByRole('button', { name: 'Schritt einfügen am Anfang von «Dann» in Schritt 2' }));
    await pick('Bestellungen', /^Bestellung stornieren/);
    await userEvent.click(screen.getByRole('button', { name: 'Schritt einfügen am Anfang von «Sonst» in Schritt 2' }));
    expect(within(screen.getByRole('dialog', { name: 'Schritt hinzufügen' })).getByText('Am Anfang von «Sonst» in Schritt 2')).toBeInTheDocument();
    await pick('Ablauf steuern', /^Beenden/);
    expect(row(/^Schritt 2\.1: Aktion «Bestellung stornieren»/)).toBeInTheDocument();
    expect(row(/^Schritt 2\.s1: Beenden/)).toHaveAttribute('aria-current', 'true');
    row(/^Schritt 2: Wenn \/ Sonst/).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(row(/^Schritt 1: Wenn \/ Sonst/)).toHaveFocus());
    expect(within(detailPane()).getByRole('button', { name: 'Schritt 1 nach oben' })).toBeDisabled();
    await waitFor(() => expect(lastSteps(calls)).toEqual([
      { id: 's2', if: { all: [{ field: 'subject.values.total', op: 'gt', value: 100 }] }, then: [{ id: 's3', action: 'order.cancel', input: {} }], else: [{ id: 's4', end: { result: 'completed' } }] },
      { id: 's1', end: { result: 'completed' } },
    ]));
  });

  it('Entfernen mit Rückgängig (Knopf und Entf): Hinweis mit Fokus, Schritt kommt zurück', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', end: { result: 'completed' } }, { id: 's2', set: { a: '1' } }] }), {
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Schritt 1: Beenden/ }));
    await userEvent.click(within(detailPane()).getByRole('button', { name: 'Schritt 1 entfernen' }));
    expect(screen.queryByRole('button', { name: /Beenden/ })).toBeNull();
    const undo = screen.getByRole('button', { name: 'Rückgängig' });
    expect(screen.getByText('Schritt 1 (Beenden) entfernt.')).toBeInTheDocument();
    await waitFor(() => expect(undo).toHaveFocus());
    await userEvent.click(undo);
    expect(row(/^Schritt 1: Beenden/)).toBeInTheDocument();
    row(/^Schritt 2: Werte setzen/).focus();
    await userEvent.keyboard('{Delete}');
    expect(screen.queryByRole('button', { name: /Werte setzen/ })).toBeNull();
    expect(screen.getByText('Schritt 2 (Werte setzen) entfernt.')).toBeInTheDocument();
    await waitFor(() => expect(lastSteps(calls)).toEqual([{ id: 's1', end: { result: 'completed' } }]));
  });

  it('Hinweise: Zähler an der Karte und in der Leiste; Klick springt zur ersten Stelle', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', action: 'order.cancel', input: {} }, { id: 's2', if: { field: 'steps.x.state', op: 'eq', value: 'a' }, then: [{ id: 's3', end: { result: 'completed' } }] }] }), {
      'POST /v1/workflows/validate': () => json({
        ok: false,
        errors: [
          { path: '/steps/1/if/field', message: 'Verweis auf unbekannten Schritt «x»' },
          { path: '/steps/0/input/reason', message: 'Pflichtangabe «reason» fehlt' },
          { path: '/steps/1/then/0/end/result', message: 'Erlaubt: «completed»' },
          { path: '/trigger/event', message: 'Unbekannter Ereignistyp «order.updated»' },
        ],
        stage: [],
      }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    const pane = await screen.findByRole('complementary', { name: 'Detail' });
    expect(await within(pane).findByRole('list', { name: 'Hinweise zum Auslöser' })).toHaveTextContent('Unbekannter Ereignistyp');
    await waitFor(() => expect(row(/^Schritt 1: Aktion/)).toHaveTextContent('1 Hinweis'));
    expect(row(/^Schritt 2\.1: Beenden/)).toHaveTextContent('1 Hinweis');
    await userEvent.click(within(bar()).getByRole('button', { name: '4 Hinweise' }));
    expect(row(/^Schritt 2: Wenn/)).toHaveAttribute('aria-current', 'true');
    const second = within(detailPane()).getByRole('list', { name: 'Hinweise zu Schritt 2' });
    expect(second).toHaveTextContent('Verweis auf unbekannten Schritt «x»');
    expect(second).not.toHaveTextContent('Erlaubt');
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
    await screen.findByRole('button', { name: 'Auslöser' });
    await menu('Name und Beschreibung …');
    const dialog0 = screen.getByRole('dialog', { name: 'Name und Beschreibung' });
    const name = within(dialog0).getByLabelText('Name des Workflows');
    await userEvent.clear(name);
    await userEvent.click(within(dialog0).getByRole('button', { name: 'Übernehmen' }));
    expect(within(dialog0).getByText('Gib einen Namen ein.')).toBeInTheDocument();
    await userEvent.type(name, 'Mein Name');
    await userEvent.click(within(dialog0).getByRole('button', { name: 'Übernehmen' }));
    expect(screen.getByRole('heading', { name: 'Mein Name' })).toBeInTheDocument();
    const dialog = await screen.findByRole('alertdialog', { name: 'Inzwischen geändert' });
    expect(within(dialog).getByRole('button', { name: 'Neu laden' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Meine Fassung speichern' }));
    await waitFor(() => expect(put(calls)).toHaveLength(2));
    expect((put(calls)[1]!.body as { name: string }).name).toBe('Mein Name');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(put(calls)).toHaveLength(2);
  });

  it('Menü «Weitere Aktionen»: Tastatur; «Name und Beschreibung …» öffnet die Einstellungen der App', async () => {
    routes(detail());
    const onOpenSettings = vi.fn();
    renderWith(<StepListEditor workflowId={WF} onOpenSettings={onOpenSettings} />);
    await screen.findByRole('button', { name: 'Auslöser' });
    const more = within(bar()).getByRole('button', { name: 'Weitere Aktionen' });
    await userEvent.click(more);
    const items = screen.getAllByRole('menuitem');
    expect(items.map(i => i.textContent)).toEqual(['Name und Beschreibung …', 'Entwurf löschen …']);
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(more).toHaveFocus();
    await menu('Name und Beschreibung …');
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Zeitplan als Auswahl: Wochentage wählen, nächste Ausführungen vom Server, Cron nur zum Nachlesen', async () => {
    const { calls } = routes(detail({}, { trigger: { schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Zurich' } }, steps: [] }), {
      'POST /v1/workflows/schedule-preview': () => json({ ok: true, error: null, next: ['2026-11-06T06:00:00.000Z', '2026-11-09T06:00:00.000Z', '2026-11-13T06:00:00.000Z'] }),
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    const pane = await screen.findByRole('complementary', { name: 'Detail' });
    expect(within(pane).getByText('Nach Zeitplan: werktags (Mo–Fr) um 07:00 (Europe/Zurich)')).toBeInTheDocument();
    expect(within(pane).getByLabelText('Wiederholen')).toHaveValue('workdays');
    await userEvent.selectOptions(within(pane).getByLabelText('Wiederholen'), 'weekly');
    expect(within(pane).getByLabelText('Mo')).toBeChecked();
    await userEvent.click(within(pane).getByLabelText('Fr'));
    expect(await within(pane).findByText('Nächste Ausführungen')).toBeInTheDocument();
    expect(within(pane).getAllByRole('listitem')).toHaveLength(3);
    await waitFor(() => expect(lastDef(calls)?.trigger).toEqual({ schedule: { cron: '0 7 * * 1,5', timezone: 'Europe/Zurich' } }));
  });

  it('Aktivieren: Zusammenfassung mit Akteur und Zeitplan, danach Zustand «Aktiv · Version 1»', async () => {
    const def: Partial<AutomationDefinition> = { trigger: { schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Zurich' } }, steps: [{ id: 's1', end: { result: 'completed' } }] };
    const { calls } = routes(detail({}, def), {
      [`POST /v1/workflows/${WF}/activate`]: () => json(detail({ state: 'active', activeVersion: 1, revision: 2, actor: { id: 'anna', kind: 'person' } }, def)),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    await screen.findByRole('button', { name: 'Auslöser' });
    expect(bar()).toHaveTextContent('Entwurf');
    expect(bar()).toHaveTextContent('noch nicht aktiv');
    const open = within(bar()).getByRole('button', { name: 'Aktivieren …' });
    await userEvent.click(open);
    const dialog = screen.getByRole('dialog', { name: 'Workflow aktivieren' });
    expect(within(dialog).getByText('Nach Zeitplan: werktags (Mo–Fr) um 07:00 (Europe/Zurich)')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Ich selbst (Anna Muster)')).toBeChecked();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(open).toHaveFocus();
    await userEvent.click(open);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Workflow aktivieren' })).getByRole('button', { name: 'Aktivieren' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find(c => c.path.endsWith('/activate'))!.body).toEqual({ revision: 1 });
    expect(within(bar()).getByText('Aktiv · Version 1')).toBeInTheDocument();
    expect(bar()).not.toHaveTextContent('noch nicht aktiv');
    expect(within(bar()).queryByRole('button', { name: /aktivieren …/i })).toBeNull();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Weitere Aktionen' }));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Pausieren', 'Name und Beschreibung …', 'Archivieren …']);
  });

  it('Entwurf weicht von der aktiven Version ab: «Version 2 aktivieren …», Verwerfen im Menü setzt ihn zurück', async () => {
    const v1: AutomationDefinition = { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 's1', end: { result: 'completed' } }] };
    const changed = { ...v1, steps: [...v1.steps, { id: 's2', set: { a: '1' } }] };
    const { calls } = routes(detail({ state: 'active', activeVersion: 1, actor: { id: 'anna', kind: 'person' } }, changed), {
      [`GET /v1/workflows/${WF}/versions/1`]: () => json({ version: 1, checksum: 'x', actor: { id: 'anna', kind: 'person' }, activatedBy: { id: 'anna', kind: 'person' }, activatedAt: '2026-11-01T08:00:00.000Z', definition: v1 }),
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ state: 'active', activeVersion: 1, revision: 2 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} saveDelayMs={0} />);
    await screen.findByRole('button', { name: 'Auslöser' });
    await waitFor(() => expect(bar()).toHaveTextContent('Änderungen noch nicht aktiv'));
    expect(within(bar()).getByRole('button', { name: 'Version 2 aktivieren …' })).toBeInTheDocument();
    await menu('Änderungen verwerfen …');
    const confirm = screen.getByRole('alertdialog', { name: 'Entwurf verwerfen?' });
    expect(within(confirm).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(bar()).not.toHaveTextContent('Änderungen noch nicht aktiv'));
    expect(within(bar()).getByText('Aktiv · Version 1')).toBeInTheDocument();
    await waitFor(() => expect(lastSteps(calls)).toEqual(v1.steps));
  });

  it('Pausiert: Meldung mit Grund, «Fortsetzen» ohne neue Version', async () => {
    const def: Partial<AutomationDefinition> = { trigger: { manual: {} }, steps: [{ id: 's1', end: { result: 'completed' } }] };
    const { calls } = routes(detail({ state: 'paused', activeVersion: 3, pausedReason: 'Akteur nicht mehr aktiv', actor: { id: 'anna', kind: 'person' } }, def), {
      [`POST /v1/workflows/${WF}/resume`]: () => json(detail({ state: 'active', activeVersion: 3, revision: 2, actor: { id: 'anna', kind: 'person' } }, def)),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    await screen.findByRole('button', { name: 'Auslöser' });
    expect(within(bar()).getByText('Pausiert · Version 3')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Pausiert: Akteur nicht mehr aktiv');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Fortsetzen' }));
    await waitFor(() => expect(within(bar()).getByText('Aktiv · Version 3')).toBeInTheDocument());
    expect(calls.some(c => c.path.endsWith('/resume'))).toBe(true);
    expect(calls.some(c => c.path.endsWith('/activate'))).toBe(false);
  });

  it('Aktivieren ist nicht vorab gesperrt: offene Stellen erscheinen beim Absenden im Dialog', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', action: '' }] }), {
      'POST /v1/workflows/validate': () => json({ ok: false, errors: [{ path: '/steps/0/action', message: 'Ungültige Schreibweise' }], stage: [] }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    await waitFor(() => expect(row(/^Schritt 1: Aktion/)).toHaveTextContent('1 Hinweis'));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Aktivieren …' }));
    const dialog = screen.getByRole('dialog', { name: 'Workflow aktivieren' });
    expect(within(dialog).getByText('Die Prüfung meldet noch 1 offene Stelle.')).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Aktivieren' });
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Zuerst diese Stelle beheben:Schritt 1: Ungültige Schreibweise');
    expect(calls.some(c => c.path.endsWith('/activate'))).toBe(false);
  });

  it('Probelauf im Modus «Probelauf»: gesuchter Bezug, Ergebnis je Schritt mit Nummer und Titel', async () => {
    const { calls } = routes(detail({}, { steps: [{ id: 's1', action: 'order.cancel', input: { order: '{{subject.id}}', reason: 'x' } }] }), {
      [`POST /v1/workflows/${WF}/dry-run`]: () => json({
        triggerMatches: null, result: 'completed', variables: {},
        steps: [{ path: '/steps/0', stepId: 's1', kind: 'action', label: null, summary: 'würde Bestellung o1 stornieren', allowed: false, missing: ['order:write'], output: { state: 'cancelled' } }],
      }),
    });
    renderWith(<StepListEditor workflowId={WF} validateDelayMs={0} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Probelauf' }));
    const pane = screen.getByRole('complementary', { name: 'Probelauf' });
    await userEvent.type(within(pane).getByLabelText('Bestellung suchen'), 'o1');
    await userEvent.click(within(pane).getByRole('button', { name: 'Suchen' }));
    await userEvent.click(await within(pane).findByRole('button', { name: 'Bestellung o1 o1' }));
    expect(within(pane).queryByRole('list', { name: 'Treffer' })).toBeNull();
    await userEvent.click(within(pane).getByRole('button', { name: 'Probelauf starten' }));
    const result = await within(pane).findByRole('region', { name: 'Ergebnis des Probelaufs' });
    expect(result).toHaveTextContent('Schritt 1 · Aktion «Bestellung stornieren»: würde Bestellung o1 stornieren');
    expect(result).toHaveTextContent('Dem Akteur fehlen Rechte: order:write');
    expect(calls.find(c => c.path.endsWith('/dry-run'))!.body).toMatchObject({ subject: { type: 'order', id: 'o1' }, definition: { kind: 'automation' } });
    await userEvent.click(row(/^Schritt 1: Aktion/));
    expect(screen.getByRole('complementary', { name: 'Detail' })).toBeInTheDocument();
  });

  it('ohne workflow:manage nur lesbar: Karten öffnen, keine Stellen zum Einfügen, kein Speicherstand', async () => {
    routes(detail({}, { steps: [{ id: 's1', end: { result: 'completed' } }] }));
    renderWith(<StepListEditor workflowId={WF} />, { perms: ['workflow:read'] });
    expect(await screen.findByText(/Zum Bearbeiten fehlt dir das Recht «Workflows bearbeiten»/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Storno bei Zahlungsausfall' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Schritt einfügen/ })).toBeNull();
    expect(within(bar()).queryByText('Gespeichert')).toBeNull();
    expect(within(bar()).queryByRole('button', { name: 'Weitere Aktionen' })).toBeNull();
    await userEvent.click(row(/^Schritt 1: Beenden/));
    expect(within(detailPane()).getByRole('group', { name: 'Schritt 1 bearbeiten' })).toBeDisabled();
  });

  it('ohne Titel, wenn die App den Namen im Seitenkopf zeigt', async () => {
    routes(detail());
    renderWith(<StepListEditor workflowId={WF} showTitle={false} />);
    await screen.findByRole('group', { name: 'Zustand des Workflows' });
    expect(screen.queryByRole('heading', { name: 'Storno bei Zahlungsausfall' })).toBeNull();
  });
});
