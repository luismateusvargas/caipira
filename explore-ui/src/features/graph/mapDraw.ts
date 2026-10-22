/**
 * Draws a map layout on a 2D canvas. Detail follows the zoom, as on a game
 * map: territories and the routes between them from afar, file cards nearer,
 * symbol names close up. Every label goes through a screen-space occupancy
 * grid, so no two labels ever overlap.
 */
import type { EdgeKind, GraphEdge, GraphNode } from '../../api/schemas';
import { evidenceNotChecked } from '../../api/schemas';
import type { Box, MapItem, MapLayout, MapRegion } from './mapLayout';
import { CARD_HEAD, CARD_W, FACT_H, REGION_HEAD, REGION_PAD, ROW_H, representative, within } from './mapLayout';

/** Screen = world × k + (x, y). */
export interface Viewport {
  x: number;
  y: number;
  k: number;
}

// Canvas cannot read CSS custom properties per draw, so the tokens are read
// once at mount with these as fallbacks.
const TOKEN_NAMES = [
  '--bg-canvas', '--bg-panel', '--bg-elevated', '--bg-hover', '--border-subtle', '--border-crimson',
  '--accent-red-dark', '--accent-red-primary', '--accent-red-bright', '--accent-red-glow', '--accent-red-soft',
  '--text-primary', '--text-secondary', '--text-muted', '--fact-surface', '--route',
  '--edge-calls', '--edge-imports', '--edge-uses-type', '--edge-extends', '--edge-evidences', '--edge-supersedes', '--edge-touched',
  '--kind-function', '--kind-type', '--kind-component', '--kind-value'
] as const;

export type Palette = Record<(typeof TOKEN_NAMES)[number], string>;

const TOKEN_FALLBACKS: Palette = {
  '--bg-canvas': '#0d0e11',
  '--bg-panel': '#14161b',
  '--bg-elevated': '#1c1f26',
  '--bg-hover': '#252932',
  '--border-subtle': '#262a34',
  '--border-crimson': '#5c191d',
  '--accent-red-dark': '#7f1d1d',
  '--accent-red-primary': '#b91c1c',
  '--accent-red-bright': '#dc2626',
  '--accent-red-glow': 'rgba(220, 38, 38, 0.28)',
  '--accent-red-soft': '#fca5a5',
  '--text-primary': '#f3f4f6',
  '--text-secondary': '#9ca3af',
  '--text-muted': '#6b7280',
  '--fact-surface': '#1f1315',
  '--route': 'rgba(203, 213, 225, 0.3)',
  '--edge-calls': '#cbd5e1',
  '--edge-imports': '#7dd3fc',
  '--edge-uses-type': '#fcd34d',
  '--edge-extends': '#c4b5fd',
  '--edge-evidences': '#f87171',
  '--edge-supersedes': '#fca5a5',
  '--edge-touched': '#86efac',
  '--kind-function': '#93c5fd',
  '--kind-type': '#fcd34d',
  '--kind-component': '#c4b5fd',
  '--kind-value': '#9ca3af'
};

/** @returns The design tokens the canvas draws with. */
export function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const palette: Palette = { ...TOKEN_FALLBACKS };
  for (const name of TOKEN_NAMES) {
    const value = style.getPropertyValue(name).trim();
    if (value) palette[name] = value;
  }
  return palette;
}

/** The kinds of link the map can draw; `defines` is shown by a symbol sitting on its file's card. */
export type LinkKind = Exclude<EdgeKind, 'defines'>;

export const LINK_KINDS: readonly LinkKind[] = ['calls', 'imports', 'uses_type', 'extends', 'evidences', 'supersedes', 'touched'];

const LINK_STYLE: Record<LinkKind, { color: keyof Palette; dash: number[]; width: number }> = {
  calls: { color: '--edge-calls', dash: [], width: 1.3 },
  imports: { color: '--edge-imports', dash: [6, 4], width: 1.3 },
  uses_type: { color: '--edge-uses-type', dash: [2, 3], width: 1.3 },
  extends: { color: '--edge-extends', dash: [], width: 1.9 },
  evidences: { color: '--edge-evidences', dash: [], width: 1.5 },
  supersedes: { color: '--edge-supersedes', dash: [6, 3], width: 1.5 },
  touched: { color: '--edge-touched', dash: [1.5, 3.5], width: 1.4 }
};

const TYPE_KINDS = new Set(['struct', 'class', 'interface', 'trait', 'enum', 'type', 'union']);

/** @returns How a symbol kind is drawn: its glyph and colour token. */
export function symbolGlyph(kind: string): { shape: 'circle' | 'square' | 'diamond' | 'bar'; color: keyof Palette } {
  if (TYPE_KINDS.has(kind)) return { shape: 'square', color: '--kind-type' };
  if (kind === 'component') return { shape: 'diamond', color: '--kind-component' };
  if (kind === 'const' || kind === 'variable') return { shape: 'bar', color: '--kind-value' };
  return { shape: 'circle', color: '--kind-function' };
}

