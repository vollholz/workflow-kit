/**
 * Aufgaben und Warteschlangen (Stufe 2, Konzept 4.6, W7, W10): Aufgaben und Genehmigungen aus Schritten anlegen,
 * zuweisen (Akteur, Team, Feld des Bezugs, Warteschlange mit Round Robin oder geringster Last), nehmen, zurücklegen,
 * weitergeben, erledigen, entscheiden, abbrechen; Fristen nach Kalender (SLA) mit Verzug und Eskalation.
 *
 * Regeln:
 * - Eine Aufgabe aus einem Lauf merkt sich Schrittpfad und Folgenummer des Laufs (`run_seq`); nur genau dieser
 *   wartende Lauf wird beim Erledigen fortgesetzt (`Engine.resumeAfterTask`), sonst bleibt der Lauf unberührt.
 * - Erledigen und Entscheiden handeln als die Person, die es tut (W7: Rechte prüfen die Routen, Audit mit ihr als
 *   Akteur); die Folgeschritte laufen danach als Jobs wieder im Namen des Workflow-Akteurs.
 * - Ergebnis im Lauf unter `steps.<id>`: `outcome`, `values`, `completedBy`, `completedAt`; bei Genehmigungen dazu
 *   `votes` und `reason`. Eine abgebrochene Aufgabe setzt den Lauf mit `outcome: 'cancelled'` fort; bricht der Lauf ab,
 *   werden seine offenen Aufgaben abgebrochen, ohne ihn fortzusetzen.
 * - Ereignisse `task.*` gehen über `emitFor` mit der Herkunft des Laufs (Schleifenschutz), Audit für Anlegen,
 *   Zuweisungen, Entscheide, Erledigen, Abbrechen und Verzug. Benachrichtigungen nur über den optionalen Port `notify`;
 *   bei vertraulichem Bezug mit neutralem Titel.
 * - Fristen: Ziel als Dauer (`P3BD`, `PT8BH`) nach dem Kalender der Warteschlange, sonst dem Standardkalender des
 *   Mandanten, sonst `DEFAULT_WORK_CALENDAR`. `tick` markiert fällige Fristen (`breached_at`) und reiht je Frist einen
 *   Job `workflow.sla` ein, der eskaliert (Ereignis, Benachrichtigung, Priorität, Umleiten) – einmal je Frist.
 */
import { randomUUID } from 'node:crypto';
import { addWorkingTime, DEFAULT_WORK_CALENDAR, type WorkCalendar } from './calendar.ts';
import type { ApprovalMode, ApprovalStep, Assignee, Escalation, TaskPriority, TaskStep } from './definition.ts';
import type { Engine, RunRow } from './engine.ts';
import { resolvePath, resolveValue, type ExpressionContext } from './expressions.ts';
import { FormChecker } from './forms.ts';
import type { ActorRef, FieldDef, JobCtx, NoticeKind, SubjectRef, TeamRef, Tx } from './ports.ts';

export const WORKFLOW_JOB_SLA = 'workflow.sla';

export type TaskKind = 'task' | 'approval';
export type TaskState = 'open' | 'in_progress' | 'done' | 'cancelled';
export type QueueSort = 'urgency' | 'due' | 'age';
export type QueueAssignment = 'pull' | 'round_robin' | 'least_load';
export type Decision = 'approved' | 'rejected';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const satisfies readonly TaskPriority[];
export const ACTIVE_STATES: readonly TaskState[] = ['open', 'in_progress'];
/** Titel einer Aufgabe, deren Bezug die Person nicht sehen darf, und in Benachrichtigungen bei vertraulichem Bezug. */
export const HIDDEN_TITLE = 'Aufgabe zu einem vertraulichen Bezug';

export interface TaskRow {
  tenant_id: string; id: string; kind: TaskKind; workflow_id: string | null; run_id: string | null; step_path: string | null; step_id: string | null;
  run_seq: number | null; subject_type: string | null; subject_id: string | null; title: string; description: string | null; form: FieldDef[];
  outcomes: string[]; mode: ApprovalMode | null; reason_required: boolean; candidates: ActorRef[]; assignee_id: string | null;
  assignee_kind: ActorRef['kind'] | null; queue_id: string | null; state: TaskState; priority: TaskPriority; outcome: string | null;
  form_values: Record<string, unknown> | null; reason: string | null; due_at: Date | string | null; breached_at: Date | string | null;
  assigned_at: Date | string | null; completed_at: Date | string | null; completed_by_id: string | null; completed_by_kind: ActorRef['kind'] | null;
  revision: number; created_at: Date | string; updated_at: Date | string;
}

export interface QueueRow {
  tenant_id: string; id: string; name: string; description: string | null; team_type: string; team_id: string; sort: QueueSort;
  assignment: QueueAssignment; rr_last_id: string | null; calendar_id: string | null; sla_target: string | null; escalation: Escalation | null;
  revision: number; created_at: Date | string; updated_at: Date | string;
}

