// Drives install.js against a fake home directory, so uninstall, status and
// doctor run on real config files without touching the user's own.
//
// Counts are asserted exactly, so this suite always takes a CAIPIRA_HOME of
// its own rather than the one run-all.js shares between suites.
delete process.env.CAIPIRA_HOME;
require('./fixtures').ensureIsolatedHome();
const { spawnSync, spawn } = require('child_process');
const vm = require('vm');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const IS_WINDOWS = process.platform === 'win32';
const { ensureWorkspace, openWorkspaceDb, machineId } = require(ROOT + '/workspace.js');
const { MemoryStore } = require(ROOT + '/store.js');
const { FactStore } = require(ROOT + '/facts.js');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'caipira-fakehome-'));
const scratch = [HOME];
process.on('exit', () => {
  for (const dir of scratch) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' -> ' + extra : '')); }
};

function caipira(...args) {
  const r = spawnSync(NODE, [path.join(ROOT, 'install.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME }
  });
  return { code: r.error ? null : r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error || ''}` };
}

const file = rel => path.join(HOME, rel);
const writeFile = (rel, text) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), text);
};
const readJson = rel => JSON.parse(fs.readFileSync(file(rel), 'utf8'));

const HOOK = '"/opt/node" "/opt/caipira/hooks/universal-hook.js"';

console.log('\n1. uninstall removes Caipira from every client and nothing else');
writeFile('.claude.json', JSON.stringify({
  theme: 'dark',
  mcpServers: { caipira: { command: '/opt/node', args: ['/opt/caipira/mcp.js'] }, other: { command: 'other' } }
}));
writeFile('.claude/settings.json', JSON.stringify({
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: `${HOOK} --client claude-code --event SessionStart` }] },
      { hooks: [{ type: 'command', command: 'echo mine' }] }
    ]
  }
}));
writeFile('.codex/config.toml', [
  'model = "gpt-5"',
  '',
  '[mcp_servers.caipira]',
  "command = '/opt/node'",
  "args = ['/opt/caipira/mcp.js']",
  '',
  '[mcp_servers.caipira.tools.search]',
  'approval_mode = "approve"',
  '',
  '[mcp_servers.other]',
  "command = 'other'",
  '',
  '[[hooks.SessionStart]]',
  '[[hooks.SessionStart.hooks]]',
  'type = "command"',
  `command = '${HOOK} --client codex --event session-start'`,
  'timeout = 15',
  '',
  '[[hooks.Stop]]',
  '[[hooks.Stop.hooks]]',
  'type = "command"',
  "command = 'echo user-stop-hook'",
  '',
  '[[hooks.Stop.hooks]]',
  'type = "command"',
  `command = '${HOOK} --client codex --event stop'`,
  '',
  '[hooks.state]',
  '',
  '[hooks.state."/home/u/.codex/config.toml:session_start:0:0"]',
  'trusted_hash = "abc"',
  '',
  '[projects."/home/u/proj"]',
  'trust_level = "trusted"',
  ''
].join('\n'));
writeFile('.gemini/config/mcp_config.json', JSON.stringify({
  mcpServers: { caipira: { command: '/opt/node' }, other: { command: 'other' } }
}));
writeFile('.gemini/config/hooks.json', JSON.stringify({
  caipira: { Stop: [{ type: 'command', command: `${HOOK} --client antigravity --event stop` }] },
  mine: { Stop: [{ type: 'command', command: 'echo mine' }] }
}));

let r = caipira('uninstall');
check('uninstall exits 0', r.code === 0, r.out);

const claude = readJson('.claude.json');
check('Claude MCP entry removed, others kept', !claude.mcpServers.caipira && Boolean(claude.mcpServers.other) && claude.theme === 'dark',
  JSON.stringify(claude));
const settings = readJson('.claude/settings.json');
check('Claude hooks removed, user hook kept',
  JSON.stringify(settings.hooks.SessionStart) === JSON.stringify([{ hooks: [{ type: 'command', command: 'echo mine' }] }]),
  JSON.stringify(settings.hooks));

const codex = fs.readFileSync(file('.codex/config.toml'), 'utf8');
check('Codex MCP tables removed', !codex.includes('[mcp_servers.caipira'), codex);
check('Codex Caipira hooks removed', !codex.includes('universal-hook.js') && !codex.includes('[[hooks.SessionStart]]'), codex);
check('Codex trust state for removed hooks dropped', !codex.includes(':session_start:'), codex);
check('Codex user hook kept with its table', codex.includes('[[hooks.Stop]]') && codex.includes("command = 'echo user-stop-hook'"), codex);
check('rest of Codex config untouched',
  codex.startsWith('model = "gpt-5"\n') && codex.includes('[mcp_servers.other]') && codex.includes('[projects."/home/u/proj"]\ntrust_level = "trusted"'),
  codex);

const agyMcp = readJson('.gemini/config/mcp_config.json');
check('Antigravity MCP entry removed, others kept', !agyMcp.mcpServers.caipira && Boolean(agyMcp.mcpServers.other), JSON.stringify(agyMcp));
const agyHooks = readJson('.gemini/config/hooks.json');
check('Antigravity hooks removed, others kept', !agyHooks.caipira && Boolean(agyHooks.mine), JSON.stringify(agyHooks));

const before = fs.readFileSync(file('.codex/config.toml'), 'utf8');
r = caipira('uninstall');
check('a second uninstall is a clean no-op', r.code === 0 && fs.readFileSync(file('.codex/config.toml'), 'utf8') === before, r.out);

console.log('\n2. status aggregates every registered workspace');
for (const [name, observations] of [['alpha', 2], ['beta', 1]]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `caipira-status-${name}-`));
  scratch.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const workspace = ensureWorkspace(dir);
  const store = new MemoryStore({ dbPath: workspace.dbFile });
  store.startSession({ id: `status-${name}`, ide: 'test', cwd: dir });
  for (let i = 0; i < observations; i++) {
    store.addObservation({ session_id: `status-${name}`, kind: 'note', content: `status probe ${name} ${i}` });
  }
  store.close();
  const db = openWorkspaceDb(workspace.dbFile);
  try {
    new FactStore(db, { machine: machineId(), agent: 'test' }).record({ kind: 'decision', title: `status ${name}`, body: 'counted by status' });
  } finally {
    db.close();
  }
}

r = caipira('status');
const count = label => (r.out.match(new RegExp(`${label}:\\s+(\\d+)`)) || [])[1];
check('status exits 0', r.code === 0, r.out);
check('workspaces counted', count('workspaces') === '2', r.out);
check('observations summed', count('observations') === '3', r.out);
check('facts summed', count('facts') === '2', r.out);
check('sessions summed', count('sessions') === '2', r.out);
check('recent sessions drawn from both', r.out.includes('status-alpha') && r.out.includes('status-beta'), r.out);

console.log('\n3. doctor checks workspace databases, and a missing Codex is a warning');
fs.rmSync(file('.codex'), { recursive: true, force: true });
r = caipira('doctor');
check('workspace databases verified', /\[ok\] +2 workspace database\(s\) open/.test(r.out), r.out);
check('missing Codex config is a warning', /\[warn\] Codex not detected — checks skipped/.test(r.out) && !/\[FAIL\] Codex/.test(r.out), r.out);

console.log('\n4. launchers never leak CAIPIRA_HOME into the child');
const cmd = fs.readFileSync(path.join(ROOT, 'caipira.cmd'), 'utf8');
const sh = fs.readFileSync(path.join(ROOT, 'caipira.sh'), 'utf8');
check('caipira.cmd does not set CAIPIRA_HOME', !/CAIPIRA_HOME/.test(cmd), cmd);
check('caipira.sh does not set CAIPIRA_HOME', !/CAIPIRA_HOME/.test(sh), sh);

// Install fixtures contain real runtime code and existing local prerequisites.
// Builds are deliberately unavailable: these checks need no network or cargo.
const CORE = ['mcp.js', 'store.js', 'facts.js', 'inject.js', 'ast.js', 'workspace.js',
  'migrate.js', 'compress.js', 'errors.js', 'explore-server.js', 'hooks/universal-hook.js',
  'install.js', 'package.json', 'caipira.sh', 'caipira.cmd'];
const NODE_MODULES = path.dirname(path.dirname(require.resolve('better-sqlite3/package.json')));
const NODE_RELEASE = `node-v22.20.0-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

function installFixture(markers = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "caipira-install 'home-"));
  scratch.push(home);
  const source = path.join(home, 'checkout'), live = path.join(home, 'deployment');
  for (const rel of CORE) {
    const dest = path.join(source, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  for (const dir of [source, live]) {
    fs.mkdirSync(path.join(dir, 'node22', NODE_RELEASE, process.platform === 'win32' ? '' : 'bin'), { recursive: true });
    const node = path.join(dir, 'node22', NODE_RELEASE, IS_WINDOWS ? 'node.exe' : 'bin/node');
    if (IS_WINDOWS) fs.linkSync(NODE, node);
    else fs.symlinkSync(NODE, node);
    fs.symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'), 'junction');
    const model = path.join(dir, 'models', 'Xenova', 'all-MiniLM-L6-v2', 'onnx');
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, 'model_quantized.onnx'), 'local model fixture');
  }
  fs.mkdirSync(path.join(source, 'explore-ui', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(source, 'explore-ui', 'dist', 'index.html'), '<html>fixture UI</html>');
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  // A missing optional index still lets explore serve its memory API.
  fs.writeFileSync(path.join(source, 'bin', `caipira-ast${process.platform === 'win32' ? '.exe' : ''}`), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (const marker of markers) {
    const dest = path.join(home, marker);
    if (marker.endsWith('.json') || marker.endsWith('.toml')) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, marker.endsWith('.json') ? '{}' : 'model = "user-model"\n');
    } else fs.mkdirSync(dest, { recursive: true });
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, CAIPIRA_HOME: live };
  if (IS_WINDOWS) {
    // HOME cannot isolate HKCU. Intercept only this platform adapter so even
    // running the suite on Windows never edits the user's actual registry.
    const preload = path.join(home, 'isolate-registry.cjs');
    fs.writeFileSync(preload, `const cp = require('child_process');
const original = cp.execFileSync;
cp.execFileSync = (command, ...args) => command === 'powershell.exe' ? Buffer.alloc(0) : original(command, ...args);
`);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`;
  }
  delete env.CAIPIRA_AST_BIN;
  const run = (...args) => {
    const child = spawnSync(NODE, [path.join(source, 'install.js'), ...args], { env, encoding: 'utf8', timeout: 30000 });
    return { code: child.error ? null : child.status, out: `${child.stdout || ''}${child.stderr || ''}${child.error || ''}` };
  };
  return { home, source, live, env, run };
}

function registered(fixture) {
  return ['.claude.json', '.codex/config.toml', '.gemini/config/mcp_config.json'].map(rel => fs.existsSync(path.join(fixture.home, rel)));
}

console.log('\n5. default detection creates no phantom client configuration');
const empty = installFixture();
r = empty.run('install');
check('empty home install succeeds', r.code === 0, r.out);
check('all absent clients are skipped', ['Claude Code', 'Codex', 'Antigravity'].every(name => r.out.includes(`[skip] ${name} not detected`)), r.out);
check('no client files or directories created', ['.claude', '.claude.json', '.codex', '.gemini'].every(rel => !fs.existsSync(path.join(empty.home, rel))));
r = empty.run('doctor');
check('doctor on empty client home has no failures', r.code === 0 && !r.out.includes('[FAIL]'), r.out);
check('doctor warns for each absent client', ['Claude Code', 'Codex', 'Antigravity'].every(name => r.out.includes(`[warn] ${name} not detected — checks skipped`)), r.out);
r = empty.run('uninstall');
check('uninstall absent clients is quiet and does not create configs', r.code === 0 && !r.out.includes('[warn]') && registered(empty).every(value => !value), r.out);

for (const [marker, expected] of [
  ['.claude', [true, false, false]], ['.claude.json', [true, false, false]],
  ['.codex', [false, true, false]], ['.codex/config.toml', [false, true, false]],
  ['.gemini', [false, false, true]], ['.gemini/config', [false, false, true]]
]) {
  const fixture = installFixture([marker]);
  r = fixture.run('install');
  check(`only client detected by ${marker} registered`, r.code === 0 && JSON.stringify(registered(fixture)) === JSON.stringify(expected), r.out);
  r = fixture.run('doctor');
  check(`doctor verifies client detected by ${marker}`, r.code === 0 && !r.out.includes('[FAIL]'), r.out);
}
const allDetected = installFixture(['.claude', '.codex', '.gemini']);
r = allDetected.run('install');
check('default installation registers all detected clients', r.code === 0 && registered(allDetected).every(Boolean), r.out);
const canonical = installFixture();
r = canonical.run('install', '--clients', 'claude-code', '--accept-risk');
check('canonical client name forces only selected client', r.code === 0 && JSON.stringify(registered(canonical)) === '[true,false,false]', r.out);

console.log('\n6. explicit selection, consent, and user configuration preservation');
const forced = installFixture();
r = forced.run('install', '--clients', 'all');
check('undetected forced clients refused without consent', r.code === 1 && r.out.includes('under your own account and operational responsibility') && r.out.includes('Rerun with --accept-risk to confirm.'), r.out);
check('refusal precedes deploy, launcher, and configuration writes', !fs.existsSync(path.join(forced.live, 'mcp.js')) && !fs.existsSync(path.join(forced.home, '.local')) && registered(forced).every(value => !value));
for (const args of [['--clients'], ['--clients', ''], ['--clients', 'unknown'], ['--clients', '__proto__'], ['--clients', 'all,'], ['--clients', 'codex', '--clients', 'agy'], ['--typo']]) {
  r = forced.run('install', ...args);
  check(`invalid args rejected: ${args.join(' ')}`, r.code === 1 && registered(forced).every(value => !value), r.out);
}
r = forced.run('install', '--clients', 'claude, codex, agy', '--accept-risk');
check('aliases force all client configs with consent', r.code === 0 && registered(forced).every(Boolean), r.out);
const forcedClaude = JSON.parse(fs.readFileSync(path.join(forced.home, '.claude.json')));
check('MCP registration targets synchronized deployment', forcedClaude.mcpServers.caipira.args[0] === path.join(forced.live, 'mcp.js') && forcedClaude.mcpServers.caipira.env.CAIPIRA_HOME === forced.live);
const forcedCodex = fs.readFileSync(path.join(forced.home, '.codex/config.toml'), 'utf8');
check('Codex SessionEnd keeps 3s timeout', /session-end[^\n]*\ntimeout = 3/.test(forcedCodex), forcedCodex);
check('Codex TOML quotes paths containing apostrophes', forcedCodex.includes(`command = ${JSON.stringify(path.join(forced.live, 'node22', NODE_RELEASE, process.platform === 'win32' ? 'node.exe' : 'bin/node'))}`), forcedCodex);
r = forced.run('doctor');
check('doctor verifies all forced clients', r.code === 0 && !r.out.includes('[FAIL]'), r.out);
r = forced.run('install', '--clients', 'all');
check('detected clients require no repeated risk agreement', r.code === 0 && !r.out.includes('operational responsibility'), r.out);
check('reinstall leaves one Caipira handler per Codex event', (fs.readFileSync(path.join(forced.home, '.codex/config.toml'), 'utf8').match(/universal-hook\.js/g) || []).length === 10);

const onlyCodex = installFixture(['.claude', '.codex', '.gemini']);
const configFile = path.join(onlyCodex.home, '.codex/config.toml');
const userConfig = 'model = "custom"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo user-hook"\ntimeout = 42\n';
fs.writeFileSync(configFile, userConfig);
r = onlyCodex.run('install', '--clients', 'codex');
check('explicit list restricts even detected clients', r.code === 0 && JSON.stringify(registered(onlyCodex)) === '[false,true,false]', r.out);
check('Codex install preserves user hook and settings', fs.readFileSync(configFile, 'utf8').startsWith(userConfig));
r = onlyCodex.run('uninstall');
check('uninstall preserves user hook after install', r.code === 0 && fs.readFileSync(configFile, 'utf8').trim() === userConfig.trim(), r.out);

console.log('\n7. complete runtime sync and PATH launcher');
check('all core files synchronized byte for byte', CORE.every(rel => fs.readFileSync(path.join(empty.source, rel)).equals(fs.readFileSync(path.join(empty.live, rel)))));
const AST_REL = `bin/caipira-ast${IS_WINDOWS ? '.exe' : ''}`;
check('UI bundle and executable synchronized', fs.readFileSync(path.join(empty.live, 'explore-ui/dist/index.html'), 'utf8') === '<html>fixture UI</html>' && fs.readFileSync(path.join(empty.live, AST_REL), 'utf8').includes('exit 1'));
check('launcher path recommendation is explicit', empty.run('install').out.includes(IS_WINDOWS ? 'open a new terminal' : 'export PATH="$HOME/.local/bin:$PATH"'));
const launcher = IS_WINDOWS ? path.join(empty.live, 'caipira.cmd') : path.join(empty.home, '.local/bin/caipira');
check('launcher executable exists', IS_WINDOWS ? fs.existsSync(launcher) : Boolean(fs.statSync(launcher).mode & 0o111));
const workdir = path.join(empty.home, 'arbitrary workspace');
fs.mkdirSync(workdir);
fs.writeFileSync(path.join(workdir, 'package.json'), '{}');
const launcherEnv = { ...empty.env, PATH: `${path.dirname(launcher)}${path.delimiter}${process.env.PATH || ''}` };
const launchCommand = IS_WINDOWS ? 'cmd.exe' : 'caipira';
const launchArgs = IS_WINDOWS ? ['/d', '/c', 'caipira.cmd'] : [];
const launched = spawnSync(launchCommand, [...launchArgs, 'status'], { cwd: workdir, env: launcherEnv, encoding: 'utf8', timeout: 10000 });
check('PATH launcher runs from another directory', !launched.error && launched.status === 0 && launched.stdout.includes('Caipira status'), launched.stderr || launched.error);
fs.writeFileSync(path.join(empty.live, 'facts.js'), 'stale deployment');
fs.writeFileSync(path.join(empty.live, 'explore-ui/dist/obsolete.js'), 'old asset');
fs.writeFileSync(path.join(empty.live, 'keep.db'), 'user data');
r = empty.run('install');
check('reinstall refreshes core files and removes stale UI assets', r.code === 0 && fs.readFileSync(path.join(empty.live, 'facts.js')).equals(fs.readFileSync(path.join(empty.source, 'facts.js'))) && !fs.existsSync(path.join(empty.live, 'explore-ui/dist/obsolete.js')), r.out);
check('runtime sync preserves user data and prerequisites', fs.readFileSync(path.join(empty.live, 'keep.db'), 'utf8') === 'user data' && fs.existsSync(path.join(empty.live, 'node_modules/better-sqlite3')));
check('staging directories removed after success', !fs.readdirSync(empty.live).some(name => name.startsWith('.runtime-')));

// Private installer functions run in a VM for deterministic I/O failures,
// TTY answers, and Windows adapter checks without touching the host registry.
function installerContext(fixture, overrides = {}) {
  const context = vm.createContext({
    __dirname: fixture.source, Buffer, console,
    process: { platform: process.platform, arch: process.arch, env: fixture.env, stdout: { on() {}, write() {}, isTTY: false }, stdin: {}, ...overrides.process },
    require: name => name === 'os' ? { homedir: () => fixture.home }
      : overrides[name] || require(name.startsWith('.') ? path.resolve(ROOT, name) : name)
  });
  const text = fs.readFileSync(path.join(ROOT, 'install.js'), 'utf8').split('const command = process.argv[2]')[0];
  vm.runInContext(text, context);
  return context;
}

async function remainingChecks() {
  console.log('\n8. interactive consent and failed deployment recovery');
  for (const [answer, agreed] of [['yes', true], ['', false], ['n', false]]) {
    let prompt = '';
    const context = installerContext(installFixture(), {
      process: { stdout: { on() {}, write() {}, isTTY: true }, stdin: { isTTY: true } },
      readline: { createInterface: () => ({ once() {}, question: (text, callback) => { prompt = text; callback(answer); }, close() {} }) }
    });
    const selection = await vm.runInContext("selectClients(['--clients', 'all'])", context);
    check(`TTY answer ${JSON.stringify(answer)} ${agreed ? 'accepts' : 'refuses'}`, Boolean(selection) === agreed && prompt.includes('[y/N]'));
  }
  for (const operation of ['stage', 'promote']) {
    const fixture = installFixture();
    fixture.run('install');
    const original = fs.readFileSync(path.join(fixture.live, 'mcp.js'));
    fs.appendFileSync(path.join(fixture.source, 'mcp.js'), '\n// updated runtime\n');
    let injected = false;
    const fakeFs = { ...fs,
      cpSync(from, to, options) {
        if (operation === 'stage' && String(from) === path.join(fixture.source, 'facts.js')) throw new Error('injected staging failure');
        return fs.cpSync(from, to, options);
      },
      renameSync(from, to) {
        if (operation === 'promote' && !injected && String(from).split(path.sep).join('/').includes('/new/explore-ui/dist')) { injected = true; throw new Error('injected promotion failure'); }
        return fs.renameSync(from, to);
      }
    };
    let threw = false;
    try { vm.runInContext('deployRuntime()', installerContext(fixture, { fs: fakeFs })); } catch { threw = true; }
    check(`${operation} failure preserves previous runtime and UI`, threw && fs.readFileSync(path.join(fixture.live, 'mcp.js')).equals(original) && fs.existsSync(path.join(fixture.live, 'explore-ui/dist/index.html')));
    check(`${operation} failure cleans staging`, !fs.readdirSync(fixture.live).some(name => name.startsWith('.runtime-')));
  }
  const recovery = installFixture();
  recovery.run('install');
  const original = fs.readFileSync(path.join(recovery.live, 'mcp.js'));
  const fakeRecoveryFs = { ...fs, renameSync(from, to) {
    const normalized = String(from).split(path.sep).join('/');
    if (normalized.includes('/new/explore-ui/dist') || normalized.includes('/old/')) throw new Error('injected rollback failure');
    return fs.renameSync(from, to);
  } };
  let recoveryError;
  try { vm.runInContext('deployRuntime()', installerContext(recovery, { fs: fakeRecoveryFs })); } catch (error) { recoveryError = error; }
  const recoveryDir = fs.readdirSync(recovery.live).find(name => name.startsWith('.runtime-'));
  check('failed rollback retains and identifies recovery files', recoveryError?.message.includes('recovery files retained at') && Boolean(recoveryDir) && fs.readFileSync(path.join(recovery.live, recoveryDir, 'old/mcp.js')).equals(original));

  const unchanged = installFixture();
  unchanged.run('install');
  fs.rmSync(path.join(unchanged.source, 'explore-ui/dist'), { recursive: true });
  fs.rmSync(path.join(unchanged.source, 'bin'), { recursive: true });
  r = unchanged.run('install');
  check('missing optional build assets retain previous deployment', r.code === 0 && fs.existsSync(path.join(unchanged.live, 'explore-ui/dist/index.html')) && fs.existsSync(path.join(unchanged.live, AST_REL)), r.out);
  const sameHome = installFixture();
  sameHome.env.CAIPIRA_HOME = sameHome.source;
  r = sameHome.run('install');
  check('installing within CAIPIRA_HOME needs no runtime copy', r.code === 0 && !r.out.includes('complete runtime synchronized') && !fs.readdirSync(sameHome.source).some(name => name.startsWith('.runtime-')), r.out);

  let windowsCall;
  const win = installFixture();
  vm.runInContext('registerPath()', installerContext(win, {
    process: { platform: 'win32' },
    child_process: { execFileSync: (...args) => { windowsCall = args; } }
  }));
  check('Windows uses bounded PowerShell registry adapter', windowsCall[0] === 'powershell.exe' && windowsCall[2].timeout === 15000 && windowsCall[1].includes('-NonInteractive'));
  const script = windowsCall[1].at(-1);
  check('Windows PATH preserves raw entries and deduplicates expanded paths', script.includes('DoNotExpandEnvironmentNames') && script.includes('ExpandEnvironmentVariables') && script.includes('-ieq') && script.includes('ExpandString') && windowsCall[2].env.CAIPIRA_PATH_TARGET === win.live);
  check('Windows registry errors fail the install', script.includes("$ErrorActionPreference = 'Stop'"));

  console.log('\n9. installed explorer uses the current directory');
  const child = spawn(launchCommand, [...launchArgs, 'explore', '--no-open', '--port', '0'], { cwd: workdir, env: launcherEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const listening = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(null); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  try {
    check('caipira explore --no-open starts from PATH', Boolean(listening), output);
    if (listening) {
      const response = await fetch(`${listening}api/workspaces`);
      const data = await response.json();
      check('explorer default workspace matches invoking directory', data.workspaces.some(row => row.id === data.defaultWorkspaceId && row.root === workdir), JSON.stringify(data));
    }
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
}

remainingChecks().catch(error => { check('integration checks complete', false, error.stack); }).finally(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exitCode = fail ? 1 : 0;
});
