/**
 * Bedingungen als Baukasten in Klartext (Konzept 4.3, W5): Gruppen «alle» (und) bzw. «mindestens eine» (oder), darin
 * Vergleiche «Feld – Vergleich – Wert», verschachtelte Gruppen und «nicht». Kein freier Ausdruck, keine Skripte.
 *
 * Regeln: Felder mit Bezeichnung aus dem Kontext (`ContextField`), ein anderer Pfad lässt sich eintippen. Werte
 * passend zur Feldart (Zahl, Ja/Nein, Auswahl, Liste bei «ist einer von»); Text darf Platzhalter enthalten.
 * `describeCondition` liefert dieselbe Bedingung als Satz für Kopfzeilen und Zusammenfassungen.
 */
import { useId } from 'react';
import { labelOf, type ContextField } from './placeholders.tsx';
import { useWorkflow } from './provider.tsx';
import type { Condition, ConditionOp, FieldCondition } from './types.ts';

export const OP_LABEL: Record<ConditionOp, string> = {
  eq: 'ist gleich', ne: 'ist nicht', gt: 'ist grösser als', gte: 'ist mindestens', lt: 'ist kleiner als', lte: 'ist höchstens',
  in: 'ist einer von', notIn: 'ist keiner von', contains: 'enthält', notContains: 'enthält nicht', startsWith: 'beginnt mit',
  endsWith: 'endet mit', isSet: 'ist gesetzt', isNotSet: 'ist leer',
};
const UNARY: ConditionOp[] = ['isSet', 'isNotSet'];
const LIST: ConditionOp[] = ['in', 'notIn'];

const isField = (c: Condition): c is FieldCondition => 'field' in c;
const fmtValue = (v: unknown) => (Array.isArray(v) ? v.map(x => `«${String(x)}»`).join(', ') : typeof v === 'boolean' ? (v ? 'ja' : 'nein') : `«${String(v ?? '')}»`);

/** Bedingung als Satz, z. B. «Betrag» ist grösser als «100» und «Zustand» ist gleich «bezahlt». */
export function describeCondition(c: Condition | undefined, fields: ContextField[]): string {
  if (!c) return 'immer';
  if (isField(c)) {
    const f = fields.find(x => x.path === c.field);
    const name = f ? f.label : c.field;
    const opt = f?.field?.options?.find(o => o.value === c.value)?.label;
    return `«${name}» ${OP_LABEL[c.op] ?? c.op}${UNARY.includes(c.op) ? '' : ` ${opt ? `«${opt}»` : fmtValue(c.value)}`}`;
  }
  if ('not' in c) return `nicht (${describeCondition(c.not, fields)})`;
  const list = 'all' in c ? c.all : c.any;
  const parts = list.map(x => (isField(x) ? describeCondition(x, fields) : `(${describeCondition(x, fields)})`));
  return parts.join('all' in c ? ' und ' : ' oder ');
}

const newRow = (fields: ContextField[]): FieldCondition => ({ field: fields[0]?.path ?? '', op: 'eq', value: '' });

/** Bedingung bearbeiten; ohne Bedingung zeigt der Baustein einen Knopf zum Anlegen. */
export function ConditionBuilder({ value, onChange, fields, label, disabled, optional }: {
  value: Condition | undefined; onChange: (c: Condition | undefined) => void; fields: ContextField[]; label: string; disabled?: boolean; optional?: boolean;
}) {
  const { ui } = useWorkflow();
  if (!value) {
    return (
      <div className="wf-cond-empty">
        <span className="wf-muted">{optional ? 'Kein Filter: jedes Ereignis dieser Art zählt.' : 'Noch keine Bedingung.'}</span>
        {!disabled ? <ui.Button size="sm" onClick={() => onChange({ all: [newRow(fields)] })}>{optional ? 'Filter hinzufügen' : 'Bedingung hinzufügen'}</ui.Button> : null}
      </div>
    );
  }
  const root = isField(value) ? { all: [value] } : value;
  return (
    <fieldset className="wf-cond" aria-label={label} disabled={disabled}>
      <Node cond={root} fields={fields} path={label} onChange={c => onChange(c)} onRemove={optional ? () => onChange(undefined) : undefined} />
      <p className="wf-hint" aria-live="polite">{describeCondition(root, fields)}</p>
    </fieldset>
  );
}

