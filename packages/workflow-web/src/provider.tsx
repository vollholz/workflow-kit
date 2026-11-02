/**
 * Konfiguration der Oberfläche (`WorkflowProvider`): Was die Bausteine von der App brauchen – Zugang zur API, den
 * angemeldeten Akteur (`me`) und Rechte (`can`). Optional beschreibt die App, wie Bezüge angezeigt und geöffnet werden
 * (`subjects`), und liefert eigene Feldarten für Aufgabenformulare (`fields`).
 *
 * Regel: Das Paket spricht mit dem Backend nur über HTTP und importiert dessen Laufzeit nicht (geprüft mit
 * `npm run boundaries`). Fachbegriffe kommen aus `subjects` und `fields` der App, nicht aus dem Paket.
 */
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';

/** Akteur wie im Backend: Person oder Maschinen-Client. */
export interface WorkflowActor { id: string; kind: 'person' | 'client' }

/** Bezug wie im Backend (`SubjectRef`). */
export interface WorkflowSubjectRef { type: string; id: string }

/** Zugang zur API des Baukastens. */
export interface WorkflowApi {
  /** Basis der API, z. B. `/v1` oder `https://app.example/v1`. */
  baseUrl: string;
  /** Zusätzliche Header je Anfrage, z. B. CSRF-Token oder Mandant. */
  headers?: () => Record<string, string>;
  /** Antwort 401: Sitzung abgelaufen. */
  onUnauthorized?: () => void;
}

/** Wie die App einen Bezugstyp zeigt. */
export interface SubjectConfig {
  /** Bezeichnung des Typs in der Einzahl. */
  label: string;
  /** Link zum Bezug in der App. */
  href?: (id: string) => string;
}

/** Eingabe für eine Feldart der App. */
export interface FieldInputProps {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  id?: string;
}

/** Feldart der App für Aufgabenformulare (Gegenstück zu `FieldKind` im Backend). */
export interface FieldConfig {
  label: string;
  Input: ComponentType<FieldInputProps>;
}

export interface WorkflowProviderProps {
  api: WorkflowApi;
  /** Angemeldeter Akteur; null, solange unbekannt. */
  me: WorkflowActor | null;
  /** Recht auf Ebene der Organisation bzw. des Mandanten. */
  can: (perm: string) => boolean;
  subjects?: Record<string, SubjectConfig>;
  fields?: Record<string, FieldConfig>;
  children?: ReactNode;
}

export interface WorkflowContextValue {
  api: WorkflowApi;
  me: WorkflowActor | null;
  can: (perm: string) => boolean;
  subjects: Record<string, SubjectConfig>;
  fields: Record<string, FieldConfig>;
}

const WorkflowContext = createContext<WorkflowContextValue | null>(null);

export function WorkflowProvider({ api, me, can, subjects, fields, children }: WorkflowProviderProps) {
  const value = useMemo<WorkflowContextValue>(
    () => ({ api, me, can, subjects: subjects ?? {}, fields: fields ?? {} }),
    [api, me, can, subjects, fields],
  );
  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}

/** Konfiguration aus dem nächsten `WorkflowProvider`; wirft ausserhalb davon. */
export function useWorkflow(): WorkflowContextValue {
  const v = useContext(WorkflowContext);
  if (!v) throw new Error('Workflow-Bausteine brauchen einen umgebenden <WorkflowProvider>.');
  return v;
}
