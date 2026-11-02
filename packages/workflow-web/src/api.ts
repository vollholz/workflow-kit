/**
 * Zugriff auf die REST-API von `@vollholz/workflow` (Stufe 1) als Hooks über TanStack Query: Status, Meta,
 * Einstellungen, Workflows (Entwurf mit `If-Match`), Prüfen, Aktivieren/Pausieren/Archivieren, Versionen, manueller
 * Start, Probelauf, Läufe mit Cursor, Lauf mit Schritten, Vorfälle.
 *
 * Regeln: Pfade immer unter `prefix` des Providers; Fehler als `WorkflowApiError` (Problem Details oder `{ code,
 * message }` der App); nach jeder Änderung werden die betroffenen Abfragen neu geladen (`wfKeys`).
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkflow, type WorkflowContextValue, type WorkflowScopeRef, type WorkflowSubjectRef } from './provider.tsx';
import type {
  ActorRefJson, DryRunJson, RunDetailJson, RunJson, RunPage, RunState, ValidationJson, VersionJson, WorkflowDefinition, WorkflowDetail,
  WorkflowLimitsJson, WorkflowMetaJson, WorkflowSettingsJson, WorkflowState, WorkflowStatusJson, WorkflowSummary,
} from './types.ts';
import { WorkflowApiError } from './ui.tsx';

/** Schlüssel der Abfragen (zum Invalidieren aus der App). */
export const wfKeys = {
  all: ['workflow'] as const,
  status: ['workflow', 'status'] as const,
  meta: (scope?: WorkflowScopeRef | null) => ['workflow', 'meta', scope?.type ?? null, scope?.id ?? null] as const,
  settings: ['workflow', 'settings'] as const,
  list: (f: WorkflowListFilter = {}) => ['workflow', 'list', f] as const,
  lists: ['workflow', 'list'] as const,
  detail: (id: string) => ['workflow', 'detail', id] as const,
  versions: (id: string) => ['workflow', 'versions', id] as const,
  version: (id: string, v: number) => ['workflow', 'version', id, v] as const,
  validate: (json: string) => ['workflow', 'validate', json] as const,
  runs: (f: RunFilter = {}) => ['workflow', 'runs', f] as const,
  allRuns: ['workflow', 'runs'] as const,
  run: (id: string) => ['workflow', 'run', id] as const,
};

export interface WorkflowListFilter { state?: WorkflowState; scopeType?: string; scopeId?: string }
export interface RunFilter { workflowId?: string; subjectType?: string; subjectId?: string; state?: RunState; limit?: number }

/** Anfrage an die API; JSON-Antwort oder `WorkflowApiError`. */
export async function wfRequest<T>(w: Pick<WorkflowContextValue, 'api' | 'prefix'>, method: string, path: string,
  o: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  let r: Response;
  try {
    r = await w.api.fetch(`${w.api.baseUrl}${w.prefix}${path}`, {
      method, signal: o.signal, // gleiche Herkunft mit Sitzungs-Cookie (Vorgabe von fetch)
      headers: { Accept: 'application/json, application/problem+json', ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...w.api.headers(), ...o.headers },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new WorkflowApiError(0, { detail: 'Der Server ist nicht erreichbar. Prüfe die Verbindung und versuche es erneut.' });
  }
  if (r.status === 401) w.api.onUnauthorized?.();
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!r.ok) throw new WorkflowApiError(r.status, body && typeof body === 'object' ? body as Record<string, unknown> : null);
  return body as T;
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;
const ifMatch = (revision: number) => ({ 'If-Match': `"${revision}"` });

// ---------------------------------------------------------------- Status, Meta, Einstellungen

export function useWorkflowStatus() {
  const w = useWorkflow();
  return useQuery({ queryKey: wfKeys.status, queryFn: ({ signal }) => wfRequest<WorkflowStatusJson>(w, 'GET', '/workflows/status', { signal }), staleTime: 60_000 });
}

/** Angemeldete Ereignisse, Aktionen, Bezugstypen mit Feldern (im Bereich `scope`). */
export function useWorkflowMeta(scope?: WorkflowScopeRef | null) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.meta(scope),
    queryFn: ({ signal }) => wfRequest<WorkflowMetaJson>(w, 'GET', `/workflows/meta${qs({ scopeType: scope?.type, scopeId: scope?.id })}`, { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useWorkflowSettings(enabled = true) {
  const w = useWorkflow();
  return useQuery({ queryKey: wfKeys.settings, enabled, queryFn: ({ signal }) => wfRequest<WorkflowSettingsJson>(w, 'GET', '/workflows/settings', { signal }) });
}

export function useSaveWorkflowSettings() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { enabled: boolean; revision?: number; limits?: Partial<WorkflowLimitsJson> }) => wfRequest<WorkflowSettingsJson>(w, 'PUT', '/workflows/settings', { body: b }),
    onSuccess: s => { qc.setQueryData(wfKeys.settings, s); void qc.invalidateQueries({ queryKey: wfKeys.all }); },
  });
}

