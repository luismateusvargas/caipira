#!/usr/bin/env node
// caipira/test/run-all.js — runs every suite with the bundled Node 22.
//
//   .\node22\node-v22.20.0-win-x64\node.exe test\run-all.js
//
// Every suite runs against a throwaway CAIPIRA_HOME, so no run can leave
// workspace databases behind in ~/.caipira/database.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = path.join(ROOT, 'node22', 'node-v22.20.0-win-x64', 'node.exe');

const SUITES = ['test-workspace', 'test-facts', 'test-inject', 'test-mcp', 'test-hook'];

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'caipira-home-'));
const ENV = { ...process.env, CAIPIRA_HOME: HOME };

let failed = 0;
for (const suite of SUITES) {
  process.stdout.write(`\n===== ${suite} =====\n`);
  try {
    const out = execFileSync(NODE, [path.join(__dirname, `${suite}.js`)], { encoding: 'utf8', env: ENV });

    const summary = out.trim().split('\n').filter(l => /passed,/.test(l)).pop();
    process.stdout.write((summary || out).trim() + '\n');
  } catch (error) {
    failed++;
    const text = `${error.stdout || ''}${error.stderr || ''}`;
    process.stdout.write(text.split('\n').filter(l => /FAIL|passed,|Error/.test(l)).join('\n') + '\n');
  }
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}

process.stdout.write(failed === 0 ? '\nAll suites passed.\n' : `\n${failed} suite(s) failed.\n`);
process.exitCode = failed === 0 ? 0 : 1;
