#!/usr/bin/env node
// caipira/explore-server.js — `caipira explore`: a local JSON API over one
// workspace's symbol index, facts and sessions, plus the compiled React UI in
// explore-ui/dist.
//
//   caipira explore [--port 4777] [--host 127.0.0.1] [--workspace <path>] [--no-open]
//
// node:http only, no framework. It binds 127.0.0.1 unless --host says
// otherwise, refuses a Host header that is not this machine while bound to
// loopback (DNS rebinding), and takes writes only as same-origin JSON, so a
// page on another site cannot post a form at it. Source previews and fact
// evidence paths are confined to the workspace root.
//
// The AST engine and FactStore are synchronous; a request blocks the loop for
// as long as they run, which is acceptable for a single local user.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { ensureWorkspace, listWorkspaces, openWorkspaceDb, machineId } = require('./workspace');
const { FactStore, trustScore, VALID_KINDS } = require('./facts');
const { AstEngineError, syncWorkspaceAst, updateFileAst, queryWorkspaceSymbols, inspectSymbol } = require('./ast');

const DEFAULT_PORT = 4777;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SOURCE_LINES = 400;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const DEFAULT_NODE_LIMIT = 1500;
const MAX_NODE_LIMIT = 5000;
const SESSION_LIMIT = 20;
const SESSION_OBSERVATIONS = 500;
const MAX_EVIDENCE = 50;

const VIEWS = ['unified', 'architecture', 'knowledge', 'impact'];
const FACT_STATES = ['active', 'needs_review', 'proposed', 'superseded', 'revoked'];
const OPEN_STATES = ['active', 'needs_review', 'proposed'];
const GRAPH_SYMBOL_KINDS = new Set(['function', 'method', 'struct', 'class', 'interface', 'trait', 'enum', 'type', 'union', 'component']);
const TYPE_KINDS = ['struct', 'class', 'interface', 'trait', 'enum', 'type', 'union'];
const CODE_EDGES = new Set(['defines', 'calls', 'imports', 'uses_type', 'extends']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

/** A request failure with the HTTP status and stable code sent to the client. */
class HttpError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} code Stable machine-readable failure code.
   * @param {string} message Safe, human-readable detail.
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** A malformed `caipira explore` command line. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// ── request plumbing ──

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function sendError(res, error) {
  sendJson(res, error.status, { error: { code: error.code, message: error.message } });
}

// Errors this module did not raise itself are translated here, so a raw
// SQLite or engine message never reaches the client.
function toHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof AstEngineError) {
    if (error.code === 'binary_missing') return new HttpError(503, 'ast_unavailable', 'caipira-ast is not installed — run: caipira install');
    if (error.code === 'invalid_argument') return new HttpError(400, 'invalid_argument', error.message);
    return new HttpError(502, 'ast_failed', `caipira-ast failed (${error.code})`);
  }
  if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_')) {
    return /BUSY|LOCKED/.test(error.code)
      ? new HttpError(503, 'database_busy', 'the workspace database is busy — retry shortly')
      : new HttpError(500, 'database_error', 'the workspace database could not be read');
  }
  return new HttpError(500, 'internal_error', 'unexpected server error');
}

// The --host value: a name or address, IPv6 with or without brackets.
function bindHostname(host) {
  return String(host || DEFAULT_HOST).replace(/^\[|\]$/g, '').toLowerCase();
}

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return null;
  const bracketed = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1].toLowerCase();
  return hostHeader.replace(/:\d+$/, '').toLowerCase();
}

// While bound to loopback only a loopback Host is accepted: a rebinding
// attacker's page reaches 127.0.0.1 under its own hostname. A server bound to
// a network address was exposed on purpose, so any Host goes.
function checkHost(ctx, req) {
  if (!ctx.loopbackOnly) return;
  const host = hostnameOf(req.headers.host);
  if (!host || !LOOPBACK_HOSTS.has(host)) throw new HttpError(403, 'forbidden_host', 'requests must address this machine by a loopback name');
}

// Writes must be same-origin JSON. A cross-site form post cannot set the JSON
// content type without a preflight, which this server never answers.
function checkWrite(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'write requests must be application/json');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross_origin', 'cross-site writes are refused');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost = null;
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* "null" or garbage */ }
    if (originHost !== String(req.headers.host || '').toLowerCase()) {
      throw new HttpError(403, 'cross_origin', 'cross-origin writes are refused');
    }
  }
}

