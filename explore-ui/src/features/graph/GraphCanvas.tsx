import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Crosshair, Maximize2, Minus, Plus } from 'lucide-react';
import type { EdgeKind, GraphNode, GraphPayload, GraphView } from '../../api/schemas';
import { bounds, createSimulation, isSettled, reheat, tick } from './forceLayout';
import type { Simulation } from './forceLayout';

/** Props for {@link GraphCanvas}. */
export interface GraphCanvasProps {
  /** The graph to lay out and draw. */
  graph: GraphPayload;
  /** The selected node id, highlighted and kept in view. */
  selectedId: string | null;
  /** Called with a clicked node, or null for a click on empty canvas. */
  onSelect: (node: GraphNode | null) => void;
  /** The active view pill. */
  view: GraphView;
  /** Called when a view pill is chosen. */
  onViewChange: (view: GraphView) => void;
  /** Whether a symbol is selected, which the Blast Radius view needs. */
  canFocus: boolean;
}

type NodeType = GraphNode['type'];

const VIEW_PILLS: readonly { view: GraphView; label: string }[] = [
  { view: 'unified', label: 'Unified Graph' },
  { view: 'architecture', label: 'Code Architecture' },
  { view: 'knowledge', label: 'Knowledge Brain' },
  { view: 'impact', label: 'Blast Radius' }
];

const LEGEND: readonly { type: NodeType; label: string }[] = [
  { type: 'file', label: 'Files' },
  { type: 'symbol', label: 'Symbols' },
  { type: 'fact', label: 'Facts' },
  { type: 'session', label: 'Sessions' }
];

const TYPE_KINDS = new Set(['struct', 'class', 'interface', 'trait', 'enum', 'type', 'union']);

// Canvas cannot read CSS custom properties per draw, so the tokens are read
// once at mount with these as fallbacks.
const TOKEN_NAMES = [
  '--bg-canvas', '--bg-elevated', '--bg-hover', '--border-subtle', '--border-crimson',
  '--accent-red-dark', '--accent-red-primary', '--accent-red-bright', '--accent-red-glow', '--accent-red-soft',
  '--text-primary', '--text-secondary', '--text-muted', '--slate-node', '--slate-edge'
] as const;

type Palette = Record<(typeof TOKEN_NAMES)[number], string>;

const TOKEN_FALLBACKS: Palette = {
  '--bg-canvas': '#0d0e11',
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
  '--slate-node': '#334155',
  '--slate-edge': '#3f4654'
};

function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const palette: Palette = { ...TOKEN_FALLBACKS };
  for (const name of TOKEN_NAMES) {
    const value = style.getPropertyValue(name).trim();
    if (value) palette[name] = value;
  }
  return palette;
}

function edgeStyle(kind: EdgeKind, palette: Palette): { color: string; dash: number[]; width: number } {
  switch (kind) {
    case 'calls': return { color: palette['--slate-edge'], dash: [], width: 1 };
    case 'imports': return { color: palette['--border-subtle'], dash: [4, 4], width: 1 };
    case 'defines': return { color: palette['--border-subtle'], dash: [], width: 0.8 };
    case 'uses_type': return { color: palette['--text-muted'], dash: [2, 3], width: 1 };
    case 'extends': return { color: palette['--text-secondary'], dash: [], width: 1.4 };
    case 'evidences': return { color: palette['--accent-red-primary'], dash: [], width: 1.3 };
    case 'supersedes': return { color: palette['--accent-red-bright'], dash: [6, 4], width: 1.3 };
    case 'touched': return { color: palette['--text-muted'], dash: [2, 5], width: 0.9 };
  }
}

function nodeRadius(node: GraphNode): number {
  switch (node.type) {
    case 'file': return 9;
    case 'symbol': return 4 + Math.min(9, Math.sqrt(node.callers) * 2);
    case 'fact': return 10;
    case 'session': return 6;
  }
}

interface Scene {
  sim: Simulation;
  nodes: GraphNode[];
  edges: { source: number; target: number; kind: EdgeKind }[];
  neighbors: Map<string, Set<string>>;
  hasDrift: boolean;
}