/** A graph edge between two map items. */
export interface MapEdge {
  source: MapItem;
  target: MapItem;
  kind: LinkKind;
  /** Both ends lie in the same top-level region: code to code, or knowledge to knowledge. */
  local: boolean;
}

/** A layout with its edges resolved to items. */
export interface Scene {
  layout: MapLayout;
  edges: MapEdge[];
  /** Edge indexes by the node id at either end. */
  incident: ReadonlyMap<string, number[]>;
}

/**
 * @param layout The map.
 * @param edges The graph's edges; those to nodes off the map are dropped.
 */
export function buildScene(layout: MapLayout, edges: readonly GraphEdge[]): Scene {
  const resolved: MapEdge[] = [];
  const incident = new Map<string, number[]>();
  const note = (id: string, index: number) => {
    const list = incident.get(id);
    if (list) list.push(index);
    else incident.set(id, [index]);
  };
  for (const edge of edges) {
    if (edge.kind === 'defines') continue;
    const source = layout.byId.get(edge.source);
    const target = layout.byId.get(edge.target);
    if (!source || !target || source === target) continue;
    const index = resolved.length;
    resolved.push({ source, target, kind: edge.kind, local: source.region.chain[0] === target.region.chain[0] });
    note(edge.source, index);
    note(edge.target, index);
  }
  return { layout, edges: resolved, incident };
}

/** What the pointer or selection lights up. */
export interface Focus {
  /** Items drawn at full strength: the focus, what it links to, and their cards. */
  lit: Set<MapItem>;
  /** Items to name with a callout when their own label is too small to read. */
  named: MapItem[];
  /** Links drawn individually, from the focused side. */
  links: { from: MapItem; to: MapItem; kind: LinkKind }[];
  /** A hovered region's links, aggregated by what stands for the far end. */
  routes: Route[];
  region: MapRegion | null;
}

/** Links aggregated between two places on the map. */
export interface Route {
  a: MapItem | MapRegion;
  b: MapItem | MapRegion;
  count: number;
}

/** On screen, a region smaller than this stands for everything inside it. */
export const STAND_IN_PX = 130;
const MAX_ROUTES = 160;
const MAX_LINKS = 500;
const MAX_ALL_LINKS = 1500;
const MAX_CALLOUTS = 40;

function isRegion(place: MapItem | MapRegion): place is MapRegion {
  return 'chain' in place;
}

/**
 * @returns The region that stands for an item at a zoom level: the outermost
 *   one drawn smaller than {@link STAND_IN_PX}, else the item's own region.
 */
export function regionFor(item: MapItem, zoom: number): MapRegion {
  const place = representative(item, zoom, STAND_IN_PX);
  return isRegion(place) ? place : item.region;
}

/**
 * Edges within one top-level region, aggregated between the regions that
 * stand for their ends at a zoom level: whole areas from afar, single
 * directories close up.
 * @param scene The scene.
 * @param zoom Screen pixels per world unit.
 * @param kinds Link kinds to include.
 * @returns Routes, heaviest first.
 */
export function aggregateRoutes(scene: Scene, zoom: number, kinds: ReadonlySet<LinkKind>): Route[] {
  const routes = new Map<string, Route>();
  for (const edge of scene.edges) {
    if (!edge.local || !kinds.has(edge.kind)) continue;
    const a = regionFor(edge.source, zoom);
    const b = regionFor(edge.target, zoom);
    if (within(a, b) || within(b, a)) continue;
    const id = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const known = routes.get(id);
    if (known) known.count++;
    else routes.set(id, { a, b, count: 1 });
  }
  return [...routes.values()].sort((x, y) => y.count - x.count);
}

/**
 * @returns What the hovered item, else the selection, else the hovered
 *   region lights up; null when nothing is in focus.
 */
