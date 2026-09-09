#!/usr/bin/env node
// caipira/hooks/proxy-start.js — session_start hook
// Checks if caipira-proxy is running; spawns it if not.
// Returns immediately — doesn't wait for proxy to listen.

const { exec } = require('child_process');
const net = require('net');
const path = require('path');
const os = require('os');

const PROXY_PORT = 8787;
const PROXY_SCRIPT = path.join(os.homedir(), '.codewhale', 'caipira-proxy.js');

function checkPort(port, host) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

async function main() {
  const alive = await checkPort(PROXY_PORT, '127.0.0.1');
  if (alive) {
    process.stderr.write('[caipira-proxy-start] proxy already running on :8787\n');
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // Spawn proxy as detached background process on Windows
  const cmd = `start "caipira-proxy" /B /MIN cmd /c "node ${PROXY_SCRIPT} --port ${PROXY_PORT} --intensity ultra"`;
  exec(cmd, { windowsHide: true }, (err) => {
    if (err) {
      process.stderr.write('[caipira-proxy-start] spawn failed: ' + err.message + '\n');
    }
  });

  process.stderr.write('[caipira-proxy-start] spawned proxy process\n');
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
}

main().catch(e => {
  process.stderr.write('[caipira-proxy-start] error: ' + e.message + '\n');
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
});
