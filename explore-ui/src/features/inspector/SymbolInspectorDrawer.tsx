import { useState } from 'react';
import { CircleCheck, Crosshair, Plus, X } from 'lucide-react';
import type { ExploreApi } from '../../api/client';
import { toApiError } from '../../api/client';
import type { AttachedFact, SourcePreview, SymbolDetail, SymbolRef } from '../../api/schemas';
import { useRequest } from '../../api/useRequest';
import { FactForm } from '../knowledge/FactForm';
import type { FactDraft } from '../knowledge/FactForm';

/** Props for {@link SymbolInspectorDrawer}. */
export interface SymbolInspectorDrawerProps {
  api: ExploreApi;
  workspaceId: number;
  symbolId: number;
  /** Bumped when facts change elsewhere, to reload without a flash. */
  revision: number;
  /** Whether the graph is focused on this symbol's blast radius, and how far. */
  blastRadius: { active: boolean; depth: number };
  onBlastRadiusChange: (active: boolean, depth: number) => void;
  /** Opens another symbol in the inspector. */
  onSelectSymbol: (symbolId: number) => void;
  /** Called after this drawer created or reaffirmed a fact. */
  onFactsChanged: () => void;
  onClose: () => void;
}

type Mutation = { status: 'idle' } | { status: 'pending'; label: string } | { status: 'error'; message: string };

const SOURCE_UNAVAILABLE: Record<string, string> = {
  missing: 'The file is no longer on disk. Reindex to refresh the symbol table.',
  not_a_file: 'The indexed path is not a regular file.',
  too_large: 'The file is too large to preview.',
  no_root: 'This workspace has no root directory to read from.'
};

/**
 * The side inspector for one symbol: what it receives and returns, its
 * docstring and source, who calls it and what it calls, the types it is
 * connected to, and the facts anchored to it or its file.
 */
export function SymbolInspectorDrawer(props: SymbolInspectorDrawerProps) {
  const { api, workspaceId, symbolId, revision, onClose } = props;
  const { state, refreshing, reload } = useRequest(
    `symbol:${workspaceId}:${symbolId}`,
    signal => api.getSymbol(workspaceId, symbolId, signal),
    { revision }
  );

  return (
    <aside className="drawer" aria-labelledby="inspector-title" aria-busy={state.status === 'loading' || refreshing}>
      <header className="drawer__header">
        <h2 id="inspector-title" className="drawer__title">Symbol inspector</h2>
        <button type="button" className="icon-button" aria-label="Close inspector" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {state.status === 'loading' && <p className="muted" role="status">Loading symbol…</p>}
      {state.status === 'empty' && <p className="muted">Nothing is indexed for this symbol.</p>}
      {state.status === 'error' && (
        <div className="notice notice--error" role="alert">
          <p>{state.error.status === 404 ? 'This symbol is no longer in the index. Reindex the workspace and try again.' : state.error.message}</p>
          <button type="button" className="button button--ghost" onClick={reload}>Retry</button>
        </div>
      )}
      {state.status === 'ready' && <SymbolBody {...props} detail={state.data} reload={reload} />}
    </aside>
  );
}

