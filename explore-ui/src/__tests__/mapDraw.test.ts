import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../api/schemas';
import type { LinkKind } from '../features/graph/mapDraw';
import { LINK_KINDS, aggregateRoutes, buildScene, describeRegion, fitText, focusOf } from '../features/graph/mapDraw';
import { layoutMap } from '../features/graph/mapLayout';

const file = (path: string): GraphNode => ({ id: `file:${path}`, type: 'file', label: path.slice(path.lastIndexOf('/') + 1), path, language: 'ts', group: '', indexed: true });
const symbol = (id: number, path: string): GraphNode => ({
  id: `symbol:${id}`, type: 'symbol', label: `s${id}`, symbolId: id, kind: 'function', path, qualifiedName: `s${id}`, line: id, isPublic: true, returnType: null, callers: 0
});
const fact: GraphNode = { id: 'fact:1', type: 'fact', label: 'a fact', factId: 1, category: 'status', state: 'active', drifted: false, trust: 1, symbolAnchors: 1, uncheckedSymbols: 0 };
const edge = (source: string, target: string, kind: GraphEdge['kind']): GraphEdge => ({ id: `${kind}:${source}->${target}`, source, target, kind });

const NODES = [file('a/x.ts'), symbol(1, 'a/x.ts'), symbol(2, 'a/x.ts'), file('b/y.ts'), symbol(3, 'b/y.ts'), file('b/c/z.ts'), symbol(4, 'b/c/z.ts'), fact];
const EDGES = [
  edge('file:a/x.ts', 'symbol:1', 'defines'),
  edge('symbol:1', 'symbol:3', 'calls'),
  edge('symbol:2', 'symbol:3', 'calls'),
  edge('symbol:1', 'symbol:2', 'calls'),
  edge('file:a/x.ts', 'file:b/y.ts', 'imports'),
  edge('symbol:3', 'symbol:4', 'uses_type'),
  edge('fact:1', 'symbol:1', 'evidences'),
  edge('fact:1', 'missing', 'evidences')
];

const ALL: ReadonlySet<LinkKind> = new Set(LINK_KINDS);

describe('map links', () => {
  const scene = buildScene(layoutMap(NODES), EDGES);
  const item = (id: string) => {
    const found = scene.layout.byId.get(id);
    if (!found) throw new Error(`no item ${id}`);
    return found;
  };

  it('drops containment and edges to nodes off the map', () => {
    expect(scene.edges.map(e => `${e.kind} ${e.source.node.id} ${e.target.node.id} ${e.local}`)).toEqual([
      'calls symbol:1 symbol:3 true',
      'calls symbol:2 symbol:3 true',
      'calls symbol:1 symbol:2 true',
      'imports file:a/x.ts file:b/y.ts true',
      'uses_type symbol:3 symbol:4 true',
      'evidences fact:1 symbol:1 false'
    ]);
  });

  it('aggregates routes between regions, within one top-level region, by the kinds shown', () => {
    const routes = (kinds: ReadonlySet<LinkKind>) => aggregateRoutes(scene, 1, kinds).map(route => [
      'chain' in route.a ? route.a.id : route.a.node.id, 'chain' in route.b ? route.b.id : route.b.node.id, route.count
    ]);

    // Close up each directory stands for itself; links into a nested region do not count as routes.
    expect(routes(ALL)).toEqual([['dir:a', 'dir:b', 3]]);
    expect(routes(new Set(['imports']))).toEqual([['dir:a', 'dir:b', 1]]);
    // From afar the whole code region stands in, so nothing leaves it.
    expect(aggregateRoutes(scene, 0.0001, ALL)).toEqual([]);
  });

  it('lights a card with its rows, what they link to, and names them', () => {
    const focus = focusOf(scene, item('file:a/x.ts'), null, null, ALL, 1);

    expect(focus?.links.map(link => `${link.kind} ${link.from.node.id} ${link.to.node.id}`).sort()).toEqual([
      'calls symbol:1 symbol:2', 'calls symbol:1 symbol:3', 'calls symbol:2 symbol:3', 'evidences fact:1 symbol:1', 'imports file:a/x.ts file:b/y.ts'
    ]);
    expect(focus?.named.map(named => named.node.id)).toEqual(['file:a/x.ts', 'file:b/y.ts', 'symbol:3', 'fact:1']);
    expect(focus?.lit.has(item('file:b/y.ts'))).toBe(true);
    expect(focus?.lit.has(item('symbol:4'))).toBe(false);
  });

  it('prefers the hovered item over the selection, and shows only the kinds asked for', () => {
    const focus = focusOf(scene, item('symbol:3'), item('fact:1'), null, new Set(['uses_type']), 1);

    expect(focus?.links.map(link => `${link.from.node.id} ${link.to.node.id}`)).toEqual(['symbol:3 symbol:4']);
  });

  it('gathers a hovered region\'s links by their far end', () => {
    const b = scene.layout.regionById.get('dir:b');
    if (!b) throw new Error('no region b');

    const focus = focusOf(scene, null, null, b, ALL, 1);

    expect(focus?.region).toBe(b);
    expect(focus?.routes.map(route => ['chain' in route.b ? route.b.id : route.b.node.id, route.count])).toEqual([['file:a/x.ts', 3]]);
    expect(focusOf(scene, null, null, null, ALL, 1)).toBeNull();
  });

  it('describes regions and fits labels to their room', () => {
    const a = scene.layout.regionById.get('dir:a');
    if (!a) throw new Error('no region a');

    expect(describeRegion(a)).toBe('a/ · 1 file · 2 symbols');
    expect(fitText('a_long_symbol_name', 60, 10)).toBe('a_long_sy…');
    expect(fitText('short', 200, 10)).toBe('short');
    expect(fitText('anything', 5, 10)).toBe('');
  });
});