function readJsonBody(req) {
  checkWrite(req);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'payload_too_large', `request bodies are limited to ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', error => { if (!failed) { failed = true; reject(error); } });
    req.on('end', () => {
      if (failed) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'request body is not valid JSON'));
        return;
      }
      if (!isPlainObject(body)) {
        reject(new HttpError(400, 'invalid_argument', 'request body must be a JSON object'));
        return;
      }
      resolve(body);
    });
  });
}

// ── argument validation ──

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message) {
  return new HttpError(400, 'invalid_argument', message);
}

function parseId(raw, name) {
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) throw invalid(`${name} must be a positive integer`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw invalid(`${name} must be a positive integer`);
  return id;
}

function intParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw invalid(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (value < min || value > max) throw invalid(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function textParam(url, name, max = 500) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return null;
  if (raw.length > max) throw invalid(`${name} must be at most ${max} characters`);
  return raw.trim();
}

function enumParam(url, name, allowed, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!allowed.includes(raw)) throw invalid(`${name} must be one of: ${allowed.join(', ')}`);
  return raw;
}

function optionalText(body, name, max) {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) throw invalid(`${name} must be a string of at most ${max} characters`);
  return value.trim() === '' ? undefined : value;
}

function requiredText(body, name, max) {
  const value = optionalText(body, name, max);
  if (value === undefined) throw invalid(`${name} is required`);
  return value;
}

function optionalConfidence(body) {
  const value = body.confidence;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw invalid('confidence must be a number from 0 to 1');
  return value;
}

function optionalList(body, name, check, message) {
  const value = body[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE || !value.every(check)) throw invalid(message);
  return value;
}

// ── workspace paths ──

const toPosix = rel => rel.split(path.sep).join('/');

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves a workspace-relative path, refusing anything that leaves the root
 * lexically or through a symlink.
 * @param {string} root Workspace root.
 * @param {string} relPath Workspace-relative path.
 * @returns {string} Absolute path inside the root.
 * @throws {HttpError} 403 path_outside_workspace.
 */
function confine(root, relPath) {
  const outside = new HttpError(403, 'path_outside_workspace', 'path is outside the workspace root');
  if (typeof relPath !== 'string' || relPath.includes('\0') || path.isAbsolute(relPath)) throw outside;
  const absolute = path.resolve(root, relPath);
  if (!isInside(root, absolute)) throw outside;
  let realRoot = root;
  let realTarget = absolute;
  try { realRoot = fs.realpathSync.native(root); } catch { /* checked lexically above */ }
  try { realTarget = fs.realpathSync.native(absolute); } catch { return absolute; }
  if (!isInside(realRoot, realTarget)) throw outside;
  return absolute;
}

// An evidence path recorded on this machine, relative to the root when it
// lies inside it.
function workspaceRelative(root, absolute) {
  if (!root || !path.isAbsolute(absolute) || !isInside(root, absolute)) return null;
  const rel = toPosix(path.relative(root, absolute));
  return rel === '' ? null : rel;
}

// ── workspaces ──

// Read-only, so listing never migrates or locks a database it only counts.
function workspaceCounts(dbFile) {
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const has = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    const count = (table, where = '') => (has(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n : 0);
    return {
      files: count('ast_files'),
      symbols: count('ast_symbols'),
      facts: count('facts', "WHERE state IN ('active', 'needs_review', 'proposed')"),
      drift: count('facts', "WHERE state = 'needs_review'")
    };
  } finally {
    db.close();
  }
}

function resolveWorkspace(ctx, url) {
  const raw = url.searchParams.get('workspace');
  const id = raw === null || raw === '' ? ctx.defaultWorkspaceId : parseId(raw, 'workspace');
  const row = listWorkspaces().find(entry => entry.id === id);
  if (!row) throw new HttpError(404, 'workspace_not_found', `no workspace with id ${id}`);
  if (!fs.existsSync(row.db_file)) throw new HttpError(404, 'workspace_unavailable', `workspace ${id} has no database on this machine`);
  return { id: row.id, label: row.label, root: row.root_path, dbFile: row.db_file };
}

function withWorkspace(ws, fn) {
  const db = openWorkspaceDb(ws.dbFile);
  try {
    return fn(db, new FactStore(db, { machine: machineId(), agent: 'explore', root: ws.root }));
  } finally {
    db.close();
  }
}

// Drift is re-checked once per workspace per server process, then on
// request (`refresh=1`) and after every reindex.
function ensureVerified(ctx, ws, store, force = false) {
  if (!force && ctx.verified.has(ws.dbFile)) return;
  store.verify();
  ctx.verified.add(ws.dbFile);
}

function driftCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM facts WHERE state = 'needs_review'").get().n;
}

// ── symbols ──

const SYMBOL_ROW = `SELECT id, path, name, qualified_name, kind, is_public, start_line, end_line, return_type FROM ast_symbols`;

// The parser has no component kind; a PascalCase function in a JSX, TSX or
// Vue file is one.
function displayKind(row) {
  if (row.kind === 'function' && /\.(?:jsx|tsx|vue)$/i.test(row.path) && /^[A-Z]/.test(row.name)) return 'component';
  return row.kind;
}

function symbolIndex(rows) {
  const key = (file, name) => `${file}\0${name}`;
  const byPathQualified = new Map();
  const byPathName = new Map();
  const byQualified = new Map();
  const byName = new Map();
  const methodsByName = new Map();
  const push = (map, name, id) => { const list = map.get(name) || []; list.push(id); map.set(name, list); };
  for (const row of rows) {
    if (!byPathQualified.has(key(row.path, row.qualified_name))) byPathQualified.set(key(row.path, row.qualified_name), row.id);
    if (!byPathName.has(key(row.path, row.name))) byPathName.set(key(row.path, row.name), row.id);
    push(byQualified, row.qualified_name, row.id);
    push(byName, row.name, row.id);
    if (row.kind === 'method') push(methodsByName, row.name, row.id);
  }
  const unique = list => (list && list.length === 1 ? list[0] : null);
  return {
    at: (file, name) => byPathQualified.get(key(file, name)) ?? byPathName.get(key(file, name)) ?? null,
    exact: (file, qualified) => byPathQualified.get(key(file, qualified)) ?? null,
    // An edge the parser could not pin to a file is drawn only when its name
    // means one symbol: a same-file `this.x` / `self.x`, a unique name, or a
    // member call (`store.add`, `Type::add`) whose method name is unique.
    resolve(edge) {
      if (edge.target_path) return this.at(edge.target_path, edge.target_symbol);
      const local = edge.target_symbol.match(/^(?:this\.|self\.|Self::)(.+)$/);
      if (local) return byPathName.get(key(edge.source_path, local[1])) ?? null;
      const named = unique(byQualified.get(edge.target_symbol)) ?? unique(byName.get(edge.target_symbol));
      if (named !== null) return named;
      const member = edge.target_symbol.match(/(?:\.|::)([A-Za-z_$][\w$]*)$/);
      return member ? unique(methodsByName.get(member[1])) : null;
    }
  };
}

// ── graph ──

/**
 * @typedef {{id: string, source: string, target: string, kind: string}} GraphEdge
 * @typedef {{view: string, symbolId: number|null, depth: number, pathPrefix: string|null,
 *   kind: string|null, category: string|null, limit: number}} GraphOptions
 */

/**
 * Builds the node/edge payload for one workspace: files, symbols, facts and
 * recent sessions, filtered to a view and capped at `limit` nodes.
 * @param {import('better-sqlite3').Database} db Open workspace database.
 * @param {{root: string|null}} ws The workspace.
 * @param {GraphOptions} opts
 * @returns {{nodes: object[], edges: GraphEdge[], stats: object, driftCount: number, focusId: string|null}}
 * @throws {HttpError} 404 when the impact view's symbol does not exist.
 */
function buildGraph(db, ws, opts) {
  const nodes = new Map();
  const edges = new Map();
  const addEdge = (source, target, kind) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const id = `${kind}:${source}->${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target, kind });
  };
  const inPrefix = file => !opts.pathPrefix || file === opts.pathPrefix || file.startsWith(`${opts.pathPrefix.replace(/\/+$/, '')}/`);
  const fileId = file => `file:${file}`;
  const addFile = (file, language, indexed) => {
    const id = fileId(file);
    if (!nodes.has(id)) {
      const dir = path.posix.dirname(file);
      nodes.set(id, { id, type: 'file', label: path.posix.basename(file), path: file, language, group: dir === '.' ? '/' : dir, indexed });
    }
    return id;
  };

  let focusRow = null;
  if (opts.view === 'impact') {
    focusRow = db.prepare(`${SYMBOL_ROW} WHERE id = ?`).get(opts.symbolId);
    if (!focusRow) throw new HttpError(404, 'symbol_not_found', `no symbol with id ${opts.symbolId}`);
  }

  // Code layer.
  const fileRows = db.prepare('SELECT path, language FROM ast_files ORDER BY path').all();
  for (const row of fileRows) if (inPrefix(row.path)) addFile(row.path, row.language, true);
  const symbolRows = db.prepare(`${SYMBOL_ROW} ORDER BY path, start_line`).all();
  const index = symbolIndex(symbolRows);
  for (const row of symbolRows) {
    const kind = displayKind(row);
    const wanted = opts.kind ? kind === opts.kind : GRAPH_SYMBOL_KINDS.has(kind);
    const isFocus = focusRow && row.id === focusRow.id;
    if (!isFocus && (!wanted || !inPrefix(row.path))) continue;
    const id = `symbol:${row.id}`;
    nodes.set(id, {
      id, type: 'symbol', label: row.name, symbolId: row.id, kind, path: row.path,
      qualifiedName: row.qualified_name, line: row.start_line, isPublic: row.is_public === 1,
      returnType: row.return_type, callers: 0
    });
    addEdge(addFile(row.path, null, false), id, 'defines');
  }
  const edgeRows = db.prepare(`SELECT source_path, source_symbol, target_path, target_symbol, edge_kind
    FROM ast_edges WHERE edge_kind IN ('calls', 'imports', 'uses_type', 'extends', 'implements')`).all();
  for (const row of edgeRows) {
    if (row.edge_kind === 'imports') {
      if (row.target_path) addEdge(fileId(row.source_path), fileId(row.target_path), 'imports');
      continue;
    }
    if (!row.source_symbol) continue;
    const source = index.exact(row.source_path, row.source_symbol);
    const target = index.resolve(row);
    if (source === null || target === null) continue;
    const kind = row.edge_kind === 'implements' ? 'extends' : row.edge_kind;
    addEdge(`symbol:${source}`, `symbol:${target}`, kind);
  }
  for (const edge of edges.values()) {
    if (edge.kind === 'calls') nodes.get(edge.target).callers++;
  }

  // Knowledge layer: every fact still on record, linked to its evidence.
  const facts = db.prepare(`SELECT * FROM facts WHERE state != 'revoked' ${opts.category ? 'AND kind = ?' : ''} ORDER BY id`)
    .all(...(opts.category ? [opts.category] : []));
  for (const fact of facts) {
    nodes.set(`fact:${fact.id}`, {
      id: `fact:${fact.id}`, type: 'fact', label: fact.title, factId: fact.id, category: fact.kind,
      state: fact.state, drifted: fact.state === 'needs_review', trust: Number(trustScore(fact).toFixed(3))
    });
  }
  const evidence = db.prepare('SELECT fact_id, path FROM fact_evidence WHERE machine = ?').all(machineId());
  for (const row of evidence) {
    const rel = workspaceRelative(ws.root, row.path);
    if (!rel || !nodes.has(`fact:${row.fact_id}`) || !inPrefix(rel)) continue;
    addEdge(`fact:${row.fact_id}`, nodes.has(fileId(rel)) ? fileId(rel) : addFile(rel, null, false), 'evidences');
  }
  for (const row of db.prepare('SELECT fact_id, path, qualified_name FROM fact_symbol_evidence').all()) {
    const symbol = index.exact(row.path, row.qualified_name);
    const target = symbol !== null && nodes.has(`symbol:${symbol}`) ? `symbol:${symbol}`
      : inPrefix(row.path) ? addFile(row.path, null, false) : null;
    if (target) addEdge(`fact:${row.fact_id}`, target, 'evidences');
  }
  for (const fact of facts) {
    if (fact.supersedes) addEdge(`fact:${fact.id}`, `fact:${fact.supersedes}`, 'supersedes');
  }

  // Episodic layer: recent sessions and what their tool calls wrote.
  const sessions = db.prepare('SELECT id, ide, cwd, started_at, ended_at, summary FROM sessions ORDER BY started_at DESC LIMIT ?').all(SESSION_LIMIT);
  const touchedRows = db.prepare(`SELECT metadata FROM observations
    WHERE session_id = ? AND kind = 'tool_result' AND metadata IS NOT NULL ORDER BY id DESC LIMIT ?`);
  for (const session of sessions) {
    const id = `session:${session.id}`;
    nodes.set(id, {
      id, type: 'session', label: `${session.ide} · ${new Date(session.started_at).toISOString().slice(0, 16).replace('T', ' ')}`,
      sessionId: session.id, ide: session.ide, startedAt: session.started_at, endedAt: session.ended_at, summary: session.summary
    });
    for (const row of touchedRows.all(session.id, SESSION_OBSERVATIONS)) {
      let meta;
      try { meta = JSON.parse(row.metadata); } catch { continue; }
      for (const file of Array.isArray(meta.files) ? meta.files : []) {
        if (typeof file !== 'string' || !ws.root) continue;
        const rel = workspaceRelative(ws.root, path.resolve(session.cwd || ws.root, file));
        if (rel && inPrefix(rel)) addEdge(id, nodes.has(fileId(rel)) ? fileId(rel) : addFile(rel, null, false), 'touched');
      }
      for (const selector of Array.isArray(meta.symbols) ? meta.symbols : []) {
        if (typeof selector !== 'string') continue;
        const split = selector.indexOf('::');
        if (split <= 0) continue;
        const symbol = index.exact(selector.slice(0, split), selector.slice(split + 2));
        if (symbol !== null) addEdge(id, `symbol:${symbol}`, 'touched');
      }
    }
  }

  const selected = selectView(nodes, edges, opts, focusRow && `symbol:${focusRow.id}`);
  const capped = capNodes(selected.nodes, selected.edges, opts.limit, focusRow && `symbol:${focusRow.id}`);
  const count = type => capped.nodes.filter(node => node.type === type).length;
  return {
    nodes: capped.nodes,
    edges: capped.edges,
    stats: {
      files: count('file'), symbols: count('symbol'), facts: count('fact'), sessions: count('session'),
      edges: capped.edges.length, indexedFiles: fileRows.length, indexedSymbols: symbolRows.length,
      truncated: capped.truncated
    },
    driftCount: driftCount(db),
    focusId: focusRow ? `symbol:${focusRow.id}` : null
  };
}

