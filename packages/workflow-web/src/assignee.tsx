/**
 * Eingaben für Zuständige und Teams (Editor der Schritte, Warteschlangen): Person, Team, Pfad zu einer Person oder
 * Warteschlange. «Zuständig» ist eine einzige Auswahl mit Suche und Gruppen (Personen, Warteschlangen, Teams nach
 * `group` der App, Person aus einem Feld). Teams kommen über `GET /queues/teams` (Port `teams` der App), sonst Typ und
 * ID von Hand (Editor der Warteschlange).
 *
 * Personen wählt man über die Suche der App (`actors.search`), sonst mit ihrer ID; die gewählte Person steht mit
 * ihrem Namen (`ActorName`) da.
 *
 * Regel: Texte ohne Begriffe einer App; was ein Team ist, sagt die Bezeichnung der App.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueues, useTeams } from './api.ts';
import { ActorName, useWorkflow, type WorkflowActor } from './provider.tsx';
import type { ActorRefJson, AssigneeJson, RefJson } from './types.ts';

type Kind = 'actor' | 'team' | 'field' | 'queue';
export const kindOfAssignee = (a: AssigneeJson): Kind => ('actor' in a ? 'actor' : 'team' in a ? 'team' : 'field' in a ? 'field' : 'queue');

/** Team wählen: Suche über die App oder Typ und ID. */
export function TeamInput({ value, onChange, label }: { value: RefJson; onChange: (t: RefJson) => void; label: string }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const [q, setQ] = useState('');
  const teams = useTeams(q, w.can('queue:manage'));
  if (teams.data?.available) {
    const options = teams.data.items;
    const current = `${value.type}\u0000${value.id}`;
    return (
      <div className="wf-field">
        <label htmlFor={`${id}-s`}>{label}</label>
        <div className="wf-row">
          <ui.Input aria-label={`${label}: suchen`} placeholder="suchen …" value={q} onChange={e => setQ(e.target.value)} />
          <ui.Select id={`${id}-s`} value={current} onChange={e => { const [type, tid] = e.target.value.split('\u0000'); onChange({ type: type ?? '', id: tid ?? '' }); }}>
            <option value={'\u0000'}>– wählen –</option>
            {value.id && !options.some(o => o.type === value.type && o.id === value.id) ? <option value={current}>{`${value.type}: ${value.id}`}</option> : null}
            {[...new Set(options.map(o => o.group ?? 'Teams'))].map(g => (
              <optgroup key={g} label={g}>
                {options.filter(o => (o.group ?? 'Teams') === g).map(o => <option key={`${o.type}:${o.id}`} value={`${o.type}\u0000${o.id}`}>{o.label}</option>)}
              </optgroup>
            ))}
          </ui.Select>
        </div>
      </div>
    );
  }
  return (
    <fieldset className="wf-field">
      <legend>{label}</legend>
      <div className="wf-row">
        <ui.Input aria-label={`${label}: Typ`} placeholder="Typ" value={value.type} onChange={e => onChange({ ...value, type: e.target.value })} />
        <ui.Input aria-label={`${label}: ID`} placeholder="ID" value={value.id} onChange={e => onChange({ ...value, id: e.target.value })} />
      </div>
    </fieldset>
  );
}

