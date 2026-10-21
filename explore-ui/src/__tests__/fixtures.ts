import { vi } from 'vitest';
import type { ExploreApi } from '../api/client';
import { factListSchema, graphPayloadSchema, symbolDetailSchema, symbolSearchSchema, workspaceListSchema } from '../api/schemas';

/** A raw `GET /api/symbol/:id` payload, in the server's snake_case. */
export const RAW_SYMBOL_DETAIL = {
  workspaceId: 1,
  symbol: {
    id: 7,
    path: 'src/store.ts',
    name: 'addUser',
    qualified_name: 'UserStore.addUser',
    kind: 'method',
    is_public: true,
    start_line: 12,
    end_line: 15,
    params: [
      { name: 'user', type_annotation: 'User', default_value: null },
      { name: 'notify', type_annotation: 'boolean', default_value: 'false' }
    ],
    return_type: 'Promise<UserRecord>',
    doc_summary: 'Adds a user and returns the stored record.',
    signature_text: 'async addUser(user: User, notify: boolean = false): Promise<UserRecord>',
    signature_hash: 'abc'
  },
  language: 'typescript',
  callers: [
    { path: 'src/api.ts', symbol: 'createUser', line: 30, resolved: true, symbol_id: 3 },
    { path: 'src/cli.ts', symbol: 'main', line: 8, resolved: false, symbol_id: null }
  ],
  callees: [
    { target_path: 'src/store.ts', target_symbol: 'UserStore.count', edge_kind: 'calls', line: 14, symbol_id: 8 }
  ],
  uses_types: [
    { target_path: 'src/types.ts', target_symbol: 'User', edge_kind: 'uses_type', line: 12, symbol_id: 2 }
  ],
  used_by: [],
  inherits: [],
  inherited_by: [],
  facts: [
    { fact_id: 41, kind: 'constraint', title: 'addUser must stay idempotent', summary: 'Retries call it twice.', state: 'needs_review', evidence_status: 'drifted', unchecked_symbols: 0 },
    { fact_id: 42, kind: 'decision', title: 'Users live in memory', summary: 'Users live in memory', state: 'active', evidence_status: 'file', unchecked_symbols: 0 }
  ],
  type_links: { User: 2, UserRecord: 5 },
  source: { status: 'ok', start_line: 12, end_line: 15, lines: ['async addUser(user, notify = false) {', '  this.users.push(user);', '  return this.count();', '}'], truncated: false }
};

/** A raw `GET /api/facts` payload. */
export const RAW_FACTS = {
  workspaceId: 1,
  driftCount: 1,
  facts: [
    {
      id: 41, kind: 'constraint', title: 'addUser must stay idempotent', summary: 'Retries call it twice.', body: 'Retries call it twice, so a second call must be a no-op.',
      state: 'needs_review', scope: null, confidence: 1, trust: 0.35, drifted: true, uncheckedSymbols: 0, supersedes: null, supersededBy: null,
      createdAt: 1, updatedAt: 2, lastVerifiedAt: 1, updatedBy: 'mcp',
      evidence: [{ path: 'src/store.ts', inWorkspace: true, startLine: null, endLine: null, nodeId: 'file:src/store.ts', indexed: true }],
      symbols: [{ path: 'src/store.ts', qualifiedName: 'UserStore.addUser', symbolId: 7, nodeId: 'symbol:7', current: false }]
    },
    {
      id: 42, kind: 'decision', title: 'Users live in memory', summary: 'Users live in memory', body: 'No database for users yet.',
      state: 'active', scope: null, confidence: 1, trust: 1, drifted: false, uncheckedSymbols: 0, supersedes: null, supersededBy: null,
      createdAt: 1, updatedAt: 1, lastVerifiedAt: 1, updatedBy: 'explore', evidence: [], symbols: []
    }
  ]
};

/** A raw `GET /api/graph` payload. */
export const RAW_GRAPH = {
  workspaceId: 1,
  view: 'unified',
  nodes: [
    { id: 'file:src/store.ts', type: 'file', label: 'store.ts', path: 'src/store.ts', language: 'typescript', group: 'src', indexed: true },
    { id: 'symbol:7', type: 'symbol', label: 'addUser', symbolId: 7, kind: 'method', path: 'src/store.ts', qualifiedName: 'UserStore.addUser', line: 12, isPublic: true, returnType: 'Promise<UserRecord>', callers: 1 },
    { id: 'fact:41', type: 'fact', label: 'addUser must stay idempotent', factId: 41, category: 'constraint', state: 'needs_review', drifted: true, trust: 0.35, symbolAnchors: 1, uncheckedSymbols: 0 },
    { id: 'session:s1', type: 'session', label: 'claude-code · 2026-10-20 10:00', sessionId: 's1', ide: 'claude-code', startedAt: 1, endedAt: null, summary: null }
  ],
  edges: [
    { id: 'defines:file:src/store.ts->symbol:7', source: 'file:src/store.ts', target: 'symbol:7', kind: 'defines' },
    { id: 'evidences:fact:41->symbol:7', source: 'fact:41', target: 'symbol:7', kind: 'evidences' },
    { id: 'touched:session:s1->file:src/store.ts', source: 'session:s1', target: 'file:src/store.ts', kind: 'touched' }
  ],
  stats: { files: 1, symbols: 1, facts: 1, sessions: 1, edges: 3, indexedFiles: 1, indexedSymbols: 1, truncated: false },
  driftCount: 1,
  focusId: null
};

/**
 * @param list Any list.
 * @param index Position to read.
 * @returns The item, or throws when the fixture is shorter than expected.
 */
export function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`fixture has no item ${index}`);
  return item;
}

/** A fake API whose answers pass through the real response schemas. */
export function fakeApi(overrides: Partial<ExploreApi> = {}): ExploreApi {
  return {
    listWorkspaces: vi.fn(async () => workspaceListSchema.parse({
      defaultWorkspaceId: 1,
      workspaces: [{ id: 1, label: 'demo', root: '/tmp/demo', machine: 'm', lastSeenAt: 1, available: true, counts: { files: 1, symbols: 1, facts: 2, drift: 1 } }]
    })),
    getGraph: vi.fn(async () => graphPayloadSchema.parse(RAW_GRAPH)),
    searchSymbols: vi.fn(async () => symbolSearchSchema.parse({ symbols: [RAW_SYMBOL_DETAIL.symbol], files: [{ path: 'src/store.ts', language: 'typescript' }] })),
    getSymbol: vi.fn(async () => symbolDetailSchema.parse(RAW_SYMBOL_DETAIL)),
    listFacts: vi.fn(async () => factListSchema.parse(RAW_FACTS)),
    createFact: vi.fn(async () => ({ fact: at(factListSchema.parse(RAW_FACTS).facts, 1), driftCount: 1 })),
    updateFact: vi.fn(async () => ({ fact: at(factListSchema.parse(RAW_FACTS).facts, 0), driftCount: 0 })),
    reindex: vi.fn(async () => ({ parsed: 1, unchanged: 0, removed: 0, failed: 0, symbolsTotal: 1, durationMs: 3, driftCount: 1 })),
    ...overrides
  };
}
