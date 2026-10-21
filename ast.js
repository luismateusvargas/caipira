// caipira/ast.js — bridge to the caipira-ast binary and queries over the
// symbol index it keeps in each <workspace>.db.
//
// Writes go through the binary (index, update-file), which owns parsing and
// the three-tier gate: (size, mtime) first, sha256 second, tree-sitter last.
// Reads are plain SQL over ast_files, ast_symbols, ast_edges and
// ast_symbols_fts, so a query never spawns a process.
//
// The binary reports failures as one JSON line on stderr plus an exit code;
// every failure surfaces here as an AstEngineError with a stable `code`.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, openWorkspaceDb } = require('./workspace');

const BIN_NAME = process.platform === 'win32' ? 'caipira-ast.exe' : 'caipira-ast';
const CRATE_DIR = path.join(__dirname, 'rust', 'caipira-ast');
const INSTALLED_BIN = path.join(ROOT, 'bin', BIN_NAME);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_BUFFER = 256 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_TEXT = 500;

const ENGINE_CODES = new Set(['invalid_argument', 'unsupported', 'io', 'database', 'parse']);
const UPDATE_STATUSES = new Set(['added', 'updated', 'unchanged', 'removed']);
const STAT_FIELDS = ['parsed', 'skipped', 'hash_matched', 'removed', 'symbols_total', 'edges_total', 'duration_ms'];

/**
 * A caipira-ast failure. `code` is one of: binary_missing, timeout,
 * bad_output, failed, invalid_argument, unsupported, io, database, parse.
 */
class AstEngineError extends Error {
  /**
   * @param {string} code Stable failure category.
   * @param {string} message Human-readable detail.
   * @param {{exitCode?: number|null}} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AstEngineError';
    this.code = code;
    this.exitCode = details.exitCode ?? null;
  }
}

// ── the binary ──

function isExecutable(file) {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The caipira-ast binary to run: CAIPIRA_AST_BIN when set, else the
 * installed copy under <CAIPIRA_HOME>/bin, else a release or debug build in
 * rust/caipira-ast/target.
 * @returns {string}
 * @throws {AstEngineError} binary_missing when none exists.
 */
function resolveBinary() {
  const override = process.env.CAIPIRA_AST_BIN;
  if (override) {
    if (isExecutable(override)) return override;
    throw new AstEngineError('binary_missing', `CAIPIRA_AST_BIN does not point at an executable: ${override}`);
  }
  const candidates = [
    INSTALLED_BIN,
    path.join(CRATE_DIR, 'target', 'release', BIN_NAME),
    path.join(CRATE_DIR, 'target', 'debug', BIN_NAME)
  ];
  const found = candidates.find(isExecutable);
  if (!found) {
    throw new AstEngineError('binary_missing', `caipira-ast not found (looked in ${candidates.join(', ')}) — run: caipira install`);
  }
  return found;
}

function engineFailure(error) {
  if (error.code === 'ENOENT' || error.code === 'EACCES') {
    return new AstEngineError('binary_missing', `caipira-ast could not start: ${error.message}`);
  }
  if (error.code === 'ETIMEDOUT') {
    return new AstEngineError('timeout', 'caipira-ast timed out');
  }
  const stderr = String(error.stderr || '').trim();
  const lastLine = stderr.split('\n').filter(Boolean).pop() || '';
  let report = null;
  try { report = JSON.parse(lastLine); } catch { /* clap usage errors are plain text */ }
  const exitCode = typeof error.status === 'number' ? error.status : null;
  if (report && ENGINE_CODES.has(report.error)) {
    return new AstEngineError(report.error, String(report.message || report.error), { exitCode });
  }
  const code = exitCode === 2 ? 'invalid_argument' : 'failed';
  return new AstEngineError(code, stderr || error.message, { exitCode });
}

/**
 * Runs one caipira-ast subcommand and parses its JSON result.
 * @param {string[]} args
 * @param {{timeoutMs?: number, bin?: string}} [opts]
 * @returns {any}
 * @throws {AstEngineError}
 */
function runEngine(args, opts = {}) {
  const bin = opts.bin || resolveBinary();
  let stdout;
  try {
    stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    throw engineFailure(error);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new AstEngineError('bad_output', 'caipira-ast printed something other than JSON');
  }
}

// ── validation ──

function requireText(name, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new AstEngineError('invalid_argument', `${name} must be a non-empty string`);
  }
  return value;
}

