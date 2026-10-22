import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { Crosshair, Maximize2, Minus, PanelLeftClose, PanelLeftOpen, Plus, X } from 'lucide-react';
import type { GraphNode, GraphPayload, GraphView } from '../../api/schemas';
import { evidenceNotChecked } from '../../api/schemas';
import type { LinkKind, Palette, Scene, Viewport } from './mapDraw';
import { LINK_KINDS, STAND_IN_PX, buildScene, describeRegion, drawMap, drawMinimap, drawPulse, labelReadable, minimapTransform, readPalette, rowsHittable } from './mapDraw';
import type { Box, MapItem, MapRegion } from './mapLayout';
import { REGION_HEAD, buildRegionTree, contains, hitTest, inHiddenRegion, layoutMap } from './mapLayout';
import type { Layers } from './MapPanel';
import { DEFAULT_LAYERS, MapPanel } from './MapPanel';

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

const VIEW_PILLS: readonly { view: GraphView; label: string }[] = [
  { view: 'unified', label: 'Unified Graph' },
  { view: 'architecture', label: 'Code Architecture' },
  { view: 'knowledge', label: 'Knowledge Brain' },
  { view: 'impact', label: 'Blast Radius' }
];

const MAX_ZOOM = 4;
const MINIMAP = { width: 200, height: 136 };
const FLY_MS = 450;
// Zoom at which a card's title and its symbols' names read comfortably.
const READ_ZOOM = 1;

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Viewport;
  moved: boolean;
}

interface Flight {
  from: Viewport;
  to: Viewport;
  start: number;
}

function layerAllows(node: GraphNode, layers: Layers): boolean {
  if (!layers[node.type]) return false;
  if (node.type === 'file' && !node.indexed && !layers.unindexed) return false;
  return !(node.type === 'fact' && node.state === 'superseded' && !layers.superseded);
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Capture fails when the pointer is already gone; the gesture then simply ends early.
function capture(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // Nothing to capture.
  }
}

/**
 * The graph as an explorable map: regions for directories, knowledge and
 * sessions; file cards listing their symbols; routes between regions from
 * afar and each node's own links on hover. Drag to pan, wheel or +/- to
 * zoom, double-click to travel into a region or card, and use the minimap
 * or the region tree to jump.
 */
