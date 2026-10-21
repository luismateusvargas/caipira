/**
 * A small force-directed layout: springs along edges, short-range repulsion
 * through a spatial grid (so a tick stays near-linear in the node count), and
 * a weak pull toward the origin. Positions are mutated in place; the canvas
 * reads them every frame.
 */

/** One laid-out node. */
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Held by the pointer: forces do not move it. */
  pinned: boolean;
}

/** An edge between two node indices. */
export interface LayoutLink {
  source: number;
  target: number;
}

/** Mutable simulation state. */
export interface Simulation {
  nodes: LayoutNode[];
  links: LayoutLink[];
  index: Map<string, number>;
  alpha: number;
}

const CELL = 110;
const REPULSION = 1600;
const SPRING = 0.045;
const GRAVITY = 0.012;
const DAMPING = 0.62;
const COOLING = 0.982;
const MIN_ALPHA = 0.004;
// Caps how far a node moves in one tick, so dense starts cannot fling
// nodes thousands of pixels out before the springs catch up.
const MAX_SPEED = 24;

/**
 * Creates a simulation. Nodes that existed in `previous` keep their position;
 * new ones start on a golden-angle spiral, so a layout is deterministic.
 * @param nodes Ids and draw radii.
 * @param edges Edges by node id; edges to unknown ids are dropped.
 * @param previous Positions from an earlier layout of overlapping nodes.
 * @returns The new simulation, fully heated.
 */
export function createSimulation(
  nodes: readonly { id: string; radius: number }[],
  edges: readonly { source: string; target: string }[],
  previous?: ReadonlyMap<string, { x: number; y: number }>
): Simulation {
  const index = new Map<string, number>();
  const spread = 22;
  const laid = nodes.map((node, i): LayoutNode => {
    index.set(node.id, i);
    const before = previous?.get(node.id);
    const angle = i * 2.399963229728653;
    const distance = spread * Math.sqrt(i + 1);
    return {
      id: node.id,
      x: before ? before.x : Math.cos(angle) * distance,
      y: before ? before.y : Math.sin(angle) * distance,
      vx: 0,
      vy: 0,
      radius: node.radius,
      pinned: false
    };
  });
  const links: LayoutLink[] = [];
  for (const edge of edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source !== undefined && target !== undefined && source !== target) links.push({ source, target });
  }
  return { nodes: laid, links, index, alpha: 1 };
}

/** @returns True once the layout has cooled enough to stop ticking. */
export function isSettled(sim: Simulation): boolean {
  return sim.alpha < MIN_ALPHA;
}

/**
 * Reheats the layout, after a drag or a filter change.
 * @param sim The simulation.
 * @param alpha Temperature to raise it to.
 */
export function reheat(sim: Simulation, alpha = 0.35): void {
  sim.alpha = Math.max(sim.alpha, alpha);
}

function cellKey(x: number, y: number): string {
  return `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
}

/**
 * Advances the layout by one step.
 * @param sim The simulation to mutate.
 */
export function tick(sim: Simulation): void {
  const { nodes, links } = sim;
  const alpha = sim.alpha;

  const grid = new Map<string, number[]>();
  nodes.forEach((node, i) => {
    const key = cellKey(node.x, node.y);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (!a) continue;
    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue;
          const b = nodes[j];
          if (!b) continue;
          let ddx = a.x - b.x;
          let ddy = a.y - b.y;
          let dist2 = ddx * ddx + ddy * ddy;
          if (dist2 < 0.01) {
            // Coincident nodes: separate them along a fixed, index-derived direction.
            ddx = Math.cos(i + j);
            ddy = Math.sin(i + j);
            dist2 = 1;
          }
          const minimum = a.radius + b.radius + 6;
          const push = (REPULSION / dist2 + (dist2 < minimum * minimum ? 0.5 : 0)) * alpha;
          const dist = Math.sqrt(dist2);
          const fx = (ddx / dist) * push;
          const fy = (ddy / dist) * push;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
    }
  }

  for (const link of links) {
    const a = nodes[link.source];
    const b = nodes[link.target];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const desired = 46 + a.radius + b.radius;
    const pull = (dist - desired) * SPRING * alpha;
    const fx = (dx / dist) * pull;
    const fy = (dy / dist) * pull;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const node of nodes) {
    if (node.pinned) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx = (node.vx - node.x * GRAVITY * alpha) * DAMPING;
    node.vy = (node.vy - node.y * GRAVITY * alpha) * DAMPING;
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > MAX_SPEED) {
      node.vx *= MAX_SPEED / speed;
      node.vy *= MAX_SPEED / speed;
    }
    node.x += node.vx;
    node.y += node.vy;
  }

  sim.alpha = alpha * COOLING;
}

/**
 * @param sim The simulation.
 * @returns The bounding box of every node, padded by its radius.
 */
export function bounds(sim: Simulation): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of sim.nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }
  if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}