function badOutput(what) {
  return new AstEngineError('bad_output', `caipira-ast returned a malformed ${what}`);
}

function checkStats(value) {
  if (!value || typeof value !== 'object') throw badOutput('index result');
  for (const field of STAT_FIELDS) {
    if (!Number.isInteger(value[field]) || value[field] < 0) throw badOutput(`index result (${field})`);
  }
  return value;
}

function checkUpdate(value) {
  const diff = value && value.diff;
  const valid = value && UPDATE_STATUSES.has(value.status) && typeof value.path === 'string'
    && diff && ['added', 'removed', 'modified'].every(key => Array.isArray(diff[key]));
  if (!valid) throw badOutput('update-file result');
  return value;
}

function boundedInt(name, value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new AstEngineError('invalid_argument', `${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

function optionalText(name, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_TEXT) {
    throw new AstEngineError('invalid_argument', `${name} must be a string of at most ${MAX_TEXT} characters`);
  }
  return value;
}

// ── writes, through the binary ──

// The binary creates the ast tables itself, but going through the JS
// migrations first keeps the database at the current schema version and
// registers WAL mode exactly as every other opener does.
function prepareDb(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  openWorkspaceDb(dbFile).close();
}

/**
 * Incrementally indexes every supported source file in a workspace.
 * @param {string} workspaceRoot Absolute workspace root.
 * @param {string} dbFile The workspace database.
 * @param {{timeoutMs?: number, bin?: string}} [opts]
 * @returns {{parsed: number, skipped: number, hash_matched: number, removed: number,
 *   failed: number, symbols_total: number, edges_total: number, duration_ms: number}}
 * @throws {AstEngineError}
 */
function syncWorkspaceAst(workspaceRoot, dbFile, opts = {}) {
  requireText('workspaceRoot', workspaceRoot);
  requireText('dbFile', dbFile);
  prepareDb(dbFile);
  return checkStats(runEngine(['index', '--workspace', workspaceRoot, '--db', dbFile], opts));
}

/**
 * Re-indexes one file and returns the symbol diff against what was stored.
 * @param {string} workspaceRoot Absolute workspace root.
 * @param {string} dbFile The workspace database.
 * @param {string} filePath Absolute, or relative to the workspace root.
 * @param {{timeoutMs?: number, bin?: string}} [opts]
 * @returns {{status: 'added'|'updated'|'unchanged'|'removed', path: string,
 *   diff: {added: object[], removed: object[], modified: {before: object, after: object}[]}, duration_ms: number}}
 * @throws {AstEngineError} unsupported for a non-source file, io when it is missing and was never indexed.
 */
function updateFileAst(workspaceRoot, dbFile, filePath, opts = {}) {
  requireText('workspaceRoot', workspaceRoot);
  requireText('dbFile', dbFile);
  requireText('filePath', filePath);
  prepareDb(dbFile);
  const args = ['update-file', '--workspace', workspaceRoot, '--db', dbFile, '--file', filePath];
  return checkUpdate(runEngine(args, opts));
}

/**
 * Parses one file without touching any database.
 * @param {string} workspaceRoot Absolute workspace root.
 * @param {string} filePath Absolute, or relative to the workspace root.
 * @param {{timeoutMs?: number, bin?: string}} [opts]
 * @returns {{path: string, language: string, symbols: object[], edges: object[]}}
 * @throws {AstEngineError}
 */
function parseFileAst(workspaceRoot, filePath, opts = {}) {
  requireText('workspaceRoot', workspaceRoot);
  requireText('filePath', filePath);
  const snapshot = runEngine(['parse-file', '--workspace', workspaceRoot, '--file', filePath], opts);
  if (!snapshot || !Array.isArray(snapshot.symbols) || !Array.isArray(snapshot.edges)) throw badOutput('snapshot');
  return snapshot;
}

// ── reads, in SQL ──

// Accepts a database path or an already-open better-sqlite3 handle, which is
// used as-is and left open. A path that does not exist yields `fallback`
// rather than creating an empty database.
function withDb(dbFile, fallback, fn) {
  if (dbFile && typeof dbFile.prepare === 'function') return fn(dbFile);
  requireText('dbFile', dbFile);
  if (!fs.existsSync(dbFile)) return fallback;
  const db = openWorkspaceDb(dbFile);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const SYMBOL_COLUMNS = ['id', 'path', 'name', 'qualified_name', 'kind', 'is_public', 'start_line', 'end_line',
  'params_json', 'return_type', 'doc_summary', 'signature_text', 'signature_hash'].map(c => `s.${c}`).join(', ');

function rowToSymbol(row) {
  let params = [];
  try { params = JSON.parse(row.params_json); } catch { /* a corrupt row reads as no parameters */ }
  const { params_json: _, ...rest } = row;
  return { ...rest, is_public: row.is_public === 1, params };
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, ch => `\\${ch}`);
}

// A trigram FTS5 phrase matches the text as a substring, case-insensitively.
function ftsPhrase(text) {
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Searches a workspace's symbols. With `query` of 3+ characters the search
 * is a substring match over name, qualified name, signature, doc and path
 * (exact names first); shorter queries match name or qualified name.
 * @param {string|object} dbFile Database path or open better-sqlite3 handle.
 * @param {{query?: string, kind?: string, path?: string, publicOnly?: boolean,
 *   limit?: number, offset?: number}} [filters] `path` matches a file or a directory prefix.
 * @returns {object[]} Symbols with parsed `params` and boolean `is_public`.
 * @throws {AstEngineError} invalid_argument for malformed filters.
 */
function queryWorkspaceSymbols(dbFile, filters = {}) {
  if (!filters || typeof filters !== 'object') throw new AstEngineError('invalid_argument', 'filters must be an object');
  const query = optionalText('query', filters.query);
  const kind = optionalText('kind', filters.kind);
  const pathFilter = optionalText('path', filters.path);
  const limit = boundedInt('limit', filters.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = boundedInt('offset', filters.offset, 0, 1e9);

  return withDb(dbFile, [], db => {
    const where = [];
    const args = { limit, offset };
    if (kind) { where.push('s.kind = @kind'); args.kind = kind; }
    if (pathFilter) {
      const prefix = pathFilter.replace(/\/+$/, '');
      where.push("(s.path = @path OR s.path LIKE @pathPrefix ESCAPE '\\')");
      args.path = prefix;
      args.pathPrefix = `${escapeLike(prefix)}/%`;
    }
    if (filters.publicOnly === true) where.push('s.is_public = 1');

    let sql;
    if (query && [...query].length >= 3) {
      args.match = ftsPhrase(query);
      args.exact = query;
      sql = `SELECT ${SYMBOL_COLUMNS} FROM ast_symbols_fts
             JOIN ast_symbols s ON s.id = ast_symbols_fts.rowid
             WHERE ast_symbols_fts MATCH @match${where.length ? ` AND ${where.join(' AND ')}` : ''}
             ORDER BY (lower(s.name) = lower(@exact)) DESC, bm25(ast_symbols_fts), s.path, s.start_line
             LIMIT @limit OFFSET @offset`;
    } else {
      if (query) {
        args.like = `%${escapeLike(query)}%`;
        where.push("(s.name LIKE @like ESCAPE '\\' OR s.qualified_name LIKE @like ESCAPE '\\')");
      }
      sql = `SELECT ${SYMBOL_COLUMNS} FROM ast_symbols s
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY s.path, s.start_line LIMIT @limit OFFSET @offset`;
    }
    return db.prepare(sql).all(args).map(rowToSymbol);
  });
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|vue|pyi?|rs|go|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;

// Selectors: a symbol id; "path::qualified.name"; "path:line" for the
// innermost symbol enclosing that line; a bare qualified or simple name; or
// {id} / {path, qualified_name}. Rust and C++ names contain "::" too, so the
// first "::" splits off a path only when what precedes it is a source file.
function findSymbols(db, selector) {
  const select = `SELECT ${SYMBOL_COLUMNS} FROM ast_symbols s`;
  if (Number.isInteger(selector) || (typeof selector === 'string' && /^\d+$/.test(selector))) {
    return db.prepare(`${select} WHERE s.id = ?`).all(Number(selector));
  }
  if (selector && typeof selector === 'object') {
    if (Number.isInteger(selector.id)) return db.prepare(`${select} WHERE s.id = ?`).all(selector.id);
    const qualified = selector.qualified_name ?? selector.qualifiedName;
    requireText('selector.path', selector.path);
    requireText('selector.qualified_name', qualified);
    return db.prepare(`${select} WHERE s.path = ? AND s.qualified_name = ? ORDER BY s.start_line`).all(selector.path, qualified);
  }
  const text = requireText('selector', selector);
  if (text.length > MAX_TEXT) throw new AstEngineError('invalid_argument', 'selector is too long');
  const lineMatch = text.match(/^(.+):(\d+)$/);
  if (lineMatch && SOURCE_EXTENSION.test(lineMatch[1])) {
    return db.prepare(`${select} WHERE s.path = ? AND s.start_line <= ? AND s.end_line >= ?
                       ORDER BY (s.end_line - s.start_line), s.start_line DESC LIMIT 1`)
      .all(lineMatch[1], Number(lineMatch[2]), Number(lineMatch[2]));
  }
  const split = text.indexOf('::');
  if (split > 0 && SOURCE_EXTENSION.test(text.slice(0, split))) {
    return db.prepare(`${select} WHERE s.path = ? AND s.qualified_name = ? ORDER BY s.start_line`)
      .all(text.slice(0, split), text.slice(split + 2));
  }
  return db.prepare(`${select} WHERE s.qualified_name = @t OR s.name = @t
                     ORDER BY (s.qualified_name = @t) DESC, s.is_public DESC, s.path, s.start_line LIMIT 50`)
    .all({ t: text });
}

function symbolIdFor(db, targetPath, targetSymbol) {
  if (!targetPath) return null;
  const row = db.prepare(`SELECT id FROM ast_symbols WHERE path = ? AND (qualified_name = ? OR name = ?)
                          ORDER BY (qualified_name = ?) DESC, start_line LIMIT 1`)
    .get(targetPath, targetSymbol, targetSymbol, targetSymbol);
  return row ? row.id : null;
}

/**
 * Everything known about one symbol: its signature, who calls it, what it
 * calls, the types it uses and is used by, inheritance in both directions,
 * its file's import edges, and facts anchored to it.
 *
 * Callers are matched by resolved target (`resolved: true`) or, for calls
 * the parser could not resolve to a file, by name (`resolved: false`), so
 * the latter can include same-named symbols elsewhere.
 * @param {string|object} dbFile Database path or open better-sqlite3 handle.
 * @param {string|number|object} selector See findSymbols above.
 * @param {{limit?: number}} [opts] Cap on each related list (default 100).
 * @returns {object|null} null when nothing matches.
 * @throws {AstEngineError} invalid_argument for a malformed selector.
 */
function inspectSymbol(dbFile, selector, opts = {}) {
  const limit = boundedInt('limit', opts.limit, 100, MAX_LIMIT);
  return withDb(dbFile, null, db => {
    const matches = findSymbols(db, selector).map(rowToSymbol);
    if (matches.length === 0) return null;
    const [symbol, ...others] = matches;
    const names = { path: symbol.path, qn: symbol.qualified_name, name: symbol.name, limit };
    const suffixes = {
      dot: `%.${escapeLike(symbol.name)}`,
      colon: `%::${escapeLike(symbol.name)}`
    };

    const callers = db.prepare(`
      SELECT source_path AS path, source_symbol AS symbol, line, target_path IS NOT NULL AS resolved
      FROM ast_edges
      WHERE edge_kind = 'calls' AND (
        (target_path = @path AND target_symbol IN (@qn, @name))
        OR (target_path IS NULL AND (target_symbol IN (@qn, @name)
            OR target_symbol LIKE @dot ESCAPE '\\' OR target_symbol LIKE @colon ESCAPE '\\'))
      )
      ORDER BY resolved DESC, source_path, line LIMIT @limit
    `).all({ ...names, ...suffixes }).map(row => ({ ...row, resolved: row.resolved === 1 }));

    const outgoing = kinds => db.prepare(`
      SELECT target_path, target_symbol, edge_kind, line FROM ast_edges
      WHERE source_path = @path AND source_symbol = @qn AND edge_kind IN (${kinds.map(k => `'${k}'`).join(', ')})
      ORDER BY line LIMIT @limit
    `).all(names).map(row => ({ ...row, symbol_id: symbolIdFor(db, row.target_path, row.target_symbol) }));

    const incoming = kinds => db.prepare(`
      SELECT source_path AS path, source_symbol AS symbol, edge_kind, line FROM ast_edges
      WHERE edge_kind IN (${kinds.map(k => `'${k}'`).join(', ')})
        AND ((target_path = @path AND target_symbol IN (@qn, @name))
             OR (target_path IS NULL AND target_symbol IN (@qn, @name)))
      ORDER BY source_path, line LIMIT @limit
    `).all(names);

    const file = db.prepare('SELECT path, language, size, mtime_ms, indexed_at FROM ast_files WHERE path = ?').get(symbol.path) || null;
    const imports = db.prepare(`SELECT target_path, target_symbol, line FROM ast_edges
                                WHERE source_path = ? AND edge_kind = 'imports' ORDER BY line LIMIT ?`).all(symbol.path, limit);
    const importedBy = db.prepare(`SELECT source_path AS path, target_symbol AS specifier, line FROM ast_edges
                                   WHERE target_path = ? AND edge_kind = 'imports' ORDER BY source_path, line LIMIT ?`).all(symbol.path, limit);

    const facts = db.prepare(`
      SELECT f.id AS fact_id, f.kind, f.title, f.summary, f.state, e.signature_hash
      FROM fact_symbol_evidence e JOIN facts f ON f.id = e.fact_id
      WHERE e.path = ? AND e.qualified_name = ? AND f.state IN ('active', 'needs_review')
      ORDER BY f.updated_at DESC
    `).all(symbol.path, symbol.qualified_name)
      .map(row => ({ ...row, evidence_status: row.signature_hash === symbol.signature_hash ? 'current' : 'drifted' }));

    return {
      symbol,
      alternatives: others.map(s => ({ id: s.id, path: s.path, qualified_name: s.qualified_name, kind: s.kind })),
      callers,
      callees: outgoing(['calls']),
      uses_types: outgoing(['uses_type']),
      used_by: incoming(['uses_type']),
      inherits: outgoing(['extends', 'implements']),
      inherited_by: incoming(['extends', 'implements']),
      file: file && { ...file, imports, imported_by: importedBy },
      facts
    };
  });
}

/**
 * One file's symbols and import edges in both directions.
 * @param {string|object} dbFile Database path or open better-sqlite3 handle.
 * @param {string} relPath Workspace-relative file path.
 * @returns {{file: object, symbols: object[], imports: object[], imported_by: object[]}|null}
 *   null when the file is not indexed.
 */
function fileEdges(dbFile, relPath) {
  requireText('relPath', relPath);
  return withDb(dbFile, null, db => {
    const file = db.prepare('SELECT path, language, size, mtime_ms, content_sha256, indexed_at FROM ast_files WHERE path = ?').get(relPath);
    if (!file) return null;
    return {
      file,
      symbols: db.prepare(`SELECT ${SYMBOL_COLUMNS} FROM ast_symbols s WHERE s.path = ? ORDER BY s.start_line`).all(relPath).map(rowToSymbol),
      imports: db.prepare(`SELECT target_path, target_symbol, line FROM ast_edges
                           WHERE source_path = ? AND edge_kind = 'imports' ORDER BY line`).all(relPath),
      imported_by: db.prepare(`SELECT source_path AS path, target_symbol AS specifier, line FROM ast_edges
                               WHERE target_path = ? AND edge_kind = 'imports' ORDER BY source_path, line`).all(relPath)
    };
  });
}

module.exports = {
  AstEngineError,
  INSTALLED_BIN,
  CRATE_DIR,
  resolveBinary,
  syncWorkspaceAst,
  updateFileAst,
  // The acceptance criteria's name for updateFileAst.
  updateFileSymbols: updateFileAst,
  parseFileAst,
  queryWorkspaceSymbols,
  inspectSymbol,
  fileEdges
};
