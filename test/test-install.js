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

function isolateRegistry(env, home) {
  if (!IS_WINDOWS) return env;
  // HOME cannot isolate HKCU; intercept the registry adapter in every CLI
  // subprocess, including uninstall on a fixture that has never installed.
  const preload = path.join(home, 'isolate-registry.cjs');
  fs.writeFileSync(preload, `const cp = require('child_process');
const original = cp.execFileSync;
cp.execFileSync = (command, ...args) => command === 'powershell.exe' ? Buffer.alloc(0) : original(command, ...args);
`);
  return { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}` };
}

function caipira(...args) {
  const r = spawnSync(NODE, [path.join(ROOT, 'install.js'), ...args], {
    encoding: 'utf8', env: isolateRegistry({ ...process.env, HOME, USERPROFILE: HOME }, HOME)
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
  'install.js', 'package.json', 'bin/caipira-cli.js', 'caipira.sh', 'caipira.cmd'];
const NODE_MODULES = path.dirname(path.dirname(require.resolve('better-sqlite3/package.json')));
const NODE_RELEASE = `node-v22.20.0-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const MCP_SESSION_PROBE_TIMEOUT_MS = 10_000;

function installFixture(markers = [], { provisionDeployment = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "caipira-install 'home-"));
  scratch.push(home);
  const source = path.join(home, 'checkout'), live = path.join(home, 'deployment');
  for (const rel of CORE) {
    const dest = path.join(source, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  const fixturePackage = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  fixturePackage.name = 'caipira';
  fs.writeFileSync(path.join(source, 'package.json'), `${JSON.stringify(fixturePackage, null, 2)}\n`);
  fs.mkdirSync(path.join(source, '.git'));
  fs.mkdirSync(path.join(source, 'rust', 'caipira-ast'), { recursive: true });
  fs.writeFileSync(path.join(source, 'rust', 'caipira-ast', 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.0.0"\n');
  for (const dir of provisionDeployment ? [source, live] : [source]) {
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
  const fakeAst = '#!/bin/sh\nexit 1\n';
  fs.writeFileSync(path.join(source, 'bin', `caipira-ast${process.platform === 'win32' ? '.exe' : ''}`), fakeAst, { mode: 0o755 });
  const targetAst = require(ROOT + '/ast.js').platformBinaryName();
  if (targetAst) fs.writeFileSync(path.join(source, 'bin', targetAst), fakeAst, { mode: 0o755 });
  for (const marker of markers) {
    const dest = path.join(home, marker);
    if (marker.endsWith('.json') || marker.endsWith('.toml')) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, marker.endsWith('.json') ? '{}' : 'model = "user-model"\n');
    } else fs.mkdirSync(dest, { recursive: true });
  }
  const env = isolateRegistry({ ...process.env, HOME: home, USERPROFILE: home, CAIPIRA_HOME: live, SHELL: '/bin/bash' }, home);
  delete env.CAIPIRA_AST_BIN;
  const run = (...args) => {
    const child = spawnSync(NODE, [path.join(source, 'install.js'), ...args], { env, encoding: 'utf8', timeout: 30000 });
    return { code: child.error ? null : child.status, out: `${child.stdout || ''}${child.stderr || ''}${child.error || ''}` };
  };
  return { home, source, live, env, run };
}

console.log('\n4. npm packaging contract and host runtime entrypoint');
const packageJson = require(ROOT + '/package.json');
const requiredFiles = ['ast.js', 'compress.js', 'errors.js', 'explore-server.js', 'facts.js', 'inject.js',
  'install.js', 'mcp.js', 'migrate.js', 'store.js', 'workspace.js', 'hooks/**', 'bin/**', 'explore-ui/dist/**', 'models/**'];
check('scoped package exposes a global caipira command', packageJson.name === '@luismateusvargas/caipira' && packageJson.bin?.caipira === 'bin/caipira-cli.js');
check('package supports Node 20/22/24 and keeps SQLite optional', packageJson.engines?.node === '^20 || ^22 || ^24' &&
  packageJson.optionalDependencies?.['better-sqlite3'] === '12.9.0' && !packageJson.dependencies?.['better-sqlite3']);
check('npm files whitelist covers runtime, CLI, UI and model assets', requiredFiles.every(file => packageJson.files.includes(file)) &&
  packageJson.files.includes('caipira.sh') && packageJson.files.includes('caipira.cmd'));
const astApi = require(ROOT + '/ast.js');
for (const [platform, arch, expected] of [
  ['linux', 'x64', 'caipira-ast-linux-x64'], ['linux', 'arm64', 'caipira-ast-linux-arm64'],
  ['darwin', 'arm64', 'caipira-ast-darwin-arm64'], ['darwin', 'x64', 'caipira-ast-darwin-x64'],
  ['win32', 'x64', 'caipira-ast-win32-x64.exe']
]) check(`AST asset name resolves ${platform}-${arch}`, astApi.platformBinaryName(platform, arch) === expected);
check('AST asset name rejects unsupported platforms', astApi.platformBinaryName('win32', 'arm64') === null);
const cliApi = require(ROOT + '/bin/caipira-cli.js');
const cliHome = path.join(HOME, 'npm-cli-home');
const bundledNode = cliApi.bundledNodePath(cliHome);
check('npm CLI selects the deployment Node 22 path for the host', bundledNode.includes(path.join('node22', `node-v22.20.0-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`)));
check('npm CLI falls back when the bundled runtime is absent', cliApi.resolveBundledNode(cliHome) === null);
fs.mkdirSync(path.dirname(bundledNode), { recursive: true });
fs.writeFileSync(bundledNode, 'runtime fixture', { mode: 0o755 });
check('npm CLI recognizes an installed bundled runtime', cliApi.resolveBundledNode(cliHome) === bundledNode);
const hostCli = spawnSync(NODE, [path.join(ROOT, 'bin/caipira-cli.js'), '__invalid_command__'], {
  encoding: 'utf8', env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome, CAIPIRA_HOME: path.join(cliHome, '.caipira') }
});
check('npm CLI executes install.js under the host Node fallback', hostCli.status === 1 && /Usage: caipira/.test(hostCli.stdout || ''));

console.log('\n4b. npm distribution installs without checkout prerequisites');
const npmPackage = installFixture([], { provisionDeployment: false });
fs.rmSync(path.join(npmPackage.source, '.git'), { recursive: true, force: true });
fs.rmSync(path.join(npmPackage.source, 'rust'), { recursive: true, force: true });
const npmManifest = JSON.parse(fs.readFileSync(path.join(npmPackage.source, 'package.json'), 'utf8'));
npmManifest.name = '@luismateusvargas/caipira';
fs.writeFileSync(path.join(npmPackage.source, 'package.json'), `${JSON.stringify(npmManifest, null, 2)}\n`);
const npmInstall = npmPackage.run('install');
check('npm install works without a preinstalled deployment Node or dependencies', npmInstall.code === 0 &&
  fs.existsSync(path.join(npmPackage.live, 'node_modules/better-sqlite3/package.json')), npmInstall.out);
check('npm install deploys the prebuilt AST, UI and model without cargo or frontend builds',
  fs.existsSync(path.join(npmPackage.live, 'bin', `caipira-ast${IS_WINDOWS ? '.exe' : ''}`)) &&
  fs.existsSync(path.join(npmPackage.live, 'explore-ui/dist/index.html')) &&
  fs.existsSync(path.join(npmPackage.live, 'models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx')) &&
  /using prebuilt caipira-ast/.test(npmInstall.out) && /using prebuilt explore UI/.test(npmInstall.out), npmInstall.out);
const deployedSqlitePackage = path.join(npmPackage.live, 'node_modules/better-sqlite3/package.json');
const sourceSqlitePackage = path.join(npmPackage.source, 'node_modules/better-sqlite3/package.json');
const staleSqliteMetadata = JSON.parse(fs.readFileSync(deployedSqlitePackage, 'utf8'));
staleSqliteMetadata.version = '0.0.0-stale-fixture';
fs.writeFileSync(deployedSqlitePackage, `${JSON.stringify(staleSqliteMetadata)}\n`);
const transformerPackage = path.join(npmPackage.live, 'node_modules/@xenova/transformers/package.json');
const sourceTransformerPackage = path.join(npmPackage.source, 'node_modules/@xenova/transformers/package.json');
if (fs.existsSync(transformerPackage) && fs.existsSync(sourceTransformerPackage)) fs.rmSync(transformerPackage);
const deployedModelConfig = path.join(npmPackage.live, 'models/Xenova/all-MiniLM-L6-v2/config.json');
const sourceModelConfig = path.join(npmPackage.source, 'models/Xenova/all-MiniLM-L6-v2/config.json');
fs.writeFileSync(sourceModelConfig, '{"model":"fixture"}\n');
fs.rmSync(deployedModelConfig, { force: true });
const npmUpgrade = npmPackage.run('install');
check('npm reinstall refreshes stale SQLite and restores missing runtime dependencies', npmUpgrade.code === 0 &&
  JSON.parse(fs.readFileSync(deployedSqlitePackage, 'utf8')).version === JSON.parse(fs.readFileSync(sourceSqlitePackage, 'utf8')).version &&
  fs.existsSync(transformerPackage) && fs.readFileSync(deployedModelConfig, 'utf8') === fs.readFileSync(sourceModelConfig, 'utf8'), npmUpgrade.out);

function registered(fixture) {
  return ['.claude.json', '.codex/config.toml', '.gemini/config/mcp_config.json'].map(rel => fs.existsSync(path.join(fixture.home, rel)));
}

console.log('\n5a. checkout installs refuse missing deployment prerequisites before writes');
for (const missing of [['node22', 'node_modules'], ['node22'], ['node_modules']]) {
  const fixture = installFixture(['.claude'], { provisionDeployment: missing.length !== 2 });
  if (missing.length === 1) fs.rmSync(path.join(fixture.live, missing[0]), { recursive: true, force: true });
  const mcpFile = path.join(fixture.home, '.claude.json');
  const hooksFile = path.join(fixture.home, '.claude/settings.json');
  const originalMcp = '{"theme":"user-theme"}\n';
  const originalHooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo user-hook"}]}]}}\n';
  fs.writeFileSync(mcpFile, originalMcp);
  fs.writeFileSync(hooksFile, originalHooks);
  const result = fixture.run('install');
  const expectedPaths = missing.map(name => path.join(fixture.live, name === 'node22'
    ? `node22/${NODE_RELEASE}/${IS_WINDOWS ? 'node.exe' : 'bin/node'}`
    : 'node_modules/better-sqlite3/package.json'));
  check(`missing ${missing.join(' and ')} refuses installation and names prerequisites`, result.code === 1 && expectedPaths.every(file => result.out.includes(file)) && /provision/i.test(result.out), result.out);
  const deployed = fs.existsSync(fixture.live) ? fs.readdirSync(fixture.live) : [];
  check(`missing ${missing.join(' and ')} creates no deployment, staging, logs or launcher`,
    CORE.every(rel => !fs.existsSync(path.join(fixture.live, rel))) && !deployed.some(name => name.startsWith('.runtime-') || name === 'logs') && !fs.existsSync(path.join(fixture.home, '.local')));
  check(`missing ${missing.join(' and ')} preserves client configs byte for byte`,
    fs.readFileSync(mcpFile, 'utf8') === originalMcp && fs.readFileSync(hooksFile, 'utf8') === originalHooks &&
    !fs.existsSync(`${mcpFile}.caipira-backup`) && !fs.existsSync(`${hooksFile}.caipira-backup`));
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
check('Claude MCP targets deployment without registering CAIPIRA_HOME', forcedClaude.mcpServers.caipira.args[0] === path.join(forced.live, 'mcp.js') &&
  JSON.stringify(forcedClaude.mcpServers.caipira.env) === JSON.stringify({ CAIPIRA_MODEL_PATH: path.join(forced.live, 'models') }));
const forcedAntigravity = JSON.parse(fs.readFileSync(path.join(forced.home, '.gemini/config/mcp_config.json')));
check('Antigravity MCP preserves model path without registering CAIPIRA_HOME',
  JSON.stringify(forcedAntigravity.mcpServers.caipira.env) === JSON.stringify({ CAIPIRA_MODEL_PATH: path.join(forced.live, 'models') }));
const forcedCodex = fs.readFileSync(path.join(forced.home, '.codex/config.toml'), 'utf8');
check('Codex MCP preserves model path without registering CAIPIRA_HOME', !forcedCodex.includes('CAIPIRA_HOME') &&
  forcedCodex.includes(`env = { CAIPIRA_MODEL_PATH = ${JSON.stringify(path.join(forced.live, 'models'))} }`), forcedCodex);
check('Codex SessionEnd keeps 3s timeout', /session-end[^\n]*\ntimeout = 3/.test(forcedCodex), forcedCodex);
check('Codex MCP uses the runtime that executed installation', forcedCodex.includes(`command = ${JSON.stringify(NODE)}`), forcedCodex);
check('Codex TOML quotes deployment paths containing apostrophes',
  forcedCodex.includes(`args = [${JSON.stringify(path.join(forced.live, 'mcp.js'))}]`), forcedCodex);
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
const pathSetup = empty.run('install');
check('automatic PATH setup asks only for a new terminal', pathSetup.code === 0 && pathSetup.out.includes('open a new terminal') && !pathSetup.out.includes('add export PATH='));
const launcher = IS_WINDOWS ? path.join(empty.live, 'caipira.cmd') : path.join(empty.home, '.local/bin/caipira');
const launcherContent = fs.readFileSync(launcher, 'utf8');
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
if (!IS_WINDOWS) {
  check('reinstall leaves only executable caipira on user PATH with unchanged content',
    JSON.stringify(fs.readdirSync(path.dirname(launcher))) === '["caipira"]' &&
    Boolean(fs.statSync(launcher).mode & 0o111) && fs.readFileSync(launcher, 'utf8') === launcherContent);
}

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

// Drive the actual registered MCP process; only terminate after its sessions
// response, and surface process/JSON/timeout failures instead of empty data.
function registeredSessions(registration, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(registration.command, registration.args, {
      env: { ...env, ...registration.env }, cwd, stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = '', stderr = '', sessions, failure;
    const timer = setTimeout(() => {
      failure = new Error('registered MCP session probe timed out');
      child.kill('SIGKILL');
    }, MCP_SESSION_PROBE_TIMEOUT_MS);
    const abort = error => { failure = error; child.kill(); };
    child.on('error', abort);
    child.stdin.on('error', abort);
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => {
      buffer += data;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      try {
        for (const line of lines.filter(line => line.trim())) {
          const response = JSON.parse(line);
          if (response.error) throw new Error(JSON.stringify(response.error));
          if (response.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'list_sessions', arguments: { cwd } } }) + '\n');
          if (response.id === 2) {
            sessions = JSON.parse(response.result.content[0].text);
            child.kill();
          }
        }
      } catch (error) { abort(error); }
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || !Array.isArray(sessions)) reject(failure || new Error(`registered MCP exited ${code}: ${stderr}`));
      else resolve(sessions);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install-probe', version: '1' } } }) + '\n');
  });
}

