/** Testhilfen: Provider (Query, Konfiguration), ein fetch-Ersatz mit Antworten je Pfad und Beispieldaten der Mini-App «shop». */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { WorkflowProvider, type WorkflowMetaJson, type WorkflowProviderProps, type WorkflowSummary } from '../src/index.ts';

export const ME = { id: 'anna', kind: 'person' as const, label: 'Anna Muster' };
export const ALL = ['workflow:read', 'workflow:manage', 'workflow:activate', 'workflow:run', 'workflow:operate', 'workflow:admin'];
export const WF = '11111111-1111-4111-8111-111111111111';

export function renderWith(ui: ReactElement, o: { perms?: string[]; props?: Partial<WorkflowProviderProps> } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const perms = o.perms ?? ALL;
  const utils = render(
    <QueryClientProvider client={qc}>
      <WorkflowProvider api={{ headers: () => ({ 'X-CSRF-Token': 'csrf-1' }) }} me={ME} can={p => perms.includes(p)}
        subjects={{ order: { label: 'Bestellung', search: async q => [{ id: 'o1', title: `Bestellung o1 ${q}` }] } }} {...o.props}>
        {ui}
      </WorkflowProvider>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

type Handler = (req: Request) => Response | Promise<Response>;
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });

/** fetch ersetzen: Schlüssel «METHOD /pfad» (ohne Query) → Antwort. Gibt die Aufrufe zurück (mit gelesenem Körper). */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; search: string; headers: Headers; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const text = await req.clone().text();
    calls.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    const h = routes[`${req.method} ${url.pathname}`];
    if (!h) return json({ title: 'Nicht gefunden', status: 404 }, 404);
    return h(req);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export const STATUS = { configured: true, enabled: true, available: true, stage: 1, version: '0.2.0' };

export const META: WorkflowMetaJson = {
  stage: 1,
  events: [
    { type: 'order.created', label: 'Bestellung eingegangen', description: null, subjectType: 'order', filterFields: [], builtin: false },
    { type: 'order.updated', label: 'Bestellung geändert', description: null, subjectType: 'order', filterFields: [{ key: 'state', label: 'Zustand', type: 'choice', options: [{ value: 'paid', label: 'Bezahlt' }, { value: 'new', label: 'Neu' }] }], builtin: false },
    { type: 'workflow.run_failed', label: 'Ein Lauf ist fehlgeschlagen', description: null, subjectType: null, filterFields: [], builtin: true },
  ],
  actions: [{
    key: 'order.cancel', label: 'Bestellung stornieren', group: 'Bestellungen',
    input: { type: 'object', required: ['order', 'reason'], properties: { order: { type: 'string', title: 'Bestellung' }, reason: { type: 'string', title: 'Grund', description: 'Steht im Verlauf' }, notify: { type: 'boolean', title: 'Kundschaft benachrichtigen' } } },
    output: { type: 'object', properties: { state: { type: 'string', title: 'Neuer Zustand' } } },
  }],
  subjectTypes: [{ type: 'order', label: 'Bestellung', fields: [{ key: 'total', label: 'Betrag', type: 'number' }, { key: 'customer', label: 'Kundin/Kunde', type: 'text' }] }],
  stateFields: [{ subjectType: 'order', key: 'state', label: 'Zustand' }],
  fieldKinds: [],
  stepKinds: ['action', 'if', 'foreach', 'wait', 'end', 'set'],
  operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'contains', 'notContains', 'startsWith', 'endsWith', 'isSet', 'isNotSet'],
  unaryOperators: ['isSet', 'isNotSet'],
  formatters: ['date', 'number', 'list', 'default'],
  canActAs: false,
};

export const summary = (o: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  id: WF, name: 'Storno bei Zahlungsausfall', description: null, kind: 'automation', scope: { type: 'tenant', id: '*' }, state: 'draft', revision: 1,
  activeVersion: null, actor: null, pausedReason: null, createdBy: { id: 'anna', kind: 'person' }, createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T08:00:00.000Z', ...o,
});
