#!/usr/bin/env node
// caipira/mcp.js — stdio MCP server with embedding-powered search
// Loads @xenova/transformers lazily. Backfills embeddings on idle.
// Tools: search, get_observations, list_sessions, timeline

const { MemoryStore } = require('./store');
const { ensureWorkspace, openWorkspaceDb, machineId, listWorkspaces } = require('./workspace');
const { FactStore, searchWorkspaces } = require('./facts');
const path = require('path');
const os = require('os');
const fs = require('fs');

let embedder = null;
let backfillTimer = null;

// ── workspace-scoped fact access ──
//
// The MCP server runs as its own process with no SessionStart hook of its own,
// so it provisions the workspace itself rather than assuming a hook got there
// first. Connections are cached per workspace: resolving is cheap, opening is not.
const factConnections = new Map();

function factsFor(cwd) {
  const workspace = ensureWorkspace(cwd || process.cwd());
  let entry = factConnections.get(workspace.dbFile);
  if (!entry) {
    const db = openWorkspaceDb(workspace.dbFile);
    entry = { db, store: new FactStore(db, { machine: machineId(), agent: 'mcp' }) };
    factConnections.set(workspace.dbFile, entry);
  }
  return { workspace, facts: entry.store };
}

function closeFactConnections() {
  for (const entry of factConnections.values()) {
    try { entry.db.close(); } catch {}
  }
  factConnections.clear();
}

// Observations live in the same per-workspace database the hooks write to.
// A bare MemoryStore() would open the legacy data.db instead, which the hooks
// no longer touch — search and backfill would then see an empty corpus.
const memoryStores = new Map();

function memoryAt(dbFile) {
  let memory = memoryStores.get(dbFile);
  if (!memory) {
    memory = new MemoryStore({ dbPath: dbFile });
    memoryStores.set(dbFile, memory);
  }
  return memory;
}

function memoryFor(cwd) {
  return memoryAt(ensureWorkspace(cwd || process.cwd()).dbFile);
}

function closeMemoryStores() {
  for (const memory of memoryStores.values()) {
    try { memory.close(); } catch {}
  }
  memoryStores.clear();
}

function closeAll() {
  closeMemoryStores();
  closeFactConnections();
}

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DIM = 384;

// Traffic log file for diagnostics
const logFile = path.join(__dirname, 'logs', 'mcp_traffic.log');
function logTraffic(direction, data) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${direction}: ${data}\n`);
  } catch (e) {}
}

// ── Embedder (lazy, cached) ──

async function getEmbedder() {
  if (embedder) return embedder;
  const transformers = require('@xenova/transformers');
  const modelDirectory = process.env.CAIPIRA_MODEL_PATH
    ? path.resolve(process.env.CAIPIRA_MODEL_PATH)
    : path.join(os.homedir(), '.caipira', 'models');
  transformers.env.localModelPath = modelDirectory;
  transformers.env.cacheDir = modelDirectory;
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = false;
  transformers.env.useFS = true;
  transformers.env.useFSCache = true;
  const extractor = await transformers.pipeline('feature-extraction', MODEL, { quantized: true });

  embedder = {
    model: MODEL,
    dim: MODEL_DIM,
    embed: async (text) => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return new Float32Array(out.data);
    }
  };
  console.error('[caipira] embedder loaded:', MODEL);
  return embedder;
}

// ── Backfill ──

const BACKFILL_BATCH = 50;

// Every registered workspace is backfilled, not just the one this server was
// started in: hooks from any client write to any workspace, and a workspace
// nobody has searched yet should still be ready when someone does.
async function backfillMissing() {
  let count = 0;
  let more = false;
  for (const row of listWorkspaces()) {
    if (!fs.existsSync(row.db_file)) continue;
    let memory;
    try {
      memory = memoryAt(row.db_file);
    } catch (e) {
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
    backfillMissing().catch(e => console.error('[caipira] backfill error:', e.message));
  }, 5000); // 5s after last activity
}

// ── MCP protocol ──

process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', chunk => {
  logTraffic('IN', chunk);
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      logTraffic('IN-LINE', line);
      const msg = JSON.parse(line);
      handle(msg);
    } catch (e) {
      logTraffic('IN-ERR', e.message);
      respond(null, { code: -32700, message: 'Parse error: ' + e.message });
    }
  }
});

function respond(id, result) {
  if (id === undefined) {
    return;
  }
  const msg = { jsonrpc: '2.0', id };
  if (result && result.code) {
    msg.error = result;
  } else {
    msg.result = result;
  }
  const payload = JSON.stringify(msg) + '\n';
  logTraffic('OUT', payload);
  process.stdout.write(payload);
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
            version: '2.0.0'
          }
        },
        instructions: 'Caipira provides local cross-session memory search and session timeline tools.'
      });
      break;

    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'caipira', version: '2.0.0' }
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
            description: 'Search durable facts, ranked by trust (relevance x still-true). Prefer this over `search` when you need what was decided rather than what happened. Results carry evidence_status: a fact whose files changed is flagged and ranked down. Defaults to this workspace; pass scope="all" to search every registered workspace when the current one has no answer and another project likely solved the same problem.',
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
                title: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string' },
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
      respond(id, { code: -32601, message: `Method not found: ${method}` });
  }
}

async function handleToolCall(id, params) {
  const { name, arguments: args = {} } = params;

  try {
    let result;
    switch (name) {
      case 'search': {
        if (!args || !args.query) {
          respond(id, { code: -32602, message: 'Missing required parameter: query' });
          return;
        }
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
        const factId = facts.record(args);
        const saved = facts.get(factId);
        result = { content: [{ type: 'text', text: JSON.stringify({
          id: factId, workspace: workspace.root, db: workspace.dbFile,
          state: saved.state, evidence: saved.evidence.map(e => e.path)
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
            id: c.id, title: c.title, files_to_reread: c.changedPaths
          }))
        }) }] };
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
        respond(id, { code: -32601, message: `Unknown tool: ${name}` });
        return;
    }
    respond(id, result);
  } catch (err) {
    respond(id, { code: -32000, message: `Tool error: ${err.message}` });
  }
}

process.on('SIGTERM', () => { closeAll(); process.exit(0); });
process.on('SIGINT', () => { closeAll(); process.exit(0); });
