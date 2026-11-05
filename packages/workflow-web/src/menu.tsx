/**
 * Menü «Weitere Aktionen» für seltene Aktionen (Editor, Lauf): Gefährliches abgetrennt zuletzt; ↓/↑ wechseln, Esc
 * schliesst; nach der Wahl geht der Fokus an den Menüknopf zurück.
 */
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useWorkflow } from './provider.tsx';

/** Eintrag im Menü; `separator`: Trennlinie davor (z. B. nach den Einträgen der App). */
export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; separator?: boolean }

export function MoreMenu({ items, label = 'Weitere Aktionen' }: { items: MenuItem[]; label?: string }) {
  const { ui } = useWorkflow();
  const id = useId();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const safe = items.filter(x => !x.danger), danger = items.filter(x => x.danger);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: MouseEvent) => { if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const all = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  const entry = (x: MenuItem) => (
    <li key={x.label} role="none">
      <button type="button" role="menuitem" className={x.danger ? 'danger' : undefined} onClick={() => { btn.current?.focus(); setOpen(false); x.onSelect(); }}>{x.label}</button>
    </li>
  );
  return (
    <div className="wf-menu">
      <ui.Button ref={btn} size="sm" variant="ghost" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(o => !o)}><span aria-hidden="true">⋯</span></ui.Button>
      {open ? (
        <ul id={id} ref={list} role="menu" aria-label={label} className="wf-menu-list" onKeyDown={onKey}>
          {safe.map((x, i) => <Fragment key={x.label}>{x.separator && i > 0 ? <li role="separator" className="wf-menu-sep" /> : null}{entry(x)}</Fragment>)}
          {safe.length && danger.length ? <li role="separator" className="wf-menu-sep" /> : null}
          {danger.map(entry)}
        </ul>
      ) : null}
    </div>
  );
}
