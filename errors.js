// Crash-safe diagnostics: built-ins only, including when native SQLite cannot load.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { version } = require('./package.json');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 16000;
const recorded = new WeakMap();

function privateText(value) {
  const tags = /<\/?private\b[^>]*>/gi;
  let depth = 0, start = 0, output = '';
  for (const match of value.matchAll(tags)) {
    if (!match[0].startsWith('</')) {
      if (depth === 0) output += value.slice(start, match.index) + '[REDACTED]';
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) start = match.index + match[0].length;
    }
  }
  return output + (depth === 0 ? value.slice(start) : '');
}

/** @param {unknown} value @returns {string} Bounded text with credentials removed. */
function sanitize(value) {
  return privateText(String(value ?? ''))
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
    .replace(/((?:["']?)(?:authorization|password|passwd|secret|[\w-]*(?:token|api[_-]?key|access[_-]?key)[\w-]*)["']?\s*(?:[:=]\s*|\s+))(?:("|')[\s\S]*?\2|[^\s,;&}\]]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|xox[baprs]-[\w-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, MAX_TEXT);
}

function journalPath() {
  return path.join(path.resolve(process.env.CAIPIRA_HOME || path.join(os.homedir(), '.caipira')), 'logs', 'errors.jsonl');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Only synthetic payloads enter a reproduction command. Never persist a prompt,
// tool result, session id, credential, or arbitrary caller-supplied shell text.
function reproduction({ component, client, event, operation, payload }) {
  const word = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_/-]{0,79}$/.test(value) ? value : 'unknown';
  const node = shellQuote(process.execPath);
  if (component === 'hook') {
    const c = ['codex', 'claude-code', 'antigravity'].includes(client) ? client : 'unknown';
    const e = word(event);
    const skeleton = JSON.stringify({ client: c, event: e, cwd: '/path/to/workspace', session_id: 'repro-session' });
    return `printf '%s\\n' ${shellQuote(skeleton)} | ${node} ${shellQuote(path.join(__dirname, 'hooks', 'universal-hook.js'))} --client ${c} --event ${shellQuote(e)}`;
  }
  if (component === 'mcp') {
    const name = word(payload?.params?.name || operation);
    const args = { cwd: '/path/to/workspace' };
    if (name === 'search' || name === 'search_facts') args.query = 'repro query';
    if (name === 'get_observations' || name === 'check_drift') args.ids = [1];
    if (name === 'timeline') args.session_id = 'repro-session';
    if (name === 'update_fact') args.id = 1;
    if (name === 'record_fact') Object.assign(args, { kind: 'decision', title: 'Repro', body: 'Reproduction fact' });
    if (name === 'inspect_symbol') args.symbol = 'src/example.js::example';
    const skeleton = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args } });
    return `printf '%s\\n' ${shellQuote(skeleton)} | ${node} ${shellQuote(path.join(__dirname, 'mcp.js'))}`;
  }
  if (component === 'ast') {
    const subcommand = ['parse-file', 'update-file'].includes(operation) ? operation : 'index';
    return `caipira-ast ${subcommand} --workspace /path/to/workspace${subcommand === 'parse-file' ? '' : ' --db /tmp/caipira-repro.db'}${subcommand === 'index' ? '' : ' --file src/example.js'}`;
  }
  const command = component === 'explore' ? 'explore --no-open --workspace /path/to/workspace'
    : ['install', 'uninstall', 'doctor', 'status', 'prune', 'logs'].includes(operation) ? operation
      : /AST|cargo|UI|deploy/.test(operation) ? 'install' : 'doctor';
  return `${node} ${shellQuote(path.join(__dirname, 'install.js'))} ${command}`;
}

/**
 * Appends one sanitized JSON record synchronously. A failure in the journal
 * itself is deliberately ignored so diagnostics never break a client protocol.
 * The same Error reported by several boundaries is recorded only once.
 * @param {{component: 'hook'|'mcp'|'ast'|'explore'|'install', operation: string,
 *   client?: string, event?: string, error: unknown, payload?: object, args?: string[]}} details
 * @returns {object|null} The saved record, or null if the journal is unavailable.
 */
function logError(details) {
  try {
    const error = details.error;
    const trackable = error !== null && (typeof error === 'object' || typeof error === 'function');
    if (trackable && recorded.has(error)) return recorded.get(error);
    if (trackable && error.cause && recorded.has(error.cause)) return recorded.get(error.cause);
    const entry = {
      id: randomUUID(), ts: new Date().toISOString(), component: sanitize(details.component),
      operation: sanitize(details.operation), client: sanitize(details.client || 'unknown'),
      error: { name: sanitize(error?.name || 'Error'), code: sanitize(error?.code) || null,
        message: sanitize(error?.message ?? error), stack: sanitize(error?.stack) },
      env: { caipiraVersion: version, nodeVersion: process.version, abi: process.versions.modules,
        platform: process.platform, arch: process.arch, execPath: sanitize(process.execPath) },
      repro: sanitize(reproduction(details))
    };
    const file = journalPath();
    const line = JSON.stringify(entry) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > MAX_BYTES) {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    if (trackable) recorded.set(error, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Reads newest entries first across the active journal and its one backup.
 * Clear removes both files after reading. Missing journals are empty; other
 * filesystem errors propagate to the CLI for a visible diagnostic.
 * @param {{limit?: number, clear?: boolean}} [options]
 * @returns {object[]}
 * @throws {RangeError} For an invalid limit.
 * @throws {Error} When existing journals cannot be read or cleared.
 */
function readErrors({ limit = 20, clear = false } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer');
  const files = [journalPath(), `${journalPath()}.1`];
  const entries = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of content.trim().split('\n').reverse()) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.id === 'string' && typeof entry.ts === 'string' && entry.error && typeof entry.repro === 'string') entries.push(entry);
      } catch { /* A torn final write must not hide the remaining records. */ }
    }
  }
  if (clear) for (const file of files) fs.rmSync(file, { force: true });
  return entries.slice(0, limit);
}

module.exports = { logError, readErrors };
