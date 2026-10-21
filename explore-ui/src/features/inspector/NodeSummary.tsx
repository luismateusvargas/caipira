import { X } from 'lucide-react';
import type { EdgeKind, GraphNode, GraphPayload } from '../../api/schemas';
import { evidenceNotChecked } from '../../api/schemas';

/** Props for {@link NodeSummary}. */
export interface NodeSummaryProps {
  node: GraphNode;
  graph: GraphPayload;
  onJumpTo: (nodeId: string) => void;
  onClose: () => void;
}

const RELATIONS: readonly { kind: EdgeKind; outgoing: string; incoming: string }[] = [
  { kind: 'defines', outgoing: 'Defines', incoming: 'Defined in' },
  { kind: 'imports', outgoing: 'Imports', incoming: 'Imported by' },
  { kind: 'evidences', outgoing: 'Evidence', incoming: 'Facts anchored here' },
  { kind: 'supersedes', outgoing: 'Supersedes', incoming: 'Superseded by' },
  { kind: 'touched', outgoing: 'Touched', incoming: 'Touched by sessions' }
];

function heading(node: GraphNode): { title: string; subtitle: string } {
  switch (node.type) {
    case 'file': return { title: node.path, subtitle: node.language ?? (node.indexed ? 'indexed file' : 'evidence file (not indexed)') };
    case 'fact': return { title: node.label, subtitle: `${node.category} · ${node.state.replace('_', ' ')}` };
    case 'session': return { title: node.label, subtitle: node.summary ?? 'no digest yet' };
    case 'symbol': return { title: node.qualifiedName, subtitle: `${node.kind} · ${node.path}:${node.line}` };
  }
}

/**
 * What the loaded graph says about a file, fact or session node: its
 * connections grouped by relation, each one a link to that node.
 */
export function NodeSummary({ node, graph, onJumpTo, onClose }: NodeSummaryProps) {
  const byId = new Map(graph.nodes.map(item => [item.id, item]));
  const { title, subtitle } = heading(node);
  const groups = RELATIONS.flatMap(relation => [
    { label: relation.outgoing, ids: graph.edges.filter(edge => edge.kind === relation.kind && edge.source === node.id).map(edge => edge.target) },
    { label: relation.incoming, ids: graph.edges.filter(edge => edge.kind === relation.kind && edge.target === node.id).map(edge => edge.source) }
  ]).filter(group => group.ids.length > 0);

  return (
    <aside className="drawer" aria-labelledby="node-summary-title">
      <header className="drawer__header">
        <h2 id="node-summary-title" className="drawer__title">{node.type === 'file' ? 'File' : node.type === 'fact' ? 'Fact' : 'Session'}</h2>
        <button type="button" className="icon-button" aria-label="Close details" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="drawer__body">
        <section className="inspector-head">
          <code className="signature">{title}</code>
          <p className="muted small">{subtitle}</p>
          {node.type === 'fact' && node.drifted && <span className="badge badge--drift">NEEDS REVIEW</span>}
          {node.type === 'fact' && evidenceNotChecked(node) && (
            <>
              <span className="badge">Evidence not checked</span>
              <p className="muted small">
                {node.uncheckedSymbols === null
                  ? 'Its symbol evidence has not been checked against the source, so this status reflects the last index.'
                  : `${node.uncheckedSymbols} symbol ${node.uncheckedSymbols === 1 ? 'anchor' : 'anchors'} could not be re-read from source, so this status reflects the last index.`}
              </p>
            </>
          )}
        </section>
        {groups.length === 0 && <p className="muted">No connections in this view.</p>}
        {groups.map(group => (
          <section key={group.label} className="inspector-section">
            <h3>{group.label} <span className="muted small">({group.ids.length})</span></h3>
            <ul className="ref-list" aria-label={group.label}>
              {group.ids.slice(0, 200).map(id => {
                const target = byId.get(id);
                return (
                  <li key={id}>
                    <button type="button" className="ref" onClick={() => onJumpTo(id)}>
                      <code>{target ? (target.type === 'symbol' ? target.qualifiedName : target.label) : id}</code>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
