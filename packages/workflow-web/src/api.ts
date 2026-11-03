/**
 * Zugriff auf die REST-API von `@vollholz/workflow` (Stufe 1) als Hooks über TanStack Query: Status, Meta,
 * Einstellungen, Workflows (Entwurf mit `If-Match`), Prüfen, Aktivieren/Pausieren/Archivieren, Versionen, manueller
 * Start, Probelauf, Läufe mit Cursor, Lauf mit Schritten, Vorfälle; Stufe 2: Aufgaben (Ansichten, Zähler, Aktionen,
 * Massenaktionen), Warteschlangen, Teams, Kalender.
 *
 * Regeln: Pfade immer unter `prefix` des Providers; Fehler als `WorkflowApiError` (Problem Details oder `{ code,
 * message }` der App); nach jeder Änderung werden die betroffenen Abfragen neu geladen (`wfKeys`).
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkflow, type WorkflowContextValue, type WorkflowScopeRef, type WorkflowSubjectRef } from './provider.tsx';
import type {
  ActorRefJson, BulkResultJson, CalendarBody, CalendarJson, MemberJson, QueueBody, QueueJson, TaskCountsJson, TaskDetailJson, TaskKind, TaskPage, TaskSort,
  TaskView, TeamOptionJson, DryRunJson, RunDetailJson, RunJson, RunPage, RunState, ValidationJson, VersionJson, WorkflowDefinition, WorkflowDetail,
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
  tasks: (f: TaskFilter = {}) => ['workflow', 'tasks', f] as const,
  allTasks: ['workflow', 'tasks'] as const,
  task: (id: string) => ['workflow', 'task', id] as const,
  taskCounts: ['workflow', 'task-counts'] as const,
  queues: ['workflow', 'queues'] as const,
  queue: (id: string) => ['workflow', 'queue', id] as const,
  queueMembers: (id: string) => ['workflow', 'queue-members', id] as const,
  teams: (q: string) => ['workflow', 'teams', q] as const,
  calendars: ['workflow', 'calendars'] as const,
  calendar: (id: string) => ['workflow', 'calendar', id] as const,
};

export interface TaskFilter {
  view?: TaskView; state?: 'active' | 'open' | 'in_progress' | 'done' | 'cancelled' | 'any'; queueId?: string; kind?: TaskKind;
  subjectType?: string; subjectId?: string; overdue?: boolean; sort?: TaskSort; limit?: number; offset?: number;
}

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

/** Nächste Ausführungen eines Zeitplans (Cron und Zeitzone rechnet der Server); `ok: false` mit `error` bei ungültiger Angabe. */
export function useSchedulePreview(cron: string, timezone: string, enabled = true) {
  const w = useWorkflow();
  return useQuery({
    queryKey: ['workflow', 'schedule-preview', cron, timezone] as const, enabled: enabled && !!cron.trim() && !!timezone.trim(),
    staleTime: 60_000, placeholderData: keepPreviousData,
    queryFn: ({ signal }) => wfRequest<{ ok: boolean; error: string | null; next: string[] }>(w, 'POST', '/workflows/schedule-preview', { body: { cron, timezone, count: 3 }, signal }),
  });
}

/** Aktivieren (mit Akteur), Pausieren, Fortsetzen (gleiche Version), Archivieren. */
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
    resume: useMutation({ mutationFn: () => wfRequest<WorkflowDetail>(w, 'POST', `/workflows/${enc(id)}/resume`), onSuccess: done }),
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
    onSuccess: async () => {
      await Promise.all([wfKeys.allRuns, wfKeys.allTasks, wfKeys.taskCounts].map(queryKey => qc.invalidateQueries({ queryKey })));
    },
  });
}

/** Nachladen für Listen: fester Abstand, `false` oder eine Funktion, die nach jeder Antwort neu entscheidet. */
export type RefetchInterval = number | false | (() => number | false);

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

