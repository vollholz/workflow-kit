-- workflow_001 Kern der Automation (Stufe 1): Workflows, Versionen, Auslöser, Läufe, Schrittprotokoll, Einstellungen
-- und Zähler je Mandant.
--
-- Platzhalter (workflowMigrations): {{schema}} Schema der App, {{app}} Laufzeit-Rolle, {{sched}} Worker-Rolle,
-- {{tenant}} Ausdruck für den Mandanten der Anfrage, {{principal}} Ausdruck für die angemeldete Person.
--
-- Regeln:
-- - Idempotent: legt an, was fehlt; bestehende Lesesichten (z. B. nach workflow_subjects) bleiben stehen.
-- - Jede Tabelle hat tenant_id, RLS ENABLE und FORCE und die Mandantentrennung tenant_isolation.
-- - Bezüge nur als (subject_type, subject_id) ohne Fremdschlüssel in Tabellen der App. Die Lesesicht der Läufe hängt
--   am Bezug: Die App meldet ihre Bezugstypen mit {{schema}}.workflow_subjects(...) in einer eigenen Migration;
--   unbekannte Bezugstypen sind unsichtbar, Läufe ohne Bezug sichtbar (das Recht prüft die API).
-- - Die Engine liest an der Lesesicht vorbei, solange sie workflow.engine = on setzt (nur lokal in der Transaktion).
-- - Der Worker (Rolle {{sched}}) liest und verschiebt Zeitpläne über alle Mandanten, nur mit workflow.sched = on.

CREATE OR REPLACE FUNCTION {{schema}}.workflow_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT {{tenant}} $$;

