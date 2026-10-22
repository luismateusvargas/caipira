'use strict';

// Bootstrap-only infrastructure: this module has no third-party dependencies.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const NODE_VERSION = '22.23.4';
const DOWNLOAD_TIMEOUT_MS = 180_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const DEPENDENCY_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 15_000;
const CLIENT_SELECTION_FILE = '.caipira-clients.json';
const ARCHIVES = Object.freeze(Object.fromEntries([
  ['linux-x64', 'linux-x64', 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406'],
  ['linux-arm64', 'linux-arm64', 'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9'],
  ['linux-x64-musl', 'linux-x64-musl', '117eae38a39e45d534f1a18c2217709dc0b09835f61689af490137de231eb42c'],
  ['darwin-arm64', 'darwin-arm64', 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428'],
  ['darwin-x64', 'darwin-x64', 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819'],
  ['win32-x64', 'win-x64', 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'],
  ['win32-arm64', 'win-arm64', 'a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111']
].map(([target, suffix, sha256]) => {
  const release = `node-v${NODE_VERSION}-${suffix}`;
  const file = `${release}.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`;
  const base = target.endsWith('-musl') ? 'https://unofficial-builds.nodejs.org/download/release' : 'https://nodejs.org/dist';
  return [target, Object.freeze({ target, release, file, sha256, url: `${base}/v${NODE_VERSION}/${file}` })];
})));
const SUPPORTED_BINARY_TARGETS = new Set([
  'linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64'
]);

/** @param {string} [platform] Host platform. @param {string} [arch] Host architecture. @returns {string|null} Packaged caipira-ast asset name, or null when none ships. */
function platformBinaryName(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!SUPPORTED_BINARY_TARGETS.has(target)) return null;
  return `caipira-ast-${target}${platform === 'win32' ? '.exe' : ''}`;
}

/**
 * Selects the exact supported archive before any filesystem writes.
 * @param {string} [platform] Host platform.
 * @param {string} [arch] Host architecture.
 * @param {object} [report] Node diagnostic report, used to distinguish glibc/musl.
 * @returns {object} Pinned archive descriptor.
 * @throws {Error} When no checksum-verified build is available for this host.
 */
function selectArchive(platform = process.platform, arch = process.arch, report = process.report.getReport()) {
  const glibc = platform === 'linux' ? report.header?.glibcVersionRuntime : undefined;
  const hasGlibcReport = glibc !== undefined && glibc !== null;
  if (hasGlibcReport) {
    const version = /^(\d+)\.(\d+)(?:\.|$)/.exec(String(glibc));
    const supported = version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 28));
    if (!supported) {
      throw new Error(`unsupported Node ${NODE_VERSION} target linux-${arch} with glibc ${glibc}; supported glibc is 2.28+; supported targets: ${Object.keys(ARCHIVES).join(', ')}`);
    }
  }
  const target = `${platform}-${arch}${platform === 'linux' && !hasGlibcReport ? '-musl' : ''}`;
  if (!Object.hasOwn(ARCHIVES, target)) {
    throw new Error(`unsupported Node ${NODE_VERSION} target ${target}; supported targets: ${Object.keys(ARCHIVES).join(', ')}`);
  }
  return ARCHIVES[target];
}

/** @param {string} home Deployment root. @param {object} [archive] Archive descriptor. @returns {object} Absolute runtime paths. */
function runtimePaths(home, archive = selectArchive()) {
  const directory = path.join(home, 'node22', archive.release);
  const windows = archive.target.startsWith('win32');
  return {
    directory,
    node: path.join(directory, windows ? 'node.exe' : 'bin/node'),
    npm: path.join(directory, windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js')
  };
}

/** @param {string} node Interpreter path. @param {Function} [exec] Subprocess adapter. @returns {boolean} Whether it reports the pinned version. */
function runtimeWorks(node, exec = execFileSync) {
  try {
    return exec(node, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: 'pipe', windowsHide: true }).trim() === `v${NODE_VERSION}`;
  } catch { return false; }
}

/** @param {object} archive Archive descriptor. @param {string} destination Temporary file. @returns {Promise<void>} Downloads with a total deadline. */
async function downloadArchive(archive, destination) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(archive.url, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }), { signal });
}

function extractArchive(archive, file, destination) {
  const options = { timeout: EXTRACT_TIMEOUT_MS, stdio: 'pipe', windowsHide: true };
  if (archive.target.startsWith('win32')) {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:CAIPIRA_ARCHIVE -DestinationPath $env:CAIPIRA_EXTRACT"],
    { ...options, env: { ...process.env, CAIPIRA_ARCHIVE: file, CAIPIRA_EXTRACT: destination } });
  } else execFileSync('tar', ['-xzf', file, '-C', destination], options);
}

/**
 * Downloads, verifies and promotes a runtime without damaging an existing one.
 * @param {string} home Deployment root.
 * @param {object} [archive] Supported archive descriptor.
 * @param {object} [adapters] Download/extract/subprocess adapters for isolated verification.
 * @returns {Promise<object>} Paths to the verified deployment runtime.
 * @throws {Error} Names the archive URL on provisioning failure.
 */
