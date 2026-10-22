#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE_VERSION = '22.20.0';

function bundledNodePath(homeDir, platform = process.platform, arch = process.arch) {
  const releasePlatform = platform === 'win32' ? 'win' : platform;
  const releaseDir = `node-v${NODE_VERSION}-${releasePlatform}-${arch}`;
  const executable = platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
  return path.join(homeDir, 'node22', releaseDir, executable);
}

function resolveBundledNode(homeDir, platform = process.platform, arch = process.arch) {
  const candidate = bundledNodePath(homeDir, platform, arch);
  try {
    fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function main(args = process.argv.slice(2)) {
  const homeDir = process.env.CAIPIRA_HOME
    ? path.resolve(process.env.CAIPIRA_HOME)
    : path.join(os.homedir(), '.caipira');
  const bundledNode = resolveBundledNode(homeDir);
  const installScript = path.join(__dirname, '..', 'install.js');

  const hostMajor = Number(String(process.versions.node).split('.')[0]);
  // better-sqlite3 prebuilds are Node-ABI-specific. Keep Node 20 and 24 on
  // the host runtime that npm installed for; the bundled runtime is Node 22.
  if (!bundledNode || hostMajor !== 22) {
    require('../install');
    return;
  }

  const result = spawnSync(bundledNode, [installScript, ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`[caipira] could not start bundled Node 22 at ${bundledNode}: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) main();

module.exports = { bundledNodePath, resolveBundledNode, main };
