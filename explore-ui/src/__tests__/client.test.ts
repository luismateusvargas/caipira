import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, isAbortError } from '../api/client';
import { graphPayloadSchema, symbolDetailSchema } from '../api/schemas';
import { RAW_GRAPH, RAW_SYMBOL_DETAIL } from './fixtures';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function first<T>(list: readonly T[]): T {
  const item = list[0];
  if (item === undefined) throw new Error('expected at least one item');
  return item;
}

describe('response schemas', () => {
  it('maps a symbol detail payload to camelCase domain types', () => {
    const detail = symbolDetailSchema.parse(RAW_SYMBOL_DETAIL);

    expect(detail.symbol.params).toEqual([
      { name: 'user', typeAnnotation: 'User', defaultValue: null },
      { name: 'notify', typeAnnotation: 'boolean', defaultValue: 'false' }
    ]);
    expect(detail.symbol.returnType).toBe('Promise<UserRecord>');
    expect(first(detail.callers)).toEqual({ name: 'createUser', path: 'src/api.ts', line: 30, symbolId: 3, relation: 'calls', resolved: true });
    expect(detail.typeReferences).toEqual([{ name: 'User', path: 'src/types.ts', line: 12, symbolId: 2, relation: 'uses_type', resolved: true }]);
    expect(detail.source).toEqual({ status: 'ok', startLine: 12, endLine: 15, lines: RAW_SYMBOL_DETAIL.source.lines, truncated: false });
  });

  it('accepts every node type and rejects an unknown edge kind', () => {
    expect(graphPayloadSchema.parse(RAW_GRAPH).nodes.map(node => node.type)).toEqual(['file', 'symbol', 'fact', 'session']);

    const broken = { ...RAW_GRAPH, edges: [{ id: 'x', source: 'a', target: 'b', kind: 'teleports' }] };

    expect(graphPayloadSchema.safeParse(broken).success).toBe(false);
  });
});

describe('createApiClient', () => {
  it('builds graph queries and validates the answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, RAW_GRAPH));
    const api = createApiClient({ fetchImpl });

    const graph = await api.getGraph({ workspaceId: 3, view: 'impact', symbolId: 7, depth: 2, kind: undefined });

    expect(graph.stats.symbols).toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/graph?workspace=3&view=impact&symbolId=7&depth=2', expect.objectContaining({ method: 'GET' }));
  });

  it('sends writes as JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(500, { error: { code: 'internal_error', message: 'boom' } }));
    const api = createApiClient({ fetchImpl });

    await expect(api.updateFact(1, 9, { action: 'reaffirm' })).rejects.toBeInstanceOf(ApiError);

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe('{"action":"reaffirm"}');
    expect(init?.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
  });

  it('translates the server error envelope', async () => {
    const api = createApiClient({ fetchImpl: async () => jsonResponse(403, { error: { code: 'path_outside_workspace', message: 'path is outside the workspace root' } }) });

    const error = await api.getSymbol(1, 5).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'http', status: 403, code: 'path_outside_workspace', message: 'path is outside the workspace root' });
  });

  it('rejects a response that does not match the schema', async () => {
    const api = createApiClient({ fetchImpl: async () => jsonResponse(200, { nodes: 'nope' }) });

    await expect(api.getGraph({ workspaceId: 1, view: 'unified' })).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('reports an unreachable server as a network error', async () => {
    const api = createApiClient({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });

    await expect(api.listWorkspaces()).rejects.toMatchObject({ kind: 'network' });
  });

  it('lets the caller cancel a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const api = createApiClient({ fetchImpl });
    const controller = new AbortController();

    const pending = api.listWorkspaces(controller.signal).catch((caught: unknown) => caught);
    controller.abort();

    expect(isAbortError(await pending)).toBe(true);
  });

  it('times out a request that never answers', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const api = createApiClient({ fetchImpl, timeoutMs: 5 });

    await expect(api.listWorkspaces()).rejects.toMatchObject({ kind: 'timeout' });
  });
});
