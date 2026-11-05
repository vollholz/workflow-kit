/** Liste der Workflows: Spalten, letzter Run, Filter, Leerzustände, «Neu» (auch in der Leiste der App), Rechte, Hinweis bei ausgeschaltetem Modul. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtDateTime, NewWorkflowButton, WorkflowList, type WorkflowTemplate } from '../src/index.ts';
import { json, META, mockFetch, renderWith, STATUS, summary, WF } from './utils.tsx';

afterEach(() => vi.unstubAllGlobals());

const ACTIVE = summary({ id: '22222222-2222-4222-8222-222222222222', name: 'Rechnung nachfassen', state: 'active', activeVersion: 3, actor: { id: 'bot', kind: 'client' }, revision: 5 });

describe('WorkflowList', () => {
  it('zeigt Name, Art, Bereich, Zustand, letzten Run (öffnet ihn) und seinen Zustand; «Entwurf» öffnet den Editor', async () => {
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows': () => json({ items: [summary(), ACTIVE] }),
      'GET /v1/workflow-runs': () => json({ items: [{ id: 'r1', workflowId: ACTIVE.id, state: 'incident', startedAt: '2026-11-04T07:06:00.000Z' }], nextCursor: null }),
    });
    const onOpen = vi.fn(), onOpenRun = vi.fn();
    renderWith(<WorkflowList onOpen={onOpen} onOpenRun={onOpenRun} />, { props: { scopeLabel: s => (s.id === '*' ? 'Ganzer Mandant' : s.id) } });
    const row = (await screen.findByRole('button', { name: 'Rechnung nachfassen' })).closest('tr')!;
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Name', 'Art', 'Bereich', 'Zustand', 'Letzter Run', 'Run-Status']);
    expect(within(row).getByText('Automation')).toBeInTheDocument();
    expect(within(row).getByText('Ganzer Mandant')).toBeInTheDocument();
    expect(within(row).getByText('Aktiv')).toBeInTheDocument();
    expect(within(row).queryByText('Entwurf')).toBeNull();
    expect(row).not.toHaveTextContent(/v3|Version/);
    expect(await within(row).findByText('Vorfall')).toHaveClass('wf-badge', 'bad');
    const at = fmtDateTime('2026-11-04T07:06:00.000Z');
    await userEvent.click(within(row).getByRole('button', { name: `Run vom ${at} öffnen` }));
    expect(onOpenRun).toHaveBeenCalledWith(ACTIVE.id, 'r1');
    expect(onOpen).not.toHaveBeenCalled();
    // Nur der letzte Run, und nur für Workflows, die schon aktiv waren
    expect(calls.filter(c => c.path === '/v1/workflow-runs').map(c => c.search)).toEqual([`?workflowId=${ACTIVE.id}&limit=1`]);
    const draft = screen.getByRole('button', { name: 'Storno bei Zahlungsausfall' }).closest('tr')!;
    expect(within(draft).getByText('Inaktiv')).toBeInTheDocument();
    expect(within(draft).getAllByText('–')).toHaveLength(2);
    const mark = within(draft).getByRole('button', { name: 'Entwurf' });
    expect(mark).toHaveClass('wf-badge', 'draft');
    await userEvent.click(mark);
    expect(onOpen).toHaveBeenCalledWith(WF);
    // Die ganze Zeile öffnet den Workflow, nicht nur der Name
    onOpen.mockClear();
    await userEvent.click(within(row).getByText('Automation'));
    expect(onOpen).toHaveBeenCalledWith(ACTIVE.id);
  });

  it('«Neu» in der Leiste der App: NewWorkflowButton legt an, die Liste zeigt dann kein eigenes «Neu»', async () => {
    mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows': () => json({ items: [] }),
      'POST /v1/workflows': () => json({ ...summary({ name: 'Neuer Ablauf' }), definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [] } }, 201),
    });
    const onCreated = vi.fn();
    renderWith(<><NewWorkflowButton onCreated={onCreated} /><WorkflowList onOpen={() => {}} showCreate={false} /></>);
    expect(await screen.findByText('Noch keine Workflows')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Neu' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Neu' }));
    const dialog = screen.getByRole('dialog', { name: 'Neuer Workflow' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Neuer Ablauf');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Entwurf anlegen' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(WF));
  });

  it('Leerzustand ohne Workflows; Filter ohne Treffer; Zustand geht als Filter an den Server', async () => {
    const { calls } = mockFetch({ 'GET /v1/workflows/status': () => json(STATUS), 'GET /v1/workflows': () => json({ items: [] }) });
    renderWith(<WorkflowList onOpen={() => {}} />);
    expect(await screen.findByText('Noch keine Workflows')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Zustand'), 'archived');
    expect(await screen.findByText('Kein Treffer')).toBeInTheDocument();
    expect(calls.some(c => c.path === '/v1/workflows' && c.search === '?state=archived')).toBe(true);
  });

  it('Zustand Aktiv / Inaktiv / Archiviert; Inaktiv fasst nie aktivierte und deaktivierte zusammen; Filter «Mit Entwurf»', async () => {
    const PAUSED = summary({ id: '33333333-3333-4333-8333-333333333333', name: 'Mahnung senden', state: 'paused', activeVersion: 2, pausedReason: 'Der Akteur des Workflows ist nicht mehr aktiv' });
    const ARCHIVED = summary({ id: '44444444-4444-4444-8444-444444444444', name: 'Alte Regel', state: 'archived', activeVersion: 1 });
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows': () => json({ items: [{ ...ACTIVE, draftChanged: true }, summary(), PAUSED, { ...ARCHIVED, draftChanged: true }] }),
      'GET /v1/workflow-runs': () => json({ items: [], nextCursor: null }),
    });
    renderWith(<WorkflowList onOpen={() => {}} />);
    const rowOf = async (name: string) => (await screen.findByRole('button', { name })).closest('tr')!;
    const paused = await rowOf('Mahnung senden');
    expect(within(paused).getByText('Inaktiv')).toBeInTheDocument();
    expect(within(paused).getByText('automatisch deaktiviert')).toHaveAttribute('title', 'Der Akteur des Workflows ist nicht mehr aktiv');
    expect(within(paused).queryByText('Entwurf')).toBeNull();
    expect(within(await rowOf('Rechnung nachfassen')).getByText('Entwurf')).toBeInTheDocument();
    const archived = await rowOf('Alte Regel');
    expect(within(archived).getByText('Archiviert')).toBeInTheDocument();
    expect(within(archived).queryByText('Entwurf')).toBeNull();
    expect([...(screen.getByLabelText('Zustand') as HTMLSelectElement).options].map(o => o.text)).toEqual(['Alle Zustände', 'Aktiv', 'Inaktiv', 'Archiviert', 'Mit Entwurf']);

    await userEvent.selectOptions(screen.getByLabelText('Zustand'), 'inactive');
    expect(screen.getAllByRole('row').slice(1).map(r => within(r).getAllByRole('button')[0]!.textContent)).toEqual(['Storno bei Zahlungsausfall', 'Mahnung senden']);
    await userEvent.selectOptions(screen.getByLabelText('Zustand'), 'draft');
    expect(screen.getAllByRole('row').slice(1).map(r => within(r).getAllByRole('button')[0]!.textContent)).toEqual(['Rechnung nachfassen', 'Storno bei Zahlungsausfall']);
    expect(calls.filter(c => c.path === '/v1/workflows').every(c => !c.search.includes('state='))).toBe(true);
  });

  it('«Neu» legt einen Entwurf im Bereich an und öffnet ihn', async () => {
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows': () => json({ items: [] }),
      'POST /v1/workflows': () => json({ ...summary({ name: 'Neuer Ablauf' }), definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [] } }, 201),
    });
    const onOpen = vi.fn();
    renderWith(<WorkflowList onOpen={onOpen} scope={{ type: 'shop', id: 'zurich' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Neu' }));
    const dialog = screen.getByRole('dialog', { name: 'Neuer Workflow' });
    expect(within(dialog).getByLabelText('Name')).toHaveFocus();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Neuer Ablauf');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Entwurf anlegen' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(WF));
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ name: 'Neuer Ablauf', scope: { type: 'shop', id: 'zurich' } });
    expect(calls.find(c => c.method === 'POST')!.headers.get('x-csrf-token')).toBe('csrf-1');
  });

  it('Workflow als Satz: Auslöser und Schritte dessen, was läuft; abweichender Entwurf und offene Vorfälle markiert', async () => {
    mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows/meta': () => json(META),
      'GET /v1/workflows': () => json({ items: [
        { ...ACTIVE, trigger: { event: 'order.updated' }, stepCount: 3, draftChanged: true, openIncidents: 2 },
        { ...summary(), trigger: { manual: {} }, stepCount: 0, draftChanged: false, openIncidents: 0 },
      ] }),
      'GET /v1/workflow-runs': () => json({ items: [], nextCursor: null }),
    });
    renderWith(<WorkflowList onOpen={() => {}} showTitle={false} />);
    const row = (await screen.findByRole('button', { name: 'Rechnung nachfassen' })).closest('tr')!;
    expect(screen.getByRole('heading', { name: 'Workflows' })).toHaveClass('wf-sr');
    expect(await within(row).findByText('Bei «Bestellung geändert» · 3 Schritte')).toBeInTheDocument();
    expect(within(row).getByText('2 Vorfälle')).toBeInTheDocument();
    expect(within(row).getByText('Aktiv')).toBeInTheDocument();
    expect(within(row).getByText('Entwurf')).toBeInTheDocument();
    const draft = screen.getByRole('button', { name: 'Storno bei Zahlungsausfall' }).closest('tr')!;
    expect(within(draft).getByText('Von Hand · noch ohne Schritte')).toBeInTheDocument();
    expect(within(draft).getByText('Inaktiv')).toBeInTheDocument();
    expect(within(draft).getByText('Entwurf')).toBeInTheDocument();
  });

  it('«Neu» mit Vorlage: Vorlagen der App vor denen des Baukastens, Name vorgeschlagen, Definition geht mit', async () => {
    const { calls } = mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows/meta': () => json(META),
      'GET /v1/workflows': () => json({ items: [] }),
      'POST /v1/workflows': () => json({ ...summary({ name: 'Stornieren' }), definition: { schemaVersion: 2, kind: 'automation', trigger: { manual: {} }, steps: [] } }, 201),
    });
    const app: WorkflowTemplate[] = [
      { key: 'cancel', name: 'Stornieren', description: 'Bestellung von Hand stornieren.', build: () => ({ schemaVersion: 2, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 's1', action: 'order.cancel', input: {} }] }) },
      { key: 'nope', name: 'Passt nicht', description: 'Fehlt im Bereich.', build: () => null },
    ];
    const onOpen = vi.fn();
    renderWith(<WorkflowList onOpen={onOpen} templates={app} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Neu' }));
    const dialog = screen.getByRole('dialog', { name: 'Neuer Workflow' });
    const choices = within(within(dialog).getByRole('group', { name: 'Beginnen mit' })).getAllByRole('radio');
    expect(choices.map(c => c.closest('label')!.querySelector('b')!.textContent)).toEqual(['Leer', 'Stornieren', 'Regelmässig nach Zeitplan']); // Aufgabe und Genehmigung bietet META nicht an
    expect(choices[0]).toBeChecked();
    expect(within(dialog).getByLabelText('Name')).toHaveFocus();
    await userEvent.click(choices[1]!);
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Stornieren');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Entwurf anlegen' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(WF));
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({
      name: 'Stornieren', scope: { type: 'tenant', id: '*' }, definition: { schemaVersion: 2, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 's1', action: 'order.cancel', input: {} }] },
    });
  });

  it('ohne workflow:manage kein «Neu»; anderer Leertext', async () => {
    mockFetch({ 'GET /v1/workflows/status': () => json(STATUS), 'GET /v1/workflows': () => json({ items: [] }) });
    renderWith(<WorkflowList onOpen={() => {}} />, { perms: ['workflow:read'] });
    expect(await screen.findByText(/sobald jemand mit dem Recht dazu/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Neu' })).toBeNull();
  });

  it('Modul für den Mandanten nicht eingeschaltet: Hinweis statt Liste', async () => {
    const { calls } = mockFetch({ 'GET /v1/workflows/status': () => json({ ...STATUS, available: false }) });
    renderWith(<WorkflowList onOpen={() => {}} />);
    expect(await screen.findByText('Workflows sind noch nicht eingeschaltet.')).toBeInTheDocument();
    expect(calls.map(c => c.path)).toEqual(['/v1/workflows/status']);
  });
});
