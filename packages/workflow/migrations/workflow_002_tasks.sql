-- workflow_002 Aufgaben und Warteschlangen (Stufe 2): Kalender, Warteschlangen, Aufgaben (auch Genehmigungen),
-- Stimmen und Fristen (SLA-Uhren).
--
-- Platzhalter (workflowMigrations): {{schema}} Schema der App, {{app}} Laufzeit-Rolle, {{sched}} Worker-Rolle,
-- {{tenant}} Ausdruck für den Mandanten der Anfrage, {{principal}} Ausdruck für die angemeldete Person.
--
-- Regeln:
-- - Idempotent: legt an, was fehlt. Jede Tabelle hat tenant_id, RLS ENABLE und FORCE und tenant_isolation.
-- - Lesesicht der Aufgaben in der Datenbank: zuständig (assignee_id), unter den Kandidaten (candidates, z. B.
--   Genehmigende oder Mitglieder eines Teams beim Anlegen) oder der Lauf ist sichtbar (dessen Lesesicht hängt am Bezug,
--   workflow_subjects aus 001). Wer zu einer Warteschlange gehört, entscheidet die App über host.members zur Laufzeit;
--   das prüfen die Routen (wie das Recht workflow:read bei den Läufen). Stimmen und Fristen hängen an der Aufgabe.
-- - Die Engine liest an der Lesesicht vorbei (workflow.engine = on); der Worker liest und markiert fällige Fristen über
--   alle Mandanten, nur mit workflow.sched = on.
-- - Stimmen sind unveränderlich (nur anhängen).

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_calendar (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  timezone text NOT NULL,
  week jsonb NOT NULL DEFAULT '{}',
  holidays jsonb NOT NULL DEFAULT '[]',
  is_default boolean NOT NULL DEFAULT false,
  revision int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_calendar_default ON {{schema}}.workflow_calendar (tenant_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_queue (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text,
  team_type text NOT NULL,
  team_id text NOT NULL,
  sort text NOT NULL DEFAULT 'urgency' CHECK (sort IN ('urgency', 'due', 'age')),
  assignment text NOT NULL DEFAULT 'pull' CHECK (assignment IN ('pull', 'round_robin', 'least_load')),
  -- Zeiger für Round Robin: zuletzt zugewiesener Akteur
  rr_last_id text,
  calendar_id uuid,
  -- Frist für Aufgaben ohne eigene Frist (Dauer, z. B. P2BD) und Eskalation bei Verzug
  sla_target text,
  escalation jsonb,
  revision int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES {{schema}}.workflow_calendar (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_task (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('task', 'approval')),
  workflow_id uuid,
  run_id uuid,
  step_path text,
  step_id text,
  run_seq int,
  subject_type text,
  subject_id text,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 2000),
  description text,
  form jsonb NOT NULL DEFAULT '[]',
  outcomes jsonb NOT NULL DEFAULT '[]',
  -- Genehmigung: Art und ob eine Ablehnung begründet werden muss
  mode text CHECK (mode IN ('first', 'all', 'majority', 'sequential')),
  reason_required boolean NOT NULL DEFAULT true,
  -- Wer die Aufgabe nehmen oder entscheiden darf, wenn niemand zuständig ist (Liste von {id, kind}; Reihenfolge zählt)
  candidates jsonb NOT NULL DEFAULT '[]',
  assignee_id text,
  assignee_kind text CHECK (assignee_kind IN ('person', 'client')),
  queue_id uuid,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_progress', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  outcome text,
  form_values jsonb,
  reason text,
  due_at timestamptz,
  breached_at timestamptz,
  assigned_at timestamptz,
  completed_at timestamptz,
  completed_by_id text,
  completed_by_kind text,
  revision int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, run_id, step_path, run_seq),
  FOREIGN KEY (tenant_id, run_id) REFERENCES {{schema}}.workflow_run (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, queue_id) REFERENCES {{schema}}.workflow_queue (tenant_id, id) ON DELETE SET NULL (queue_id),
  CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  CHECK ((assignee_id IS NULL) = (assignee_kind IS NULL)),
  CHECK (kind <> 'approval' OR mode IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS workflow_task_by_assignee ON {{schema}}.workflow_task (tenant_id, assignee_id) WHERE state IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS workflow_task_by_queue ON {{schema}}.workflow_task (tenant_id, queue_id, state);
CREATE INDEX IF NOT EXISTS workflow_task_by_run ON {{schema}}.workflow_task (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS workflow_task_by_subject ON {{schema}}.workflow_task (tenant_id, subject_type, subject_id) WHERE subject_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_task_open ON {{schema}}.workflow_task (tenant_id, state, due_at) WHERE state IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS workflow_task_candidates ON {{schema}}.workflow_task USING gin (candidates jsonb_path_ops);

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_task_vote (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'client')),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, task_id, actor_id, actor_kind),
  FOREIGN KEY (tenant_id, task_id) REFERENCES {{schema}}.workflow_task (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_sla_timer (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  -- Ziel als Dauer (z. B. P3BD, PT8BH) und Kalender, nach dem gerechnet wurde (NULL = Vorgabe)
  target text NOT NULL,
  calendar_id uuid,
  started_at timestamptz NOT NULL,
  paused_at timestamptz,
  paused_ms bigint NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL,
  breached_at timestamptz,
  escalated_at timestamptz,
  stopped_at timestamptz,
  escalation jsonb,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES {{schema}}.workflow_task (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workflow_sla_timer_due ON {{schema}}.workflow_sla_timer (due_at)
  WHERE breached_at IS NULL AND stopped_at IS NULL AND paused_at IS NULL;

-- Mandantentrennung
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_calendar', 'workflow_queue', 'workflow_task', 'workflow_task_vote', 'workflow_sla_timer'] LOOP
    EXECUTE format('ALTER TABLE {{schema}}.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE {{schema}}.%I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format($f$CREATE POLICY tenant_isolation ON {{schema}}.%I TO {{app}} USING (tenant_id = {{tenant}}) WITH CHECK (tenant_id = {{tenant}})$f$, t);
    END IF;
  END LOOP;
END $$;

-- Lesesicht der Aufgaben, Stimmen und Fristen
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = 'workflow_task' AND policyname = 'subject_read') THEN
    CREATE POLICY subject_read ON {{schema}}.workflow_task AS RESTRICTIVE FOR SELECT TO {{app}}
      USING (current_setting('workflow.engine', true) = 'on'
        OR assignee_id = ({{principal}})::text
        OR candidates @> jsonb_build_array(jsonb_build_object('id', ({{principal}})::text))
        OR run_id IS NULL
        OR EXISTS (SELECT 1 FROM {{schema}}.workflow_run r WHERE r.tenant_id = workflow_task.tenant_id AND r.id = workflow_task.run_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = 'workflow_task_vote' AND policyname = 'subject_read') THEN
    CREATE POLICY subject_read ON {{schema}}.workflow_task_vote AS RESTRICTIVE FOR SELECT TO {{app}}
      USING (EXISTS (SELECT 1 FROM {{schema}}.workflow_task t WHERE t.tenant_id = workflow_task_vote.tenant_id AND t.id = workflow_task_vote.task_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = 'workflow_sla_timer' AND policyname = 'subject_read') THEN
    CREATE POLICY subject_read ON {{schema}}.workflow_sla_timer AS RESTRICTIVE FOR SELECT TO {{app}}
      USING (current_setting('workflow.engine', true) = 'on'
        OR EXISTS (SELECT 1 FROM {{schema}}.workflow_task t WHERE t.tenant_id = workflow_sla_timer.tenant_id AND t.id = workflow_sla_timer.task_id));
  END IF;
  -- Fristen im Worker über alle Mandanten, nur mit workflow.sched = on
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = 'workflow_sla_timer' AND policyname = 'sched_tick') THEN
    CREATE POLICY sched_tick ON {{schema}}.workflow_sla_timer FOR ALL TO {{sched}}
      USING (current_setting('workflow.sched', true) = 'on') WITH CHECK (current_setting('workflow.sched', true) = 'on');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.workflow_calendar, {{schema}}.workflow_queue TO {{app}};
GRANT SELECT, INSERT, UPDATE ON {{schema}}.workflow_task, {{schema}}.workflow_sla_timer TO {{app}};
-- Stimmen nur anhängen
GRANT SELECT, INSERT ON {{schema}}.workflow_task_vote TO {{app}};
REVOKE UPDATE, DELETE ON {{schema}}.workflow_task_vote FROM {{app}};
GRANT SELECT, UPDATE ON {{schema}}.workflow_sla_timer TO {{sched}};