export interface CalendarRow {
  tenant_id: string; id: string; name: string; timezone: string; week: WorkCalendar['week']; holidays: WorkCalendar['holidays'];
  is_default: boolean; revision: number; created_at: Date | string; updated_at: Date | string;
}

export interface VoteRow { id: string; task_id: string; actor_id: string; actor_kind: ActorRef['kind']; decision: Decision; reason: string | null; created_at: Date | string }

export interface TimerRow {
  tenant_id: string; id: string; task_id: string; target: string; calendar_id: string | null; started_at: Date | string; paused_at: Date | string | null;
  paused_ms: string | number; due_at: Date | string; breached_at: Date | string | null; escalated_at: Date | string | null;
  stopped_at: Date | string | null; escalation: Escalation | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Reine Regeln (einzeln getestet)

/**
 * Ergebnis einer Genehmigung nach Art und bisherigen Stimmen; `null` = noch offen.
 * - `first`: die erste Stimme entscheidet.
 * - `all` und `sequential`: eine Ablehnung lehnt ab, sonst genehmigt, wenn alle zugestimmt haben.
 * - `majority`: genehmigt bei mehr als der Hälfte Zustimmungen; abgelehnt, sobald das nicht mehr erreichbar ist
 *   (bei Gleichstand abgelehnt).
 */
export function approvalOutcome(mode: ApprovalMode, voters: number, votes: { decision: Decision }[]): Decision | null {
  const yes = votes.filter(v => v.decision === 'approved').length;
  const no = votes.length - yes;
  switch (mode) {
    case 'first': return votes[0]?.decision ?? null;
    case 'all':
    case 'sequential':
      if (no > 0) return 'rejected';
      return yes >= voters ? 'approved' : null;
    case 'majority': {
      const need = Math.floor(voters / 2) + 1;
      if (yes >= need) return 'approved';
      if (no > voters - need) return 'rejected';
      return null;
    }
  }
}

export const actorKey = (a: Pick<ActorRef, 'id' | 'kind'>) => `${a.kind}:${a.id}`;

/** Akteure ohne Doppel, Reihenfolge bleibt. */
export function uniqueActors(list: ActorRef[]): ActorRef[] {
  const seen = new Set<string>();
  return list.filter(a => (seen.has(actorKey(a)) ? false : (seen.add(actorKey(a)), true)));
}

/** Mitglieder in fester Reihenfolge, beginnend nach dem zuletzt zugewiesenen (Round Robin). */
export function rotateAfter(members: ActorRef[], lastId: string | null): ActorRef[] {
  const sorted = uniqueActors(members).sort((a, b) => (actorKey(a) < actorKey(b) ? -1 : actorKey(a) > actorKey(b) ? 1 : 0));
  const i = lastId === null ? -1 : sorted.findIndex(m => actorKey(m) === lastId || m.id === lastId);
  return i < 0 ? sorted : [...sorted.slice(i + 1), ...sorted.slice(0, i + 1)];
}

/** Nächste Person nach Round Robin. */
export function nextRoundRobin(members: ActorRef[], lastId: string | null): ActorRef | null {
  return rotateAfter(members, lastId)[0] ?? null;
}

/** Person mit der geringsten offenen Last; bei Gleichstand die nächste nach Round Robin. */
export function leastLoaded(members: ActorRef[], load: (a: ActorRef) => number, lastId: string | null): ActorRef | null {
  let best: ActorRef | null = null;
  let min = Infinity;
  for (const m of rotateAfter(members, lastId)) {
    const n = load(m);
    if (n < min) { min = n; best = m; }
  }
  return best;
}

/** Priorität eine Stufe höher (höchstens `urgent`). */
export function raisePriority(p: TaskPriority): TaskPriority {
  return PRIORITIES[Math.min(PRIORITIES.indexOf(p) + 1, PRIORITIES.length - 1)]!;
}

/** Akteur aus einem Wert (Text = Person, `{ id, kind }`); sonst null. */
export function actorFrom(v: unknown): ActorRef | null {
  if (typeof v === 'string' && v) return { id: v, kind: 'person' };
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && (v as { id: string }).id) {
    const kind = (v as { kind?: unknown }).kind;
    return { id: (v as { id: string }).id, kind: kind === 'client' ? 'client' : 'person' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------

/** Fehler, den die Routen in `host.error` übersetzen. */
export class TaskError extends Error {
  override name = 'TaskError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const iso = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : new Date(v).toISOString());

export class Tasks {
  private readonly e: Engine;
  readonly forms: FormChecker;

  constructor(engine: Engine, forms: FormChecker) {
    this.e = engine;
    this.forms = forms;
  }

  private t(name: string): string { return `${this.e.o.schema}.${name}`; }
  private now(): Date { return this.e.o.clock(); }
  private get host() { return this.e.o.host; }

  // -------------------------------------------------------------------------------------------------------------
  // Lesen

  async load(tx: Tx, id: string, lock = false): Promise<TaskRow | null> {
    return (await tx.query<TaskRow>(`SELECT * FROM ${this.t('workflow_task')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] ?? null;
  }

  async queue(tx: Tx, id: string, lock = false): Promise<QueueRow | null> {
    return (await tx.query<QueueRow>(`SELECT * FROM ${this.t('workflow_queue')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] ?? null;
  }

  async votes(tx: Tx, taskId: string): Promise<VoteRow[]> {
    return (await tx.query<VoteRow>(`SELECT * FROM ${this.t('workflow_task_vote')} WHERE task_id = $1 ORDER BY created_at, id`, [taskId])).rows;
  }

  async timer(tx: Tx, taskId: string): Promise<TimerRow | null> {
    return (await tx.query<TimerRow>(`SELECT * FROM ${this.t('workflow_sla_timer')} WHERE task_id = $1`, [taskId])).rows[0] ?? null;
  }

  /** Kalender: der angegebene, sonst der Standard des Mandanten, sonst die Vorgabe des Pakets. */
  async calendar(tx: Tx, id: string | null): Promise<{ id: string | null; calendar: WorkCalendar }> {
    const row = (await tx.query<CalendarRow>(
      id ? `SELECT * FROM ${this.t('workflow_calendar')} WHERE id = $1` : `SELECT * FROM ${this.t('workflow_calendar')} WHERE is_default`, id ? [id] : [])).rows[0];
    return row ? { id: row.id, calendar: { timezone: row.timezone, week: row.week, holidays: row.holidays } } : { id: null, calendar: DEFAULT_WORK_CALENDAR };
  }

  /** Frist ab jetzt nach Kalender. */
  async dueAt(tx: Tx, target: string, calendarId: string | null, from = this.now()): Promise<{ dueAt: Date; calendarId: string | null }> {
    const c = await this.calendar(tx, calendarId);
    return { dueAt: addWorkingTime(c.calendar, from, target), calendarId: c.id };
  }

  /** Mitglieder eines Teams über den Port der App. */
  members(tx: Tx, team: TeamRef): Promise<ActorRef[]> {
    return this.host.members(tx, team);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Zuweisung

  /** Akteure aus einer Zuständigkeit (ohne Warteschlange: deren Regel greift in `pick`). */
  async actorsOf(tx: Tx, a: Assignee, ctx: ExpressionContext): Promise<ActorRef[]> {
    if ('actor' in a) return [{ id: a.actor.id, kind: a.actor.kind }];
    if ('team' in a) return uniqueActors(await this.members(tx, a.team));
    if ('field' in a) {
      const v = resolvePath(ctx, a.field);
      const list = Array.isArray(v) ? v : [v];
      return uniqueActors(list.map(actorFrom).filter((x): x is ActorRef => x !== null));
    }
    const q = await this.queue(tx, a.queue);
    return q ? uniqueActors(await this.members(tx, { type: q.team_type, id: q.team_id })) : [];
  }

  /** Nächste Person einer Warteschlange nach ihrer Regel (Zeiger wird nachgeführt); `null` bei «Nehmen». */
  async pick(tx: Tx, queueId: string): Promise<ActorRef | null> {
    const q = await this.queue(tx, queueId, true);
    if (!q || q.assignment === 'pull') return null;
    const members = await this.members(tx, { type: q.team_type, id: q.team_id });
    if (!members.length) return null;
    let chosen: ActorRef | null;
    if (q.assignment === 'round_robin') chosen = nextRoundRobin(members, q.rr_last_id);
    else {
      const rows = (await tx.query<{ assignee_id: string; assignee_kind: string; n: number }>(
        `SELECT assignee_id, assignee_kind, count(*)::int AS n FROM ${this.t('workflow_task')}
          WHERE state IN ('open', 'in_progress') AND assignee_id = ANY($1::text[]) GROUP BY assignee_id, assignee_kind`, [members.map(m => m.id)])).rows;
      const load = new Map(rows.map(r => [`${r.assignee_kind}:${r.assignee_id}`, r.n]));
      chosen = leastLoaded(members, m => load.get(actorKey(m)) ?? 0, q.rr_last_id);
    }
    if (chosen) await tx.query(`UPDATE ${this.t('workflow_queue')} SET rr_last_id = $2 WHERE id = $1`, [q.id, actorKey(chosen)]);
    return chosen;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Anlegen aus einem Schritt

  /** Aufgabe oder Genehmigung eines Schritts anlegen (Job des Laufs, an der Lesesicht vorbei). */
  async createFromStep(tx: Tx, run: RunRow, step: TaskStep | ApprovalStep, path: string, ctx: ExpressionContext): Promise<TaskRow> {
    const approval = 'approval' in step ? step.approval : null;
    const spec = 'task' in step ? step.task : step.approval;
    const text = (v: string) => String(resolveValue(v, ctx) ?? '').trim();
    const title = text(spec.title).slice(0, 2000) || 'Aufgabe';
    const description = spec.description ? text(spec.description) || null : null;
    let assignee: ActorRef | null = null;
    let candidates: ActorRef[] = [];
    let queue: QueueRow | null = null;

    if (approval) {
      for (const a of approval.approvers) candidates.push(...(await this.actorsOf(tx, a, ctx)));
      candidates = uniqueActors(candidates);
      if (!candidates.length) throw this.e.failure('no-assignee', 'Niemand kann diese Genehmigung entscheiden (keine Personen gefunden)');
      if (approval.mode === 'sequential') assignee = candidates[0]!;
    } else {
      const a = (step as TaskStep).task.assignee;
      if ('queue' in a) {
        queue = await this.queue(tx, a.queue);
        if (!queue) throw this.e.failure('queue-missing', `Warteschlange «${a.queue}» gibt es nicht`);
        assignee = await this.pick(tx, queue.id);
      } else {
        const actors = await this.actorsOf(tx, a, ctx);
        if (!actors.length) throw this.e.failure('no-assignee', 'Niemand ist für diese Aufgabe zuständig (keine Person gefunden)');
        if (actors.length === 1) assignee = actors[0]!;
        else candidates = actors;
      }
    }

    const now = this.now();
    const target = spec.due ?? queue?.sla_target ?? null;
    const due = target ? await this.dueAt(tx, target, queue?.calendar_id ?? null, now) : null;
    const escalation = spec.escalation ?? queue?.escalation ?? null;
    const outcomes = approval ? ['approved', 'rejected'] : ((step as TaskStep).task.outcomes ?? ['done']);
    const id = randomUUID();
    const row = (await tx.query<TaskRow>(
      `INSERT INTO ${this.t('workflow_task')} (tenant_id, id, kind, workflow_id, run_id, step_path, step_id, run_seq, subject_type, subject_id, title, description,
         form, outcomes, mode, reason_required, candidates, assignee_id, assignee_kind, queue_id, priority, due_at, assigned_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23, $24, $24)
       RETURNING *`,
      [run.tenant_id, id, approval ? 'approval' : 'task', run.workflow_id, run.id, path, step.id, run.seq + 1, run.subject_type, run.subject_id, title,
        description, JSON.stringify(approval ? [] : ((step as TaskStep).task.form ?? [])), JSON.stringify(outcomes), approval?.mode ?? null,
        approval ? approval.reasonOnReject ?? true : false, JSON.stringify(candidates), assignee?.id ?? null, assignee?.kind ?? null, queue?.id ?? null,
        spec.priority ?? 'normal', due?.dueAt ?? null, assignee ? now : null, now])).rows[0]!;
    if (due && target) {
      await tx.query(
        `INSERT INTO ${this.t('workflow_sla_timer')} (tenant_id, id, task_id, target, calendar_id, started_at, due_at, escalation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [run.tenant_id, randomUUID(), id, target, due.calendarId, now, due.dueAt, escalation ? JSON.stringify(escalation) : null]);
    }
    // vertraulich oder für die Engine nicht ladbar: Benachrichtigungen mit neutralem Titel
    const snap = ctx.subject as { title?: unknown; confidential?: unknown } | null;
    const confidential = !!run.subject_type && (!snap || snap.title === undefined || snap.confidential === true);
    await this.event(tx, row, 'task.created', { kind: row.kind, queueId: row.queue_id, assignee, dueAt: iso(row.due_at) });
    await this.host.audit(tx, {
      action: 'task.created', actor: null, onBehalfOf: { id: run.actor_id, kind: run.actor_kind }, subject: this.subjectOf(row),
      workflowId: run.workflow_id, runId: run.id, data: { taskId: id, kind: row.kind, title, assignee, queueId: row.queue_id, candidates: candidates.length },
    });
    if (assignee) await this.assigned(tx, row, assignee, null, confidential, approval ? 'approval_requested' : 'task_assigned');
    if (approval && approval.mode !== 'sequential') {
      for (const c of candidates) await this.notify(tx, row, 'approval_requested', c, confidential);
    }
    return row;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Hilfen für Ereignisse, Audit, Benachrichtigungen

  subjectOf(task: Pick<TaskRow, 'subject_type' | 'subject_id'>): SubjectRef | null {
    return task.subject_type && task.subject_id ? { type: task.subject_type, id: task.subject_id } : null;
  }

  /** Ereignis zur Aufgabe; aus einem Lauf mit dessen Herkunft (Schleifenschutz). */
  async event(tx: Tx, task: TaskRow, type: string, data: Record<string, unknown>): Promise<void> {
    const payload = { taskId: task.id, workflowId: task.workflow_id, runId: task.run_id, subject: this.subjectOf(task), ...data };
    if (task.run_id) {
      const depth = (await this.e.asEngine(tx, () => tx.query<{ chain_depth: number }>(`SELECT chain_depth FROM ${this.t('workflow_run')} WHERE id = $1`, [task.run_id]))).rows[0]?.chain_depth ?? 1;
      await this.e.emitFor(tx, { id: task.run_id, chain_depth: depth, subject_id: task.subject_id }, type, payload);
    } else {
      await this.host.emit(tx, type, task.subject_id, payload);
    }
  }

  async notify(tx: Tx, task: TaskRow, kind: NoticeKind, recipient: ActorRef, confidential?: boolean): Promise<void> {
    if (!this.host.notify) return;
    const hidden = confidential ?? (await this.isConfidential(tx, task));
    const lead = kind === 'approval_requested' ? 'Genehmigung erbeten' : kind === 'sla_breached' ? 'Frist überschritten' : 'Neue Aufgabe';
    await this.host.notify(tx, {
      kind, recipient, title: `${lead}: ${hidden ? HIDDEN_TITLE : task.title}`, subject: this.subjectOf(task), link: null,
      data: { taskId: task.id, taskKind: task.kind, workflowId: task.workflow_id, runId: task.run_id, dueAt: iso(task.due_at) },
    });
  }

  private async isConfidential(tx: Tx, task: TaskRow): Promise<boolean> {
    if (!task.subject_type || !task.subject_id) return false;
    const s = this.e.subjectType(task.subject_type);
    const snap = s ? await this.e.asEngine(tx, () => s.load(tx, task.subject_id!)) : null;
    return !snap || snap.confidential;
  }

  /** Zuweisung melden: Ereignis, Audit (Akteur oder Regel), Benachrichtigung an die neue Person (nicht an sich selbst). */
  private async assigned(tx: Tx, task: TaskRow, to: ActorRef | null, by: ActorRef | null, confidential?: boolean, kind: NoticeKind = 'task_assigned'): Promise<void> {
    await this.event(tx, task, 'task.assigned', { assignee: to, queueId: task.queue_id, by });
    await this.host.audit(tx, {
      action: 'task.assigned', actor: by, subject: this.subjectOf(task), workflowId: task.workflow_id, runId: task.run_id,
      data: { taskId: task.id, assignee: to, queueId: task.queue_id },
    });
    if (to && (!by || actorKey(by) !== actorKey(to))) await this.notify(tx, task, kind, to, confidential);
  }

  private async write(tx: Tx, task: TaskRow, set: Record<string, unknown>): Promise<TaskRow> {
    const json = new Set(['form_values', 'candidates']);
    const keys = Object.keys(set);
    const cols = keys.map((k, i) => `${k} = $${i + 2}${json.has(k) ? '::jsonb' : ''}`);
    return (await tx.query<TaskRow>(
      `UPDATE ${this.t('workflow_task')} SET ${cols.join(', ')}, revision = revision + 1, updated_at = $${keys.length + 2} WHERE id = $1 RETURNING *`,
      [task.id, ...keys.map(k => (json.has(k) && set[k] !== null ? JSON.stringify(set[k]) : set[k])), this.now()])).rows[0]!;
  }

  private async stopTimer(tx: Tx, taskId: string): Promise<void> {
    await tx.query(`UPDATE ${this.t('workflow_sla_timer')} SET stopped_at = $2 WHERE task_id = $1 AND stopped_at IS NULL`, [taskId, this.now()]);
  }

  private active(task: TaskRow): void {
    if (!ACTIVE_STATES.includes(task.state)) throw new TaskError(409, 'conflict', 'Die Aufgabe ist schon erledigt oder abgebrochen.');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Aktionen (Rechte und Sichtbarkeit prüfen die Routen)

  /** Nehmen: die Person wird zuständig und arbeitet daran. */
  async take(tx: Tx, task: TaskRow, by: ActorRef): Promise<TaskRow> {
    this.active(task);
    if (task.kind === 'approval') throw new TaskError(409, 'conflict', 'Genehmigungen werden entschieden, nicht genommen.');
    const mine = task.assignee_id === by.id && task.assignee_kind === by.kind;
    if (mine && task.state === 'in_progress') return task;
    const after = await this.write(tx, task, { assignee_id: by.id, assignee_kind: by.kind, state: 'in_progress', ...(mine ? {} : { assigned_at: this.now() }) });
    await this.host.audit(tx, { action: 'task.taken', actor: by, subject: this.subjectOf(task), workflowId: task.workflow_id, runId: task.run_id, data: { taskId: task.id } });
    if (!mine) await this.event(tx, after, 'task.assigned', { assignee: by, queueId: after.queue_id, by });
    return after;
  }

  /** Zurücklegen in die Warteschlange bzw. an das Team. */
  async release(tx: Tx, task: TaskRow, by: ActorRef): Promise<TaskRow> {
    this.active(task);
    if (task.kind === 'approval') throw new TaskError(409, 'conflict', 'Genehmigungen lassen sich nicht zurücklegen.');
    if (!task.queue_id && !task.candidates.length) throw new TaskError(409, 'conflict', 'Diese Aufgabe gehört keiner Warteschlange; gib sie stattdessen weiter.');
    if (!task.assignee_id) return task;
    const after = await this.write(tx, task, { assignee_id: null, assignee_kind: null, state: 'open', assigned_at: null });
    await this.event(tx, after, 'task.assigned', { assignee: null, queueId: after.queue_id, by });
    await this.host.audit(tx, { action: 'task.released', actor: by, subject: this.subjectOf(task), workflowId: task.workflow_id, runId: task.run_id, data: { taskId: task.id, from: { id: task.assignee_id, kind: task.assignee_kind } } });
    return after;
  }

  /** Weitergeben an eine Person und/oder in eine Warteschlange (dort nach deren Regel, wenn keine Person angegeben ist). */
  async assign(tx: Tx, task: TaskRow, by: ActorRef, to: { assignee?: ActorRef | null; queueId?: string | null }): Promise<TaskRow> {
    this.active(task);
    if (task.kind === 'approval') throw new TaskError(409, 'conflict', 'Genehmigungen lassen sich nicht weitergeben.');
    const set: Record<string, unknown> = {};
    let assignee: ActorRef | null = to.assignee === undefined ? (task.assignee_id ? { id: task.assignee_id, kind: task.assignee_kind! } : null) : to.assignee;
    if (to.queueId !== undefined) {
      if (to.queueId !== null && !(await this.queue(tx, to.queueId))) throw new TaskError(404, 'not-found', 'Warteschlange nicht gefunden.');
      set.queue_id = to.queueId;
      if (to.assignee === undefined) assignee = to.queueId ? await this.pick(tx, to.queueId) : assignee;
    }
    if (!assignee && !(set.queue_id ?? task.queue_id) && !task.candidates.length) throw new TaskError(422, 'invalid', 'Bitte eine Person oder eine Warteschlange angeben.');
    Object.assign(set, { assignee_id: assignee?.id ?? null, assignee_kind: assignee?.kind ?? null, state: 'open', assigned_at: assignee ? this.now() : null });
    const after = await this.write(tx, task, set);
    await this.assigned(tx, after, assignee, by);
    return after;
  }

  /** Erledigen mit Ergebnis und Formularwerten (serverseitig geprüft); setzt den wartenden Lauf fort. */
  async complete(tx: Tx, task: TaskRow, by: ActorRef, outcome: string | undefined, values: unknown): Promise<TaskRow> {
    this.active(task);
    if (task.kind === 'approval') throw new TaskError(409, 'conflict', 'Genehmigungen werden über «Entscheiden» abgeschlossen.');
    const outcomes = task.outcomes.length ? task.outcomes : ['done'];
    const chosen = outcome ?? (outcomes.length === 1 ? outcomes[0] : undefined);
    if (!chosen || !outcomes.includes(chosen)) throw new TaskError(422, 'invalid', `Bitte ein Ergebnis wählen: ${outcomes.map(o => `«${o}»`).join(', ')}.`);
    const form = this.forms.check(task.form, values);
    if (!form.ok) throw new TaskError(422, 'invalid', `Formular unvollständig: ${form.errors.map(e => e.message).join('; ')}.`);
    const now = this.now();
    const after = await this.write(tx, task, {
      state: 'done', outcome: chosen, form_values: form.values, completed_at: now, completed_by_id: by.id, completed_by_kind: by.kind,
      ...(task.assignee_id ? {} : { assignee_id: by.id, assignee_kind: by.kind, assigned_at: now }),
    });
    await this.stopTimer(tx, task.id);
    await this.event(tx, after, 'task.completed', { outcome: chosen, by });
    await this.host.audit(tx, {
      action: 'task.completed', actor: by, subject: this.subjectOf(task), workflowId: task.workflow_id, runId: task.run_id,
      data: { taskId: task.id, outcome: chosen, fields: Object.keys(form.values) },
    });
    await this.resume(tx, after, { taskId: task.id, outcome: chosen, values: form.values, completedBy: by, completedAt: now.toISOString() });
    return after;
  }

  /** Abstimmen bei einer Genehmigung; wenn entschieden, Lauf fortsetzen. */
  async decide(tx: Tx, task: TaskRow, by: ActorRef, decision: Decision, reason: string | null): Promise<TaskRow> {
    this.active(task);
    if (task.kind !== 'approval' || !task.mode) throw new TaskError(409, 'conflict', 'Nur Genehmigungen werden entschieden.');
    const key = actorKey(by);
    const index = task.candidates.findIndex(c => actorKey(c) === key);
    if (index < 0) throw new TaskError(403, 'forbidden', 'Du gehörst nicht zu den Personen, die hier entscheiden.');
    const before = await this.votes(tx, task.id);
    if (before.some(v => actorKey({ id: v.actor_id, kind: v.actor_kind }) === key)) throw new TaskError(409, 'conflict', 'Du hast hier schon entschieden.');
    if (task.mode === 'sequential' && index !== before.length) throw new TaskError(409, 'conflict', 'Du bist noch nicht an der Reihe.');
    const text = reason?.trim() || null;
    if (decision === 'rejected' && task.reason_required && !text) throw new TaskError(422, 'invalid', 'Bitte begründe die Ablehnung.');
    const now = this.now();
    await tx.query(
      `INSERT INTO ${this.t('workflow_task_vote')} (tenant_id, id, task_id, actor_id, actor_kind, decision, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [task.tenant_id, randomUUID(), task.id, by.id, by.kind, decision, text, now]);
    await this.event(tx, task, 'task.decided', { decision, by });
    await this.host.audit(tx, {
      action: 'task.decided', actor: by, subject: this.subjectOf(task), workflowId: task.workflow_id, runId: task.run_id,
      data: { taskId: task.id, decision, reason: text, mode: task.mode },
    });
    const votes = [...before, { id: '', task_id: task.id, actor_id: by.id, actor_kind: by.kind, decision, reason: text, created_at: now }];
    const result = approvalOutcome(task.mode, task.candidates.length, votes);
    if (!result) {
      const next = task.mode === 'sequential' ? task.candidates[votes.length] ?? null : null;
      const after = await this.write(tx, task, { state: 'in_progress', ...(next ? { assignee_id: next.id, assignee_kind: next.kind, assigned_at: now } : {}) });
      if (next) await this.assigned(tx, after, next, null, undefined, 'approval_requested');
      return after;
    }
    const deciding = result === 'rejected' ? votes.find(v => v.decision === 'rejected') : votes.at(-1);
    const after = await this.write(tx, task, {
      state: 'done', outcome: result, reason: deciding?.reason ?? null, form_values: {}, completed_at: now, completed_by_id: by.id, completed_by_kind: by.kind,
    });
    await this.stopTimer(tx, task.id);
    await this.event(tx, after, 'task.completed', { outcome: result, by });
    await this.host.audit(tx, { action: 'task.completed', actor: by, subject: this.subjectOf(task), workflowId: task.workflow_id, runId: task.run_id, data: { taskId: task.id, outcome: result } });
    await this.resume(tx, after, {
      taskId: task.id, outcome: result, reason: deciding?.reason ?? null, values: {}, completedBy: by, completedAt: now.toISOString(),
      votes: votes.map(v => ({ actor: { id: v.actor_id, kind: v.actor_kind }, decision: v.decision, reason: v.reason, at: iso(v.created_at) })),
    });
    return after;
  }

  /** Abbrechen von Hand; der Lauf geht mit `outcome: 'cancelled'` weiter. */
  async cancel(tx: Tx, task: TaskRow, by: ActorRef, reason: string | null): Promise<TaskRow> {
    this.active(task);
    const now = this.now();
    const after = await this.write(tx, task, { state: 'cancelled', outcome: 'cancelled', reason, completed_at: now, completed_by_id: by.id, completed_by_kind: by.kind });
    await this.stopTimer(tx, task.id);
    await this.event(tx, after, 'task.cancelled', { by, reason });
    await this.host.audit(tx, { action: 'task.cancelled', actor: by, subject: this.subjectOf(task), workflowId: task.workflow_id, runId: task.run_id, data: { taskId: task.id, reason } });
    await this.resume(tx, after, { taskId: task.id, outcome: 'cancelled', reason, values: {}, completedBy: by, completedAt: now.toISOString(), ...(task.kind === 'approval' ? { votes: [] } : {}) });
    return after;
  }

  /** Offene Aufgaben eines beendeten Laufs abbrechen (ohne den Lauf fortzusetzen). */
  async cancelForRun(tx: Tx, runId: string, reason: string): Promise<number> {
    const rows = (await tx.query<TaskRow>(
      `UPDATE ${this.t('workflow_task')} SET state = 'cancelled', outcome = 'cancelled', reason = $2, completed_at = $3, revision = revision + 1, updated_at = $3
        WHERE run_id = $1 AND state IN ('open', 'in_progress') RETURNING *`, [runId, reason, this.now()])).rows;
    for (const t of rows) {
      await this.stopTimer(tx, t.id);
      await this.event(tx, t, 'task.cancelled', { by: null, reason });
    }
    return rows.length;
  }

  private async resume(tx: Tx, task: TaskRow, output: Record<string, unknown>): Promise<void> {
    if (task.run_id && task.step_path && task.run_seq !== null) await this.e.resumeAfterTask(tx, { runId: task.run_id, path: task.step_path, seq: task.run_seq }, output);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Fristen

  /** Fällige Fristen markieren und je Frist einen Job `workflow.sla` einreihen (aus `tick`). */
  async tickSla(tx: Tx, o: { limit?: number } = {}): Promise<number> {
    const now = this.now();
    const due = (await tx.query<{ tenant_id: string; id: string }>(
      `SELECT t.tenant_id::text AS tenant_id, t.id FROM ${this.t('workflow_sla_timer')} t
         JOIN ${this.t('workflow_settings')} s ON s.tenant_id = t.tenant_id AND s.enabled
        WHERE t.due_at <= $1 AND t.breached_at IS NULL AND t.stopped_at IS NULL AND t.paused_at IS NULL
        ORDER BY t.due_at LIMIT $2 FOR UPDATE OF t SKIP LOCKED`, [now, o.limit ?? 100])).rows;
    for (const r of due) {
      await tx.query(`UPDATE ${this.t('workflow_sla_timer')} SET breached_at = $2 WHERE id = $1`, [r.id, now]);
      await this.host.jobs.enqueue(tx, WORKFLOW_JOB_SLA, { tenantId: r.tenant_id, timerId: r.id }, { dedupeKey: `workflow:sla:${r.id}` });
    }
    return due.length;
  }

  /** Job `workflow.sla`: Verzug melden und eskalieren (einmal je Frist). */
  async slaJob(ctx: JobCtx): Promise<void> {
    const p = ctx.payload as { tenantId: string; timerId: string };
    const tx = ctx.tx;
    await this.e.asEngine(tx, async () => {
      const timer = (await tx.query<TimerRow>(`SELECT * FROM ${this.t('workflow_sla_timer')} WHERE id = $1 FOR UPDATE`, [p.timerId])).rows[0];
      if (!timer || timer.escalated_at || timer.stopped_at) return;
      if (!(await this.e.settings(tx)).enabled) return;
      let task = await this.load(tx, timer.task_id, true);
      if (!task || !ACTIVE_STATES.includes(task.state)) return;
      const now = this.now();
      const breachedAt = timer.breached_at ?? now;
      await tx.query(`UPDATE ${this.t('workflow_sla_timer')} SET escalated_at = $2, breached_at = $3 WHERE id = $1`, [timer.id, now, breachedAt]);
      const e: Escalation = timer.escalation ?? {};
      const set: Record<string, unknown> = { breached_at: breachedAt };
      if (e.raisePriority) set.priority = raisePriority(task.priority);
      let rerouted: ActorRef | null | undefined;
      if (e.queue && e.queue !== task.queue_id && (await this.queue(tx, e.queue))) {
        rerouted = task.kind === 'task' ? await this.pick(tx, e.queue) : undefined;
        set.queue_id = e.queue;
        if (rerouted !== undefined) Object.assign(set, { assignee_id: rerouted?.id ?? null, assignee_kind: rerouted?.kind ?? null, state: 'open', assigned_at: rerouted ? now : null });
      }
      task = await this.write(tx, task, set);
      await this.event(tx, task, 'task.sla_breached', { dueAt: iso(timer.due_at), breachedAt: iso(breachedAt), priority: task.priority, queueId: task.queue_id });
      await this.host.audit(tx, {
        action: 'task.sla_breached', actor: null, subject: this.subjectOf(task), workflowId: task.workflow_id, runId: task.run_id,
        data: { taskId: task.id, dueAt: iso(timer.due_at), escalation: e },
      });
      if (rerouted !== undefined) await this.assigned(tx, task, rerouted, null);
      const recipients: ActorRef[] = [];
      if (task.assignee_id) recipients.push({ id: task.assignee_id, kind: task.assignee_kind! });
      else if (task.queue_id) {
        const q = await this.queue(tx, task.queue_id);
        if (q) recipients.push(...(await this.members(tx, { type: q.team_type, id: q.team_id })));
      } else recipients.push(...task.candidates);
      if (e.notify?.length) {
        const subject = await this.e.subjectContextOf(tx, task.subject_type, task.subject_id);
        for (const a of e.notify) recipients.push(...(await this.actorsOf(tx, a, { subject })));
      }
      const hidden = await this.isConfidential(tx, task);
      for (const r of uniqueActors(recipients)) await this.notify(tx, task, 'sla_breached', r, hidden);
    });
  }
}
