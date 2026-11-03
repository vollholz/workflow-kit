/**
 * Formulare aus Beschreibungen: `SchemaForm` erzeugt die Eingabe einer Aktion aus ihrem JSON-Schema (`input` der
 * Aktion in `/workflows/meta`), `FieldForm` das Formular eines manuellen Auslösers aus `FieldDef`-Feldern.
 *
 * Regeln: Beschriftung aus `title` bzw. `label`, Hinweis aus `description`, Pflichtfelder markiert. In Aktionen dürfen
 * Texte und Zahlen Daten (`{{…}}`, als Chip) enthalten (die Engine setzt sie beim Lauf ein); Listen und Angaben in `{…}`
 * werden als JSON bearbeitet. Feldarten der App (`fields` im Provider) ersetzen die eingebaute Eingabe.
 */
import { useId, useState } from 'react';
import { TemplateInput, type ContextField } from './placeholders.tsx';
import { useWorkflow } from './provider.tsx';
import type { FieldDefJson, JsonSchema } from './types.ts';

const typeOf = (p: JsonSchema): string => (Array.isArray(p.type) ? String(p.type.find(t => t !== 'null') ?? 'string') : typeof p.type === 'string' ? p.type : 'string');

/** Eingabe einer Aktion aus ihrem JSON-Schema. */
export function SchemaForm({ schema, value, onChange, fields, disabled }: {
  schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; fields: ContextField[]; disabled?: boolean;
}) {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const entries = Object.entries(properties);
  if (!entries.length) return <p className="wf-muted wf-small">Diese Aktion braucht keine Angaben.</p>;
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === '') delete next[k]; else next[k] = v;
    onChange(next);
  };
  return (
    <div className="wf-form">
      {entries.map(([k, p]) => <SchemaField key={k} name={k} prop={p} required={required.has(k)} value={value[k]} onChange={v => set(k, v)} fields={fields} disabled={disabled} />)}
    </div>
  );
}

function SchemaField({ name, prop, required, value, onChange, fields, disabled }: {
  name: string; prop: JsonSchema; required: boolean; value: unknown; onChange: (v: unknown) => void; fields: ContextField[]; disabled?: boolean;
}) {
  const { ui } = useWorkflow();
  const id = useId();
  const label = typeof prop.title === 'string' ? prop.title : name;
  const hint = typeof prop.description === 'string' ? prop.description : undefined;
  const type = typeOf(prop);
  const [raw, setRaw] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [jsonError, setJsonError] = useState<string | null>(null);
  if (Array.isArray(prop.enum)) {
    return (
      <div className="wf-field">
        <label htmlFor={id}>{label}{required ? <span className="wf-req" aria-hidden="true"> *</span> : null}</label>
        <ui.Select id={id} value={value === undefined ? '' : String(value)} required={required} disabled={disabled} onChange={e => onChange(e.target.value || undefined)}>
          <option value="">– wählen –</option>
          {(prop.enum as unknown[]).map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
        </ui.Select>
        {hint ? <div className="wf-hint">{hint}</div> : null}
      </div>
    );
  }
  if (type === 'boolean') {
    return (
      <div className="wf-field wf-check-row">
        <ui.Input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={e => onChange(e.target.checked)} />
        <label htmlFor={id}>{label}</label>
        {hint ? <div className="wf-hint">{hint}</div> : null}
      </div>
    );
  }
  if (type === 'object' || type === 'array') {
    return (
      <div className="wf-field">
        <label htmlFor={id}>{label}{required ? <span className="wf-req" aria-hidden="true"> *</span> : null} <span className="wf-muted wf-small">(JSON)</span></label>
        <ui.Textarea id={id} rows={4} value={raw} disabled={disabled} aria-invalid={!!jsonError} aria-describedby={jsonError ? `${id}-err` : undefined}
          onChange={e => setRaw(e.target.value)}
          onBlur={() => {
            if (!raw.trim()) { setJsonError(null); onChange(undefined); return; }
            try { onChange(JSON.parse(raw)); setJsonError(null); } catch { setJsonError('Kein gültiges JSON.'); }
          }} />
        {jsonError ? <div id={`${id}-err`} className="wf-field-error" role="alert">{jsonError}</div> : hint ? <div className="wf-hint">{hint}</div> : null}
      </div>
    );
  }
  const numeric = type === 'number' || type === 'integer';
  return (
    <TemplateInput label={label} required={required} disabled={disabled} fields={fields}
      hint={[hint, numeric ? 'Zahl oder Daten' : null].filter(Boolean).join(' · ') || undefined}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={v => onChange(numeric && v.trim() !== '' && !v.includes('{{') && !Number.isNaN(Number(v)) ? Number(v) : v)} />
  );
}

/** Formular aus Feldern (manueller Auslöser): eingebaute Feldarten und die der App. */
export function FieldForm({ fields, value, onChange, disabled }: {
  fields: FieldDefJson[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; disabled?: boolean;
}) {
  return (
    <div className="wf-form">
      {fields.map(f => <FormField key={f.key} def={f} value={value[f.key]} disabled={disabled} onChange={v => onChange({ ...value, [f.key]: v })} />)}
    </div>
  );
}

function FormField({ def, value, onChange, disabled }: { def: FieldDefJson; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const custom = w.fields[def.type];
  const label = <label htmlFor={id}>{def.label}{def.required ? <span className="wf-req" aria-hidden="true"> *</span> : null}</label>;
  const hint = def.description ? <div className="wf-hint">{def.description}</div> : null;
  if (custom) return <div className="wf-field">{label}<custom.Input id={id} value={value} onChange={onChange} disabled={disabled} />{hint}</div>;
  if (def.type === 'boolean') {
    return <div className="wf-field wf-check-row"><ui.Input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={e => onChange(e.target.checked)} />{label}{hint}</div>;
  }
  if (def.type === 'choice' && def.options?.length) {
    return (
      <div className="wf-field">{label}
        <ui.Select id={id} value={value === undefined ? '' : String(value)} required={def.required} disabled={disabled} onChange={e => onChange(e.target.value || undefined)}>
          <option value="">– wählen –</option>
          {def.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </ui.Select>{hint}
      </div>
    );
  }
  const type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text';
  return (
    <div className="wf-field">{label}
      <ui.Input id={id} type={type} value={value === undefined || value === null ? '' : String(value)} required={def.required} disabled={disabled}
        onChange={e => onChange(type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)} />{hint}
    </div>
  );
}

/** Fehlende Pflichtfelder (Bezeichnungen) eines Formulars. */
export const missingRequired = (fields: FieldDefJson[], value: Record<string, unknown>) =>
  fields.filter(f => f.required && (value[f.key] === undefined || value[f.key] === null || value[f.key] === '')).map(f => f.label);