function automaticPathChecks() {
  if (IS_WINDOWS) return;
  const marker = '# >>> caipira PATH >>>';
  const endMarker = '# <<< caipira PATH <<<';
  const command = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
  const block = `${marker}\n${command}\n${endMarker}\n`;
  const minimalPath = '/usr/bin:/bin';
  const bash = installFixture();
  bash.env.PATH = minimalPath;
  const rc = path.join(bash.home, '.bashrc');
  const original = '# user startup\r\nexport USER_STARTUP=kept\r\n';
  fs.writeFileSync(rc, original);
  fs.chmodSync(rc, 0o600);
  let result = bash.run('install');
  const installed = fs.readFileSync(rc, 'utf8');
  check('bash install appends one exact marked block and preserves original bytes', result.code === 0 && installed === original + block, result.out);
  const installedMode = fs.statSync(rc).mode & 0o777;
  result = bash.run('install');
  check('second bash install leaves marked startup file unchanged', result.code === 0 && fs.readFileSync(rc, 'utf8') === installed, result.out);
  const directory = path.join(bash.home, 'another workspace');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  const shell = spawnSync('/bin/bash', ['-ic', 'command -v caipira && caipira status'], {
    env: bash.env, cwd: directory, encoding: 'utf8', timeout: MCP_SESSION_PROBE_TIMEOUT_MS
  });
  check('new real bash finds and runs caipira from another directory', !shell.error && shell.status === 0 && shell.stdout.includes(path.join(bash.home, '.local/bin/caipira')) && shell.stdout.includes('Caipira status'), shell.stdout + shell.stderr);
  result = bash.run('uninstall');
  check('uninstall restores bash startup bytes', result.code === 0 && fs.readFileSync(rc, 'utf8') === original, result.out);
  check('install and uninstall preserve private startup file permissions', installedMode === 0o600 && (fs.statSync(rc).mode & 0o777) === 0o600);

  const inPath = installFixture();
  inPath.env.PATH = `${path.join(inPath.home, '.local/bin')}:${minimalPath}`;
  result = inPath.run('install');
  check('PATH already configured creates no startup file', result.code === 0 && !fs.existsSync(path.join(inPath.home, '.bashrc')), result.out);
  fs.writeFileSync(path.join(inPath.home, '.bashrc'), 'user config without newline');
  inPath.run('install');
  check('PATH already configured does not change existing startup bytes', fs.readFileSync(path.join(inPath.home, '.bashrc'), 'utf8') === 'user config without newline');

  for (const [shellName, rel, expectedCommand] of [
    ['/bin/sh', '.profile', command], ['/usr/bin/zsh', '.zshrc', command],
    ['/usr/bin/fish', '.config/fish/conf.d/caipira.fish', 'contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH']
  ]) {
    const fixture = installFixture();
    fixture.env.SHELL = shellName;
    fixture.env.PATH = minimalPath;
    result = fixture.run('install');
    const file = path.join(fixture.home, rel);
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    check(`${shellName} selects startup file and shell syntax`, result.code === 0 && content === `${marker}\n${expectedCommand}\n${endMarker}\n`, result.out);
    if (shellName === '/bin/sh') {
      const login = spawnSync('/bin/sh', ['-lc', 'command -v caipira'], { env: fixture.env, cwd: directory, encoding: 'utf8', timeout: MCP_SESSION_PROBE_TIMEOUT_MS });
      check('new real sh login finds caipira', !login.error && login.status === 0 && login.stdout.trim() === path.join(fixture.home, '.local/bin/caipira'), login.stdout + login.stderr);
    }
    result = fixture.run('uninstall');
    check(`${shellName} uninstall removes the created startup file`, result.code === 0 && !fs.existsSync(file), result.out);
  }

  const noNewline = installFixture();
  noNewline.env.PATH = minimalPath;
  const noNewlineFile = path.join(noNewline.home, '.bashrc');
  const noNewlineOriginal = 'export USER_LAST_LINE=kept';
  fs.writeFileSync(noNewlineFile, noNewlineOriginal);
  noNewline.run('install');
  const noNewlineInstalled = fs.readFileSync(noNewlineFile, 'utf8');
  check('startup without final newline keeps original bytes and gains a valid block', noNewlineInstalled.includes(block) && noNewlineInstalled.includes(noNewlineOriginal));
  noNewline.run('uninstall');
  check('uninstall restores file without final newline exactly', fs.readFileSync(noNewlineFile, 'utf8') === noNewlineOriginal);

  const mac = installFixture();
  mac.env.PATH = minimalPath;
  const macRc = path.join(mac.home, '.bashrc'), macProfile = path.join(mac.home, '.bash_profile');
  fs.writeFileSync(macRc, 'bash rc\n');
  fs.writeFileSync(macProfile, 'bash login\n');
  const lowerPriorityFiles = ['.bash_login', '.profile'].map(rel => path.join(mac.home, rel));
  for (const file of lowerPriorityFiles) fs.writeFileSync(file, 'lower priority login\n');
  const macContext = installerContext(mac, { process: { platform: 'darwin' } });
  vm.runInContext('registerPath()', macContext);
  check('macOS bash covers rc and login startup', fs.readFileSync(macRc, 'utf8') === 'bash rc\n' + block && fs.readFileSync(macProfile, 'utf8') === 'bash login\n' + block);
  check('macOS bash_profile wins without touching lower priority login files', lowerPriorityFiles.every(file => fs.readFileSync(file, 'utf8') === 'lower priority login\n'));
  vm.runInContext('unregister()', macContext);
  check('macOS uninstall restores both startup files', fs.readFileSync(macRc, 'utf8') === 'bash rc\n' && fs.readFileSync(macProfile, 'utf8') === 'bash login\n');

  const untouched = installFixture();
  const userFiles = ['.bashrc', '.bash_profile', '.bash_login', '.zshrc', '.profile', '.config/fish/conf.d/caipira.fish'];
  for (const rel of userFiles) {
    const file = path.join(untouched.home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'unmarked user content\r\n');
  }
  result = untouched.run('uninstall');
  check('uninstall leaves every unmarked startup file untouched', result.code === 0 && userFiles.every(rel => fs.readFileSync(path.join(untouched.home, rel), 'utf8') === 'unmarked user content\r\n'), result.out);
  const fish = installFixture();
  fish.env.SHELL = '/usr/bin/fish';
  fish.env.PATH = minimalPath;
  const fishFile = path.join(fish.home, '.config/fish/conf.d/caipira.fish');
  fs.mkdirSync(path.dirname(fishFile), { recursive: true });
  fs.writeFileSync(fishFile, 'set -gx USER_FISH kept\n');
  fish.run('install');
  fish.run('uninstall');
  check('uninstall preserves user content in a pre-existing fish file', fs.readFileSync(fishFile, 'utf8') === 'set -gx USER_FISH kept\n');
  const blank = installFixture([], { provisionDeployment: false });
  result = blank.run('uninstall');
  check('uninstall on never-installed home is quiet and creates no startup or deployment files', result.code === 0 && !result.out.includes('[warn]') &&
    !fs.existsSync(blank.live) && !fs.existsSync(path.join(blank.home, '.local')) && userFiles.every(rel => !fs.existsSync(path.join(blank.home, rel))), result.out);
  const markedFile = path.join(untouched.home, '.zshrc');
  const surrounding = 'before\r\n' + block + 'between\n' + block + 'after';
  fs.writeFileSync(markedFile, surrounding);
  untouched.run('uninstall');
  check('uninstall removes only marked ranges, preserving surrounding bytes', fs.readFileSync(markedFile, 'utf8') === 'before\r\nbetween\nafter');
  fs.writeFileSync(markedFile, `${marker}\nuser incomplete block`);
  untouched.env.SHELL = '/usr/bin/zsh';
  untouched.env.PATH = minimalPath;
  untouched.run('install');
  untouched.run('uninstall');
  check('existing incomplete marker is never rewritten or truncated', fs.readFileSync(markedFile, 'utf8') === `${marker}\nuser incomplete block`);
}

