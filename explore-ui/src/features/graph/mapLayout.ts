/**
 * The map layout: the graph drawn as nested territories rather than a force
 * cloud. Directories become regions, files become cards inside them and a
 * file's symbols become rows on its card; facts sit in a Knowledge region,
 * one territory per category, and sessions in a Sessions region. Boxes are
 * packed bottom-up and computed once per graph, so nothing overlaps and the
 * same graph always lands in the same place.
 */
import type { FactNode, GraphNode, SymbolNode } from '../../api/schemas';
import { FACT_CATEGORIES } from '../../api/schemas';

/** An axis-aligned rectangle in world units. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RegionKind = 'code' | 'directory' | 'knowledge' | 'category' | 'sessions';

export type NodeCounts = Record<GraphNode['type'], number>;

/** A territory: the code root, a directory, the knowledge or sessions area, or a fact category. */
export interface MapRegion extends Box {
  /** Stable across layouts: `dir:<path>`, `knowledge`, `category:<name>` or `sessions`. */
  id: string;
  kind: RegionKind;
  /** The short name drawn in the header; collapsed directory chains read `a/b`. */
  label: string;
  /** The directory path, category name, or '' for the code root. */
  path: string;
  depth: number;
  parent: MapRegion | null;
  children: MapRegion[];
  /** Cards placed directly in this region. */
  items: MapItem[];
  /** Nodes anywhere inside, by type. */
  counts: NodeCounts;
  /** The regions from the top level down to this one. */
  chain: MapRegion[];
  /** Territory tint. */
  hue: number;
  saturation: number;
}

/** A node on the map: a card in a region, or a symbol row on its file's card. */
export interface MapItem extends Box {
  node: GraphNode;
  region: MapRegion;
  /** The card this row sits on; null for a card. */
  card: MapItem | null;
  rows: MapItem[];
}

export interface MapLayout {
  roots: MapRegion[];
  /** Every region, parents before children. */
  regions: MapRegion[];
  /** Every item, each card before its rows. */
  items: MapItem[];
  byId: ReadonlyMap<string, MapItem>;
  regionById: ReadonlyMap<string, MapRegion>;
  bounds: Box;
}

// World units; one unit is one CSS pixel at zoom 1.
export const CARD_W = 220;
export const CARD_HEAD = 26;
export const ROW_H = 16;
const CARD_FOOT = 6;
/** Longer files wrap their symbols into more columns, so no card towers over its neighbours. */
export const ROWS_PER_COLUMN = 30;
export const FACT_W = 240;
export const FACT_H = 56;
export const SESSION_W = 220;
export const SESSION_H = 40;
const CARD_GAP = 10;
const REGION_GAP = 18;
export const REGION_PAD = 14;
export const REGION_HEAD = 30;
const REGION_MIN_W = 170;
const ROOT_GAP = 90;
// Width over height that packing aims for, close to a desktop viewport.
const ASPECT = 1.6;

// Muted hues for directories, red left out: red marks facts and drift.
const HUES = [212, 168, 136, 42, 264, 190, 96, 300, 28, 236];

export const CODE_ROOT_ID = 'dir:';
export const KNOWLEDGE_ID = 'knowledge';
export const SESSIONS_ID = 'sessions';

/**
 * @param path A workspace-relative file path.
 * @returns Its directory, '' at the workspace root.
 */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * @param node Any graph node.
 * @returns The id of the region the node belongs to before chains collapse:
 *   its directory, its fact category, or the sessions area.
 */
export function homeRegionId(node: GraphNode): string {
  switch (node.type) {
    case 'file':
    case 'symbol': return `dir:${dirOf(node.path)}`;
    case 'fact': return `category:${node.category}`;
    case 'session': return SESSIONS_ID;
  }
}

/**
 * @param node Any graph node.
 * @param hidden Region ids the viewer switched off.
 * @returns True when the node sits inside a hidden region, at any depth.
 */