export function focusOf(scene: Scene, hoverItem: MapItem | null, selected: MapItem | null, hoverRegion: MapRegion | null, kinds: ReadonlySet<LinkKind>, zoom: number): Focus | null {
  const item = hoverItem ?? selected;
  if (item) {
    // A card brings its rows: a file is in focus with all its symbols.
    const own = new Set<MapItem>([item, ...item.rows]);
    const lit = new Set<MapItem>(own);
    if (item.card) lit.add(item.card);
    const named: MapItem[] = [item];
    const links: Focus['links'] = [];
    const seen = new Set<number>();
    for (const member of own) {
      for (const index of scene.incident.get(member.node.id) ?? []) {
        const edge = scene.edges[index];
        if (!edge || seen.has(index) || !kinds.has(edge.kind) || links.length >= MAX_LINKS) continue;
        seen.add(index);
        links.push({ from: edge.source, to: edge.target, kind: edge.kind });
        const other = own.has(edge.source) ? edge.target : edge.source;
        if (!lit.has(other)) {
          lit.add(other);
          named.push(other);
        }
        if (other.card) lit.add(other.card);
      }
    }
    return { lit, named, links, routes: [], region: null };
  }
  if (hoverRegion) {
    // Each link leaving the region, gathered by what stands for its far end.
    const inside = (target: MapItem) => within(target.region, hoverRegion);
    const merged = new Map<MapItem | MapRegion, Route>();
    for (const edge of scene.edges) {
      if (!kinds.has(edge.kind)) continue;
      const sourceInside = inside(edge.source);
      if (sourceInside === inside(edge.target)) continue;
      const outside = sourceInside ? edge.target : edge.source;
      let far = representative(outside, zoom, STAND_IN_PX);
      if (isRegion(far) && within(hoverRegion, far)) far = outside.card ?? outside;
      const known = merged.get(far);
      if (known) known.count++;
      else merged.set(far, { a: hoverRegion, b: far, count: 1 });
    }
    const lit = new Set<MapItem>();
    const named: MapItem[] = [];
    for (const place of merged.keys()) {
      if (isRegion(place)) continue;
      lit.add(place);
      named.push(place);
    }
    return { lit, named, links: [], routes: [...merged.values()].sort((x, y) => y.count - x.count), region: hoverRegion };
  }
  return null;
}

// ── geometry ──

interface Point {
  x: number;
  y: number;
}

const center = (box: Box): Point => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

/** Where a line toward `toward` leaves the box; rows attach at their left or right end. */
function anchor(box: Box, row: boolean, toward: Point): Point {
  const c = center(box);
  if (row) return { x: toward.x >= c.x ? box.x + box.w : box.x, y: c.y };
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(Math.abs(box.w / 2 / (dx || 1e-9)), Math.abs(box.h / 2 / (dy || 1e-9)));
  return { x: c.x + dx * Math.min(1, scale), y: c.y + dy * Math.min(1, scale) };
}

// ── labels ──

/** Screen cells claimed by labels drawn so far. */
class Occupancy {
  private readonly cells: Uint8Array;
  private readonly columns: number;
  private readonly rows: number;

  constructor(width: number, height: number, private readonly size = 6) {
    this.columns = Math.max(1, Math.ceil(width / size));
    this.rows = Math.max(1, Math.ceil(height / size));
    this.cells = new Uint8Array(this.columns * this.rows);
  }

  /** Claims the rectangle when none of it is taken. Off-screen parts are free. */
  claim(x: number, y: number, w: number, h: number): boolean {
    const x0 = Math.max(0, Math.floor(x / this.size));
    const y0 = Math.max(0, Math.floor(y / this.size));
    const x1 = Math.min(this.columns - 1, Math.floor((x + w) / this.size));
    const y1 = Math.min(this.rows - 1, Math.floor((y + h) / this.size));
    for (let row = y0; row <= y1; row++) {
      for (let column = x0; column <= x1; column++) if (this.cells[row * this.columns + column]) return false;
    }
    for (let row = y0; row <= y1; row++) this.cells.fill(1, row * this.columns + x0, row * this.columns + x1 + 1);
    return true;
  }
}

const SANS = 'Inter, "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Fira Code", ui-monospace, monospace';

// Character widths are estimated rather than measured: thousands of labels
// are fitted per frame.
const charWidth = (px: number, mono: boolean) => px * (mono ? 0.6 : 0.56);

/** @returns The text cut with an ellipsis to fit `width` screen pixels. */
export function fitText(text: string, width: number, px: number, mono = false): string {
  const max = Math.floor(width / charWidth(px, mono));
  if (max <= 1) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** @returns Up to `lines` lines of `text` wrapped at word breaks to fit `width`. */
function wrap(text: string, width: number, px: number, lines: number): string[] {
  const max = Math.max(1, Math.floor(width / charWidth(px, false)));
  const out: string[] = [];
  let line = '';
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    const next = line ? `${line} ${word}` : word;
    if (next.length <= max || !line) { line = next; continue; }
    // The last line takes the rest and ends in an ellipsis.
    if (out.length === lines - 1) {
      line = `${line} ${words.slice(i).join(' ')}`;
      break;
    }
    out.push(line);
    line = word;
  }
  if (line) out.push(line);
  return out.map(text => fitText(text, width, px));
}

function shortLabel(node: GraphNode): string {
  return node.type === 'fact' ? `#${node.factId} ${node.label}` : node.label;
}

