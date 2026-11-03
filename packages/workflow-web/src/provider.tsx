/**
 * Konfiguration der Oberfläche (`WorkflowProvider`): Was die Bausteine von der App brauchen – Zugang zur API (`api`),
 * den angemeldeten Akteur (`me`) und Rechte (`can`). Optional beschreibt die App, wie Bezüge heissen, gesucht und
 * geöffnet werden (`subjects`), wie Akteure und Bereiche heissen (`actors`, `scopeLabel`), liefert eigene Feldarten
 * (`fields`) und eigene Grundbausteine (`components`), damit die Bausteine wie der Rest der App aussehen.
 *
 * Regeln:
 * - Das Paket spricht mit dem Backend nur über HTTP und importiert dessen Laufzeit nicht (geprüft mit
 *   `npm run boundaries`). Fachbegriffe kommen aus `subjects`, `fields` und den Angaben der API (`/workflows/meta`).
 * - Daten über TanStack Query: Liegt schon ein `QueryClientProvider` der App aussen herum, wird er genutzt (gemeinsamer
 *   Zwischenspeicher), sonst legt der Provider einen eigenen an (oder nimmt `queryClient`).
 */
import { QueryClient, QueryClientContext, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { defaultComponents, type WorkflowComponents } from './ui.tsx';

/** Akteur wie im Backend: Person oder Maschinen-Client; `label` zeigt die Oberfläche statt der ID. */
export interface WorkflowActor { id: string; kind: 'person' | 'client'; label?: string }

/** Bezug wie im Backend (`SubjectRef`). */
export interface WorkflowSubjectRef { type: string; id: string }

/** Bereich wie im Backend (`ScopeRef`). */
export interface WorkflowScopeRef { type: string; id: string }

/** Zugang zur API des Baukastens (gleiche Herkunft mit Sitzungs-Cookie, wenn nichts anderes angegeben ist). */
export interface WorkflowApi {
  /** Herkunft der API, z. B. `https://app.example` (Standard: gleiche Herkunft wie die Seite). */
  baseUrl?: string;
  /** Eigener fetch der App (z. B. mit Wiederholung oder Mandant); Standard `globalThis.fetch`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Zusätzliche Header je Anfrage, z. B. CSRF-Token oder Mandant. */
  headers?: () => Record<string, string>;
  /** Antwort 401: Sitzung abgelaufen. */
  onUnauthorized?: () => void;
}

/** Treffer der Suche nach einem Bezug. */
export interface SubjectHit { id: string; title: string }

/** Wie die App einen Bezugstyp zeigt, sucht und öffnet. */
export interface SubjectConfig {
  /** Bezeichnung des Typs in der Einzahl (sonst die Bezeichnung aus der API). */
  label: string;
  /** Suche nach Bezügen (Probelauf, Filter im Protokoll); ohne Suche gibt man die ID ein. */
  search?: (q: string) => Promise<SubjectHit[]>;
  /** Link zum Bezug in der App. */
  href?: (id: string) => string;
  /** Bezug in der App öffnen (statt Link), z. B. in einer Schublade. */
  onOpen?: (id: string) => void;
  /**
   * Titel eines Bezugs als Baustein der App (darf eigene Hooks nutzen, z. B. den Bezug laden); ohne Angabe der Titel
   * aus der API, sonst Bezeichnung des Typs und ID.
   */
  Title?: ComponentType<{ id: string }>;
}

/** Eingabe für eine Feldart der App. */
export interface FieldInputProps {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  id?: string;
}

/** Feldart der App für Formulare (Gegenstück zu `FieldKind` im Backend). */
export interface FieldConfig {
  label: string;
  Input: ComponentType<FieldInputProps>;
}

/** Akteure anzeigen und wählen. */
export interface ActorConfig {
  /** Bezeichnung eines Akteurs (Person oder Maschinen-Client) als Text, z. B. für `title` und Auswahllisten; ohne Angabe die ID. */
  label?: (actor: WorkflowActor) => string | undefined;
  /**
   * Name eines Akteurs als Baustein der App (darf eigene Hooks nutzen, z. B. die Person laden); überall, wo die
   * Oberfläche Akteure zeigt. Ohne Angabe `label`, sonst die ID.
   */
  Name?: ComponentType<{ actor: WorkflowActor }>;
  /** Maschinen-Clients, die die angemeldete Person beim Aktivieren wählen darf (W6; nur mit `canActAs` im Backend). */
  clients?: () => Promise<WorkflowActor[]>;
  /** Personen suchen (Weitergeben einer Aufgabe); ohne Suche gibt man die ID ein. */
  search?: (q: string) => Promise<WorkflowActor[]>;
}

export interface WorkflowProviderProps {
  api: WorkflowApi;
  /** Angemeldeter Akteur; null, solange unbekannt. */
  me: WorkflowActor | null;
  /** Recht auf Ebene der Organisation bzw. des Mandanten (`workflow:manage`, `workflow:activate` …). */
  can: (perm: string) => boolean;
  /** Präfix der Routen wie im Backend (Standard `/v1`). */
  prefix?: string;
  subjects?: Record<string, SubjectConfig>;
  fields?: Record<string, FieldConfig>;
  actors?: ActorConfig;
  /** Bezeichnung eines Bereichs (Liste, Kopf des Editors); ohne Angabe `type: id`. */
  scopeLabel?: (scope: WorkflowScopeRef) => string;
  /** Grundbausteine der App statt der eigenen. */
  components?: Partial<WorkflowComponents>;
  /** Eigener QueryClient (sonst der der App oder ein eigener). */
  queryClient?: QueryClient;
  children?: ReactNode;
}

export interface WorkflowContextValue {
  api: { baseUrl: string; headers: () => Record<string, string>; fetch: (url: string, init: RequestInit) => Promise<Response>; onUnauthorized?: () => void };
  prefix: string;
  me: WorkflowActor | null;
  can: (perm: string) => boolean;
  subjects: Record<string, SubjectConfig>;
  fields: Record<string, FieldConfig>;
  actors: ActorConfig;
  scopeLabel: (scope: WorkflowScopeRef) => string;
  ui: WorkflowComponents;
}

const WorkflowContext = createContext<WorkflowContextValue | null>(null);

/** Gleiche Herkunft als absolute Adresse (fetch ausserhalb des Browsers, z. B. in Tests, kennt keine relativen Pfade). */
const defaultOrigin = () => (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null' ? window.location.origin : '');

export function WorkflowProvider({ api, me, can, prefix, subjects, fields, actors, scopeLabel, components, queryClient, children }: WorkflowProviderProps) {
  if (!api || typeof api !== 'object') throw new Error('WorkflowProvider: «api» fehlt (z. B. api={{ headers: () => ({ … }) }}).');
  if (typeof can !== 'function') throw new Error('WorkflowProvider: «can» fehlt (Funktion perm → boolean).');
  if (me === undefined) throw new Error('WorkflowProvider: «me» fehlt (angemeldeter Akteur oder null).');
  const value = useMemo<WorkflowContextValue>(() => ({
    api: {
      baseUrl: (api.baseUrl ?? defaultOrigin()).replace(/\/$/, ''),
      headers: api.headers ?? (() => ({})),
      fetch: api.fetch ?? ((url, init) => globalThis.fetch(url, init)),
      onUnauthorized: api.onUnauthorized,
    },
    prefix: prefix ?? '/v1',
    me, can,
    subjects: subjects ?? {}, fields: fields ?? {}, actors: actors ?? {},
    scopeLabel: scopeLabel ?? (s => `${s.type}: ${s.id}`),
    ui: { ...defaultComponents, ...components },
  }), [api, prefix, me, can, subjects, fields, actors, scopeLabel, components]);
  const outer = useContext(QueryClientContext);
  const [own] = useState(() => queryClient ?? (outer ? null : new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } })));
  const inner = <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
  return own ? <QueryClientProvider client={own}>{inner}</QueryClientProvider> : inner;
}