/** Person wählen: mit der Suche der App (`actors.search`) aus Treffern, sonst mit ihrer ID. */
export function PersonInput({ value, onChange, label }: { value: ActorRefJson; onChange: (a: ActorRefJson) => void; label: string }) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<WorkflowActor[] | null>(null);
  const seq = useRef(0);
  const search = w.actors.search;
  if (!search) {
    return (
      <div className="wf-field">
        <label htmlFor={`${id}-a`}>{`${label}: ID der Person`}</label>
        <ui.Input id={`${id}-a`} value={value.id} onChange={e => onChange({ ...value, id: e.target.value })} />
      </div>
    );
  }
  const find = (text: string) => {
    setQ(text);
    const n = ++seq.current;
    if (text.trim().length < 2) { setHits(null); return; }
    void search(text.trim()).then(r => { if (n === seq.current) setHits(r); }).catch(() => { if (n === seq.current) setHits([]); });
  };
  return (
    <fieldset className="wf-field wf-person">
      <legend>{label}</legend>
      <div className="wf-small">{value.id ? <>Gewählt: <b><ActorName actor={value} /></b></> : <span className="wf-muted">Noch keine Person gewählt.</span>}</div>
      <label htmlFor={`${id}-q`} className="wf-sr">{`${label}: Person suchen`}</label>
      <ui.Input id={`${id}-q`} type="search" placeholder="Person suchen …" value={q} onChange={e => find(e.target.value)} />
      {hits ? (
        hits.length ? (
          <ul className="wf-plain" aria-label={`${label}: Treffer`}>
            {hits.map(h => {
              const on = h.id === value.id && h.kind === value.kind;
              return (
                <li key={`${h.kind}:${h.id}`}>
                  <ui.Button size="sm" variant={on ? 'primary' : 'ghost'} aria-pressed={on}
                    onClick={() => { onChange({ id: h.id, kind: h.kind }); setHits(null); setQ(''); }}><ActorName actor={h} /></ui.Button>
                </li>
              );
            })}
          </ul>
        ) : <p className="wf-muted wf-small">Keine Treffer.</p>
      ) : null}
    </fieldset>
  );
}

/** Eintrag der Auswahl «Zuständig». */
interface AssigneeOption { key: string; group: string; text: ReactNode; value: AssigneeJson }

/**
 * Zuständig: ein Feld mit Suche über Personen (`actors.search`), Warteschlangen und Teams der App (gruppiert nach
 * `group` der App), dazu «Person aus einem Feld». Eine Person, die die Suche findet, erscheint nur als Person, nie
 * zusätzlich als Team. Tastatur: ↓/↑ wählen, Enter übernehmen, Esc schliessen.
 */
