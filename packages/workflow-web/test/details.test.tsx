/** Reiter eines Workflows: Versionen (Liste, aktiv) und Einstellungen (Name und Beschreibung mit If-Match, Angaben zum Nachlesen). */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionList, WorkflowSettings, type WorkflowDetail } from '../src/index.ts';
import { json, mockFetch, renderWith, summary, WF } from './utils.tsx';

afterEach(() => vi.unstubAllGlobals());

const detail = (o: Partial<WorkflowDetail> = {}): WorkflowDetail => ({
  ...summary({ state: 'active', activeVersion: 2, actor: { id: 'anna', kind: 'person' }, ...o }),
  definition: { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [] },
});

describe('Reiter eines Workflows', () => {
  it('Versionen: neueste zuerst, aktive markiert, Personen mit Namen', async () => {
    mockFetch({
      [`GET /v1/workflows/${WF}/versions`]: () => json({ items: [
        { version: 2, checksum: 'b', actor: { id: 'anna', kind: 'person' }, activatedBy: { id: 'anna', kind: 'person' }, activatedAt: '2026-11-03T09:00:00.000Z', active: true },
        { version: 1, checksum: 'a', actor: { id: 'anna', kind: 'person' }, activatedBy: { id: 'anna', kind: 'person' }, activatedAt: '2026-11-01T09:00:00.000Z', active: false },
      ] }),
    });
    renderWith(<VersionList workflowId={WF} />);
    const table = await screen.findByRole('table', { name: 'Versionen' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Version 2 aktiv');
    expect(rows[0]).toHaveTextContent('Anna Muster');
    expect(rows[1]).not.toHaveTextContent('aktiv');
  });

  it('Versionen: leer mit Hinweis aufs Aktivieren', async () => {
    mockFetch({ [`GET /v1/workflows/${WF}/versions`]: () => json({ items: [] }) });
    renderWith(<VersionList workflowId={WF} />);
    expect(await screen.findByText('Eine Version entsteht beim Aktivieren des Entwurfs.')).toBeInTheDocument();
  });

  it('Einstellungen: fehlender Name am Feld, Speichern mit If-Match, Angaben zum Nachlesen', async () => {
    const { calls } = mockFetch({
      [`GET /v1/workflows/${WF}`]: () => json(detail()),
      [`PUT /v1/workflows/${WF}`]: () => json(detail({ revision: 2, name: 'Neu' })),
    });
    renderWith(<WorkflowSettings workflowId={WF} />);
    const name = await screen.findByLabelText('Name des Workflows');
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    expect(screen.getByText(/Version 2/)).toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(screen.getByText('Gib einen Namen ein.')).toBeInTheDocument();
    expect(name).toHaveFocus();
    await userEvent.type(name, 'Neu');
    await userEvent.type(screen.getByLabelText('Beschreibung'), 'Für Geräte');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
    const req = calls.find(c => c.method === 'PUT')!;
    expect(req.headers.get('if-match')).toBe('"1"');
    expect(req.body).toEqual({ name: 'Neu', description: 'Für Geräte' });
  });

  it('Einstellungen ohne workflow:manage nur lesbar', async () => {
    mockFetch({ [`GET /v1/workflows/${WF}`]: () => json(detail()) });
    renderWith(<WorkflowSettings workflowId={WF} />, { perms: ['workflow:read'] });
    expect(await screen.findByLabelText('Name des Workflows')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(screen.getByText(/Zum Ändern fehlt dir das Recht/)).toBeInTheDocument();
  });
});