function startupPreservationChecks() {
  if (IS_WINDOWS) return;
  const block = '# >>> caipira PATH >>>\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n# <<< caipira PATH <<<\n';
  const original = '# dotfiles startup\nexport DOTFILE_READY=kept';
  const linked = installFixture();
  linked.env.PATH = '/usr/bin:/bin';
  const rc = path.join(linked.home, '.bashrc');
  const target = path.join(linked.home, 'dotfiles', 'bashrc');
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, original, { mode: 0o600 });
  fs.symlinkSync('dotfiles/bashrc', rc);
  let result = linked.run('install');
  check('install keeps the startup symlink and updates its target with original bytes', result.code === 0 &&
    fs.lstatSync(rc).isSymbolicLink() && fs.readFileSync(target, 'utf8') === block + original, result.out);
  check('startup backup stays beside the home symlink, outside the dotfiles directory',
    fs.readFileSync(`${rc}.caipira-backup`, 'utf8') === original &&
    JSON.stringify(fs.readdirSync(path.dirname(target))) === '["bashrc"]');
  result = linked.run('install');
  check('reinstall keeps the symlink and one block at its target', result.code === 0 &&
    fs.lstatSync(rc).isSymbolicLink() && fs.readFileSync(target, 'utf8') === block + original, result.out);
  const shell = spawnSync('/bin/bash', ['-ic', 'command -v caipira && caipira status'], {
    env: linked.env, cwd: linked.home, encoding: 'utf8', timeout: MCP_SESSION_PROBE_TIMEOUT_MS
  });
  check('new real bash loads the symlink target and runs caipira', !shell.error && shell.status === 0 &&
    shell.stdout.includes(path.join(linked.home, '.local/bin/caipira')) && shell.stdout.includes('Caipira status'), shell.stdout + shell.stderr);
  result = linked.run('uninstall');
  check('uninstall keeps the symlink and restores target bytes and permissions', result.code === 0 &&
    fs.lstatSync(rc).isSymbolicLink() && fs.readFileSync(target, 'utf8') === original &&
    (fs.statSync(target).mode & 0o777) === 0o600, result.out);
  fs.writeFileSync(target, '');
  linked.run('install');
  result = linked.run('uninstall');
  check('uninstall preserves an originally empty symlink target without a dangling link', result.code === 0 &&
    fs.lstatSync(rc).isSymbolicLink() && fs.readFileSync(target, 'utf8') === '', result.out);

  for (const readOnlyDirectory of [false, true]) {
    const fixture = installFixture();
    fixture.env.PATH = '/usr/bin:/bin';
    const link = path.join(fixture.home, '.bashrc');
    const dir = path.join(fixture.home, 'readonly-dotfiles');
    const destination = path.join(dir, 'bashrc');
    fs.mkdirSync(dir);
    fs.writeFileSync(destination, original);
    fs.symlinkSync('readonly-dotfiles/bashrc', link);
    const protect = () => fs.chmodSync(readOnlyDirectory ? dir : destination, readOnlyDirectory ? 0o555 : 0o444);
    const unlock = () => fs.chmodSync(readOnlyDirectory ? dir : destination, readOnlyDirectory ? 0o755 : 0o644);
    protect();
    try {
      result = fixture.run('install');
      check(`unwritable ${readOnlyDirectory ? 'directory' : 'target'} leaves link and bytes intact while install succeeds`,
        result.code === 0 && fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(destination, 'utf8') === original &&
        fs.existsSync(path.join(fixture.home, '.local/bin/caipira')) && result.out.includes('[warn]') &&
        result.out.includes('export PATH="$HOME/.local/bin:$PATH"') && fs.readdirSync(dir).length === 1, result.out);
    } finally { unlock(); }
    // Test uninstall independently even against an implementation that broke
    // the link during install, so both failure paths are reported.
    if (!fs.lstatSync(link).isSymbolicLink()) { fs.unlinkSync(link); fs.symlinkSync('readonly-dotfiles/bashrc', link); }
    fs.writeFileSync(destination, original + '\n' + block);
    protect();
    try {
      result = fixture.run('uninstall');
      check(`unwritable ${readOnlyDirectory ? 'directory' : 'target'} warns and continues uninstall without changing the link or bytes`,
        result.code === 0 && result.out.includes('[warn]') && fs.lstatSync(link).isSymbolicLink() &&
        fs.readFileSync(destination, 'utf8') === original + '\n' + block && fs.readdirSync(dir).length === 1, result.out);
    } finally { unlock(); }
  }

  for (const code of ['EPERM', 'EROFS']) {
    const fixture = installFixture();
    fixture.env.PATH = '/usr/bin:/bin';
    const link = path.join(fixture.home, '.bashrc');
    const destination = path.join(fixture.home, 'dotfiles', 'bashrc');
    fs.mkdirSync(path.dirname(destination));
    fs.writeFileSync(destination, original);
    fs.symlinkSync('dotfiles/bashrc', link);
    let output = '';
    const context = installerContext(fixture, {
      process: { stdout: { on() {}, write: text => { output += text; } } },
      fs: { ...fs, renameSync: (from, to) => {
        if (to === destination) throw Object.assign(new Error('simulated target restriction'), { code });
        return fs.renameSync(from, to);
      } }
    });
    vm.runInContext('registerPath()', context);
    check(`${code} during startup promotion warns, preserves target and cleans its temporary file`,
      output.includes(`[warn]`) && output.includes(code) && output.includes('export PATH="$HOME/.local/bin:$PATH"') &&
      fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(destination, 'utf8') === original &&
      fs.readdirSync(path.dirname(destination)).length === 1);
    fs.writeFileSync(destination, original + '\n' + block);
    output = '';
    vm.runInContext('unregisterPath()', context);
    check(`${code} during uninstall warns and continues with target and link intact`,
      output.includes('[warn]') && output.includes(code) && fs.lstatSync(link).isSymbolicLink() &&
      fs.readFileSync(destination, 'utf8') === original + '\n' + block && fs.readdirSync(path.dirname(destination)).length === 1);
  }

  const fresh = installFixture();
  fresh.env.PATH = '/usr/bin:/bin';
  result = fresh.run('install');
  const created = result.code === 0 && fs.existsSync(path.join(fresh.home, '.bashrc'));
  result = fresh.run('uninstall');
  check('install then uninstall returns an absent bashrc to absent', created && result.code === 0 && !fs.existsSync(path.join(fresh.home, '.bashrc')), result.out);

  for (const loginName of ['.profile', '.bash_login', null]) {
    const fixture = installFixture();
    fixture.env.PATH = '/usr/bin:/bin';
    delete fixture.env.HOMEBREW_READY;
    const login = path.join(fixture.home, loginName || '.bash_profile');
    const contents = 'export HOMEBREW_READY=1\n';
    if (loginName) fs.writeFileSync(login, contents);
    const context = installerContext(fixture, { process: { platform: 'darwin' } });
    vm.runInContext('registerPath()', context);
    check(`macOS bash selects ${loginName || 'new .bash_profile'} without shadowing existing login files`,
      fs.readFileSync(login, 'utf8') === (loginName ? contents : '') + block &&
      (loginName === null || !fs.existsSync(path.join(fixture.home, '.bash_profile'))));
    const loginShell = spawnSync('/bin/bash', ['-lc', 'printf "%s\\n" "$HOMEBREW_READY"; command -v caipira'], {
      env: fixture.env, cwd: fixture.home, encoding: 'utf8', timeout: MCP_SESSION_PROBE_TIMEOUT_MS
    });
    check(`real bash login preserves settings and finds caipira via ${loginName || 'new .bash_profile'}`,
      !loginShell.error && loginShell.status === 0 && loginShell.stdout === `${loginName ? '1' : ''}\n${path.join(fixture.home, '.local/bin/caipira')}\n`, loginShell.stdout + loginShell.stderr);
    vm.runInContext('unregisterPath()', context);
    check(`macOS uninstall restores ${loginName || 'absent .bash_profile'} and removes the created bashrc`,
      (loginName ? fs.readFileSync(login, 'utf8') === contents : !fs.existsSync(login)) && !fs.existsSync(path.join(fixture.home, '.bashrc')));
  }
}

