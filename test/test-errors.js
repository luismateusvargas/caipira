// Journal tests use a dedicated home and never require native SQLite.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caipira-errors-'));
const previousHome = process.env.CAIPIRA_HOME;
process.env.CAIPIRA_HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const { logError, readErrors } = require('../errors');
const file = path.join(home, 'logs', 'errors.jsonl');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (error) { fail++; console.log('  FAIL ' + name + ': ' + error.message); }
}
function record(message = 'synthetic failure', extra = {}) {
  return logError({ component: 'hook', operation: 'load modules', client: 'codex', event: 'SessionStart',
    error: Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' }), ...extra });
}
function cliWith(env, ...args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'install.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, CAIPIRA_HOME: home, ...env }, timeout: 10000
  });
}
function cli(...args) { return cliWith({}, ...args); }

test('empty journal is empty and creates no directory', () => {
  assert.deepEqual(readErrors(), []);
  assert.equal(fs.existsSync(path.dirname(file)), false);
});
test('one failure produces one JSON line with the complete metadata contract', () => {
  const entry = record();
  assert.deepEqual(Object.keys(entry), ['id', 'ts', 'component', 'operation', 'client', 'error', 'env', 'repro']);
  assert.match(entry.id, /^[\da-f-]{36}$/);
  assert.equal(new Date(entry.ts).toISOString(), entry.ts);
  assert.deepEqual(entry.env, { caipiraVersion: require('../package.json').version,
    nodeVersion: process.version, abi: process.versions.modules, platform: process.platform,
    arch: process.arch, execPath: process.execPath });
  assert.deepEqual(Object.keys(entry.error), ['name', 'code', 'message', 'stack']);
  assert.equal(entry.error.code, 'ERR_DLOPEN_FAILED');
  assert.match(entry.error.stack, /synthetic failure/);
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse), [entry]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('nested, multiline, unclosed private content and credentials are redacted in every field', () => {
  const secret = '<private>private-one\n<private>private-two</private>private-tail</private> ';
  const entry = record(secret + 'token=token-value api_key="key-value" password=pass-value ' +
    'Bearer bearer-value sk-synthetic123 ghp_synthetic123 https://user:url-secret@example.test ' +
    '<private>unclosed-secret', { operation: '<private>hidden-op</private>', client: 'codex' });
  const raw = JSON.stringify(entry);
  for (const text of ['private-one', 'private-two', 'private-tail', 'token-value', 'key-value', 'pass-value',
    'bearer-value', 'sk-synthetic123', 'ghp_synthetic123', 'url-secret', 'unclosed-secret', 'hidden-op']) {
    assert.equal(raw.includes(text), false, text);
  }
});
test('reproduction is a single shell command with synthetic input and no caller shell text', () => {
  const entry = record('repro', { event: "FutureEvent'; touch /tmp/caipira-injected #", payload: { prompt: 'user-prompt-secret' }, args: ['--token', 'argument-secret'] });
  assert.match(entry.repro, /printf '%s\\n'.*universal-hook\.js.*--client codex/);
  assert.equal(/[\r\n]/.test(entry.repro), false);
  for (const secret of ['touch ', 'user-prompt-secret', 'argument-secret']) assert.equal(entry.repro.includes(secret), false);
  const syntax = spawnSync('/bin/sh', ['-n'], { input: entry.repro, encoding: 'utf8' });
  if (process.platform !== 'win32') assert.equal(syntax.status, 0, syntax.stderr);
});
test('reporting the same Error across boundaries appends only one entry', () => {
  const error = new Error('shared error');
  const first = record('', { error });
  const second = logError({ component: 'mcp', operation: 'tool', error });
  assert.equal(second.id, first.id);
  const translated = logError({ component: 'explore', operation: 'HTTP request', error: new Error('translated', { cause: error }) });
  assert.equal(translated.id, first.id);
  assert.equal(readErrors({ limit: 100 }).filter(entry => entry.id === first.id).length, 1);
});
test('rotation is bounded to one backup and readers return newest entries first', () => {
  readErrors({ clear: true });
  const old = record('backup-entry');
  fs.appendFileSync(file, ' '.repeat(2 * 1024 * 1024));
  const current = record('current-entry');
  assert.equal(fs.existsSync(file + '.1'), true);
  assert.deepEqual(readErrors().map(entry => entry.id), [current.id, old.id]);
  fs.appendFileSync(file, ' '.repeat(2 * 1024 * 1024));
  const newest = record('newest-entry');
  assert.deepEqual(readErrors().map(entry => entry.id), [newest.id, current.id]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['errors.jsonl', 'errors.jsonl.1']);
  assert.ok(fs.statSync(file).size <= 2 * 1024 * 1024);
});
test('limits, malformed trailing lines, clearing and non-Error rejections are safe', () => {
  const entry = record('', { error: 'promise rejected' });
  fs.appendFileSync(file, '{torn-line\n');
  assert.deepEqual(readErrors({ limit: 1 }), [entry]);
  assert.deepEqual(readErrors({ limit: 0 }), []);
  assert.throws(() => readErrors({ limit: -1 }), RangeError);
  readErrors({ clear: true });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(file + '.1'), false);
});
test('an unwritable journal never throws or pollutes stdout', () => {
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, '');
  process.env.CAIPIRA_HOME = blocker;
  try { assert.equal(record(), null); } finally { process.env.CAIPIRA_HOME = home; }
});
test('logs CLI formats errors, limits output, validates flags, and clears both generations', () => {
  record('older');
  record('newer');
  const shown = cli('logs', '--limit', '1');
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /newer[\s\S]*Reproduce: .*universal-hook/);
  assert.equal(shown.stdout.includes('older'), false);
  assert.equal(cli('logs', '--limit', 'bad').status, 1);
  assert.equal(cli('logs', '--unknown').status, 1);
  assert.equal(cli('logs', '--clear').status, 0);
  assert.equal(cli('logs').stdout.trim(), 'No logged errors.');
});
test('doctor and status report zero errors and warn when the journal is non-empty', () => {
  assert.match(cli('status').stdout, /recent errors:\s+0/);
  assert.match(cli('doctor').stdout, /0 recent logged errors/);
  record('doctor warning');
  assert.match(cli('status').stdout, /recent errors:\s+1/);
  assert.match(cli('doctor').stdout, /\[warn\] 1 recent logged error\(s\)/);
});
test('AST subprocess failures are journaled at the bridge with the matching reproduction operation', () => {
  readErrors({ clear: true });
  const child = spawnSync(process.execPath, ['-e', `
    try { require('./ast').parseFileAst(process.cwd(), 'errors.js'); }
    catch (error) { process.exitCode = error.code === 'binary_missing' ? 0 : 1; }
  `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CAIPIRA_AST_BIN: path.join(home, 'missing-parser') }, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const entries = readErrors();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].component, 'ast');
  assert.equal(entries[0].error.code, 'binary_missing');
  assert.match(entries[0].repro, /caipira-ast parse-file.*--file src\/example.js/);
});
test('installer command failures are journaled without running installation steps', () => {
  readErrors({ clear: true });
  const preload = path.join(home, 'installer-failure.cjs');
  fs.writeFileSync(preload, `
    const fs = require('fs'), exists = fs.existsSync;
    fs.existsSync = file => /node_modules[\\\\/]better-sqlite3[\\\\/]package.json$/.test(String(file)) ? false : exists(file);
    require('child_process').execFileSync = () => { throw Object.assign(new Error('synthetic install failure'), {code: 'ENOENT'}); };
  `);
  const child = cliWith({ NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }, 'install');
  assert.equal(child.status, 1);
  const entries = readErrors();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].component, 'install');
  assert.equal(entries[0].error.code, 'ENOENT');
  assert.match(entries[0].repro, /install.js' install$/);
});
test('explorer dependency failure is journaled once through both CLI boundaries', () => {
  readErrors({ clear: true });
  const preload = path.join(home, 'explorer-failure.cjs');
  fs.writeFileSync(preload, `
    const Module = require('module'), load = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'better-sqlite3') throw Object.assign(new Error('synthetic native failure'), {code: 'ERR_DLOPEN_FAILED'});
      return load.call(this, id, ...args);
    };
  `);
  const child = cliWith({ NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }, 'explore', '--no-open', '--workspace', home);
  assert.equal(child.status, 1, child.stderr);
  const entries = readErrors();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].component, 'explore');
  assert.equal(entries[0].error.code, 'ERR_DLOPEN_FAILED');
  const direct = spawnSync(process.execPath, [path.join(ROOT, 'explore-server.js'), '--no-open', '--workspace', home], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }, timeout: 10000
  });
  assert.equal(direct.status, 1);
  assert.equal(readErrors().length, 2);
});

if (previousHome === undefined) delete process.env.CAIPIRA_HOME;
else process.env.CAIPIRA_HOME = previousHome;
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
