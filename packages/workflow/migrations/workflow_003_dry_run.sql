-- workflow_003 Probelauf vor dem Aktivieren: Prüfsumme des Entwurfs, den zuletzt ein Probelauf erfolgreich durchgespielt
-- hat (nur mit der Option `requireDryRun`), dazu wann und von wem.
--
-- Platzhalter (workflowMigrations): {{schema}} Schema der App, {{app}} Laufzeit-Rolle, {{sched}} Worker-Rolle,
-- {{tenant}} Ausdruck für den Mandanten der Anfrage, {{principal}} Ausdruck für die angemeldete Person.
--
-- Regeln:
-- - Idempotent: legt nur fehlende Spalten an. Sie gehören zur Tabelle `workflow` (RLS, Rechte und Policies wie dort).
-- - Ein Probelauf ändert weder `revision` noch `updated_at`: Sonst stiesse das Speichern des Entwurfs im Editor auf
--   «inzwischen geändert».

ALTER TABLE {{schema}}.workflow ADD COLUMN IF NOT EXISTS dry_run_checksum text;
ALTER TABLE {{schema}}.workflow ADD COLUMN IF NOT EXISTS dry_run_at timestamptz;
ALTER TABLE {{schema}}.workflow ADD COLUMN IF NOT EXISTS dry_run_by_id text;
ALTER TABLE {{schema}}.workflow ADD COLUMN IF NOT EXISTS dry_run_by_kind text;
