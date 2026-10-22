#!/usr/bin/env node
// caipira/mcp.js — stdio MCP server with embedding-powered search
// Loads @xenova/transformers lazily. Backfills embeddings on idle.
// Tools: search, get_observations, list_sessions, timeline

const path = require('path');
const os = require('os');
const fs = require('fs');
const { logError } = require('./errors');
const { version } = require('./package.json');

let MemoryStore, redactPrivate, ensureWorkspace, openWorkspaceDb, machineId, listWorkspaces, canonicalKey;
let FactStore, searchWorkspaces, syncWorkspaceAst, updateFileAst, queryWorkspaceSymbols, inspectSymbol;
let moduleFailure = null;
try {
  ({ MemoryStore, redactPrivate } = require('./store'));
  ({ ensureWorkspace, openWorkspaceDb, machineId, listWorkspaces, canonicalKey } = require('./workspace'));
  ({ FactStore, searchWorkspaces } = require('./facts'));
  ({ syncWorkspaceAst, updateFileAst, queryWorkspaceSymbols, inspectSymbol } = require('./ast'));
  // Force the lazy native binding load inside this guarded startup boundary.
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (error) {
  moduleFailure = error;
  journal('load modules', error);
}

function journal(operation, error, payload) {
  logError({ component: 'mcp', operation, error, payload });
}

let embedderPromise = null;
let backfillTimer = null;

// ── workspace-scoped fact access ──
//
// The MCP server runs as its own process with no SessionStart hook of its own,
// so it provisions the workspace itself rather than assuming a hook got there
// first. Connections are cached per workspace: resolving is cheap, opening is not.
const factConnections = new Map();
const fullyIndexedWorkspaces = new Set();

// `caipira prune --apply` can delete a workspace database under a running
// server, and ensureWorkspace() then provisions a fresh file at the same path.
// A cached handle would keep reading and writing the unlinked file, so each
// cache entry remembers which file it opened and is dropped once that changes.
function fileIdentity(dbFile) {
  try { return fs.statSync(dbFile).ino; } catch { return null; }
}

function isStale(entry, dbFile) {
  const identity = fileIdentity(dbFile);
  return identity === null || identity !== entry.identity;
}

function factsFor(cwd) {
  const workspace = ensureWorkspace(cwd || process.cwd());
  let entry = factConnections.get(workspace.dbFile);
  if (entry && isStale(entry, workspace.dbFile)) {
    try { entry.db.close(); } catch {}
    factConnections.delete(workspace.dbFile);
    fullyIndexedWorkspaces.delete(workspace.dbFile);
    entry = null;
  }
  if (!entry) {
    const db = openWorkspaceDb(workspace.dbFile);
    entry = {
      db, identity: fileIdentity(workspace.dbFile),
      store: new FactStore(db, { machine: machineId(), agent: 'mcp', root: workspace.root })
    };
    factConnections.set(workspace.dbFile, entry);
  }
  return { workspace, facts: entry.store };
}

function closeFactConnections() {
  for (const entry of factConnections.values()) {
    try { entry.db.close(); } catch {}
  }
  factConnections.clear();
  fullyIndexedWorkspaces.clear();
}

// Observations live in the same per-workspace database the hooks write to.
// A bare MemoryStore() would open the legacy data.db instead, which the hooks
// no longer touch — search and backfill would then see an empty corpus.
const memoryStores = new Map();

function memoryAt(dbFile) {
  let entry = memoryStores.get(dbFile);
  if (entry && isStale(entry, dbFile)) {
    try { entry.memory.close(); } catch {}
    memoryStores.delete(dbFile);
    entry = null;
  }
  if (!entry) {
    const memory = new MemoryStore({ dbPath: dbFile });
    entry = { memory, identity: fileIdentity(dbFile) };
    memoryStores.set(dbFile, entry);
  }
  return entry.memory;
}

function memoryFor(cwd) {
  return memoryAt(ensureWorkspace(cwd || process.cwd()).dbFile);
}

function closeMemoryStores() {
  for (const entry of memoryStores.values()) {
    try { entry.memory.close(); } catch {}
  }
  memoryStores.clear();
}

function closeAll() {
  closeMemoryStores();
  closeFactConnections();
}

function ensureAstIndex(workspace) {
  if (fullyIndexedWorkspaces.has(workspace.dbFile)) return;
  syncWorkspaceAst(workspace.root, workspace.dbFile);
  fullyIndexedWorkspaces.add(workspace.dbFile);
}

function resolveSymbolEvidence(workspace, db, selectors) {
  const resolved = [];
  for (const selector of selectors) {
    if (!nonEmptyString(selector)) throw new Error('evidence_symbols must contain non-empty strings');
    const split = selector.indexOf('::');
    const line = selector.match(/^(.+):(\d+)$/);
    const relPath = split > 0 ? selector.slice(0, split) : line ? line[1] : null;
    if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
      throw new Error(`evidence symbol needs a workspace-relative source path: ${selector}`);
    }
    const absolute = path.resolve(workspace.root, relPath);
    updateFileAst(workspace.root, workspace.dbFile, absolute);
    const found = inspectSymbol(db, selector);
    if (!found || found.symbol.path !== relPath.replace(/\\/g, '/')) {
      throw new Error(`symbol not found: ${selector}`);
    }
    resolved.push({ path: found.symbol.path, qualifiedName: found.symbol.qualified_name,
      signatureHash: found.symbol.signature_hash });
  }
  return [...new Map(resolved.map(symbol =>
    [`${symbol.path}::${symbol.qualifiedName}`, symbol])).values()];
}

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DIM = 384;