export function inHiddenRegion(node: GraphNode, hidden: ReadonlySet<string>): boolean {
  if (hidden.size === 0) return false;
  if (node.type === 'fact') return hidden.has(KNOWLEDGE_ID) || hidden.has(`category:${node.category}`);
  if (node.type === 'session') return hidden.has(SESSIONS_ID);
  if (hidden.has(CODE_ROOT_ID)) return true;
  const dir = dirOf(node.path);
  for (let end = dir.length; end > 0; end = dir.lastIndexOf('/', end - 1)) {
    if (hidden.has(`dir:${dir.slice(0, end)}`)) return true;
  }
  return false;
}

// ── region tree ──

/** A region before layout: what it holds, without geometry. */
export interface RegionTree {
  id: string;
  kind: RegionKind;
  label: string;
  path: string;
  children: RegionTree[];
  cards: GraphNode[];
  /** Symbols per file path, for files that are cards here. */
  rows: Map<string, SymbolNode[]>;
  counts: NodeCounts;
}

const emptyCounts = (): NodeCounts => ({ file: 0, symbol: 0, fact: 0, session: 0 });

function branch(id: string, kind: RegionKind, label: string, path: string): RegionTree {
  return { id, kind, label, path, children: [], cards: [], rows: new Map(), counts: emptyCounts() };
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function factOrder(a: FactNode, b: FactNode): number {
  const rank = (fact: FactNode) => (fact.drifted ? 0 : fact.state === 'superseded' ? 2 : 1);
  return rank(a) - rank(b) || b.factId - a.factId;
}

/**
 * Groups nodes into the region tree: directories under a code root (a
 * directory holding nothing but one subdirectory merges into it), fact
 * categories under Knowledge, and Sessions. Empty regions are left out.
 * @param nodes The nodes to place.
 * @returns The top-level regions in map order: code, knowledge, sessions.
 */
export function buildRegionTree(nodes: readonly GraphNode[]): RegionTree[] {
  const code = branch(CODE_ROOT_ID, 'code', 'Code', '');
  const dirs = new Map<string, RegionTree>([['', code]]);
  const dirFor = (path: string): RegionTree => {
    const known = dirs.get(path);
    if (known) return known;
    const parent = dirFor(dirOf(path));
    const created = branch(`dir:${path}`, 'directory', path.slice(path.lastIndexOf('/') + 1), path);
    parent.children.push(created);
    dirs.set(path, created);
    return created;
  };

  const files = new Set<string>();
  for (const node of nodes) if (node.type === 'file') files.add(node.path);
  const knowledge = branch(KNOWLEDGE_ID, 'knowledge', 'Knowledge', '');
  const categories = new Map(FACT_CATEGORIES.map(category => [category, branch(`category:${category}`, 'category', category, category)]));
  const sessions = branch(SESSIONS_ID, 'sessions', 'Sessions', '');

  for (const node of nodes) {
    switch (node.type) {
      case 'file':
        dirFor(dirOf(node.path)).cards.push(node);
        break;
      case 'symbol': {
        // A symbol whose file is not on the map stands on its own card.
        const dir = dirFor(dirOf(node.path));
        if (!files.has(node.path)) { dir.cards.push(node); break; }
        const list = dir.rows.get(node.path) ?? [];
        list.push(node);
        dir.rows.set(node.path, list);
        break;
      }
      case 'fact':
        categories.get(node.category)?.cards.push(node);
        break;
      case 'session':
        sessions.cards.push(node);
        break;
    }
  }

  const count = (tree: RegionTree): NodeCounts => {
    const counts = emptyCounts();
    for (const node of tree.cards) counts[node.type]++;
    for (const rows of tree.rows.values()) counts.symbol += rows.length;
    for (const child of tree.children) {
      const inner = count(child);
      for (const type of Object.keys(counts) as (keyof NodeCounts)[]) counts[type] += inner[type];
    }
    tree.counts = counts;
    return counts;
  };

  const tidy = (tree: RegionTree): RegionTree => {
    tree.children = tree.children.map(tidy).sort((a, b) => byText(a.label, b.label));
    tree.cards.sort((a, b) => {
      if (a.type === 'fact' && b.type === 'fact') return factOrder(a, b);
      if (a.type === 'session' && b.type === 'session') return b.startedAt - a.startedAt;
      return byText(a.label, b.label) || byText(a.id, b.id);
    });
    for (const rows of tree.rows.values()) rows.sort((a, b) => a.line - b.line || byText(a.label, b.label));
    if (tree.kind === 'directory' && tree.cards.length === 0 && tree.children.length === 1) {
      const [only] = tree.children;
      if (only) return { ...only, label: `${tree.label}/${only.label}` };
    }
    return tree;
  };

  const roots: RegionTree[] = [];
  const tidiedCode = tidy(code);
  if (count(tidiedCode).file + tidiedCode.counts.symbol > 0) roots.push(tidiedCode);
  knowledge.children = [...categories.values()].filter(category => category.cards.length > 0);
  for (const category of knowledge.children) tidy(category);
  if (count(knowledge).fact > 0) roots.push(knowledge);
  if (sessions.cards.length > 0) {
    tidy(sessions);
    count(sessions);
    roots.push(sessions);
  }
  return roots;
}

// ── packing ──

interface Size {
  w: number;
  h: number;
}

interface Placed {
  x: number;
  y: number;
}

/**
 * Skyline bottom-left packing: tallest first, each box at the lowest spot
 * along the current skyline that fits it.
 * @returns Each box's offset, in input order, and the packed size.
 */
export function packBoxes(sizes: readonly Size[], gap: number): { at: Placed[]; size: Size } {
  if (sizes.length === 0) return { at: [], size: { w: 0, h: 0 } };
  const area = sizes.reduce((sum, size) => sum + (size.w + gap) * (size.h + gap), 0);
  const widest = Math.max(...sizes.map(size => size.w));
  const width = Math.max(widest + gap, Math.sqrt(area * ASPECT));
  const order = sizes.map((_, i) => i).sort((a, b) => (sizes[b]?.h ?? 0) - (sizes[a]?.h ?? 0) || a - b);
  let skyline: { x: number; w: number; y: number }[] = [{ x: 0, w: width, y: 0 }];
  const at: Placed[] = new Array<Placed>(sizes.length);
  for (const i of order) {
    const size = sizes[i];
    if (!size) continue;
    const span = size.w + gap;
    let best: { x: number; y: number } | null = null;
    for (const start of skyline) {
      if (start.x + span > width + 0.5) break;
      let y = 0;
      for (const segment of skyline) {
        if (segment.x + segment.w <= start.x || segment.x >= start.x + span) continue;
        y = Math.max(y, segment.y);
      }
      if (!best || y < best.y) best = { x: start.x, y };
    }
    const spot = best ?? { x: 0, y: Math.max(...skyline.map(segment => segment.y)) };
    at[i] = spot;
    const top = spot.y + size.h + gap;
    const next: typeof skyline = [];
    for (const segment of skyline) {
      const end = segment.x + segment.w;
      if (end <= spot.x || segment.x >= spot.x + span) { next.push(segment); continue; }
      if (segment.x < spot.x) next.push({ x: segment.x, w: spot.x - segment.x, y: segment.y });
      if (end > spot.x + span) next.push({ x: spot.x + span, w: end - spot.x - span, y: segment.y });
    }
    next.push({ x: spot.x, w: span, y: top });
    next.sort((a, b) => a.x - b.x);
    skyline = [];
    for (const segment of next) {
      const last = skyline[skyline.length - 1];
      if (last && last.y === segment.y && last.x + last.w === segment.x) last.w += segment.w;
      else skyline.push({ ...segment });
    }
  }
  let w = 0;
  let h = 0;
  sizes.forEach((size, i) => {
    const spot = at[i];
    if (!spot) return;
    w = Math.max(w, spot.x + size.w);
    h = Math.max(h, spot.y + size.h);
  });
  return { at, size: { w, h } };
}

/**
 * @param rows How many symbol rows a file card holds.
 * @returns Its columns, balanced so no column runs past {@link ROWS_PER_COLUMN}.
 */
export function rowColumns(rows: number): { columns: number; perColumn: number } {
  const columns = Math.max(1, Math.ceil(rows / ROWS_PER_COLUMN));
  return { columns, perColumn: Math.ceil(rows / columns) };
}

function cardSize(node: GraphNode, rows: number): Size {
  switch (node.type) {
    case 'fact': return { w: FACT_W, h: FACT_H };
    case 'session': return { w: SESSION_W, h: SESSION_H };
    default: {
      const { columns, perColumn } = rowColumns(rows);
      return { w: CARD_W * columns, h: CARD_HEAD + perColumn * ROW_H + (rows > 0 ? CARD_FOOT : 0) };
    }
  }
}

/** A region with its content placed relative to its own top-left corner. */
interface Sized {
  tree: RegionTree;
  size: Size;
  cards: { node: GraphNode; at: Placed; size: Size }[];
  children: { region: Sized; at: Placed }[];
}

function measure(tree: RegionTree): Sized {
  const children = tree.children.map(measure);
  const sizes = tree.cards.map(node => cardSize(node, node.type === 'file' ? tree.rows.get(node.path)?.length ?? 0 : 0));
  // A region's own cards stay together as one block; subregions pack around it.
  const block = sizes.length > 0 ? packBoxes(sizes, CARD_GAP) : null;
  const boxes: Size[] = [...(block ? [block.size] : []), ...children.map(child => child.size)];
  const packed = packBoxes(boxes, REGION_GAP);
  const offset = (i: number): Placed => packed.at[i] ?? { x: 0, y: 0 };
  const origin = { x: REGION_PAD, y: REGION_HEAD };
  const blockAt = block ? offset(0) : { x: 0, y: 0 };
  return {
    tree,
    size: {
      w: Math.max(REGION_MIN_W, packed.size.w + REGION_PAD * 2),
      h: REGION_HEAD + packed.size.h + REGION_PAD
    },
    cards: tree.cards.map((node, i) => ({
      node,
      at: { x: origin.x + blockAt.x + (block?.at[i]?.x ?? 0), y: origin.y + blockAt.y + (block?.at[i]?.y ?? 0) },
      size: sizes[i] ?? { w: CARD_W, h: CARD_HEAD }
    })),
    children: children.map((region, i) => {
      const at = offset(i + (block ? 1 : 0));
      return { region, at: { x: origin.x + at.x, y: origin.y + at.y } };
    })
  };
}

/**
 * Lays nodes out as a map.
 * @param nodes The nodes to show; their edges are drawn by the caller.
 * @returns Every region and item with absolute world coordinates.
 */
export function layoutMap(nodes: readonly GraphNode[]): MapLayout {
  const trees = buildRegionTree(nodes);
  const measured = trees.map(measure);
  const regions: MapRegion[] = [];
  const items: MapItem[] = [];
  const byId = new Map<string, MapItem>();
  const regionById = new Map<string, MapRegion>();

  const place = (sized: Sized, x: number, y: number, parent: MapRegion | null, tint: { hue: number; saturation: number }): MapRegion => {
    const { tree } = sized;
    const region: MapRegion = {
      id: tree.id, kind: tree.kind, label: tree.label, path: tree.path, depth: parent ? parent.depth + 1 : 0,
      parent, children: [], items: [], counts: tree.counts, chain: [], hue: tint.hue, saturation: tint.saturation,
      x, y, w: sized.size.w, h: sized.size.h
    };
    region.chain = [...(parent?.chain ?? []), region];
    regions.push(region);
    regionById.set(region.id, region);
    for (const card of sized.cards) {
      const item: MapItem = { node: card.node, region, card: null, rows: [], x: x + card.at.x, y: y + card.at.y, w: card.size.w, h: card.size.h };
      region.items.push(item);
      items.push(item);
      byId.set(card.node.id, item);
      if (card.node.type !== 'file') continue;
      const symbols = tree.rows.get(card.node.path) ?? [];
      const { perColumn } = rowColumns(symbols.length);
      symbols.forEach((symbol, i) => {
        const column = Math.floor(i / perColumn);
        const row: MapItem = {
          node: symbol, region, card: item, rows: [],
          x: item.x + column * CARD_W, y: item.y + CARD_HEAD + (i % perColumn) * ROW_H, w: CARD_W, h: ROW_H
        };
        item.rows.push(row);
        items.push(row);
        byId.set(symbol.id, row);
      });
    }
    sized.children.forEach((child, i) => {
      // Directories in the top two levels take hues in turn, so neighbours
      // differ; deeper ones keep their parent's.
      let own = tint;
      if (region.kind === 'code') own = { hue: HUES[i % HUES.length] ?? tint.hue, saturation: 34 };
      else if (region.kind === 'directory' && region.depth === 1) {
        own = { hue: HUES[(HUES.indexOf(tint.hue) + i + 1) % HUES.length] ?? tint.hue, saturation: 34 };
      }
      region.children.push(place(child.region, x + child.at.x, y + child.at.y, region, own));
    });
    return region;
  };

  const roots: MapRegion[] = [];
  const tints: Record<string, { hue: number; saturation: number }> = {
    code: { hue: 215, saturation: 14 }, knowledge: { hue: 356, saturation: 46 }, sessions: { hue: 220, saturation: 10 }
  };
  // Code on the left; knowledge and sessions stacked in a column beside it.
  let column = 0;
  let below = 0;
  for (const sized of measured) {
    const tint = tints[sized.tree.kind] ?? { hue: 215, saturation: 14 };
    if (sized.tree.kind === 'code') {
      roots.push(place(sized, 0, 0, null, tint));
      column = sized.size.w + ROOT_GAP;
    } else {
      roots.push(place(sized, column, below, null, tint));
      below += sized.size.h + ROOT_GAP;
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const root of roots) {
    minX = Math.min(minX, root.x);
    minY = Math.min(minY, root.y);
    maxX = Math.max(maxX, root.x + root.w);
    maxY = Math.max(maxY, root.y + root.h);
  }
  const bounds = Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 1, h: 1 };
  return { roots, regions, items, byId, regionById, bounds };
}

// ── queries ──

/** @returns True when the point lies inside the box. */
export function contains(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/**
 * @param layout The map.
 * @param x World x.
 * @param y World y.
 * @param rows Whether symbol rows can be hit at this zoom.
 * @returns The item under the point, if any, and the deepest region under it.
 */
export function hitTest(layout: MapLayout, x: number, y: number, rows: boolean): { item: MapItem | null; region: MapRegion | null } {
  let region = layout.roots.find(root => contains(root, x, y)) ?? null;
  if (!region) return { item: null, region: null };
  for (;;) {
    const child: MapRegion | undefined = region.children.find(inner => contains(inner, x, y));
    if (!child) break;
    region = child;
  }
  const card = region.items.find(item => contains(item, x, y)) ?? null;
  const row = card && rows ? card.rows.find(item => contains(item, x, y)) ?? null : null;
  return { item: row ?? card, region };
}

/**
 * What stands for an item at a zoom level: the outermost region drawn
 * smaller than `minSize` screen pixels, else the item's card.
 * @param item A card or row.
 * @param zoom Screen pixels per world unit.
 * @param minSize Screen size below which a region stands in for its content.
 */
export function representative(item: MapItem, zoom: number, minSize: number): MapItem | MapRegion {
  for (const region of item.region.chain) {
    if (Math.max(region.w, region.h) * zoom < minSize) return region;
  }
  return item.card ?? item;
}

/** @returns True when `inner` is `outer` or lies inside it. */
export function within(inner: MapRegion, outer: MapRegion): boolean {
  return inner.chain[outer.depth] === outer;
}