function selectView(nodes, edges, opts, focusId) {
  let keep;
  let edgeList = [...edges.values()];
  if (opts.view === 'architecture') {
    keep = new Set([...nodes.values()].filter(node => node.type === 'file' || node.type === 'symbol').map(node => node.id));
    edgeList = edgeList.filter(edge => CODE_EDGES.has(edge.kind));
  } else if (opts.view === 'knowledge') {
    keep = new Set([...nodes.values()].filter(node => node.type === 'fact' || node.type === 'session').map(node => node.id));
    for (const edge of edgeList) {
      if (edge.kind === 'evidences' || edge.kind === 'touched') keep.add(edge.target);
    }
    // Files and the symbols they define stay connected in the picture.
    edgeList = edgeList.filter(edge => edge.kind !== 'calls' && edge.kind !== 'imports' && edge.kind !== 'uses_type' && edge.kind !== 'extends');
  } else if (opts.view === 'impact') {
    keep = neighborhood(edgeList, focusId, opts.depth);
  } else {
    keep = new Set(nodes.keys());
  }
  // A code filter drops the facts and sessions that no longer touch a file or
  // symbol still in view; a link to another fact does not count.
  if (opts.pathPrefix || opts.kind) {
    const isCode = id => { const type = nodes.get(id).type; return type === 'file' || type === 'symbol'; };
    const linked = new Set();
    for (const edge of edgeList) {
      if (!keep.has(edge.source) || !keep.has(edge.target)) continue;
      if (isCode(edge.target)) linked.add(edge.source);
      if (isCode(edge.source)) linked.add(edge.target);
    }
    for (const id of [...keep]) {
      const type = nodes.get(id).type;
      if ((type === 'fact' || type === 'session') && !linked.has(id)) keep.delete(id);
    }
  }
  return {
    nodes: [...nodes.values()].filter(node => keep.has(node.id)),
    edges: edgeList.filter(edge => keep.has(edge.source) && keep.has(edge.target))
  };
}