function SymbolBody({ api, workspaceId, symbolId, detail, blastRadius, onBlastRadiusChange, onSelectSymbol, onFactsChanged, reload }:
  SymbolInspectorDrawerProps & { detail: SymbolDetail; reload: () => void }) {
  const { symbol } = detail;
  const [attaching, setAttaching] = useState(false);
  const [mutation, setMutation] = useState<Mutation>({ status: 'idle' });

  const attach = async (draft: FactDraft) => {
    await api.createFact(workspaceId, {
      kind: draft.kind, title: draft.title, body: draft.body,
      summary: draft.summary || undefined, evidenceSymbols: [symbolId]
    });
    setAttaching(false);
    reload();
    onFactsChanged();
  };

  const reaffirm = async (fact: AttachedFact) => {
    setMutation({ status: 'pending', label: `Reaffirming “${fact.title}”…` });
    try {
      await api.updateFact(workspaceId, fact.factId, { action: 'reaffirm' });
      setMutation({ status: 'idle' });
      reload();
      onFactsChanged();
    } catch (error) {
      setMutation({ status: 'error', message: toApiError(error).message });
    }
  };

  return (
    <div className="drawer__body">
      <section className="inspector-head" aria-label="Signature">
        <code className="signature">{symbol.signatureText}</code>
        <div className="badges">
          {detail.language && <span className="badge badge--language">{detail.language}</span>}
          <span className="badge">{symbol.kind}</span>
          <span className={`badge ${symbol.isPublic ? 'badge--public' : 'badge--private'}`}>{symbol.isPublic ? 'public' : 'private'}</span>
        </div>
        <p className="location"><span className="visually-hidden">Location: </span>{symbol.path}:{symbol.startLine}</p>
      </section>

      <section aria-labelledby="receives-title" className="inspector-section">
        <h3 id="receives-title">Receives</h3>
        {symbol.params.length === 0 ? (
          <p className="muted">No parameters.</p>
        ) : (
          <table className="params" aria-labelledby="receives-title">
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Default</th></tr>
            </thead>
            <tbody>
              {symbol.params.map((param, index) => (
                <tr key={`${index}:${param.name}`}>
                  <td><code>{param.name}</code></td>
                  <td>{param.typeAnnotation ? <TypeText text={param.typeAnnotation} links={detail.typeLinks} onSelect={onSelectSymbol} /> : <span className="muted">—</span>}</td>
                  <td>{param.defaultValue ? <code>{param.defaultValue}</code> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="returns-title" className="inspector-section">
        <h3 id="returns-title">Returns</h3>
        <span className="badge badge--return">
          {symbol.returnType ? <TypeText text={symbol.returnType} links={detail.typeLinks} onSelect={onSelectSymbol} /> : 'void / inferred'}
        </span>
      </section>

      <section aria-labelledby="doc-title" className="inspector-section">
        <h3 id="doc-title">Docstring</h3>
        {symbol.docSummary ? <p className="doc">{symbol.docSummary}</p> : <p className="muted">No docstring.</p>}
      </section>

      <SourceSection source={detail.source} />

      <section aria-labelledby="calls-title" className="inspector-section">
        <div className="section-head">
          <h3 id="calls-title">Callers &amp; Callees</h3>
          <div className="blast-controls">
            <button
              type="button"
              className="pill pill--small"
              aria-pressed={blastRadius.active}
              onClick={() => onBlastRadiusChange(!blastRadius.active, blastRadius.depth)}
            >
              <Crosshair size={13} aria-hidden="true" /> Focus Blast Radius
            </button>
            <label className="visually-hidden" htmlFor="blast-depth">Blast radius depth</label>
            <select
              id="blast-depth"
              value={blastRadius.depth}
              onChange={event => onBlastRadiusChange(blastRadius.active, Number(event.target.value))}
            >
              {[1, 2, 3, 4].map(depth => <option key={depth} value={depth}>{depth} hop{depth === 1 ? '' : 's'}</option>)}
            </select>
          </div>
        </div>
        <RefList title="Callers" refs={detail.callers} empty="No callers found." onSelect={onSelectSymbol} />
        <RefList title="Callees" refs={detail.callees} empty="Calls nothing indexed." onSelect={onSelectSymbol} />
      </section>

      <section aria-labelledby="types-title" className="inspector-section">
        <h3 id="types-title">Type References</h3>
        <RefList title="Uses and extends" refs={detail.typeReferences} empty="No type references." onSelect={onSelectSymbol} />
        <RefList title="Used by" refs={detail.typeDependents} empty="Nothing uses this type." onSelect={onSelectSymbol} />
      </section>

      <section aria-labelledby="facts-title" className="inspector-section">
        <div className="section-head">
          <h3 id="facts-title">Attached Facts</h3>
          {!attaching && (
            <button type="button" className="button button--ghost button--small" onClick={() => setAttaching(true)}>
              <Plus size={13} aria-hidden="true" /> Attach Fact
            </button>
          )}
        </div>
        {attaching && (
          <FactForm
            legend="Attach a fact to this symbol"
            submitLabel="Attach fact"
            note={`Anchored to ${symbol.path}::${symbol.qualifiedName}; it drifts when this signature changes.`}
            onSubmit={attach}
            onCancel={() => setAttaching(false)}
          />
        )}
        {mutation.status === 'pending' && <p className="muted" role="status">{mutation.label}</p>}
        {mutation.status === 'error' && <p className="field__error" role="alert">{mutation.message}</p>}
        {detail.facts.length === 0 ? (
          <p className="muted">No facts are anchored to this symbol or its file.</p>
        ) : (
          <ul className="attached-facts">
            {detail.facts.map(fact => {
              const drifted = fact.state === 'needs_review' || fact.anchor === 'drifted';
              return (
                <li key={fact.factId} className={`attached-fact${drifted ? ' attached-fact--drifted' : ''}`}>
                  <div className="attached-fact__head">
                    <span className={`badge badge--fact badge--${fact.category}`}>{fact.category}</span>
                    {drifted && <span className="badge badge--drift">NEEDS REVIEW</span>}
                    <span className="muted small">{anchorLabel(fact.anchor)}</span>
                  </div>
                  <p className="attached-fact__title">{fact.title}</p>
                  {fact.summary !== fact.title && <p className="small muted">{fact.summary}</p>}
                  <button
                    type="button"
                    className={`button button--small ${drifted ? 'button--primary' : 'button--ghost'}`}
                    disabled={mutation.status === 'pending'}
                    onClick={() => void reaffirm(fact)}
                  >
                    <CircleCheck size={13} aria-hidden="true" /> Reaffirm
                    <span className="visually-hidden"> fact {fact.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function anchorLabel(anchor: AttachedFact['anchor']): string {
  switch (anchor) {
    case 'current': return 'anchored to this signature';
    case 'drifted': return 'signature changed since recorded';
    case 'file_range': return 'covers these lines';
    case 'file': return 'anchored to this file';
  }
}

/**
 * A type annotation whose identifiers that name a workspace type become links.
 */
function TypeText({ text, links, onSelect }: { text: string; links: Record<string, number>; onSelect: (symbolId: number) => void }) {
  const parts = text.split(/([A-Za-z_][A-Za-z0-9_]*)/);
  return (
    <code className="type-text">
      {parts.map((part, index) => {
        const target = links[part];
        if (target === undefined) return part;
        return (
          <button key={index} type="button" className="type-link" onClick={() => onSelect(target)} title={`Inspect type ${part}`}>
            {part}
          </button>
        );
      })}
    </code>
  );
}

function SourceSection({ source }: { source: SourcePreview }) {
  return (
    <section aria-labelledby="source-title" className="inspector-section">
      <details className="source">
        <summary id="source-title">
          Source Preview
          {source.status === 'ok' && <span className="muted small"> lines {source.startLine}–{source.endLine}</span>}
        </summary>
        {source.status === 'ok' ? (
          <pre className="source__code" aria-label="Source code">
            <code>
              {source.lines.map((line, index) => (
                <span key={index} className="source__line">
                  <span className="source__number" aria-hidden="true">{source.startLine + index}</span>
                  {line || ' '}
                  {'\n'}
                </span>
              ))}
            </code>
            {source.truncated && <span className="muted small">… preview truncated</span>}
          </pre>
        ) : (
          <p className="muted">{SOURCE_UNAVAILABLE[source.reason] ?? 'The source is not available.'}</p>
        )}
      </details>
    </section>
  );
}

function RefList({ title, refs, empty, onSelect }: { title: string; refs: SymbolRef[]; empty: string; onSelect: (symbolId: number) => void }) {
  return (
    <div className="ref-list">
      <h4>{title} <span className="muted small">({refs.length})</span></h4>
      {refs.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul aria-label={title}>
          {refs.map((ref, index) => {
            const location = ref.path ? `${ref.path}:${ref.line}` : `line ${ref.line}`;
            const target = ref.symbolId;
            return (
              <li key={`${index}:${ref.name}:${ref.line}`}>
                {target !== null ? (
                  <button type="button" className="ref" onClick={() => onSelect(target)}>
                    <code>{ref.name}</code>
                  </button>
                ) : (
                  <code className="ref ref--static">{ref.name}</code>
                )}
                <span className="muted small"> {location}{ref.resolved ? '' : ' · matched by name'}{ref.relation !== 'calls' ? ` · ${ref.relation}` : ''}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