// ── Debug traffic log ──
//
// Opt-in only: raw stdio carries prompts and tool output. Lives under
// CAIPIRA_HOME when that is set, so test runs never write into the install.
const DEBUG_TRAFFIC = process.env.CAIPIRA_DEBUG === '1';
const TRAFFIC_LOG = process.env.CAIPIRA_HOME
  ? path.join(path.resolve(process.env.CAIPIRA_HOME), 'logs', 'mcp_traffic.log')
  : path.join(__dirname, 'logs', 'mcp_traffic.log');
const TRAFFIC_LOG_MAX_BYTES = 5 * 1024 * 1024;

function logTraffic(direction, data) {
  if (!DEBUG_TRAFFIC || moduleFailure) return;
  try {
    fs.mkdirSync(path.dirname(TRAFFIC_LOG), { recursive: true });
    let size = 0;
    try { size = fs.statSync(TRAFFIC_LOG).size; } catch {}
    if (size >= TRAFFIC_LOG_MAX_BYTES) fs.renameSync(TRAFFIC_LOG, `${TRAFFIC_LOG}.1`);
    fs.appendFileSync(TRAFFIC_LOG, `[${new Date().toISOString()}] ${direction}: ${redactPrivate(String(data))}\n`);
  } catch (e) {
    // Diagnostics must never take the server down with them.
    journal('traffic log', e);
    console.error('[caipira] traffic log write failed:', e.message);
  }
}

// ── Embedder (lazy, cached) ──

// The bundled model ships next to this file; ~/.caipira/models is the
// fallback for a checkout run without one.
function modelDirectory() {
  if (process.env.CAIPIRA_MODEL_PATH) return path.resolve(process.env.CAIPIRA_MODEL_PATH);
  const bundled = path.join(__dirname, 'models');
  return fs.existsSync(bundled) ? bundled : path.join(os.homedir(), '.caipira', 'models');
}

// Concurrent first requests share one pipeline load rather than racing to
// load the model several times. A failed load is forgotten so a later call
// can retry it.
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = loadEmbedder().catch(error => {
      journal('load embedder', error);
      embedderPromise = null;
      throw error;
    });
  }
  return embedderPromise;
}

async function loadEmbedder() {
  const transformers = require('@xenova/transformers');
  const directory = modelDirectory();
  transformers.env.localModelPath = directory;
  transformers.env.cacheDir = directory;
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = false;
  transformers.env.useFS = true;
  transformers.env.useFSCache = true;
  const extractor = await transformers.pipeline('feature-extraction', MODEL, { quantized: true });

  console.error('[caipira] embedder loaded:', MODEL);
  return {
    model: MODEL,
    dim: MODEL_DIM,
    embed: async (text) => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return new Float32Array(out.data);
    }
  };
}

