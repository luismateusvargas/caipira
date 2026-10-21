import { Component, useEffect, useId, useState } from 'react';
import type { ErrorInfo, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { ExploreApi } from './api/client';
import { toApiError } from './api/client';
import { FACT_CATEGORIES, isFactCategory } from './api/schemas';
import type { FactCategory, GraphNode, GraphPayload, GraphView, ReindexResult, WorkspaceList } from './api/schemas';
import { useRequest } from './api/useRequest';
import { GraphCanvas } from './features/graph/GraphCanvas';
import { NodeSummary } from './features/inspector/NodeSummary';
import { SymbolInspectorDrawer } from './features/inspector/SymbolInspectorDrawer';
import { KnowledgeBoard } from './features/knowledge/KnowledgeBoard';
import type { FactAnchor } from './features/knowledge/KnowledgeBoard';
import { OmniSearchModal } from './features/search/OmniSearchModal';
import type { SearchPick } from './features/search/OmniSearchModal';

/** Props for {@link App}. */
export interface AppProps {
  /** The API client; tests pass a fake. */
  api: ExploreApi;
}

/**
 * The explorer shell: loads the registered workspaces and shows the
 * explorer for the chosen one.
 */
export function App({ api }: AppProps) {
  const workspaces = useRequest('workspaces', signal => api.listWorkspaces(signal), {
    isEmpty: data => data.workspaces.length === 0
  });
  const [chosen, setChosen] = useState<number | null>(null);

  if (workspaces.state.status === 'loading') return <FullScreen><p role="status">Loading workspaces…</p></FullScreen>;
  if (workspaces.state.status === 'empty') return <FullScreen><p>No workspaces are registered yet. Run an agent session with Caipira installed first.</p></FullScreen>;
  if (workspaces.state.status === 'error') {
    return (
      <FullScreen>
        <div className="notice notice--error" role="alert">
          <p>{workspaces.state.error.message}</p>
          <button type="button" className="button button--ghost" onClick={workspaces.reload}>Retry</button>
        </div>
      </FullScreen>
    );
  }
  const list = workspaces.state.data;
  const workspaceId = chosen ?? list.defaultWorkspaceId;
  return <Explorer key={workspaceId} api={api} workspaceId={workspaceId} workspaces={list} onWorkspaceChange={setChosen} />;
}

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="fullscreen">
      <div className="brand"><span className="brand__mark" aria-hidden="true" />Caipira <span className="brand__sub">Explore</span></div>
      {children}
    </div>
  );
}

type Panel = 'inspector' | 'knowledge';
type BaseView = Exclude<GraphView, 'impact'>;
type Reindex = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: ReindexResult } | { status: 'error'; message: string };

interface GraphFilters {
  pathPrefix: string;
  kind: string;
  category: FactCategory | '';
}

const SYMBOL_KINDS = ['function', 'method', 'component', 'class', 'struct', 'interface', 'trait', 'enum', 'type', 'union', 'const', 'variable'];

function symbolIdOf(nodeId: string | null): number | null {
  const match = nodeId?.match(/^symbol:(\d+)$/);
  return match?.[1] ? Number(match[1]) : null;
}

function factIdOf(nodeId: string | null): number | null {
  const match = nodeId?.match(/^fact:(\d+)$/);
  return match?.[1] ? Number(match[1]) : null;
}

interface ExplorerProps {
  api: ExploreApi;
  workspaceId: number;
  workspaces: WorkspaceList;
  onWorkspaceChange: (workspaceId: number) => void;
}