function startupRecoveryChecks() {
  if (IS_WINDOWS) return;
  const marker = '# >>> caipira PATH >>>';
  const block = `${marker}\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n# <<< caipira PATH <<<\n`;

  const dangling = installFixture(['.claude']);
  dangling.env.PATH = '/usr/bin:/bin';
  const danglingLink = path.join(dangling.home, '.bashrc');
  fs.symlinkSync('dotfiles-moved/bashrc', danglingLink);
  let result = dangling.run('install');
  check('dangling startup link warns without creating its target or blocking client registration', result.code === 0 &&
    fs.lstatSync(danglingLink).isSymbolicLink() && !fs.existsSync(path.join(dangling.home, 'dotfiles-moved')) &&
    fs.existsSync(path.join(dangling.home, '.local/bin/caipira')) && fs.existsSync(path.join(dangling.home, '.claude.json')) &&
    fs.readFileSync(path.join(dangling.home, '.claude/settings.json'), 'utf8').includes('universal-hook.js') &&
    result.out.includes('[warn]') && result.out.includes('.bashrc') && result.out.includes('export PATH="$HOME/.local/bin:$PATH"'), result.out);
  result = dangling.run('uninstall');
  check('dangling startup link remains unchanged and silent during uninstall', result.code === 0 &&
    fs.lstatSync(danglingLink).isSymbolicLink() && !fs.existsSync(path.join(dangling.home, 'dotfiles-moved')) && !result.out.includes('[warn]'), result.out);

  const looping = installFixture(['.claude']);
  looping.env.PATH = '/usr/bin:/bin';
  const loopingLink = path.join(looping.home, '.bashrc');
  fs.symlinkSync('.bashrc', loopingLink);
  result = looping.run('install');
  check('looping startup link warns without blocking runtime and client setup', result.code === 0 &&
    fs.lstatSync(loopingLink).isSymbolicLink() && fs.existsSync(path.join(looping.home, '.local/bin/caipira')) &&
    fs.existsSync(path.join(looping.home, '.claude.json')) && result.out.includes('[warn]') &&
    result.out.includes('.bashrc') && result.out.includes('export PATH="$HOME/.local/bin:$PATH"'), result.out);
  result = looping.run('uninstall');
  check('looping startup link warns while client uninstall completes', result.code === 0 &&
    fs.lstatSync(loopingLink).isSymbolicLink() && fs.existsSync(path.join(looping.home, '.claude.json')) &&
    !readJsonFor(looping.home, '.claude.json').mcpServers?.caipira && result.out.includes('[warn]'), result.out);

  for (const relative of ['.bashrc', 'dotfiles/bashrc']) {
    const fixture = installFixture();
    fixture.env.PATH = '/usr/bin:/bin';
    let target = path.join(fixture.home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (relative !== '.bashrc') {
      fs.writeFileSync(target, 'user startup\n');
      fs.symlinkSync('dotfiles/bashrc', path.join(fixture.home, '.bashrc'));
      target = path.join(fixture.home, 'dotfiles/bashrc');
    } else fs.writeFileSync(target, 'user startup\n');
    if (relative === '.bashrc') fs.writeFileSync(`${target}.caipira-tmp`, 'interrupted write');
    else {
      fs.writeFileSync(`${target}.link-target`, 'safe');
      fs.symlinkSync('bashrc.link-target', `${target}.caipira-tmp`);
    }
    result = fixture.run('install');
    check(`install replaces stale ${relative === '.bashrc' ? 'regular-file' : 'symlink'} temporary and adds one block`,
      result.code === 0 && fs.readFileSync(target, 'utf8') === 'user startup\n' + block &&
      !fs.existsSync(`${target}.caipira-tmp`) &&
      (relative === '.bashrc' || fs.readFileSync(`${target}.link-target`, 'utf8') === 'safe'), result.out);
  }

  for (const [relative, shell, platform] of [
    ['.bashrc', '/bin/bash', 'linux'], ['.zshrc', '/usr/bin/zsh', 'linux'], ['.bash_profile', '/bin/bash', 'darwin']
  ]) {
    const fixture = installFixture();
    fixture.env.SHELL = shell;
    fixture.env.PATH = '/usr/bin:/bin';
    const startup = path.join(fixture.home, relative);
    fs.writeFileSync(startup, '', { mode: 0o640 });
    if (platform === 'darwin') {
      fs.writeFileSync(path.join(fixture.home, '.profile'), 'export PROFILE_ONLY=1\n');
      delete fixture.env.PROFILE_ONLY;
    }
    const context = installerContext(fixture, { process: { platform } });
    const loginValue = () => spawnSync('/bin/bash', ['-lc', 'printf "%s\\n" "$PROFILE_ONLY"'], {
      env: fixture.env, cwd: fixture.home, encoding: 'utf8', timeout: MCP_SESSION_PROBE_TIMEOUT_MS
    });
    const before = platform === 'darwin' ? loginValue() : null;
    vm.runInContext('registerPath()', context);
    const state = path.join(fixture.live, '.caipira-startup-files.json');
    const recordedFiles = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : [];
    check(`install records created startup file but leaves pre-existing empty ${relative} intact`,
      fs.readFileSync(startup, 'utf8') === block && (fs.statSync(startup).mode & 0o777) === 0o640 &&
      !recordedFiles.includes(startup) &&
      (platform === 'darwin' ? recordedFiles.length === 1 && recordedFiles[0] === path.join(fixture.home, '.bashrc') : recordedFiles.length === 0));
    vm.runInContext('unregisterPath()', context);
    const after = platform === 'darwin' ? loginValue() : null;
    check(`uninstall retains pre-existing empty ${relative} and removes its empty tracking state`,
      fs.existsSync(startup) && fs.readFileSync(startup, 'utf8') === '' && (fs.statSync(startup).mode & 0o777) === 0o640 &&
      !fs.existsSync(path.join(fixture.live, '.caipira-startup-files.json')) &&
      (platform !== 'darwin' || (fs.readFileSync(path.join(fixture.home, '.profile'), 'utf8') === 'export PROFILE_ONLY=1\n' &&
        before.status === 0 && after.status === 0 && before.stdout === '\n' && after.stdout === before.stdout)));
  }

  const created = installFixture();
  created.env.PATH = '/usr/bin:/bin';
  result = created.run('install');
  const state = path.join(created.live, '.caipira-startup-files.json');
  const createdRc = path.join(created.home, '.bashrc');
  check('created regular startup file and ownership path are recorded once', result.code === 0 &&
    fs.readFileSync(createdRc, 'utf8') === block && JSON.parse(fs.readFileSync(state, 'utf8')).filter(file => file === createdRc).length === 1, result.out);
  result = created.run('install');
  check('reinstall never records a startup path twice', result.code === 0 &&
    JSON.parse(fs.readFileSync(state, 'utf8')).filter(file => file === createdRc).length === 1, result.out);
  fs.rmSync(state);
  result = created.run('uninstall');
  check('missing ownership state keeps a newly empty regular startup file safely', result.code === 0 &&
    fs.existsSync(createdRc) && fs.readFileSync(createdRc, 'utf8') === '', result.out);

  const unreadable = installFixture();
  unreadable.env.PATH = '/usr/bin:/bin';
  result = unreadable.run('install');
  const unreadableState = path.join(unreadable.live, '.caipira-startup-files.json');
  const unreadableRc = path.join(unreadable.home, '.bashrc');
  const context = installerContext(unreadable, {
    fs: { ...fs, readFileSync: (file, ...args) => {
      if (path.resolve(file) === unreadableState) throw Object.assign(new Error('simulated unreadable state'), { code: 'EACCES' });
      return fs.readFileSync(file, ...args);
    } }
  });
  vm.runInContext('unregisterPath()', context);
  check('unreadable state is treated as empty, keeps the startup file and uninstall continues',
    fs.existsSync(unreadableRc) && fs.readFileSync(unreadableRc, 'utf8') === '' && fs.existsSync(unreadableState));
}

function readJsonFor(home, relative) {
  return JSON.parse(fs.readFileSync(path.join(home, relative), 'utf8'));
}

async function remainingChecks() {
  console.log('\n7a. automatic PATH startup files and uninstall');
  automaticPathChecks();
  console.log('\n7b. dotfiles symlinks, login selection and startup cleanup');
  startupPreservationChecks();
  console.log('\n7c. dangling links, stale temporaries and startup ownership');
  startupRecoveryChecks();
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
  fs.rmSync(path.join(unchanged.source, AST_REL), { force: true });
  const targetAst = require(ROOT + '/ast.js').platformBinaryName();
  if (targetAst) fs.rmSync(path.join(unchanged.source, 'bin', targetAst), { force: true });
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
  check('Windows PATH limit has no unnamed 15000 literal', !/\b15000\b/.test(fs.readFileSync(path.join(ROOT, 'install.js'), 'utf8')));
  const broadcastContract = call => {
    const body = call[1].at(-1);
    return body.includes('Add-Type') && body.includes('SendMessageTimeout') && body.includes('0x1A') && body.includes('0xFFFF') &&
      body.includes('SMTO_ABORTIFHUNG') && body.includes('Environment') && body.includes('CAIPIRA_PATH_BROADCAST_TIMEOUT_MS') &&
      body.indexOf("$key.SetValue('Path'") < body.indexOf('Add-Type') &&
      Number(call[2].env.CAIPIRA_PATH_BROADCAST_TIMEOUT_MS) > 0 && Number(call[2].env.CAIPIRA_PATH_BROADCAST_TIMEOUT_MS) < call[2].timeout;
  };
  check('Windows install broadcasts environment change after registry write with bounded timeout', broadcastContract(windowsCall));
  let removalCall;
  vm.runInContext('unregister()', installerContext(win, {
    process: { platform: 'win32' }, child_process: { execFileSync: (...args) => { removalCall = args; } }
  }));
  check('Windows uninstall removes only expanded target and broadcasts with same contract', Boolean(removalCall) && broadcastContract(removalCall) &&
    removalCall[2].env.CAIPIRA_PATH_ACTION === 'remove' && removalCall[1].at(-1).includes('-ine') &&
    removalCall[1].at(-1).includes('DoNotExpandEnvironmentNames') && removalCall[1].at(-1).includes('ExpandString'));
  let registryWrites = 0, warningOutput = '';
  vm.runInContext('registerPath()', installerContext(win, {
    process: { platform: 'win32', stdout: { on() {}, write: message => { warningOutput += message; } } },
    child_process: { execFileSync: () => { registryWrites++; return 'CAIPIRA_PATH_CHANGED\nCAIPIRA_PATH_BROADCAST_FAILED\n'; } }
  }));
  check('simulated broadcast failure warns about sign-out without a registry rollback call', registryWrites === 1 && warningOutput.includes('[warn]') && /signing out/i.test(warningOutput));
  warningOutput = '';
  vm.runInContext('registerPath()', installerContext(win, {
    process: { platform: 'win32', stdout: { on() {}, write: message => { warningOutput += message; } } },
    child_process: { execFileSync: () => { throw Object.assign(new Error('broadcast subprocess deadline'), { code: 'ETIMEDOUT', stdout: 'CAIPIRA_PATH_CHANGED\n' }); } }
  }));
  check('outer timeout after registry write warns while retaining completed update', warningOutput.includes('[warn]') && /signing out/i.test(warningOutput));
  let missingEntryOutput = '';
  vm.runInContext('unregisterPath()', installerContext(win, {
    process: { platform: 'win32', stdout: { on() {}, write: message => { missingEntryOutput += message; } } },
    child_process: { execFileSync: () => '' }
  }));
  check('Windows missing PATH entry removal is silent', missingEntryOutput === '');

  console.log('\n8a. registered entry points inherit one data root after custom deployment');
  const shared = installFixture(['.claude', '.codex', '.gemini']);
  const installed = shared.run('install');
  check('custom deployment installs for data-root probe', installed.code === 0, installed.out);
  const parentEnv = { ...shared.env };
  delete parentEnv.CAIPIRA_HOME;
  parentEnv.PATH = `${IS_WINDOWS ? shared.live : path.join(shared.home, '.local/bin')}${path.delimiter}${parentEnv.PATH || ''}`;
  const workspace = path.join(shared.home, 'shared workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  const registration = JSON.parse(fs.readFileSync(path.join(shared.home, '.claude.json'))).mcpServers.caipira;
  const hook = JSON.parse(fs.readFileSync(path.join(shared.home, '.claude/settings.json'))).hooks.UserPromptSubmit[0].hooks[0].command;
  const sessionId = 'installed-shared-session';
  const captured = spawnSync(hook, { shell: IS_WINDOWS ? 'cmd.exe' : '/bin/sh', cwd: workspace, env: parentEnv,
    input: JSON.stringify({ session_id: sessionId, cwd: workspace, prompt: 'shared memory probe' }), encoding: 'utf8', timeout: MCP_SESSION_PROBE_TIMEOUT_MS });
  check('registered UserPromptSubmit captures session without inherited CAIPIRA_HOME', !captured.error && captured.status === 0 && fs.existsSync(path.join(shared.home, '.caipira/database/master.db')), captured.stderr || captured.error);
  const sessions = await registeredSessions(registration, parentEnv, workspace);
  check('registered MCP sees session captured by hook', sessions.length === 1 && sessions[0].id === sessionId, JSON.stringify(sessions));
  const status = spawnSync(launchCommand, [...launchArgs, 'status'], { cwd: workspace, env: parentEnv, encoding: 'utf8', timeout: MCP_SESSION_PROBE_TIMEOUT_MS });
  check('PATH status counts same hook and MCP session', !status.error && status.status === 0 && /workspaces:\s+1\b/.test(status.stdout) && /sessions:\s+1\b/.test(status.stdout) && status.stdout.includes(sessionId), status.stdout || status.stderr || status.error);
  check('entry points do not populate custom install data root without inherited override', !fs.existsSync(path.join(shared.live, 'database')));

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

  console.log('\n10. supported Node runtime contract');
  const compatibilityFixture = installFixture([], { provisionDeployment: false });
  for (const major of [20, 22, 24]) {
    const context = installerContext(compatibilityFixture, { process: { versions: { node: `${major}.0.0` } } });
    check(`Node ${major} is supported`, vm.runInContext('hasSupportedNodeMajor()', context));
  }
  let incompatibleOutput = '';
  const incompatible = installerContext(compatibilityFixture, {
    process: {
      versions: { node: '26.0.0' },
      stdout: { on() {}, write: message => { incompatibleOutput += message; }, isTTY: false }
    }
  });
  await vm.runInContext('install()', incompatible);
  check('unsupported Node exits before writing deployment files', incompatible.process.exitCode === 1 &&
    /Node 26\.0\.0 is unsupported; use Node 20, 22, or 24/.test(incompatibleOutput) && !fs.existsSync(compatibilityFixture.live));

  fs.rmSync(path.join(compatibilityFixture.source, '.git'), { recursive: true, force: true });
  fs.rmSync(path.join(compatibilityFixture.source, AST_REL), { force: true });
  const unsupportedAst = require(ROOT + '/ast.js').platformBinaryName();
  if (unsupportedAst) fs.rmSync(path.join(compatibilityFixture.source, 'bin', unsupportedAst), { force: true });
  let cargoCalls = 0, astBuildOutput = '';
  const noCheckoutBuild = installerContext(compatibilityFixture, {
    './ast': { CRATE_DIR: path.join(compatibilityFixture.source, 'rust/caipira-ast'), platformBinaryName: () => null },
    child_process: { execFileSync: () => { cargoCalls++; throw new Error('cargo should not run'); } },
    process: { stdout: { on() {}, write: message => { astBuildOutput += message; }, isTTY: false } }
  });
  vm.runInContext('buildAstEngine()', noCheckoutBuild);
  check('Cargo fallback is limited to development checkouts', cargoCalls === 0 && /builds are limited to development checkouts/.test(astBuildOutput), astBuildOutput);
}

remainingChecks().catch(error => { check('integration checks complete', false, error.stack); }).finally(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exitCode = fail ? 1 : 0;
});