function countsLine(region: MapRegion): string {
  const { file, symbol, fact, session } = region.counts;
  const parts: string[] = [];
  if (file) parts.push(`${file} file${file === 1 ? '' : 's'}`);
  if (symbol) parts.push(`${symbol} symbol${symbol === 1 ? '' : 's'}`);
  if (fact) parts.push(`${fact} fact${fact === 1 ? '' : 's'}`);
  if (session) parts.push(`${session} session${session === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** @returns The hover line for a region. */
export function describeRegion(region: MapRegion): string {
  const name = region.kind === 'directory' ? `${region.path}/` : region.kind === 'category' ? `${region.label} facts` : region.label;
  return `${name} · ${countsLine(region) || 'empty'}`;
}

// ── drawing ──

export interface DrawState {
  viewport: Viewport;
  width: number;
  height: number;
  dpr: number;
  palette: Palette;
  hoverItem: MapItem | null;
  hoverRegion: MapRegion | null;
  selected: MapItem | null;
  kinds: ReadonlySet<LinkKind>;
  /** Draw the routes between regions when nothing is in focus. */
  routes: boolean;
  /**
   * Draw every link, as for a blast radius small enough to read whole; then
   * only a hover dims the rest.
   */
  allLinks: boolean;
}

/** Zoom thresholds, in screen pixels, at which detail appears. */
const READABLE = { cardTitle: 11, rowBar: 2.5, rowText: 10, factText: 22, regionLabel: 44 };

/** @returns True when the item's own label is drawn at this zoom. */
export function labelReadable(item: MapItem, zoom: number): boolean {
  if (item.card) return ROW_H * zoom >= READABLE.rowText;
  if (item.node.type === 'fact' || item.node.type === 'session') return Math.min(item.h, FACT_H) * zoom >= READABLE.factText;
  return CARD_HEAD * zoom >= READABLE.cardTitle;
}

/** @returns True when symbol rows are large enough on screen to point at. */
export function rowsHittable(zoom: number): boolean {
  return ROW_H * zoom >= 6;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function glyph(ctx: CanvasRenderingContext2D, shape: ReturnType<typeof symbolGlyph>['shape'], x: number, y: number, size: number): void {
  ctx.beginPath();
  switch (shape) {
    case 'circle': ctx.arc(x, y, size / 2, 0, Math.PI * 2); break;
    case 'square': ctx.rect(x - size / 2, y - size / 2, size, size); break;
    case 'diamond':
      ctx.moveTo(x, y - size / 2 - 1);
      ctx.lineTo(x + size / 2 + 1, y);
      ctx.lineTo(x, y + size / 2 + 1);
      ctx.lineTo(x - size / 2 - 1, y);
      ctx.closePath();
      break;
    case 'bar': ctx.rect(x - size / 2, y - 1, size, 2); break;
  }
  ctx.fill();
}

/**
 * Draws the whole map for one frame.
 * @param ctx A 2D context sized width × dpr by height × dpr.
 * @param scene The laid-out graph.
 * @param state Viewport, palette, focus and link filters.
 */
export function drawMap(ctx: CanvasRenderingContext2D, scene: Scene, state: DrawState): void {
  const { viewport: v, palette, width, height } = state;
  const k = v.k;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.fillStyle = palette['--bg-canvas'];
  ctx.fillRect(0, 0, width, height);

  const sx = (x: number) => x * k + v.x;
  const sy = (y: number) => y * k + v.y;
  const left = -v.x / k;
  const top = -v.y / k;
  const right = left + width / k;
  const bottom = top + height / k;
  const onScreen = (box: Box) => box.x < right && box.x + box.w > left && box.y < bottom && box.y + box.h > top;
  // A route can cross the screen with both ends off it.
  const crossesScreen = (a: Box, b: Box) => Math.min(a.x, b.x) < right && Math.max(a.x + a.w, b.x + b.w) > left
    && Math.min(a.y, b.y) < bottom && Math.max(a.y + a.h, b.y + b.h) > top;
  const { layout } = scene;
  const focus = focusOf(scene, state.hoverItem, state.selected, state.hoverRegion, state.kinds, k);
  const dimming = focus !== null && focus.region === null && (!state.allLinks || state.hoverItem !== null);
  const dim = (item: MapItem) => (dimming && !focus?.lit.has(item) ? 0.28 : 1);

  // Territories, outermost first.
  for (const region of layout.regions) {
    if (!onScreen(region) || Math.max(region.w, region.h) * k < 2) continue;
    const x = sx(region.x);
    const y = sy(region.y);
    const w = region.w * k;
    const h = region.h * k;
    const lightness = 9 + Math.min(region.depth, 4) * 2.4;
    roundRect(ctx, x, y, w, h, Math.min(10, Math.max(2, 9 * k)));
    ctx.fillStyle = `hsla(${region.hue}, ${region.saturation}%, ${lightness}%, ${region.depth === 0 ? 0.5 : 0.62})`;
    ctx.fill();
    const hovered = focus?.region === region;
    ctx.strokeStyle = hovered ? palette['--accent-red-soft'] : `hsla(${region.hue}, ${region.saturation + 10}%, ${30 + Math.min(region.depth, 3) * 5}%, 0.9)`;
    ctx.lineWidth = hovered ? 2 : region.depth === 0 ? 1.5 : 1;
    ctx.stroke();
    if (REGION_HEAD * k >= 3) {
      ctx.save();
      roundRect(ctx, x, y, w, h, Math.min(10, Math.max(2, 9 * k)));
      ctx.clip();
      ctx.fillStyle = `hsla(${region.hue}, ${region.saturation}%, ${lightness + 4}%, 0.75)`;
      ctx.fillRect(x, y, w, REGION_HEAD * k);
      ctx.restore();
    }
  }

  // Cards, then the rows on them.
  const rowBars = ROW_H * k >= READABLE.rowBar;
  const rowText = ROW_H * k >= READABLE.rowText;
  for (const item of layout.items) {
    if (item.card || !onScreen(item) || Math.max(item.w, item.h) * k < 1.5) continue;
    const x = sx(item.x);
    const y = sy(item.y);
    const w = item.w * k;
    const h = item.h * k;
    const node = item.node;
    ctx.globalAlpha = dim(item);
    roundRect(ctx, x, y, w, h, Math.min(6, Math.max(1, 5 * k)));
    switch (node.type) {
      case 'file':
      case 'symbol':
        ctx.fillStyle = palette['--bg-elevated'];
        ctx.fill();
        ctx.strokeStyle = node.type === 'file' && !node.indexed ? palette['--text-muted'] : palette['--border-subtle'];
        ctx.setLineDash(node.type === 'file' && !node.indexed ? [3, 2] : []);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        if (item.rows.length > 0 && CARD_HEAD * k >= 4) {
          ctx.fillStyle = palette['--border-subtle'];
          ctx.fillRect(x + 1, y + CARD_HEAD * k - 0.5, w - 2, 1);
          // Long files wrap their symbols into columns.
          for (let column = 1; column * CARD_W < item.w; column++) ctx.fillRect(x + column * CARD_W * k - 0.5, y + CARD_HEAD * k, 1, h - CARD_HEAD * k - 2);
        }
        break;
      case 'fact': {
        const superseded = node.state === 'superseded';
        ctx.fillStyle = superseded ? palette['--bg-hover'] : palette['--fact-surface'];
        ctx.fill();
        ctx.strokeStyle = node.drifted ? palette['--accent-red-bright'] : superseded ? palette['--border-subtle'] : palette['--border-crimson'];
        // Dashed, like a file the index has not read: evidence not checked.
        ctx.setLineDash(evidenceNotChecked(node) ? [3, 2] : []);
        ctx.lineWidth = node.drifted ? 1.6 : 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = node.drifted ? palette['--accent-red-bright'] : superseded ? palette['--text-muted'] : palette['--accent-red-primary'];
        ctx.fillRect(x, y + Math.min(3, h / 4), Math.max(1.5, 3 * k), h - Math.min(6, h / 2));
        break;
      }
      case 'session':
        ctx.fillStyle = palette['--bg-hover'];
        ctx.fill();
        ctx.strokeStyle = palette['--border-subtle'];
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = palette['--edge-touched'];
        ctx.globalAlpha *= 0.7;
        ctx.fillRect(x, y + Math.min(3, h / 4), Math.max(1.5, 3 * k), h - Math.min(6, h / 2));
        break;
    }
    if (rowBars && !rowText) {
      // From afar, rows read like the lines of a code minimap.
      for (const row of item.rows) {
        if (row.node.type !== 'symbol') continue;
        ctx.globalAlpha = dim(row) * 0.6;
        ctx.fillStyle = palette[symbolGlyph(row.node.kind).color];
        const barW = Math.min(row.w - 16, 14 + row.node.label.length * 6.5) * k;
        ctx.fillRect(sx(row.x + 8), sy(row.y + ROW_H * 0.32), barW, Math.max(1, ROW_H * 0.36 * k));
      }
    }
  }
  ctx.globalAlpha = 1;

  // Links: the focus's own, else the routes between places.
  const edgeAlpha = (count: number) => Math.min(0.85, 0.35 + Math.log2(count + 1) * 0.08);
  const curve = (from: Point, to: Point, color: string, lineWidth: number, dash: number[], arrow: boolean, alpha: number) => {
    const a = { x: sx(from.x), y: sy(from.y) };
    const b = { x: sx(to.x), y: sy(to.y) };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) return;
    const bend = Math.min(90, dist * 0.16);
    const c = { x: (a.x + b.x) / 2 - (dy / dist) * bend, y: (a.y + b.y) / 2 + (dx / dist) * bend };
    if (Math.max(a.x, b.x, c.x) < 0 || Math.min(a.x, b.x, c.x) > width || Math.max(a.y, b.y, c.y) < 0 || Math.min(a.y, b.y, c.y) > height) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!arrow || dist < 14) return;
    const tx = b.x - c.x;
    const ty = b.y - c.y;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl;
    const uy = ty / tl;
    const size = 4 + lineWidth;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * size - uy * size * 0.55, b.y - uy * size + ux * size * 0.55);
    ctx.lineTo(b.x - ux * size + uy * size * 0.55, b.y - uy * size - ux * size * 0.55);
    ctx.closePath();
    ctx.fill();
  };
  const placeBox = (place: MapItem | MapRegion): { box: Box; row: boolean } => ({ box: place, row: !isRegion(place) && place.card !== null && rowText });
  const drawRoute = (route: Route, color: string, alpha: number) => {
    const a = placeBox(route.a);
    const b = placeBox(route.b);
    const from = anchor(a.box, a.row, center(b.box));
    const to = anchor(b.box, b.row, center(a.box));
    curve(from, to, color, Math.min(7, 0.8 + Math.log2(route.count + 1) * 0.9), [], false, alpha);
  };

  const link = (source: MapItem, target: MapItem, kind: LinkKind, alpha: number) => {
    const style = LINK_STYLE[kind];
    // A row too small to read stands in through its card.
    const from = !rowText && source.card ? source.card : source;
    const to = !rowText && target.card ? target.card : target;
    if (from === to) return;
    const a = anchor(from, from.card !== null, center(to));
    const b = anchor(to, to.card !== null, center(from));
    curve(a, b, palette[style.color], style.width + (k > 1 ? 0.3 : 0), style.dash, true, alpha);
  };
  if (state.allLinks && (!focus || focus.region === null)) {
    let drawn = 0;
    for (const edge of scene.edges) {
      if (drawn >= MAX_ALL_LINKS) break;
      if (!state.kinds.has(edge.kind)) continue;
      link(edge.source, edge.target, edge.kind, dimming ? 0.12 : 0.55);
      drawn++;
    }
  }
  if (focus && focus.region === null) {
    for (const own of focus.links) link(own.from, own.to, own.kind, 0.92);
  } else if (focus) {
    for (const route of focus.routes.slice(0, MAX_ROUTES)) drawRoute(route, palette['--accent-red-soft'], edgeAlpha(route.count));
  } else if (state.routes && !state.allLinks) {
    const visible = aggregateRoutes(scene, k, state.kinds).filter(route => crossesScreen(route.a, route.b));
    for (const route of visible.slice(0, MAX_ROUTES)) drawRoute(route, palette['--route'], 1);
  }
  ctx.globalAlpha = 1;

  // Labels. Callouts claim space first, then territories, then cards.
  const occupied = new Occupancy(width, height);
  const callouts: { text: string; x: number; y: number; w: number; h: number; color: string }[] = [];
  if (focus) {
    for (const item of focus.named) {
      if (callouts.length >= MAX_CALLOUTS) break;
      if (labelReadable(item, k)) {
        // Readable already: keep its own label clear of other callouts.
        occupied.claim(sx(item.x), sy(item.y), item.w * k, Math.min(item.h, CARD_HEAD) * k);
        continue;
      }
      const text = fitText(shortLabel(item.node), 260, 11);
      const w = text.length * charWidth(11, false) + 14;
      const h = 20;
      const c = { x: sx(item.x + item.w / 2), y: sy(item.y + item.h / 2) };
      const spots = [{ x: c.x - w / 2, y: c.y - h - 6 }, { x: c.x - w / 2, y: c.y + 6 }, { x: c.x + 8, y: c.y - h / 2 }, { x: c.x - w - 8, y: c.y - h / 2 }];
      const spot = spots.find(at => at.x > -w && at.x < width && at.y > -h && at.y < height && occupied.claim(at.x, at.y, w, h));
      if (!spot) continue;
      const own = item === (state.hoverItem ?? state.selected);
      callouts.push({ text, x: spot.x, y: spot.y, w, h, color: own ? palette['--accent-red-bright'] : palette['--border-crimson'] });
    }
  }

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const halo = (text: string, x: number, y: number) => {
    ctx.strokeStyle = palette['--bg-canvas'];
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  };

  const labelled = layout.regions
    .filter(region => onScreen(region) && region.w * k >= READABLE.regionLabel)
    .sort((a, b) => a.depth - b.depth || b.w * b.h - a.w * a.h);
  for (const region of labelled) {
    // A header band tall enough holds its label; from afar the label floats
    // over the region at its own size and gives way to any it would cover.
    const band = REGION_HEAD * k;
    const nominal = region.depth === 0 ? 15 : region.depth === 1 ? 13 : 12;
    const inBand = band - 4 >= 10;
    const px = inBand ? Math.min(nominal, band - 4) : nominal;
    const weight = region.depth <= 1 ? 700 : 600;
    const x = sx(region.x) + Math.max(8, REGION_PAD * k * 0.7);
    const room = region.w * k - (x - sx(region.x)) - 8;
    const text = fitText(region.label, room, px);
    if (!text) continue;
    const textW = text.length * charWidth(px, false);
    const y = sy(region.y) + (inBand ? band / 2 : px / 2 + 5);
    if (!occupied.claim(x - 2, y - px / 2 - 2, textW + 4, px + 4)) continue;
    ctx.font = `${weight} ${px}px ${SANS}`;
    ctx.fillStyle = `hsl(${region.hue}, ${Math.min(70, region.saturation + 30)}%, 80%)`;
    if (inBand) ctx.fillText(text, x, y);
    else halo(text, x, y);
    const counts = countsLine(region);
    const spare = room - textW - 12;
    if (counts && spare > 70 && inBand) {
      const smallPx = Math.min(11, px);
      const small = fitText(counts, spare, smallPx);
      ctx.font = `400 ${smallPx}px ${SANS}`;
      ctx.fillStyle = palette['--text-muted'];
      ctx.fillText(small, x + textW + 12, y);
    }
  }

  // Card titles and row names.
  for (const item of layout.items) {
    if (item.card || !onScreen(item) || !labelReadable(item, k)) continue;
    const node = item.node;
    const x = sx(item.x);
    const y = sy(item.y);
    const w = item.w * k;
    ctx.globalAlpha = dim(item);
    if (node.type === 'fact' || node.type === 'session') {
      const h = item.h * k;
      const px = Math.min(13, Math.max(10, h * 0.22));
      const lines = Math.floor((h - 8) / (px * 1.3));
      const inner = w - 12 - 3 * k;
      const textX = x + 8 + 3 * k;
      let lineY = y + 6 + px * 0.65;
      const line = (text: string, font: string, color: string) => {
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.fillText(text, textX, lineY);
        lineY += px * 1.3;
      };
      if (node.type === 'session') {
        line(fitText(node.label, inner, px), `500 ${px}px ${SANS}`, palette['--text-primary']);
        if (lines >= 2 && node.summary) line(fitText(node.summary, inner, px - 1), `400 ${px - 1}px ${SANS}`, palette['--text-secondary']);
        continue;
      }
      // Facts: a status line when there is room, then the title on up to two lines.
      const meta = lines >= 3;
      if (meta) {
        const status = `#${node.factId} · ${node.drifted ? 'needs review' : node.state.replace('_', ' ')}${evidenceNotChecked(node) ? ' · not checked' : ''}`;
        line(fitText(status.toUpperCase(), inner, px - 2), `600 ${px - 2}px ${SANS}`, node.drifted ? palette['--accent-red-soft'] : palette['--text-muted']);
      }
      const color = node.state === 'superseded' ? palette['--text-muted'] : palette['--text-primary'];
      for (const text of wrap(node.label, inner, px, Math.max(1, Math.min(2, lines - (meta ? 1 : 0))))) line(text, `500 ${px}px ${SANS}`, color);
      continue;
    }
    const px = Math.min(13, Math.max(10, CARD_HEAD * k * 0.46));
    const headY = y + (CARD_HEAD * k) / 2;
    let textX = x + 8;
    if (node.type === 'symbol') {
      const shape = symbolGlyph(node.kind);
      ctx.fillStyle = palette[shape.color];
      glyph(ctx, shape.shape, textX + px * 0.3, headY, px * 0.6);
      textX += px;
    }
    const language = node.type === 'file' ? node.language : node.kind;
    const tag = language && w > 150 ? language : '';
    const tagW = tag ? tag.length * charWidth(10, true) + 8 : 0;
    ctx.font = `600 ${px}px ${SANS}`;
    ctx.fillStyle = node.type === 'file' && !node.indexed ? palette['--text-secondary'] : palette['--text-primary'];
    ctx.fillText(fitText(node.label, w - (textX - x) - tagW - 8, px), textX, headY);
    if (tag) {
      ctx.font = `400 10px ${MONO}`;
      ctx.fillStyle = palette['--text-muted'];
      ctx.textAlign = 'right';
      ctx.fillText(tag, x + w - 8, headY);
      ctx.textAlign = 'left';
    }
    if (!rowText) continue;
    const rowPx = Math.min(12.5, Math.max(9, ROW_H * k * 0.66));
    for (const row of item.rows) {
      if (row.node.type !== 'symbol' || !onScreen(row)) continue;
      const rowX = sx(row.x);
      const rowW = row.w * k;
      const rowY = sy(row.y + ROW_H / 2);
      ctx.globalAlpha = dim(row);
      if (row === state.selected || row === state.hoverItem) {
        ctx.fillStyle = row === state.selected ? palette['--accent-red-dark'] : palette['--bg-hover'];
        ctx.fillRect(rowX + 1, sy(row.y), rowW - 2, ROW_H * k);
      }
      const shape = symbolGlyph(row.node.kind);
      ctx.fillStyle = palette[shape.color];
      glyph(ctx, shape.shape, rowX + 8 + rowPx * 0.3, rowY, rowPx * 0.55);
      const callers = row.node.callers > 0 ? String(row.node.callers) : '';
      const callersW = callers ? callers.length * charWidth(10, true) + 10 : 0;
      ctx.font = `400 ${rowPx}px ${MONO}`;
      ctx.fillStyle = row.node.isPublic ? palette['--text-primary'] : palette['--text-secondary'];
      ctx.fillText(fitText(row.node.label, rowW - 16 - rowPx - callersW, rowPx, true), rowX + 8 + rowPx, rowY);
      if (callers) {
        ctx.font = `400 10px ${MONO}`;
        ctx.fillStyle = palette['--text-muted'];
        ctx.textAlign = 'right';
        ctx.fillText(callers, rowX + rowW - 8, rowY);
        ctx.textAlign = 'left';
      }
    }
  }
  ctx.globalAlpha = 1;

  // Selection and hover rings over everything but the callouts.
  const ring = (item: MapItem, color: string, lineWidth: number, glow: boolean) => {
    const box = !rowText && item.card ? item.card : item;
    if (!onScreen(box)) return;
    roundRect(ctx, sx(box.x) - 3, sy(box.y) - 3, box.w * k + 6, box.h * k + 6, 7);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (glow) {
      ctx.shadowColor = palette['--accent-red-glow'];
      ctx.shadowBlur = 16;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  };
  if (state.hoverItem && state.hoverItem !== state.selected) ring(state.hoverItem, palette['--text-secondary'], 1.5, false);
  if (state.selected) ring(state.selected, palette['--accent-red-bright'], 2.5, true);

  for (const callout of callouts) {
    roundRect(ctx, callout.x, callout.y, callout.w, callout.h, 6);
    ctx.fillStyle = palette['--bg-panel'];
    ctx.globalAlpha = 0.94;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = callout.color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = `500 11px ${SANS}`;
    ctx.fillStyle = palette['--text-primary'];
    ctx.fillText(callout.text, callout.x + 7, callout.y + callout.h / 2);
  }
}