// ── Backfill ──

const BACKFILL_BATCH = 50;

// Every registered workspace is backfilled, not just the one this server was
// started in: hooks from any client write to any workspace, and a workspace
// nobody has searched yet should still be ready when someone does.
async function backfillMissing() {
  if (moduleFailure) return;
  let count = 0;
  let more = false;
  for (const row of listWorkspaces()) {
    if (!fs.existsSync(row.db_file)) continue;
    let memory;
    try {
      memory = memoryAt(row.db_file);
    } catch (e) {
      journal('open backfill workspace', e);
      console.error('[caipira] backfill skipped', row.db_file, ':', e.message);
      continue;
    }
    const missing = memory.observationsMissingEmbeddings(BACKFILL_BATCH, MODEL);
    if (missing.length === 0) continue;
    if (missing.length === BACKFILL_BATCH) more = true;

    const emb = await getEmbedder();
    for (const obs of missing) {
      try {
        const vec = await emb.embed(obs.content);
        memory.putEmbedding(obs.id, MODEL, vec);
        count++;
      } catch (e) {
        journal('embed observation', e);
        console.error('[caipira] embed failed for obs', obs.id, ':', e.message);
      }
    }
  }
  if (count > 0) console.error(`[caipira] backfilled ${count} embeddings`);
  // A full batch means there is likely more; keep going without waiting for
  // the next request to come in.
  if (more) scheduleBackfill();
}

function scheduleBackfill() {
  if (backfillTimer) clearTimeout(backfillTimer);
  backfillTimer = setTimeout(() => {
    backfillMissing().catch(e => {
      journal('backfill', e);
      console.error('[caipira] backfill error:', e.message);
    });
  }, 5000); // 5s after last activity
}

// ── MCP protocol ──

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    logTraffic('IN', line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      journal('parse request', e);
      logTraffic('IN-ERR', e.message);
      respondError(null, -32700, 'Parse error: ' + e.message);
      continue;
    }
    if (!isPlainObject(msg) || typeof msg.method !== 'string') {
      respondError(isPlainObject(msg) && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
      continue;
    }
    // handle() is async: without this a throw inside it is an unhandled
    // rejection, which takes the whole server down.
    handle(msg).catch(err => {
      journal(msg.method, err, msg);
      respondError(msg.id ?? null, -32603, err.message);
    });
  }
});

// JSON-RPC 2.0: notifications (no id) are never replied to.
function send(id, body) {
  if (id === undefined) return;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, ...body });
  logTraffic('OUT', payload);
  process.stdout.write(payload + '\n');
}

function respond(id, result) {
  send(id, { result });
}

