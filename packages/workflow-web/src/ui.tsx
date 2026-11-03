/**
 * Grundbausteine (Vorgabe, ersetzbar über `components` im `WorkflowProvider`): Knopf, Eingabe, Auswahl, Textfeld,
 * Dialog, Laden, Fehler, Leerzustand. Dazu der Fehler der API (`WorkflowApiError`), Bezeichnungen und Formatierung
 * (de-CH). Klassen mit Präfix `wf-`, Farben über die Tokens der App (styles.css).
 *
 * Regeln: Texte in Du-Form ohne Fachbegriffe einer App. Dialoge halten den Fokus (Tab bleibt im Dialog, Esc schliesst)
 * und geben ihn danach an den Auslöser zurück. Ersetzte Bausteine müssen `id`, `aria-*`, `ref` und `disabled`
 * weiterreichen, damit Beschriftungen und Fokus stimmen.
 */
import { useEffect, useId, useRef, type ComponentPropsWithRef, type ComponentType, type ReactNode } from 'react';
import type { ApprovalMode, QueueAssignment, RunState, TaskPriority, TaskSort, TaskState, WorkflowKind, WorkflowState } from './types.ts';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
};
export type InputProps = ComponentPropsWithRef<'input'>;
export type SelectProps = ComponentPropsWithRef<'select'>;
export type TextareaProps = ComponentPropsWithRef<'textarea'>;
export interface DialogProps { title: string; onClose: () => void; footer?: ReactNode; width?: number; children?: ReactNode; role?: 'dialog' | 'alertdialog' }

export interface WorkflowComponents {
  Button: ComponentType<ButtonProps>;
  Input: ComponentType<InputProps>;
  Select: ComponentType<SelectProps>;
  Textarea: ComponentType<TextareaProps>;
  /** Modaler Dialog mit Titel, Inhalt und Fusszeile (Knöpfe). */
  Dialog: ComponentType<DialogProps>;
  Loading: ComponentType<{ label: string }>;
  ErrorBox: ComponentType<{ error: unknown; onRetry?: () => void }>;
  Empty: ComponentType<{ title: string; children?: ReactNode }>;
}

/** Fehler einer Antwort der API (Problem Details oder `{ code, message }` der App). */
export class WorkflowApiError extends Error {
  override name = 'WorkflowApiError';
  readonly status: number;
  readonly code: string | null;
  readonly title: string;
  readonly detail: string | null;
  constructor(status: number, body: Record<string, unknown> | null) {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const detail = str(body?.detail) ?? str(body?.message);
    const title = str(body?.title) ?? (status === 0 ? 'Keine Verbindung' : status >= 500 ? 'Fehler auf dem Server' : `Fehler ${status}`);
    super(detail && detail !== title ? `${title}: ${detail}` : title);
    this.status = status;
    this.code = str(body?.code);
    this.title = title;
    this.detail = detail && detail !== title ? detail : null;
  }
  /** Stand passt nicht mehr (optimistische Sperre). */
  get conflict(): boolean { return this.status === 412 || (this.status === 409 && this.code !== 'limit'); }
  /** Modul in der Umgebung oder im Mandanten ausgeschaltet. */
  get moduleDisabled(): boolean { return this.status === 404 && this.code === 'module-disabled'; }
}

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

function Button({ variant = 'default', size = 'md', className, type = 'button', ...p }: ButtonProps) {
  return <button type={type} className={cx('wf-btn', variant !== 'default' && variant, size === 'sm' && 'sm', className)} {...p} />;
}
function Input({ className, ...p }: InputProps) {
  return <input className={cx(p.type === 'checkbox' || p.type === 'radio' ? 'wf-check' : 'wf-input', className)} {...p} />;
}
function Select({ className, ...p }: SelectProps) {
  return <select className={cx('wf-input', className)} {...p} />;
}
function Textarea({ className, ...p }: TextareaProps) {
  return <textarea className={cx('wf-input', 'wf-textarea', className)} {...p} />;
}

const FOCUSABLE = 'button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialog mit Fokus im Dialog, Esc schliesst, Fokus danach zurück an den Auslöser. */
function Dialog({ title, onClose, footer, width, children, role = 'dialog' }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="wf-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="wf-dialog" role={role} aria-modal="true" aria-labelledby={id} style={width ? { width } : undefined} onKeyDown={onKey}>
        <h2 id={id}>{title}</h2>
        <div className="wf-dialog-body">{children}</div>
        {footer ? <div className="wf-dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return <div className="wf-loading" role="status"><span className="wf-spin" aria-hidden="true" />{label}</div>;
}

function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error instanceof WorkflowApiError ? error : null;
  const title = e?.title ?? 'Unerwarteter Fehler';
  const detail = e ? e.detail : error instanceof Error ? error.message : String(error);
  return (
    <div className="wf-error" role="alert">
      <div className="wf-grow"><b>{title}</b>{detail ? <div>{detail}</div> : null}</div>
      {onRetry && e?.status !== 404 && e?.status !== 403 ? <Button size="sm" onClick={onRetry}>Erneut versuchen</Button> : null}
    </div>
  );
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="wf-empty"><b>{title}</b>{children ? <div className="wf-muted">{children}</div> : null}</div>;
}

export const defaultComponents: WorkflowComponents = { Button, Input, Select, Textarea, Dialog, Loading, ErrorBox, Empty };

// ---------------------------------------------------------------- Bezeichnungen