export function GraphCanvas({ graph, selectedId, onSelect, view, onViewChange, canFocus }: GraphCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const hoverItemRef = useRef<MapItem | null>(null);
  const hoverRegionRef = useRef<MapRegion | null>(null);
  const selectedRef = useRef<MapItem | null>(null);
  const kindsRef = useRef<ReadonlySet<LinkKind>>(new Set(LINK_KINDS));
  const routesRef = useRef(false);
  const allLinksRef = useRef(view === 'impact');
  const dirtyRef = useRef(true);
  const flightRef = useRef<Flight | null>(null);
  const userMovedRef = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  const minimapDragRef = useRef<number | null>(null);
  // A selection made on the canvas is already in view; one from search is flown to.
  const selectedHereRef = useRef(false);
  const trailKeyRef = useRef('');
  const reducedMotionRef = useRef(false);
  // The pointer over the map, so the hover follows the map as it moves underneath.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const hoveredAtRef = useRef<Viewport | null>(null);

  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [kinds, setKinds] = useState<ReadonlySet<LinkKind>>(() => new Set(LINK_KINDS));
  const [routes, setRoutes] = useState(false);
  const [hiddenRegions, setHiddenRegions] = useState<ReadonlySet<string>>(() => new Set());
  const [panelOpen, setPanelOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1200);
  const [hoverText, setHoverText] = useState<string | null>(null);
  const [trail, setTrail] = useState<MapRegion[]>([]);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  const shown = useMemo(() => graph.nodes.filter(node => layerAllows(node, layers) && !inHiddenRegion(node, hiddenRegions)), [graph, layers, hiddenRegions]);
  const scene = useMemo(() => buildScene(layoutMap(shown), graph.edges), [shown, graph.edges]);
  const tree = useMemo(() => buildRegionTree(graph.nodes.filter(node => layerAllows(node, layers))), [graph, layers]);

  const zoomLimits = () => {
    const { width, height } = sizeRef.current;
    const box = sceneRef.current?.layout.bounds ?? { x: 0, y: 0, w: 1, h: 1 };
    const fit = Math.min((width - 80) / box.w, (height - 112) / box.h);
    return { min: Math.min(0.02, Math.max(0.001, fit * 0.6)), max: MAX_ZOOM };
  };

  /**
   * @returns The viewport that shows `box` whole, centred below the trail at
   *   the top of the stage, within the zoom limits.
   */
  const viewportFor = (box: Box, zoom?: number): Viewport => {
    const { width, height } = sizeRef.current;
    const limits = zoomLimits();
    const k = Math.min(limits.max, Math.max(limits.min, zoom ?? Math.min((width - 80) / box.w, (height - 112) / box.h)));
    return { k, x: width / 2 - (box.x + box.w / 2) * k, y: (height + 32) / 2 - (box.y + box.h / 2) * k };
  };

  /** @returns The viewport that brings an item close enough to read, centred on it. */
  const viewportForItem = (item: MapItem): Viewport => {
    const card = item.card ?? item;
    const { width, height } = sizeRef.current;
    const fit = Math.min((width - 80) / card.w, (height - 112) / card.h);
    return viewportFor(item, Math.max(READ_ZOOM * 0.9, Math.min(1.4, fit)));
  };

  const travel = (to: Viewport) => {
    userMovedRef.current = true;
    if (reducedMotionRef.current) {
      viewportRef.current = to;
      flightRef.current = null;
    } else {
      flightRef.current = { from: viewportRef.current, to, start: performance.now() };
    }
    dirtyRef.current = true;
  };

  const fit = () => {
    const layout = sceneRef.current?.layout;
    if (!layout || sizeRef.current.width === 0) return;
    flightRef.current = null;
    viewportRef.current = viewportFor(layout.bounds);
    dirtyRef.current = true;
  };

  const zoomBy = (factor: number, screenX?: number, screenY?: number) => {
    userMovedRef.current = true;
    flightRef.current = null;
    const viewport = viewportRef.current;
    const { width, height } = sizeRef.current;
    const limits = zoomLimits();
    const k = Math.min(limits.max, Math.max(limits.min, viewport.k * factor));
    const px = screenX ?? width / 2;
    const py = screenY ?? height / 2;
    viewportRef.current = { k, x: px - ((px - viewport.x) * k) / viewport.k, y: py - ((py - viewport.y) * k) / viewport.k };
    dirtyRef.current = true;
  };

  const flyToRegion = (regionId: string) => {
    const region = sceneRef.current?.layout.regionById.get(regionId);
    if (region) travel(viewportFor(region));
  };

  // The animation loop and wheel listener live in a mount-once effect; these
  // read the latest state through refs.
  const fitFromEffect = useEffectEvent(() => fit());
  const zoomFromWheel = useEffectEvent((factor: number, screenX: number, screenY: number) => zoomBy(factor, screenX, screenY));
  const updateTrail = useEffectEvent((regions: MapRegion[]) => setTrail(regions));
  const hoverFromLoop = useEffectEvent(() => {
    hoveredAtRef.current = viewportRef.current;
    const pointer = pointerRef.current;
    if (!pointer || dragRef.current) return;
    const hit = pick(pointer.x, pointer.y);
    setHover(hit.item, hit.region);
  });

  const toWorld = (screenX: number, screenY: number) => {
    const viewport = viewportRef.current;
    return { x: (screenX - viewport.x) / viewport.k, y: (screenY - viewport.y) / viewport.k };
  };

  /**
   * What a screen point is on: a region too small to show its content stands
   * in for everything inside it; otherwise the item under the point, else the
   * region whose header it is on.
   */
  const pick = (screenX: number, screenY: number): { item: MapItem | null; region: MapRegion | null } => {
    const layout = sceneRef.current?.layout;
    if (!layout) return { item: null, region: null };
    const k = viewportRef.current.k;
    const point = toWorld(screenX, screenY);
    const hit = hitTest(layout, point.x, point.y, rowsHittable(k));
    if (!hit.region) return { item: null, region: null };
    const standIn = hit.region.chain.find(region => Math.max(region.w, region.h) * k < STAND_IN_PX);
    if (standIn) return { item: null, region: standIn };
    if (hit.item) return { item: hit.item, region: null };
    const onHeader = (point.y - hit.region.y) * k <= Math.max(REGION_HEAD * k, 22);
    return { item: null, region: onHeader ? hit.region : null };
  };

  // A new layout keeps the view on the region it was showing, when it can.
  useEffect(() => {
    const previous = sceneRef.current;
    sceneRef.current = scene;
    hoverItemRef.current = null;
    hoverRegionRef.current = null;
    selectedRef.current = selectedId ? scene.layout.byId.get(selectedId) ?? null : null;
    setHoverText(null);
    dirtyRef.current = true;
    const { width, height } = sizeRef.current;
    if (!previous || !userMovedRef.current || width === 0) {
      fitFromEffect();
      return;
    }
    const viewport = viewportRef.current;
    const centre = { x: (width / 2 - viewport.x) / viewport.k, y: (height / 2 - viewport.y) / viewport.k };
    const before = previous.layout.regions.filter(region => contains(region, centre.x, centre.y)).pop();
    const after = before ? scene.layout.regionById.get(before.id) : undefined;
    if (!before || !after) {
      fitFromEffect();
      return;
    }
    const x = after.x + Math.min(after.w, centre.x - before.x);
    const y = after.y + Math.min(after.h, centre.y - before.y);
    viewportRef.current = { k: viewport.k, x: width / 2 - x * viewport.k, y: height / 2 - y * viewport.k };
  }, [scene]);

  // Travel to a selection made elsewhere, such as from search.
  useEffect(() => {
    const item = selectedId ? sceneRef.current?.layout.byId.get(selectedId) ?? null : null;
    selectedRef.current = item;
    dirtyRef.current = true;
    const here = selectedHereRef.current;
    selectedHereRef.current = false;
    if (!item || here) return;
    const viewport = viewportRef.current;
    const { width, height } = sizeRef.current;
    const sx = (item.x + item.w / 2) * viewport.k + viewport.x;
    const sy = (item.y + item.h / 2) * viewport.k + viewport.y;
    const inView = sx > 40 && sx < width - 40 && sy > 40 && sy < height - 40;
    if (!inView || !labelReadable(item, viewport.k)) travel(viewportForItem(item));
  }, [selectedId]);

  useEffect(() => {
    kindsRef.current = kinds;
    routesRef.current = routes;
    // A blast radius is small enough to show every link in it.
    allLinksRef.current = view === 'impact';
    dirtyRef.current = true;
  }, [kinds, routes, view]);

  // The animation loop, canvas sizing and the non-passive wheel handler.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const minimap = minimapRef.current;
    if (!canvas || !stage) return undefined;
    const ctx = canvas.getContext('2d');
    const miniCtx = minimap?.getContext('2d') ?? null;
    // The map is drawn once per change into a cached copy; frames between
    // changes only redraw the pulse of facts that need review.
    const base = document.createElement('canvas');
    const baseCtx = base.getContext('2d');
    const palette: Palette = readPalette(stage);
    reducedMotionRef.current = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const first = sizeRef.current.width === 0;
      sizeRef.current = { width: rect.width, height: rect.height };
      for (const target of [canvas, base]) {
        target.width = Math.max(1, Math.round(rect.width * dpr));
        target.height = Math.max(1, Math.round(rect.height * dpr));
      }
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      if (minimap) {
        minimap.width = Math.round(MINIMAP.width * dpr);
        minimap.height = Math.round(MINIMAP.height * dpr);
      }
      if (first || !userMovedRef.current) fitFromEffect();
      dirtyRef.current = true;
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(stage);

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomFromWheel(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let frame = 0;
    let pulsing = false;
    const loop = (time: number) => {
      const scene = sceneRef.current;
      const flight = flightRef.current;
      if (flight) {
        const t = Math.min(1, (time - flight.start) / FLY_MS);
        const e = ease(Math.max(0, t));
        const k = Math.exp(Math.log(flight.from.k) + (Math.log(flight.to.k) - Math.log(flight.from.k)) * e);
        // Interpolate the world point at the centre, so the zoom does not swing sideways.
        const { width, height } = sizeRef.current;
        const fromCentre = { x: (width / 2 - flight.from.x) / flight.from.k, y: (height / 2 - flight.from.y) / flight.from.k };
        const toCentre = { x: (width / 2 - flight.to.x) / flight.to.k, y: (height / 2 - flight.to.y) / flight.to.k };
        const cx = fromCentre.x + (toCentre.x - fromCentre.x) * e;
        const cy = fromCentre.y + (toCentre.y - fromCentre.y) * e;
        viewportRef.current = { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
        if (t >= 1) flightRef.current = null;
        dirtyRef.current = true;
      }
      if (scene && hoveredAtRef.current !== viewportRef.current) hoverFromLoop();
      if (scene && ctx && baseCtx) {
        const { width, height } = sizeRef.current;
        const dpr = window.devicePixelRatio || 1;
        const viewport = viewportRef.current;
        const dirty = dirtyRef.current;
        if (dirty) {
          drawMap(baseCtx, scene, {
            viewport, width, height, dpr, palette,
            hoverItem: hoverItemRef.current, hoverRegion: hoverRegionRef.current, selected: selectedRef.current,
            kinds: kindsRef.current, routes: routesRef.current, allLinks: allLinksRef.current
          });
          if (miniCtx) drawMinimap(miniCtx, scene.layout, viewport, { width, height }, MINIMAP, dpr, palette);
          const centre = { x: (width / 2 - viewport.x) / viewport.k, y: (height / 2 - viewport.y) / viewport.k };
          const regions = scene.layout.regions.filter(region => contains(region, centre.x, centre.y)
            && (region.w * viewport.k >= width * 0.3 || region.h * viewport.k >= height * 0.3));
          const key = regions.map(region => region.id).join('|');
          if (key !== trailKeyRef.current) {
            trailKeyRef.current = key;
            updateTrail(regions);
          }
          dirtyRef.current = false;
        }
        if (dirty || pulsing) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(base, 0, 0);
          pulsing = !reducedMotionRef.current && drawPulse(ctx, scene, viewport, width, height, dpr, time, palette);
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

  const localPoint = (event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const setHover = (item: MapItem | null, region: MapRegion | null) => {
    if (item === hoverItemRef.current && region === hoverRegionRef.current) return;
    hoverItemRef.current = item;
    hoverRegionRef.current = region;
    dirtyRef.current = true;
    setHoverText(item ? describeNode(item.node) : region ? describeRegion(region) : null);
  };

  const placeTooltip = (x: number, y: number) => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const { width, height } = sizeRef.current;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.style.transform = `translate(${x > width * 0.6 ? 'calc(-100% - 14px)' : '14px'}, ${y > height * 0.75 ? 'calc(-100% - 14px)' : '14px'})`;
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    capture(event.currentTarget, event.pointerId);
    flightRef.current = null;
    dragRef.current = { pointerId: event.pointerId, startX: point.x, startY: point.y, origin: viewportRef.current, moved: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 3) drag.moved = true;
      if (!drag.moved) return;
      userMovedRef.current = true;
      viewportRef.current = { ...drag.origin, x: drag.origin.x + point.x - drag.startX, y: drag.origin.y + point.y - drag.startY };
      dirtyRef.current = true;
      return;
    }
    pointerRef.current = point;
    hoveredAtRef.current = viewportRef.current;
    const hit = pick(point.x, point.y);
    setHover(hit.item, hit.region);
    placeTooltip(point.x, point.y);
  };

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // Capture ends by itself after pointerup or pointercancel.
    dragRef.current = null;
    if (drag.moved || event.type === 'pointercancel') return;
    const { item, region } = pick(drag.startX, drag.startY);
    // A click on a region too small to show its content travels into it.
    if (!item && region && Math.max(region.w, region.h) * viewportRef.current.k < STAND_IN_PX) {
      travel(viewportFor(region));
      return;
    }
    selectedHereRef.current = item !== null;
    onSelect(item?.node ?? null);
  };

  const onDoubleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const layout = sceneRef.current?.layout;
    if (!layout) return;
    const world = toWorld(point.x, point.y);
    const hit = hitTest(layout, world.x, world.y, rowsHittable(viewportRef.current.k));
    if (hit.item) travel(viewportForItem(hit.item));
    else if (hit.region) travel(viewportFor(hit.region));
    else travel(viewportFor(layout.bounds));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const step = 80;
    const viewport = viewportRef.current;
    const pans: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const pan = pans[event.key];
    if (pan) {
      userMovedRef.current = true;
      flightRef.current = null;
      viewportRef.current = { ...viewport, x: viewport.x + pan[0], y: viewport.y + pan[1] };
      dirtyRef.current = true;
    } else if (event.key === '+' || event.key === '=') zoomBy(1.25);
    else if (event.key === '-' || event.key === '_') zoomBy(0.8);
    else if (event.key === '0') fit();
    else if (event.key === 'Escape') onSelect(null);
    else return;
    event.preventDefault();
  };

  const minimapTo = (event: PointerEvent<HTMLCanvasElement>) => {
    const layout = sceneRef.current?.layout;
    if (!layout) return;
    const point = localPoint(event);
    const t = minimapTransform(layout, MINIMAP.width, MINIMAP.height);
    const world = { x: (point.x - t.offsetX) / t.scale, y: (point.y - t.offsetY) / t.scale };
    const { width, height } = sizeRef.current;
    const k = viewportRef.current.k;
    userMovedRef.current = true;
    flightRef.current = null;
    viewportRef.current = { k, x: width / 2 - world.x * k, y: height / 2 - world.y * k };
    dirtyRef.current = true;
  };

  return (
    <section className="graph" aria-label="Graph">
      <div className="graph__toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label={panelOpen ? 'Hide map controls' : 'Show map controls'}
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          {panelOpen ? <PanelLeftClose size={16} aria-hidden="true" /> : <PanelLeftOpen size={16} aria-hidden="true" />}
        </button>
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

      <div className="graph__body">
        {panelOpen && (
          <MapPanel
            graph={graph}
            layers={layers}
            onLayersChange={setLayers}
            kinds={kinds}
            onKindsChange={setKinds}
            routes={routes}
            onRoutesChange={setRoutes}
            tree={tree}
            hidden={hiddenRegions}
            onHiddenChange={setHiddenRegions}
            onFlyTo={flyToRegion}
          />
        )}

        <div ref={stageRef} className="graph__stage">
          <canvas
            ref={canvasRef}
            className={`graph__canvas${hoverText ? ' graph__canvas--pointing' : ''}`}
            tabIndex={0}
            role="application"
            aria-roledescription="graph map"
            aria-label={`Map of ${shown.length} nodes in ${scene.layout.regions.length} regions, with ${graph.edges.length} edges`}
            aria-describedby="graph-help"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => {
              pointerRef.current = null;
              setHover(null, null);
            }}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
          />
          <p id="graph-help" className="visually-hidden">
            Arrow keys pan, plus and minus zoom, 0 fits the map, Escape clears the selection.
            Press Control K to search for a node. The Regions list in the map controls travels to a region.
          </p>
          <nav className="graph__trail" aria-label="You are here">
            {trail.length === 0 ? <span className="muted">Overview</span> : trail.map((region, i) => (
              <span key={region.id} className="graph__trail-step">
                {i > 0 && <span aria-hidden="true">›</span>}
                <button type="button" className="link-button" onClick={() => flyToRegion(region.id)}>{region.label}</button>
              </span>
            ))}
          </nav>
          <div ref={tooltipRef} className="graph__hover" aria-live="polite" hidden={!hoverText}>{hoverText}</div>
          {shown.length === 0 && <p className="graph__empty">Every node here is hidden by the map controls. Turn a layer or region back on.</p>}
          {graph.stats.truncated && !noticeDismissed && (
            <p className="graph__notice" role="status">
              Showing the {graph.nodes.length.toLocaleString()} most connected nodes of a larger graph. Narrow it with a path prefix.
              <button type="button" className="icon-button graph__notice-close" aria-label="Dismiss" onClick={() => setNoticeDismissed(true)}>
                <X size={14} aria-hidden="true" />
              </button>
            </p>
          )}
          <canvas
            ref={minimapRef}
            className="graph__minimap"
            style={{ width: MINIMAP.width, height: MINIMAP.height }}
            aria-label="Minimap: click or drag to move the view"
            onPointerDown={event => {
              capture(event.currentTarget, event.pointerId);
              minimapDragRef.current = event.pointerId;
              minimapTo(event);
            }}
            onPointerMove={event => { if (minimapDragRef.current === event.pointerId) minimapTo(event); }}
            onPointerUp={() => { minimapDragRef.current = null; }}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * @param node Any graph node.
 * @returns The one-line description shown, and announced, while it is hovered.
 */
export function describeNode(node: GraphNode): string {
  switch (node.type) {
    case 'file': return `${node.path}${node.language ? ` · ${node.language}` : ''}`;
    case 'symbol': return `${node.kind} ${node.qualifiedName} · ${node.path}:${node.line} · ${node.callers} caller${node.callers === 1 ? '' : 's'} in graph`;
    case 'fact': return `${node.category}: ${node.label}${node.drifted ? ' · NEEDS REVIEW' : ''}${evidenceNotChecked(node) ? ' · Evidence not checked' : ''}`;
    case 'session': return `${node.label}${node.summary ? ` · ${node.summary}` : ''}`;
  }
}
