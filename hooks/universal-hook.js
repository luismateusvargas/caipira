#!/usr/bin/env node
// Shared Caipira lifecycle adapter for Codex, Claude Code, and Antigravity.
// Input arrives as one JSON object on stdin. The adapter always returns JSON
// and exits successfully so memory failures never block the coding client.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { MemoryStore } = require('../store');
const { ensureWorkspace, openWorkspaceDb, machineId } = require('../workspace');
const { buildPromptInjection, buildStandingInjection, buildDriftNotice } = require('../inject');
const { FactStore } = require('../facts');

// Madar lives in the user's global npm prefix; resolve it instead of hardcoding.
function resolveMadarPath() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'madar.cmd'),
    path.join(os.homedir(), '.local', 'bin', 'madar'),
    '/usr/local/bin/madar'
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return 'madar';
}

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
  ['Stop', 'stop']
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
  'Call update_fact when you find a recorded fact is wrong, outdated, or contradicted by what you just saw; revoke it if nothing replaces it, and record a replacement with supersedes if something does.',
  'Do not end a session leaving something you had to work out sitting only in the transcript.'
].join(' ');

const MADAR_STARTUP_INSTRUCTION = [
  `Madar is the global local AST code-graph executable at ${resolveMadarPath()}.`,
  'For codebase navigation, symbol lookup, routes, callers, impact analysis, or architecture questions, prefer Madar before broad text search or reading many files.',
  'Find the relevant project graph at <project-root>\\out\\graph.json, then use Madar query, explain, path, or pack with an explicit --graph path.',
  'Do not assume a static Madar MCP server can select the current project graph; use the executable unless that project separately runs Madar serve with --mcp.',
  'Check graph freshness with Madar status and inspect exact cited source before edits or behavior claims.'
].join(' ');

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
const WRITE_TOOLS = /^(edit|write|multiedit|notebookedit|str_replace|create_file|apply_patch)$/i;

function writtenPaths(payload) {
  const toolCall = payload.toolCall || {};
  const toolName = String(payload.tool_name || payload.toolName || toolCall.name || '');
  if (!WRITE_TOOLS.test(toolName)) return [];

  const args = toolCall.args || payload.tool_input || payload.toolInput || {};
  const candidates = [args.file_path, args.filePath, args.path, args.notebook_path];
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) candidates.push(edit && (edit.file_path || edit.path));
  }
  return candidates.filter(p => typeof p === 'string' && p.length > 0);
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
function recallContext(event, payload, workspace) {
  if (!workspace) return null;
  let db;
  try {
    db = openWorkspaceDb(workspace.dbFile);
    const opts = { machine: machineId() };

    // Drift rides along with whatever else is being injected. It is appended
    // rather than gated on relevance: the fact that its evidence moved is
    // established, so the agent is told even when the prompt is unrelated.
    const drift = buildDriftNotice(db, opts);

    if (event === 'user-prompt-submit') {
      const prompt = payload.prompt || payload.userPrompt || '';
      const recalled = prompt ? buildPromptInjection(db, prompt, opts) : null;
      return [recalled, drift].filter(Boolean).join('\n\n') || null;
    }
    if (event === 'session-start' || event === 'pre-invocation') {
      return [buildStandingInjection(db, opts), drift].filter(Boolean).join('\n\n') || null;
    }
    return null;
  } catch (error) {
    process.stderr.write(`[caipira-hook] recall skipped: ${error.message}\n`);
    return null;
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

// Claude Code and Codex both read injected context from
// hookSpecificOutput.additionalContext, and both reject unknown top-level
// diagnostic fields, so they share one branch.
const HOOK_EVENT_NAMES = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  'stop': 'Stop'
};

function writeClientResult(result, event, client, payload, recalled) {
  if (client === 'codex' || client === 'claude-code') {
    // Only these two events may carry additionalContext; the others must
    // return a bare acknowledgement or the client rejects the payload.
    const canInject = event === 'session-start' || event === 'user-prompt-submit';
    if (canInject) {
      const parts = [];
      if (event === 'session-start') {
        parts.push(CAIPIRA_STARTUP_INSTRUCTION, MADAR_STARTUP_INSTRUCTION);
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
    writeResult(client === 'codex' ? {} : { continue: true });
    return;
  }

  if (client === 'antigravity' && event === 'pre-invocation') {
    const isFirstInvocation = payload.invocationNum === 0;
    const steps = [];
    if (isFirstInvocation) {
      steps.push(
        { ephemeralMessage: CAIPIRA_STARTUP_INSTRUCTION },
        { ephemeralMessage: MADAR_STARTUP_INSTRUCTION }
      );
    }
    if (recalled) steps.push({ ephemeralMessage: recalled });
    writeResult(steps.length ? { injectSteps: steps } : {});
    return;
  }

  if (client === 'antigravity' && ['post-tool-use', 'pre-invocation', 'post-invocation', 'stop'].includes(event)) {
    writeResult({});
    return;
  }
  writeResult(result);
}

// A write to a file some fact was derived from is the one drift signal that
// needs no judgement, so it is acted on the moment it happens rather than
// waiting for someone to call check_drift. Only the facts resting on the
// written paths are re-verified, and verify() itself stats before it hashes.
function verifyTouchedFacts(payload, workspaceRow) {
  if (!workspaceRow) return;
  const paths = writtenPaths(payload);
  if (paths.length === 0) return;

  let db = null;
  try {
    db = openWorkspaceDb(workspaceRow.dbFile);
    const facts = new FactStore(db, { machine: machineId(), agent: 'hook' });
    const ids = facts.factsForPaths(paths);
    if (ids.length) facts.verify(ids);
  } catch (error) {
    // Drift detection must never break the tool call that triggered it.
    process.stderr.write(`[caipira-hook] drift check skipped: ${error.message}\n`);
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

function captureEvent(store, event, payload, client, sessionId, workspace, workspaceRow) {
  if (!sessionId) return { ok: false, skipped: true, reason: 'missing session identifier' };

  if (event === 'session-start' || event === 'pre-invocation') {
    store.startSession({ id: sessionId, ide: client, cwd: workspace });
  }

  if (event === 'user-prompt-submit' && payload.prompt) {
    store.addObservation({ session_id: sessionId, kind: 'user_prompt', content: payload.prompt });
  }

  if (event === 'post-tool-use') {
    store.addObservation({ session_id: sessionId, kind: 'tool_result', content: describeTool(payload) });
    verifyTouchedFacts(payload, workspaceRow);
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

      const store = new MemoryStore(workspace ? { dbPath: workspace.dbFile } : {});
      try {
        const result = captureEvent(store, event, payload, client, sessionId, workspacePath, workspace);
        const recalled = recallContext(event, payload, workspace);
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