export function AssigneeInput({ value, onChange, label, kinds = ['actor', 'team', 'field', 'queue'] }: {
  value: AssigneeJson; onChange: (a: AssigneeJson) => void; label: string; kinds?: Kind[];
}) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActiveState] = useState(0);
  const activeRef = useRef(0);
  const setActive = (i: number) => { activeRef.current = i; setActiveState(i); };
  const [people, setPeople] = useState<WorkflowActor[]>([]);
  const seq = useRef(0);
  const queues = useQueues(kinds.includes('queue'));
  const teams = useTeams(q.trim(), kinds.includes('team') && w.can('queue:manage'));
  const search = kinds.includes('actor') ? w.actors.search : undefined;
  const find = (text: string) => {
    setQ(text);
    setOpen(true);
    setActive(0);
    const n = ++seq.current;
    if (!search || text.trim().length < 2) { setPeople([]); return; }
    void search(text.trim()).then(r => { if (n === seq.current) setPeople(r); }).catch(() => { if (n === seq.current) setPeople([]); });
  };
  const needle = q.trim().toLowerCase();
  const options: AssigneeOption[] = [];
  for (const p of people) options.push({ key: `a:${p.kind}:${p.id}`, group: 'Personen', text: <ActorName actor={p} />, value: { actor: { id: p.id, kind: p.kind } } });
  for (const x of queues.data?.items ?? []) {
    if (!needle || x.name.toLowerCase().includes(needle)) options.push({ key: `q:${x.id}`, group: 'Warteschlangen', text: x.name, value: { queue: x.id } });
  }
  const found = new Set(people.map(p => p.id));
  if (teams.data?.available) {
    for (const t of teams.data.items) {
      if (!found.has(t.id)) options.push({ key: `t:${t.type}:${t.id}`, group: t.group ?? 'Teams', text: t.label, value: { team: { type: t.type, id: t.id } } });
    }
  }
  // Ohne Suche der App: Person über ihre ID (nach den Treffern, damit echte Namen zuerst kommen).
  if (kinds.includes('actor') && !w.actors.search && needle) {
    options.push({ key: 'a:id', group: 'Weitere', text: `Person mit der ID «${q.trim()}»`, value: { actor: { id: q.trim(), kind: 'person' } } });
  }
  if (kinds.includes('field')) options.push({ key: 'f', group: 'Weitere', text: 'Person aus einem Feld …', value: { field: 'subject.values.' } });
  const groups = [...new Set(options.map(o => o.group))];
  const flat = groups.flatMap(g => options.filter(o => o.group === g));
  const pick = (o: AssigneeOption) => { onChange(o.value); setOpen(false); setQ(''); setPeople([]); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Der Zeiger liest den Stand aus der Ref: schnelle Tastenfolgen (↓ Enter) warten nicht auf das nächste Rendern.
    const at = activeRef.current;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(Math.min(flat.length - 1, at + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, at - 1)); }
    else if (e.key === 'Enter' && open && flat[at]) { e.preventDefault(); pick(flat[at]); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };
  const chosen = 'actor' in value ? !!value.actor.id : 'team' in value ? !!value.team.id : 'queue' in value ? !!value.queue : true;
  const listId = `${id}-l`;
  const shown = open && flat.length > 0;
  return (
    <div className="wf-field wf-assignee" role="group" aria-labelledby={`${id}-lb`}>
      <span id={`${id}-lb`} className="wf-label">{label}</span>
      <div className="wf-small">
        {chosen ? <span className="wf-chip">{'actor' in value ? <>Person: <ActorName actor={value.actor} /></> : <AssigneeText value={value} />}</span>
          : <span className="wf-muted">Noch niemand gewählt.</span>}
      </div>
      <div className="wf-combo-wrap">
        <ui.Input id={`${id}-q`} role="combobox" aria-label={`${label}: suchen`} aria-expanded={shown} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={shown && flat[active] ? `${id}-o${active}` : undefined} autoComplete="off"
          placeholder={chosen ? 'Ändern: Person, Team oder Warteschlange suchen …' : 'Person, Team oder Warteschlange suchen …'}
          value={q} onChange={e => find(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey} />
        {shown ? (
          <ul id={listId} role="listbox" className="wf-combo" aria-label={`${label}: Auswahl`}>
            {groups.map(g => (
              <li key={g} role="presentation">
                <div className="wf-combo-group" aria-hidden="true">{g}</div>
                <ul role="group" aria-label={g}>
                  {options.filter(o => o.group === g).map(o => {
                    const i = flat.indexOf(o);
                    return (
                      <li key={o.key} id={`${id}-o${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : undefined}
                        onMouseDown={e => { e.preventDefault(); pick(o); }} onMouseEnter={() => setActive(i)}>{o.text}</li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {'field' in value ? (
        <div className="wf-field">
          <label htmlFor={`${id}-f`}>{`${label}: Pfad`}</label>
          <ui.Input id={`${id}-f`} value={value.field} aria-describedby={`${id}-fh`} onChange={e => onChange({ field: e.target.value })} />
          <span id={`${id}-fh`} className="wf-hint">z. B. subject.values.verantwortlich – liefert eine Person-ID oder eine Liste.</span>
        </div>
      ) : null}
    </div>
  );
}

/** Kurzbeschreibung einer Zuständigkeit als Text (Namen über `queueName` bzw. `teamName`, sonst IDs); ein Team heisst so, wie die App es bezeichnet. */
export function describeAssignee(a: AssigneeJson, queueName?: (id: string) => string | undefined, teamName?: (team: RefJson) => string | undefined): string {
  if ('actor' in a) return a.actor.id || 'Person';
  if ('team' in a) return (a.team.id && teamName?.(a.team)) || `Team ${a.team.id || '…'}`;
  if ('field' in a) return `Person aus ${a.field}`;
  return `Warteschlange ${queueName?.(a.queue) ?? a.queue}`;
}

/** Kurzbeschreibung einer Zuständigkeit mit Namen: Person über `ActorName`, Warteschlange und Team aus den geladenen Listen. */
export function AssigneeText({ value }: { value: AssigneeJson }) {
  const w = useWorkflow();
  const queues = useQueues('queue' in value);
  const teams = useTeams('', 'team' in value && w.can('queue:manage'));
  if ('actor' in value) return value.actor.id ? <ActorName actor={value.actor} /> : <>Person</>;
  const queueName = (qid: string) => queues.data?.items.find(q => q.id === qid)?.name;
  const teamName = (t: RefJson) => (teams.data?.available ? teams.data.items.find(o => o.type === t.type && o.id === t.id)?.label : undefined);
  return <>{describeAssignee(value, queueName, teamName)}</>;
}
