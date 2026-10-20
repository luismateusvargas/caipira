#!/usr/bin/env node
// caipira/install.js — installs and wires Caipira into Claude Code.
//
// Run with the BUNDLED Node 22 runtime, never the system Node 24:
//   Windows: .\node22\node-v22.20.0-win-x64\node.exe install.js  (caipira.cmd)
//   Linux:   ./node22/node-v22.20.0-linux-x64/bin/node install.js  (caipira.sh)
//
// Commands: install | uninstall | status | doctor | prune [--apply] | mode <lite|full|ultra>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const HOME = os.homedir();
const IS_WINDOWS = process.platform === 'win32';
const NODE_DIR = path.join(ROOT, 'node22', IS_WINDOWS ? 'node-v22.20.0-win-x64' : 'node-v22.20.0-linux-x64');
const NODE_BIN = IS_WINDOWS ? path.join(NODE_DIR, 'node.exe') : path.join(NODE_DIR, 'bin', 'node');
const NPM_CLI = IS_WINDOWS
  ? path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : path.join(NODE_DIR, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const MCP_ENTRY = path.join(ROOT, 'mcp.js');
const HOOK_ENTRY = path.join(ROOT, 'hooks', 'universal-hook.js');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
const ANTIGRAVITY_MCP = path.join(HOME, '.gemini', 'config', 'mcp_config.json');
const ANTIGRAVITY_HOOKS = path.join(HOME, '.gemini', 'config', 'hooks.json');

// Antigravity hook events. Tool events are grouped behind a matcher; the
// invocation and stop events take a flat list of handlers.
const ANTIGRAVITY_EVENTS = [
  ['PreInvocation', 'pre-invocation', false],
  ['PostToolUse', 'post-tool-use', true],
  ['PostInvocation', 'post-invocation', false],
  ['Stop', 'stop', false]
];
const MODEL_DIR = path.join(ROOT, 'models', 'Xenova', 'all-MiniLM-L6-v2');

// Claude Code hook events -> Caipira lifecycle events.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'];
const HOOK_MARKER = 'caipira';

// Codex names the same lifecycle points differently, and keys its hook trust
// state by the snake_case form rather than the TOML table name.
// Codex clamps SessionEnd hooks to 3s and warns on every launch if asked for more.
const codexTimeout = lifecycle => (lifecycle === 'session-end' ? 3 : 15);
const CODEX_HOOKS = [
  ['SessionStart', 'session_start', 'session-start'],
  ['UserPromptSubmit', 'user_prompt_submit', 'user-prompt-submit'],
  ['PostToolUse', 'post_tool_use', 'post-tool-use'],
  ['Stop', 'stop', 'stop'],
  ['SessionEnd', 'session_end', 'session-end']
];

// ── helpers ──

const log = (msg) => process.stdout.write(`${msg}\n`);
const ok = (msg) => log(`  [ok]   ${msg}`);
const warn = (msg) => log(`  [warn] ${msg}`);
const fail = (msg) => log(`  [FAIL] ${msg}`);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.caipira-backup`);
  }
  const tmp = `${file}.caipira-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.caipira-backup`);
  }
  const tmp = `${file}.caipira-tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function hookCommand(event) {
  // Quoted so spaces in the home directory path stay intact.
  return `"${NODE_BIN}" "${HOOK_ENTRY}" --client claude-code --event ${event}`;
}

function isCaipiraHook(entry) {
  return typeof entry?.command === 'string' && entry.command.toLowerCase().includes(HOOK_MARKER);
}

// ── steps ──

function installDependencies() {
  const marker = path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json');
  if (fs.existsSync(marker)) {
    ok('dependencies already installed');
    return;
  }
  log('  installing dependencies with bundled Node 22...');
  execFileSync(NODE_BIN, [NPM_CLI, 'install', '--omit=dev'], { cwd: ROOT, stdio: 'inherit' });
  ok('dependencies installed');
}

function ensureDirectories() {
  for (const dir of ['logs']) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  }
  ok('runtime directories ready');
}

