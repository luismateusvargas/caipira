#!/usr/bin/env node
// Shared Caipira lifecycle adapter for Codex, Claude Code, and Antigravity.
// Input arrives as one JSON object on stdin. The adapter always returns JSON
// and exits successfully so memory failures never block the coding client.

const path = require('path');
const { MemoryStore } = require('../store');
const { ensureWorkspace, machineId } = require('../workspace');
const {
  buildInjection, buildDriftNotice, selectFacts, renderInjection, PROMPT_BUDGET_CHARS, STARTUP_BUDGET_CHARS
} = require('../inject');
const { FactStore, AstRefreshScope } = require('../facts');
const { syncWorkspaceAst, updateFileAst } = require('../ast');

// install.js registers every recall hook with a 15 s client timeout (only
// Codex's SessionEnd gets less). Parser work for recall (the startup sync,
// then any evidence re-indexing) must end this long after the run starts,
// which leaves the rest for process start, hashing, and rendering.
const RECALL_PARSER_BUDGET_MS = 9000;
// The startup sync's own allowance, inside that budget.
const STARTUP_SYNC_TIMEOUT_MS = 5000;
// One PostToolUse re-index of a written file.
const POST_TOOL_AST_TIMEOUT_MS = 2000;

// What a PostToolUse reminder and a session digest may carry.
const DELTA_CALLER_LIMIT = 12;
const DELTA_CHANGE_LIMIT = 8;
const DIGEST_OBSERVATION_LIMIT = 500;
const DIGEST_LIST_LIMIT = 6;
const DIGEST_SUMMARY_CHARS = 500;
// Tool arguments or results kept in one observation.
const OBSERVATION_TEXT_CHARS = 6000;
// One stderr diagnostic, and how many unreadable paths it names.
const DIAGNOSTIC_CHARS = 600;
const SYNC_FAILURE_SAMPLES = 3;

const KNOWN_CLIENTS = new Set(['codex', 'claude-code', 'antigravity']);

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

const AST_STARTUP_INSTRUCTION = [
  'The workspace\'s public symbol map is provided once at session start as `path::qualified_name (kind Lstart-end)` lines: use those line spans for direct ranged reads and pass the entries to inspect_symbol for signatures, callers, and type connections.',
  'Use workspace_symbols only to search for private symbols or entries the map omitted.',
  'Inspect cited source before editing.'
].join(' ');

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// The command line names the event and client the hook was installed for, so
// they are known even when stdin cannot be parsed; the payload only fills in
// what the command line left out.
/** @param {string|null} fromPayload @returns {string} */
function resolveEvent(fromPayload) {
  const rawEvent = readArgument('--event', fromPayload || '');
  return EVENT_ALIASES.get(rawEvent) || rawEvent.toLowerCase().replace(/_/g, '-');
}

/** @param {string|null} fromPayload @returns {string} */
function resolveClient(fromPayload) {
  return readArgument('--client', fromPayload || 'unknown');
}

// Diagnostics go to stderr, never into the client protocol, and are bounded
// so a raw storage error cannot flood the client's log.
/** @param {string} message */
function diagnose(message) {
  const text = String(message);
  const bounded = text.length > DIAGNOSTIC_CHARS ? `${text.slice(0, DIAGNOSTIC_CHARS)}...` : text;
  process.stderr.write(`[caipira-hook] ${bounded}\n`);
}

/** Stdin that is not a JSON object. */
class HookInputError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'HookInputError';
  }
}

// The first of these fields holding a non-empty string. A present field of
// any other type is named in `invalid` and passed over.
/** @param {object} payload @param {string[]} names @param {string[]} invalid @returns {string|null} */
function textField(payload, names, invalid) {
  for (const name of names) {
    const value = payload[name];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string') return value;
    invalid.push(name);
  }
  return null;
}

/** @param {object} payload @param {string[]} invalid @returns {string|null} */
function resolveWorkspace(payload, invalid) {
  const cwd = textField(payload, ['cwd'], invalid);
  if (cwd) return cwd;
  const paths = payload.workspacePaths;
  if (Array.isArray(paths) && paths.length > 0) {
    if (typeof paths[0] === 'string' && paths[0]) return paths[0];
    invalid.push('workspacePaths');
  } else if (paths !== undefined && paths !== null && !Array.isArray(paths)) {
    invalid.push('workspacePaths');
  }
  return textField(payload, ['workspace'], invalid);
}

/**
 * @typedef {object} HookInput
 * @property {string} event Canonical lifecycle event.
 * @property {string} client Client the reply is shaped for.
 * @property {object} payload The client's JSON object, for tool and invocation details.
 * @property {string|null} sessionId
 * @property {string} prompt Empty when the event carries none.
 * @property {string|null} workspacePath Directory the client reported.
 * @property {number|undefined} invocationNum Antigravity's step counter; undefined when absent.
 */

