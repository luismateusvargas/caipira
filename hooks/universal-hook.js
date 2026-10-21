#!/usr/bin/env node
// Shared Caipira lifecycle adapter for Codex, Claude Code, and Antigravity.
// Input arrives as one JSON object on stdin. The adapter always returns JSON
// and exits successfully so memory failures never block the coding client.

const path = require('path');
const { MemoryStore } = require('../store');
const { ensureWorkspace, machineId } = require('../workspace');
const { buildInjection, buildDriftNotice } = require('../inject');
const { FactStore } = require('../facts');
const { updateFileAst } = require('../ast');

const EVENT_ALIASES = new Map([
  ['session-start', 'session-start'],
  ['SessionStart', 'session-start'],
  ['user-prompt-submit', 'user-prompt-submit'],
  ['UserPromptSubmit', 'user-prompt-submit'],
  ['post-tool-use', 'post-tool-use'],
  ['PostToolUse', 'post-tool-use'],
  ['pre-invocation', 'pre-invocation'],
  ['PreInvocation', 'pre-invocation'],
  ['post-invocation', 'post-invocation'],
  ['PostInvocation', 'post-invocation'],
  ['stop', 'stop'],
  ['Stop', 'stop'],
  ['session-end', 'session-end'],
  ['SessionEnd', 'session-end']
]);

const CAIPIRA_STARTUP_INSTRUCTION = [
  'Caipira is the shared local-first cross-agent memory for Codex, Claude Code, and Antigravity.',
  'For prior work, project decisions, investigations, unfinished tasks, recurring bugs, or any cross-session context, call the Caipira MCP search tool first with focused terms.',
  'Use list_sessions, timeline, and get_observations only to refine the relevant results.',
  'Do not rely on Antigravity local brain/history as a substitute for Caipira cross-agent context.',
  'Caipira is already configured with its bundled Node 22 runtime; never try to launch it with the system Node 24.',
  // Facts fingerprint the files they came from, so "is this still true" is
  // already answered mechanically. Without this, the agent re-reads and
  // re-verifies what memory just told it, and the memory earns nothing.
  'An injected fact is a settled answer, not a hint: act on it directly.',
  'Do not re-read files, re-run checks, or confirm a tool exists just to reconfirm something a fact already states — caipira fingerprints each fact\'s evidence, so an unflagged fact is verified by construction.',
  'Re-derive only what is flagged NEEDS REVIEW, what no fact covers, or what the user contradicts.',
  // Nothing previously told any agent to WRITE, so the knowledge layer only
  // grew when the user asked for it.
  'Recording is your job, not the user\'s: call record_fact whenever something becomes settled that a future session would otherwise re-derive — a decision made, a constraint discovered, a preference stated, a gotcha hit, or the status of ongoing work — with the files it came from in evidence.',
  'For a fact about a specific function or type, include evidence_symbols so unrelated edits in that file leave the fact verified.',
  'Call update_fact when you find a recorded fact is wrong, outdated, or contradicted by what you just saw; revoke it if nothing replaces it, and record a replacement with supersedes if something does.',
  'Do not end a session leaving something you had to work out sitting only in the transcript.'
].join(' ');

const AST_STARTUP_INSTRUCTION = 'For code symbols, signatures, callers, and type connections, use Caipira workspace_symbols and inspect_symbol. Inspect cited source before editing.';

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function resolveEvent(payload) {
  const rawEvent = readArgument('--event', payload.hook_event_name || payload.event || '');
  return EVENT_ALIASES.get(rawEvent) || rawEvent.toLowerCase().replace(/_/g, '-');
}

function resolveClient(payload) {
  return readArgument('--client', payload.client || payload.ide || 'unknown');
}

function resolveSessionId(payload) {
  return payload.session_id || payload.sessionId || payload.conversationId || payload.conversation_id || null;
}