/**
 * Draws the pulsing ring around facts that need review; cheap enough to run
 * every frame over a cached copy of the map.
 * @returns True when any pulsing fact is on screen.
 */
export function drawPulse(ctx: CanvasRenderingContext2D, scene: Scene, viewport: Viewport, width: number, height: number, dpr: number, time: number, palette: Palette): boolean {
  const k = viewport.k;
  const phase = (Math.sin(time / 280) + 1) / 2;
  let any = false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const item of scene.layout.items) {
    if (item.node.type !== 'fact' || !item.node.drifted) continue;
    const x = item.x * k + viewport.x;
    const y = item.y * k + viewport.y;
    const w = item.w * k;
    const h = item.h * k;
    if (x > width || y > height || x + w < 0 || y + h < 0 || Math.max(w, h) < 3) continue;
    any = true;
    const grow = 2 + phase * 4;
    roundRect(ctx, x - grow, y - grow, w + grow * 2, h + grow * 2, 7 + grow);
    ctx.globalAlpha = 0.25 + (1 - phase) * 0.45;
    ctx.strokeStyle = palette['--accent-red-bright'];
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return any;
}

/** How the minimap maps world units onto its own pixels. */
export interface MinimapTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** @returns The transform that fits the whole map in a `width` × `height` minimap. */
export function minimapTransform(layout: MapLayout, width: number, height: number): MinimapTransform {
  const pad = 6;
  const { bounds } = layout;
  const scale = Math.min((width - pad * 2) / Math.max(1, bounds.w), (height - pad * 2) / Math.max(1, bounds.h));
  return {
    scale,
    offsetX: (width - bounds.w * scale) / 2 - bounds.x * scale,
    offsetY: (height - bounds.h * scale) / 2 - bounds.y * scale
  };
}