/**
 * Parses one hook payload and validates the fields the adapter acts on. A
 * field of the wrong type is dropped and named on stderr, so a client bug
 * costs the part of the run that needed it and nothing more.
 * @param {string} text Raw stdin; empty input is an empty payload.
 * @returns {HookInput}
 * @throws {SyntaxError} When stdin is not JSON.
 * @throws {HookInputError} When it is JSON but not an object.
 */
function readHookInput(text) {
  const trimmed = text.trim();
  const payload = trimmed ? JSON.parse(trimmed) : {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HookInputError('payload must be a JSON object');
  }
  const invalid = [];
  const event = resolveEvent(textField(payload, ['hook_event_name', 'event'], invalid));
  const client = resolveClient(textField(payload, ['client', 'ide'], invalid));
  const sessionId = textField(payload, ['session_id', 'sessionId', 'conversationId', 'conversation_id'], invalid);
  const prompt = textField(payload, ['prompt', 'userPrompt'], invalid) || '';
  const workspacePath = resolveWorkspace(payload, invalid);
  // A null counter is as good as none; anything but a step number is dropped.
  let invocationNum;
  const counter = payload.invocationNum;
  if (Number.isSafeInteger(counter) && counter >= 0) invocationNum = counter;
  else if (counter !== undefined && counter !== null) invalid.push('invocationNum');
  if (invalid.length) diagnose(`ignored invalid payload fields: ${invalid.join(', ')}`);
  return { event, client, payload, sessionId, prompt, workspacePath, invocationNum };
}