/**
 * The nodes within `depth` undirected hops of `start`.
 * @param {GraphEdge[]} edgeList
 * @param {string} start
 * @param {number} depth
 * @returns {Set<string>}
 */
function neighborhood(edgeList, start, depth) {
  const adjacent = new Map();
  const link = (a, b) => { const list = adjacent.get(a) || []; list.push(b); adjacent.set(a, list); };
  for (const edge of edgeList) { link(edge.source, edge.target); link(edge.target, edge.source); }
  const seen = new Set([start]);
  let frontier = [start];
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const other of adjacent.get(id) || []) {
        if (!seen.has(other)) { seen.add(other); next.push(other); }
      }
    }
    frontier = next;
  }
  return seen;
}

// Over the cap, facts, sessions and files are kept first, then the symbols
// with the most connections.
function capNodes(nodeList, edgeList, limit, focusId) {
  if (nodeList.length <= limit) return { nodes: nodeList, edges: edgeList, truncated: false };
  const degree = new Map();
  for (const edge of edgeList) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }
  const rank = { fact: 0, session: 1, file: 2, symbol: 3 };
  const ordered = [...nodeList].sort((a, b) => (b.id === focusId) - (a.id === focusId)
    || rank[a.type] - rank[b.type] || (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
  const keep = new Set(ordered.slice(0, limit).map(node => node.id));
  return {
    nodes: nodeList.filter(node => keep.has(node.id)),
    edges: edgeList.filter(edge => keep.has(edge.source) && keep.has(edge.target)),
    truncated: true
  };
}

// ── facts ──

// Evidence and anchors for many facts in two queries rather than two per fact.
function factDtos(db, ws, rows) {
  if (rows.length === 0) return [];
  const ids = rows.map(row => row.id);
  const marks = ids.map(() => '?').join(',');
  const files = db.prepare(`SELECT fact_id, path, start_line, end_line FROM fact_evidence
    WHERE fact_id IN (${marks}) AND machine = ? ORDER BY id`).all(...ids, machineId());
  const symbols = db.prepare(`SELECT fact_id, path, qualified_name, signature_hash FROM fact_symbol_evidence
    WHERE fact_id IN (${marks}) ORDER BY path, qualified_name`).all(...ids);
  const successors = db.prepare(`SELECT id, supersedes FROM facts WHERE supersedes IN (${marks})`).all(...ids);
  const current = db.prepare('SELECT id, signature_hash FROM ast_symbols WHERE path = ? AND qualified_name = ? ORDER BY start_line LIMIT 1');
  const indexed = db.prepare('SELECT 1 FROM ast_files WHERE path = ?');

  const group = (list, map) => { for (const item of list) { const bucket = map.get(item.fact_id) || []; bucket.push(item); map.set(item.fact_id, bucket); } return map; };
  const filesByFact = group(files, new Map());
  const symbolsByFact = group(symbols, new Map());
  const supersededBy = new Map(successors.map(row => [row.supersedes, row.id]));

  return rows.map(fact => ({
    id: fact.id,
    kind: fact.kind,
    title: fact.title,
    summary: fact.summary,
    body: fact.body,
    state: fact.state,
    scope: fact.scope,
    confidence: fact.confidence,
    trust: Number((fact.trust ?? trustScore(fact)).toFixed(3)),
    drifted: fact.state === 'needs_review',
    supersedes: fact.supersedes,
    supersededBy: supersededBy.get(fact.id) ?? null,
    createdAt: fact.created_at,
    updatedAt: fact.updated_at,
    lastVerifiedAt: fact.last_verified_at,
    updatedBy: fact.updated_by,
    evidence: (filesByFact.get(fact.id) || []).map(row => {
      const rel = workspaceRelative(ws.root, row.path);
      return {
        path: rel ?? row.path, inWorkspace: rel !== null, startLine: row.start_line, endLine: row.end_line,
        nodeId: rel ? `file:${rel}` : null, indexed: Boolean(rel && indexed.get(rel))
      };
    }),
    symbols: (symbolsByFact.get(fact.id) || []).map(row => {
      const now = current.get(row.path, row.qualified_name);
      return {
        path: row.path, qualifiedName: row.qualified_name, symbolId: now ? now.id : null,
        nodeId: now ? `symbol:${now.id}` : null, current: Boolean(now && now.signature_hash === row.signature_hash)
      };
    })
  }));
}

function factById(db, ws, id) {
  const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'fact_not_found', `no fact with id ${id}`);
  return factDtos(db, ws, [row])[0];
}