function registerMcpServer() {
  const config = readJson(CLAUDE_JSON, {});
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.caipira = {
    type: 'stdio',
    command: NODE_BIN,
    args: [MCP_ENTRY],
    env: { CAIPIRA_MODEL_PATH: path.join(ROOT, 'models') }
  };
  writeJsonAtomic(CLAUDE_JSON, config);
  ok('MCP server "caipira" registered (user scope)');
}

function registerHooks() {
  const settings = readJson(CLAUDE_SETTINGS, {});
  settings.hooks = settings.hooks || {};
  for (const event of HOOK_EVENTS) {
    const matchers = (settings.hooks[event] || []).filter(
      group => !(group.hooks || []).some(isCaipiraHook)
    );
    matchers.push({
      matcher: event === 'PostToolUse' ? '*' : undefined,
      hooks: [{ type: 'command', command: hookCommand(event), timeout: 15 }]
    });
    settings.hooks[event] = matchers.map(group => {
      if (group.matcher === undefined) delete group.matcher;
      return group;
    });
  }
  writeJsonAtomic(CLAUDE_SETTINGS, settings);
  ok(`hooks registered: ${HOOK_EVENTS.join(', ')}`);
}

// Codex's config.toml is hand-maintained and full of unrelated plugin state,
// so it is edited by line surgery rather than parsed and re-emitted — a round
// trip through a TOML writer would reorder and reformat everything else in it.
function registerCodex() {
  if (!fs.existsSync(CODEX_CONFIG)) {
    warn('Codex config.toml not found — skipped');
    return;
  }
  const original = fs.readFileSync(CODEX_CONFIG, 'utf8');
  const lines = original.split(/\r?\n/);
  const out = [];

  // `command` is written POSIX-style and `command_windows` with escaped
  // backslashes, matching how Codex already stores the pair.
  const codexCommand = (lifecycle, windows) => {
    const node = windows ? NODE_BIN.replace(/\\/g, '\\\\') : NODE_BIN.replace(/\\/g, '/');
    const entry = windows ? HOOK_ENTRY.replace(/\\/g, '\\\\') : HOOK_ENTRY.replace(/\\/g, '/');
    return `"${node}" "${entry}" --client codex --event ${lifecycle}`;
  };

  let mcpFixed = 0;
  let hooksFixed = 0;
  let section = null;
  let droppingState = false;

  for (const line of lines) {
    // Drop the [hooks.state] trust entries for our own hooks: Codex hashes the
    // command string, so a repointed command still carrying its old hash reads
    // as tampered-with rather than merely changed.
    if (/^\[hooks\.state\./.test(line)) {
      droppingState = CODEX_HOOKS.some(([, snake]) => line.includes(`:${snake}:`));
      if (droppingState) continue;
    } else if (droppingState) {
      if (/^\s*trusted_hash\s*=/.test(line) || /^\s*$/.test(line)) continue;
      droppingState = false;
    }

    if (/^\[mcp_servers\.caipira\]/.test(line)) { section = 'mcp'; out.push(line); continue; }
    if (section === 'mcp') {
      if (/^\s*command\s*=/.test(line)) { out.push(`command = '${NODE_BIN}'`); mcpFixed++; continue; }
      if (/^\s*args\s*=/.test(line)) { out.push(`args = ['${MCP_ENTRY}']`); mcpFixed++; continue; }
      if (/^\[/.test(line)) section = null;
    }

    const header = line.match(/^\[\[hooks\.(\w+)\.hooks\]\]/);
    if (header) {
      const found = CODEX_HOOKS.find(([toml]) => toml === header[1]);
      section = found ? found[2] : null;
      out.push(line);
      continue;
    }
    if (section && section !== 'mcp') {
      if (/^\s*command\s*=/.test(line)) {
        out.push(`command = '${codexCommand(section, false)}'`);
        hooksFixed++;
        continue;
      }
      if (/^\s*command_windows\s*=/.test(line)) {
        out.push(`command_windows = '${codexCommand(section, true)}'`);
        hooksFixed++;
        continue;
      }
      if (/^\s*timeout\s*=/.test(line)) {
        const timeout = `timeout = ${codexTimeout(section)}`;
        if (line.trim() !== timeout) hooksFixed++;
        out.push(timeout);
        continue;
      }
      if (/^\[/.test(line)) section = null;
    }

    out.push(line);
  }

  // Repointing only touches entries that exist; a fresh Codex has none, so the
  // MCP server and hook tables are appended the first time round.
  let appended = '';
  if (!out.some(line => /^\[mcp_servers\.caipira\]/.test(line))) {
    appended += `\n[mcp_servers.caipira]\ncommand = '${NODE_BIN}'\nargs = ['${MCP_ENTRY}']\n`;
  }
  for (const [toml, , lifecycle] of CODEX_HOOKS) {
    const present = out.some(line => line.startsWith(`[[hooks.${toml}.hooks]]`));
    if (present) continue;
    appended += `\n[[hooks.${toml}]]\n[[hooks.${toml}.hooks]]\ntype = "command"\n`
      + `command = '${codexCommand(lifecycle, false)}'\n`
      + `command_windows = '${codexCommand(lifecycle, true)}'\ntimeout = ${codexTimeout(lifecycle)}\n`;
  }
  if (appended) {
    while (out.length && out[out.length - 1] === '') out.pop();
    out.push(appended.replace(/\n$/, ''), '');
  }

  const updated = out.join('\n');
  if (updated === original) {
    ok('Codex config already points at Caipira');
    return;
  }
  writeTextAtomic(CODEX_CONFIG, updated);
  ok(`Codex repointed (${mcpFixed} MCP keys, ${hooksFixed} hook commands, trust hashes cleared)`);
  warn('Codex will ask to re-trust its hooks on next launch');
}

function registerAntigravity() {
  const config = readJson(ANTIGRAVITY_MCP, {});
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.caipira = {
    command: NODE_BIN,
    args: [MCP_ENTRY],
    env: { CAIPIRA_MODEL_PATH: path.join(ROOT, 'models') }
  };
  writeJsonAtomic(ANTIGRAVITY_MCP, config);
  ok('MCP server "caipira" registered for Antigravity');
}

// hooks.json is keyed by hook name, so Caipira owns the "caipira" entry
// outright and rewriting it never touches anyone else's hooks.
function registerAntigravityHooks() {
  const config = readJson(ANTIGRAVITY_HOOKS, {});
  const spec = {};
  for (const [event, lifecycle, grouped] of ANTIGRAVITY_EVENTS) {
    const handler = {
      type: 'command',
      command: `"${NODE_BIN}" "${HOOK_ENTRY}" --client antigravity --event ${lifecycle}`,
      timeout: 15
    };
    spec[event] = grouped ? [{ matcher: '*', hooks: [handler] }] : [handler];
  }
  config.caipira = spec;
  writeJsonAtomic(ANTIGRAVITY_HOOKS, config);
  ok(`Antigravity hooks registered: ${ANTIGRAVITY_EVENTS.map(([event]) => event).join(', ')}`);
}

// Splits TOML into blocks at table headers (a header line plus everything up
// to the next one), so whole tables can be dropped without a TOML round trip.
function tomlBlocks(text) {
  const blocks = [{ header: null, lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    if (/^\[/.test(line)) blocks.push({ header: line.trim(), lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks;
}

// Drops the [mcp_servers.caipira] tables, every [[hooks.X.hooks]] handler that
// runs universal-hook.js, any [[hooks.X]] left with no handlers, and the trust
// state of the events that lost one. Everything else is kept byte for byte.
function stripCodexConfig(text) {
  const blocks = tomlBlocks(text);
  const keep = blocks.map(() => true);
  const strippedEvents = new Set();
  let removed = 0;

  blocks.forEach((block, i) => {
    if (!block.header) return;
    if (/^\[mcp_servers\.caipira[\].]/.test(block.header)) { keep[i] = false; removed++; return; }
    const handler = block.header.match(/^\[\[hooks\.(\w+)\.hooks\]\]$/);
    if (handler && block.lines.some(line => line.includes('universal-hook.js'))) {
      keep[i] = false;
      strippedEvents.add(handler[1]);
      removed++;
    }
  });

  blocks.forEach((block, i) => {
    const parent = block.header && block.header.match(/^\[\[hooks\.(\w+)\]\]$/);
    if (!parent || !strippedEvents.has(parent[1])) return;
    let handlers = 0;
    for (let j = i + 1; j < blocks.length && blocks[j].header === `[[hooks.${parent[1]}.hooks]]`; j++) {
      if (keep[j]) handlers++;
    }
    if (handlers === 0) keep[i] = false;
  });

  // Codex keys trust by hook position, so an event that lost a handler has to
  // be re-trusted either way; stale entries would only read as tampering.
  blocks.forEach((block, i) => {
    if (!block.header || !block.header.startsWith('[hooks.state.')) return;
    const stale = CODEX_HOOKS.some(([toml, snake]) => strippedEvents.has(toml) && block.header.includes(`:${snake}:`));
    if (stale) keep[i] = false;
  });

  const lines = blocks.filter((_, i) => keep[i]).flatMap(block => block.lines);
  return { text: lines.join('\n'), removed };
}

function unregisterCodex() {
  if (!fs.existsSync(CODEX_CONFIG)) {
    warn('Codex config.toml not found — skipped');
    return;
  }
  const original = fs.readFileSync(CODEX_CONFIG, 'utf8');
  const { text, removed } = stripCodexConfig(original);
  if (removed === 0) {
    warn('Codex had no Caipira entries');
    return;
  }
  writeTextAtomic(CODEX_CONFIG, text);
  ok(`Codex entries removed: ${removed}`);
}

function unregisterAntigravity() {
  const mcp = readJson(ANTIGRAVITY_MCP, null);
  if (mcp?.mcpServers?.caipira) {
    delete mcp.mcpServers.caipira;
    writeJsonAtomic(ANTIGRAVITY_MCP, mcp);
    ok('Antigravity MCP server unregistered');
  } else {
    warn('Antigravity MCP server was not registered');
  }

  const hooks = readJson(ANTIGRAVITY_HOOKS, null);
  if (hooks?.caipira) {
    delete hooks.caipira;
    writeJsonAtomic(ANTIGRAVITY_HOOKS, hooks);
    ok('Antigravity hooks removed');
  } else {
    warn('Antigravity hooks were not registered');
  }
}

function unregister() {
  const config = readJson(CLAUDE_JSON, {});
  if (config.mcpServers?.caipira) {
    delete config.mcpServers.caipira;
    writeJsonAtomic(CLAUDE_JSON, config);
    ok('MCP server unregistered');
  } else {
    warn('MCP server was not registered');
  }

  const settings = readJson(CLAUDE_SETTINGS, {});
  let removed = 0;
  for (const event of Object.keys(settings.hooks || {})) {
    const kept = settings.hooks[event].filter(group => {
      const isOurs = (group.hooks || []).some(isCaipiraHook);
      if (isOurs) removed++;
      return !isOurs;
    });
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (removed > 0) writeJsonAtomic(CLAUDE_SETTINGS, settings);
  ok(`hooks removed: ${removed}`);

  unregisterCodex();
  unregisterAntigravity();

  const { DB_DIR } = require('./workspace');
  log(`\nCaipira data under ${DB_DIR} was left untouched.`);
}

// ── workspace databases ──

// Read-only, so status and doctor never migrate, lock, or create a workspace
// they only count. Tables a pre-v2 database lacks count as zero.
function workspaceCounts(dbFile) {
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const has = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    const count = table => (has(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0);
    return {
      observations: count('observations'),
      embeddings: count('embeddings'),
      facts: count('facts'),
      sessions: count('sessions'),
      recent: has('sessions') ? db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 5').all() : []
    };
  } finally {
    db.close();
  }
}

// Every registered workspace whose database exists, with its counts. Rows
// whose file is missing or unreadable come back separately rather than
// failing the whole report.
function aggregateWorkspaces() {
  const { listWorkspaces } = require('./workspace');
  const totals = { workspaces: 0, observations: 0, embeddings: 0, facts: 0, sessions: 0 };
  const recent = [];
  const missing = [];
  const broken = [];
  for (const row of listWorkspaces()) {
    if (!fs.existsSync(row.db_file)) { missing.push(row); continue; }
    let counts;
    try {
      counts = workspaceCounts(row.db_file);
    } catch (error) {
      broken.push({ row, error });
      continue;
    }
    totals.workspaces++;
    for (const key of ['observations', 'embeddings', 'facts', 'sessions']) totals[key] += counts[key];
    for (const session of counts.recent) recent.push({ ...session, workspace: row.label || row.root_path || 'legacy' });
  }
  recent.sort((a, b) => b.started_at - a.started_at);
  return { totals, recent: recent.slice(0, 5), missing, broken };
}

// ── doctor ──

function doctor() {
  let problems = 0;
  const check = (label, condition, hint) => {
    if (condition) { ok(label); return; }
    problems++;
    fail(`${label}${hint ? ` — ${hint}` : ''}`);
  };

  log('\nCaipira doctor\n');

  check(`bundled Node 22 at ${NODE_BIN}`, fs.existsSync(NODE_BIN), 'reinstall the node22 folder');
  check('dependencies installed', fs.existsSync(path.join(ROOT, 'node_modules', 'better-sqlite3')), 'run: caipira install');
  check('embedding model present', fs.existsSync(path.join(MODEL_DIR, 'onnx', 'model_quantized.onnx')));

  try {
    const { openMaster } = require('./workspace');
    openMaster().close();
    ok('workspace registry opens');
    const { totals, missing, broken } = aggregateWorkspaces();
    for (const { row, error } of broken) {
      problems++;
      fail(`workspace database ${path.basename(row.db_file)} — ${error.message}`);
    }
    ok(`${totals.workspaces} workspace database(s) open (${totals.observations} observations, ${totals.facts} facts)`);
    if (missing.length) warn(`${missing.length} registered workspace database(s) missing — re-created on next use`);
  } catch (error) {
    problems++;
    fail(`workspace registry — ${error.message}`);
  }

  const config = readJson(CLAUDE_JSON, {});
  check('MCP server registered in ~/.claude.json', Boolean(config.mcpServers?.caipira), 'run: caipira install');

  const settings = readJson(CLAUDE_SETTINGS, {});
  for (const event of HOOK_EVENTS) {
    const present = (settings.hooks?.[event] || []).some(group => (group.hooks || []).some(isCaipiraHook));
    check(`hook ${event}`, present, 'run: caipira install');
  }

  // Matches registerCodex(): a machine without Codex is fine, not broken.
  const codexConfig = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : '';
  if (!codexConfig) warn('Codex config.toml not found — Codex checks skipped');
  else {
    check('Codex free of cavemem references', !/cavemem/i.test(codexConfig), 'run: caipira install');
    check('Codex hooks point at Caipira',
      (codexConfig.match(/universal-hook\.js/g) || []).length >= CODEX_HOOKS.length * 2,
      'run: caipira install');
  }

  try {
    const { openMaster } = require('./workspace');
    const master = openMaster();
    const dangling = danglingWorkspaces(master);
    master.close();
    check('no dangling workspace registry rows', dangling.length === 0,
      `${dangling.length} row(s) whose root is gone — run: caipira prune --apply`);
  } catch (error) {
    problems++;
    fail(`workspace registry — ${error.message}`);
  }

  const antigravity = readJson(ANTIGRAVITY_MCP, {});
  check('Antigravity MCP registered', Boolean(antigravity.mcpServers?.caipira), 'run: caipira install');
  check('Antigravity hooks registered', Boolean(readJson(ANTIGRAVITY_HOOKS, {}).caipira), 'run: caipira install');

  check(`mode flag (${currentMode()})`, ['lite', 'full', 'ultra'].includes(currentMode()));

  log(problems === 0 ? '\nAll checks passed.\n' : `\n${problems} problem(s) found.\n`);
  process.exitCode = problems === 0 ? 0 : 1;
}

// ── prune ──

// Registry rows whose root directory is gone: abandoned project checkouts, and
// historically the test suites, which wrote their temp workspaces into the real
// database directory before CAIPIRA_HOME isolation existed. The legacy row has
// no root_path and is never a candidate.
function isDangling(row) {
  return Boolean(row.root_path) && !fs.existsSync(row.root_path);
}

function danglingWorkspaces(master) {
  return master.prepare('SELECT * FROM workspaces').all().filter(isDangling);
}

function prune() {
  const { openMaster, DB_DIR } = require('./workspace');
  const apply = process.argv.includes('--apply');
  const master = openMaster();
  const rows = master.prepare('SELECT * FROM workspaces').all();
  const dangling = rows.filter(isDangling);

  log('\nCaipira prune\n');
  for (const row of rows) {
    if (!isDangling(row)) ok(`keep  #${row.id} ${row.label || row.root_path}`);
  }
  if (!dangling.length) {
    log('\nNo dangling workspaces.\n');
    master.close();
    return;
  }

  let files = 0;
  const owned = new Set(rows.map(row => path.basename(row.db_file)));
  for (const row of dangling) {
    log(`  ${apply ? 'drop ' : 'would'} #${row.id} ${row.root_path} -> ${path.basename(row.db_file)}`);
    if (!apply) continue;
    // Registry row first: if this throws, the files are still there and a
    // rerun is a clean retry. The other order strands a live row pointing at
    // a database that no longer exists.
    master.transaction(() => {
      master.prepare('DELETE FROM workspace_links WHERE from_id = ? OR to_id = ?').run(row.id, row.id);
      master.prepare('DELETE FROM workspaces WHERE id = ?').run(row.id);
    })();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = row.db_file + suffix;
      if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); files++; }
    }
  }

  // A .db under database/ that no surviving row claims is an orphan too.
  for (const file of fs.readdirSync(DB_DIR)) {
    if (!/\.db$/.test(file) || file === 'master.db' || owned.has(file)) continue;
    log(`  ${apply ? 'drop ' : 'would'} unclaimed file ${file}`);
    if (!apply) continue;
    for (const suffix of ['', '-wal', '-shm']) {
      const full = path.join(DB_DIR, file + suffix);
      if (fs.existsSync(full)) { fs.rmSync(full, { force: true }); files++; }
    }
  }

  master.close();
  log(apply ? `\n${dangling.length} row(s), ${files} file(s) removed.\n` : '\nDry run — re-run with --apply to delete.\n');
}

function currentMode() {
  try { return fs.readFileSync(path.join(ROOT, 'active'), 'utf8').trim(); } catch { return 'full'; }
}

function setMode(mode) {
  if (!['lite', 'full', 'ultra'].includes(mode)) {
    fail(`unknown mode "${mode}" — use lite, full, or ultra`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(path.join(ROOT, 'active'), mode, 'utf8');
  ok(`compression mode set to ${mode}`);
}

function status() {
  const { totals, recent, missing, broken } = aggregateWorkspaces();
  log(`\nCaipira status`);
  log(`  mode:         ${currentMode()}`);
  log(`  workspaces:   ${totals.workspaces}`);
  log(`  observations: ${totals.observations}`);
  log(`  embeddings:   ${totals.embeddings}`);
  log(`  facts:        ${totals.facts}`);
  log(`  sessions:     ${totals.sessions}`);
  if (missing.length) warn(`${missing.length} registered workspace database(s) missing`);
  for (const { row, error } of broken) warn(`${path.basename(row.db_file)} unreadable — ${error.message}`);
  log(`  recent sessions:`);
  for (const session of recent) {
    log(`    ${new Date(session.started_at).toISOString()}  ${String(session.ide).padEnd(12)}  ${String(session.workspace).padEnd(20)}  ${session.id}`);
  }
  log('');
}

function install() {
  log('\nInstalling Caipira\n');
  installDependencies();
  ensureDirectories();
  registerMcpServer();
  registerHooks();
  registerCodex();
  registerAntigravity();
  registerAntigravityHooks();
  log('\nRestart Claude Code to load the MCP server and hooks.');
  log('Verify any time with: caipira doctor\n');
}

const command = process.argv[2] || 'install';
const commands = {
  install,
  uninstall: unregister,
  doctor,
  prune,
  status,
  mode: () => setMode(process.argv[3] || currentMode())
};

if (!commands[command]) {
  log(`Usage: caipira <install|uninstall|doctor|prune [--apply]|status|mode <lite|full|ultra>>`);
  process.exitCode = 1;
} else {
  commands[command]();
}
