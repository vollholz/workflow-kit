/**
 * Eingaben für Zuständige und Teams (Editor der Schritte, Warteschlangen): Person, Team, Pfad zu einer Person oder
 * Warteschlange. Teams wählt man über `GET /queues/teams` (Port `teams` der App), sonst Typ und ID von Hand.
 *
 * Personen wählt man über die Suche der App (`actors.search`), sonst mit ihrer ID; die gewählte Person steht mit
 * ihrem Namen (`ActorName`) da.
 *
 * Regel: Texte ohne Begriffe einer App; was ein Team ist, sagt die Bezeichnung der App.
 */
import { useId, useRef, useState } from 'react';
import { useQueues, useTeams } from './api.ts';
import { ActorName, useWorkflow, type WorkflowActor } from './provider.tsx';
import type { ActorRefJson, AssigneeJson, RefJson } from './types.ts';

type Kind = 'actor' | 'team' | 'field' | 'queue';
const KIND_LABEL: Record<Kind, string> = { actor: 'Person', team: 'Team', field: 'Person aus einem Feld', queue: 'Warteschlange' };
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
            {options.map(o => <option key={`${o.type}:${o.id}`} value={`${o.type}\u0000${o.id}`}>{o.label}</option>)}
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

/** Zuständig: Art wählen, dann die passende Angabe. */
export function AssigneeInput({ value, onChange, label, kinds = ['actor', 'team', 'field', 'queue'] }: {
  value: AssigneeJson; onChange: (a: AssigneeJson) => void; label: string; kinds?: Kind[];
}) {
  const w = useWorkflow();
  const { ui } = w;
  const id = useId();
  const kind = kindOfAssignee(value);
  const queues = useQueues(kinds.includes('queue'));
  const change = (k: Kind) => onChange(
    k === 'actor' ? { actor: { id: w.me?.id ?? '', kind: 'person' } } : k === 'team' ? { team: { type: '', id: '' } } : k === 'field' ? { field: 'subject.values.' } : { queue: queues.data?.items[0]?.id ?? '' },
  );
  return (
    <div className="wf-assignee">
      <div className="wf-field">
        <label htmlFor={`${id}-k`}>{label}</label>
        <ui.Select id={`${id}-k`} value={kind} onChange={e => change(e.target.value as Kind)}>
          {kinds.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </ui.Select>
      </div>
      {'actor' in value ? <PersonInput label={label} value={value.actor} onChange={actor => onChange({ actor })} /> : null}
      {'team' in value ? <TeamInput label={`${label}: Team`} value={value.team} onChange={team => onChange({ team })} /> : null}
      {'field' in value ? (
        <div className="wf-field">
          <label htmlFor={`${id}-f`}>{`${label}: Pfad`}</label>
          <ui.Input id={`${id}-f`} value={value.field} aria-describedby={`${id}-fh`} onChange={e => onChange({ field: e.target.value })} />
          <span id={`${id}-fh`} className="wf-hint">z. B. subject.values.verantwortlich – liefert eine Person-ID oder eine Liste.</span>
        </div>
      ) : null}
      {'queue' in value ? (
        <div className="wf-field">
          <label htmlFor={`${id}-q`}>{`${label}: Warteschlange`}</label>
          <ui.Select id={`${id}-q`} value={value.queue} onChange={e => onChange({ queue: e.target.value })}>
            <option value="">– wählen –</option>
            {value.queue && !queues.data?.items.some(q => q.id === value.queue) ? <option value={value.queue}>{value.queue}</option> : null}
            {(queues.data?.items ?? []).map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
          </ui.Select>
        </div>
      ) : null}
    </div>
  );
}

/** Kurzbeschreibung einer Zuständigkeit als Text (Namen über `queueName` bzw. `teamName`, sonst IDs). */
export function describeAssignee(a: AssigneeJson, queueName?: (id: string) => string | undefined, teamName?: (team: RefJson) => string | undefined): string {
  if ('actor' in a) return a.actor.id || 'Person';
  if ('team' in a) return `Team ${(a.team.id && teamName?.(a.team)) || a.team.id || '…'}`;
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