function Node({ cond, fields, onChange, onRemove, path }: {
  cond: Condition; fields: ContextField[]; onChange: (c: Condition) => void; onRemove?: () => void; path: string;
}) {
  const { ui } = useWorkflow();
  const id = useId();
  if (isField(cond)) return <Row cond={cond} fields={fields} onChange={onChange} onRemove={onRemove} path={path} />;
  if ('not' in cond) {
    return (
      <div className="wf-cond-not">
        <span className="wf-cond-tag">nicht</span>
        <Node cond={cond.not} fields={fields} path={`${path}, nicht`} onChange={c => onChange({ not: c })} onRemove={onRemove} />
      </div>
    );
  }
  const mode: 'all' | 'any' = 'all' in cond ? 'all' : 'any';
  const items = 'all' in cond ? cond.all : cond.any;
  const set = (list: Condition[]) => onChange(mode === 'all' ? { all: list } : { any: list });
  return (
    <div className="wf-cond-group" role="group" aria-label={path}>
      <div className="wf-row">
        <label htmlFor={id} className="wf-small">Zutreffen müssen</label>
        <ui.Select id={id} value={mode} onChange={e => onChange(e.target.value === 'all' ? { all: items } : { any: items })}>
          <option value="all">alle (und)</option>
          <option value="any">mindestens eine (oder)</option>
        </ui.Select>
        {onRemove ? <ui.Button size="sm" variant="ghost" onClick={onRemove} aria-label={`${path} entfernen`}>Entfernen</ui.Button> : null}
      </div>
      <ol className="wf-cond-list">
        {items.map((c, i) => (
          <li key={i}>
            <Node cond={c} fields={fields} path={`${path}, Teil ${i + 1}`}
              onChange={n => set(items.map((x, j) => (j === i ? n : x)))}
              onRemove={items.length > 1 || onRemove ? () => (items.length > 1 ? set(items.filter((_, j) => j !== i)) : onRemove?.()) : undefined} />
          </li>
        ))}
      </ol>
      <div className="wf-row">
        <ui.Button size="sm" onClick={() => set([...items, newRow(fields)])}>Vergleich hinzufügen</ui.Button>
        <ui.Button size="sm" variant="ghost" onClick={() => set([...items, { any: [newRow(fields)] }])}>Gruppe hinzufügen</ui.Button>
      </div>
    </div>
  );
}

function Row({ cond, fields, onChange, onRemove, path }: { cond: FieldCondition; fields: ContextField[]; onChange: (c: Condition) => void; onRemove?: () => void; path: string }) {
  const { ui } = useWorkflow();
  const id = useId();
  const known = fields.find(f => f.path === cond.field);
  const groups = [...new Set(fields.map(f => f.group))];
  const def = known?.field;
  const unary = UNARY.includes(cond.op);
  const list = LIST.includes(cond.op);
  const setValue = (raw: string) => {
    if (list) { onChange({ ...cond, value: raw.split(',').map(s => s.trim()).filter(Boolean) }); return; }
    if (def?.type === 'number' && raw.trim() !== '' && !raw.includes('{{') && !Number.isNaN(Number(raw))) { onChange({ ...cond, value: Number(raw) }); return; }
    onChange({ ...cond, value: raw });
  };
  const setOp = (op: ConditionOp) => {
    const next: FieldCondition = { field: cond.field, op };
    if (!UNARY.includes(op)) next.value = LIST.includes(op) ? (Array.isArray(cond.value) ? cond.value : cond.value ? [cond.value] : []) : Array.isArray(cond.value) ? (cond.value[0] ?? '') : (cond.value ?? '');
    onChange(next);
  };
  const shown = Array.isArray(cond.value) ? cond.value.join(', ') : cond.value === undefined || cond.value === null ? '' : String(cond.value);
  return (
    <div className="wf-cond-row" role="group" aria-label={path}>
      <label className="wf-sr" htmlFor={`${id}-f`}>{`${path}: Feld`}</label>
      <ui.Select id={`${id}-f`} value={known ? cond.field : '__other'} onChange={e => onChange({ ...cond, field: e.target.value === '__other' ? '' : e.target.value })}>
        {groups.map(g => (
          <optgroup key={g} label={g}>
            {fields.filter(f => f.group === g).map(f => <option key={f.path} value={f.path}>{f.label}</option>)}
          </optgroup>
        ))}
        <option value="__other">Anderer Pfad …</option>
      </ui.Select>
      {!known ? (
        <>
          <label className="wf-sr" htmlFor={`${id}-p`}>{`${path}: Pfad`}</label>
          <ui.Input id={`${id}-p`} value={cond.field} placeholder="z. B. event.data.wert" onChange={e => onChange({ ...cond, field: e.target.value })} />
        </>
      ) : null}
      <label className="wf-sr" htmlFor={`${id}-o`}>{`${path}: Vergleich`}</label>
      <ui.Select id={`${id}-o`} value={cond.op} onChange={e => setOp(e.target.value as ConditionOp)}>
        {(Object.keys(OP_LABEL) as ConditionOp[]).map(op => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
      </ui.Select>
      {unary ? null : (
        <>
          <label className="wf-sr" htmlFor={`${id}-v`}>{`${path}: Wert`}</label>
          {def?.type === 'boolean' && !list ? (
            <ui.Select id={`${id}-v`} value={String(cond.value)} onChange={e => onChange({ ...cond, value: e.target.value === 'true' })}>
              <option value="true">ja</option>
              <option value="false">nein</option>
            </ui.Select>
          ) : def?.options?.length && !list ? (
            <ui.Select id={`${id}-v`} value={shown} onChange={e => onChange({ ...cond, value: e.target.value })}>
              <option value="">– wählen –</option>
              {def.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </ui.Select>
          ) : (
            <ui.Input id={`${id}-v`} value={shown} placeholder={list ? 'Werte mit Komma getrennt' : def?.type === 'date' ? 'z. B. 2026-12-31 oder {{now}}' : 'Wert'}
              inputMode={def?.type === 'number' ? 'decimal' : undefined} onChange={e => setValue(e.target.value)} />
          )}
        </>
      )}
      {onRemove ? <ui.Button size="sm" variant="ghost" onClick={onRemove} aria-label={`${path} entfernen`}>✕</ui.Button> : null}
      {!known && cond.field ? <span className="wf-hint">{labelOf(fields, cond.field)}</span> : null}
    </div>
  );
}
