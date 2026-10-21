// Drives install.js against a fake home directory, so uninstall, status and
// doctor run on real config files without touching the user's own.
//
// Counts are asserted exactly, so this suite always takes a CAIPIRA_HOME of
// its own rather than the one run-all.js shares between suites.
delete process.env.CAIPIRA_HOME;
require('./fixtures').ensureIsolatedHome();
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
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
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
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
check('missing Codex config is a warning', /\[warn\] Codex config\.toml not found/.test(r.out) && !/\[FAIL\] Codex/.test(r.out), r.out);

console.log('\n4. launchers never leak CAIPIRA_HOME into the child');
const cmd = fs.readFileSync(path.join(ROOT, 'caipira.cmd'), 'utf8');
const sh = fs.readFileSync(path.join(ROOT, 'caipira.sh'), 'utf8');
check('caipira.cmd does not set CAIPIRA_HOME', !/CAIPIRA_HOME/.test(cmd), cmd);
check('caipira.sh does not set CAIPIRA_HOME', !/CAIPIRA_HOME/.test(sh), sh);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
