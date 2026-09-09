#!/usr/bin/env node
// caipira/hooks/system-inject.js — CodeWhale session_start hook
// Injects compressed-response examples (few-shot) + reasoning compression rules.
// Experiment proved: few-shot examples -> 55% output reduction
// vs 22% from abstract CAIPIRA MODE rules.
// Added: reasoning compression rules to reduce thinking/reasoning token waste.

const fs = require('fs');
const path = require('path');
const os = require('os');

function getActiveMode() {
  const flagPath = path.join(os.homedir(), '.caipira', 'active');
  try {
    const mode = fs.readFileSync(flagPath, 'utf8').trim();
    if (['lite', 'full', 'ultra'].includes(mode)) return mode;
  } catch {}
  return 'full';
}

// Reasoning compression — reduces thinking/reasoning token waste
const REASONING_RULES = [
  "REASONING RULES (thinking/reasoning blocks only — not final replies):",
  "- Short: 3-5 lines max. No narration, no filler.",
  "- No self-reflection. Drop: I think, Let me consider, Hmm, Actually.",
  "- No planning theater. State action, then do it.",
  "- Facts only. Skip explaining what you already know.",
  "- Single cause before fix. Skip listing many theories.",
  "- Fragments OK. Drop articles in reasoning too.",
  "- If code matches, show it. If it fails, show the error.",
  "",
  "Example BAD reasoning (verbose, wasteful):",
  "  I think the issue might be related to hooks config.",
  "  Let me consider what could be wrong. There are several",
  "  possibilities: 1) path wrong, 2) node not found...",
  "",
  "Example GOOD reasoning (short, direct, factual):",
  "  Hooks fail silently. Check: 1) paths, 2) node on PATH,",
  "  3) exit codes. Read hooks.toml first.",
  "",
  "Apply to ALL reasoning/thinking output. Saves tokens."
].join('\n');

// Few-shot examples — model learns output style from these
const FEWSHOT = {
  lite: REASONING_RULES + '\n\n' +
    'Reply in compressed style. Strip filler words but keep full sentences. Examples:\n\n' +
    'Q: how do I set up a reverse proxy with nginx for a node app?\n' +
    'A: Create nginx server block with location / proxy_pass to http://localhost:3000. Set Host header. Reload.\n\n' +
    'Q: explain the difference between a thread and a process\n' +
    'A: Process: independent execution unit, own memory space. Thread: lightweight unit within a process, shares memory. OS schedules threads, not processes.\n\n' +
    'Reply in this exact style. Code blocks stay normal.',

  full: REASONING_RULES + '\n\n' +
    'Reply terse. Drop articles and filler. Fragments OK. Examples:\n\n' +
    'Q: how configure nginx reverse proxy for node app on port 3000?\n' +
    'A: nginx server block -> location / -> proxy_pass http://localhost:3000. Set proxy_set_header Host. Reload.\n\n' +
    'Q: diff btwn thread and process?\n' +
    'A: Process: own memory, heavy. Thread: shares memory, light. OS schedules threads. IPC needed for processes, not threads.\n\n' +
    'Q: git remove commits from history safely?\n' +
    'A: git rebase -i HEAD~N -> mark commits drop/squash. Or git reset --soft HEAD~N for recent. Force push after: git push --force-with-lease. Backup branch first.\n\n' +
    'Reply in this exact compressed style. No articles. Fragments. Code blocks stay normal.',

  ultra: REASONING_RULES + '\n\n' +
    'Reply ultra-compressed. Abbreviate prose (DB/auth/config/fn/impl). Strip conjunctions. Arrows for causality. Examples:\n\n' +
    'Q: how cfg nginx reverse proxy node app port 3000?\n' +
    'A: nginx srv block -> loc / -> proxy_pass http://localhost:3000. Set proxy_set_header Host. Reload.\n\n' +
    'Q: diff btwn thread and process?\n' +
    'A: Process: own mem, heavy, IPC. Thread: shared mem, light, same addr space. OS schedules threads.\n\n' +
    'Q: SQL top 5 customers by order val last 30 days?\n' +
    "A: SELECT c.id, c.name, SUM(o.total) FROM customers c JOIN orders o ON c.id = o.customer_id WHERE o.created_at >= NOW() - INTERVAL '30 days' GROUP BY c.id, c.name ORDER BY SUM(o.total) DESC LIMIT 5;\n\n" +
    'Q: git remove commits from history?\n' +
    'A: git rebase -i HEAD~N -> mark commits drop/squash -> git push --force-with-lease. Backup branch first.\n\n' +
    'Reply in this exact style. Abbreviate prose words. NEVER abbreviate code/identifiers/API names/error strings/file paths. Code blocks stay normal.'
};

function processPayload() {
  const intensity = getActiveMode();
  const rules = FEWSHOT[intensity] || FEWSHOT.full;
  process.stdout.write(JSON.stringify({
    additionalContext: rules,
    decision: 'allow'
  }));
}

function main() {
  const chunks = [];
  process.stdin.on('data', function(c) { chunks.push(c); });
  process.stdin.on('end', processPayload);

  // If stdin was already closed before listener registered (race with
  // CodeWhale's CREATE_SUSPENDED + immediate pipe-close), fire immediately.
  if (process.stdin.readableEnded) {
    processPayload();
  }
}

main();