// ---------------------------------------------------------------- Workflows

export function useWorkflows(filter: WorkflowListFilter = {}, enabled = true) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.list(filter), enabled,
    queryFn: ({ signal }) => wfRequest<{ items: WorkflowSummary[] }>(w, 'GET', `/workflows${qs({ ...filter })}`, { signal }),
  });
}

export function useWorkflowDetail(id: string | null | undefined) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.detail(id ?? ''), enabled: !!id,
    queryFn: ({ signal }) => wfRequest<WorkflowDetail>(w, 'GET', `/workflows/${enc(id!)}`, { signal }),
  });
}

export function useCreateWorkflow() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { name: string; description?: string; scope: WorkflowScopeRef; definition?: WorkflowDefinition }) => wfRequest<WorkflowDetail>(w, 'POST', '/workflows', { body: b }),
    onSuccess: d => { qc.setQueryData(wfKeys.detail(d.id), d); void qc.invalidateQueries({ queryKey: wfKeys.lists }); },
  });
}

/** Entwurf speichern mit optimistischer Sperre (`If-Match: "<revision>"`); Konflikt = `WorkflowApiError.conflict`. */
export function useSaveWorkflow(id: string) {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { revision: number; name?: string; description?: string | null; definition?: WorkflowDefinition }) => {
      const { revision, ...body } = b;
      return wfRequest<WorkflowDetail>(w, 'PUT', `/workflows/${enc(id)}`, { body, headers: ifMatch(revision) });
    },
    onSuccess: d => { qc.setQueryData(wfKeys.detail(id), d); void qc.invalidateQueries({ queryKey: wfKeys.lists }); },
  });
}

export function useDeleteWorkflow(id: string) {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (revision: number) => wfRequest<void>(w, 'DELETE', `/workflows/${enc(id)}`, { headers: ifMatch(revision) }),
    onSuccess: () => { qc.removeQueries({ queryKey: wfKeys.detail(id) }); void qc.invalidateQueries({ queryKey: wfKeys.lists }); },
  });
}

/** Definition prüfen (Schema, Inhalt, was diese Stufe ausführen kann); `null` = nicht prüfen. */
export function useValidateDefinition(definition: WorkflowDefinition | null) {
  const w = useWorkflow();
  const json = definition ? JSON.stringify(definition) : '';
  return useQuery({
    queryKey: wfKeys.validate(json), enabled: !!definition, staleTime: Infinity, placeholderData: keepPreviousData,
    queryFn: ({ signal }) => wfRequest<ValidationJson>(w, 'POST', '/workflows/validate', { body: { definition }, signal }),
  });
}

