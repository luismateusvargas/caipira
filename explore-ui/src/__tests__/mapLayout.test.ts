import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../api/schemas';
import type { Box, MapLayout, MapRegion } from '../features/graph/mapLayout';
import { CARD_W, ROWS_PER_COLUMN, buildRegionTree, hitTest, inHiddenRegion, layoutMap, packBoxes, representative } from '../features/graph/mapLayout';

const file = (path: string, indexed = true): GraphNode => ({
  id: `file:${path}`, type: 'file', label: path.slice(path.lastIndexOf('/') + 1), path, language: 'rust', group: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/', indexed
});

let nextSymbol = 1;
const symbol = (path: string, name: string, line = 1, kind = 'function'): GraphNode => {
  const symbolId = nextSymbol++;
  return { id: `symbol:${symbolId}`, type: 'symbol', label: name, symbolId, kind, path, qualifiedName: name, line, isPublic: true, returnType: null, callers: 0 };
};

const fact = (factId: number, category: 'decision' | 'gotcha' | 'status', state: 'active' | 'needs_review' | 'superseded' = 'active'): GraphNode => ({
  id: `fact:${factId}`, type: 'fact', label: `fact ${factId}`, factId, category, state, drifted: state === 'needs_review', trust: 1, symbolAnchors: 0, uncheckedSymbols: null
});

const session = (id: string, startedAt: number): GraphNode => ({
  id: `session:${id}`, type: 'session', label: id, sessionId: id, ide: 'codex', startedAt, endedAt: null, summary: null
});

const inside = (inner: Box, outer: Box) => inner.x >= outer.x - 1e-6 && inner.y >= outer.y - 1e-6
  && inner.x + inner.w <= outer.x + outer.w + 1e-6 && inner.y + inner.h <= outer.y + outer.h + 1e-6;

const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

/** Every region inside its parent, siblings and cards apart, rows on their card. */
function geometryProblems(layout: MapLayout): string[] {
  const problems: string[] = [];
  const check = (siblings: readonly Box[], label: string) => {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const [a, b] = [siblings[i], siblings[j]];
        if (a && b && overlap(a, b)) problems.push(`${label}: ${i} overlaps ${j}`);
      }
    }
  };
  check(layout.roots, 'roots');
  for (const region of layout.regions) {
    if (region.parent && !inside(region, region.parent)) problems.push(`${region.id} leaves ${region.parent.id}`);
    check([...region.children, ...region.items], region.id);
    for (const card of region.items) {
      if (!inside(card, region)) problems.push(`${card.node.id} leaves ${region.id}`);
      for (const row of card.rows) if (!inside(row, card)) problems.push(`${row.node.id} leaves ${card.node.id}`);
      check(card.rows, card.node.id);
    }
  }
  return problems;
}

function region(layout: MapLayout, id: string): MapRegion {
  const found = layout.regionById.get(id);
  if (!found) throw new Error(`no region ${id}; have ${[...layout.regionById.keys()].join(', ')}`);
  return found;
}