export function useRuns(filter: RunFilter = {}, enabled = true, o: { refetchInterval?: RefetchInterval } = {}) {
  const w = useWorkflow();
  const every = o.refetchInterval;
  return useInfiniteQuery({
    queryKey: wfKeys.runs(filter), enabled, initialPageParam: null as string | null,
    refetchInterval: typeof every === 'function' ? () => every() : every,
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

// ---------------------------------------------------------------- Aufgaben (Stufe 2)

/** Aufgaben einer Ansicht (`mine`, `team`, `all`) mit Filter und Sortierung. */
export function useTasks(filter: TaskFilter = {}, enabled = true, o: { refetchInterval?: RefetchInterval } = {}) {
  const w = useWorkflow();
  const every = o.refetchInterval;
  return useQuery({
    queryKey: wfKeys.tasks(filter), enabled, placeholderData: keepPreviousData,
    refetchInterval: typeof every === 'function' ? () => every() : every,
    queryFn: ({ signal }) => wfRequest<TaskPage>(w, 'GET', `/tasks${qs({ ...filter, overdue: filter.overdue ? 'true' : undefined })}`, { signal }),
  });
}

/**
 * Zähler offen/überfällig für die Navigation der App («Meine Arbeit»). Fragt nur, wenn das Modul verfügbar ist;
 * `refetchInterval` (Standard 60 s) hält ihn ohne Neuladen aktuell.
 */
export function useTaskCounts(o: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  const w = useWorkflow();
  const status = useWorkflowStatus();
  return useQuery({
    queryKey: wfKeys.taskCounts, enabled: (o.enabled ?? true) && !!status.data?.available, refetchInterval: o.refetchInterval ?? 60_000,
    queryFn: ({ signal }) => wfRequest<TaskCountsJson>(w, 'GET', '/tasks/counts', { signal }),
  });
}

export function useTask(id: string | null | undefined) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.task(id ?? ''), enabled: !!id,
    queryFn: ({ signal }) => wfRequest<TaskDetailJson>(w, 'GET', `/tasks/${enc(id!)}`, { signal }),
  });
}

export type TaskAction =
  | { action: 'take' } | { action: 'release' }
  | { action: 'assign'; assignee?: ActorRefJson | null; queueId?: string | null }
  | { action: 'complete'; outcome?: string; values: Record<string, unknown> }
  | { action: 'decide'; decision: 'approved' | 'rejected'; reason?: string | null }
  | { action: 'cancel'; reason?: string | null };

/** Aktion auf einer Aufgabe (mit `If-Match`, wenn `revision` bekannt ist); lädt Listen, Zähler und Läufe neu. */
export function useTaskAction(id: string) {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ revision, ...a }: TaskAction & { revision?: number }) => {
      const { action, ...body } = a;
      return wfRequest<TaskDetailJson>(w, 'POST', `/tasks/${enc(id)}/${action}`, { body, headers: revision !== undefined ? ifMatch(revision) : {} });
    },
    onSuccess: t => {
      qc.setQueryData(wfKeys.task(id), t);
      void qc.invalidateQueries({ queryKey: wfKeys.allTasks });
      void qc.invalidateQueries({ queryKey: wfKeys.taskCounts });
      void qc.invalidateQueries({ queryKey: wfKeys.queues });
      void qc.invalidateQueries({ queryKey: wfKeys.allRuns });
    },
  });
}

/** Massenaktion (zuweisen oder abbrechen, Recht `task:assign`). */
export function useBulkTasks() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { action: 'assign' | 'cancel'; ids: string[]; assignee?: ActorRefJson | null; queueId?: string | null; reason?: string | null }) =>
      wfRequest<BulkResultJson>(w, 'POST', '/tasks/bulk', { body: b }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: wfKeys.all }); },
  });
}

// ---------------------------------------------------------------- Warteschlangen und Kalender

export function useQueues(enabled = true) {
  const w = useWorkflow();
  return useQuery({ queryKey: wfKeys.queues, enabled, queryFn: ({ signal }) => wfRequest<{ items: QueueJson[] }>(w, 'GET', '/queues', { signal }) });
}