// Re-reads the files a fact's symbols live in, so a reaffirmed or newly
// anchored hash is the code as it is now. The stored index may predate the
// source, so when the engine cannot re-read a file the request fails before
// any fact is written rather than certify a stale signature.
function refreshFiles(ws, relPaths) {
  const files = [...new Set(relPaths)];
  if (files.length === 0) return;
  if (!ws.root) throw new HttpError(409, 'workspace_has_no_root', 'this workspace has no root directory to re-read symbol evidence from');
  for (const rel of files) {
    try {
      updateFileAst(ws.root, ws.dbFile, path.join(ws.root, rel), { timeoutMs: 5000 });
    } catch (error) {
      if (!(error instanceof AstEngineError)) throw error;
      const status = error.code === 'binary_missing' || error.code === 'timeout' ? 503 : 502;
      throw new HttpError(status, 'evidence_unverifiable',
        `symbol evidence in ${rel} could not be re-read (${error.code}); no fact was changed — check caipira-ast (caipira install) and retry`);
    }
  }
}

// Validates and resolves a new fact's fields and evidence. Files are
// workspace-relative regular files; symbols are ids in this workspace's index.
function factInput(db, ws, body) {
  const kind = requiredText(body, 'kind', 40);
  if (!VALID_KINDS.includes(kind)) throw invalid(`kind must be one of: ${VALID_KINDS.join(', ')}`);
  const input = {
    kind,
    title: requiredText(body, 'title', 200),
    body: requiredText(body, 'body', 20000),
    summary: optionalText(body, 'summary', 500),
    scope: optionalText(body, 'scope', 200),
    confidence: optionalConfidence(body)
  };
  const files = optionalList(body, 'evidenceFiles', value => typeof value === 'string' && value.length > 0 && value.length <= 1024,
    `evidenceFiles must be at most ${MAX_EVIDENCE} workspace-relative paths`);
  const symbolIds = optionalList(body, 'evidenceSymbols', value => Number.isSafeInteger(value) && value > 0,
    `evidenceSymbols must be at most ${MAX_EVIDENCE} symbol ids`);
  if ((files.length || symbolIds.length) && !ws.root) {
    throw new HttpError(409, 'workspace_has_no_root', 'this workspace has no root directory to anchor evidence in');
  }
  input.evidence = files.map(rel => {
    const absolute = confine(ws.root, rel);
    let stat;
    try { stat = fs.statSync(absolute); } catch { throw invalid(`evidence file does not exist: ${rel}`); }
    if (!stat.isFile()) throw invalid(`evidence path is not a file: ${rel}`);
    return absolute;
  });
  const anchors = symbolIds.map(id => {
    const row = db.prepare('SELECT path, qualified_name FROM ast_symbols WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'symbol_not_found', `no symbol with id ${id}`);
    confine(ws.root, row.path);
    return row;
  });
  refreshFiles(ws, anchors.map(row => row.path));
  input.evidenceSymbols = [...new Map(anchors.map(row => {
    const now = db.prepare('SELECT signature_hash FROM ast_symbols WHERE path = ? AND qualified_name = ? ORDER BY start_line LIMIT 1')
      .get(row.path, row.qualified_name);
    if (!now) throw new HttpError(409, 'symbol_changed', `${row.path}::${row.qualified_name} no longer exists — reindex and retry`);
    return [`${row.path}::${row.qualified_name}`, { path: row.path, qualifiedName: row.qualified_name, signatureHash: now.signature_hash }];
  })).values()];
  return input;
}

// A replacement fact inherits its predecessor's evidence that still exists:
// whole files, line ranges, and symbols (re-anchored to today's signature).
function inheritedEvidence(db, ws, factId) {
  const live = db.prepare('SELECT path, start_line, end_line FROM fact_evidence WHERE fact_id = ? AND machine = ?')
    .all(factId, machineId())
    .filter(row => { try { return fs.statSync(row.path).isFile(); } catch { return false; } });
  const anchors = db.prepare('SELECT path, qualified_name FROM fact_symbol_evidence WHERE fact_id = ?').all(factId);
  refreshFiles(ws, anchors.map(row => row.path));
  const current = db.prepare('SELECT signature_hash FROM ast_symbols WHERE path = ? AND qualified_name = ? ORDER BY start_line LIMIT 1');
  return {
    evidence: live.filter(row => row.start_line === null).map(row => row.path),
    evidence_ranges: live.filter(row => row.start_line !== null)
      .map(row => ({ path: row.path, start_line: row.start_line, end_line: row.end_line })),
    evidenceSymbols: anchors.flatMap(row => {
      const now = current.get(row.path, row.qualified_name);
      return now ? [{ path: row.path, qualifiedName: row.qualified_name, signatureHash: now.signature_hash }] : [];
    })
  };
}

// FactStore rejects bad input with plain Errors carrying safe messages.
function recordFact(store, input) {
  try {
    return store.record(input);
  } catch (error) {
    if (error && typeof error.code === 'string') throw error;
    throw invalid(error.message);
  }
}

// ── source previews ──

async function readSource(ws, symbol) {
  if (!ws.root) return { status: 'unavailable', reason: 'no_root' };
  const absolute = confine(ws.root, symbol.path);
  let stat;
  try { stat = await fs.promises.stat(absolute); } catch { return { status: 'unavailable', reason: 'missing' }; }
  if (!stat.isFile()) return { status: 'unavailable', reason: 'not_a_file' };
  if (stat.size > MAX_SOURCE_BYTES) return { status: 'unavailable', reason: 'too_large' };
  const lines = (await fs.promises.readFile(absolute, 'utf8')).split(/\r?\n/);
  const start = Math.max(1, symbol.start_line);
  const end = Math.min(lines.length, symbol.end_line, start + MAX_SOURCE_LINES - 1);
  return {
    status: 'ok', start_line: start, end_line: end,
    lines: lines.slice(start - 1, end), truncated: end < Math.min(lines.length, symbol.end_line)
  };
}

// Identifiers in a symbol's parameter and return types that name a type
// declared in this workspace; same-file declarations win.
function typeLinks(db, symbol) {
  const texts = [...symbol.params.map(param => param.type_annotation), symbol.return_type].filter(Boolean);
  const names = new Set();
  for (const text of texts) for (const match of String(text).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) names.add(match[0]);
  const lookup = db.prepare(`SELECT id FROM ast_symbols WHERE name = ? AND kind IN (${TYPE_KINDS.map(() => '?').join(',')})
    ORDER BY (path = ?) DESC, path, start_line LIMIT 1`);
  const links = {};
  for (const name of [...names].slice(0, 50)) {
    const row = lookup.get(name, ...TYPE_KINDS, symbol.path);
    if (row) links[name] = row.id;
  }
  return links;
}

// ── handlers ──

function getWorkspaces(ctx) {
  const workspaces = listWorkspaces().map(row => {
    let counts = null;
    if (fs.existsSync(row.db_file)) {
      try { counts = workspaceCounts(row.db_file); } catch { /* unreadable: listed without counts */ }
    }
    return {
      id: row.id, label: row.label || row.root_path || 'legacy', root: row.root_path, machine: row.machine,
      lastSeenAt: row.last_seen_at, available: counts !== null, counts
    };
  });
  return { defaultWorkspaceId: ctx.defaultWorkspaceId, workspaces };
}

function getGraph(ctx, req, url) {
  const ws = resolveWorkspace(ctx, url);
  const view = enumParam(url, 'view', VIEWS, 'unified');
  const symbolParam = url.searchParams.get('symbolId');
  const opts = {
    view,
    symbolId: symbolParam ? parseId(symbolParam, 'symbolId') : null,
    depth: intParam(url, 'depth', 2, 1, 4),
    pathPrefix: textParam(url, 'pathPrefix', 1024),
    kind: textParam(url, 'kind', 40),
    category: url.searchParams.get('category') ? enumParam(url, 'category', VALID_KINDS, null) : null,
    limit: intParam(url, 'limit', DEFAULT_NODE_LIMIT, 1, MAX_NODE_LIMIT)
  };
  if (view === 'impact' && opts.symbolId === null) throw invalid('the impact view needs symbolId');
  return withWorkspace(ws, (db, store) => {
    ensureVerified(ctx, ws, store);
    return { workspaceId: ws.id, view, ...buildGraph(db, ws, opts) };
  });
}

function getSymbols(ctx, req, url) {
  const ws = resolveWorkspace(ctx, url);
  const query = textParam(url, 'q');
  const filters = {
    query,
    kind: textParam(url, 'kind', 40),
    path: textParam(url, 'path', 1024),
    publicOnly: url.searchParams.get('public') === '1',
    limit: intParam(url, 'limit', 25, 0, 100),
    offset: intParam(url, 'offset', 0, 0, 100000)
  };
  return withWorkspace(ws, db => {
    const symbols = queryWorkspaceSymbols(db, filters).map(symbol => ({ ...symbol, kind: displayKind(symbol) }));
    const files = query
      ? db.prepare(`SELECT path, language FROM ast_files WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path), path LIMIT 10`)
        .all(`%${query.replace(/[\\%_]/g, ch => `\\${ch}`)}%`)
      : [];
    return { symbols, files };
  });
}

async function getSymbol(ctx, req, url, [rawId]) {
  const id = parseId(rawId, 'symbol id');
  const ws = resolveWorkspace(ctx, url);
  const detail = withWorkspace(ws, (db, store) => {
    ensureVerified(ctx, ws, store);
    const found = inspectSymbol(db, id, ws.root ? { workspaceRoot: ws.root } : {});
    if (!found) throw new HttpError(404, 'symbol_not_found', `no symbol with id ${id}`);
    if (ws.root) confine(ws.root, found.symbol.path);
    const idAt = db.prepare(`SELECT id FROM ast_symbols WHERE path = ? AND (qualified_name = ? OR name = ?)
      ORDER BY (qualified_name = ?) DESC, start_line LIMIT 1`);
    const withId = row => {
      const hit = row.symbol ? idAt.get(row.path, row.symbol, row.symbol, row.symbol) : null;
      return { ...row, symbol_id: hit ? hit.id : null };
    };
    // An outgoing reference the parser left unresolved is linked exactly as
    // the graph draws it, so a member call such as `store.add` points at the
    // one method of that name and an ambiguous one stays unlinked.
    let index = null;
    const resolved = row => {
      if (row.symbol_id !== null) return row;
      index ??= symbolIndex(db.prepare(`${SYMBOL_ROW} ORDER BY path, start_line`).all());
      return { ...row, symbol_id: index.resolve({ ...row, source_path: found.symbol.path }) };
    };
    const facts = [...found.facts];
    if (ws.root) {
      const attached = new Set(facts.map(fact => fact.fact_id));
      const wholeFile = db.prepare(`SELECT f.id AS fact_id, f.kind, f.title, f.summary, f.state
        FROM fact_evidence e JOIN facts f ON f.id = e.fact_id
        WHERE e.path = ? AND e.machine = ? AND e.start_line IS NULL AND f.state IN ('active', 'needs_review', 'proposed')
        ORDER BY f.updated_at DESC`).all(path.join(ws.root, found.symbol.path), machineId());
      for (const row of wholeFile) {
        if (!attached.has(row.fact_id)) { attached.add(row.fact_id); facts.push({ ...row, evidence_status: 'file' }); }
      }
    }
    return {
      symbol: { ...found.symbol, kind: displayKind(found.symbol) },
      language: found.file ? found.file.language : null,
      callers: found.callers.map(withId),
      callees: found.callees.map(resolved),
      uses_types: found.uses_types.map(resolved),
      used_by: found.used_by.map(withId),
      inherits: found.inherits.map(resolved),
      inherited_by: found.inherited_by.map(withId),
      facts: facts.map(fact => ({ fact_id: fact.fact_id, kind: fact.kind, title: fact.title, summary: fact.summary,
        state: fact.state, evidence_status: fact.evidence_status })),
      type_links: typeLinks(db, found.symbol)
    };
  });
  return { workspaceId: ws.id, ...detail, source: await readSource(ws, detail.symbol) };
}

function getFacts(ctx, req, url) {
  const ws = resolveWorkspace(ctx, url);
  const query = textParam(url, 'q');
  const category = url.searchParams.get('category') ? enumParam(url, 'category', VALID_KINDS, null) : null;
  const state = enumParam(url, 'state', ['open', 'all', ...FACT_STATES], 'open');
  const limit = intParam(url, 'limit', 200, 1, 1000);
  const refresh = url.searchParams.get('refresh') === '1';
  const states = state === 'open' ? OPEN_STATES : state === 'all' ? FACT_STATES.filter(s => s !== 'revoked') : [state];
  return withWorkspace(ws, (db, store) => {
    ensureVerified(ctx, ws, store, refresh);
    let rows;
    if (query) {
      rows = store.search(query, { limit, states }).filter(fact => !category || fact.kind === category);
    } else {
      const where = [`state IN (${states.map(() => '?').join(',')})`];
      const args = [...states];
      if (category) { where.push('kind = ?'); args.push(category); }
      rows = db.prepare(`SELECT * FROM facts WHERE ${where.join(' AND ')}
        ORDER BY (state = 'needs_review') DESC, updated_at DESC, id DESC LIMIT ?`).all(...args, limit);
    }
    return { workspaceId: ws.id, facts: factDtos(db, ws, rows), driftCount: driftCount(db) };
  });
}

async function postFact(ctx, req, url) {
  const ws = resolveWorkspace(ctx, url);
  const body = await readJsonBody(req);
  let supersedes;
  if (body.supersedes !== undefined && body.supersedes !== null) {
    if (!Number.isSafeInteger(body.supersedes) || body.supersedes < 1) throw invalid('supersedes must be a fact id');
    supersedes = body.supersedes;
  }
  return withWorkspace(ws, (db, store) => {
    if (supersedes !== undefined) openFact(db, supersedes);
    const id = recordFact(store, { ...factInput(db, ws, body), supersedes });
    return { status: 201, body: { fact: factById(db, ws, id), driftCount: driftCount(db) } };
  });
}

// Facts that were superseded or revoked are history, not something to edit.
function openFact(db, id) {
  const row = db.prepare('SELECT id, state FROM facts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'fact_not_found', `no fact with id ${id}`);
  if (!OPEN_STATES.includes(row.state)) throw new HttpError(409, 'fact_closed', `fact ${id} is ${row.state}`);
  return row;
}

async function patchFact(ctx, req, url, [rawId]) {
  const id = parseId(rawId, 'fact id');
  const ws = resolveWorkspace(ctx, url);
  const body = await readJsonBody(req);
  const action = body.action;
  if (!['reaffirm', 'archive', 'update', 'supersede'].includes(action)) {
    throw invalid('action must be one of: reaffirm, archive, update, supersede');
  }
  return withWorkspace(ws, (db, store) => {
    if (action === 'archive') {
      const row = db.prepare('SELECT state FROM facts WHERE id = ?').get(id);
      if (!row) throw new HttpError(404, 'fact_not_found', `no fact with id ${id}`);
      if (row.state === 'revoked') throw new HttpError(409, 'fact_closed', `fact ${id} is already archived`);
      store.update(id, { state: 'revoked' });
      return { fact: factById(db, ws, id), driftCount: driftCount(db) };
    }
    openFact(db, id);
    if (action === 'reaffirm') {
      const anchors = db.prepare('SELECT path, qualified_name FROM fact_symbol_evidence WHERE fact_id = ?').all(id);
      refreshFiles(ws, anchors.map(row => row.path));
      // A symbol that is gone has no signature to re-baseline to.
      const exists = db.prepare('SELECT 1 FROM ast_symbols WHERE path = ? AND qualified_name = ? LIMIT 1');
      const removed = anchors.find(row => !exists.get(row.path, row.qualified_name));
      if (removed) {
        throw new HttpError(409, 'symbol_changed', `${removed.path}::${removed.qualified_name} no longer exists — supersede or archive this fact instead`);
      }
      store.reaffirm(id);
      return { fact: factById(db, ws, id), driftCount: driftCount(db) };
    }
    if (action === 'supersede') {
      const input = factInput(db, ws, body);
      if (body.evidenceFiles === undefined && body.evidenceSymbols === undefined) Object.assign(input, inheritedEvidence(db, ws, id));
      const replacement = recordFact(store, { ...input, supersedes: id });
      return { status: 201, body: { fact: factById(db, ws, replacement), superseded: factById(db, ws, id), driftCount: driftCount(db) } };
    }
    const changes = {
      title: optionalText(body, 'title', 200),
      summary: optionalText(body, 'summary', 500),
      body: optionalText(body, 'body', 20000),
      confidence: optionalConfidence(body)
    };
    if (body.kind !== undefined) {
      if (!VALID_KINDS.includes(body.kind)) throw invalid(`kind must be one of: ${VALID_KINDS.join(', ')}`);
      changes.kind = body.kind;
    }
    store.update(id, changes);
    return { fact: factById(db, ws, id), driftCount: driftCount(db) };
  });
}

async function postReindex(ctx, req, url) {
  const ws = resolveWorkspace(ctx, url);
  await readJsonBody(req);
  if (!ws.root) throw new HttpError(409, 'workspace_has_no_root', 'this workspace has no root directory to index');
  const stats = syncWorkspaceAst(ws.root, ws.dbFile);
  return withWorkspace(ws, (db, store) => {
    ensureVerified(ctx, ws, store, true);
    return { workspaceId: ws.id, stats, driftCount: driftCount(db) };
  });
}

const ROUTES = [
  ['GET', /^\/api\/workspaces$/, getWorkspaces],
  ['GET', /^\/api\/graph$/, getGraph],
  ['GET', /^\/api\/symbols$/, getSymbols],
  ['GET', /^\/api\/symbol\/([^/]+)$/, getSymbol],
  ['GET', /^\/api\/facts$/, getFacts],
  ['POST', /^\/api\/facts$/, postFact],
  ['PATCH', /^\/api\/facts\/([^/]+)$/, patchFact],
  ['POST', /^\/api\/reindex$/, postReindex]
];

async function handleApi(ctx, req, res, url) {
  const matches = ROUTES.filter(([, pattern]) => pattern.test(url.pathname));
  if (matches.length === 0) throw new HttpError(404, 'not_found', 'no such endpoint');
  const route = matches.find(([method]) => method === req.method);
  if (!route) throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here`);
  const [, pattern, handler] = route;
  const params = pattern.exec(url.pathname).slice(1).map(part => {
    try { return decodeURIComponent(part); } catch { throw invalid('malformed path parameter'); }
  });
  const result = await handler(ctx, req, url, params);
  if (result && typeof result.status === 'number' && 'body' in result) sendJson(res, result.status, result.body);
  else sendJson(res, 200, result);
}

// ── static UI ──

async function serveStatic(ctx, req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here`);
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'bad_path', 'malformed path'); }
  if (decoded.includes('\0')) throw new HttpError(400, 'bad_path', 'malformed path');
  const target = path.resolve(ctx.distDir, `.${decoded}`);
  if (!isInside(ctx.distDir, target)) throw new HttpError(403, 'forbidden_path', 'path is outside the UI bundle');

  let file = target;
  let stat = await fs.promises.stat(file).catch(() => null);
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = await fs.promises.stat(file).catch(() => null);
  }
  // Client-side routes fall back to the app shell; a missing asset is a 404.
  if (!stat && !path.extname(decoded)) {
    file = path.join(ctx.distDir, 'index.html');
    stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('The caipira explore UI is not built. Run: caipira install\n');
      return;
    }
  }
  if (!stat || !stat.isFile()) throw new HttpError(404, 'not_found', 'no such file');
  const hashed = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...SECURITY_HEADERS
  });
  if (req.method === 'HEAD') { res.end(); return; }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    res.on('close', () => { stream.destroy(); resolve(); });
    stream.pipe(res).on('finish', resolve);
  });
}