interface Viewport {
  x: number;
  y: number;
  k: number;
}

interface Drag {
  pointerId: number;
  index: number | null;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

function buildScene(graph: GraphPayload, previous: Scene | null): Scene {
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of previous?.sim.nodes ?? []) positions.set(node.id, { x: node.x, y: node.y });
  const sim = createSimulation(graph.nodes.map(node => ({ id: node.id, radius: nodeRadius(node) })), graph.edges, positions);
  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = neighbors.get(a) ?? new Set<string>();
    set.add(b);
    neighbors.set(a, set);
  };
  const edges: Scene['edges'] = [];
  for (const edge of graph.edges) {
    const source = sim.index.get(edge.source);
    const target = sim.index.get(edge.target);
    if (source === undefined || target === undefined) continue;
    edges.push({ source, target, kind: edge.kind });
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  return { sim, nodes: graph.nodes, edges, neighbors, hasDrift: graph.nodes.some(node => node.type === 'fact' && node.drifted) };
}

function polygon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sides: number, rotation: number): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i * 2 * Math.PI) / sides;
    const px = x + r * Math.cos(angle);
    const py = y + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface DrawState {
  viewport: Viewport;
  width: number;
  height: number;
  dpr: number;
  time: number;
  hoverId: string | null;
  selectedId: string | null;
  hidden: ReadonlySet<NodeType>;
  palette: Palette;
  animate: boolean;
}