function resolveWorkspace(payload) {
  if (typeof payload.cwd === 'string' && payload.cwd) return payload.cwd;
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) return payload.workspacePaths[0];
  if (typeof payload.workspace === 'string' && payload.workspace) return payload.workspace;
  return null;
}

function safeText(value, maxLength = 6000) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
}

function describeTool(payload) {
  const toolCall = payload.toolCall || {};
  const toolName = payload.tool_name || payload.toolName || toolCall.name || 'unknown-tool';
  const error = payload.error || payload.tool_error || '';
  const result = payload.tool_response || payload.toolResponse || payload.response || '';
  return [
    `tool=${toolName}`,
    `args=${safeText(toolCall.args || payload.tool_input || payload.toolInput)}`,
    error ? `error=${safeText(error)}` : `result=${safeText(result)}`
  ].join('\n');
}

// Paths a tool call wrote to. Read-only tools are deliberately ignored: only
// a write can invalidate a fact, and re-verifying on reads would burn stats on
// every grep. Each client names the field differently, so all forms are tried.
const WRITE_TOOLS = /^(edit|write|edit_file|write_file|multiedit|multi_edit|notebookedit|str_replace|create_file|apply_patch)$/i;

// Codex apply_patch names its targets inside the patch text rather than in a
// field. A deleted evidence file invalidates a fact as surely as an edit.
const PATCH_TARGET = /^(?:\*\*\* (?:Update|Add|Delete) File: (.+)|\+\+\+ b\/(.+))$/gm;

function patchPaths(patch) {
  return Array.from(patch.matchAll(PATCH_TARGET), match => (match[1] || match[2]).trim());
}

function writtenPaths(payload) {
  const toolCall = payload.toolCall || {};
  const toolName = String(payload.tool_name || payload.toolName || toolCall.name || '');
  if (!WRITE_TOOLS.test(toolName)) return [];

  const args = toolCall.args || payload.tool_input || payload.toolInput || {};
  if (typeof args === 'string') return patchPaths(args);
  if (typeof args !== 'object') return [];

  const candidates = [
    args.file_path, args.filePath, args.path, args.Path,
    args.target_file, args.TargetFile, args.notebook_path
  ];
  for (const list of [args.edits, args.Replacements]) {
    if (!Array.isArray(list)) continue;
    for (const edit of list) candidates.push(edit && (edit.file_path || edit.filePath || edit.path || edit.Path));
  }
  for (const patch of [args.patch, args.input]) {
    if (typeof patch === 'string') candidates.push(...patchPaths(patch));
  }
  return [...new Set(candidates.filter(p => typeof p === 'string' && p.length > 0))];
}

// Antigravity fires pre-invocation before every model step. A payload with no
// counter is treated as the first, so standing facts are never lost outright.
function isFirstInvocation(payload) {
  return payload.invocationNum === 0 || payload.invocationNum === undefined;
}