function respondError(id, code, message) {
  send(id, { error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  scheduleBackfill();

  // JSON-RPC 2.0: Notifications have no id and MUST NOT be replied to
  if (id === undefined) {
    return;
  }

  switch (method) {
    case 'ping':
      respond(id, {});
      break;

    case 'server/discover':
      respond(id, {
        resultType: 'complete',
        supportedVersions: ['2024-11-05'],
        capabilities: { tools: {} },
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'caipira',
            version
          }
        },
        instructions: 'Caipira provides local cross-session memory search, observations and session timelines; durable facts (record_fact, search_facts, update_fact); drift detection (check_drift); and AST symbol tools (workspace_symbols, inspect_symbol).'
      });
      break;

    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'caipira', version }
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      respond(id, {
        tools: [
          {
            name: 'search',
            description: 'Search caipira memory across sessions using hybrid FTS5 + embedding search. Multi-word queries require ALL terms (AND logic); falls back to substring OR search if FTS5 returns nothing. For broad recall, use single keywords. Returns relevant observations with snippets and scores.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search terms. Multi-word = AND (all must match). Falls back to OR substring search when no FTS5 hits. Prefer 1-3 keywords for best results.' },
                limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
                cwd: { type: 'string', description: 'Workspace path (defaults to the server working directory)' }
              },
              required: ['query']
            }
          },
          {
            name: 'get_observations',
            description: 'Retrieve specific observations by their IDs, optionally expanding compressed content.',
            inputSchema: {
              type: 'object',
              properties: {
                ids: { type: 'array', items: { type: 'number' }, description: 'Observation IDs to retrieve' },
                expand: { type: 'boolean', description: 'Expand compressed abbreviations (default false)' },
                cwd: { type: 'string', description: 'Workspace path (defaults to the server working directory)' }
              },
              required: ['ids']
            }
          },
          {
            name: 'list_sessions',
            description: 'List recent sessions with their metadata.',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Max sessions (default 20)', default: 20 },
                cwd: { type: 'string', description: 'Workspace path (defaults to the server working directory)' }
              }
            }
          },
          {
            name: 'timeline',
            description: 'Get timeline of observations for a session.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
                cwd: { type: 'string', description: 'Workspace path (defaults to the server working directory)' }
              },
              required: ['session_id']
            }
          },
          {
            name: 'record_fact',
            description: 'Record a durable fact about this workspace: a decision, constraint, preference, status, or gotcha. Use this whenever something is settled that a future session would otherwise have to re-derive by re-reading files. List the files the fact came from in `evidence` — caipira fingerprints them, so a later session can trust the fact without opening them, and is told to re-read exactly the ones that changed. Body is stored verbatim.',
            inputSchema: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['decision', 'constraint', 'preference', 'status', 'gotcha'], description: 'decision = a choice made; constraint = a rule that must hold; preference = how the user wants things done; status = current state of work (expires); gotcha = a trap to avoid' },
                title: { type: 'string', description: 'Short handle, a few words' },
                body: { type: 'string', description: 'The full statement, including the reasoning. Stored verbatim.' },
                summary: { type: 'string', description: 'One line. This is what gets injected into future sessions, so make it self-contained.' },
                evidence: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files this fact was derived from' },
                evidence_ranges: { type: 'array', items: { type: 'object', properties: {
                  path: { type: 'string', description: 'Absolute source file path' },
                  start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 }
                }, required: ['path', 'start_line', 'end_line'] },
                description: 'Inclusive source line ranges linked to a fact' },
                evidence_symbols: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative path::qualified_name or path:line selectors' },
                scope: { type: 'string', description: 'Optional sub-path this fact applies to' },
                confidence: { type: 'number', description: '0..1, default 1.0' },
                ttl_days: { type: 'number', description: 'Re-verify after this many days. Defaults to 14 for status, none otherwise.' },
                supersedes: { type: 'number', description: 'Fact id this replaces. The old fact is kept and marked superseded.' },
                session_id: { type: 'string' },
                cwd: { type: 'string', description: 'Workspace path (defaults to the server working directory)' }
              },
              required: ['kind', 'title', 'body']
            }
          },
          {
            name: 'search_facts',
            description: 'Search durable facts, ranked by trust (relevance x still-true). Prefer this over `search` when you need what was decided rather than what happened. Results carry evidence_status: a fact whose files changed is flagged and ranked down, and evidence_status.unchecked counts symbol evidence that could not be re-read just now, so such a fact is unverified rather than current. Defaults to this workspace; pass scope="all" to search every registered workspace when the current one has no answer and another project likely solved the same problem.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                limit: { type: 'number', default: 10 },
                include_stale: { type: 'boolean', description: 'Include facts needing review (default true)' },
                scope: {
                  type: 'string',
                  enum: ['workspace', 'all'],
                  description: 'workspace (default) searches only here. "all" searches every registered workspace; each result carries the workspace it came from. Facts from another workspace were settled against a different codebase — treat them as precedent to check, not as settled truth here.'
                },
                cwd: { type: 'string' }
              },
              required: ['query']
            }
          },
          {
            name: 'update_fact',
            description: 'Revise a fact in place, or change its state. Use state=revoked when a fact is no longer true and nothing replaces it; use record_fact with `supersedes` when something does.',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                kind: { type: 'string', enum: ['decision', 'constraint', 'preference', 'status', 'gotcha'] },
                title: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string' },
                scope: { type: 'string', description: 'Sub-path this fact applies to' },
                evidence: { type: 'array', items: { type: 'string' }, description: 'Replaces this machine\'s evidence files; each is re-fingerprinted' },
                state: { type: 'string', enum: ['active', 'needs_review', 'superseded', 'revoked', 'proposed'] },
                confidence: { type: 'number' }, ttl_days: { type: 'number' },
                cwd: { type: 'string' }
              },
              required: ['id']
            }
          },
          {
            name: 'check_drift',
            description: 'Re-verify facts against their evidence files and report which have drifted. Returns the specific files that changed — read those, not the whole workspace. This is the cheap way to find out what you actually need to look at.',
            inputSchema: {
              type: 'object',
              properties: {
                ids: { type: 'array', items: { type: 'number' }, description: 'Specific facts to verify (default: all active)' },
                cwd: { type: 'string' }
              }
            }
          },
          {
            name: 'workspace_symbols',
            description: 'Find indexed functions, types, and other symbols in this workspace.',
            inputSchema: { type: 'object', properties: {
              query: { type: 'string' }, kind: { type: 'string' }, path_prefix: { type: 'string' },
              public_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 0, maximum: 500 },
              cwd: { type: 'string' }
            } }
          },
          {
            name: 'inspect_symbol',
            description: 'Inspect one symbol, its signature, graph connections, imports, and attached facts.',
            inputSchema: { type: 'object', properties: {
              symbol: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
              path: { type: 'string' }, cwd: { type: 'string' }
            }, required: ['symbol'] }
          },
          {
            name: 'list_workspaces',
            description: 'List known workspaces and the database file each one uses.',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      });
      break;

    case 'tools/call':
      await handleToolCall(id, params);
      break;

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

