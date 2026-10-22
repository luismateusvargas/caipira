import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { GraphPayload } from '../../api/schemas';
import type { LinkKind } from './mapDraw';
import { LINK_KINDS } from './mapDraw';
import type { RegionTree } from './mapLayout';

/** Which nodes the map shows. */
export interface Layers {
  file: boolean;
  symbol: boolean;
  fact: boolean;
  session: boolean;
  /** Files the index has not read, such as notes or plans cited as evidence. */
  unindexed: boolean;
  /** Facts a newer fact replaced. */
  superseded: boolean;
}

export const DEFAULT_LAYERS: Layers = { file: true, symbol: true, fact: true, session: true, unindexed: true, superseded: false };

/** Props for {@link MapPanel}. */
export interface MapPanelProps {
  graph: GraphPayload;
  layers: Layers;
  onLayersChange: (layers: Layers) => void;
  kinds: ReadonlySet<LinkKind>;
  onKindsChange: (kinds: ReadonlySet<LinkKind>) => void;
  /** Whether routes between regions are drawn when nothing is in focus. */
  routes: boolean;
  onRoutesChange: (routes: boolean) => void;
  /** Every region the layers allow, hidden ones included. */
  tree: readonly RegionTree[];
  hidden: ReadonlySet<string>;
  onHiddenChange: (hidden: ReadonlySet<string>) => void;
  onFlyTo: (regionId: string) => void;
}

const LAYER_LABELS: readonly { key: keyof Layers; label: string; nested?: boolean }[] = [
  { key: 'file', label: 'Files' },
  { key: 'unindexed', label: 'Not indexed', nested: true },
  { key: 'symbol', label: 'Symbols' },
  { key: 'fact', label: 'Facts' },
  { key: 'superseded', label: 'Superseded', nested: true },
  { key: 'session', label: 'Sessions' }
];

const LINK_LABELS: Record<LinkKind, string> = {
  calls: 'Calls',
  imports: 'Imports',
  uses_type: 'Uses type',
  extends: 'Extends',
  evidences: 'Evidence',
  supersedes: 'Supersedes',
  touched: 'Touched'
};

/**
 * The map's side panel: which layers and links to draw, a key, and the
 * region tree for hiding regions or travelling to one.
 */