function describeInvocation(payload) {
  return [
    `model=${payload.modelName || payload.model || 'unknown-model'}`,
    `invocation=${payload.invocationNum ?? payload.executionNum ?? 'unknown'}`,
    payload.error ? `error=${safeText(payload.error)}` : '',
    payload.terminationReason ? `termination=${safeText(payload.terminationReason)}` : ''
  ].filter(Boolean).join('\n');
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Recall the facts worth putting in front of the model for this event. Never
// allowed to throw or to be slow: memory is an accelerant, and a hook that
// fails must cost nothing but the recall it would have provided.
function recallContext(db, event, payload, workspace) {
  if (!db) return null;
  try {
    const opts = { machine: machineId() };
    const starting = event === 'session-start' || (event === 'pre-invocation' && isFirstInvocation(payload));

    // A git pull or another editor can move evidence between sessions with no
    // PostToolUse to notice, so a new session re-checks every fact before
    // anything is injected as settled.
    if (starting) new FactStore(db, { ...opts, agent: 'hook', root: workspace?.root }).verify();

    // Drift rides along with whatever else is being injected. It is appended
    // rather than gated on relevance: the fact that its evidence moved is
    // established, so the agent is told even when the prompt is unrelated.
    const drift = buildDriftNotice(db, opts);
    const prompt = payload.prompt || payload.userPrompt || '';
    const recalled = buildInjection(db, workspace, {
      ...opts, cwd: resolveWorkspace(payload) || workspace?.root,
      budget: 2400, prompt: event === 'session-start' ? '' : prompt
    });

    if (event === 'user-prompt-submit') {
      return [recalled, drift].filter(Boolean).join('\n\n') || null;
    }
    if (event === 'session-start') {
      return [recalled, drift].filter(Boolean).join('\n\n') || null;
    }
    // Standing facts open the conversation; repeating them before every step
    // would bury whatever the step actually recalled.
    if (event === 'pre-invocation') {
      return [starting ? recalled : prompt ? recalled : null, drift].filter(Boolean).join('\n\n') || null;
    }
    return null;
  } catch (error) {
    process.stderr.write(`[caipira-hook] recall skipped: ${error.message}\n`);
    return null;
  }
}

// Claude Code and Codex both read injected context from
// hookSpecificOutput.additionalContext, and both reject unknown top-level
// diagnostic fields, so they share one branch.
const HOOK_EVENT_NAMES = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  'stop': 'Stop',
  'session-end': 'SessionEnd'
};

function writeClientResult(result, event, client, payload, recalled) {
  if (client === 'codex' || client === 'claude-code') {
    // SessionStart and UserPromptSubmit carry recall. PostToolUse can carry
    // an AST reminder through its own additionalContext output.
    const canInject = event === 'session-start' || event === 'user-prompt-submit';
    if (canInject) {
      const parts = [];
      if (event === 'session-start') {
        parts.push(CAIPIRA_STARTUP_INSTRUCTION, AST_STARTUP_INSTRUCTION);
      }
      if (recalled) parts.push(recalled);

      if (parts.length > 0) {
        writeResult({
          hookSpecificOutput: {
            hookEventName: HOOK_EVENT_NAMES[event],
            additionalContext: parts.join('\n\n')
          }
        });
        return;
      }
    }
    if (event === 'post-tool-use' && result.reminder) {
      writeResult({
        hookSpecificOutput: {
          hookEventName: HOOK_EVENT_NAMES[event],
          additionalContext: result.reminder
        }
      });
      return;
    }
    writeResult(client === 'codex' ? {} : { continue: true });
    return;
  }

  if (client === 'antigravity' && event === 'pre-invocation') {
    const steps = [];
    if (isFirstInvocation(payload)) {
      steps.push(
        { ephemeralMessage: CAIPIRA_STARTUP_INSTRUCTION },
        { ephemeralMessage: AST_STARTUP_INSTRUCTION }
      );
    }
    if (recalled) steps.push({ ephemeralMessage: recalled });
    writeResult(steps.length ? { injectSteps: steps } : {});
    return;
  }

  if (client === 'antigravity' && ['post-tool-use', 'pre-invocation', 'post-invocation', 'stop'].includes(event)) {
    writeResult(event === 'post-tool-use' && result.reminder
      ? { injectSteps: [{ ephemeralMessage: result.reminder }] } : {});
    return;
  }
  writeResult(result);
}

// A write to a file some fact was derived from is the one drift signal that
// needs no judgement, so it is acted on the moment it happens rather than
// waiting for someone to call check_drift. Only the facts resting on the
// written paths are re-verified, and verify() itself stats before it hashes.
// Relative paths (Codex patches, Antigravity args) resolve against the cwd the
// client reported.
function verifyTouchedFacts(db, payload, workspacePath, workspaceRoot) {
  if (!db) return;
  const paths = writtenPaths(payload);
  if (paths.length === 0) return;

  try {
    const facts = new FactStore(db, { machine: machineId(), agent: 'hook', root: workspaceRoot });
    const ids = facts.factsForPaths(paths, workspacePath || undefined);
    if (ids.length) facts.verify(ids);
  } catch (error) {
    // Drift detection must never break the tool call that triggered it.
    process.stderr.write(`[caipira-hook] drift check skipped: ${error.message}\n`);
  }
}

