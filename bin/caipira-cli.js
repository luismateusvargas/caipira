#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const RUNTIME = require('../runtime');

const NODE_VERSION = RUNTIME.NODE_VERSION;

function bundledNodePath(homeDir, platform = process.platform, arch = process.arch, report = process.report.getReport()) {
  return RUNTIME.runtimePaths(homeDir, RUNTIME.selectArchive(platform, arch, report)).node;
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
  if (args[0] === 'install' || !args.length) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'install.js'), ...(args.length ? args : ['install'])], { stdio: 'inherit' });
    if (result.error) {
      console.error(`[caipira] could not start installer with host Node: ${result.error.message}`);
      process.exitCode = 1;
    } else process.exitCode = typeof result.status === 'number' ? result.status : 1;
    return;
  }

  let bundledNode;
  try { bundledNode = resolveBundledNode(homeDir); }
  catch (error) {
    console.error(`[caipira] ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!bundledNode || !RUNTIME.runtimeWorks(bundledNode)) {
    console.error('[caipira] deployment runtime is missing or invalid; run caipira install first');
    process.exitCode = 1;
    return;
  }
  const installScript = path.join(homeDir, 'install.js');
  if (!fs.existsSync(installScript)) {
    console.error('[caipira] deployment is incomplete; run caipira install first');
    process.exitCode = 1;
    return;
  }
  const result = spawnSync(bundledNode, [installScript, ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`[caipira] could not start bundled Node ${NODE_VERSION} at ${bundledNode}: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) main();

module.exports = { bundledNodePath, resolveBundledNode, main };