function draw(ctx: CanvasRenderingContext2D, scene: Scene, state: DrawState): void {
  const { viewport, palette } = state;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.fillStyle = palette['--bg-canvas'];
  ctx.fillRect(0, 0, state.width, state.height);
  ctx.translate(state.width / 2 + viewport.x, state.height / 2 + viewport.y);
  ctx.scale(viewport.k, viewport.k);

  const { sim, nodes } = scene;
  const visible = (i: number) => {
    const node = nodes[i];
    return node !== undefined && !state.hidden.has(node.type);
  };
  const anchor = state.hoverId ?? state.selectedId;
  const focus = anchor && scene.neighbors.has(anchor) ? new Set([anchor, ...(scene.neighbors.get(anchor) ?? [])]) : anchor ? new Set([anchor]) : null;

  // Directory hulls behind everything else.
  const groups = new Map<string, number[]>();
  nodes.forEach((node, i) => {
    if (node.type !== 'file' || !visible(i)) return;
    const list = groups.get(node.group) ?? [];
    list.push(i);
    groups.set(node.group, list);
  });
  ctx.setLineDash([]);
  for (const [group, members] of groups) {
    if (members.length < 2) continue;
    let cx = 0;
    let cy = 0;
    for (const i of members) { cx += sim.nodes[i]?.x ?? 0; cy += sim.nodes[i]?.y ?? 0; }
    cx /= members.length;
    cy /= members.length;
    let radius = 0;
    for (const i of members) radius = Math.max(radius, Math.hypot((sim.nodes[i]?.x ?? 0) - cx, (sim.nodes[i]?.y ?? 0) - cy));
    radius += 36;
    ctx.globalAlpha = focus ? 0.25 : 0.55;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(28, 31, 38, 0.35)';
    ctx.fill();
    ctx.strokeStyle = palette['--border-subtle'];
    ctx.lineWidth = 1 / viewport.k;
    ctx.stroke();
    if (viewport.k > 0.35) {
      ctx.fillStyle = palette['--text-muted'];
      ctx.font = `${11 / Math.max(viewport.k, 0.6)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(truncate(group, 40), cx, cy - radius - 4);
    }
  }

  // Edges with arrowheads at the target's rim.
  for (const edge of scene.edges) {
    if (!visible(edge.source) || !visible(edge.target)) continue;
    const a = sim.nodes[edge.source];
    const b = sim.nodes[edge.target];
    const sourceNode = nodes[edge.source];
    const targetNode = nodes[edge.target];
    if (!a || !b || !sourceNode || !targetNode) continue;
    const lit = focus ? focus.has(sourceNode.id) && focus.has(targetNode.id) : false;
    const style = edgeStyle(edge.kind, palette);
    ctx.globalAlpha = focus ? (lit ? 0.95 : 0.05) : edge.kind === 'defines' ? 0.22 : 0.5;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const x1 = a.x + ux * a.radius;
    const y1 = a.y + uy * a.radius;
    const x2 = b.x - ux * (b.radius + 2);
    const y2 = b.y - uy * (b.radius + 2);
    ctx.strokeStyle = lit && edge.kind === 'calls' ? palette['--accent-red-soft'] : style.color;
    ctx.lineWidth = (lit ? style.width * 1.6 : style.width) / Math.max(viewport.k, 0.5);
    ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (edge.kind !== 'defines' && dist > a.radius + b.radius + 8) {
      const size = 5;
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - ux * size - uy * size * 0.6, y2 - uy * size + ux * size * 0.6);
      ctx.lineTo(x2 - ux * size + uy * size * 0.6, y2 - uy * size - ux * size * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.setLineDash([]);

  // Nodes.
  const pulse = state.animate ? (Math.sin(state.time / 280) + 1) / 2 : 0.5;
  nodes.forEach((node, i) => {
    const point = sim.nodes[i];
    if (!point || !visible(i)) return;
    const { x, y, radius: r } = point;
    ctx.globalAlpha = focus && !focus.has(node.id) ? 0.16 : 1;
    ctx.lineWidth = 1.4 / Math.max(viewport.k, 0.6);
    switch (node.type) {
      case 'file':
        roundedRect(ctx, x - r * 1.5, y - r * 0.8, r * 3, r * 1.6, r * 0.8);
        ctx.fillStyle = palette['--bg-elevated'];
        ctx.fill();
        ctx.setLineDash(node.indexed ? [] : [3, 2]);
        ctx.strokeStyle = palette['--text-muted'];
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      case 'symbol':
        if (TYPE_KINDS.has(node.kind)) roundedRect(ctx, x - r, y - r, r * 2, r * 2, Math.min(3, r / 2));
        else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }
        ctx.fillStyle = TYPE_KINDS.has(node.kind) ? palette['--bg-hover'] : palette['--slate-node'];
        ctx.fill();
        ctx.strokeStyle = node.isPublic ? palette['--accent-red-primary'] : palette['--slate-edge'];
        ctx.stroke();
        break;
      case 'fact':
        if (node.drifted) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4 + pulse * 5, 0, Math.PI * 2);
          ctx.strokeStyle = palette['--accent-red-bright'];
          ctx.globalAlpha *= 0.35 + (1 - pulse) * 0.5;
          ctx.lineWidth = 2.2 / Math.max(viewport.k, 0.6);
          ctx.stroke();
          ctx.globalAlpha = focus && !focus.has(node.id) ? 0.16 : 1;
        }
        polygon(ctx, x, y, r, 8, Math.PI / 8);
        ctx.fillStyle = node.state === 'superseded' ? palette['--bg-hover'] : palette['--accent-red-dark'];
        ctx.fill();
        ctx.strokeStyle = node.drifted ? palette['--accent-red-soft'] : palette['--accent-red-bright'];
        ctx.lineWidth = 1.4 / Math.max(viewport.k, 0.6);
        ctx.stroke();
        break;
      case 'session':
        polygon(ctx, x, y, r * 1.2, 4, 0);
        ctx.fillStyle = palette['--bg-hover'];
        ctx.fill();
        ctx.strokeStyle = palette['--text-muted'];
        ctx.stroke();
        break;
    }
    if (node.id === state.selectedId) {
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = palette['--accent-red-bright'];
      ctx.lineWidth = 2.5 / Math.max(viewport.k, 0.6);
      ctx.shadowColor = palette['--accent-red-glow'];
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  });

  // Labels: everything when zoomed in, otherwise only what is in focus.
  const visibleCount = nodes.reduce((n, _node, i) => n + (visible(i) ? 1 : 0), 0);
  const showAll = viewport.k >= 1.15 && visibleCount <= 700;
  ctx.font = `${11 / Math.max(viewport.k, 0.75)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  nodes.forEach((node, i) => {
    const point = sim.nodes[i];
    if (!point || !visible(i)) return;
    const inFocus = focus?.has(node.id) ?? false;
    const prominent = (node.type === 'file' && viewport.k > 0.7) || (node.type === 'fact' && viewport.k > 0.55);
    if (!showAll && !inFocus && !prominent) return;
    if (focus && !inFocus) return;
    ctx.globalAlpha = 1;
    ctx.fillStyle = node.type === 'fact' ? palette['--accent-red-soft'] : node.id === anchor ? palette['--text-primary'] : palette['--text-secondary'];
    ctx.fillText(truncate(node.label, 32), point.x, point.y + point.radius + 13 / Math.max(viewport.k, 0.75));
  });
  ctx.globalAlpha = 1;
}

/**
 * The interactive force-directed graph: zoom with the wheel or +/-, pan by
 * dragging the background or with the arrow keys, drag nodes, hover to light
 * a node's neighbourhood, click to select.
 */
export function GraphCanvas({ graph, selectedId, onSelect, view, onViewChange, canFocus }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  const hiddenRef = useRef<ReadonlySet<NodeType>>(new Set());
  const dirtyRef = useRef(true);
  // A new layout is fitted early (once it has cooled a little) and again
  // when it settles, unless the user has panned, zoomed or dragged by then.
  const fitPhaseRef = useRef<'early' | 'settle' | 'done'>('early');
  const userMovedRef = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<NodeType>>(() => new Set());
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  const fit = () => {
    const scene = sceneRef.current;
    const { width, height } = sizeRef.current;
    if (!scene || width === 0 || height === 0) return;
    const box = bounds(scene.sim);
    const k = Math.min(2, Math.max(0.08, Math.min(width / (box.maxX - box.minX + 120), height / (box.maxY - box.minY + 120))));
    viewportRef.current = { k, x: -((box.minX + box.maxX) / 2) * k, y: -((box.minY + box.maxY) / 2) * k };
    dirtyRef.current = true;
  };

  const zoomBy = (factor: number, screenX?: number, screenY?: number) => {
    userMovedRef.current = true;
    const viewport = viewportRef.current;
    const { width, height } = sizeRef.current;
    const k = Math.min(6, Math.max(0.05, viewport.k * factor));
    const px = (screenX ?? width / 2) - width / 2;
    const py = (screenY ?? height / 2) - height / 2;
    viewportRef.current = {
      k,
      x: px - ((px - viewport.x) * k) / viewport.k,
      y: py - ((py - viewport.y) * k) / viewport.k
    };
    dirtyRef.current = true;
  };

  // The animation loop and wheel listener live in a mount-once effect; these
  // read the latest viewport through refs.
  const fitFromLoop = useEffectEvent(() => fit());
  const zoomFromWheel = useEffectEvent((factor: number, screenX: number, screenY: number) => zoomBy(factor, screenX, screenY));

  const toWorld = (screenX: number, screenY: number) => {
    const viewport = viewportRef.current;
    const { width, height } = sizeRef.current;
    return { x: (screenX - width / 2 - viewport.x) / viewport.k, y: (screenY - height / 2 - viewport.y) / viewport.k };
  };

  const hitTest = (screenX: number, screenY: number): number | null => {
    const scene = sceneRef.current;
    if (!scene) return null;
    const point = toWorld(screenX, screenY);
    const slop = 4 / viewportRef.current.k;
    for (let i = scene.sim.nodes.length - 1; i >= 0; i--) {
      const node = scene.sim.nodes[i];
      const graphNode = scene.nodes[i];
      if (!node || !graphNode || hiddenRef.current.has(graphNode.type)) continue;
      const reach = (graphNode.type === 'file' ? node.radius * 1.5 : node.radius) + slop;
      if (Math.hypot(point.x - node.x, point.y - node.y) <= reach) return i;
    }
    return null;
  };

  // A new graph keeps the positions of nodes it shares with the old one.
  useEffect(() => {
    const previous = sceneRef.current;
    sceneRef.current = buildScene(graph, previous);
    fitPhaseRef.current = 'early';
    userMovedRef.current = false;
    dirtyRef.current = true;
  }, [graph]);

  useEffect(() => {
    hiddenRef.current = hidden;
    dirtyRef.current = true;
  }, [hidden]);

  // Keep the selection on screen when it was chosen outside the canvas.
  useEffect(() => {
    selectedRef.current = selectedId;
    dirtyRef.current = true;
    const scene = sceneRef.current;
    const index = selectedId ? scene?.sim.index.get(selectedId) : undefined;
    const node = index === undefined ? undefined : scene?.sim.nodes[index];
    if (!node) return;
    const viewport = viewportRef.current;
    const { width, height } = sizeRef.current;
    const sx = node.x * viewport.k + viewport.x;
    const sy = node.y * viewport.k + viewport.y;
    if (Math.abs(sx) > width / 2 - 40 || Math.abs(sy) > height / 2 - 40) {
      userMovedRef.current = true;
      viewportRef.current = { ...viewport, x: -node.x * viewport.k, y: -node.y * viewport.k };
    }
  }, [selectedId]);

  // The animation loop, canvas sizing and the non-passive wheel handler.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;
    const ctx = canvas.getContext('2d');
    const palette = readPalette(container);
    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width: rect.width, height: rect.height };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      dirtyRef.current = true;
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(container);

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomFromWheel(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let frame = 0;
    const loop = (time: number) => {
      const scene = sceneRef.current;
      if (scene && ctx) {
        if (!isSettled(scene.sim)) {
          const steps = reducedMotion ? 400 : scene.nodes.length < 900 ? 2 : 1;
          for (let i = 0; i < steps && !isSettled(scene.sim); i++) tick(scene.sim);
          dirtyRef.current = true;
          if (!userMovedRef.current && fitPhaseRef.current === 'early' && scene.sim.alpha < 0.3) {
            fitPhaseRef.current = 'settle';
            fitFromLoop();
          }
          if (!userMovedRef.current && fitPhaseRef.current === 'settle' && isSettled(scene.sim)) {
            fitPhaseRef.current = 'done';
            fitFromLoop();
          }
        }
        if (dirtyRef.current || (scene.hasDrift && !reducedMotion)) {
          draw(ctx, scene, {
            viewport: viewportRef.current, width: sizeRef.current.width, height: sizeRef.current.height,
            dpr: window.devicePixelRatio || 1, time, hoverId: hoverRef.current, selectedId: selectedRef.current,
            hidden: hiddenRef.current, palette, animate: !reducedMotion
          });
          dirtyRef.current = false;
        }
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  const localPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const index = hitTest(point.x, point.y);
    const scene = sceneRef.current;
    const node = index === null ? undefined : scene?.sim.nodes[index];
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (node) node.pinned = true;
    dragRef.current = {
      pointerId: event.pointerId, index, startX: point.x, startY: point.y,
      originX: viewportRef.current.x, originY: viewportRef.current.y, moved: false
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const drag = dragRef.current;
    const scene = sceneRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 3) drag.moved = true;
      if (!drag.moved) return;
      userMovedRef.current = true;
      const node = drag.index === null ? undefined : scene?.sim.nodes[drag.index];
      if (node && scene) {
        const world = toWorld(point.x, point.y);
        node.x = world.x;
        node.y = world.y;
        reheat(scene.sim, 0.12);
      } else {
        viewportRef.current = { ...viewportRef.current, x: drag.originX + point.x - drag.startX, y: drag.originY + point.y - drag.startY };
      }
      dirtyRef.current = true;
      return;
    }
    const index = hitTest(point.x, point.y);
    const hovered = index === null ? null : scene?.nodes[index] ?? null;
    if ((hovered?.id ?? null) !== hoverRef.current) {
      hoverRef.current = hovered?.id ?? null;
      dirtyRef.current = true;
      setHoverLabel(hovered ? describe(hovered) : null);
    }
  };

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const scene = sceneRef.current;
    const node = drag.index === null ? undefined : scene?.sim.nodes[drag.index];
    if (node) node.pinned = false;
    if (!drag.moved) onSelect(drag.index === null ? null : scene?.nodes[drag.index] ?? null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const step = 60;
    const viewport = viewportRef.current;
    const pans: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const pan = pans[event.key];
    if (pan) {
      userMovedRef.current = true;
      viewportRef.current = { ...viewport, x: viewport.x + pan[0], y: viewport.y + pan[1] };
      dirtyRef.current = true;
    } else if (event.key === '+' || event.key === '=') zoomBy(1.25);
    else if (event.key === '-' || event.key === '_') zoomBy(0.8);
    else if (event.key === '0') fit();
    else if (event.key === 'Escape') onSelect(null);
    else return;
    event.preventDefault();
  };

  const toggleType = (type: NodeType) => {
    setHidden(current => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const typeCounts: Record<NodeType, number> = { file: 0, symbol: 0, fact: 0, session: 0 };
  for (const node of graph.nodes) typeCounts[node.type]++;

  return (
    <section className="graph" aria-label="Graph">
      <div className="graph__toolbar">
        <div className="pill-group" role="toolbar" aria-label="Graph views">
          {VIEW_PILLS.map(pill => {
            const disabled = pill.view === 'impact' && !canFocus && view !== 'impact';
            return (
              <button
                key={pill.view}
                type="button"
                className="pill"
                aria-pressed={view === pill.view}
                disabled={disabled}
                title={disabled ? 'Select a symbol to see its blast radius' : undefined}
                onClick={() => onViewChange(pill.view)}
              >
                {pill.view === 'impact' && <Crosshair size={14} aria-hidden="true" />}
                {pill.label}
              </button>
            );
          })}
        </div>
        <div className="graph__zoom" role="group" aria-label="Zoom">
          <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}><Plus size={16} aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => zoomBy(0.8)}><Minus size={16} aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label="Fit graph to view" onClick={fit}><Maximize2 size={16} aria-hidden="true" /></button>
        </div>
      </div>

      <div ref={containerRef} className="graph__stage">
        <canvas
          ref={canvasRef}
          className="graph__canvas"
          tabIndex={0}
          role="application"
          aria-roledescription="graph canvas"
          aria-label={`Graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`}
          aria-describedby="graph-help"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => {
            if (hoverRef.current !== null) {
              hoverRef.current = null;
              dirtyRef.current = true;
              setHoverLabel(null);
            }
          }}
          onKeyDown={onKeyDown}
        />
        <p id="graph-help" className="visually-hidden">
          Arrow keys pan, plus and minus zoom, 0 fits the graph, Escape clears the selection.
          Press Control K to search for a node.
        </p>
        {hoverLabel && <div className="graph__hover" aria-live="polite">{hoverLabel}</div>}
        {graph.stats.truncated && (
          <p className="graph__notice" role="status">
            Showing the {graph.nodes.length} most connected nodes of a larger graph. Narrow it with a view or filter.
          </p>
        )}
      </div>

      <ul className="legend" aria-label="Node types">
        {LEGEND.map(item => (
          <li key={item.type}>
            <button
              type="button"
              className={`legend__item legend__item--${item.type}`}
              aria-pressed={!hidden.has(item.type)}
              onClick={() => toggleType(item.type)}
            >
              <span className="legend__swatch" aria-hidden="true" />
              {item.label}
              <span className="legend__count">{typeCounts[item.type]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function describe(node: GraphNode): string {
  switch (node.type) {
    case 'file': return `${node.path}${node.language ? ` · ${node.language}` : ''}`;
    case 'symbol': return `${node.kind} ${node.qualifiedName} · ${node.path}:${node.line} · ${node.callers} caller${node.callers === 1 ? '' : 's'} in graph`;
    case 'fact': return `${node.category}: ${node.label}${node.drifted ? ' · NEEDS REVIEW' : ''}`;
    case 'session': return `${node.label}${node.summary ? ` · ${node.summary}` : ''}`;
  }
}