/** Draws the overview: territories, drifted facts, and the visible area. */
export function drawMinimap(ctx: CanvasRenderingContext2D, layout: MapLayout, viewport: Viewport, stage: { width: number; height: number }, size: { width: number; height: number }, dpr: number, palette: Palette): void {
  const t = minimapTransform(layout, size.width, size.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  for (const region of layout.regions) {
    if (region.depth > 2) continue;
    const w = region.w * t.scale;
    const h = region.h * t.scale;
    if (Math.max(w, h) < 1) continue;
    ctx.fillStyle = `hsla(${region.hue}, ${region.saturation + 6}%, ${16 + region.depth * 6}%, 0.9)`;
    ctx.fillRect(region.x * t.scale + t.offsetX, region.y * t.scale + t.offsetY, w, h);
  }
  ctx.fillStyle = palette['--accent-red-bright'];
  for (const item of layout.items) {
    if (item.node.type !== 'fact' || !item.node.drifted) continue;
    ctx.fillRect(item.x * t.scale + t.offsetX, item.y * t.scale + t.offsetY, Math.max(1.5, item.w * t.scale), Math.max(1.5, item.h * t.scale));
  }
  const k = viewport.k;
  const x = (-viewport.x / k) * t.scale + t.offsetX;
  const y = (-viewport.y / k) * t.scale + t.offsetY;
  ctx.strokeStyle = palette['--text-primary'];
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, (stage.width / k) * t.scale, (stage.height / k) * t.scale);
}
