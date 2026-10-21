import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { FileCode2, Lightbulb, Search, SquareFunction, X } from 'lucide-react';
import type { ExploreApi } from '../../api/client';
import { useRequest } from '../../api/useRequest';

/** What the user chose from the search results. */
export type SearchPick =
  | { type: 'symbol'; symbolId: number }
  | { type: 'file'; path: string }
  | { type: 'fact'; factId: number };

/** Props for {@link OmniSearchModal}. */
export interface OmniSearchModalProps {
  open: boolean;
  api: ExploreApi;
  workspaceId: number;
  onPick: (pick: SearchPick) => void;
  onClose: () => void;
}

interface Result {
  key: string;
  group: 'Symbols' | 'Files' | 'Facts';
  title: string;
  detail: string;
  pick: SearchPick;
}

const DEBOUNCE_MS = 160;

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The Ctrl+K / Cmd+K search dialog: symbols by name, parameter type or return
 * type, files by path, and facts by text. Arrow keys move, Enter opens,
 * Escape closes.
 */
export function OmniSearchModal(props: OmniSearchModalProps) {
  if (!props.open) return null;
  return <OmniSearchDialog {...props} />;
}

function OmniSearchDialog({ api, workspaceId, onPick, onClose }: OmniSearchModalProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const term = useDebouncedValue(query.trim(), DEBOUNCE_MS);

  const { state } = useRequest(
    term ? `omni:${workspaceId}:${term}` : null,
    async signal => {
      const [symbols, facts] = await Promise.all([
        api.searchSymbols(workspaceId, term, signal),
        term.length >= 2 ? api.listFacts({ workspaceId, query: term, state: 'all' }, signal) : Promise.resolve(null)
      ]);
      const results: Result[] = [
        ...symbols.symbols.map((symbol): Result => ({
          key: `symbol:${symbol.id}`, group: 'Symbols', title: symbol.qualifiedName,
          detail: `${symbol.kind} · ${symbol.signatureText} · ${symbol.path}:${symbol.startLine}`,
          pick: { type: 'symbol', symbolId: symbol.id }
        })),
        ...symbols.files.map((file): Result => ({
          key: `file:${file.path}`, group: 'Files', title: file.path, detail: file.language,
          pick: { type: 'file', path: file.path }
        })),
        ...(facts?.facts ?? []).map((fact): Result => ({
          key: `fact:${fact.id}`, group: 'Facts', title: fact.title,
          detail: `${fact.kind}${fact.drifted ? ' · NEEDS REVIEW' : ''} · ${fact.summary}`,
          pick: { type: 'fact', factId: fact.id }
        }))
      ];
      return results;
    },
    { isEmpty: results => results.length === 0 }
  );

  const results = state.status === 'ready' ? state.data : [];
  const activeIndex = Math.max(0, results.findIndex(result => result.key === activeKey));
  const active = results[activeIndex];

  // Focus returns to whatever opened the dialog.
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const choose = (result: Result) => {
    onPick(result.pick);
    onClose();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = results[(activeIndex + step + results.length) % results.length];
      if (next) setActiveKey(next.key);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active) choose(active);
    }
  };

  // Escape closes; Tab stays inside the dialog.
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const listId = `${id}-results`;
  const optionId = (result: Result) => `${id}-option-${result.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  let lastGroup: Result['group'] | null = null;

  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="omni"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={onDialogKeyDown}
      >
        <h2 id={`${id}-title`} className="visually-hidden">Search the workspace</h2>
        <div className="omni__bar">
          <Search size={16} aria-hidden="true" />
          <input
            className="omni__input"
            type="text"
            role="combobox"
            aria-label="Search symbols, files and facts"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            placeholder="Symbols by name, parameter or return type · files · facts"
            autoFocus
            value={query}
            onChange={event => { setQuery(event.target.value); setActiveKey(null); }}
            onKeyDown={onInputKeyDown}
          />
          <button type="button" className="icon-button" aria-label="Close search" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="omni__status" role="status" aria-live="polite">
          {!term && 'Type to search. Use ↑ ↓ to move, Enter to open, Esc to close.'}
          {term && state.status === 'loading' && 'Searching…'}
          {term && state.status === 'empty' && `Nothing matches “${term}”.`}
          {term && state.status === 'error' && state.error.message}
          {term && state.status === 'ready' && `${results.length} result${results.length === 1 ? '' : 's'}`}
        </div>

        <ul id={listId} className="omni__results" role="listbox" aria-label="Search results">
          {results.map(result => {
            const heading = result.group !== lastGroup ? result.group : null;
            lastGroup = result.group;
            const selected = result.key === active?.key;
            return (
              <li
                key={result.key}
                id={optionId(result)}
                role="option"
                aria-selected={selected}
                className={`omni__option${selected ? ' omni__option--active' : ''}`}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActiveKey(result.key)}
                onClick={() => choose(result)}
              >
                {heading && <span className="omni__group" aria-hidden="true">{heading}</span>}
                <span className="omni__row">
                  {result.group === 'Symbols' && <SquareFunction size={14} aria-hidden="true" />}
                  {result.group === 'Files' && <FileCode2 size={14} aria-hidden="true" />}
                  {result.group === 'Facts' && <Lightbulb size={14} aria-hidden="true" />}
                  <span className="omni__title">{result.title}</span>
                </span>
                <span className="omni__detail">{result.detail}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
