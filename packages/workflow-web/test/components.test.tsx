/** Provider (Pflichtangaben, eigener QueryClient, ersetzbare Bausteine) und Bausteine späterer Stufen. */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CaseView, MyWork, useWorkflow, WorkflowProvider, WorkflowList, type ButtonProps, type WorkflowApi } from '../src/index.ts';
import { json, ME, mockFetch, STATUS, summary } from './utils.tsx';

afterEach(() => vi.unstubAllGlobals());

function Probe() {
  const w = useWorkflow();
  return <p>{`${w.me?.id} ${w.can('workflow:run') ? 'darf' : 'darf nicht'} ${w.subjects.order?.label} ${w.prefix}`}</p>;
}

test('Provider gibt Konfiguration weiter; Fall (Stufe 3) zeigt «noch nicht verfügbar»', () => {
  render(
    <WorkflowProvider api={{}} me={ME} can={p => p === 'workflow:run'} subjects={{ order: { label: 'Bestellung' } }}>
      <Probe />
      <CaseView caseId="c1" />
    </WorkflowProvider>,
  );
  expect(screen.getByText('anna darf Bestellung /v1')).toBeInTheDocument();
  expect(screen.getAllByText('noch nicht verfügbar')).toHaveLength(1);
});

test('Pflichtangaben: ohne Provider, ohne api, can oder me ein verständlicher Fehler', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => render(<MyWork />)).toThrow(/<WorkflowProvider>/);
  expect(() => render(<WorkflowProvider api={undefined as unknown as WorkflowApi} me={ME} can={() => true} />)).toThrow(/«api» fehlt/);
  expect(() => render(<WorkflowProvider api={{}} me={ME} can={undefined as unknown as () => boolean} />)).toThrow(/«can» fehlt/);
  expect(() => render(<WorkflowProvider api={{}} me={undefined as unknown as null} can={() => true} />)).toThrow(/«me» fehlt/);
  spy.mockRestore();
});

test('ohne QueryClient der App: eigener; Präfix, Header, fetch der App und eigene Knöpfe werden genutzt', async () => {
  const appFetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/workflows/status') return json(STATUS);
    if (path === '/api/workflows') return json({ items: [summary()] });
    return json({ items: [], nextCursor: null });
  });
  const Button = ({ variant: _v, size: _s, ...p }: ButtonProps) => <button data-app-button="" {...p} />;
  render(
    <WorkflowProvider api={{ baseUrl: 'https://app.example', fetch: appFetch, headers: () => ({ 'X-Tenant': 't1' }) }} prefix="/api" me={ME} can={() => true} components={{ Button }}>
      <WorkflowList onOpen={() => {}} />
    </WorkflowProvider>,
  );
  expect(await screen.findByRole('button', { name: 'Storno bei Zahlungsausfall' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Neu' })).toHaveAttribute('data-app-button');
  const [url, init] = appFetch.mock.calls[0]!;
  expect(url).toBe('https://app.example/api/workflows/status');
  expect((init.headers as Record<string, string>)['X-Tenant']).toBe('t1');
});

test('Antwort 401 meldet die App über onUnauthorized', async () => {
  mockFetch({ 'GET /v1/workflows/status': () => json({ title: 'Bitte anmelden' }, 401) });
  const onUnauthorized = vi.fn();
  render(<WorkflowProvider api={{ onUnauthorized }} me={null} can={() => false}><WorkflowList onOpen={() => {}} /></WorkflowProvider>);
  await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
});