export function MapPanel(props: MapPanelProps) {
  const { graph, layers, onLayersChange, kinds, onKindsChange, routes, onRoutesChange } = props;
  const counts: Record<keyof Layers, number> = { file: 0, symbol: 0, fact: 0, session: 0, unindexed: 0, superseded: 0 };
  for (const node of graph.nodes) {
    counts[node.type]++;
    if (node.type === 'file' && !node.indexed) counts.unindexed++;
    if (node.type === 'fact' && node.state === 'superseded') counts.superseded++;
  }
  const linkCounts = new Map<string, number>();
  for (const edge of graph.edges) linkCounts.set(edge.kind, (linkCounts.get(edge.kind) ?? 0) + 1);

  const toggleKind = (kind: LinkKind) => {
    const next = new Set(kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    onKindsChange(next);
  };

  return (
    <aside className="map-panel" aria-label="Map controls">
      <details open className="map-panel__section" aria-label="Layers">
        <summary>Layers</summary>
        <ul className="toggle-list">
          {LAYER_LABELS.map(({ key, label, nested }) => (
            <li key={key}>
              <button
                type="button"
                className={`toggle${nested ? ' toggle--nested' : ''}`}
                aria-pressed={layers[key]}
                disabled={nested && !layers[key === 'unindexed' ? 'file' : 'fact']}
                onClick={() => onLayersChange({ ...layers, [key]: !layers[key] })}
              >
                <span className={`swatch swatch--${key}`} aria-hidden="true" />
                <span className="toggle__label">{label}</span>
                <span className="toggle__count">{counts[key]}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>

      <details open className="map-panel__section" aria-label="Links">
        <summary>Links</summary>
        <button type="button" className="toggle" aria-pressed={routes} onClick={() => onRoutesChange(!routes)}>
          <span className="swatch swatch--route" aria-hidden="true" />
          <span className="toggle__label">Routes between regions</span>
        </button>
        <p className="map-panel__hint">Hover or select a node to see its own links.</p>
        <ul className="toggle-list">
          {LINK_KINDS.map(kind => (
            <li key={kind}>
              <button type="button" className="toggle" aria-pressed={kinds.has(kind)} onClick={() => toggleKind(kind)}>
                <span className={`link-swatch link-swatch--${kind}`} aria-hidden="true" />
                <span className="toggle__label">{LINK_LABELS[kind]}</span>
                <span className="toggle__count">{linkCounts.get(kind) ?? 0}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>

      <details open className="map-panel__section" aria-label="Regions">
        <summary>Regions</summary>
        {props.hidden.size > 0 && (
          <button type="button" className="button button--ghost button--small map-panel__reset" onClick={() => props.onHiddenChange(new Set())}>
            Show all regions
          </button>
        )}
        <ul className="region-tree" aria-label="Regions">
          {props.tree.map(region => (
            <RegionRow key={region.id} region={region} depth={0} hidden={props.hidden} ancestorHidden={false} onHiddenChange={props.onHiddenChange} onFlyTo={props.onFlyTo} />
          ))}
        </ul>
      </details>

      <details className="map-panel__section" aria-label="Key">
        <summary>Key</summary>
        <ul className="map-key">
          <li><span className="glyph glyph--function" aria-hidden="true" />Function or method</li>
          <li><span className="glyph glyph--type" aria-hidden="true" />Type: struct, class, trait…</li>
          <li><span className="glyph glyph--component" aria-hidden="true" />Component</li>
          <li><span className="glyph glyph--value" aria-hidden="true" />Constant or variable</li>
          <li><span className="key-card key-card--dashed" aria-hidden="true" />Dashed: not indexed, or evidence not checked</li>
          <li><span className="key-card key-card--drift" aria-hidden="true" />Red ring: fact needs review</li>
        </ul>
        <p className="map-panel__hint">Bright symbol names are public. The number on a symbol row counts its callers in this graph.</p>
      </details>
    </aside>
  );
}

interface RegionRowProps {
  region: RegionTree;
  depth: number;
  hidden: ReadonlySet<string>;
  ancestorHidden: boolean;
  onHiddenChange: (hidden: ReadonlySet<string>) => void;
  onFlyTo: (regionId: string) => void;
}

function regionCount(region: RegionTree): string {
  const { file, symbol, fact, session } = region.counts;
  if (region.kind === 'knowledge' || region.kind === 'category') return `${fact}`;
  if (region.kind === 'sessions') return `${session}`;
  return file > 0 ? `${file}` : `${symbol}`;
}

function RegionRow({ region, depth, hidden, ancestorHidden, onHiddenChange, onFlyTo }: RegionRowProps) {
  const [open, setOpen] = useState(depth === 0);
  const own = hidden.has(region.id);
  const off = own || ancestorHidden;
  const name = region.kind === 'directory' ? region.path : region.label;
  const toggle = () => {
    const next = new Set(hidden);
    if (own) next.delete(region.id);
    else next.add(region.id);
    onHiddenChange(next);
  };
  return (
    <li>
      <div className={`region-row${off ? ' region-row--off' : ''}`} style={{ paddingLeft: depth * 12 }}>
        {region.children.length > 0 ? (
          <button type="button" className="region-row__expand" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} onClick={() => setOpen(!open)}>
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        ) : <span className="region-row__expand" aria-hidden="true" />}
        <input type="checkbox" checked={!own} disabled={ancestorHidden} onChange={toggle} aria-label={`Show ${name}`} />
        <button type="button" className="region-row__name" title={name} disabled={off} onClick={() => onFlyTo(region.id)}>
          {region.label}
        </button>
        <span className="region-row__count">{regionCount(region)}</span>
      </div>
      {open && region.children.length > 0 && (
        <ul>
          {region.children.map(child => (
            <RegionRow key={child.id} region={child} depth={depth + 1} hidden={hidden} ancestorHidden={off} onHiddenChange={onHiddenChange} onFlyTo={onFlyTo} />
          ))}
        </ul>
      )}
    </li>
  );
}
