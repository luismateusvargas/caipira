/**
 * Runtime schemas for every `caipira explore` API response. Each response is
 * validated here before it reaches a component; symbol records arrive in the
 * index's snake_case and leave as camelCase domain types.
 */
import { z } from 'zod';

const id = z.number().int();
const count = z.number().int().nonnegative();

/** Fact categories, as recorded by caipira. */
export const factCategorySchema = z.enum(['decision', 'constraint', 'preference', 'status', 'gotcha']);
/** Fact lifecycle states. */
export const factStateSchema = z.enum(['active', 'needs_review', 'superseded', 'revoked', 'proposed']);
/** Graph edge kinds. */
export const edgeKindSchema = z.enum(['defines', 'calls', 'imports', 'uses_type', 'extends', 'evidences', 'supersedes', 'touched']);
/** Server-side graph views. */
export const graphViewSchema = z.enum(['unified', 'architecture', 'knowledge', 'impact']);

export type FactCategory = z.infer<typeof factCategorySchema>;
export type FactState = z.infer<typeof factStateSchema>;
export type EdgeKind = z.infer<typeof edgeKindSchema>;
export type GraphView = z.infer<typeof graphViewSchema>;

/** Every fact category, in display order. */
export const FACT_CATEGORIES: readonly FactCategory[] = factCategorySchema.options;

/**
 * @param value Any string, such as a select's value.
 * @returns True when it names a fact category.
 */
export function isFactCategory(value: string): value is FactCategory {
  return factCategorySchema.safeParse(value).success;
}

// ── errors ──

/** The server's error envelope. */
export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() })
});

// ── workspaces ──

export const workspaceSchema = z.object({
  id,
  label: z.string(),
  root: z.string().nullable(),
  machine: z.string(),
  lastSeenAt: z.number(),
  available: z.boolean(),
  counts: z.object({ files: count, symbols: count, facts: count, drift: count }).nullable()
});

export const workspaceListSchema = z.object({
  defaultWorkspaceId: id,
  workspaces: z.array(workspaceSchema)
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceList = z.infer<typeof workspaceListSchema>;

// ── graph ──

const fileNodeSchema = z.object({
  id: z.string(),
  type: z.literal('file'),
  label: z.string(),
  path: z.string(),
  language: z.string().nullable(),
  group: z.string(),
  indexed: z.boolean()
});

const symbolNodeSchema = z.object({
  id: z.string(),
  type: z.literal('symbol'),
  label: z.string(),
  symbolId: id,
  kind: z.string(),
  path: z.string(),
  qualifiedName: z.string(),
  line: z.number().int(),
  isPublic: z.boolean(),
  returnType: z.string().nullable(),
  callers: count
});

const factNodeSchema = z.object({
  id: z.string(),
  type: z.literal('fact'),
  label: z.string(),
  factId: id,
  category: factCategorySchema,
  state: factStateSchema,
  drifted: z.boolean(),
  /** The stored trust score: the code as it is now only when `uncheckedSymbols` is 0. */
  trust: z.number(),
  /** Symbol anchors on record for the fact, whatever edges the view keeps; null from a server too old to say. */
  symbolAnchors: count.nullable().default(null),
  /**
   * Symbol anchors the newest check could not re-read from source: 0 when it
   * read them all, null when no check has covered the fact or the server is
   * too old to say — unknown, never 0.
   */
  uncheckedSymbols: count.nullable().default(null)
});

const sessionNodeSchema = z.object({
  id: z.string(),
  type: z.literal('session'),
  label: z.string(),
  sessionId: z.string(),
  ide: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  summary: z.string().nullable()
});

export const graphNodeSchema = z.discriminatedUnion('type', [fileNodeSchema, symbolNodeSchema, factNodeSchema, sessionNodeSchema]);

export const graphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: edgeKindSchema
});

export const graphPayloadSchema = z.object({
  workspaceId: id,
  view: graphViewSchema,
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  stats: z.object({
    files: count,
    symbols: count,
    facts: count,
    sessions: count,
    edges: count,
    indexedFiles: count,
    indexedSymbols: count,
    truncated: z.boolean()
  }),
  driftCount: count,
  focusId: z.string().nullable()
});

