/**
 * Reiter eines Workflows: Versionen (Liste, aktiv, Entwurf darüber; Vergleich, Ablauf, «Als Entwurf übernehmen») und
 * Einstellungen (Name und Beschreibung mit If-Match, Angaben zum Nachlesen, ohne Versionsnummer).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionList, WorkflowSettings, type AutomationDefinition, type WorkflowDetail } from '../src/index.ts';
import { json, META, mockFetch, renderWith, summary, WF } from './utils.tsx';

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
    expect(rows[0]).toHaveTextContent('Version 2 Aktiv');
    expect(rows[0]).toHaveTextContent('Anna Muster');
    expect(rows[1]).not.toHaveTextContent(/aktiv/i);
  });

  it('Version vergleichen (mit der vorherigen, mit dem Entwurf), Ablauf ansehen, als Entwurf übernehmen', async () => {
    const v1: AutomationDefinition = { schemaVersion: 1, kind: 'automation', trigger: { manual: {} }, steps: [{ id: 's1', end: { result: 'completed' } }] };
    const v2: AutomationDefinition = { ...v1, steps: [{ id: 's2', set: { geprueft: true } }, ...v1.steps] };
    const draft: AutomationDefinition = { ...v2, trigger: { event: 'order.updated' } };
    const meta = (version: number, active: boolean) => ({ version, checksum: String(version), actor: { id: 'anna', kind: 'person' }, activatedBy: { id: 'anna', kind: 'person' }, activatedAt: `2026-11-0${version}T09:00:00.000Z`, active });
    const { calls } = mockFetch({
      [`GET /v1/workflows/${WF}/versions`]: () => json({ items: [meta(2, true), meta(1, false)] }),
      [`GET /v1/workflows/${WF}/versions/1`]: () => json({ ...meta(1, false), definition: v1 }),
      [`GET /v1/workflows/${WF}/versions/2`]: () => json({ ...meta(2, true), definition: v2 }),
      [`GET /v1/workflows/${WF}`]: () => json({ ...detail({ revision: 7 }), definition: draft }),
      'GET /v1/workflows/meta': () => json(META),
      [`PUT /v1/workflows/${WF}`]: async req => json({ ...detail({ revision: 8 }), definition: ((await req.json()) as { definition: unknown }).definition }),
    });
    const onAdopted = vi.fn();
    const onOpenDraft = vi.fn();
    renderWith(<VersionList workflowId={WF} onAdopted={onAdopted} onOpenDraft={onOpenDraft} />);
    // Der Entwurf weicht ab: eigene Zeile über den Versionen, öffnet den Editor
    const top = (await screen.findByRole('button', { name: 'Entwurf' })).closest('tr')!;
    expect(top).toHaveTextContent('noch nicht aktiv · wird Version 3');
    await userEvent.click(within(top).getByRole('button', { name: 'Entwurf' }));
    expect(onOpenDraft).toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Version 2' }));
    const v = screen.getByRole('region', { name: 'Version 2' });
    const changes = await within(v).findByRole('list', { name: 'Version 2 gegenüber Version 1' });
    expect(changes).toHaveTextContent('Neu Schritt 1 · Werte setzen');
    await userEvent.selectOptions(within(v).getByLabelText('Vergleichen'), 'draft');
    expect(await within(v).findByRole('list', { name: 'Entwurf gegenüber Version 2' })).toHaveTextContent('Auslöser');
    await userEvent.click(within(v).getByText('Ablauf von Version 2 ansehen'));
    expect(within(v).getByRole('button', { name: /^Schritt 1: Werte setzen/ })).toBeInTheDocument();
    expect(within(v).queryByRole('button', { name: /Schritt einfügen/ })).toBeNull();
    await userEvent.click(within(v).getByRole('button', { name: 'Als Entwurf übernehmen …' }));
    const ask = screen.getByRole('alertdialog', { name: 'Version 2 als Entwurf übernehmen?' });
    expect(within(ask).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
    expect(ask).toHaveTextContent('bis dahin läuft Version 2 unverändert weiter');
    await userEvent.click(within(ask).getByRole('button', { name: 'Übernehmen' }));
    expect(await within(v).findByText('Der Entwurf entspricht jetzt Version 2. Er wirkt erst nach dem Aktivieren.')).toBeInTheDocument();
    const sent = calls.find(c => c.method === 'PUT')!;
    expect(sent.body).toEqual({ definition: v2 });
    expect(sent.headers.get('if-match')).toBe('"7"');
    expect(onAdopted).toHaveBeenCalled();
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
    expect(screen.queryByText(/Version \d/)).toBeNull();
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