// ── server ──

/**
 * Creates the explore HTTP server; the caller listens and closes it.
 * Registers `defaultWorkspace` in master.db when it is not there yet.
 * @param {{caipiraDir?: string, defaultWorkspace?: string, distDir?: string, host?: string}} [opts]
 *   caipiraDir holds explore-ui/dist (default: this file's directory); distDir overrides
 *   the bundle directory; host is the address it will bind (default 127.0.0.1).
 * @returns {import('http').Server}
 */
function createExploreServer(opts = {}) {
  const caipiraDir = path.resolve(opts.caipiraDir || __dirname);
  const workspace = ensureWorkspace(opts.defaultWorkspace || process.cwd());
  const host = bindHostname(opts.host);
  const ctx = {
    defaultWorkspaceId: workspace.id,
    distDir: path.resolve(opts.distDir || path.join(caipiraDir, 'explore-ui', 'dist')),
    loopbackOnly: LOOPBACK_HOSTS.has(host),
    verified: new Set()
  };
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://explore.local');
    } catch {
      sendError(res, new HttpError(400, 'bad_path', 'malformed request target'));
      return;
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    Promise.resolve()
      .then(() => {
        checkHost(ctx, req);
        return isApi ? handleApi(ctx, req, res, url) : serveStatic(ctx, req, res, url);
      })
      .catch(error => {
        const failure = toHttpError(error);
        if (failure.status >= 500) process.stderr.write(`[caipira-explore] ${req.method} ${url.pathname}: ${error.message}\n`);
        if (res.headersSent) { res.destroy(); return; }
        sendError(res, failure);
      });
  });
}