async function provisionRuntime(home, archive = selectArchive(), adapters = {}) {
  const { download = downloadArchive, extract = extractArchive, exec = execFileSync } = adapters;
  const paths = runtimePaths(home, archive);
  if (runtimeWorks(paths.node, exec)) return paths;
  fs.mkdirSync(home, { recursive: true });
  const staging = fs.mkdtempSync(path.join(home, '.node-download-'));
  let previous = false, promoted = false, keepRecovery = false;
  try {
    const file = path.join(staging, archive.file);
    await download(archive, file);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== archive.sha256) throw new Error('SHA-256 checksum mismatch');
    await extract(archive, file, staging);
    const extracted = path.join(staging, archive.release);
    // Archives contain the release directory directly, not a node22 parent.
    const stagedNode = path.join(extracted, path.relative(paths.directory, paths.node));
    if (!runtimeWorks(stagedNode, exec)) throw new Error(`extracted binary does not report v${NODE_VERSION}`);
    fs.mkdirSync(path.dirname(paths.directory), { recursive: true });
    if (fs.existsSync(paths.directory)) {
      fs.renameSync(paths.directory, path.join(staging, 'previous'));
      previous = true;
    }
    fs.renameSync(extracted, paths.directory);
    promoted = true;
    return paths;
  } catch (error) {
    try {
      if (promoted) fs.rmSync(paths.directory, { recursive: true, force: true });
      if (previous) fs.renameSync(path.join(staging, 'previous'), paths.directory);
    } catch (rollbackError) {
      keepRecovery = true;
      throw new Error(`Node provisioning from ${archive.url} failed; recovery files retained at ${staging}`, { cause: new AggregateError([error, rollbackError]) });
    }
    throw new Error(`Node provisioning from ${archive.url} failed: ${error.message}`, { cause: error });
  } finally {
    if (!keepRecovery) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** @param {string} home Deployment root. @param {object} [paths] Runtime paths. @param {Function} [exec] Subprocess adapter. @returns {void} Opens SQLite in a fresh bundled process or throws. */
function verifySqlite(home, paths = runtimePaths(home), exec = execFileSync) {
  exec(paths.node, ['-e', "const Database = require(process.argv[1]); const db = new Database(':memory:'); db.close();",
    path.join(home, 'node_modules', 'better-sqlite3')], { timeout: PROBE_TIMEOUT_MS, stdio: 'pipe', windowsHide: true });
}

/**
 * Installs the locked runtime dependencies, then swaps and validates in fresh processes.
 * @param {string} home Deployment root.
 * @param {string} manifestDirectory Directory holding the runtime package and lockfile.
 * @param {object} [adapters] Runtime paths and subprocess adapter for isolated tests.
 * @returns {boolean} Whether dependencies were replaced (false means verified reuse).
 * @throws {Error} Keeps the previous modules and manifests on install or validation failure.
 */
function installDependencies(home, manifestDirectory, adapters = {}) {
  const { paths = runtimePaths(home), exec = execFileSync } = adapters;
  const names = ['package.json', 'package-lock.json'];
  const contents = names.map(name => fs.readFileSync(path.join(manifestDirectory, name)));
  const identical = names.every((name, i) => {
    try { return fs.readFileSync(path.join(home, name)).equals(contents[i]); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  if (identical) {
    try { verifySqlite(home, paths, exec); return false; } catch { /* Repair missing or ABI-incompatible native modules. */ }
  }
  fs.mkdirSync(home, { recursive: true });
  const staging = fs.mkdtempSync(path.join(home, '.dependencies-'));
  const promoted = [], backedUp = [];
  let keepRecovery = false;
  try {
    for (let i = 0; i < names.length; i++) fs.writeFileSync(path.join(staging, names[i]), contents[i]);
    exec(paths.node, [paths.npm, 'ci', '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund'], {
      cwd: staging, stdio: 'inherit', timeout: DEPENDENCY_TIMEOUT_MS, windowsHide: true,
      env: { ...process.env, PATH: `${path.dirname(paths.node)}${path.delimiter}${process.env.PATH || ''}` }
    });
    verifySqlite(staging, paths, exec);
    fs.mkdirSync(path.join(staging, 'previous'));
    for (const name of ['node_modules', ...names]) {
      const live = path.join(home, name);
      if (fs.existsSync(live)) {
        fs.renameSync(live, path.join(staging, 'previous', name));
        backedUp.push(name);
      }
      fs.renameSync(path.join(staging, name), live);
      promoted.push(name);
    }
    verifySqlite(home, paths, exec);
    return true;
  } catch (error) {
    try {
      for (const name of [...promoted].reverse()) fs.rmSync(path.join(home, name), { recursive: true, force: true });
      for (const name of [...backedUp].reverse()) fs.renameSync(path.join(staging, 'previous', name), path.join(home, name));
    } catch (rollbackError) {
      keepRecovery = true;
      throw new Error(`dependency refresh and rollback failed; recovery files retained at ${staging}`, { cause: new AggregateError([error, rollbackError]) });
    }
    const failure = new Error(`runtime dependency install failed; previous dependencies retained: ${error.message}`, { cause: error });
    if (error.code) failure.code = error.code;
    throw failure;
  } finally {
    if (!keepRecovery) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** @param {string} home Deployment root. @param {Function} warn Warning sink. @returns {void} Removes old Node 22 releases only after successful registration. */
function removeSupersededRuntimes(home, warn) {
  const current = runtimePaths(home).directory;
  const parent = path.dirname(current);
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    const directory = path.join(parent, entry.name);
    if (!entry.isDirectory() || !/^node-v22\./.test(entry.name) || directory === current) continue;
    try { fs.rmSync(directory, { recursive: true }); }
    catch (error) { warn(`could not remove superseded runtime ${directory}: ${error.message}`); }
  }
}

module.exports = { NODE_VERSION, ARCHIVES, DOWNLOAD_TIMEOUT_MS, EXTRACT_TIMEOUT_MS, DEPENDENCY_TIMEOUT_MS,
  PROBE_TIMEOUT_MS, CLIENT_SELECTION_FILE, platformBinaryName, selectArchive, runtimePaths, runtimeWorks, provisionRuntime,
  verifySqlite, installDependencies, removeSupersededRuntimes };
