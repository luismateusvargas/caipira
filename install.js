#!/usr/bin/env node
// caipira/install.js — installs and wires Caipira into detected coding clients.
//
// Every Caipira process uses the deployment's pinned Node 22; host Node starts install only:
//   Windows: .\node22\node-v22.23.4-win-x64\node.exe install.js  (caipira.cmd)
//   Linux:   ./node22/node-v22.23.4-linux-x64/bin/node install.js  (caipira.sh)
//
// Commands: install | uninstall | status | doctor | logs [--limit N] [--clear] | prune [--apply] | mode <lite|full|ultra>
//           explore [--port 4777] [--host 127.0.0.1] [--workspace <path>] [--no-open]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { logError, readErrors, DEFAULT_LOG_LIMIT } = require('./errors');
const RUNTIME = require('./runtime');

process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit();
  throw error;
});

function journal(operation, error) {
  logError({ component: 'install', operation, error });
}

const ROOT = __dirname;
const HOME = os.homedir();
const HOME_DIR = process.env.CAIPIRA_HOME ? path.resolve(process.env.CAIPIRA_HOME) : path.join(HOME, '.caipira');
const IS_WINDOWS = process.platform === 'win32';
const PATH_REGISTRY_TIMEOUT_MS = 15_000;
const PATH_BROADCAST_TIMEOUT_MS = 1_000;
const PATH_CHANGED_MARKER = 'CAIPIRA_PATH_CHANGED';
const PATH_BROADCAST_FAILED_MARKER = 'CAIPIRA_PATH_BROADCAST_FAILED';
const PATH_BLOCK_START = '# >>> caipira PATH >>>';
const PATH_BLOCK_END = '# <<< caipira PATH <<<';
const PATH_STARTUP_STATE_FILE = path.join(HOME_DIR, '.caipira-startup-files.json');
const PATH_STARTUP_RECOVERABLE_CODES = Object.freeze(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ELOOP', 'EEXIST']);
const USER_BIN_DIR = path.join(HOME, '.local', 'bin');
const USER_LAUNCHER = path.join(USER_BIN_DIR, 'caipira');
const SHELL_STARTUP_FILES = {
  bash: path.join(HOME, '.bashrc'),
  bashProfile: path.join(HOME, '.bash_profile'),
  bashLogin: path.join(HOME, '.bash_login'),
  zsh: path.join(HOME, '.zshrc'),
  profile: path.join(HOME, '.profile'),
  fish: path.join(HOME, '.config', 'fish', 'conf.d', 'caipira.fish')
};
const POSIX_PATH_COMMAND = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
const FISH_PATH_COMMAND = 'contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH';
const NODE_VERSION = RUNTIME.NODE_VERSION;
const CLIENT_SELECTION_FILE = RUNTIME.CLIENT_SELECTION_FILE;
let NODE_ARCHIVE;
let NODE_ARCHIVE_ERROR;
try { NODE_ARCHIVE = RUNTIME.selectArchive(); }
catch (error) { NODE_ARCHIVE_ERROR = error; }
const DEPLOYMENT_RUNTIME = NODE_ARCHIVE ? RUNTIME.runtimePaths(HOME_DIR, NODE_ARCHIVE) : { node: '', npm: '' };
const NODE_BIN = DEPLOYMENT_RUNTIME.node;
const NPM_CLI = DEPLOYMENT_RUNTIME.npm;
const EXPLORE_UI_DIR = path.join(ROOT, 'explore-ui');
const EXPLORE_DIST = path.join(EXPLORE_UI_DIR, 'dist');
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
const MODEL_SOURCE_DIR = path.join(ROOT, 'models', 'Xenova', 'all-MiniLM-L6-v2');
const MODEL_DIR = path.join(HOME_DIR, 'models', 'Xenova', 'all-MiniLM-L6-v2');
let AST_BINARY_SOURCE = null;

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

const CLIENTS = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
const CLIENT_NAMES = { claude: 'claude-code', codex: 'codex', antigravity: 'antigravity' };
const RISK_NOTICE = 'Configuring hooks and MCP servers for undetected clients is done under your own account and operational responsibility. Rerun with --accept-risk to confirm.';

/** @returns {{claude: boolean, codex: boolean, antigravity: boolean}} Installed client markers. */
function detectClients() {
  const directory = name => {
    try { return fs.statSync(path.join(HOME, name)).isDirectory(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  return {
    claude: directory('.claude') || fs.existsSync(CLAUDE_JSON),
    codex: directory('.codex') || fs.existsSync(CODEX_CONFIG),
    antigravity: directory('.gemini') || fs.existsSync(path.dirname(ANTIGRAVITY_MCP))
  };
}

/**
 * Validates selection and obtains consent before any install writes.
 * @param {string[]} args Install arguments.
 * @returns {Promise<object|null>} Enabled clients, or null when consent was refused.
 * @throws {Error} For unknown arguments or client names.
 */
async function selectClients(args) {
  const detected = detectClients();
  let selected = null, acceptRisk = false;
  const aliases = { claude: 'claude', 'claude-code': 'claude', codex: 'codex', agy: 'antigravity', antigravity: 'antigravity' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--accept-risk') { acceptRisk = true; continue; }
    if (args[i] !== '--clients' || selected !== null) throw new Error(`unknown or repeated install argument: ${args[i]}`);
    const list = args[++i];
    if (!list || list.startsWith('--')) throw new Error('--clients needs a comma-separated client list');
    selected = { claude: false, codex: false, antigravity: false };
    for (const raw of list.split(',')) {
      const name = raw.trim().toLowerCase();
      if (name === 'all') { for (const key of Object.keys(CLIENTS)) selected[key] = true; }
      else if (Object.hasOwn(aliases, name)) selected[aliases[name]] = true;
      else throw new Error(`unknown client: ${raw || '(empty)'}`);
    }
  }
  const enabled = selected || detected;
  if (Object.keys(CLIENTS).some(key => enabled[key] && !detected[key]) && !acceptRisk) {
    log(RISK_NOTICE);
    let agreed = false;
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const readline = require('readline');
      const input = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise(resolve => {
          input.once('close', () => resolve(''));
          input.question('Proceed? [y/N] ', resolve);
        });
        agreed = /^y(es)?$/i.test(answer.trim());
      } finally { input.close(); }
    }
    if (!agreed) { process.exitCode = 1; return null; }
  }
  for (const key of Object.keys(CLIENTS)) {
    if (!enabled[key] && !detected[key]) log(`  [skip] ${CLIENTS[key]} not detected (use --clients ${CLIENT_NAMES[key]} --accept-risk to force)`);
  }
  return enabled;
}

/**
 * Registration paths always point at the synchronized deployment.
 * @returns {{node: string, mcp: string, hook: string, models: string}} Live entry points.
 */
function runtimePaths() {
  return {
    node: NODE_BIN,
    mcp: path.join(HOME_DIR, 'mcp.js'), hook: path.join(HOME_DIR, 'hooks', 'universal-hook.js'),
    models: path.join(HOME_DIR, 'models')
  };
}

function isDevelopmentCheckout() {
  return fs.existsSync(path.join(ROOT, 'rust', 'caipira-ast', 'Cargo.toml')) && fs.existsSync(path.join(ROOT, '.git'));
}

function isNpmDistribution() {
  if (realPath(ROOT) === realPath(HOME_DIR) || isDevelopmentCheckout()) return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name === '@luismateusvargas/caipira';
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') journal('read configuration', error);
    return fallback;
  }
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
  let mode = null;
  if (fs.existsSync(file)) {
    mode = fs.statSync(file).mode & 0o777;
    fs.copyFileSync(file, `${file}.caipira-backup`);
  }
  const tmp = `${file}.caipira-tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  if (mode !== null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function hookCommand(event) {
  // Quoted so spaces in the home directory path stay intact.
  const runtime = runtimePaths();
  return `"${runtime.node}" "${runtime.hook}" --client claude-code --event ${event}`;
}

function isCaipiraHook(entry) {
  return typeof entry?.command === 'string' && entry.command.toLowerCase().includes(HOOK_MARKER);
}

// ── steps ──

function copyMissingTree(source, destination) {
  const sourceInfo = fs.statSync(source);
  if (sourceInfo.isDirectory()) {
    try {
      if (!fs.statSync(destination).isDirectory()) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyMissingTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true, force: false, errorOnExist: false });
}

function replaceDependencyDirectory(source, destination, validate) {
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.caipira-dependency-'));
  const replacement = path.join(staging, path.basename(destination));
  const backup = path.join(staging, 'previous');
  let backupMoved = false;
  let replacementPromoted = false;
  let keepRecovery = false;
  try {
    fs.cpSync(source, replacement, { recursive: true, dereference: true });
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      backupMoved = true;
    }
    fs.renameSync(replacement, destination);
    replacementPromoted = true;
    validate();
  } catch (error) {
    try {
      if (replacementPromoted) fs.rmSync(destination, { recursive: true, force: true });
      if (backupMoved) fs.renameSync(backup, destination);
    } catch (rollbackError) {
      keepRecovery = true;
      throw new Error(`dependency refresh and rollback failed; recovery files retained at ${staging}`, {
        cause: new AggregateError([error, rollbackError])
      });
    }
    throw error;
  } finally {
    if (!keepRecovery) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function installDependencies() {
  const nestedManifest = path.join(ROOT, 'runtime');
  const manifestDirectory = fs.existsSync(path.join(nestedManifest, 'package.json')) ? nestedManifest : ROOT;
  return RUNTIME.installDependencies(HOME_DIR, manifestDirectory, { paths: DEPLOYMENT_RUNTIME });
}

function installModelAssets() {
  const sourceRoot = path.join(ROOT, 'models');
  const sourceModel = path.join(MODEL_SOURCE_DIR, 'onnx', 'model_quantized.onnx');
  const deployedModel = path.join(MODEL_DIR, 'onnx', 'model_quantized.onnx');
  if (!fs.existsSync(sourceModel)) {
    warn('local ONNX model unavailable — semantic embeddings are disabled');
    return;
  }
  if (fs.existsSync(sourceRoot)) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    copyMissingTree(sourceRoot, path.join(HOME_DIR, 'models'));
  }
  if (!fs.existsSync(deployedModel)) throw new Error(`the ONNX model could not be copied to ${MODEL_DIR}`);
  ok(`local embedding model available at ${MODEL_DIR}`);
}

function verifyNativeSqlite() {
  RUNTIME.verifySqlite(HOME_DIR, DEPLOYMENT_RUNTIME);
}

function buildAstEngine() {
  const { CRATE_DIR, platformBinaryName } = require('./ast');
  const genericName = IS_WINDOWS ? 'caipira-ast.exe' : 'caipira-ast';
  const genericBinary = path.join(ROOT, 'bin', genericName);
  const platformName = platformBinaryName();
  const platformBinary = platformName ? path.join(ROOT, 'bin', platformName) : null;
  const packaged = [platformBinary, genericBinary].filter(Boolean).find(file => {
    try {
      fs.accessSync(file, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch { return false; }
  });
  if (packaged) {
    AST_BINARY_SOURCE = packaged;
    ok(`using prebuilt caipira-ast at ${packaged}`);
    return;
  }
  const manifest = path.join(CRATE_DIR, 'Cargo.toml');
  if (!fs.existsSync(manifest)) {
    journal('build AST', new Error('rust/caipira-ast not found'));
    warn(`prebuilt caipira-ast is missing for ${process.platform}-${process.arch} — AST symbol index unavailable`);
    return;
  }
  if (!isDevelopmentCheckout()) {
    warn('caipira-ast build skipped — cargo builds are limited to development checkouts');
    return;
  }
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' });
  } catch (error) {
    journal('find cargo', error);
    warn('cargo not found — install Rust (https://rustup.rs) and re-run install to enable the AST symbol index');
    return;
  }
  log('  building caipira-ast (cargo build --release)...');
  try {
    execFileSync('cargo', ['build', '--release', '--manifest-path', manifest], { cwd: ROOT, stdio: 'inherit' });
  } catch (error) {
    journal('build AST', error);
    warn(`caipira-ast build failed — ${error.message}`);
    return;
  }
  AST_BINARY_SOURCE = path.join(CRATE_DIR, 'target', 'release', genericName);
  if (!fs.existsSync(AST_BINARY_SOURCE)) throw new Error(`cargo build completed without creating ${AST_BINARY_SOURCE}`);
  ok(`built caipira-ast at ${AST_BINARY_SOURCE}`);
}

// The explorer UI is optional like the AST engine: when its first npm
// install has no network, or the build fails, `caipira explore` still serves
// the API and says the UI is missing.
function buildExploreUi() {
  if (fs.existsSync(path.join(EXPLORE_DIST, 'index.html'))) {
    ok(`using prebuilt explore UI at ${EXPLORE_DIST}`);
    return;
  }
  if (isNpmDistribution()) warn('prebuilt explore-ui/dist/index.html is missing — caipira explore will serve the API only');
  if (!fs.existsSync(path.join(EXPLORE_UI_DIR, 'package.json'))) {
    journal('build explore UI', new Error('explore-ui not found'));
    warn('explore-ui not found — caipira explore will serve the API only');
    return;
  }
  // npm scripts resolve `node` from PATH; put the bundled runtime first.
  const env = { ...process.env, PATH: `${path.dirname(NODE_BIN)}${path.delimiter}${process.env.PATH || ''}` };
  try {
    if (!fs.existsSync(path.join(EXPLORE_UI_DIR, 'node_modules', 'vite', 'package.json'))) {
      log('  installing explore-ui dependencies with bundled Node 22...');
      execFileSync(NODE_BIN, [NPM_CLI, 'ci', '--no-audit', '--no-fund'], { cwd: EXPLORE_UI_DIR, stdio: 'inherit', env });
    }
    log('  building explore-ui (vite build)...');
    execFileSync(NODE_BIN, [NPM_CLI, 'run', 'build'], { cwd: EXPLORE_UI_DIR, stdio: 'inherit', env });
  } catch (error) {
    journal('build explore UI', error);
    warn(`explore-ui build failed — ${error.message}`);
    return;
  }
  ok(`explore UI built at ${EXPLORE_DIST}`);
}

function realPath(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

// Stage the complete set before replacing any live file. Each file is promoted
// by rename; directory swaps and failed promotions restore the previous set.
function deployRuntime() {
  const sameRoot = realPath(HOME_DIR) === realPath(ROOT);
  const binary = `bin/caipira-ast${IS_WINDOWS ? '.exe' : ''}`;
  if (sameRoot) {
    if (AST_BINARY_SOURCE && path.resolve(AST_BINARY_SOURCE) !== path.join(ROOT, binary)) {
      fs.mkdirSync(path.dirname(path.join(ROOT, binary)), { recursive: true });
      const tmp = `${path.join(ROOT, binary)}.caipira-tmp-${process.pid}`;
      fs.copyFileSync(AST_BINARY_SOURCE, tmp);
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, path.join(ROOT, binary));
    }
    return;
  }
  const files = ['mcp.js', 'store.js', 'facts.js', 'inject.js', 'ast.js', 'runtime.js', 'workspace.js',
    'migrate.js', 'compress.js', 'errors.js', 'explore-server.js', 'hooks/universal-hook.js',
    'install.js', 'bin/caipira-cli.js', 'caipira.sh', 'caipira.cmd', 'runtime/package.json', 'runtime/package-lock.json']
    .map(rel => ({ source: path.join(ROOT, rel), rel }));
  const ui = 'explore-ui/dist';
  if (fs.existsSync(path.join(ROOT, ui, 'index.html'))) files.push({ source: path.join(ROOT, ui), rel: ui });
  else warn(`${ui}/index.html unavailable in checkout — existing deployed asset kept`);
  if (AST_BINARY_SOURCE) files.push({ source: AST_BINARY_SOURCE, rel: binary });
  else if (fs.existsSync(path.join(ROOT, binary))) files.push({ source: path.join(ROOT, binary), rel: binary });
  else warn(`${binary} unavailable in checkout — existing deployed asset kept`);
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const staging = fs.mkdtempSync(path.join(HOME_DIR, '.runtime-'));
  const promoted = [];
  const movedDirectories = [];
  let keepRecovery = false;
  try {
    for (const { source, rel } of files) {
      const live = path.join(HOME_DIR, rel), staged = path.join(staging, 'new', rel);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.cpSync(source, staged, { recursive: true, dereference: true });
      if (rel === binary || rel === 'bin/caipira-cli.js') fs.chmodSync(staged, 0o755);
      if (fs.existsSync(live)) {
        const backup = path.join(staging, 'old', rel);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.cpSync(live, backup, { recursive: true, dereference: true });
      }
    }
    fs.chmodSync(path.join(staging, 'new', 'caipira.sh'), 0o755);
    for (const { rel } of files) {
      const live = path.join(HOME_DIR, rel);
      fs.mkdirSync(path.dirname(live), { recursive: true });
      if (fs.existsSync(live) && fs.statSync(live).isDirectory()) {
        const previous = path.join(staging, 'previous', rel);
        fs.mkdirSync(path.dirname(previous), { recursive: true });
        fs.renameSync(live, previous);
        movedDirectories.push(rel);
      }
      fs.renameSync(path.join(staging, 'new', rel), live);
      promoted.push(rel);
    }
  } catch (error) {
    try {
      for (const rel of new Set([...promoted, ...movedDirectories].reverse())) {
        const live = path.join(HOME_DIR, rel), backup = path.join(staging, 'old', rel);
        const previous = path.join(staging, 'previous', rel);
        if (fs.existsSync(previous)) {
          fs.rmSync(live, { recursive: true, force: true });
          fs.renameSync(previous, live);
        } else if (fs.existsSync(backup)) fs.renameSync(backup, live);
        else fs.rmSync(live, { recursive: true, force: true });
      }
    } catch (rollbackError) {
      keepRecovery = true;
      throw new Error(`runtime sync and rollback failed; recovery files retained at ${staging}`, {
        cause: new AggregateError([error, rollbackError])
      });
    }
    throw new Error(`runtime could not be synchronized to ${HOME_DIR}`, { cause: error });
  } finally {
    if (!keepRecovery) fs.rmSync(staging, { recursive: true, force: true });
  }
  ok(`complete runtime synchronized to ${HOME_DIR}`);
}

/**
 * Updates only the deployment entry and announces a successful registry write.
 * @param {boolean} remove Whether to remove rather than append the entry.
 * @returns {boolean} Whether the registry changed.
 */
function updateWindowsPath(remove) {
  const script = [
      "$ErrorActionPreference = 'Stop'",
      "$remove = $env:CAIPIRA_PATH_ACTION -eq 'remove'",
      "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
      "if ($null -eq $key) { if ($remove) { return }; $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
      'try {',
      "  $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
      '  $target = $env:CAIPIRA_PATH_TARGET',
      "  $parts = @($current -split ';')",
      '  if ($remove) {',
      "    $kept = @($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ine $target.TrimEnd('\\') })",
      '    $changed = $kept.Count -ne $parts.Count',
      "    $updated = $kept -join ';'",
      '  } else {',
      "    $present = @($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $target.TrimEnd('\\') }).Count -gt 0",
      '    $changed = -not $present',
      "    $updated = ($current.TrimEnd(';') + ';' + $target).TrimStart(';')",
      '  }',
      '  if ($changed) {',
      "    $key.SetValue('Path', $updated, [Microsoft.Win32.RegistryValueKind]::ExpandString)",
      `    Write-Output '${PATH_CHANGED_MARKER}'`,
      '    try {',
      "      Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class CaipiraEnvironment {',
      '  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]',
      '  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);',
      '}',
      "'@",
      '      $HWND_BROADCAST = [IntPtr]0xFFFF',
      '      $WM_SETTINGCHANGE = [uint32]0x1A',
      '      $SMTO_ABORTIFHUNG = [uint32]0x0002',
      '      $result = [UIntPtr]::Zero',
      "      $sent = [CaipiraEnvironment]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment', $SMTO_ABORTIFHUNG, [uint32]$env:CAIPIRA_PATH_BROADCAST_TIMEOUT_MS, [ref]$result)",
      "      if ($sent -eq [IntPtr]::Zero) { throw 'Environment broadcast failed or timed out' }",
      `    } catch { Write-Output '${PATH_BROADCAST_FAILED_MARKER}' }`,
      '  }',
      '} finally { $key.Close() }'
  ].join('\n');
  let output;
  try {
    output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, CAIPIRA_PATH_TARGET: HOME_DIR, CAIPIRA_PATH_ACTION: remove ? 'remove' : 'add',
        CAIPIRA_PATH_BROADCAST_TIMEOUT_MS: String(PATH_BROADCAST_TIMEOUT_MS) },
      encoding: 'utf8', stdio: 'pipe', timeout: PATH_REGISTRY_TIMEOUT_MS, windowsHide: true
    });
  } catch (error) {
    // HWND_BROADCAST's timeout applies per window. Keep a completed write if
    // the outer subprocess deadline interrupts a slow broadcast or Add-Type.
    if (!String(error.stdout || '').includes(PATH_CHANGED_MARKER)) throw error;
    output = `${PATH_CHANGED_MARKER}\n${PATH_BROADCAST_FAILED_MARKER}`;
  }
  if (String(output || '').includes(PATH_BROADCAST_FAILED_MARKER)) {
    warn('User PATH updated, but the environment broadcast failed; signing out completes the change.');
  }
  return String(output || '').includes(PATH_CHANGED_MARKER);
}

/** @returns {string[]} Startup files for the shell that will open next. */
function shellStartupFiles() {
  switch (path.basename(process.env.SHELL || '')) {
    case 'bash': {
      if (process.platform !== 'darwin') return [SHELL_STARTUP_FILES.bash];
      const login = [SHELL_STARTUP_FILES.bashProfile, SHELL_STARTUP_FILES.bashLogin, SHELL_STARTUP_FILES.profile]
        .find(file => fs.existsSync(file)) || SHELL_STARTUP_FILES.bashProfile;
      return [SHELL_STARTUP_FILES.bash, login];
    }
    case 'zsh': return [SHELL_STARTUP_FILES.zsh];
    case 'fish': return [SHELL_STARTUP_FILES.fish];
    default: return [SHELL_STARTUP_FILES.profile];
  }
}

/** @param {string} file Startup path. @returns {string|null} Contents or null if absent. */
function readStartupFile(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** @param {string} file Startup path. @returns {boolean} Whether its directory entry exists. */
function startupEntryExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** @returns {string[]|null} Saved paths, or null when state cannot be read safely. */
function readOwnedStartupFiles() {
  try {
    const saved = JSON.parse(fs.readFileSync(PATH_STARTUP_STATE_FILE, 'utf8'));
    if (!Array.isArray(saved)) return null;
    const candidates = Object.values(SHELL_STARTUP_FILES);
    return [...new Set(saved.filter(file => typeof file === 'string' && candidates.includes(file)))];
  // Unreadable or malformed ownership state must never authorize file deletion.
  } catch (error) { return error.code === 'ENOENT' ? [] : null; }
}

/** @param {string[]} files Paths of startup files still owned by the installation. */
function writeOwnedStartupFiles(files) {
  const candidates = Object.values(SHELL_STARTUP_FILES);
  const unique = [...new Set(files.filter(file => candidates.includes(file)))].sort();
  if (unique.length) {
    writeJsonAtomic(PATH_STARTUP_STATE_FILE, unique);
    return;
  }
  fs.rmSync(PATH_STARTUP_STATE_FILE, { force: true });
  fs.rmSync(`${PATH_STARTUP_STATE_FILE}.caipira-backup`, { force: true });
  fs.rmSync(`${PATH_STARTUP_STATE_FILE}.caipira-tmp`, { force: true });
}

/**
 * Replaces the resolved startup target, keeping dotfiles symlinks and home-side backups.
 * @param {string} file Startup path under HOME.
 * @param {string} text Replacement contents; empty removes a regular startup file.
 * @param {boolean} [removeEmpty=true] Whether an empty regular target may be removed.
 * @returns {void}
 * @throws {Error} For filesystem failures; callers recover from permission errors.
 */
function writeStartupFile(file, text, removeEmpty = true) {
  let entry = null;
  try { entry = fs.lstatSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const linked = entry?.isSymbolicLink();
  const target = linked ? fs.realpathSync(file) : file;
  const mode = entry ? fs.statSync(target).mode & 0o777 : null;
  // A writable directory alone would permit rename over a read-only file.
  // Honor target permissions as well, including managed dotfiles stores.
  if (entry) fs.accessSync(target, fs.constants.W_OK);
  // Keep an empty linked target rather than leaving a managed link dangling.
  if (text === '' && removeEmpty && !linked) { fs.unlinkSync(target); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.caipira-tmp`;
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
  try {
    try { fs.writeFileSync(fd, text, 'utf8'); }
    finally { fs.closeSync(fd); }
    if (mode !== null) fs.chmodSync(tmp, mode);
    if (entry) fs.copyFileSync(target, `${file}.caipira-backup`);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Installs the user launcher without changing the caller's working directory. */
function registerPath() {
  if (IS_WINDOWS) {
    updateWindowsPath(false);
    ok(`User PATH includes ${HOME_DIR} (open a new terminal)`);
    return;
  }
  const quoted = `'${path.join(HOME_DIR, 'caipira.sh').replace(/'/g, `'\\''`)}'`;
  fs.mkdirSync(USER_BIN_DIR, { recursive: true });
  const tmp = `${USER_LAUNCHER}.caipira-tmp`;
  try {
    fs.writeFileSync(tmp, `#!/bin/sh\nexec ${quoted} "$@"\n`, 'utf8');
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, USER_LAUNCHER);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  ok(`launcher installed at ${USER_LAUNCHER}`);
  if ((process.env.PATH || '').split(path.delimiter).some(entry => entry && path.resolve(entry) === USER_BIN_DIR)) return;
  const ownedStartupFiles = new Set(readOwnedStartupFiles() || []);
  for (const file of shellStartupFiles()) {
    try {
      const original = readStartupFile(file) || '';
      if (!original.includes(PATH_BLOCK_START)) {
        const command = file === SHELL_STARTUP_FILES.fish ? FISH_PATH_COMMAND : POSIX_PATH_COMMAND;
        const block = `${PATH_BLOCK_START}\n${command}\n${PATH_BLOCK_END}\n`;
        // Prepend when the original lacks a final newline: removal can then
        // restore every original byte without inventing a separator newline.
        const updated = original && !original.endsWith('\n') ? block + original : original + block;
        const addedOwnership = !startupEntryExists(file) && !ownedStartupFiles.has(file);
        if (addedOwnership) {
          ownedStartupFiles.add(file);
          writeOwnedStartupFiles([...ownedStartupFiles]);
        }
        try { writeStartupFile(file, updated); }
        catch (error) {
          if (addedOwnership) {
            ownedStartupFiles.delete(file);
            try { writeOwnedStartupFiles([...ownedStartupFiles]); }
            catch (rollbackError) { journal('restore PATH ownership', rollbackError); }
          }
          throw error;
        }
      }
      ok(`PATH configured in ${file} — open a new terminal`);
    } catch (error) {
      if (!PATH_STARTUP_RECOVERABLE_CODES.includes(error.code)) throw error;
      warn(`Cannot configure PATH in ${file} (${error.code}); add manually: export PATH="$HOME/.local/bin:$PATH"`);
    }
  }
}

/** Removes owned startup ranges or the Windows deployment entry, leaving other content intact. */
function unregisterPath() {
  if (IS_WINDOWS) {
    if (updateWindowsPath(true)) ok(`User PATH entry removed: ${HOME_DIR}`);
    return;
  }
  const savedStartupFiles = readOwnedStartupFiles();
  const ownedStartupFiles = new Set(savedStartupFiles || []);
  for (const file of Object.values(SHELL_STARTUP_FILES)) {
    try {
      const original = readStartupFile(file);
      if (original === null) {
        forgetOwnedStartupFile(file, ownedStartupFiles);
        continue;
      }
      let updated = original, from = 0;
      while ((from = updated.indexOf(PATH_BLOCK_START, from)) !== -1) {
        const end = updated.indexOf(PATH_BLOCK_END, from + PATH_BLOCK_START.length);
        if (end === -1) break;
        let after = end + PATH_BLOCK_END.length;
        if (updated.slice(after, after + 2) === '\r\n') after += 2;
        else if (updated[after] === '\n') after++;
        updated = updated.slice(0, from) + updated.slice(after);
      }
      if (updated !== original) {
        const removeEmpty = ownedStartupFiles.has(file) || file === SHELL_STARTUP_FILES.fish;
        writeStartupFile(file, updated, removeEmpty);
        ok(`PATH block removed from ${file}`);
      }
      forgetOwnedStartupFile(file, ownedStartupFiles);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (!PATH_STARTUP_RECOVERABLE_CODES.includes(error.code)) throw error;
      warn(`Cannot remove PATH block from ${file} (${error.code}); continuing uninstall`);
    }
  }
  if (savedStartupFiles !== null && ownedStartupFiles.size === 0) writeOwnedStartupFiles([]);
}

/** Drops a processed startup path from install's ownership state. */
function forgetOwnedStartupFile(file, ownedStartupFiles) {
  if (!ownedStartupFiles.has(file)) return;
  const remaining = [...ownedStartupFiles].filter(candidate => candidate !== file);
  writeOwnedStartupFiles(remaining);
  ownedStartupFiles.delete(file);
}

function ensureDirectories() {
  for (const dir of ['logs']) {
    fs.mkdirSync(path.join(HOME_DIR, dir), { recursive: true });
  }
  ok('runtime directories ready');
}

function registerMcpServer(options) {
  if (!options.claude) return;
  const runtime = runtimePaths();
  const config = readJson(CLAUDE_JSON, {});
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.caipira = {
    type: 'stdio',
    command: runtime.node,
    args: [runtime.mcp],
    env: { CAIPIRA_MODEL_PATH: runtime.models }
  };
  writeJsonAtomic(CLAUDE_JSON, config);
  ok('MCP server "caipira" registered (user scope)');
}

function registerHooks(options) {
  if (!options.claude) return;
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
function registerCodex(options) {
  if (!options.codex) return;
  const runtime = runtimePaths();
  // Remove only our own old handlers; user-owned hooks retain their commands.
  const original = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : '';
  const stripped = stripCodexConfig(original).text;
  const out = stripped.split(/\r?\n/);

  // Forward slashes work on both platforms; JSON quoting is also TOML basic
  // string quoting and safely handles apostrophes in user directory names.
  const codexCommand = lifecycle => {
    const node = runtime.node.replace(/\\/g, '/');
    const entry = runtime.hook.replace(/\\/g, '/');
    return `"${node}" "${entry}" --client codex --event ${lifecycle}`;
  };

  // Append our own tables after preserving every unrelated table verbatim.
  let appended = '';
  if (!out.some(line => /^\[mcp_servers\.caipira\]/.test(line))) {
    appended += `\n[mcp_servers.caipira]\ncommand = ${JSON.stringify(runtime.node)}\nargs = [${JSON.stringify(runtime.mcp)}]\n`
      + `env = { CAIPIRA_MODEL_PATH = ${JSON.stringify(runtime.models)} }\n`;
  }
  for (const [toml, , lifecycle] of CODEX_HOOKS) {
    appended += `\n[[hooks.${toml}]]\n[[hooks.${toml}.hooks]]\ntype = "command"\n`
      + `command = ${JSON.stringify(codexCommand(lifecycle))}\n`
      + `command_windows = ${JSON.stringify(codexCommand(lifecycle))}\ntimeout = ${codexTimeout(lifecycle)}\n`;
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
  ok('Codex MCP server and hooks registered; old Caipira trust hashes cleared');
  warn('Codex will ask to re-trust its hooks on next launch');
}

function registerAntigravity(options) {
  if (!options.antigravity) return;
  const runtime = runtimePaths();
  const config = readJson(ANTIGRAVITY_MCP, {});
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.caipira = {
    command: runtime.node,
    args: [runtime.mcp],
    env: { CAIPIRA_MODEL_PATH: runtime.models }
  };
  writeJsonAtomic(ANTIGRAVITY_MCP, config);
  ok('MCP server "caipira" registered for Antigravity');
}

// hooks.json is keyed by hook name, so Caipira owns the "caipira" entry
// outright and rewriting it never touches anyone else's hooks.
function registerAntigravityHooks(options) {
  if (!options.antigravity) return;
  const runtime = runtimePaths();
  const config = readJson(ANTIGRAVITY_HOOKS, {});
  const spec = {};
  for (const [event, lifecycle, grouped] of ANTIGRAVITY_EVENTS) {
    const handler = {
      type: 'command',
      command: `"${runtime.node}" "${runtime.hook}" --client antigravity --event ${lifecycle}`,
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
  if (!fs.existsSync(CODEX_CONFIG)) return;
  const original = fs.readFileSync(CODEX_CONFIG, 'utf8');
  const { text, removed } = stripCodexConfig(original);
  if (removed === 0) return;
  writeTextAtomic(CODEX_CONFIG, text);
  ok(`Codex entries removed: ${removed}`);
}

function unregisterAntigravity() {
  const mcp = readJson(ANTIGRAVITY_MCP, null);
  if (mcp?.mcpServers?.caipira) {
    delete mcp.mcpServers.caipira;
    writeJsonAtomic(ANTIGRAVITY_MCP, mcp);
    ok('Antigravity MCP server unregistered');
  }

  const hooks = readJson(ANTIGRAVITY_HOOKS, null);
  if (hooks?.caipira) {
    delete hooks.caipira;
    writeJsonAtomic(ANTIGRAVITY_HOOKS, hooks);
    ok('Antigravity hooks removed');
  }
}

function unregister() {
  const config = readJson(CLAUDE_JSON, {});
  if (config.mcpServers?.caipira) {
    delete config.mcpServers.caipira;
    writeJsonAtomic(CLAUDE_JSON, config);
    ok('MCP server unregistered');
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
  unregisterPath();
  fs.rmSync(path.join(HOME_DIR, CLIENT_SELECTION_FILE), { force: true });

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

  check(`bundled Node ${NODE_VERSION} at ${NODE_BIN}`, RUNTIME.runtimeWorks(NODE_BIN), 'run: caipira install');
  try {
    RUNTIME.verifySqlite(HOME_DIR, DEPLOYMENT_RUNTIME);
    ok('native SQLite opens an in-memory database');
  } catch (error) {
    problems++;
    fail(`runtime SQLite validation — ${error.message}; run: caipira install`);
  }
  check('dependencies installed', fs.existsSync(path.join(HOME_DIR, 'node_modules', 'better-sqlite3')), 'run: caipira install');
  check('embedding model present', fs.existsSync(path.join(MODEL_DIR, 'onnx', 'model_quantized.onnx')));
  try {
    ok(`AST engine at ${require('./ast').resolveBinary()}`);
  } catch (error) {
    warn('caipira-ast not built — AST symbol index unavailable (run: caipira install with cargo on PATH)');
  }
  if (fs.existsSync(path.join(EXPLORE_DIST, 'index.html'))) ok(`explore UI at ${EXPLORE_DIST}`);
  else warn('explore UI not built — caipira explore serves the API only (run: caipira install)');

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

  const recorded = readJson(path.join(HOME_DIR, CLIENT_SELECTION_FILE), null);
  const detected = recorded && Array.isArray(recorded.clients)
    ? Object.fromEntries(Object.keys(CLIENTS).map(key => [key, recorded.clients.includes(key)]))
    : detectClients();
  if (!detected.claude) {
    if (recorded) log('  [skip] Claude Code not selected for this install');
    else warn('Claude Code not detected — checks skipped');
  }
  else {
    const config = readJson(CLAUDE_JSON, {});
    check('Claude Code MCP server registered in ~/.claude.json', Boolean(config.mcpServers?.caipira), 'run: caipira install');
    const settings = readJson(CLAUDE_SETTINGS, {});
    for (const event of HOOK_EVENTS) {
      const present = (settings.hooks?.[event] || []).some(group => (group.hooks || []).some(isCaipiraHook));
      check(`Claude Code hook ${event}`, present, 'run: caipira install');
    }
  }

  // Matches registerCodex(): a machine without Codex is fine, not broken.
  const codexConfig = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : '';
  if (!detected.codex) {
    if (recorded) log('  [skip] Codex not selected for this install');
    else warn('Codex not detected — checks skipped');
  }
  else {
    check('Codex MCP server registered', /^\[mcp_servers\.caipira\]/m.test(codexConfig), 'run: caipira install');
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

  if (!detected.antigravity) {
    if (recorded) log('  [skip] Antigravity not selected for this install');
    else warn('Antigravity not detected — checks skipped');
  }
  else {
    const antigravity = readJson(ANTIGRAVITY_MCP, {});
    check('Antigravity MCP registered', Boolean(antigravity.mcpServers?.caipira), 'run: caipira install');
    check('Antigravity hooks registered', Boolean(readJson(ANTIGRAVITY_HOOKS, {}).caipira), 'run: caipira install');
  }

  check(`mode flag (${currentMode()})`, ['lite', 'full', 'ultra'].includes(currentMode()));

  const errors = readErrors({ limit: Number.MAX_SAFE_INTEGER }).length;
  if (errors) warn(`${errors} recent logged error(s) — run: caipira logs`);
  else ok('0 recent logged errors');

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
  log(`\nCaipira status`);
  let aggregate;
  try { aggregate = aggregateWorkspaces(); }
  catch (error) { journal('status', error); throw error; }
  finally { log(`  recent errors: ${readErrors({ limit: Number.MAX_SAFE_INTEGER }).length} (caipira logs)`); }
  const { totals, recent, missing, broken } = aggregate;
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

/** Prints the retained error journal, or clears both journal generations.
 * @returns {void}
 * @throws {Error} For invalid flags or an unreadable journal.
 */
function logs() {
  let limit = DEFAULT_LOG_LIMIT;
  let clear = false;
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--clear') clear = true;
    else if (args[i] === '--limit') {
      const raw = args[++i];
      if (!/^\d+$/.test(raw || '') || !Number.isSafeInteger(Number(raw))) throw new Error('--limit needs a non-negative integer');
      limit = Number(raw);
    } else throw new Error(`unknown logs argument: ${args[i]}`);
  }
  const entries = readErrors({ limit, clear });
  if (clear) { log('Error journal cleared.'); return; }
  if (!entries.length) { log('No logged errors.'); return; }
  // Stored records may contain line breaks in stacks; keep CLI fields on one line.
  const line = value => String(value ?? '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
  for (const entry of entries) {
    log(`${line(entry.ts)} [${line(entry.component)}/${line(entry.operation)}] ${line(entry.error.code || entry.error.name)}: ${line(entry.error.message)}`);
    log(`  Reproduce: ${line(entry.repro)}`);
  }
}

async function install() {
  let archive;
  try { archive = RUNTIME.selectArchive(); }
  catch (error) {
    fail(error.message);
    process.exitCode = 1;
    return;
  }
  const options = await selectClients(process.argv.slice(3));
  if (!options) return;
  log('\nInstalling Caipira\n');

  let deployedRuntime;
  try { deployedRuntime = await RUNTIME.provisionRuntime(HOME_DIR, archive); }
  catch (error) {
    fail(`Node ${NODE_VERSION} provisioning — ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (realPath(process.execPath) !== realPath(deployedRuntime.node)) {
    if (process.env.CAIPIRA_REEXEC_GUARD === '1') {
      fail(`recursive re-exec loop detected: ${process.execPath} !== ${deployedRuntime.node}`);
      process.exitCode = 1;
      return;
    }
    const args = [path.join(ROOT, 'install.js'), ...process.argv.slice(2)];
    const result = require('child_process').spawnSync(deployedRuntime.node, args, {
      env: { ...process.env, CAIPIRA_REEXEC_GUARD: '1' },
      stdio: 'inherit', timeout: RUNTIME.DEPENDENCY_TIMEOUT_MS + RUNTIME.DOWNLOAD_TIMEOUT_MS + RUNTIME.EXTRACT_TIMEOUT_MS + 300_000, windowsHide: true
    });
    if (result.error) fail(`could not restart installer with bundled Node ${NODE_VERSION}: ${result.error.message}`);
    process.exitCode = typeof result.status === 'number' ? result.status : 1;
    return;
  }

  installDependencies();
  verifyNativeSqlite();
  installModelAssets();
  buildAstEngine();
  buildExploreUi();
  deployRuntime();
  writeJsonAtomic(path.join(HOME_DIR, CLIENT_SELECTION_FILE), { clients: Object.keys(CLIENTS).filter(key => options[key]) });
  ensureDirectories();
  registerPath();
  registerMcpServer(options);
  registerHooks(options);
  registerCodex(options);
  registerAntigravity(options);
  registerAntigravityHooks(options);
  RUNTIME.removeSupersededRuntimes(HOME_DIR, warn);
  log('\nRestart the configured clients to load the MCP server and hooks.');
  log('Verify any time with: caipira doctor\n');
}

const command = process.argv[2] || 'install';
const commands = {
  install,
  uninstall: unregister,
  doctor,
  prune,
  status,
  logs,
  mode: () => setMode(process.argv[3] || currentMode()),
  // caipira.sh starts explore-server.js directly; this serves caipira.cmd.
  explore: () => require('./explore-server').main(process.argv.slice(3)).catch(error => {
    logError({ component: 'explore', operation: 'startup', error });
    fail(`caipira explore — ${error.message}`);
    process.exitCode = 1;
  })
};

if (NODE_ARCHIVE_ERROR) {
  process.stderr.write(`[FAIL] ${NODE_ARCHIVE_ERROR.message}\n`);
  process.exitCode = 1;
} else if (!commands[command]) {
  log(`Usage: caipira <install [--clients <list>] [--accept-risk]|uninstall|doctor|prune [--apply]|status|logs [--limit N] [--clear]|mode <lite|full|ultra>|explore [--port 4777] [--host 127.0.0.1] [--workspace <path>] [--no-open]>`);
  process.exitCode = 1;
} else {
  Promise.resolve().then(() => commands[command]()).catch(error => {
    journal(command, error);
    fail(`${command} — ${error.message}`);
    process.exitCode = 1;
  });
}
