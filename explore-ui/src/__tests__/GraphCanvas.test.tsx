import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { graphPayloadSchema } from '../api/schemas';
import { GraphCanvas } from '../features/graph/GraphCanvas';
import { RAW_GRAPH } from './fixtures';

afterEach(cleanup);

// jsdom has no canvas, so the map draws nothing, but its controls work; they
// start open on a desktop-sized window.
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('innerWidth', 1400);
});

const SUPERSEDED = { id: 'fact:40', type: 'fact', label: 'old idea', factId: 40, category: 'decision', state: 'superseded', drifted: false, trust: 0.2, symbolAnchors: 0, uncheckedSymbols: null };
const DOC = { id: 'file:docs/plan.md', type: 'file', label: 'plan.md', path: 'docs/plan.md', language: null, group: 'docs', indexed: false };
const GRAPH = graphPayloadSchema.parse({ ...RAW_GRAPH, nodes: [...RAW_GRAPH.nodes, SUPERSEDED, DOC] });

/** @returns A reader for the map's description, which counts what it shows. */
function renderMap() {
  render(<GraphCanvas graph={GRAPH} selectedId={null} onSelect={vi.fn()} view="unified" onViewChange={vi.fn()} canFocus={false} />);
  return { map: () => screen.getByRole('application').getAttribute('aria-label') };
}

describe('GraphCanvas', () => {
  it('hides superseded facts until asked, and toggles layers', () => {
    const { map } = renderMap();
    const layers = screen.getByRole('group', { name: 'Layers' });

    expect(map()).toBe('Map of 5 nodes in 6 regions, with 3 edges');
    expect(within(layers).getByRole('button', { name: /Superseded/ }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(within(layers).getByRole('button', { name: /Superseded/ }));
    expect(map()).toBe('Map of 6 nodes in 7 regions, with 3 edges');

    fireEvent.click(within(layers).getByRole('button', { name: /Not indexed/ }));
    expect(map()).toBe('Map of 5 nodes in 6 regions, with 3 edges');

    fireEvent.click(within(layers).getByRole('button', { name: /^Facts/ }));
    expect(map()).toBe('Map of 3 nodes in 3 regions, with 3 edges');
    expect(within(layers).getByRole('button', { name: /Superseded/ }).hasAttribute('disabled')).toBe(true);
  });

  it('hides a region from the tree and brings every region back', () => {
    const { map } = renderMap();
    const tree = screen.getByRole('list', { name: 'Regions' });

    fireEvent.click(within(tree).getByRole('checkbox', { name: 'Show docs' }));
    expect(map()).toBe('Map of 4 nodes in 5 regions, with 3 edges');
    expect(within(tree).getByRole('button', { name: 'docs' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Show all regions' }));
    expect(map()).toBe('Map of 5 nodes in 6 regions, with 3 edges');
  });

  it('lists link kinds with their counts and leaves region routes off by default', () => {
    renderMap();
    const links = screen.getByRole('group', { name: 'Links' });

    expect(within(links).getByRole('button', { name: /Routes between regions/ }).getAttribute('aria-pressed')).toBe('false');
    expect(within(links).getByRole('button', { name: /Evidence/ }).textContent).toContain('1');
    fireEvent.click(within(links).getByRole('button', { name: /Touched/ }));
    expect(within(links).getByRole('button', { name: /Touched/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('folds the map controls away', () => {
    renderMap();

    fireEvent.click(screen.getByRole('button', { name: 'Hide map controls' }));
    expect(screen.queryByRole('complementary', { name: 'Map controls' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show map controls' }));
    expect(screen.getByRole('complementary', { name: 'Map controls' })).toBeTruthy();
  });
});
