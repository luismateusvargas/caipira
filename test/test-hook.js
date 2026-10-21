// Drives universal-hook.js exactly as each client would: JSON on stdin,
// JSON on stdout, one process per event.
require('./fixtures').ensureIsolatedHome();
const { execFileSync } = require('child_process');
const ROOT = require('path').join(__dirname, '..');
const NODE = process.execPath;
const HOOK = ROOT + '/hooks/universal-hook.js';
const WS = ROOT;

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' -> ' + extra : '')); }
};

function run(client, event, payload) {
  const out = execFileSync(NODE, [HOOK, '--client', client, '--event', event], {
    input: JSON.stringify(payload), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// Injection has nothing to recall in an isolated CAIPIRA_HOME, so the facts
// these assertions expect are seeded rather than borrowed from live history.
require('./fixtures').seedFacts(WS).db.close();

console.log('\n1. Claude Code — SessionStart carries startup instructions + standing facts');
let r = run('claude-code', 'SessionStart', { session_id: 'hooktest-1', cwd: WS });
let ctx = r.hookSpecificOutput && r.hookSpecificOutput.additionalContext;
check('uses hookSpecificOutput', Boolean(ctx), JSON.stringify(r).slice(0, 120));
check('hookEventName correct', r.hookSpecificOutput.hookEventName === 'SessionStart');
check('keeps caipira startup instruction', ctx.includes('shared local-first cross-agent memory'));
check('advertises built-in symbol tools', ctx.includes('workspace_symbols') && ctx.includes('inspect_symbol'));
check('does not advertise Madar', !ctx.includes('Madar'));

// The write half of the contract. Nothing used to name these, so memory only
// grew when the user asked for it — a fact the agent is never told to record
// is a fact the next session pays to re-derive.
check('instructs record_fact', ctx.includes('record_fact'));
check('instructs update_fact', ctx.includes('update_fact'));
// The read half: an unflagged fact must not send the agent back to the files.
check('instructs acting on facts, not reconfirming them',
  /do not re-read/i.test(ctx) && ctx.includes('NEEDS REVIEW'));
check('no blanket re-verification instruction', !/verify current source/i.test(ctx));
check('adds standing facts', ctx.includes('Caipira standing facts'));

console.log('\n2. Claude Code — UserPromptSubmit recalls on a relevant prompt');
r = run('claude-code', 'UserPromptSubmit', {
  session_id: 'hooktest-1', cwd: WS,
  prompt: 'how do I wire codex over to caipira and drop cavemem?'
});
ctx = r.hookSpecificOutput && r.hookSpecificOutput.additionalContext;
check('injects recalled facts', Boolean(ctx) && ctx.includes('Caipira recalled'), JSON.stringify(r).slice(0, 140));
check('names the codex decision', ctx.includes('cavemem'));
check('does NOT repeat startup boilerplate', !ctx.includes('Madar is the global local AST'));

console.log('\n3. Claude Code — UserPromptSubmit keeps unrelated facts out');
r = run('claude-code', 'UserPromptSubmit', {
  session_id: 'hooktest-1', cwd: WS,
  prompt: 'add a dark mode toggle to the settings page'
});
const unrelated = r.hookSpecificOutput?.additionalContext || '';
check('unrelated facts are not injected', !unrelated.includes('Caipira recalled facts:'), JSON.stringify(r));
check('returns a valid hook response', r.continue === true || r.hookSpecificOutput?.hookEventName === 'UserPromptSubmit', JSON.stringify(r));

console.log('\n4. Codex — same shape, confirmed against the binary');
r = run('codex', 'UserPromptSubmit', {
  session_id: 'hooktest-codex', cwd: WS,
  prompt: 'why did we pick per workspace databases for sqlite?'
});
ctx = r.hookSpecificOutput && r.hookSpecificOutput.additionalContext;
check('codex gets injection too', Boolean(ctx) && ctx.includes('Caipira recalled'), JSON.stringify(r).slice(0, 140));
check('hookEventName UserPromptSubmit', r.hookSpecificOutput.hookEventName === 'UserPromptSubmit');

r = run('codex', 'PostToolUse', { session_id: 'hooktest-codex', cwd: WS, tool_name: 'Read', tool_response: 'ok' });
check('codex PostToolUse returns bare {}', JSON.stringify(r) === '{}', JSON.stringify(r));

console.log('\n5. Antigravity — injectSteps shape');
r = run('antigravity', 'pre-invocation', { conversationId: 'hooktest-agy', workspacePaths: [WS], invocationNum: 0 });
check('first invocation injects steps', Array.isArray(r.injectSteps) && r.injectSteps.length >= 2, JSON.stringify(r).slice(0, 140));
check('includes standing facts step', JSON.stringify(r).includes('standing facts'));
r = run('antigravity', 'post-tool-use', { conversationId: 'hooktest-agy', workspacePaths: [WS], tool_name: 'x' });
check('post-tool-use returns bare {}', JSON.stringify(r) === '{}', JSON.stringify(r));

console.log('\n6. resilience — a hook must never break the client');
r = run('claude-code', 'UserPromptSubmit', { cwd: WS });             // no session_id, no prompt
check('missing session id tolerated', typeof r === 'object', JSON.stringify(r));
r = run('claude-code', 'SessionStart', { session_id: 'x', cwd: 'Z:\\does\\not\\exist' });
check('nonexistent workspace tolerated', typeof r === 'object', JSON.stringify(r).slice(0, 100));

console.log('\n7. observations route to the workspace db, not the legacy one');
const D = require('better-sqlite3');
const { ensureWorkspace } = require(ROOT + '/workspace.js');
const wsInfo = ensureWorkspace(WS);
const wdb = new D(wsInfo.dbFile, { readonly: true });
const n = wdb.prepare("SELECT COUNT(*) n FROM observations WHERE session_id LIKE 'hooktest%'").get().n;
check('hook writes landed in workspace db (' + n + ')', n > 0);
wdb.close();
// A standalone run's fresh CAIPIRA_HOME has no legacy data.db at all, and a
// file that does not exist cannot have had anything leaked into it.
const LEGACY_DB = require(ROOT + '/workspace.js').LEGACY_DB;
let leaked = 0;
if (require('fs').existsSync(LEGACY_DB)) {
  const ldb = new D(LEGACY_DB, { readonly: true });
  try { leaked = ldb.prepare("SELECT COUNT(*) n FROM observations WHERE session_id LIKE 'hooktest%'").get().n; }
  finally { ldb.close(); }
}
check('nothing leaked into legacy data.db', leaked === 0, leaked);

console.log('\n8. a write to a fact\'s evidence flags that fact, in-session');
{
  const fs2 = require('fs');
  const { openWorkspaceDb, machineId } = require(ROOT + '/workspace.js');
  const { FactStore } = require(ROOT + '/facts.js');
  const os2 = require('os'), path2 = require('path');

  const file = path2.join(os2.tmpdir(), 'drift-evidence-' + Date.now() + '.js');
  fs2.writeFileSync(file, 'const PORT = 3000;\n');

  let fdb = openWorkspaceDb(wsInfo.dbFile);
  const seededId = new FactStore(fdb, { machine: machineId(), agent: 'test' })
    .record({ kind: 'decision', title: 'drift probe', body: 'the port is 3000', evidence: [file] });
  fdb.close();

  // Untouched evidence must not flag anything, or every write would flag
  // everything and the signal would be worthless.
  run('claude-code', 'PostToolUse', {
    session_id: 'hooktest-1', cwd: WS,
    tool_name: 'Edit', tool_input: { file_path: path2.join(os2.tmpdir(), 'some-other-file.js') }
  });
  fdb = openWorkspaceDb(wsInfo.dbFile);
  let state = fdb.prepare('SELECT state FROM facts WHERE id = ?').get(seededId).state;
  fdb.close();
  check('unrelated write leaves the fact active', state === 'active', state);

  // A read of the very same file must not flag it either.
  fs2.writeFileSync(file, 'const PORT = 8080;\n');
  run('claude-code', 'PostToolUse', {
    session_id: 'hooktest-1', cwd: WS, tool_name: 'Read', tool_input: { file_path: file }
  });
  fdb = openWorkspaceDb(wsInfo.dbFile);
  state = fdb.prepare('SELECT state FROM facts WHERE id = ?').get(seededId).state;
  fdb.close();
  check('a read never flags drift', state === 'active', state);

  run('claude-code', 'PostToolUse', {
    session_id: 'hooktest-1', cwd: WS, tool_name: 'Edit', tool_input: { file_path: file }
  });
  fdb = openWorkspaceDb(wsInfo.dbFile);
  state = fdb.prepare('SELECT state FROM facts WHERE id = ?').get(seededId).state;
  fdb.close();
  check('writing the evidence flags the fact', state === 'needs_review', state);

  // And the agent is actually told, on the next prompt, even an unrelated one.
  const after = run('claude-code', 'UserPromptSubmit', {
    session_id: 'hooktest-1', cwd: WS, prompt: 'add a dark mode toggle to the settings page'
  });
  const text = after.hookSpecificOutput && after.hookSpecificOutput.additionalContext;
  check('drift rides along on an unrelated prompt', Boolean(text) && text.includes('evidence changed'),
    JSON.stringify(after).slice(0, 120));
  check('names the drifted fact', Boolean(text) && text.includes('#' + seededId));

  fdb = openWorkspaceDb(wsInfo.dbFile);
  fdb.prepare('DELETE FROM fact_evidence WHERE fact_id = ?').run(seededId);
  fdb.prepare('DELETE FROM facts WHERE id = ?').run(seededId);
  fdb.close();
  fs2.rmSync(file, { force: true });
}

// Each drift scenario gets its own workspace holding one fact on one evidence
// file, so every case starts from a known-active fact.
const fs = require('fs'), os = require('os'), path = require('path');
const { openWorkspaceDb, machineId } = require(ROOT + '/workspace.js');
const { FactStore } = require(ROOT + '/facts.js');
const probes = [];

function driftProbe(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookdrift-' + name + '-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(path.join(dir, 'src'));
  const file = path.join(dir, 'src', 'config.js');
  fs.writeFileSync(file, 'const PORT = 3000;\n');
  const info = ensureWorkspace(dir);
  const db = openWorkspaceDb(info.dbFile);
  try {
    const id = new FactStore(db, { machine: machineId(), agent: 'test' }).record({
      kind: 'decision', title: 'port probe', summary: 'The dev server listens on port 3000.',
      body: 'the port is 3000', evidence: [file]
    });
    const probe = { dir, file, id, dbFile: info.dbFile };
    probes.push(probe);
    return probe;
  } finally {
    db.close();
  }
}

// A different size, so the change is caught even within one mtime tick.
const editEvidence = probe => fs.writeFileSync(probe.file, 'const PORT = 8080; // moved\n');

function factState(probe) {
  const db = new D(probe.dbFile, { readonly: true });
  try { return db.prepare('SELECT state FROM facts WHERE id = ?').get(probe.id).state; }
  finally { db.close(); }
}

function sessionRow(dbFile, id) {
  const db = new D(dbFile, { readonly: true });
  try { return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id); }
  finally { db.close(); }
}

console.log('\n9. Antigravity and Codex writes flag drift too');
{
  const cases = [
    ['antigravity edit_file, absolute Path', probe => run('antigravity', 'post-tool-use', {
      conversationId: 'hooktest-agy-drift', workspacePaths: [probe.dir],
      toolName: 'edit_file', toolCall: { name: 'edit_file', args: { Path: probe.file } }
    })],
    ['antigravity edit_file, Path relative to cwd', probe => run('antigravity', 'post-tool-use', {
      conversationId: 'hooktest-agy-drift', cwd: probe.dir,
      toolName: 'edit_file', toolCall: { args: { Path: 'src/config.js' } }
    })],
    ['codex apply_patch, absolute path', probe => run('codex', 'PostToolUse', {
      session_id: 'hooktest-codex-drift', cwd: probe.dir, tool_name: 'apply_patch',
      tool_input: '*** Begin Patch\n*** Update File: ' + probe.file + '\n@@\n-const PORT = 3000;\n+const PORT = 8080;\n*** End Patch\n'
    })],
    ['codex apply_patch, path relative to cwd', probe => run('codex', 'PostToolUse', {
      session_id: 'hooktest-codex-drift', cwd: probe.dir, tool_name: 'apply_patch',
      tool_input: '*** Begin Patch\n*** Update File: src/config.js\n@@\n-const PORT = 3000;\n+const PORT = 8080;\n*** End Patch\n'
    })]
  ];
  for (const [label, send] of cases) {
    const probe = driftProbe('write');
    editEvidence(probe);
    const response = send(probe);
    check(label + ' flags the fact', factState(probe) === 'needs_review', factState(probe));
    check(label + ' still acks with {}', JSON.stringify(response) === '{}', JSON.stringify(response));
  }
}

console.log('\n10. edits made between sessions are caught at session start');
{
  const starts = [
    ['claude-code SessionStart', probe => {
      const r = run('claude-code', 'SessionStart', { session_id: 'hooktest-between-cc', cwd: probe.dir });
      return r.hookSpecificOutput && r.hookSpecificOutput.additionalContext;
    }],
    ['codex SessionStart', probe => {
      const r = run('codex', 'SessionStart', { session_id: 'hooktest-between-codex', cwd: probe.dir });
      return r.hookSpecificOutput && r.hookSpecificOutput.additionalContext;
    }],
    ['antigravity pre-invocation #0', probe => {
      const r = run('antigravity', 'pre-invocation', { conversationId: 'hooktest-between-agy', workspacePaths: [probe.dir], invocationNum: 0 });
      return (r.injectSteps || []).map(step => step.ephemeralMessage).join('\n\n');
    }]
  ];
  for (const [label, start] of starts) {
    const probe = driftProbe('between');
    editEvidence(probe);
    const text = start(probe) || '';
    const tag = 'decision#' + probe.id + ']';
    check(label + ' marks the fact NEEDS REVIEW', text.includes(tag) && /NEEDS REVIEW/.test(text.split(tag)[1] || ''),
      text.slice(0, 160));
    check(label + ' carries the drift notice', text.includes('whose evidence changed') && text.includes('changed: config.js'),
      text.slice(-200));
  }
}

console.log('\n11. Antigravity injects standing facts once per conversation');
r = run('antigravity', 'pre-invocation', { conversationId: 'hooktest-agy', workspacePaths: [WS], invocationNum: 1 });
check('later invocation without a prompt returns {}', JSON.stringify(r) === '{}', JSON.stringify(r).slice(0, 140));
r = run('antigravity', 'pre-invocation', {
  conversationId: 'hooktest-agy', workspacePaths: [WS], invocationNum: 1,
  prompt: 'how do I wire codex over to caipira and drop cavemem?'
});
let steps = JSON.stringify(r);
check('later invocation with a prompt recalls facts', steps.includes('Caipira recalled') && steps.includes('cavemem'), steps.slice(0, 140));
check('...without repeating standing facts', !steps.includes('standing facts'), steps.slice(0, 140));
r = run('antigravity', 'pre-invocation', {
  conversationId: 'hooktest-agy', workspacePaths: [WS], invocationNum: 2,
  userPrompt: 'why did we pick per workspace databases for sqlite?'
});
steps = JSON.stringify(r);
check('userPrompt is recalled as well', steps.includes('Caipira recalled'), steps.slice(0, 140));

console.log('\n12. session lifecycle is recorded for every client');
r = run('codex', 'session-end', { session_id: 'hooktest-codex-end', cwd: WS });
let row = sessionRow(wsInfo.dbFile, 'hooktest-codex-end');
check('codex session-end sets ended_at', Boolean(row && row.ended_at), JSON.stringify(row));
check('codex session-end acks with {}', JSON.stringify(r) === '{}', JSON.stringify(r));
run('claude-code', 'SessionEnd', { session_id: 'hooktest-cc-end', cwd: WS });
row = sessionRow(wsInfo.dbFile, 'hooktest-cc-end');
check('SessionEnd alias closes the session', Boolean(row && row.ended_at), JSON.stringify(row));

run('codex', 'PostToolUse', { session_id: 'hooktest-midstream', cwd: WS, tool_name: 'Read', tool_input: { file_path: 'x' } });
row = sessionRow(wsInfo.dbFile, 'hooktest-midstream');
check('a session first seen mid-stream records client and cwd', row && row.ide === 'codex' && row.cwd === WS, JSON.stringify(row));

console.log('\n13. AST delta reminder and session digest');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ast-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const source = path.join(dir, 'api.js');
  fs.writeFileSync(source, 'function api(value) { return value; }\nfunction caller() { return api(1); }\nmodule.exports = { api };\n');
  const info = ensureWorkspace(dir);
  const ast = require(ROOT + '/ast.js');
  ast.updateFileAst(dir, info.dbFile, source);
  const db = openWorkspaceDb(info.dbFile);
  const symbol = ast.inspectSymbol(db, 'api.js::api').symbol;
  const id = new FactStore(db, { machine: machineId(), agent: 'test', root: dir }).record({
    kind: 'constraint', title: 'api signature', body: 'api takes one argument',
    evidenceSymbols: [{ path: 'api.js', qualifiedName: 'api', signatureHash: symbol.signature_hash }]
  });
  db.close();
  fs.writeFileSync(source, 'function api(value, extra) { return value + extra; }\nfunction caller() { return api(1); }\nmodule.exports = { api };\n');
  const notice = run('codex', 'PostToolUse', { session_id: 'hook-ast-session', cwd: dir,
    tool_name: 'Edit', tool_input: { file_path: source } });
  check('public signature change emits system reminder', notice.systemMessage?.includes('<system-reminder>') && notice.systemMessage.includes('api.js::api'), JSON.stringify(notice));
  check('reminder names caller and impacted fact', notice.systemMessage?.includes('caller') && notice.systemMessage.includes(`[constraint#${id}]`), JSON.stringify(notice));
  run('codex', 'SessionEnd', { session_id: 'hook-ast-session', cwd: dir });
  const ended = sessionRow(info.dbFile, 'hook-ast-session');
  check('SessionEnd stores deterministic tool/file/symbol digest', ended.summary?.includes('Tools: Edit') && ended.summary.includes('Files:') && ended.summary.includes('Symbols: api.js::api'), JSON.stringify(ended));
  const prompt = run('codex', 'SessionStart', { session_id: 'hook-ast-next', cwd: dir });
  check('next session recalls the digest', prompt.hookSpecificOutput?.additionalContext?.includes('Recent sessions:'), JSON.stringify(prompt));
  fs.rmSync(dir, { recursive: true, force: true });
}

for (const probe of probes) fs.rmSync(probe.dir, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