// Argument checks for the fields each tool cannot run without. Returns the
// problem as a message, or null when the arguments are usable.
const MAX_IDS = 500;
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const validIds = ids => Array.isArray(ids) && ids.length <= MAX_IDS && ids.every(Number.isInteger);

function invalidArguments(name, args) {
  if (args.cwd !== undefined && typeof args.cwd !== 'string') return 'cwd must be a string';
  switch (name) {
    case 'search':
    case 'search_facts':
      return nonEmptyString(args.query) ? null : 'Missing required parameter: query';
    case 'get_observations':
      return validIds(args.ids) ? null : `ids must be an array of at most ${MAX_IDS} integer ids`;
    case 'check_drift':
      return args.ids === undefined || validIds(args.ids) ? null : `ids must be an array of at most ${MAX_IDS} integer ids`;
    case 'timeline':
      return nonEmptyString(args.session_id) ? null : 'Missing required parameter: session_id';
    case 'update_fact':
      return Number.isInteger(args.id) ? null : 'id must be an integer fact id';
    case 'record_fact':
      if (args.evidence_symbols !== undefined &&
          (!Array.isArray(args.evidence_symbols) || !args.evidence_symbols.every(nonEmptyString))) {
        return 'evidence_symbols must be an array of symbol selectors';
      }
      if (args.evidence_ranges !== undefined &&
          (!Array.isArray(args.evidence_ranges) || args.evidence_ranges.some(range =>
            !isPlainObject(range) || !nonEmptyString(range.path) || !path.isAbsolute(range.path) ||
            !Number.isSafeInteger(range.start_line) || !Number.isSafeInteger(range.end_line) ||
            range.start_line < 1 || range.end_line < range.start_line))) {
        return 'evidence_ranges must contain absolute paths and valid inclusive line ranges';
      }
      if (args.evidence_ranges && new Set(args.evidence_ranges.map(range => canonicalKey(range.path))).size !== args.evidence_ranges.length) {
        return 'evidence_ranges may list each file once';
      }
      return null;
    case 'inspect_symbol':
      return (nonEmptyString(args.symbol) || Number.isInteger(args.symbol)) &&
        (args.path === undefined || nonEmptyString(args.path))
        ? null : 'symbol must be a name or integer id; path must be a non-empty string';
    case 'workspace_symbols':
      for (const field of ['query', 'kind', 'path_prefix']) {
        if (args[field] !== undefined && typeof args[field] !== 'string') return `${field} must be a string`;
      }
      if (args.public_only !== undefined && typeof args.public_only !== 'boolean') return 'public_only must be boolean';
      return args.limit === undefined || (Number.isInteger(args.limit) && args.limit >= 0 && args.limit <= 500)
        ? null : 'limit must be an integer from 0 to 500';
    default:
      return null;
  }
}