export function useQueue(id: string | null | undefined) {
  const w = useWorkflow();
  return useQuery({ queryKey: wfKeys.queue(id ?? ''), enabled: !!id, queryFn: ({ signal }) => wfRequest<QueueJson>(w, 'GET', `/queues/${enc(id!)}`, { signal }) });
}

export function useQueueMembers(id: string | null | undefined) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.queueMembers(id ?? ''), enabled: !!id,
    queryFn: ({ signal }) => wfRequest<{ items: MemberJson[] }>(w, 'GET', `/queues/${enc(id!)}/members`, { signal }),
  });
}

/** Teams zur Auswahl (Port `teams` der App); `available: false`, wenn die App keine anbietet. */
export function useTeams(q: string, enabled = true) {
  const w = useWorkflow();
  return useQuery({
    queryKey: wfKeys.teams(q), enabled, staleTime: 60_000, placeholderData: keepPreviousData,
    queryFn: ({ signal }) => wfRequest<{ available: boolean; items: TeamOptionJson[] }>(w, 'GET', `/queues/teams${qs({ q })}`, { signal }),
  });
}

/** Warteschlange anlegen (ohne `id`) oder ändern (mit `id` und `revision`). */
export function useSaveQueue() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, revision, ...body }: QueueBody & { id?: string; revision?: number }) =>
      id ? wfRequest<QueueJson>(w, 'PUT', `/queues/${enc(id)}`, { body, headers: ifMatch(revision ?? 0) }) : wfRequest<QueueJson>(w, 'POST', '/queues', { body }),
    onSuccess: q => { qc.setQueryData(wfKeys.queue(q.id), q); void qc.invalidateQueries({ queryKey: wfKeys.queues }); },
  });
}

export function useDeleteQueue() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; revision: number }) => wfRequest<void>(w, 'DELETE', `/queues/${enc(b.id)}`, { headers: ifMatch(b.revision) }),
    onSuccess: (_r, b) => { qc.removeQueries({ queryKey: wfKeys.queue(b.id) }); void qc.invalidateQueries({ queryKey: wfKeys.queues }); },
  });
}

export function useCalendars(enabled = true) {
  const w = useWorkflow();
  return useQuery({ queryKey: wfKeys.calendars, enabled, queryFn: ({ signal }) => wfRequest<{ items: CalendarJson[] }>(w, 'GET', '/calendars', { signal }) });
}

export function useCalendar(id: string | null | undefined) {
  const w = useWorkflow();
  return useQuery({ queryKey: wfKeys.calendar(id ?? ''), enabled: !!id, queryFn: ({ signal }) => wfRequest<CalendarJson>(w, 'GET', `/calendars/${enc(id!)}`, { signal }) });
}

/** Kalender anlegen (ohne `id`) oder ändern (mit `id` und `revision`). */
export function useSaveCalendar() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, revision, ...body }: CalendarBody & { id?: string; revision?: number }) =>
      id ? wfRequest<CalendarJson>(w, 'PUT', `/calendars/${enc(id)}`, { body, headers: ifMatch(revision ?? 0) }) : wfRequest<CalendarJson>(w, 'POST', '/calendars', { body }),
    onSuccess: c => { qc.setQueryData(wfKeys.calendar(c.id), c); void qc.invalidateQueries({ queryKey: wfKeys.calendars }); },
  });
}

export function useDeleteCalendar() {
  const w = useWorkflow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; revision: number }) => wfRequest<void>(w, 'DELETE', `/calendars/${enc(b.id)}`, { headers: ifMatch(b.revision) }),
    onSuccess: (_r, b) => { qc.removeQueries({ queryKey: wfKeys.calendar(b.id) }); void qc.invalidateQueries({ queryKey: wfKeys.calendars }); },
  });
}

/** Frist nach Kalender ausrechnen (Vorschau im Editor). */
export function useCalendarPreview() {
  const w = useWorkflow();
  return useMutation({
    mutationFn: (b: { duration: string; from?: string; calendarId?: string; calendar?: Pick<CalendarJson, 'timezone' | 'week' | 'holidays'> }) =>
      wfRequest<{ from: string; dueAt: string }>(w, 'POST', '/calendars/preview', { body: b }),
  });
}