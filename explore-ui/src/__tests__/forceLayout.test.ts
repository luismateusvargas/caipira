import { describe, expect, it } from 'vitest';
import { createSimulation, isSettled, tick } from '../features/graph/forceLayout';
import type { Simulation } from '../features/graph/forceLayout';

function position(sim: Simulation, id: string): { x: number; y: number } {
  const index = sim.index.get(id);
  const node = index === undefined ? undefined : sim.nodes[index];
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

function distance(sim: Simulation, a: string, b: string): number {
  const p = position(sim, a);
  const q = position(sim, b);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

describe('forceLayout', () => {
  it('settles with linked nodes closer than unlinked ones', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, radius: 6 }));
    const sim = createSimulation(nodes, [
      { source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'd', target: 'e' }, { source: 'x', target: 'a' }
    ]);

    let steps = 0;
    while (!isSettled(sim) && steps < 2000) { tick(sim); steps++; }

    expect(isSettled(sim)).toBe(true);
    expect(sim.links).toHaveLength(3);
    expect(sim.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(distance(sim, 'a', 'b')).toBeLessThan(distance(sim, 'a', 'e'));
    expect(distance(sim, 'a', 'b')).toBeGreaterThan(12);
  });

  it('keeps known positions and does not move pinned nodes', () => {
    const sim = createSimulation([{ id: 'a', radius: 5 }, { id: 'b', radius: 5 }], [{ source: 'a', target: 'b' }],
      new Map([['a', { x: 40, y: -20 }]]));
    const pinned = sim.nodes[0];
    if (!pinned) throw new Error('missing node');
    pinned.pinned = true;

    for (let i = 0; i < 50; i++) tick(sim);

    expect(position(sim, 'a')).toMatchObject({ x: 40, y: -20 });
  });
});