async function handleToolCall(id, params) {
  if (!isPlainObject(params) || typeof params.name !== 'string') {
    respondError(id, -32602, 'tools/call needs params with a tool name');
    return;
  }
  const { name, arguments: args = {} } = params;
  if (!isPlainObject(args)) {
    respondError(id, -32602, 'arguments must be an object');
    return;
  }
  const problem = invalidArguments(name, args);
  if (problem) {
    respondError(id, -32602, problem);
    return;
  }

  try {
    if (moduleFailure) throw moduleFailure;
    let result;
    switch (name) {
      case 'search': {
        const emb = await getEmbedder().catch(() => null);
        const hits = await memoryFor(args.cwd).search(args.query, args.limit || 10, emb);
        result = { content: [{ type: 'text', text: JSON.stringify(hits) }] };
        break;
      }
      case 'get_observations': {
        const rows = memoryFor(args.cwd).getObservations(args.ids, { expand: args.expand ?? false });
        result = { content: [{ type: 'text', text: JSON.stringify(rows) }] };
        break;
      }
      case 'list_sessions': {
        const sessions = memoryFor(args.cwd).listSessions(args.limit || 20);
        result = { content: [{ type: 'text', text: JSON.stringify(sessions) }] };
        break;
      }
      case 'timeline': {
        const rows = memoryFor(args.cwd).timeline(args.session_id, null, args.limit || 20);
        result = { content: [{ type: 'text', text: JSON.stringify(rows) }] };
        break;
      }
      case 'record_fact': {
        const { workspace, facts } = factsFor(args.cwd);
        const evidenceSymbols = args.evidence_symbols
          ? resolveSymbolEvidence(workspace, facts.db, args.evidence_symbols) : [];
        const factId = facts.record({ ...args, evidenceSymbols });
        const saved = facts.get(factId);
        result = { content: [{ type: 'text', text: JSON.stringify({
          id: factId, workspace: workspace.root, db: workspace.dbFile,
          state: saved.state, evidence: saved.evidence.map(e => e.path),
          evidence_ranges: saved.evidence.filter(e => e.start_line !== null)
            .map(e => ({ path: e.path, start_line: e.start_line, end_line: e.end_line })),
          evidence_symbols: saved.symbol_evidence.map(e => `${e.path}::${e.qualified_name}`)
        }) }] };
        break;
      }
      case 'search_facts': {
        const { workspace, facts } = factsFor(args.cwd);
        const states = args.include_stale === false
          ? ['active']
          : ['active', 'needs_review', 'proposed'];
        const limit = args.limit || 10;

        const render = fact => ({
          id: fact.id, kind: fact.kind, title: fact.title, summary: fact.summary, body: fact.body,
          state: fact.state, trust: Number(fact.trust.toFixed(3)),
          updated_at: fact.updated_at, updated_by: fact.updated_by,
          stale_files: fact.evidence_status.changedPaths,
          evidence_status: fact.evidence_status,
          ...(fact.workspace ? { workspace: fact.workspace } : {})
        });

        if (args.scope === 'all') {
          const hits = searchWorkspaces(args.query, { limit, states, machine: machineId(), agent: 'mcp' });
          const local = hits.filter(f => f.workspace_id === workspace.id).length;
          result = { content: [{ type: 'text', text: JSON.stringify({
            scope: 'all',
            workspace: workspace.root,
            searched_workspaces: listWorkspaces().length,
            note: local === hits.length
              ? undefined
              : 'Results marked with a different workspace were settled against another codebase. Treat them as precedent worth checking here, not as facts about this project.',
            facts: hits.map(render)
          }) }] };
          break;
        }

        const hits = facts.search(args.query, { limit, states });
        result = { content: [{ type: 'text', text: JSON.stringify({
          workspace: workspace.root,
          facts: hits.map(render)
        }) }] };
        break;
      }
      case 'update_fact': {
        const { facts } = factsFor(args.cwd);
        const updated = facts.update(args.id, args);
        result = { content: [{ type: 'text', text: JSON.stringify({
          id: updated.id, state: updated.state, updated_at: updated.updated_at
        }) }] };
        break;
      }
      case 'check_drift': {
        const { workspace, facts } = factsFor(args.cwd);
        const checked = facts.verify(args.ids);
        result = { content: [{ type: 'text', text: JSON.stringify({
          workspace: workspace.root,
          checked: checked.length,
          drifted: checked.filter(c => c.drifted).map(c => ({
            id: c.id, title: c.title,
            fact: { id: c.id, kind: c.kind, title: c.title, summary: c.summary },
            files_to_reread: c.changedPaths, broken: c.broken
          }))
        }) }] };
        break;
      }
      case 'workspace_symbols': {
        const { workspace, facts } = factsFor(args.cwd);
        ensureAstIndex(workspace);
        result = { content: [{ type: 'text', text: JSON.stringify(queryWorkspaceSymbols(facts.db, {
          query: args.query, kind: args.kind, path: args.path_prefix,
          publicOnly: args.public_only, limit: args.limit
        })) }] };
        break;
      }
      case 'inspect_symbol': {
        const { workspace, facts } = factsFor(args.cwd);
        ensureAstIndex(workspace);
        const selector = args.path && typeof args.symbol === 'string'
          ? { path: args.path, name: args.symbol } : args.symbol;
        const detail = inspectSymbol(facts.db, selector, { workspaceRoot: workspace.root });
        if (detail && args.path && detail.symbol.path !== args.path) {
          throw new Error('symbol id does not belong to the requested path');
        }
        const output = detail && {
          ...detail,
          params: detail.symbol.params,
          return_type: detail.symbol.return_type,
          doc_summary: detail.symbol.doc_summary,
          signature_text: detail.symbol.signature_text,
          path: detail.symbol.path,
          start_line: detail.symbol.start_line,
          end_line: detail.symbol.end_line,
          signature_hash: detail.symbol.signature_hash,
          callers: detail.callers.map(c => ({ ...c, source_path: c.path, source_symbol: c.symbol })),
          type_references: [...detail.uses_types, ...detail.inherits],
          imports: detail.file?.imports || []
        };
        result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
        break;
      }
      case 'list_workspaces': {
        result = { content: [{ type: 'text', text: JSON.stringify(
          listWorkspaces().map(w => ({
            id: w.id, label: w.label, root: w.root_path,
            db: w.db_file, machine: w.machine, last_seen_at: w.last_seen_at
          }))
        ) }] };
        break;
      }
      default:
        respondError(id, -32601, `Unknown tool: ${name}`);
        return;
    }
    respond(id, result);
  } catch (err) {
    journal(name, err, { params });
    respondError(id, -32000, err === moduleFailure
      ? 'Caipira storage unavailable; inspect caipira logs' : `Tool error: ${err.message}`);
  }
}

process.on('SIGTERM', () => { closeAll(); process.exit(0); });
process.on('SIGINT', () => { closeAll(); process.exit(0); });

function processFailure(error, operation) {
  journal(operation, error);
  respondError(null, -32603, 'Caipira runtime failure; inspect caipira logs');
  closeAll();
  process.exit(0);
}

process.stdin.on('error', error => processFailure(error, 'stdin'));
process.stdout.on('error', error => { journal('stdout', error); process.exit(0); });
process.on('uncaughtException', error => processFailure(error, 'uncaughtException'));
process.on('unhandledRejection', error => processFailure(error, 'unhandledRejection'));