/** Aktivieren (mit Akteur), Pausieren, Archivieren. */
export function useWorkflowLifecycle(id: string) {
  const w = useWorkflow();
  const qc = useQueryClient();
  const done = (d: WorkflowDetail) => {
    qc.setQueryData(wfKeys.detail(id), d);
    void qc.invalidateQueries({ queryKey: wfKeys.lists });
    void qc.invalidateQueries({ queryKey: wfKeys.versions(id) });
  };
  return {
    activate: useMutation({
      mutationFn: (b: { revision?: number; actor?: ActorRefJson }) => wfRequest<WorkflowDetail>(w, 'POST', `/workflows/${enc(id)}/activate`, { body: b }),
      onSuccess: done,
    }),
    pause: useMutation({ mutationFn: () => wfRequest<WorkflowDetail>(w, 'POST', `/workflows/${enc(id)}/pause`), onSuccess: done }),
    archive: useMutation({ mutationFn: () => wfRequest<WorkflowDetail>(w, 'POST', `/workflows/${enc(id)}/archive`), onSuccess: done }),
  };
}

export function useWorkflowVersions(id: string | null | undefined) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.versions(id ?? ''), enabled: !!id,
    queryFn: ({ signal }) => wfRequest<{ items: VersionJson[] }>(w, 'GET', `/workflows/${enc(id!)}/versions`, { signal }),
  });
}

export function useWorkflowVersion(id: string | null | undefined, version: number | null | undefined) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.version(id ?? '', version ?? 0), enabled: !!id && !!version, staleTime: Infinity,
    queryFn: ({ signal }) => wfRequest<VersionJson>(w, 'GET', `/workflows/${enc(id!)}/versions/${version}`, { signal }),
  });
}

/** Lauf von Hand starten (manueller Auslöser, mit Bezug und Eingabe). */
export function useStartRun() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { workflowId: string; subject?: WorkflowSubjectRef; input?: Record<string, unknown> }) =>
      wfRequest<RunJson>(w, 'POST', `/workflows/${enc(b.workflowId)}/runs`, { body: { subject: b.subject, input: b.input ?? {} } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: wfKeys.allRuns }),
  });
}

export interface DryRunBody {
  definition?: WorkflowDefinition;
  version?: number;
  subject?: WorkflowSubjectRef;
  input?: Record<string, unknown>;
  event?: { type: string; subject?: WorkflowSubjectRef | null; data?: Record<string, unknown> };
}

/** Probelauf (schreibt nichts). */
export function useDryRun(id: string) {
  const w = useWorkflow();
  return useMutation({ mutationFn: (b: DryRunBody) => wfRequest<DryRunJson>(w, 'POST', `/workflows/${enc(id)}/dry-run`, { body: b }) });
}

// ---------------------------------------------------------------- Läufe und Vorfälle

export function useRuns(filter: RunFilter = {}, enabled = true) {
  const w = useWorkflow();
  return useInfiniteQuery({
    queryKey: wfKeys.runs(filter), enabled, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => wfRequest<RunPage>(w, 'GET', `/workflow-runs${qs({ ...filter, limit: filter.limit ?? 50, cursor: pageParam })}`, { signal }),
    getNextPageParam: l => l.nextCursor ?? null,
  });
}

export function useRun(id: string | null | undefined) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.run(id ?? ''), enabled: !!id,
    queryFn: ({ signal }) => wfRequest<RunDetailJson>(w, 'GET', `/workflow-runs/${enc(id!)}`, { signal }),
  });
}

export type IncidentAction = 'retry' | 'skip' | 'cancel';

/** Vorfall lösen: nochmals versuchen, Schritt überspringen, Lauf abbrechen. */
export function useIncidentAction() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { runId: string; action: IncidentAction }) => wfRequest<RunJson>(w, 'POST', `/workflow-runs/${enc(b.runId)}/${b.action}`),
    onSuccess: (_r, b) => { void qc.invalidateQueries({ queryKey: wfKeys.run(b.runId) }); void qc.invalidateQueries({ queryKey: wfKeys.allRuns }); },
  });
}