function postToolAstDelta(db, workspace, payload) {
  if (!workspace || !db) return { reminder: null, symbols: [] };
  const changes = [];
  const symbols = [];
  for (const file of writtenPaths(payload)) {
    const absolute = path.resolve(resolveWorkspace(payload) || workspace.root, file);
    if (absolute !== workspace.root && !absolute.startsWith(`${workspace.root}${path.sep}`)) continue;
    let result;
    try {
      result = updateFileAst(workspace.root, workspace.dbFile, absolute, { timeoutMs: 2000 });
    } catch (error) {
      if (error.code !== 'unsupported' && error.code !== 'io') {
        process.stderr.write(`[caipira-hook] AST delta skipped: ${error.message}\n`);
      }
      continue;
    }
    const changed = [
      ...result.diff.modified.map(change => ({ before: change.before, after: change.after })),
      ...result.diff.removed.map(before => ({ before, after: null }))
    ];
    for (const { before: entry, after } of changed) {
      const anchored = db.prepare(`SELECT f.id, f.kind FROM fact_symbol_evidence e
        JOIN facts f ON f.id = e.fact_id WHERE e.path = ? AND e.qualified_name = ?
        AND f.state IN ('active','needs_review')`).all(result.path, entry.qualified_name);
      if (!entry.is_public && anchored.length === 0) continue;
      symbols.push(`${result.path}::${entry.qualified_name}`);
      const callers = db.prepare(`SELECT DISTINCT source_path, source_symbol, line FROM ast_edges
        WHERE edge_kind = 'calls' AND
          ((target_path = ? AND target_symbol IN (?, ?)) OR
           (target_path IS NULL AND target_symbol IN (?, ?)))
        ORDER BY source_path, line LIMIT 12`)
        .all(result.path, entry.qualified_name, entry.name, entry.qualified_name, entry.name);
      changes.push({ symbol: entry.qualified_name, path: result.path,
        signature: after ? `${entry.signature_text} → ${after.signature_text}` : `${entry.signature_text} (removed)`,
        callers: callers.map(c => `${c.source_path}::${c.source_symbol || '?'}:${c.line}`),
        facts: anchored.map(f => `[${f.kind}#${f.id}]`) });
    }
  }
  if (!changes.length) return { reminder: null, symbols };
  const lines = ['<system-reminder>', 'Caipira AST signature changes:'];
  for (const change of changes.slice(0, 8)) {
    lines.push(`- ${change.path}::${change.symbol}: ${change.signature}`);
    if (change.callers.length) lines.push(`  Callers: ${change.callers.join(', ')}`);
    if (change.facts.length) lines.push(`  Impacted facts: ${change.facts.join(', ')}`);
  }
  lines.push('</system-reminder>');
  return { reminder: lines.join('\n'), symbols };
}

function synthesizeSessionDigest(store, sessionId) {
  const db = store.storage.db;
  const existing = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(sessionId);
  if (!existing) return null;
  const rows = db.prepare(`SELECT content, metadata FROM observations
    WHERE session_id = ? AND kind = 'tool_result' ORDER BY id LIMIT 500`).all(sessionId);
  if (rows.length === 0) return existing.summary || null;
  const tools = new Set(), files = new Set(), symbols = new Set();
  for (const row of rows) {
    let meta = {};
    try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* old observation */ }
    const tool = meta.tool || /^tool=([^\n]+)/.exec(row.content)?.[1];
    if (tool) tools.add(tool);
    for (const file of meta.files || []) files.add(file);
    for (const symbol of meta.symbols || []) symbols.add(symbol);
  }
  const list = values => [...values].sort().slice(0, 6).join(', ');
  const summary = [`Tools: ${list(tools)} (${rows.length} calls)`,
    files.size ? `Files: ${list(files)}` : '', symbols.size ? `Symbols: ${list(symbols)}` : '']
    .filter(Boolean).join('; ').slice(0, 500);
  db.prepare('UPDATE sessions SET summary = ? WHERE id = ? AND (summary IS NULL OR summary != ?)')
    .run(summary, sessionId, summary);
  return summary;
}

