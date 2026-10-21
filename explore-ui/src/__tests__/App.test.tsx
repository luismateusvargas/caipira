import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { ApiError } from '../api/client';
import type { ExploreApi, FactQuery } from '../api/client';
import { factListSchema, graphPayloadSchema, symbolDetailSchema, workspaceListSchema } from '../api/schemas';
import type { GraphCanvasProps } from '../features/graph/GraphCanvas';
import { RAW_FACTS, RAW_GRAPH, RAW_SYMBOL_DETAIL, at, fakeApi } from './fixtures';

// jsdom has no canvas. The stand-in lists the nodes it is given, so a test
// can select one and read the drift flag the graph would draw.
vi.mock('../features/graph/GraphCanvas', () => ({
  GraphCanvas: ({ graph, onSelect }: GraphCanvasProps) => (
    <ul aria-label="Graph nodes">
      {graph.nodes.map(node => (
        <li key={node.id}>
          <button type="button" onClick={() => onSelect(node)}>{node.label}</button>
          {node.type === 'fact' && node.drifted && <span> drifted</span>}
        </li>
      ))}
    </ul>
  )
}));

afterEach(cleanup);

const DRIFTED_FACT = at(RAW_FACTS.facts, 0);
const ACTIVE_FACT = {
  ...DRIFTED_FACT, state: 'active', drifted: false, trust: 1,
  symbols: DRIFTED_FACT.symbols.map(symbol => ({ ...symbol, current: true }))
};

/**
 * A server whose one fact is active until an explicit re-check finds its
 * evidence changed; from then on every view reports it as needing review.
 * @param failedRechecks How many re-checks fail before one succeeds.
 */
function driftingServer(failedRechecks = 0): ExploreApi {
  let drifted = false;
  let failures = failedRechecks;
  return fakeApi({
    listWorkspaces: vi.fn(async () => workspaceListSchema.parse({
      defaultWorkspaceId: 1,
      workspaces: [{ id: 1, label: 'demo', root: '/tmp/demo', machine: 'm', lastSeenAt: 1, available: true, counts: { files: 1, symbols: 1, facts: 1, drift: 0 } }]
    })),
    getGraph: vi.fn(async () => graphPayloadSchema.parse({
      ...RAW_GRAPH,
      driftCount: drifted ? 1 : 0,
      nodes: RAW_GRAPH.nodes.map(node => (node.type === 'fact' ? { ...node, state: drifted ? 'needs_review' : 'active', drifted } : node))
    })),
    getSymbol: vi.fn(async () => symbolDetailSchema.parse({
      ...RAW_SYMBOL_DETAIL,
      facts: [{ ...at(RAW_SYMBOL_DETAIL.facts, 0), state: drifted ? 'needs_review' : 'active', evidence_status: drifted ? 'drifted' : 'current' }]
    })),
    listFacts: vi.fn(async (query: FactQuery) => {
      if (query.refresh) {
        if (failures > 0) {
          failures--;
          throw new ApiError('http', 'the workspace database is busy — retry shortly', 503, 'database_busy');
        }
        drifted = true;
      }
      return factListSchema.parse({ ...RAW_FACTS, driftCount: drifted ? 1 : 0, facts: [drifted ? DRIFTED_FACT : ACTIVE_FACT] });
    })
  });
}

const calls = (fn: (...args: never[]) => unknown) => vi.mocked(fn).mock.calls.length;
const rechecks = (api: ExploreApi) => vi.mocked(api.listFacts).mock.calls.filter(([query]) => query.refresh === true).length;
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

async function attachedFacts(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Attached Facts' });
  const section = heading.closest('section');
  if (!section) throw new Error('no Attached Facts section');
  return section;
}

describe('App', () => {
  it('refreshes the graph, header and inspector after an explicit drift re-check', async () => {
    const api = driftingServer();
    render(<App api={api} />);

    const graph = await screen.findByRole('list', { name: 'Graph nodes' });
    fireEvent.click(within(graph).getByRole('button', { name: 'addUser' }));
    const inspected = await attachedFacts();
    expect(await within(inspected).findByText('addUser must stay idempotent')).toBeTruthy();
    expect(within(inspected).queryByText('NEEDS REVIEW')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Knowledge' }));
    const board = await screen.findByRole('region', { name: 'Knowledge' });
    await within(board).findByRole('heading', { name: 'addUser must stay idempotent' });
    expect(screen.queryByRole('button', { name: /NEEDS REVIEW/ })).toBeNull();
    expect(within(graph).queryByText('drifted')).toBeNull();
    const graphLoads = calls(api.getGraph);
    const symbolLoads = calls(api.getSymbol);

    fireEvent.click(within(board).getByRole('button', { name: 'Re-check drift' }));

    await waitFor(() => expect(calls(api.getGraph)).toBe(graphLoads + 1));
    expect(await screen.findByRole('button', { name: '1 NEEDS REVIEW' })).toBeTruthy();
    expect(within(board).getAllByText('1 NEEDS REVIEW')).toHaveLength(1);
    expect(await within(screen.getByRole('list', { name: 'Graph nodes' })).findByText('drifted')).toBeTruthy();

    // The reload the re-check triggers is ordinary, so nothing loops.
    await settle();
    expect(calls(api.getGraph)).toBe(graphLoads + 1);
    expect(rechecks(api)).toBe(1);
    const factLoads = calls(api.listFacts);
    await settle();
    expect(calls(api.listFacts)).toBe(factLoads);

    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }));
    expect(await within(await attachedFacts()).findByText('NEEDS REVIEW')).toBeTruthy();
    expect(calls(api.getSymbol)).toBe(symbolLoads + 1);
  });

  it('shows a recoverable error when the re-check fails', async () => {
    const api = driftingServer(1);
    render(<App api={api} />);

    const board = await screen.findByRole('region', { name: 'Knowledge' });
    await within(board).findByRole('heading', { name: 'addUser must stay idempotent' });
    const graphLoads = calls(api.getGraph);

    fireEvent.click(within(board).getByRole('button', { name: 'Re-check drift' }));

    const alert = await within(board).findByRole('alert');
    expect(alert.textContent).toContain('the workspace database is busy');
    await settle();
    expect(calls(api.getGraph)).toBe(graphLoads);
    expect(screen.queryByRole('button', { name: /NEEDS REVIEW/ })).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(calls(api.getGraph)).toBe(graphLoads + 1));
    expect(rechecks(api)).toBe(2);
    expect(await screen.findByRole('button', { name: '1 NEEDS REVIEW' })).toBeTruthy();
    expect(await within(board).findByText('1 NEEDS REVIEW')).toBeTruthy();
  });
});
