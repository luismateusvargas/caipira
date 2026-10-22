'use strict';

// Deterministic provisioning/refresh checks use real filesystem transactions and
// injected network/process boundaries; no downloaded runtime or native addon is
// modified, and this suite can run on the documented older Node 22 interpreter.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const runtime = require('../runtime');
const ROOT = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'caipira-runtime-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
let pass = 0, fail = 0, sequence = 0;

function check(label, run) {
  try { run(); pass++; console.log(`  ok   ${label}`); }
  catch (error) { fail++; console.log(`  FAIL ${label} -> ${error.stack}`); }
}

async function checkAsync(label, run) {
  try { await run(); pass++; console.log(`  ok   ${label}`); }
  catch (error) { fail++; console.log(`  FAIL ${label} -> ${error.stack}`); }
}

function directory(label) {
  const dir = path.join(scratch, `${++sequence}-${label}`);
  fs.mkdirSync(dir);
  return dir;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function temporaryEntries(home) {
  return fs.readdirSync(home).filter(name => name.startsWith('.node-download-') || name.startsWith('.dependencies-'));
}

const bytes = Buffer.from('checksum-verified archive fixture');
const archive = { ...runtime.ARCHIVES['linux-x64'], sha256: createHash('sha256').update(bytes).digest('hex') };

function runtimeAdapters({ badChecksum = false, extractFailure = false, wrongVersion = false } = {}) {
  const calls = { download: 0, extract: 0, exec: [] };
  return {
    calls,
    async download(selected, file) {
      calls.download++;
      assert.equal(selected.url, archive.url);
      write(file, badChecksum ? 'tampered bytes' : bytes);
    },
    async extract(selected, file, staging) {
      calls.extract++;
      assert.deepEqual(fs.readFileSync(file), bytes);
      if (extractFailure) throw new Error('fixture extraction failed');
      write(path.join(staging, selected.release, 'bin/node'), wrongVersion ? 'v20.0.0' : `v${runtime.NODE_VERSION}`);
    },
    exec(node, args, options) {
      calls.exec.push({ node, args, options });
      assert.deepEqual(args, ['--version']);
      assert(options.timeout > 0);
      return fs.readFileSync(node, 'utf8');
    }
  };
}

function dependencyFixture({ identical = false, lockOnly = false, failure = null, sqliteBroken = false } = {}) {
  const home = directory('deployment'), manifest = directory('manifest');
  const oldManifest = '{"name":"runtime-fixture","version":"1.0.0"}\n';
  const newManifest = '{"name":"runtime-fixture","version":"2.0.0"}\n';
  const oldLock = '{"lockfileVersion":3,"fixture":"old"}\n';
  const newLock = '{"lockfileVersion":3,"fixture":"new"}\n';
  for (const [name, value] of [['package.json', newManifest], ['package-lock.json', newLock]]) write(path.join(manifest, name), value);
  write(path.join(home, 'package.json'), identical || lockOnly ? newManifest : oldManifest);
  write(path.join(home, 'package-lock.json'), identical ? newLock : oldLock);
  write(path.join(home, 'node_modules/better-sqlite3/package.json'), '{"version":"old"}');
  write(path.join(home, 'node_modules/@xenova/transformers/src/pipelines.js'), 'old transformer code');
  write(path.join(home, 'node_modules/obsolete/file.js'), 'remove me on refresh');
  const before = ['package.json', 'package-lock.json', 'node_modules/better-sqlite3/package.json',
    'node_modules/@xenova/transformers/src/pipelines.js', 'node_modules/obsolete/file.js']
    .map(name => [name, fs.readFileSync(path.join(home, name))]);
  const paths = runtime.runtimePaths(home, archive);
  const calls = [];
  const exec = (node, args, options) => {
    assert.equal(node, paths.node);
    assert(options.timeout > 0);
    calls.push({ node, args, options });
    if (args[0] === paths.npm) {
      assert.deepEqual(args.slice(1), ['ci', '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund']);
      assert.equal(options.env.PATH.split(path.delimiter)[0], path.dirname(paths.node));
      assert.equal(fs.readFileSync(path.join(options.cwd, 'package-lock.json'), 'utf8'), newLock);
      write(path.join(options.cwd, 'node_modules/better-sqlite3/package.json'), '{"version":"new"}');
      write(path.join(options.cwd, 'node_modules/@xenova/transformers/src/pipelines.js'), 'new transformer code');
      if (failure === 'npm') throw new Error('fixture npm failed');
      return;
    }
    assert.equal(args[0], '-e');
    assert(args[1].includes("new Database(':memory:')") && args[1].includes('db.close()'));
    const live = args[2] === path.join(home, 'node_modules/better-sqlite3');
    const content = JSON.parse(fs.readFileSync(path.join(args[2], 'package.json'), 'utf8'));
    if (failure === 'staged' && !live) throw new Error('fixture staged SQLite failed');
    if (failure === 'promoted' && live && content.version === 'new') throw new Error('fixture promoted SQLite failed');
    if (sqliteBroken && live && content.version === 'old') throw new Error('fixture ABI mismatch');
  };
  return { home, manifest, paths, calls, before, exec, newManifest, newLock };
}

async function main() {
  console.log('\n1. pinned platform and package contracts');
  check('Node pin and timeouts are explicit and bounded', () => {
    assert.equal(runtime.NODE_VERSION, '22.23.4');
    for (const name of ['DOWNLOAD_TIMEOUT_MS', 'EXTRACT_TIMEOUT_MS', 'DEPENDENCY_TIMEOUT_MS', 'PROBE_TIMEOUT_MS']) {
      assert(Number.isFinite(runtime[name]) && runtime[name] > 0 && runtime[name] <= 600_000);
    }
    assert.equal(typeof runtime.CLIENT_SELECTION_FILE, 'string');
    assert(!path.isAbsolute(runtime.CLIENT_SELECTION_FILE));
  });
  const expectedTargets = [
    ['linux', 'x64', { header: { glibcVersionRuntime: '2.31' } }, 'linux-x64'],
    ['linux', 'arm64', { header: { glibcVersionRuntime: '2.31' } }, 'linux-arm64'],
    ['linux', 'x64', { header: {} }, 'linux-x64-musl'],
    ['darwin', 'arm64', { header: {} }, 'darwin-arm64'],
    ['darwin', 'x64', { header: {} }, 'darwin-x64'],
    ['win32', 'x64', { header: {} }, 'win32-x64'],
    ['win32', 'arm64', { header: {} }, 'win32-arm64']
  ];
  for (const [platform, arch, report, target] of expectedTargets) check(`archive selection and paths: ${target}`, () => {
    const selected = runtime.selectArchive(platform, arch, report);
    assert.equal(selected, runtime.ARCHIVES[target]);
    assert.equal(selected.target, target);
    assert.match(selected.sha256, /^[a-f0-9]{64}$/);
    assert(selected.file.includes(`node-v${runtime.NODE_VERSION}-`));
    assert(selected.url.endsWith(`/v${runtime.NODE_VERSION}/${selected.file}`));
    assert(selected.url.startsWith(target.endsWith('musl') ? 'https://unofficial-builds.nodejs.org/' : 'https://nodejs.org/'));
    assert(selected.file.endsWith(platform === 'win32' ? '.zip' : '.tar.gz'));
    const paths = runtime.runtimePaths(scratch, selected);
    assert.equal(paths.node, path.join(scratch, 'node22', selected.release, platform === 'win32' ? 'node.exe' : 'bin/node'));
    assert(paths.npm.endsWith(path.join('node_modules', 'npm', 'bin', 'npm-cli.js')));
    assert.notEqual(paths.node, process.execPath);
  });
  for (const version of ['2.28', '2.29', '3.0']) check(`glibc ${version} meets the minimum supported version`, () => {
    assert.equal(runtime.selectArchive('linux', 'x64', { header: { glibcVersionRuntime: version } }).target, 'linux-x64');
  });
  check('glibc below 2.28 is refused with the supported minimum', () => assert.throws(
    () => runtime.selectArchive('linux', 'x64', { header: { glibcVersionRuntime: '2.27' } }),
    error => /glibc 2\.27/.test(error.message) && /2\.28\+/.test(error.message)));
  for (const glibcVersionRuntime of ['', 'unknown']) check(`unrecognized glibc report ${JSON.stringify(glibcVersionRuntime)} is refused`, () => assert.throws(
    () => runtime.selectArchive('linux', 'x64', { header: { glibcVersionRuntime } }), /supported glibc is 2\.28\+/));
  check('archive table contains only verified targets', () => assert.deepEqual(Object.keys(runtime.ARCHIVES).sort(), expectedTargets.map(row => row[3]).sort()));
  for (const [platform, arch, report] of [['linux', 'arm64', { header: {} }], ['linux', 'riscv64', { header: {} }], ['freebsd', 'x64', { header: {} }]]) {
    check(`unsupported ${platform}-${arch} reports supported targets`, () => assert.throws(() => runtime.selectArchive(platform, arch, report), error =>
      /unsupported/.test(error.message) && expectedTargets.every(row => error.message.includes(row[3]))));
  }
  check('root bootstrap has no runtime or optional dependencies', () => {
    const manifest = require('../package.json');
    assert.equal(manifest.engines.node, '>=20');
    assert.equal(Object.keys(manifest.dependencies || {}).length, 0);
    assert.equal(Object.keys(manifest.optionalDependencies || {}).length, 0);
    for (const name of ['runtime.js', 'runtime/package.json', 'runtime/package-lock.json']) assert(manifest.files.includes(name));
  });
  check('required SQLite and all package versions agree with runtime lockfile', () => {
    const root = require('../package.json'), manifest = require('../runtime/package.json');
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime/package-lock.json'), 'utf8'));
    assert.equal(manifest.dependencies['better-sqlite3'], '12.9.0');
    assert(!manifest.optionalDependencies?.['better-sqlite3']);
    assert.equal(manifest.version, root.version);
    assert.equal(lock.version, root.version);
    assert.equal(lock.packages[''].version, root.version);
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    assert.equal(lock.packages['node_modules/better-sqlite3'].version, '12.9.0');
    assert(!lock.packages['node_modules/better-sqlite3'].optional);
  });
  check('entry points, README, installer and release workflow agree on the Node pin', () => {
    for (const name of ['install.js', 'bin/caipira-cli.js', 'caipira.sh', 'caipira.cmd', 'README.md', '.github/workflows/release.yml']) {
      const content = fs.readFileSync(path.join(ROOT, name), 'utf8');
      const pins = [...content.matchAll(/\b22\.\d+\.\d+\b/g)].map(match => match[0]);
      assert(!pins.some(pin => pin !== runtime.NODE_VERSION), `${name}: inconsistent pin ${pins.join(', ')}`);
      assert(content.includes(runtime.NODE_VERSION) || /NODE_VERSION|runtime/.test(content), `${name}: no shared Node version`);
    }
  });
  check('runtime version probe rejects wrong versions and execution failures', () => {
    assert(runtime.runtimeWorks('/fixture/node', () => `v${runtime.NODE_VERSION}\n`));
    assert(!runtime.runtimeWorks('/fixture/node', () => 'v22.20.0\n'));
    assert(!runtime.runtimeWorks('/fixture/node', () => { throw new Error('missing binary'); }));
  });

  console.log('\n2. checksum-verified transactional provisioning');
  await checkAsync('checksum mismatch leaves no runtime, clients or temporary archive', async () => {
    const home = directory('checksum-empty'), adapters = runtimeAdapters({ badChecksum: true });
    await assert.rejects(runtime.provisionRuntime(home, archive, adapters), error => error.message.includes(archive.url) && /checksum mismatch/.test(error.message));
    assert.equal(adapters.calls.extract, 0);
    assert.deepEqual(fs.readdirSync(home), []);
  });
  await checkAsync('partial download failure names URL and cleans up without touching prior runtime', async () => {
    const home = directory('partial-download'), paths = runtime.runtimePaths(home, archive);
    write(paths.node, 'v22.20.0');
    const adapters = runtimeAdapters();
    adapters.download = async (selected, file) => {
      write(file, 'partial archive');
      throw new Error('fixture connection interrupted');
    };
    await assert.rejects(runtime.provisionRuntime(home, archive, adapters), error =>
      error.message.includes(archive.url) && error.message.includes('connection interrupted'));
    assert.equal(fs.readFileSync(paths.node, 'utf8'), 'v22.20.0');
    assert.equal(adapters.calls.extract, 0);
    assert.deepEqual(temporaryEntries(home), []);
  });
  for (const failure of ['checksum', 'extract', 'version']) await checkAsync(`${failure} failure preserves existing runtime byte for byte`, async () => {
    const home = directory('checksum-existing'), paths = runtime.runtimePaths(home, archive);
    write(paths.node, 'v22.20.0');
    write(path.join(paths.directory, 'keep.txt'), 'old runtime marker');
    const adapters = runtimeAdapters({ badChecksum: failure === 'checksum', extractFailure: failure === 'extract', wrongVersion: failure === 'version' });
    await assert.rejects(runtime.provisionRuntime(home, archive, adapters), error => error.message.includes(archive.url));
    assert.equal(fs.readFileSync(paths.node, 'utf8'), 'v22.20.0');
    assert.equal(fs.readFileSync(path.join(paths.directory, 'keep.txt'), 'utf8'), 'old runtime marker');
    assert.deepEqual(temporaryEntries(home), []);
  });
  await checkAsync('successful provision promotes verified binary and reuses it without network', async () => {
    const home = directory('provision'), adapters = runtimeAdapters();
    const paths = await runtime.provisionRuntime(home, archive, adapters);
    assert.deepEqual(paths, runtime.runtimePaths(home, archive));
    assert.equal(fs.readFileSync(paths.node, 'utf8'), `v${runtime.NODE_VERSION}`);
    assert.deepEqual(temporaryEntries(home), []);
    assert.deepEqual(await runtime.provisionRuntime(home, archive, { ...adapters, download() { throw new Error('reuse must not download'); }, extract() { throw new Error('reuse must not extract'); } }), paths);
    assert.equal(adapters.calls.download, 1);
    assert.equal(adapters.calls.extract, 1);
  });
  await checkAsync('wrong existing runtime is replaced only after staged version verification', async () => {
    const home = directory('upgrade'), paths = runtime.runtimePaths(home, archive);
    write(paths.node, 'v22.20.0');
    write(path.join(paths.directory, 'obsolete'), 'old');
    await runtime.provisionRuntime(home, archive, runtimeAdapters());
    assert.equal(fs.readFileSync(paths.node, 'utf8'), `v${runtime.NODE_VERSION}`);
    assert(!fs.existsSync(path.join(paths.directory, 'obsolete')));
    assert.deepEqual(temporaryEntries(home), []);
  });

  console.log('\n3. locked dependency refresh and rollback');
  check('unchanged manifests and healthy SQLite skip npm entirely', () => {
    const fixture = dependencyFixture({ identical: true });
    assert.equal(runtime.installDependencies(fixture.home, fixture.manifest, fixture), false);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].args[0], '-e');
    assert.deepEqual(temporaryEntries(fixture.home), []);
  });
  for (const [label, options] of [
    ['changed manifests refresh the complete dependency tree', {}],
    ['changed lockfile alone refreshes the complete dependency tree', { lockOnly: true }],
    ['broken SQLite repairs an unchanged lockfile', { identical: true, sqliteBroken: true }]
  ]) check(label, () => {
    const fixture = dependencyFixture(options);
    assert.equal(runtime.installDependencies(fixture.home, fixture.manifest, fixture), true);
    assert.equal(fs.readFileSync(path.join(fixture.home, 'package.json'), 'utf8'), fixture.newManifest);
    assert.equal(fs.readFileSync(path.join(fixture.home, 'package-lock.json'), 'utf8'), fixture.newLock);
    assert.equal(fs.readFileSync(path.join(fixture.home, 'node_modules/@xenova/transformers/src/pipelines.js'), 'utf8'), 'new transformer code');
    assert(!fs.existsSync(path.join(fixture.home, 'node_modules/obsolete')));
    assert.equal(fixture.calls.filter(call => call.args[0] === fixture.paths.npm).length, 1);
    assert.equal(fixture.calls.at(-1).args[2], path.join(fixture.home, 'node_modules/better-sqlite3'));
    assert.deepEqual(temporaryEntries(fixture.home), []);
  });
  check('deployed reinstall repairs dependencies using its own unchanged manifests', () => {
    const fixture = dependencyFixture({ identical: true, sqliteBroken: true });
    assert.equal(runtime.installDependencies(fixture.home, fixture.home, fixture), true);
    assert.equal(fs.readFileSync(path.join(fixture.home, 'package.json'), 'utf8'), fixture.newManifest);
    assert.equal(fs.readFileSync(path.join(fixture.home, 'package-lock.json'), 'utf8'), fixture.newLock);
    assert.equal(fs.readFileSync(path.join(fixture.home, 'node_modules/@xenova/transformers/src/pipelines.js'), 'utf8'), 'new transformer code');
    assert.deepEqual(temporaryEntries(fixture.home), []);
  });
  for (const failure of ['npm', 'staged', 'promoted']) check(`${failure} failure restores previous modules and both manifests`, () => {
    const fixture = dependencyFixture({ failure });
    assert.throws(() => runtime.installDependencies(fixture.home, fixture.manifest, fixture), /previous dependencies retained/);
    for (const [name, value] of fixture.before) assert.deepEqual(fs.readFileSync(path.join(fixture.home, name)), value);
    assert.deepEqual(temporaryEntries(fixture.home), []);
  });
  check('fresh-process SQLite probe instantiates and closes the database', () => {
    const fixture = dependencyFixture();
    runtime.verifySqlite(fixture.home, fixture.paths, fixture.exec);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].node, fixture.paths.node);
    assert.equal(fixture.calls[0].options.stdio, 'pipe');
  });
  check('superseded Node releases are removed without touching current or unrelated data', () => {
    const home = directory('cleanup'), current = runtime.runtimePaths(home);
    write(current.node, 'current');
    write(path.join(home, 'node22/node-v22.20.0-linux-x64/bin/node'), 'old');
    write(path.join(home, 'node22/unrelated/keep'), 'keep');
    const warnings = [];
    runtime.removeSupersededRuntimes(home, message => warnings.push(message));
    assert.equal(fs.readFileSync(current.node, 'utf8'), 'current');
    assert(!fs.existsSync(path.join(home, 'node22/node-v22.20.0-linux-x64')));
    assert.equal(fs.readFileSync(path.join(home, 'node22/unrelated/keep'), 'utf8'), 'keep');
    assert.deepEqual(warnings, []);
  });
}

main().catch(error => check('runtime checks complete', () => { throw error; })).finally(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
});