// ── CLI ──

const USAGE = 'Usage: caipira explore [--port 4777] [--host 127.0.0.1] [--workspace <path>] [--no-open]';

/**
 * @param {string[]} argv Arguments after `explore`.
 * @returns {{port: number, host: string, workspace: string, open: boolean, help: boolean}}
 * @throws {UsageError} For an unknown flag or a bad value.
 */
function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, host: DEFAULT_HOST, workspace: process.cwd(), open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      if (eq > 0) return arg.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--port': {
        const raw = value();
        if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) throw new UsageError('--port must be an integer from 0 to 65535');
        opts.port = Number(raw);
        break;
      }
      case '--host': opts.host = value(); break;
      case '--workspace': opts.workspace = path.resolve(value()); break;
      case '--no-open': opts.open = false; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => process.stderr.write(`[caipira-explore] could not open a browser; visit ${url}\n`));
    child.unref();
  } catch {
    process.stderr.write(`[caipira-explore] could not open a browser; visit ${url}\n`);
  }
}

/**
 * Runs `caipira explore`: indexes the workspace when the AST engine is
 * available, then serves until SIGINT or SIGTERM.
 * @param {string[]} argv Arguments after `explore`.
 * @returns {Promise<import('http').Server|null>} null when only usage was printed.
 */