export type FileNode = z.infer<typeof fileNodeSchema>;
export type SymbolNode = z.infer<typeof symbolNodeSchema>;
export type FactNode = z.infer<typeof factNodeSchema>;
export type SessionNode = z.infer<typeof sessionNodeSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphPayload = z.infer<typeof graphPayloadSchema>;

/**
 * @param node A graph fact node.
 * @returns True when the fact has, or may have, symbol anchors that no check
 *   re-read from source, so its drift flag and trust describe the last index.
 */
export function evidenceNotChecked(node: FactNode): boolean {
  return node.symbolAnchors !== 0 && node.uncheckedSymbols !== 0;
}

// ── symbols ──

const paramSchema = z.object({
  name: z.string(),
  type_annotation: z.string().nullish(),
  default_value: z.string().nullish()
}).transform(param => ({
  name: param.name,
  typeAnnotation: param.type_annotation ?? null,
  defaultValue: param.default_value ?? null
}));

/** A symbol row from the AST index. */
export const symbolRecordSchema = z.object({
  id,
  path: z.string(),
  name: z.string(),
  qualified_name: z.string(),
  kind: z.string(),
  is_public: z.boolean(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  params: z.array(paramSchema),
  return_type: z.string().nullish(),
  doc_summary: z.string().nullish(),
  signature_text: z.string()
}).transform(row => ({
  id: row.id,
  path: row.path,
  name: row.name,
  qualifiedName: row.qualified_name,
  kind: row.kind,
  isPublic: row.is_public,
  startLine: row.start_line,
  endLine: row.end_line,
  params: row.params,
  returnType: row.return_type ?? null,
  docSummary: row.doc_summary ?? null,
  signatureText: row.signature_text
}));

export type SymbolParam = z.infer<typeof paramSchema>;
export type SymbolRecord = z.infer<typeof symbolRecordSchema>;

/** A related symbol: a caller, callee, type reference, or inheritance link. */
export interface SymbolRef {
  name: string;
  path: string | null;
  line: number;
  symbolId: number | null;
  relation: string;
  resolved: boolean;
}

const incomingRefSchema = z.object({
  path: z.string(),
  symbol: z.string().nullable(),
  line: z.number().int(),
  edge_kind: z.string().optional(),
  resolved: z.boolean().optional(),
  symbol_id: id.nullable()
}).transform((row): SymbolRef => ({
  name: row.symbol ?? '(top level)',
  path: row.path,
  line: row.line,
  symbolId: row.symbol_id,
  relation: row.edge_kind ?? 'calls',
  resolved: row.resolved ?? true
}));

const outgoingRefSchema = z.object({
  target_path: z.string().nullable(),
  target_symbol: z.string(),
  edge_kind: z.string(),
  line: z.number().int(),
  symbol_id: id.nullable()
}).transform((row): SymbolRef => ({
  name: row.target_symbol,
  path: row.target_path,
  line: row.line,
  symbolId: row.symbol_id,
  relation: row.edge_kind,
  resolved: row.target_path !== null
}));

const attachedFactSchema = z.object({
  fact_id: id,
  kind: factCategorySchema,
  title: z.string(),
  summary: z.string(),
  state: factStateSchema,
  /** How the fact attaches here; `current` and `drifted` compare its anchor with the indexed signature. */
  evidence_status: z.enum(['current', 'drifted', 'file_range', 'file']),
  /** As the fact DTO's `uncheckedSymbols`: missing from a server too old to send it is unknown, never 0. */
  unchecked_symbols: count.nullable().default(null)
}).transform(row => ({
  factId: row.fact_id,
  category: row.kind,
  title: row.title,
  summary: row.summary,
  state: row.state,
  anchor: row.evidence_status,
  uncheckedSymbols: row.unchecked_symbols
}));

const sourceSchema = z.union([
  z.object({
    status: z.literal('ok'),
    start_line: z.number().int(),
    end_line: z.number().int(),
    lines: z.array(z.string()),
    truncated: z.boolean()
  }).transform(source => ({
    status: source.status,
    startLine: source.start_line,
    endLine: source.end_line,
    lines: source.lines,
    truncated: source.truncated
  })),
  z.object({ status: z.literal('unavailable'), reason: z.string() })
]);

/** Everything `GET /api/symbol/:id` reports about one symbol. */
export const symbolDetailSchema = z.object({
  workspaceId: id,
  symbol: symbolRecordSchema,
  language: z.string().nullable(),
  callers: z.array(incomingRefSchema),
  callees: z.array(outgoingRefSchema),
  uses_types: z.array(outgoingRefSchema),
  used_by: z.array(incomingRefSchema),
  inherits: z.array(outgoingRefSchema),
  inherited_by: z.array(incomingRefSchema),
  facts: z.array(attachedFactSchema),
  type_links: z.record(z.string(), id),
  source: sourceSchema
}).transform(detail => ({
  workspaceId: detail.workspaceId,
  symbol: detail.symbol,
  language: detail.language,
  callers: detail.callers,
  callees: detail.callees,
  typeReferences: [...detail.uses_types, ...detail.inherits],
  typeDependents: [...detail.used_by, ...detail.inherited_by],
  facts: detail.facts,
  typeLinks: detail.type_links,
  source: detail.source
}));

export type AttachedFact = z.infer<typeof attachedFactSchema>;
export type SourcePreview = z.infer<typeof sourceSchema>;
export type SymbolDetail = z.infer<typeof symbolDetailSchema>;

export const symbolSearchSchema = z.object({
  symbols: z.array(symbolRecordSchema),
  files: z.array(z.object({ path: z.string(), language: z.string() }))
});

export type SymbolSearch = z.infer<typeof symbolSearchSchema>;

// ── facts ──

export const factSchema = z.object({
  id,
  kind: factCategorySchema,
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  state: factStateSchema,
  scope: z.string().nullable(),
  confidence: z.number(),
  trust: z.number(),
  drifted: z.boolean(),
  /**
   * Symbol anchors the server could not re-read from source: 0 when a check
   * read them all, null when no check has covered the fact. A server too old
   * to send it is unknown as well, never 0.
   */
  uncheckedSymbols: count.nullable().default(null),
  supersedes: id.nullable(),
  supersededBy: id.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastVerifiedAt: z.number().nullable(),
  updatedBy: z.string().nullable(),
  evidence: z.array(z.object({
    path: z.string(),
    inWorkspace: z.boolean(),
    startLine: z.number().int().nullable(),
    endLine: z.number().int().nullable(),
    nodeId: z.string().nullable(),
    indexed: z.boolean()
  })),
  symbols: z.array(z.object({
    path: z.string(),
    qualifiedName: z.string(),
    symbolId: id.nullable(),
    nodeId: z.string().nullable(),
    /** The anchor matches the indexed signature: the code as it is now only when `uncheckedSymbols` is 0. */
    current: z.boolean()
  }))
});

export const factListSchema = z.object({
  workspaceId: id,
  facts: z.array(factSchema),
  driftCount: count
});

export const factMutationSchema = z.object({
  fact: factSchema,
  superseded: factSchema.optional(),
  driftCount: count
});

export type Fact = z.infer<typeof factSchema>;
export type FactList = z.infer<typeof factListSchema>;
export type FactMutation = z.infer<typeof factMutationSchema>;

// ── reindex ──

export const reindexSchema = z.object({
  workspaceId: id,
  stats: z.object({
    parsed: count,
    skipped: count,
    hash_matched: count,
    removed: count,
    failed: count,
    symbols_total: count,
    duration_ms: count
  }),
  driftCount: count
}).transform(result => ({
  parsed: result.stats.parsed,
  unchanged: result.stats.skipped + result.stats.hash_matched,
  removed: result.stats.removed,
  failed: result.stats.failed,
  symbolsTotal: result.stats.symbols_total,
  durationMs: result.stats.duration_ms,
  driftCount: result.driftCount
}));

export type ReindexResult = z.infer<typeof reindexSchema>;
