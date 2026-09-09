#!/usr/bin/env node
// caipira/hooks/session-end.js — CodeWhale session_end hook
// Closes caipira session. Direct SQLite — no CLI subprocess.

const { MemoryStore } = require('../store');

function processPayload(chunks) {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { payload = {}; }

  const sessionId = payload.session_id || process.env.DEEPSEEK_SESSION_ID;
  if (!sessionId) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'no session_id' }));
    return;
  }

  try {
    const store = new MemoryStore();
    store.endSession(sessionId);

    // Generate session summary from turn summaries
    const summaries = store.listSummaries(sessionId);
    const turnSummaries = summaries.filter(s => s.scope === 'turn');
    if (turnSummaries.length > 0) {
      const combined = turnSummaries.map(s => s.content).join('\n');
      store.addSummary({
        session_id: sessionId,
        scope: 'session',
        content: combined.slice(0, 2000)
      });
    }

    store.close();
    process.stdout.write(JSON.stringify({ ok: true, session_id: sessionId }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
  }
}

function main() {
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => processPayload(chunks));

  // If stdin was already closed before listener registered (race with
  // CodeWhale's CREATE_SUSPENDED + immediate pipe-close), fire immediately.
  if (process.stdin.readableEnded) {
    processPayload(chunks);
  }
}

main();