function Explorer({ api, workspaceId, workspaces, onWorkspaceChange }: ExplorerProps) {
  const id = useId();
  const [baseView, setBaseView] = useState<BaseView>('unified');
  const [focus, setFocus] = useState<number | null>(null);
  const [depth, setDepth] = useState(2);
  const [filters, setFilters] = useState<GraphFilters>({ pathPrefix: '', kind: '', category: '' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('knowledge');
  const [revision, setRevision] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reindex, setReindex] = useState<Reindex>({ status: 'idle' });

  const view: GraphView = focus !== null ? 'impact' : baseView;
  const graphKey = `graph:${workspaceId}:${view}:${focus ?? ''}:${depth}:${filters.pathPrefix}:${filters.kind}:${filters.category}`;
  const graph = useRequest(
    graphKey,
    signal => api.getGraph({
      workspaceId, view, depth,
      symbolId: focus ?? undefined,
      pathPrefix: filters.pathPrefix || undefined,
      kind: filters.kind || undefined,
      category: filters.category || undefined
    }, signal),
    { revision, isEmpty: data => data.nodes.length === 0 }
  );
  const graphData: GraphPayload | null = graph.state.status === 'ready' ? graph.state.data : null;
  const selectedNode: GraphNode | null = graphData?.nodes.find(node => node.id === selectedId) ?? null;
  const selectedSymbol = symbolIdOf(selectedId);

  // Ctrl+K / Cmd+K opens the search from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const jumpTo = (nodeId: string) => {
    setSelectedId(nodeId);
    setPanel(nodeId.startsWith('fact:') ? 'knowledge' : 'inspector');
  };

  const selectNode = (node: GraphNode | null) => {
    if (node) jumpTo(node.id);
    else setSelectedId(null);
  };

  const changeView = (next: GraphView) => {
    if (next === 'impact') {
      if (selectedSymbol !== null) setFocus(selectedSymbol);
      return;
    }
    setFocus(null);
    setBaseView(next);
  };

  const changeBlastRadius = (active: boolean, nextDepth: number) => {
    setDepth(nextDepth);
    setFocus(active ? selectedSymbol : null);
  };

  const pick = (choice: SearchPick) => {
    if (choice.type === 'symbol') jumpTo(`symbol:${choice.symbolId}`);
    else if (choice.type === 'file') jumpTo(`file:${choice.path}`);
    else jumpTo(`fact:${choice.factId}`);
  };

  const runReindex = async () => {
    setReindex({ status: 'running' });
    try {
      const result = await api.reindex(workspaceId);
      setReindex({ status: 'done', result });
      setRevision(value => value + 1);
    } catch (error) {
      setReindex({ status: 'error', message: toApiError(error).message });
    }
  };

  const factsChanged = () => setRevision(value => value + 1);

  const anchor: FactAnchor | null = selectedSymbol !== null
    ? { label: selectedNode?.type === 'symbol' ? selectedNode.qualifiedName : `symbol #${selectedSymbol}`, evidenceFiles: [], evidenceSymbols: [selectedSymbol] }
    : selectedNode?.type === 'file'
      ? { label: selectedNode.path, evidenceFiles: [selectedNode.path], evidenceSymbols: [] }
      : null;

  const workspace = workspaces.workspaces.find(item => item.id === workspaceId);
  const driftCount = graphData?.driftCount ?? workspace?.counts?.drift ?? 0;

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: Panel = panel === 'inspector' ? 'knowledge' : 'inspector';
    setPanel(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand__mark" aria-hidden="true" />Caipira <span className="brand__sub">Explore</span></div>
        <div className="topbar__workspace">
          <label htmlFor={`${id}-workspace`} className="small muted">Workspace</label>
          <select
            id={`${id}-workspace`}
            value={workspaceId}
            onChange={event => onWorkspaceChange(Number(event.target.value))}
          >
            {workspaces.workspaces.map(item => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.label}{item.counts ? ` · ${item.counts.symbols} symbols · ${item.counts.facts} facts` : ' · unavailable'}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="search-trigger" onClick={() => setSearchOpen(true)} aria-keyshortcuts="Control+K Meta+K">
          <Search size={15} aria-hidden="true" /> Search symbols, files, facts <kbd>Ctrl K</kbd>
        </button>
        <div className="topbar__end">
          {driftCount > 0 && (
            <button type="button" className="badge badge--drift badge--button" onClick={() => setPanel('knowledge')}>
              {driftCount} NEEDS REVIEW
            </button>
          )}
          <button type="button" className="button button--ghost" onClick={() => void runReindex()} disabled={reindex.status === 'running'}>
            <RefreshCw size={14} aria-hidden="true" className={reindex.status === 'running' ? 'spin' : undefined} />
            {reindex.status === 'running' ? 'Reindexing…' : 'Reindex'}
          </button>
        </div>
      </header>
      <div className="topbar__status" role="status" aria-live="polite">
        {reindex.status === 'done' && `Reindexed: ${reindex.result.parsed} parsed, ${reindex.result.unchanged} unchanged, ${reindex.result.symbolsTotal} symbols in ${reindex.result.durationMs} ms.`}
        {reindex.status === 'error' && <span className="field__error">Reindex failed: {reindex.message}</span>}
      </div>

      <main className="layout">
        <div className="layout__graph">
          <GraphFiltersForm filters={filters} onApply={setFilters} />
          <ErrorBoundary label="graph">
            {graph.state.status === 'loading' && <p className="graph-placeholder" role="status">Building the graph…</p>}
            {graph.state.status === 'error' && (
              <div className="graph-placeholder notice notice--error" role="alert">
                <p>{graph.state.error.message}</p>
                <button type="button" className="button button--ghost" onClick={graph.reload}>Retry</button>
              </div>
            )}
            {graph.state.status === 'empty' && (
              <div className="graph-placeholder">
                <p>Nothing to show here yet. Index the workspace to map its files and symbols.</p>
                <button type="button" className="button button--primary" onClick={() => void runReindex()}>Index workspace</button>
              </div>
            )}
            {graphData && (
              <GraphCanvas
                graph={graphData}
                selectedId={selectedId}
                onSelect={selectNode}
                view={view}
                onViewChange={changeView}
                canFocus={selectedSymbol !== null}
              />
            )}
          </ErrorBoundary>
          {graphData && (
            <footer className="statusbar" aria-label="Graph statistics">
              <span>{graphData.stats.files} files</span>
              <span>{graphData.stats.symbols} symbols</span>
              <span>{graphData.stats.facts} facts</span>
              <span>{graphData.stats.sessions} sessions</span>
              <span>{graphData.stats.edges} edges</span>
              <span className="muted">index: {graphData.stats.indexedFiles} files · {graphData.stats.indexedSymbols} symbols</span>
              {graph.refreshing && <span className="muted">refreshing…</span>}
            </footer>
          )}
        </div>

        <div className="layout__panel">
          <div className="tabs" role="tablist" aria-label="Side panel">
            {(['inspector', 'knowledge'] as const).map(tab => (
              <button
                key={tab}
                id={`${id}-tab-${tab}`}
                type="button"
                role="tab"
                className="tab"
                aria-selected={panel === tab}
                aria-controls={`${id}-panel`}
                tabIndex={panel === tab ? 0 : -1}
                onClick={() => setPanel(tab)}
                onKeyDown={onTabKeyDown}
              >
                {tab === 'inspector' ? 'Inspector' : 'Knowledge'}
              </button>
            ))}
          </div>
          <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${panel}`} className="tabpanel">
            <ErrorBoundary label={panel}>
              {panel === 'inspector' && selectedSymbol !== null && (
                <SymbolInspectorDrawer
                  api={api}
                  workspaceId={workspaceId}
                  symbolId={selectedSymbol}
                  revision={revision}
                  blastRadius={{ active: focus !== null && focus === selectedSymbol, depth }}
                  onBlastRadiusChange={changeBlastRadius}
                  onSelectSymbol={symbolId => jumpTo(`symbol:${symbolId}`)}
                  onFactsChanged={factsChanged}
                  onClose={() => setSelectedId(null)}
                />
              )}
              {panel === 'inspector' && selectedSymbol === null && selectedNode && graphData && (
                <NodeSummary node={selectedNode} graph={graphData} onJumpTo={jumpTo} onClose={() => setSelectedId(null)} />
              )}
              {panel === 'inspector' && selectedSymbol === null && !selectedNode && (
                <p className="muted panel-empty">Select a symbol in the graph, or press Ctrl K, to inspect what it receives, returns and calls.</p>
              )}
              {panel === 'knowledge' && (
                <KnowledgeBoard
                  api={api}
                  workspaceId={workspaceId}
                  revision={revision}
                  highlightFactId={factIdOf(selectedId)}
                  anchor={anchor}
                  onJumpTo={jumpTo}
                  onFactsChanged={factsChanged}
                />
              )}
            </ErrorBoundary>
          </div>
        </div>
      </main>

      <OmniSearchModal open={searchOpen} api={api} workspaceId={workspaceId} onPick={pick} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function GraphFiltersForm({ filters, onApply }: { filters: GraphFilters; onApply: (filters: GraphFilters) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(filters);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onApply({ ...draft, pathPrefix: draft.pathPrefix.trim() });
  };
  return (
    <form className="filters" aria-label="Graph filters" onSubmit={submit}>
      <label htmlFor={`${id}-path`} className="visually-hidden">Path prefix</label>
      <input
        id={`${id}-path`}
        type="text"
        placeholder="Path prefix, e.g. src/api"
        value={draft.pathPrefix}
        onChange={event => setDraft(current => ({ ...current, pathPrefix: event.target.value }))}
      />
      <label htmlFor={`${id}-kind`} className="visually-hidden">Symbol kind</label>
      <select id={`${id}-kind`} value={draft.kind} onChange={event => setDraft(current => ({ ...current, kind: event.target.value }))}>
        <option value="">All symbol kinds</option>
        {SYMBOL_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <label htmlFor={`${id}-category`} className="visually-hidden">Fact category</label>
      <select
        id={`${id}-category`}
        value={draft.category}
        onChange={event => {
          const value = event.target.value;
          if (value === '' || isFactCategory(value)) setDraft(current => ({ ...current, category: value }));
        }}
      >
        <option value="">All fact kinds</option>
        {FACT_CATEGORIES.map(kind => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <button type="submit" className="button button--ghost">Apply</button>
    </form>
  );
}

interface ErrorBoundaryProps {
  label: string;
  children: ReactNode;
}

/** Contains a render failure to one region and offers to retry it. */
class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[caipira-explore] the ${this.props.label} panel failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="notice notice--error" role="alert">
        <p>The {this.props.label} panel failed to render.</p>
        <button type="button" className="button button--ghost" onClick={() => this.setState({ failed: false })}>Try again</button>
      </div>
    );
  }
}
