/** Liste der Workflows: Spalten, letzte Läufe, Filter, Leerzustände, «Neu», Rechte, Hinweis bei ausgeschaltetem Modul. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowList } from '../src/index.ts';
import { json, mockFetch, renderWith, STATUS, summary, WF } from './utils.tsx';

afterEach(() => vi.unstubAllGlobals());

const ACTIVE = summary({ id: '22222222-2222-4222-8222-222222222222', name: 'Rechnung nachfassen', state: 'active', activeVersion: 3, actor: { id: 'bot', kind: 'client' }, revision: 5 });

describe('WorkflowList', () => {
  it('zeigt Name, Art, Bereich, Zustand, letzte Läufe und Akteur', async () => {
    mockFetch({
      'GET /v1/workflows/status': () => json(STATUS),
      'GET /v1/workflows': () => json({ items: [summary(), ACTIVE] }),
      'GET /v1/workflow-runs': () => json({ items: [{ state: 'completed' }, { state: 'completed' }, { state: 'incident' }].map((r, i) => ({ id: `r${i}`, workflowId: ACTIVE.id, ...r })), nextCursor: null }),
    });
    const onOpen = vi.fn();
    renderWith(<WorkflowList onOpen={onOpen} />, { props: { scopeLabel: s => (s.id === '*' ? 'Ganzer Mandant' : s.id), actors: { label: a => (a.id === 'bot' ? 'Abgleich-Client' : undefined) } } });
    const row = (await screen.findByRole('button', { name: 'Rechnung nachfassen' })).closest('tr')!;
    expect(within(row).getByText('Automation')).toBeInTheDocument();
    expect(within(row).getByText('Ganzer Mandant')).toBeInTheDocument();
    expect(within(row).getByText('Aktiv')).toBeInTheDocument();
    expect(within(row).getByText('Abgleich-Client')).toBeInTheDocument();
    expect(await within(row).findByLabelText('2 erfolgreich, 1 mit Fehler (letzte 3)')).toBeInTheDocument();
    const draft = screen.getByRole('button', { name: 'Storno bei Zahlungsausfall' }).closest('tr')!;
    expect(within(draft).getByText('Entwurf')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Rechnung nachfassen' }));
    expect(onOpen).toHaveBeenCalledWith(ACTIVE.id);
  });

  it('Leerzustand ohne Workflows; Filter ohne Treffer; Zustand geht als Filter an den Server', async () => {
    const { calls } = mockFetch({ 'GET /v1/workflows/status': () => json(STATUS), 'GET /v1/workflows': () => json({ items: [] }) });
    renderWith(<WorkflowList onOpen={() => {}} />);
    expect(await screen.findByText('Noch keine Workflows')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Zustand'), 'paused');
    expect(await screen.findByText('Kein Treffer')).toBeInTheDocument();
    expect(calls.some(c => c.path === '/v1/workflows' && c.search === '?state=paused')).toBe(true);
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