// db is the store's own connection, or null when no workspace resolved and
// the store fell back to the legacy database, which holds no facts to check.
function captureEvent(store, event, payload, client, sessionId, workspacePath, db, workspace) {
  if (!sessionId) return { ok: false, skipped: true, reason: 'missing session identifier' };

  // A client whose start hook never fired still gets its session attributed.
  if (event === 'session-start' || event === 'pre-invocation') {
    store.startSession({ id: sessionId, ide: client, cwd: workspacePath });
  } else {
    store.ensureSession(sessionId, client, workspacePath);
  }

  if (event === 'user-prompt-submit' && payload.prompt) {
    store.addObservation({ session_id: sessionId, kind: 'user_prompt', content: payload.prompt });
  }

  if (event === 'post-tool-use') {
    const delta = postToolAstDelta(db, workspace, payload);
    store.addObservation({ session_id: sessionId, kind: 'tool_result', content: describeTool(payload),
      metadata: { tool: payload.tool_name || payload.toolName || payload.toolCall?.name || 'unknown-tool',
        files: writtenPaths(payload), symbols: delta.symbols } });
    verifyTouchedFacts(db, payload, workspacePath, workspace?.root);
    if (delta.reminder) return { ok: true, event, client, session_id: sessionId, reminder: delta.reminder };
  }

  if (event === 'post-invocation') {
    store.addObservation({ session_id: sessionId, kind: 'model_invocation', content: describeInvocation(payload) });
  }

  if (event === 'stop') {
    const finalMessage = payload.last_assistant_message || payload.lastAssistantMessage || payload.error;
    if (finalMessage) {
      store.addObservation({ session_id: sessionId, kind: 'session_stop', content: finalMessage });
      store.addSummary({ session_id: sessionId, scope: 'session', content: finalMessage });
    }
    synthesizeSessionDigest(store, sessionId);
    store.endSession(sessionId);
  }

  if (event === 'session-end') {
    synthesizeSessionDigest(store, sessionId);
    store.endSession(sessionId);
  }

  return { ok: true, event, client, session_id: sessionId };
}

function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    let payload = {};
    try {
      const input = chunks.join('').trim();
      payload = input ? JSON.parse(input) : {};
      const event = resolveEvent(payload);
      const client = resolveClient(payload);
      const sessionId = resolveSessionId(payload);
      const workspacePath = resolveWorkspace(payload);

      // Provisioned here as well as at SessionStart: a hook that never fired,
      // or fired late while PostToolUse was already writing, must not be able
      // to cost us an observation.
      let workspace = null;
      try {
        workspace = ensureWorkspace(workspacePath || process.cwd());
      } catch (error) {
        process.stderr.write(`[caipira-hook] workspace resolve failed: ${error.message}\n`);
      }

      // One connection per hook run: capture, drift checks, and recall share it.
      const store = new MemoryStore(workspace ? { dbPath: workspace.dbFile } : {});
      try {
        const db = workspace ? store.storage.db : null;
        const result = captureEvent(store, event, payload, client, sessionId, workspacePath, db, workspace);
        const recalled = recallContext(db, event, payload, workspace);
        writeClientResult(result, event, client, payload, recalled);
      } finally {
        store.close();
      }
    } catch (error) {
      process.stderr.write(`[caipira-hook] ${error.name}: ${error.message}\n`);
      writeResult({ ok: false, error: error.message });
    }
  });
}

main();
