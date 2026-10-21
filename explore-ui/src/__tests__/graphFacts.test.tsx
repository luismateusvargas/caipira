import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { graphPayloadSchema } from '../api/schemas';
import type { GraphNode, GraphPayload } from '../api/schemas';
import { describeNode } from '../features/graph/GraphCanvas';
import { NodeSummary } from '../features/inspector/NodeSummary';
import { RAW_GRAPH, at } from './fixtures';

afterEach(cleanup);

const RAW_FACT = { ...at(RAW_GRAPH.nodes, 2), state: 'active', drifted: false };
const LEGACY_FACT = Object.fromEntries(Object.entries(RAW_FACT).filter(([key]) => key !== 'symbolAnchors' && key !== 'uncheckedSymbols'));

/** Fact node payloads keyed by what the server knows about their evidence. */
const CASES: Record<string, object> = {
  unchecked: { ...RAW_FACT, symbolAnchors: 2, uncheckedSymbols: 1 },
  unknown: { ...RAW_FACT, symbolAnchors: 1, uncheckedSymbols: null },
  legacy: LEGACY_FACT,
  checked: { ...RAW_FACT, symbolAnchors: 1, uncheckedSymbols: 0 },
  unanchored: { ...RAW_FACT, symbolAnchors: 0, uncheckedSymbols: null },
  driftedUnchecked: { ...RAW_FACT, state: 'needs_review', drifted: true, symbolAnchors: 1, uncheckedSymbols: 1 }
};

// The payload as the app receives it: through the response contract.
function parsedWith(fact: object): { graph: GraphPayload; node: GraphNode } {
  const graph = graphPayloadSchema.parse({ ...RAW_GRAPH, nodes: RAW_GRAPH.nodes.map(node => (node.id === 'fact:41' ? fact : node)) });
  return { graph, node: at(graph.nodes, 2) };
}

describe('graph fact nodes', () => {
  it('describe on hover whether their evidence was checked, apart from drift', () => {
    const actual = Object.fromEntries(Object.entries(CASES).map(([name, fact]) => [name, describeNode(parsedWith(fact).node)]));

    const title = 'constraint: addUser must stay idempotent';
    expect(actual).toEqual({
      unchecked: `${title} · Evidence not checked`,
      unknown: `${title} · Evidence not checked`,
      legacy: `${title} · Evidence not checked`,
      checked: title,
      unanchored: title,
      driftedUnchecked: `${title} · NEEDS REVIEW · Evidence not checked`
    });
  });

  it('say so in the selection summary and keep its links', () => {
    const onJumpTo = vi.fn<(nodeId: string) => void>();
    const actual = Object.fromEntries(Object.entries(CASES).map(([name, fact]) => {
      const { graph, node } = parsedWith(fact);
      const { unmount } = render(<NodeSummary node={node} graph={graph} onJumpTo={onJumpTo} onClose={() => undefined} />);
      const summary = screen.getByRole('complementary', { name: 'Fact' });
      const seen = {
        notChecked: within(summary).queryByText('Evidence not checked') !== null,
        review: within(summary).queryByText('NEEDS REVIEW') !== null,
        note: within(summary).queryByText(/reflects the last index/)?.textContent ?? null
      };
      fireEvent.click(within(within(summary).getByRole('list', { name: 'Evidence' })).getByRole('button', { name: 'UserStore.addUser' }));
      unmount();
      return [name, seen];
    }));

    const unknown = 'Its symbol evidence has not been checked against the source, so this status reflects the last index.';
    const one = '1 symbol anchor could not be re-read from source, so this status reflects the last index.';
    expect(actual).toEqual({
      unchecked: { notChecked: true, review: false, note: one },
      unknown: { notChecked: true, review: false, note: unknown },
      legacy: { notChecked: true, review: false, note: unknown },
      checked: { notChecked: false, review: false, note: null },
      unanchored: { notChecked: false, review: false, note: null },
      driftedUnchecked: { notChecked: true, review: true, note: one }
    });
    expect(onJumpTo.mock.calls).toEqual(Object.keys(CASES).map(() => ['symbol:7']));
  });
});
