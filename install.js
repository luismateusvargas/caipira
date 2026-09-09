#!/usr/bin/env node
// caipira/install.js — installs and wires Caipira into Claude Code.
//
// Run with the BUNDLED Node 22 runtime, never the system Node 24:
//   .\node22\node-v22.20.0-win-x64\node.exe install.js
// (caipira.cmd does this for you.)
//
// Commands: install | uninstall | status | doctor | prune [--apply] | mode <lite|full|ultra>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const HOME = os.homedir();
const NODE_BIN = path.join(ROOT, 'node22', 'node-v22.20.0-win-x64', 'node.exe');
const NPM_CLI = path.join(ROOT, 'node22', 'node-v22.20.0-win-x64', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const MCP_ENTRY = path.join(ROOT, 'mcp.js');
const HOOK_ENTRY = path.join(ROOT, 'hooks', 'universal-hook.js');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
const ANTIGRAVITY_MCP = path.join(HOME, '.gemini', 'config', 'mcp_config.json');
const MODEL_DIR = path.join(ROOT, 'models', 'Xenova', 'all-MiniLM-L6-v2');

// Claude Code hook events -> Caipira lifecycle events.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'];
const HOOK_MARKER = 'caipira';

// Codex names the same lifecycle points differently, and keys its hook trust
// state by the snake_case form rather than the TOML table name.
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
      if (/^\[/.test(line)) section = null;
    }

    out.push(line);
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
  writeJsonAtomic(CLAUDE_SETTINGS, settings);
  ok(`hooks removed: ${removed}`);
  log('\nCaipira data at ~/.caipira/data.db was left untouched.');
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
    const { MemoryStore } = require('./store');
    const store = new MemoryStore();
    const count = store.countObservations();
    store.close();
    ok(`SQLite store opens (${count} observations)`);
  } catch (error) {
    problems++;
    fail(`SQLite store — ${error.message}`);
  }

  const config = readJson(CLAUDE_JSON, {});
  check('MCP server registered in ~/.claude.json', Boolean(config.mcpServers?.caipira), 'run: caipira install');

  const settings = readJson(CLAUDE_SETTINGS, {});
  for (const event of HOOK_EVENTS) {
    const present = (settings.hooks?.[event] || []).some(group => (group.hooks || []).some(isCaipiraHook));
    check(`hook ${event}`, present, 'run: caipira install');
  }

  const codexConfig = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : '';
  check('Codex config.toml present', Boolean(codexConfig), 'Codex not installed?');
  if (codexConfig) {
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
  const { MemoryStore } = require('./store');
  const store = new MemoryStore();
  const sessions = store.listSessions(5);
  log(`\nCaipira status`);
  log(`  mode:         ${currentMode()}`);
  log(`  observations: ${store.countObservations()}`);
  log(`  embeddings:   ${store.countEmbeddings()}`);
  log(`  recent sessions:`);
  for (const session of sessions) {
    log(`    ${new Date(session.started_at).toISOString()}  ${session.ide.padEnd(12)}  ${session.id}`);
  }
  log('');
  store.close();
}

function install() {
  log('\nInstalling Caipira\n');
  installDependencies();
  ensureDirectories();
  registerMcpServer();
  registerHooks();
  registerCodex();
  registerAntigravity();
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