function safeText(value, maxLength = OBSERVATION_TEXT_CHARS) {
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
/** @param {number|undefined} invocationNum @returns {boolean} */
function isFirstInvocation(invocationNum) {
  return invocationNum === 0 || invocationNum === undefined;
}

function describeInvocation(payload) {
  return [
    `model=${payload.modelName || payload.model || 'unknown-model'}`,
    `invocation=${payload.invocationNum ?? payload.executionNum ?? 'unknown'}`,
    payload.error ? `error=${safeText(payload.error)}` : '',
    payload.terminationReason ? `termination=${safeText(payload.terminationReason)}` : ''
  ].filter(Boolean).join('\n');
}

// Exactly one JSON reply per run: once one is written, later ones are dropped.
let replied = false;
function writeResult(result) {
  if (replied) return;
  replied = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// A sync that could not read some paths still succeeds and keeps their old
// rows, so the map is usable but may be stale there: worth one stderr line,
// never a failed start.
/** @param {{failed: number, failures?: unknown}} stats @returns {string[]} Workspace-relative paths it could not read. */
function reportPartialSync(stats) {
  if (!stats.failed) return [];
  const failures = (Array.isArray(stats.failures) ? stats.failures : [])
    .filter(failure => failure && typeof failure.path === 'string' && typeof failure.message === 'string');
  const sample = failures.slice(0, SYNC_FAILURE_SAMPLES).map(failure => `${failure.path}: ${failure.message}`).join('; ');
  diagnose(`AST sync incomplete: ${stats.failed} unreadable path(s) kept their previous symbols${sample ? ` (${sample})` : ''}`);
  return failures.map(failure => failure.path);
}

// The symbol map injected at session start must describe the files as they
// are now, including edits made outside any session. The sync is incremental,
// but a missing, slow or failing parser only costs the map its freshness.
// What the sync learns also bounds the evidence checks after it: a parser
// that failed is not asked again this run, paths it could not read are not
// retried one by one, and nothing starts after the recall deadline.
/** @param {{root: string, dbFile: string}} workspace @param {number} deadlineAtMs @returns {AstRefreshScope} */
function syncSessionAst(workspace, deadlineAtMs) {
  const timeoutMs = Math.min(STARTUP_SYNC_TIMEOUT_MS, deadlineAtMs - Date.now());
  if (timeoutMs <= 0) {
    diagnose('AST sync skipped: the recall parser budget is spent');
    return new AstRefreshScope({ deadlineAtMs, parserUnavailable: true });
  }
  try {
    const stats = syncWorkspaceAst(workspace.root, workspace.dbFile, { timeoutMs });
    return new AstRefreshScope({ deadlineAtMs, unreadablePaths: reportPartialSync(stats) });
  } catch (error) {
    diagnose(`AST sync skipped: ${error.message}`);
    return new AstRefreshScope({ deadlineAtMs, parserUnavailable: true });
  }
}

/** @param {string} operation @param {Error} error */
function reportRecallFailure(operation, error) {
  diagnose(`recall degraded: ${operation} failed: ${error.message}`);
}

// Antigravity's first step can carry the user's prompt as well. Only facts it
// recalls beyond the standing ones already shown are worth a second block.
function recallBeyondStanding(db, prompt, opts, standing) {
  try {
    return renderInjection(selectFacts(db, prompt, opts)
      .filter(({ fact }) => !(standing || '').includes(`[${fact.kind}#${fact.id}]`)));
  } catch (error) {
    reportRecallFailure('prompt facts', error);
    return null;
  }
}

// Recall the facts worth putting in front of the model for this event. Never
// allowed to throw or to be slow: memory is an accelerant, and a hook that
// fails must cost nothing but the recall it would have provided.
/** @param {object|null} db @param {HookInput} input @param {object|null} workspace @param {number} deadlineAtMs @returns {string|null} */
function recallContext(db, input, workspace, deadlineAtMs) {
  if (!db) return null;
  const { event, prompt } = input;
  const starting = event === 'session-start' || (event === 'pre-invocation' && isFirstInvocation(input.invocationNum));
  if (!starting && event !== 'user-prompt-submit' && event !== 'pre-invocation') return null;
  try {
    const opts = { machine: machineId(), onFailure: reportRecallFailure };

    // A git pull or another editor can move evidence between sessions with no
    // PostToolUse to notice, so a new session re-indexes the workspace and
    // re-checks every fact before anything is injected as settled. One
    // refresh scope carries the deadline through all of it, and facts whose
    // symbol evidence it could not check are flagged rather than shown as
    // settled.
    let astScope = new AstRefreshScope({ deadlineAtMs });
    let uncheckedFacts = new Set();
    if (starting) {
      astScope = syncSessionAst(workspace, deadlineAtMs);
      const outcomes = new FactStore(db, { machine: opts.machine, agent: 'hook', root: workspace?.root })
        .verify(undefined, astScope);
      uncheckedFacts = new Set(outcomes.filter(outcome => outcome.unchecked > 0).map(outcome => outcome.id));
    }

    // Drift rides along with whatever else is being injected. It is appended
    // rather than gated on relevance: the fact that its evidence moved is
    // established, so the agent is told even when the prompt is unrelated.
    const drift = buildDriftNotice(db, opts);
    const cwd = input.workspacePath || workspace?.root;

    // Session context (standing facts, digests, the symbol map) opens the
    // conversation once. Later turns carry only what their prompt recalls, so
    // the cached conversation prefix stays put and an unrelated prompt adds
    // nothing at all.
    if (starting) {
      const recalled = buildInjection(db, workspace,
        { ...opts, cwd, budget: STARTUP_BUDGET_CHARS, prompt: '', uncheckedFacts });
      const extra = prompt
        ? recallBeyondStanding(db, prompt, { machine: opts.machine, root: workspace?.root, astScope }, recalled)
        : null;
      return [recalled, extra, drift].filter(Boolean).join('\n\n') || null;
    }
    const recalled = prompt
      ? buildInjection(db, workspace, { ...opts, cwd, budget: PROMPT_BUDGET_CHARS, prompt, astScope })
      : null;
    return [recalled, drift].filter(Boolean).join('\n\n') || null;
  } catch (error) {
    diagnose(`recall skipped: ${error.message}`);
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

// The reply that carries no context, in the shape each known client accepts.
/** @param {string} client @returns {object} */
function acknowledgement(client) {
  return client === 'claude-code' ? { continue: true } : {};
}

// A failed run still owes the client a reply it accepts: a known client gets
// its plain acknowledgement, and any other caller Caipira's own result shape
// with a stable code. The error itself only ever reaches stderr.
/** @param {string} event @param {string} client */
function writeFailure(event, client) {
  writeResult(KNOWN_CLIENTS.has(client) ? acknowledgement(client) : { ok: false, event, client, error: 'hook_failed' });
}

/** @param {object} result @param {HookInput} input @param {string|null} recalled */
function writeClientResult(result, input, recalled) {
  const { event, client } = input;
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
    writeResult(acknowledgement(client));
    return;
  }

  if (client === 'antigravity' && event === 'pre-invocation') {
    const steps = [];
    if (isFirstInvocation(input.invocationNum)) {
      steps.push(
        { ephemeralMessage: CAIPIRA_STARTUP_INSTRUCTION },
        { ephemeralMessage: AST_STARTUP_INSTRUCTION }
      );
    }
    if (recalled) steps.push({ ephemeralMessage: recalled });
    writeResult(steps.length ? { injectSteps: steps } : acknowledgement(client));
    return;
  }

  if (client === 'antigravity' && ['post-tool-use', 'pre-invocation', 'post-invocation', 'stop'].includes(event)) {
    writeResult(event === 'post-tool-use' && result.reminder
      ? { injectSteps: [{ ephemeralMessage: result.reminder }] } : acknowledgement(client));
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
    diagnose(`drift check skipped: ${error.message}`);
  }
}

/** @param {object|null} db @param {object|null} workspace @param {HookInput} input */
function postToolAstDelta(db, workspace, input) {
  if (!workspace || !db) return { reminder: null, symbols: [] };
  const changes = [];
  const symbols = [];
  for (const file of writtenPaths(input.payload)) {
    const absolute = path.resolve(input.workspacePath || workspace.root, file);
    if (absolute !== workspace.root && !absolute.startsWith(`${workspace.root}${path.sep}`)) continue;
    let result;
    try {
      result = updateFileAst(workspace.root, workspace.dbFile, absolute, { timeoutMs: POST_TOOL_AST_TIMEOUT_MS });
    } catch (error) {
      if (error.code !== 'unsupported' && error.code !== 'io') {
        diagnose(`AST delta skipped: ${error.message}`);
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
        ORDER BY source_path, line LIMIT ?`)
        .all(result.path, entry.qualified_name, entry.name, entry.qualified_name, entry.name, DELTA_CALLER_LIMIT);
      changes.push({ symbol: entry.qualified_name, path: result.path,
        signature: after ? `${entry.signature_text} → ${after.signature_text}` : `${entry.signature_text} (removed)`,
        callers: callers.map(c => `${c.source_path}::${c.source_symbol || '?'}:${c.line}`),
        facts: anchored.map(f => `[${f.kind}#${f.id}]`) });
    }
  }
  if (!changes.length) return { reminder: null, symbols };
  const lines = ['<system-reminder>', 'Caipira AST signature changes:'];
  for (const change of changes.slice(0, DELTA_CHANGE_LIMIT)) {
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
    WHERE session_id = ? AND kind = 'tool_result' ORDER BY id LIMIT ?`).all(sessionId, DIGEST_OBSERVATION_LIMIT);
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
  const list = values => [...values].sort().slice(0, DIGEST_LIST_LIMIT).join(', ');
  const summary = [`Tools: ${list(tools)} (${rows.length} calls)`,
    files.size ? `Files: ${list(files)}` : '', symbols.size ? `Symbols: ${list(symbols)}` : '']
    .filter(Boolean).join('; ').slice(0, DIGEST_SUMMARY_CHARS);
  db.prepare('UPDATE sessions SET summary = ? WHERE id = ? AND (summary IS NULL OR summary != ?)')
    .run(summary, sessionId, summary);
  return summary;
}

// db is the store's own connection, or null when no workspace resolved and
// the store fell back to the legacy database, which holds no facts to check.
/** @param {object} store @param {HookInput} input @param {object|null} db @param {object|null} workspace @returns {object} */
function captureEvent(store, input, db, workspace) {
  const { event, client, payload, sessionId, workspacePath } = input;
  if (!sessionId) return { ok: false, skipped: true, reason: 'missing session identifier' };

  // A client whose start hook never fired still gets its session attributed.
  if (event === 'session-start' || event === 'pre-invocation') {
    store.startSession({ id: sessionId, ide: client, cwd: workspacePath });
  } else {
    store.ensureSession(sessionId, client, workspacePath);
  }

  if (event === 'user-prompt-submit' && input.prompt) {
    store.addObservation({ session_id: sessionId, kind: 'user_prompt', content: input.prompt });
  }

  if (event === 'post-tool-use') {
    const delta = postToolAstDelta(db, workspace, input);
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
    // An error object is kept as text; other non-string messages are dropped.
    const finalMessage = textField(payload, ['last_assistant_message', 'lastAssistantMessage', 'error'], [])
      || (payload.error ? safeText(payload.error) : null);
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
  // Recall's parser budget runs from here, as close as the adapter gets to
  // the moment the client started its own timeout.
  const deadlineAtMs = Date.now() + RECALL_PARSER_BUDGET_MS;
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    // Known before stdin is parsed, so even unreadable input gets a reply in
    // the shape the client expects.
    let event = resolveEvent(null);
    let client = resolveClient(null);
    try {
      const input = readHookInput(chunks.join(''));
      ({ event, client } = input);

      // Provisioned here as well as at SessionStart: a hook that never fired,
      // or fired late while PostToolUse was already writing, must not be able
      // to cost us an observation.
      let workspace = null;
      try {
        workspace = ensureWorkspace(input.workspacePath || process.cwd());
      } catch (error) {
        diagnose(`workspace resolve failed: ${error.message}`);
      }

      // One connection per hook run: capture, drift checks, and recall share it.
      const store = new MemoryStore(workspace ? { dbPath: workspace.dbFile } : {});
      try {
        const db = workspace ? store.storage.db : null;
        const result = captureEvent(store, input, db, workspace);
        const recalled = recallContext(db, input, workspace, deadlineAtMs);
        writeClientResult(result, input, recalled);
      } finally {
        store.close();
      }
    } catch (error) {
      diagnose(`${error.name}: ${error.message}`);
      writeFailure(event, client);
    }
  });
}

main();
