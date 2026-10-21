/**
 * The `caipira explore` HTTP client. Every response is validated against
 * `schemas.ts`; transport, HTTP and validation failures surface as one
 * {@link ApiError} type that components can render safely.
 */
import type { z } from 'zod';
import {
  errorEnvelopeSchema, factListSchema, factMutationSchema, graphPayloadSchema, reindexSchema,
  symbolDetailSchema, symbolSearchSchema, workspaceListSchema
} from './schemas';
import type {
  FactCategory, FactList, FactMutation, FactState, GraphPayload, GraphView, ReindexResult,
  SymbolDetail, SymbolSearch, WorkspaceList
} from './schemas';

/** Why a request failed. */
export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'invalid_response';

/** A failed API request, with a message that is safe to show. */
export class ApiError extends Error {
  /** Failure category. */
  readonly kind: ApiErrorKind;
  /** HTTP status, when the server answered. */
  readonly status: number | null;
  /** The server's stable error code, when it sent one. */
  readonly code: string | null;

  /**
   * @param kind Failure category.
   * @param message Safe, human-readable detail.
   * @param status HTTP status, or null when no response arrived.
   * @param code Server error code, or null.
   * @param cause The underlying failure.
   */
  constructor(kind: ApiErrorKind, message: string, status: number | null = null, code: string | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/**
 * @param error Anything thrown by a request.
 * @returns True when the caller cancelled the request.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * @param error Anything thrown while loading data.
 * @returns The error as an {@link ApiError}.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError('network', 'Something went wrong while talking to the explore server.', null, null, error);
}

/** Filters for `GET /api/graph`. */
export interface GraphQuery {
  workspaceId: number;
  view: GraphView;
  symbolId?: number | undefined;
  depth?: number | undefined;
  pathPrefix?: string | undefined;
  kind?: string | undefined;
  category?: FactCategory | undefined;
  limit?: number | undefined;
}

/** Filters for `GET /api/facts`. */
export interface FactQuery {
  workspaceId: number;
  query?: string | undefined;
  category?: FactCategory | undefined;
  state?: 'open' | 'all' | FactState | undefined;
  refresh?: boolean | undefined;
}

/** A new fact for `POST /api/facts`. */
export interface NewFact {
  kind: FactCategory;
  title: string;
  body: string;
  summary?: string | undefined;
  evidenceFiles?: string[] | undefined;
  evidenceSymbols?: number[] | undefined;
  supersedes?: number | undefined;
}

/** A change for `PATCH /api/facts/:id`. */
export type FactAction =
  | { action: 'reaffirm' }
  | { action: 'archive' }
  | ({ action: 'supersede' } & NewFact)
  | { action: 'update'; title?: string; summary?: string; body?: string; kind?: FactCategory };

/** Operations the explorer UI performs against `caipira explore`. */
export interface ExploreApi {
  listWorkspaces(signal?: AbortSignal): Promise<WorkspaceList>;
  getGraph(query: GraphQuery, signal?: AbortSignal): Promise<GraphPayload>;
  searchSymbols(workspaceId: number, query: string, signal?: AbortSignal): Promise<SymbolSearch>;
  getSymbol(workspaceId: number, symbolId: number, signal?: AbortSignal): Promise<SymbolDetail>;
  listFacts(query: FactQuery, signal?: AbortSignal): Promise<FactList>;
  createFact(workspaceId: number, fact: NewFact): Promise<FactMutation>;
  updateFact(workspaceId: number, factId: number, change: FactAction): Promise<FactMutation>;
  reindex(workspaceId: number): Promise<ReindexResult>;
}

/** Options for {@link createApiClient}. */
export interface ApiClientOptions {
  /** Origin and path prefix of the server; empty for same-origin. */
  baseUrl?: string;
  /** Fetch implementation, for tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

type Params = Record<string, string | number | boolean | undefined>;

function queryString(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * Creates an API client bound to one server.
 * @param options Base URL, fetch implementation and timeout.
 * @returns The client. Its methods reject with {@link ApiError}, or with the
 *   caller's abort reason when the passed signal fires.
 */
export function createApiClient(options: ApiClientOptions = {}): ExploreApi {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 60000;

  async function request<S extends z.ZodTypeAny>(
    schema: S,
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {}
  ): Promise<z.output<S>> {
    const controller = new AbortController();
    const caller = init.signal;
    const forwardAbort = () => controller.abort(caller?.reason);
    if (caller?.aborted) controller.abort(caller.reason);
    else caller?.addEventListener('abort', forwardAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    try {
      let response: Response;
      let text: string;
      try {
        const requestInit: RequestInit = { method: init.method ?? 'GET', signal: controller.signal, headers: { Accept: 'application/json' } };
        if (init.body !== undefined) {
          requestInit.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
          requestInit.body = JSON.stringify(init.body);
        }
        response = await fetchImpl(`${baseUrl}${path}`, requestInit);
        text = await response.text();
      } catch (error) {
        if (caller?.aborted) throw error;
        if (timedOut) throw new ApiError('timeout', 'The explore server took too long to answer.', null, null, error);
        throw new ApiError('network', 'Could not reach the explore server. Is `caipira explore` still running?', null, null, error);
      }

      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        const envelope = errorEnvelopeSchema.safeParse(payload);
        if (envelope.success) throw new ApiError('http', envelope.data.error.message, response.status, envelope.data.error.code);
        throw new ApiError('http', `The explore server answered with status ${response.status}.`, response.status);
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiError('invalid_response', 'The explore server sent a response this UI does not understand.', response.status, null, parsed.error);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', forwardAbort);
    }
  }

  return {
    listWorkspaces: signal => request(workspaceListSchema, '/api/workspaces', { signal }),
    getGraph: (query, signal) => request(graphPayloadSchema, `/api/graph${queryString({
      workspace: query.workspaceId, view: query.view, symbolId: query.symbolId, depth: query.depth,
      pathPrefix: query.pathPrefix, kind: query.kind, category: query.category, limit: query.limit
    })}`, { signal }),
    searchSymbols: (workspaceId, query, signal) =>
      request(symbolSearchSchema, `/api/symbols${queryString({ workspace: workspaceId, q: query, limit: 20 })}`, { signal }),
    getSymbol: (workspaceId, symbolId, signal) =>
      request(symbolDetailSchema, `/api/symbol/${encodeURIComponent(String(symbolId))}${queryString({ workspace: workspaceId })}`, { signal }),
    listFacts: (query, signal) => request(factListSchema, `/api/facts${queryString({
      workspace: query.workspaceId, q: query.query, category: query.category, state: query.state, refresh: query.refresh
    })}`, { signal }),
    createFact: (workspaceId, fact) =>
      request(factMutationSchema, `/api/facts${queryString({ workspace: workspaceId })}`, { method: 'POST', body: fact }),
    updateFact: (workspaceId, factId, change) =>
      request(factMutationSchema, `/api/facts/${encodeURIComponent(String(factId))}${queryString({ workspace: workspaceId })}`, { method: 'PATCH', body: change }),
    reindex: workspaceId =>
      request(reindexSchema, `/api/reindex${queryString({ workspace: workspaceId })}`, { method: 'POST', body: {} })
  };
}