/** Konfiguration aus dem nächsten `WorkflowProvider`; wirft ausserhalb davon. */
export function useWorkflow(): WorkflowContextValue {
  const v = useContext(WorkflowContext);
  if (!v) throw new Error('Workflow-Bausteine brauchen einen umgebenden <WorkflowProvider>.');
  return v;
}

/** Bezeichnung eines Akteurs (App, sonst `label`, sonst ID). */
export function actorName(w: Pick<WorkflowContextValue, 'actors' | 'me'>, a: { id: string; kind: 'person' | 'client'; label?: string } | null | undefined): string {
  if (!a) return '–';
  const fromApp = w.actors.label?.(a);
  if (fromApp) return fromApp;
  if (a.label) return a.label;
  if (w.me && w.me.id === a.id && w.me.kind === a.kind) return w.me.label ?? 'Du';
  return a.kind === 'client' ? `Maschinen-Client ${a.id}` : a.id;
}

/** Name eines Akteurs: Baustein der App (`actors.Name`), sonst `actorName`. */
export function ActorName({ actor }: { actor: WorkflowActor | null | undefined }) {
  const w = useWorkflow();
  if (!actor) return <>–</>;
  const Name = w.actors.Name;
  if (Name) return <Name actor={actor} />;
  return <>{actorName(w, actor)}</>;
}

/** Titel eines Bezugs: Baustein der App (`subjects.<typ>.Title`), sonst `title` aus der API, sonst Typ und ID. */
export function SubjectTitle({ type, id, title }: { type: string; id: string; title?: string | null }) {
  const w = useWorkflow();
  const cfg = w.subjects[type];
  if (cfg?.Title) return <cfg.Title id={id} />;
  if (title) return <>{title}</>;
  return <>{`${cfg?.label ?? type} ${id}`}</>;
}