async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return null;
  }
  if (opts.help) { process.stdout.write(`${USAGE}\n`); return null; }
  if (!fs.existsSync(opts.workspace) || !fs.statSync(opts.workspace).isDirectory()) {
    process.stderr.write(`[caipira-explore] workspace is not a directory: ${opts.workspace}\n`);
    process.exitCode = 2;
    return null;
  }

  const workspace = ensureWorkspace(opts.workspace);
  if (workspace.root) {
    try {
      const stats = syncWorkspaceAst(workspace.root, workspace.dbFile);
      process.stdout.write(`Indexed ${workspace.root}: ${stats.parsed} parsed, ${stats.skipped + stats.hash_matched} unchanged, ${stats.symbols_total} symbols\n`);
    } catch (error) {
      if (!(error instanceof AstEngineError)) throw error;
      process.stderr.write(`[caipira-explore] symbol index not refreshed — ${error.message}\n`);
    }
  }

  const server = createExploreServer({ caipiraDir: __dirname, defaultWorkspace: opts.workspace, host: opts.host });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const shownHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${shownHost}:${address.port}/`;
  process.stdout.write(`Caipira explore listening on ${url}\n`);
  if (!LOOPBACK_HOSTS.has(bindHostname(opts.host))) {
    process.stderr.write('[caipira-explore] warning: bound to a non-loopback address; anyone who can reach it can read and edit this memory\n');
  }
  if (opts.open) openBrowser(url);

  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`[caipira-explore] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createExploreServer, parseArgs, main, HttpError, UsageError, DEFAULT_PORT, DEFAULT_HOST };
