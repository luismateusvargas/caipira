import { useEffect, useId, useRef, useState } from 'react';
import { Archive, CircleCheck, GitBranchPlus, Pencil, Plus, RefreshCw } from 'lucide-react';
import type { ExploreApi, FactAction } from '../../api/client';
import { toApiError } from '../../api/client';
import { FACT_CATEGORIES, isFactCategory } from '../../api/schemas';
import type { Fact, FactCategory } from '../../api/schemas';
import { useRequest } from '../../api/useRequest';
import { FactForm } from './FactForm';
import type { FactDraft } from './FactForm';

/** What a new fact can be anchored to: the graph's current selection. */
export interface FactAnchor {
  label: string;
  evidenceFiles: string[];
  evidenceSymbols: number[];
}

/** Props for {@link KnowledgeBoard}. */
export interface KnowledgeBoardProps {
  api: ExploreApi;
  workspaceId: number;
  /** Bumped when facts change elsewhere. */
  revision: number;
  /** A fact to scroll to and highlight. */
  highlightFactId: number | null;
  /** Offered as the anchor of a new fact. */
  anchor: FactAnchor | null;
  /** Selects a node (`file:…`, `symbol:…`, `fact:…`) in the graph. */
  onJumpTo: (nodeId: string) => void;
  /**
   * Called after any fact was created, edited, reaffirmed, superseded or
   * archived, and after an explicit drift re-check, which rewrites drift state.
   */
  onFactsChanged: () => void;
}

type StateFilter = 'open' | 'needs_review' | 'superseded' | 'all';

const STATE_FILTERS: readonly { value: StateFilter; label: string }[] = [
  { value: 'open', label: 'Standing' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'superseded', label: 'Superseded' },
  { value: 'all', label: 'All' }
];

function isStateFilter(value: string): value is StateFilter {
  return STATE_FILTERS.some(filter => filter.value === value);
}

type Mutation = { status: 'idle' } | { status: 'pending'; factId: number } | { status: 'error'; factId: number; message: string };

/**
 * The second-brain board: standing facts with trust, drift alerts and
 * evidence links into the graph, plus one-click curation.
 */