describe('map layout', () => {
  it('groups files by directory, merges single-child chains and puts symbols on their file card', () => {
    const nodes = [
      file('README.md', false),
      file('crates/app/src/main.rs'), file('crates/app/src/lib.rs'), file('crates/core/src/model.rs'),
      symbol('crates/app/src/main.rs', 'run', 20), symbol('crates/app/src/main.rs', 'main', 3),
      symbol('crates/core/src/orphan.rs', 'Loose', 1, 'struct')
    ];

    const layout = layoutMap(nodes);

    expect(layout.roots.map(root => root.id)).toEqual(['dir:']);
    const code = region(layout, 'dir:');
    expect(code.items.map(item => item.node.label)).toEqual(['README.md']);
    expect(code.children.map(child => child.label)).toEqual(['crates']);
    const crates = region(layout, 'dir:crates');
    expect(crates.children.map(child => [child.id, child.label])).toEqual([['dir:crates/app/src', 'app/src'], ['dir:crates/core/src', 'core/src']]);
    expect(crates.counts).toEqual({ file: 3, symbol: 3, fact: 0, session: 0 });

    const main = layout.byId.get('file:crates/app/src/main.rs');
    expect(main?.rows.map(row => row.node.label)).toEqual(['main', 'run']);
    expect(main?.rows.every(row => row.card === main && row.region.id === 'dir:crates/app/src')).toBe(true);
    // A symbol whose file is not on the map gets a card of its own.
    const loose = layout.byId.get(nodes[6]?.id ?? '');
    expect(loose?.card).toBeNull();
    expect(loose?.region.id).toBe('dir:crates/core/src');
    expect(geometryProblems(layout)).toEqual([]);
  });

  it('puts facts in a Knowledge region by category, review first then newest, and sessions newest first', () => {
    const layout = layoutMap([
      fact(1, 'decision'), fact(5, 'decision'), fact(3, 'decision', 'needs_review'), fact(4, 'decision', 'superseded'), fact(2, 'gotcha'),
      session('old', 100), session('new', 300), session('mid', 200)
    ]);

    expect(layout.roots.map(root => root.id)).toEqual(['knowledge', 'sessions']);
    expect(region(layout, 'knowledge').children.map(child => child.id)).toEqual(['category:decision', 'category:gotcha']);
    expect(region(layout, 'category:decision').items.map(item => item.node.id)).toEqual(['fact:3', 'fact:5', 'fact:1', 'fact:4']);
    expect(region(layout, 'sessions').items.map(item => item.node.id)).toEqual(['session:new', 'session:mid', 'session:old']);
    expect(geometryProblems(layout)).toEqual([]);
  });

  it('packs a large workspace without overlaps and the same way every time', () => {
    const nodes: GraphNode[] = [];
    for (let d = 0; d < 12; d++) {
      for (let f = 0; f < (d * 7) % 13 + 1; f++) {
        const path = `pkg${d % 4}/mod${d}/${f % 3 ? 'src/' : ''}file${f}.ts`;
        nodes.push(file(path));
        for (let s = 0; s < (f * 11 + d) % 75; s++) nodes.push(symbol(path, `fn${s}`, s));
      }
    }
    for (let i = 1; i <= 40; i++) nodes.push(fact(i, i % 3 === 0 ? 'gotcha' : 'status'));
    for (let i = 0; i < 9; i++) nodes.push(session(`s${i}`, i));

    const first = layoutMap(nodes);
    const second = layoutMap(nodes);

    expect(geometryProblems(first)).toEqual([]);
    expect(first.items).toHaveLength(nodes.length);
    expect(first.items.map(item => [item.node.id, item.x, item.y, item.w, item.h])).toEqual(second.items.map(item => [item.node.id, item.x, item.y, item.w, item.h]));
    for (const root of first.roots) expect(inside(root, first.bounds)).toBe(true);
  });

  it('wraps a long file into balanced columns', () => {
    const path = 'src/big.rs';
    const count = ROWS_PER_COLUMN * 2 + 1;
    const layout = layoutMap([file(path), ...Array.from({ length: count }, (_, i) => symbol(path, `item${i}`, i))]);

    const card = layout.byId.get(`file:${path}`);
    expect(card?.w).toBe(CARD_W * 3);
    const columns = new Map<number, number>();
    for (const row of card?.rows ?? []) columns.set(row.x, (columns.get(row.x) ?? 0) + 1);
    expect([...columns.values()]).toEqual([21, 21, 19]);
    expect(geometryProblems(layout)).toEqual([]);
  });

  it('hides a region and everything under it, at any depth', () => {
    const hidden = new Set(['dir:a/b', 'category:gotcha']);

    expect(inHiddenRegion(file('a/b/c/d.rs'), hidden)).toBe(true);
    expect(inHiddenRegion(file('a/b/x.rs'), hidden)).toBe(true);
    expect(inHiddenRegion(file('a/bc/x.rs'), hidden)).toBe(false);
    expect(inHiddenRegion(file('a/x.rs'), hidden)).toBe(false);
    expect(inHiddenRegion(fact(1, 'gotcha'), hidden)).toBe(true);
    expect(inHiddenRegion(fact(2, 'status'), hidden)).toBe(false);
    expect(inHiddenRegion(file('top.rs'), new Set(['dir:']))).toBe(true);
    expect(inHiddenRegion(session('s', 1), new Set(['sessions']))).toBe(true);
  });

  it('finds what is under a point and what stands for an item from afar', () => {
    const nodes = [file('a/x.rs'), symbol('a/x.rs', 'first'), symbol('a/x.rs', 'second'), file('b/y.rs')];
    const layout = layoutMap(nodes);
    const card = layout.byId.get('file:a/x.rs');
    const row = card?.rows[1];
    if (!card || !row) throw new Error('layout lost the card');

    expect(hitTest(layout, row.x + 5, row.y + 5, true).item).toBe(row);
    expect(hitTest(layout, row.x + 5, row.y + 5, false).item).toBe(card);
    const margin = hitTest(layout, card.x - 1, card.y + 1, true);
    expect(margin.item).toBeNull();
    expect(margin.region).toBe(region(layout, 'dir:a'));
    const outside = hitTest(layout, -50, -50, true);
    expect([outside.item, outside.region]).toEqual([null, null]);

    expect(representative(row, 1, 130)).toBe(card);
    expect(representative(row, 0.0001, 130)).toBe(region(layout, 'dir:'));
  });

  it('builds the region tree for the panel without geometry', () => {
    const tree = buildRegionTree([file('a/b/c.rs'), fact(1, 'status'), session('s', 1)]);

    expect(tree.map(root => root.id)).toEqual(['dir:', 'knowledge', 'sessions']);
    expect(tree[0]?.children.map(child => child.label)).toEqual(['a/b']);
  });

  it('packs boxes inside the width it aims for, without overlaps', () => {
    const sizes = [{ w: 300, h: 50 }, { w: 120, h: 400 }, { w: 80, h: 80 }, { w: 80, h: 80 }, { w: 500, h: 30 }];

    const packed = packBoxes(sizes, 10);

    const boxes = packed.at.map((at, i) => ({ ...at, w: sizes[i]?.w ?? 0, h: sizes[i]?.h ?? 0 }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i] as Box, boxes[j] as Box)).toBe(false);
    expect(Math.max(...boxes.map(box => box.x + box.w))).toBe(packed.size.w);
    expect(Math.max(...boxes.map(box => box.y + box.h))).toBe(packed.size.h);
  });
});