export const STATE_LABEL: Record<WorkflowState, string> = { draft: 'Entwurf', active: 'Aktiv', paused: 'Pausiert', archived: 'Archiviert' };
export const KIND_LABEL: Record<WorkflowKind, string> = { automation: 'Automation', case: 'Fall', state_model: 'Zustandsmodell' };
export const RUN_STATE_LABEL: Record<RunState, string> = {
  running: 'Läuft', waiting: 'Wartet', completed: 'Erfolgreich', failed: 'Fehlgeschlagen', incident: 'Vorfall', cancelled: 'Abgebrochen',
};
export const TRIGGER_KIND_LABEL: Record<string, string> = { event: 'Ereignis', schedule: 'Zeitplan', manual: 'Von Hand' };
export const STEP_STATE_LABEL: Record<string, string> = {
  completed: 'Erledigt', failed: 'Fehlgeschlagen', skipped: 'Übersprungen', waiting: 'Wartet', running: 'Läuft', retrying: 'Wird wiederholt',
};
/** Namen der Rechte des Baukastens (wie `workflowPermissions` im Backend). */
export const PERMISSION_LABEL: Record<string, string> = {
  'workflow:read': 'Workflows sehen', 'workflow:manage': 'Workflows bearbeiten', 'workflow:activate': 'Workflows aktivieren',
  'workflow:run': 'Workflows von Hand starten', 'workflow:operate': 'Vorfälle bearbeiten', 'workflow:admin': 'Workflows einrichten',
  'task:work': 'Aufgaben erledigen', 'task:assign': 'Aufgaben zuweisen', 'queue:manage': 'Warteschlangen verwalten',
};

export const TASK_STATE_LABEL: Record<TaskState, string> = { open: 'Offen', in_progress: 'In Arbeit', done: 'Erledigt', cancelled: 'Abgebrochen' };
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };
export const MODE_LABEL: Record<ApprovalMode, string> = { first: 'Erste Antwort entscheidet', all: 'Alle müssen zustimmen', majority: 'Mehrheit entscheidet', sequential: 'Nacheinander' };
export const ASSIGNMENT_LABEL: Record<QueueAssignment, string> = { pull: 'Selbst nehmen', round_robin: 'Reihum zuweisen', least_load: 'An die Person mit den wenigsten offenen Aufgaben' };
export const SORT_LABEL: Record<TaskSort, string> = { urgency: 'Dringlichkeit', due: 'Frist', age: 'Alter' };
/** Bezeichnung eines Ergebnisses (feste Ergebnisse übersetzt, eigene unverändert). */
export const outcomeLabel = (o: string | null | undefined) =>
  (o ? ({ approved: 'Genehmigt', rejected: 'Abgelehnt', cancelled: 'Abgebrochen', done: 'Erledigt' } as Record<string, string>)[o] ?? o : '');
export const taskTone = (s: TaskState) => (s === 'done' ? 'ok' : s === 'cancelled' ? 'muted' : s === 'in_progress' ? 'accent' : 'warn');
export const priorityTone = (p: TaskPriority) => (p === 'urgent' ? 'bad' : p === 'high' ? 'warn' : 'muted');

export function Badge({ tone, children }: { tone: 'ok' | 'bad' | 'warn' | 'muted' | 'accent'; children: ReactNode }) {
  return <span className={`wf-badge ${tone}`}>{children}</span>;
}
export const stateTone = (s: WorkflowState) => (s === 'active' ? 'ok' : s === 'paused' ? 'warn' : s === 'archived' ? 'muted' : 'accent');
export const runTone = (s: RunState) => (s === 'completed' ? 'ok' : s === 'incident' || s === 'failed' ? 'bad' : s === 'cancelled' ? 'muted' : 'accent');

/** Hinweis, dass ein Recht fehlt; `lead` beginnt den Satz («Zum Bearbeiten»). */
export function MissingRight({ perm, lead }: { perm: string; lead: string }) {
  return <p className="wf-muted wf-small">{lead} fehlt dir das Recht «{PERMISSION_LABEL[perm] ?? perm}». Rechte vergibt die Administration.</p>;
}

// ---------------------------------------------------------------- Formatierung (de-CH)

const dateTimeFmt = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : dateTimeFmt.format(d);
}

/** Dauer zwischen zwei Zeitpunkten, z. B. «1,2 s», «3 min». */
export function fmtElapsed(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return '';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1 }).format(ms / 3_600_000)} h`;
}

/** Anzahl mit Einzahl oder Mehrzahl, z. B. `plural(1, 'Person', 'Personen')` → «1 Person». */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Frist relativ zu jetzt, z. B. «fällig in 3 h», «überfällig seit 2 Tagen». */
export function fmtDue(due: string | null | undefined, now = Date.now()): { text: string; overdue: boolean; soon: boolean } {
  if (!due) return { text: 'ohne Frist', overdue: false, soon: false };
  const ms = new Date(due).getTime() - now;
  const abs = Math.abs(ms);
  const span = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))} min` : abs < 2 * 86_400_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} Tagen`;
  return ms < 0 ? { text: `überfällig seit ${span}`, overdue: true, soon: false } : { text: `fällig in ${span}`, overdue: false, soon: ms < 4 * 3_600_000 };
}

/** JSON lesbar (Protokoll, Probelauf). */
export function Json({ value, label }: { value: unknown; label: string }) {
  if (value === undefined || value === null) return null;
  return <details className="wf-json"><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