export function KnowledgeBoard({ api, workspaceId, revision, highlightFactId, anchor, onJumpTo, onFactsChanged }: KnowledgeBoardProps) {
  const id = useId();
  const [category, setCategory] = useState<FactCategory | 'all'>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [anchorNew, setAnchorNew] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [superseding, setSuperseding] = useState<number | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<number | null>(null);
  const [mutation, setMutation] = useState<Mutation>({ status: 'idle' });
  const recheckRef = useRef(false);

  const { state, refreshing, reload } = useRequest(
    `facts:${workspaceId}:${category}:${stateFilter}`,
    async signal => {
      const refresh = recheckRef.current;
      recheckRef.current = false;
      try {
        const data = await api.listFacts({
          workspaceId, refresh,
          category: category === 'all' ? undefined : category,
          state: stateFilter
        }, signal);
        // Only the explicit re-check tells the app: the reload that follows
        // is an ordinary one, so the two cannot keep triggering each other.
        if (refresh) onFactsChanged();
        return data;
      } catch (error) {
        // A re-check that did not finish runs again on the next load, Retry included.
        if (refresh) recheckRef.current = true;
        throw error;
      }
    },
    { revision }
  );

  const facts = state.status === 'ready' ? state.data.facts : [];
  const needle = text.trim().toLowerCase();
  const shown = needle
    ? facts.filter(fact => `${fact.title}\n${fact.summary}\n${fact.body}`.toLowerCase().includes(needle))
    : facts;

  // Scroll the highlighted fact into view once it is rendered.
  useEffect(() => {
    if (highlightFactId === null) return;
    const card = document.getElementById(`${id}-fact-${highlightFactId}`);
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlightFactId, id, state.status]);

  const mutate = async (fact: Fact, change: FactAction) => {
    setMutation({ status: 'pending', factId: fact.id });
    try {
      await api.updateFact(workspaceId, fact.id, change);
      setMutation({ status: 'idle' });
      setEditing(null);
      setSuperseding(null);
      setConfirmArchive(null);
      reload();
      onFactsChanged();
    } catch (error) {
      setMutation({ status: 'error', factId: fact.id, message: toApiError(error).message });
      throw error;
    }
  };

  const create = async (draft: FactDraft) => {
    const anchored = anchorNew && anchor;
    await api.createFact(workspaceId, {
      kind: draft.kind, title: draft.title, body: draft.body, summary: draft.summary || undefined,
      evidenceFiles: anchored ? anchor.evidenceFiles : undefined,
      evidenceSymbols: anchored ? anchor.evidenceSymbols : undefined
    });
    setCreating(false);
    reload();
    onFactsChanged();
  };

  const recheck = () => {
    recheckRef.current = true;
    reload();
  };

  return (
    <section className="board" aria-labelledby={`${id}-title`} aria-busy={state.status === 'loading' || refreshing}>
      <header className="board__header">
        <h2 id={`${id}-title`} className="drawer__title">Knowledge</h2>
        {state.status === 'ready' && state.data.driftCount > 0 && (
          <span className="badge badge--drift" role="status">{state.data.driftCount} NEEDS REVIEW</span>
        )}
        <div className="board__actions">
          <button type="button" className="icon-button" aria-label="Re-check drift" title="Re-check drift" onClick={recheck}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button type="button" className="button button--ghost button--small" onClick={() => setCreating(value => !value)} aria-expanded={creating}>
            <Plus size={13} aria-hidden="true" /> New fact
          </button>
        </div>
      </header>

      <div className="board__filters" role="search">
        <label className="visually-hidden" htmlFor={`${id}-text`}>Filter facts</label>
        <input id={`${id}-text`} type="search" placeholder="Filter facts…" value={text} onChange={event => setText(event.target.value)} />
        <label className="visually-hidden" htmlFor={`${id}-category`}>Category</label>
        <select
          id={`${id}-category`}
          value={category}
          onChange={event => {
            const value = event.target.value;
            if (value === 'all' || isFactCategory(value)) setCategory(value);
          }}
        >
          <option value="all">All kinds</option>
          {FACT_CATEGORIES.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <label className="visually-hidden" htmlFor={`${id}-state`}>State</label>
        <select
          id={`${id}-state`}
          value={stateFilter}
          onChange={event => { if (isStateFilter(event.target.value)) setStateFilter(event.target.value); }}
        >
          {STATE_FILTERS.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
        </select>
      </div>

      {creating && (
        <div className="board__create">
          {anchor && (
            <label className="checkbox">
              <input type="checkbox" checked={anchorNew} onChange={event => setAnchorNew(event.target.checked)} />
              Anchor to {anchor.label}
            </label>
          )}
          <FactForm legend="Record a new fact" submitLabel="Record fact" onSubmit={create} onCancel={() => setCreating(false)} />
        </div>
      )}

      {state.status === 'loading' && <p className="muted" role="status">Loading facts…</p>}
      {state.status === 'error' && (
        <div className="notice notice--error" role="alert">
          <p>{state.error.message}</p>
          <button type="button" className="button button--ghost" onClick={reload}>Retry</button>
        </div>
      )}
      {state.status === 'ready' && shown.length === 0 && (
        <p className="muted">{facts.length === 0 ? 'No facts recorded here yet.' : 'No facts match this filter.'}</p>
      )}

      {shown.length > 0 && (
        <ul className="fact-list" aria-label="Facts">
          {shown.map(fact => (
            <FactCard
              key={fact.id}
              domId={`${id}-fact-${fact.id}`}
              fact={fact}
              highlighted={fact.id === highlightFactId}
              busy={mutation.status === 'pending' && mutation.factId === fact.id}
              error={mutation.status === 'error' && mutation.factId === fact.id ? mutation.message : null}
              editing={editing === fact.id}
              superseding={superseding === fact.id}
              confirmingArchive={confirmArchive === fact.id}
              onJumpTo={onJumpTo}
              onReaffirm={() => void mutate(fact, { action: 'reaffirm' }).catch(() => undefined)}
              onStartEdit={() => { setSuperseding(null); setEditing(fact.id); }}
              onCancelEdit={() => setEditing(null)}
              onEdit={draft => mutate(fact, {
                action: 'update', kind: draft.kind, title: draft.title, body: draft.body, summary: draft.summary || draft.title
              })}
              onStartSupersede={() => { setEditing(null); setSuperseding(fact.id); }}
              onCancelSupersede={() => setSuperseding(null)}
              onSupersede={draft => mutate(fact, {
                action: 'supersede', kind: draft.kind, title: draft.title, body: draft.body, summary: draft.summary || undefined
              })}
              onArchive={() => {
                if (confirmArchive === fact.id) void mutate(fact, { action: 'archive' }).catch(() => undefined);
                else setConfirmArchive(fact.id);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface FactCardProps {
  domId: string;
  fact: Fact;
  highlighted: boolean;
  busy: boolean;
  error: string | null;
  editing: boolean;
  superseding: boolean;
  confirmingArchive: boolean;
  onJumpTo: (nodeId: string) => void;
  onReaffirm: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEdit: (draft: FactDraft) => Promise<void>;
  onStartSupersede: () => void;
  onCancelSupersede: () => void;
  onSupersede: (draft: FactDraft) => Promise<void>;
  onArchive: () => void;
}

function FactCard({
  domId, fact, highlighted, busy, error, editing, superseding, confirmingArchive,
  onJumpTo, onReaffirm, onStartEdit, onCancelEdit, onEdit, onStartSupersede, onCancelSupersede, onSupersede, onArchive
}: FactCardProps) {
  const open = fact.state === 'active' || fact.state === 'needs_review' || fact.state === 'proposed';
  const initial = { kind: fact.kind, title: fact.title, body: fact.body, summary: fact.summary === fact.title ? '' : fact.summary };
  const trust = Math.round(fact.trust * 100);
  // Symbol anchors no check could re-read: trust and each anchor's `current`
  // then describe the last index, not the code as it is now.
  const unchecked = fact.symbols.length > 0 && fact.uncheckedSymbols !== 0;
  const classes = ['fact-card', fact.drifted ? 'fact-card--drifted' : '', highlighted ? 'fact-card--highlighted' : '', open ? '' : 'fact-card--closed'];
  return (
    <li id={domId} className={classes.filter(Boolean).join(' ')}>
      <article aria-labelledby={`${domId}-title`}>
        <div className="fact-card__head">
          <span className={`badge badge--fact badge--${fact.kind}`}>{fact.kind}</span>
          {fact.drifted && <span className="badge badge--drift">NEEDS REVIEW</span>}
          {unchecked && <span className="badge">Evidence not checked</span>}
          {fact.state === 'superseded' && <span className="badge">superseded</span>}
          {fact.state === 'proposed' && <span className="badge">proposed</span>}
          <button type="button" className="fact-card__id" onClick={() => onJumpTo(`fact:${fact.id}`)} aria-label={`Show fact ${fact.id} in the graph`}>
            #{fact.id}
          </button>
        </div>
        <h3 id={`${domId}-title`} className="fact-card__title">{fact.title}</h3>
        {fact.summary !== fact.title && <p className="fact-card__summary">{fact.summary}</p>}

        <div className="trust">
          <span className="small muted" id={`${domId}-trust`}>{unchecked ? 'Trust (unverified)' : 'Trust'}</span>
          <meter min={0} max={1} low={0.4} high={0.75} optimum={1} value={fact.trust} aria-labelledby={`${domId}-trust`}
            aria-valuetext={unchecked ? `${trust}%, unverified` : `${trust}%`} />
          <span className="small">{trust}%</span>
        </div>
        {unchecked && (
          <p className="small muted">
            {fact.uncheckedSymbols === null
              ? 'Its symbol evidence has not been re-read from source, so trust and anchor status reflect the last index.'
              : `${fact.uncheckedSymbols} symbol ${fact.uncheckedSymbols === 1 ? 'anchor' : 'anchors'} could not be re-read from source, so trust and anchor status reflect the last index. Re-check drift to retry.`}
          </p>
        )}

        {(fact.evidence.length > 0 || fact.symbols.length > 0) && (
          <ul className="evidence" aria-label="Evidence">
            {fact.symbols.map(item => {
              const nodeId = item.nodeId;
              return (
                <li key={`symbol:${item.path}::${item.qualifiedName}`}>
                  <button type="button" className="chip chip--symbol" disabled={nodeId === null} onClick={() => { if (nodeId) onJumpTo(nodeId); }}>
                    {item.qualifiedName}
                    {!item.current && <span className="chip__warn"> · changed</span>}
                    {item.current && unchecked && <span> · not checked</span>}
                  </button>
                </li>
              );
            })}
            {fact.evidence.map(item => {
              const nodeId = item.nodeId;
              const range = item.startLine !== null ? `:${item.startLine}-${item.endLine ?? item.startLine}` : '';
              return (
                <li key={`file:${item.path}`}>
                  <button type="button" className="chip" disabled={nodeId === null} onClick={() => { if (nodeId) onJumpTo(nodeId); }}>
                    {item.path}{range}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {fact.supersededBy !== null && (
          <p className="small muted">
            Superseded by{' '}
            <button type="button" className="link-button" onClick={() => onJumpTo(`fact:${fact.supersededBy}`)}>#{fact.supersededBy}</button>
          </p>
        )}

        {error && <p className="field__error" role="alert">{error}</p>}

        <div className="fact-card__actions">
          {open && (
            <button type="button" className={`button button--small ${fact.drifted ? 'button--primary' : 'button--ghost'}`} disabled={busy} onClick={onReaffirm}>
              <CircleCheck size={13} aria-hidden="true" /> Reaffirm<span className="visually-hidden"> {fact.title}</span>
            </button>
          )}
          {open && !editing && !superseding && (
            <button type="button" className="button button--small button--ghost" disabled={busy} onClick={onStartEdit}>
              <Pencil size={13} aria-hidden="true" /> Edit<span className="visually-hidden"> {fact.title}</span>
            </button>
          )}
          {open && !editing && !superseding && (
            <button type="button" className="button button--small button--ghost" disabled={busy} onClick={onStartSupersede}>
              <GitBranchPlus size={13} aria-hidden="true" /> Supersede<span className="visually-hidden"> {fact.title}</span>
            </button>
          )}
          {fact.state !== 'revoked' && (
            <button type="button" className="button button--small button--ghost" disabled={busy} onClick={onArchive}>
              <Archive size={13} aria-hidden="true" /> {confirmingArchive ? 'Confirm archive' : 'Archive'}
              <span className="visually-hidden"> {fact.title}</span>
            </button>
          )}
        </div>

        {editing && (
          <FactForm
            legend={`Edit fact ${fact.id}`}
            submitLabel="Save changes"
            note="Corrects this fact in place; its evidence, state and history stay as they are."
            initial={initial}
            onSubmit={onEdit}
            onCancel={onCancelEdit}
          />
        )}
        {superseding && (
          <FactForm
            legend={`Supersede fact ${fact.id}`}
            submitLabel="Record replacement"
            note="The replacement keeps this fact's evidence; this fact is kept as history and marked superseded."
            initial={initial}
            onSubmit={onSupersede}
            onCancel={onCancelSupersede}
          />
        )}
      </article>
    </li>
  );
}