CREATE TABLE IF NOT EXISTS {{schema}}.workflow (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text,
  kind text NOT NULL CHECK (kind IN ('automation', 'case', 'state_model')),
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'paused', 'archived')),
  draft jsonb NOT NULL,
  revision int NOT NULL DEFAULT 1,
  active_version int,
  actor_id text,
  actor_kind text CHECK (actor_kind IN ('person', 'client')),
  paused_reason text,
  created_by_id text NOT NULL,
  created_by_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS workflow_by_scope ON {{schema}}.workflow (tenant_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS workflow_by_state ON {{schema}}.workflow (tenant_id, state);

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_version (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  workflow_id uuid NOT NULL,
  version int NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  schema_version int NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'client')),
  activated_by_id text NOT NULL,
  activated_by_kind text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workflow_id, version),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES {{schema}}.workflow (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_trigger (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  version int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('event', 'schedule', 'manual')),
  event_type text,
  filter jsonb,
  include_workflow_events boolean NOT NULL DEFAULT false,
  cron text,
  timezone text,
  next_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES {{schema}}.workflow (tenant_id, id) ON DELETE CASCADE,
  CHECK (kind <> 'event' OR event_type IS NOT NULL),
  CHECK (kind <> 'schedule' OR (cron IS NOT NULL AND timezone IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS workflow_trigger_by_event ON {{schema}}.workflow_trigger (tenant_id, event_type) WHERE kind = 'event';
CREATE INDEX IF NOT EXISTS workflow_trigger_due ON {{schema}}.workflow_trigger (next_at) WHERE kind = 'schedule';

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_run (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  version int NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('event', 'schedule', 'manual')),
  trigger jsonb NOT NULL DEFAULT '{}',
  subject_type text,
  subject_id text,
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'client')),
  started_by_id text,
  started_by_kind text,
  state text NOT NULL CHECK (state IN ('running', 'waiting', 'completed', 'failed', 'incident', 'cancelled')),
  cursor text,
  seq int NOT NULL DEFAULT 1,
  attempts int NOT NULL DEFAULT 0,
  step_count int NOT NULL DEFAULT 0,
  chain_depth int NOT NULL DEFAULT 1 CHECK (chain_depth >= 1),
  parent_run_id uuid,
  correlation_id text,
  variables jsonb NOT NULL DEFAULT '{}',
  outputs jsonb NOT NULL DEFAULT '{}',
  loops jsonb NOT NULL DEFAULT '{}',
  input jsonb,
  error jsonb,
  wake_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES {{schema}}.workflow (tenant_id, id),
  CHECK ((subject_type IS NULL) = (subject_id IS NULL))
);
CREATE INDEX IF NOT EXISTS workflow_run_by_workflow ON {{schema}}.workflow_run (tenant_id, workflow_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workflow_run_by_subject ON {{schema}}.workflow_run (tenant_id, subject_type, subject_id, started_at DESC) WHERE subject_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_run_list ON {{schema}}.workflow_run (tenant_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workflow_run_open ON {{schema}}.workflow_run (tenant_id, state) WHERE state IN ('running', 'waiting', 'incident');

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_step (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  id uuid NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  run_id uuid NOT NULL,
  path text NOT NULL,
  step_id text NOT NULL,
  kind text NOT NULL,
  attempt int NOT NULL CHECK (attempt >= 1),
  state text NOT NULL CHECK (state IN ('completed', 'failed', 'skipped', 'waiting')),
  input jsonb,
  output jsonb,
  log jsonb,
  error jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, run_id, path, attempt),
  FOREIGN KEY (tenant_id, run_id) REFERENCES {{schema}}.workflow_run (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_settings (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  enabled boolean NOT NULL DEFAULT false,
  limits jsonb NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id text,
  PRIMARY KEY (tenant_id)
);

CREATE TABLE IF NOT EXISTS {{schema}}.workflow_usage (
  tenant_id uuid NOT NULL DEFAULT {{tenant}},
  day date NOT NULL,
  runs int NOT NULL DEFAULT 0,
  runs_rejected int NOT NULL DEFAULT 0,
  steps int NOT NULL DEFAULT 0,
  http_calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

-- Neue Auslöser: Zähler «version» steigt, andere Prozesse erfahren es über LISTEN workflow_triggers (Nutzlast: Mandant)
CREATE OR REPLACE FUNCTION {{schema}}.workflow_settings_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('workflow_triggers', NEW.tenant_id::text);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER workflow_settings_notify AFTER UPDATE OF version, enabled, limits ON {{schema}}.workflow_settings
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.workflow_settings_notify();

-- Mandantentrennung und Rechte
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow', 'workflow_version', 'workflow_trigger', 'workflow_run', 'workflow_step', 'workflow_settings', 'workflow_usage'] LOOP
    EXECUTE format('ALTER TABLE {{schema}}.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE {{schema}}.%I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = t AND policyname = 'tenant_isolation') THEN
      -- Dollar-Quoting: der Ausdruck für den Mandanten darf Anführungszeichen enthalten
      EXECUTE format($f$CREATE POLICY tenant_isolation ON {{schema}}.%I TO {{app}} USING (tenant_id = {{tenant}}) WITH CHECK (tenant_id = {{tenant}})$f$, t);
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.workflow, {{schema}}.workflow_trigger, {{schema}}.workflow_run,
  {{schema}}.workflow_settings, {{schema}}.workflow_usage TO {{app}};
-- Versionen unveränderlich, Schrittprotokoll nur anhängen
GRANT SELECT, INSERT ON {{schema}}.workflow_version, {{schema}}.workflow_step TO {{app}};
REVOKE UPDATE, DELETE ON {{schema}}.workflow_version FROM {{app}};
REVOKE UPDATE ON {{schema}}.workflow_step FROM {{app}};
GRANT EXECUTE ON FUNCTION {{schema}}.workflow_tenant() TO {{app}};

-- Lesesicht der Läufe: Vorgabe «nur Läufe ohne Bezug», bis die App ihre Bezugstypen meldet; bestehende bleibt
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = 'workflow_run' AND policyname = 'subject_read') THEN
    CREATE POLICY subject_read ON {{schema}}.workflow_run AS RESTRICTIVE FOR SELECT TO {{app}}
      USING (current_setting('workflow.engine', true) = 'on' OR subject_type IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = 'workflow_step' AND policyname = 'subject_read') THEN
    CREATE POLICY subject_read ON {{schema}}.workflow_step AS RESTRICTIVE FOR SELECT TO {{app}}
      USING (EXISTS (SELECT 1 FROM {{schema}}.workflow_run r WHERE r.tenant_id = workflow_step.tenant_id AND r.id = workflow_step.run_id));
  END IF;
  -- Zeitpläne im Worker über alle Mandanten, nur mit workflow.sched = on
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = 'workflow_trigger' AND policyname = 'sched_tick') THEN
    CREATE POLICY sched_tick ON {{schema}}.workflow_trigger FOR ALL TO {{sched}}
      USING (current_setting('workflow.sched', true) = 'on') WITH CHECK (current_setting('workflow.sched', true) = 'on');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = 'workflow_settings' AND policyname = 'sched_read') THEN
    CREATE POLICY sched_read ON {{schema}}.workflow_settings FOR SELECT TO {{sched}} USING (current_setting('workflow.sched', true) = 'on');
  END IF;
END $$;
GRANT SELECT, UPDATE ON {{schema}}.workflow_trigger TO {{sched}};
GRANT SELECT ON {{schema}}.workflow_settings TO {{sched}};

-- Bezugstypen melden (nur in Migrationen der App): Lesesicht subject_read der Läufe mit einem Ausdruck je Bezugstyp neu
-- anlegen. Die Tabelle jedes Bezugstyps braucht die Spalten tenant_id und id; ein Lauf ist sichtbar, wenn die Zeile
-- seines Bezugs unter der Lesesicht der App sichtbar ist. Immer alle Bezugstypen übergeben:
--   SELECT {{schema}}.workflow_subjects('{"order": "{{schema}}.sales_order"}');
-- Unbekannte Bezugstypen sind unsichtbar, Läufe ohne Bezug sichtbar (Recht workflow:read prüft die API).
CREATE OR REPLACE FUNCTION {{schema}}.workflow_subjects(p_subjects jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE k text; target regclass; id_type text; branches text := '';
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_subjects) ORDER BY 1 LOOP
    IF k !~ '^[a-z][a-z0-9_.-]{0,79}$' THEN RAISE EXCEPTION 'Ungültiger Bezugstyp: %', k; END IF;
    target := (p_subjects ->> k)::regclass;
    SELECT format_type(a.atttypid, a.atttypmod) INTO id_type FROM pg_attribute a
     WHERE a.attrelid = target AND a.attname = 'id' AND NOT a.attisdropped;
    IF id_type IS NULL THEN RAISE EXCEPTION 'Tabelle % hat keine Spalte id', target; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = target AND a.attname = 'tenant_id' AND NOT a.attisdropped) THEN
      RAISE EXCEPTION 'Tabelle % hat keine Spalte tenant_id', target;
    END IF;
    branches := branches || format(' WHEN %L THEN EXISTS (SELECT 1 FROM %s t WHERE t.tenant_id = workflow_run.tenant_id AND t.id = (workflow_run.subject_id)::%s)', k, target, id_type);
  END LOOP;
  DROP POLICY IF EXISTS subject_read ON {{schema}}.workflow_run;
  EXECUTE format('CREATE POLICY subject_read ON {{schema}}.workflow_run AS RESTRICTIVE FOR SELECT TO {{app}} USING ('
    || 'current_setting(''workflow.engine'', true) = ''on'' OR subject_type IS NULL%s)',
    CASE WHEN branches = '' THEN '' ELSE ' OR CASE subject_type' || branches || ' ELSE false END' END);
END $$;
REVOKE ALL ON FUNCTION {{schema}}.workflow_subjects(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION {{schema}}.workflow_settings_notify() FROM PUBLIC;
