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

// Like run, with extra environment and the hook's stderr returned too.
function runWith(client, event, payload, env) {
  const child = require('child_process').spawnSync(NODE, [HOOK, '--client', client, '--event', event], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env }
  });
  return { result: JSON.parse(child.stdout.trim().split('\n').pop()), stderr: child.stderr, status: child.status };
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
check('adds the workspace symbol map', /^Workspace symbols:$/m.test(ctx) &&
  /^- \S+::\S+ \(\w+ L\d+-\d+\)$/m.test(ctx), ctx.slice(-300));
check('explains the session-start symbol map', ctx.includes('path::qualified_name (kind Lstart-end)') &&
  /workspace_symbols only to search for private symbols/.test(ctx));

console.log('\n2. Claude Code — UserPromptSubmit recalls on a relevant prompt');
r = run('claude-code', 'UserPromptSubmit', {
  session_id: 'hooktest-1', cwd: WS,
  prompt: 'how do I wire codex over to caipira and drop cavemem?'
});
ctx = r.hookSpecificOutput && r.hookSpecificOutput.additionalContext;
check('injects recalled facts', Boolean(ctx) && ctx.includes('Caipira recalled'), JSON.stringify(r).slice(0, 140));
check('names the codex decision', ctx.includes('cavemem'));
check('does NOT repeat startup boilerplate', !ctx.includes('Madar is the global local AST'));
check('does NOT repeat the symbol map or session digests', !ctx.includes('Workspace symbols:') && !ctx.includes('Recent sessions:'));

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
  const codexContext = notice.hookSpecificOutput?.additionalContext;
  check('Codex receives PostToolUse model context', notice.hookSpecificOutput?.hookEventName === 'PostToolUse' &&
    codexContext?.includes('<system-reminder>') && codexContext.includes('api.js::api'), JSON.stringify(notice));
  check('Codex context names caller and impacted fact', codexContext?.includes('caller') &&
    codexContext.includes(`[constraint#${id}]`), JSON.stringify(notice));
  fs.writeFileSync(source, 'function api(value, extra, flag) { return value + extra + flag; }\nfunction caller() { return api(1); }\nmodule.exports = { api };\n');
  const claudeNotice = run('claude-code', 'PostToolUse', { session_id: 'hook-ast-claude', cwd: dir,
    tool_name: 'Edit', tool_input: { file_path: source } });
  const claudeContext = claudeNotice.hookSpecificOutput?.additionalContext;
  check('Claude Code receives PostToolUse model context', claudeNotice.hookSpecificOutput?.hookEventName === 'PostToolUse' &&
    claudeContext?.includes('<system-reminder>') && claudeContext.includes('api.js::api') &&
    claudeContext.includes('caller') && claudeContext.includes(`[constraint#${id}]`), JSON.stringify(claudeNotice));
  const quietCodex = run('codex', 'PostToolUse', { session_id: 'hook-ast-session', cwd: dir,
    tool_name: 'Edit', tool_input: { file_path: source } });
  const quietClaude = run('claude-code', 'PostToolUse', { session_id: 'hook-ast-claude', cwd: dir,
    tool_name: 'Edit', tool_input: { file_path: source } });
  check('unchanged Codex PostToolUse returns bare acknowledgement', JSON.stringify(quietCodex) === '{}', JSON.stringify(quietCodex));
  check('unchanged Claude Code PostToolUse returns continue', JSON.stringify(quietClaude) === '{"continue":true}', JSON.stringify(quietClaude));
  run('codex', 'SessionEnd', { session_id: 'hook-ast-session', cwd: dir });
  const ended = sessionRow(info.dbFile, 'hook-ast-session');
  check('SessionEnd stores deterministic tool/file/symbol digest', ended.summary?.includes('Tools: Edit') && ended.summary.includes('Files:') && ended.summary.includes('Symbols: api.js::api'), JSON.stringify(ended));
  const prompt = run('codex', 'SessionStart', { session_id: 'hook-ast-next', cwd: dir });
  check('next session recalls the digest', prompt.hookSpecificOutput?.additionalContext?.includes('Recent sessions:'), JSON.stringify(prompt));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n14. each Stop refreshes the digest and SessionEnd is idempotent');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-digest-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const firstFile = path.join(dir, 'api.js');
  const secondFile = path.join(dir, 'b.js');
  fs.writeFileSync(firstFile, 'function api(v) { return v; }\n');
  run('claude-code', 'SessionStart', { session_id: 'hook-multiturn', cwd: dir });
  run('claude-code', 'PostToolUse', { session_id: 'hook-multiturn', cwd: dir,
    tool_name: 'Read', tool_input: { file_path: firstFile } });
  run('claude-code', 'Stop', { session_id: 'hook-multiturn', cwd: dir });
  const info = ensureWorkspace(dir);
  const firstDigest = sessionRow(info.dbFile, 'hook-multiturn').summary;
  fs.writeFileSync(firstFile, 'function api(v, w) { return v + w; }\n');
  run('claude-code', 'PostToolUse', { session_id: 'hook-multiturn', cwd: dir,
    tool_name: 'Edit', tool_input: { file_path: firstFile } });
  fs.writeFileSync(secondFile, 'function beta() { return 2; }\n');
  run('claude-code', 'PostToolUse', { session_id: 'hook-multiturn', cwd: dir,
    tool_name: 'Write', tool_input: { file_path: secondFile } });
  run('claude-code', 'Stop', { session_id: 'hook-multiturn', cwd: dir });
  const finalDigest = sessionRow(info.dbFile, 'hook-multiturn').summary;
  check('later Stop includes every turn', finalDigest !== firstDigest &&
    ['Edit', 'Read', 'Write', 'Files:', 'api.js', 'b.js', '(3 calls)'].every(part => finalDigest.includes(part)), finalDigest);
  run('claude-code', 'SessionEnd', { session_id: 'hook-multiturn', cwd: dir });
  run('claude-code', 'SessionEnd', { session_id: 'hook-multiturn', cwd: dir });
  check('repeated SessionEnd leaves identical digest', sessionRow(info.dbFile, 'hook-multiturn').summary === finalDigest);
  fs.rmSync(dir, { recursive: true, force: true });
}

function symbolWorkspace(prefix, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(path.join(dir, 'src'));
  for (const name of names) {
    fs.writeFileSync(path.join(dir, 'src', `${name}.js`),
      `export function ${name}(value) { return value; }\nfunction hidden_${name}() { return 0; }\n`);
  }
  return dir;
}

function symbolCount(dbFile) {
  const db = openWorkspaceDb(dbFile);
  try { return db.prepare('SELECT COUNT(*) AS n FROM ast_symbols').get().n; }
  finally { db.close(); }
}

const SYMBOL_LINE = /^- src\/\w+\.js::\w+ \(function L\d+-\d+\)$/gm;

console.log('\n15. session start indexes the workspace and maps its symbols once');
{
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  const dir = symbolWorkspace('hook-symbols-', names);
  const info = ensureWorkspace(dir);
  check('a fresh workspace starts unindexed', symbolCount(info.dbFile) === 0);

  r = run('claude-code', 'SessionStart', { session_id: 'hook-symbols-1', cwd: dir });
  ctx = r.hookSpecificOutput?.additionalContext || '';
  check('SessionStart indexed the workspace', symbolCount(info.dbFile) >= names.length, symbolCount(info.dbFile));
  check('SessionStart injects every public symbol with kind and span', (ctx.match(SYMBOL_LINE) || []).length === names.length &&
    names.every(name => ctx.includes(`- src/${name}.js::${name} (function L1-1)`)), ctx.slice(-500));
  check('private symbols stay out of the map', !ctx.includes('hidden_'));

  // An edit made between sessions, with no PostToolUse to see it.
  fs.writeFileSync(path.join(dir, 'src', 'omega.js'), 'export function omega(value) {\n  return value;\n}\n');
  r = run('codex', 'SessionStart', { session_id: 'hook-symbols-2', cwd: dir });
  ctx = r.hookSpecificOutput?.additionalContext || '';
  check('the next SessionStart maps an externally added file', ctx.includes('- src/omega.js::omega (function L1-3)'), ctx.slice(-300));

  run('claude-code', 'PostToolUse', { session_id: 'hook-symbols-1', cwd: dir,
    tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src', 'alpha.js') } });
  run('claude-code', 'Stop', { session_id: 'hook-symbols-1', cwd: dir });
  r = run('antigravity', 'pre-invocation', { conversationId: 'hook-symbols-agy', workspacePaths: [dir], invocationNum: 0 });
  const opening = (r.injectSteps || []).map(step => step.ephemeralMessage).join('\n\n');
  check('Antigravity first step carries the digest and the map', opening.includes('Recent sessions:') &&
    opening.includes('Workspace symbols:') && opening.includes('src/omega.js::omega'), opening.slice(-300));

  const unrelatedPrompt = 'add a dark mode toggle to the settings page';
  r = run('claude-code', 'UserPromptSubmit', { session_id: 'hook-symbols-1', cwd: dir, prompt: unrelatedPrompt });
  check('Claude Code unrelated prompt on an indexed workspace returns continue', JSON.stringify(r) === '{"continue":true}', JSON.stringify(r).slice(0, 200));
  r = run('codex', 'UserPromptSubmit', { session_id: 'hook-symbols-2', cwd: dir, prompt: unrelatedPrompt });
  check('Codex unrelated prompt returns {}', JSON.stringify(r) === '{}', JSON.stringify(r).slice(0, 200));
  r = run('antigravity', 'pre-invocation', { conversationId: 'hook-symbols-agy', workspacePaths: [dir],
    invocationNum: 1, prompt: unrelatedPrompt });
  check('Antigravity later step with an unrelated prompt returns {}', JSON.stringify(r) === '{}', JSON.stringify(r).slice(0, 200));
  r = run('claude-code', 'UserPromptSubmit', { session_id: 'hook-symbols-1', cwd: dir });
  check('a prompt turn without a prompt injects nothing', JSON.stringify(r) === '{"continue":true}', JSON.stringify(r).slice(0, 200));

  const db = openWorkspaceDb(info.dbFile);
  new FactStore(db, { machine: machineId(), agent: 'test', root: dir }).record({
    kind: 'decision', title: 'Webhook retry payloads',
    summary: 'Webhook retry payloads are normalized by omega before delivery.',
    body: 'omega normalizes webhook retry payloads before delivery.', evidence: [path.join(dir, 'package.json')]
  });
  db.close();
  const relevantPrompt = 'how are webhook retry payloads normalized?';
  r = run('claude-code', 'UserPromptSubmit', { session_id: 'hook-symbols-1', cwd: dir, prompt: relevantPrompt });
  ctx = r.hookSpecificOutput?.additionalContext || '';
  check('Claude Code relevant prompt recalls only the fact', ctx.includes('Caipira recalled facts:') && ctx.includes('Webhook retry') &&
    !ctx.includes('Workspace symbols:') && !ctx.includes('Recent sessions:'), ctx.slice(0, 300));
  r = run('antigravity', 'pre-invocation', { conversationId: 'hook-symbols-agy', workspacePaths: [dir],
    invocationNum: 2, userPrompt: relevantPrompt });
  const later = (r.injectSteps || []).map(step => step.ephemeralMessage).join('\n\n');
  check('Antigravity later step recalls only the fact', later.includes('Caipira recalled facts:') &&
    !later.includes('Workspace symbols:') && !later.includes('Recent sessions:') && !later.includes('standing facts'), later.slice(0, 300));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n16. Antigravity\'s first step adds prompt recall beyond the standing facts');
{
  const dir = symbolWorkspace('hook-first-step-', ['alpha']);
  const info = ensureWorkspace(dir);
  const db = openWorkspaceDb(info.dbFile);
  const store = new FactStore(db, { machine: machineId(), agent: 'test', root: dir });
  const evidence = [path.join(dir, 'package.json')];
  // Recorded first and ranked last by kind, so the eight status facts fill
  // the standing list and this one is left for the prompt to recall.
  const hiddenId = store.record({ kind: 'decision', title: 'Webhook retry payloads',
    summary: 'Webhook retry payloads are normalized before delivery.',
    body: 'Webhook retry payloads are normalized before delivery.', evidence });
  for (let i = 1; i <= 8; i++) {
    store.record({ kind: 'status', title: `Release checklist item ${i}`,
      summary: `Release checklist item ${i} is complete.`, body: `Release checklist item ${i} is complete.`, evidence });
  }
  db.close();
  const tag = `[decision#${hiddenId}]`;
  r = run('antigravity', 'pre-invocation', { conversationId: 'hook-first-step', workspacePaths: [dir],
    invocationNum: 0, prompt: 'how are webhook retry payloads normalized?' });
  let text = (r.injectSteps || []).map(step => step.ephemeralMessage).join('\n\n');
  check('standing facts and the map open the conversation', text.includes('Caipira standing facts') &&
    text.includes('Workspace symbols:'), text.slice(0, 200));
  check('a fact only the prompt recalls is appended once', text.includes('Caipira recalled these established facts') &&
    text.split(tag).length === 2, text.slice(-400));
  r = run('antigravity', 'pre-invocation', { conversationId: 'hook-first-step', workspacePaths: [dir],
    invocationNum: 0, prompt: 'is release checklist item 3 complete?' });
  text = (r.injectSteps || []).map(step => step.ephemeralMessage).join('\n\n');
  check('facts already standing are not repeated', !text.includes('Caipira recalled these established facts') &&
    text.split('Release checklist item 3 ').length === 2, text.slice(-400));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n17. a missing, failing or slow caipira-ast never blocks session start');
{
  const dir = symbolWorkspace('hook-ast-down-', ['alpha']);
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-fake-ast-'));
  const failing = path.join(fake, 'failing-ast');
  fs.writeFileSync(failing, '#!/bin/sh\necho boom >&2\nexit 1\n', { mode: 0o755 });
  const slow = path.join(fake, 'slow-ast');
  fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const cases = [
    ['missing', path.join(fake, 'does-not-exist'), 'AST sync skipped: CAIPIRA_AST_BIN does not point at an executable'],
    ['failing', failing, 'AST sync skipped: boom'],
    ['timed out', slow, 'AST sync skipped: caipira-ast timed out']
  ];
  for (const [label, bin, message] of cases) {
    const started = Date.now();
    const { result, stderr, status } = runWith('claude-code', 'SessionStart',
      { session_id: `hook-ast-down-${label}`, cwd: dir }, { CAIPIRA_AST_BIN: bin });
    const text = result.hookSpecificOutput?.additionalContext || '';
    check(`${label} caipira-ast: SessionStart still answers`, status === 0 &&
      text.includes('shared local-first cross-agent memory') && text.includes('workspace_symbols'), JSON.stringify(result).slice(0, 160));
    check(`${label} caipira-ast: logged to stderr`, stderr.includes(message), stderr);
    if (label === 'timed out') check('the sync gives up after its 5 s timeout', Date.now() - started < 15000, Date.now() - started);
  }
  fs.rmSync(fake, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

// Raw stdin, any environment and cwd: for input no client should send.
function runRaw(client, event, input, env = {}, cwd = os.tmpdir()) {
  const child = require('child_process').spawnSync(NODE, [HOOK, '--client', client, '--event', event], {
    input, encoding: 'utf8', env: { ...process.env, ...env }, cwd
  });
  return { stdout: child.stdout, stderr: child.stderr, status: child.status };
}

const STATS = '{"parsed":0,"skipped":0,"hash_matched":0,"removed":0,"failed":0,"relinked":0,"symbols_total":0,"edges_total":0,"duration_ms":0';
// A stand-in caipira-ast: `index` prints `indexOutput` or, when that is
// null, hangs like every other subcommand; each run is logged to `log`.
function fakeParser(dir, name, indexOutput) {
  const log = path.join(dir, `${name}.log`);
  const bin = path.join(dir, name);
  const index = indexOutput === null ? 'exec sleep 30' : `printf '%s\\n' '${indexOutput}'; exit 0`;
  fs.writeFileSync(bin, `#!/bin/sh\necho "$1" >> '${log}'\nif [ "$1" = index ]; then ${index}; fi\nexec sleep 30\n`, { mode: 0o755 });
  return { bin, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

// Six facts anchored to one symbol and two to another, indexed by the real
// parser, then both files changed on disk with no PostToolUse to see it.
function anchoredWorkspace(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'api.js'), 'export function api(value) { return value; }\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'export function beta(value) { return value; }\n');
  const info = ensureWorkspace(dir);
  const ast = require(ROOT + '/ast.js');
  ast.syncWorkspaceAst(dir, info.dbFile);
  const db = openWorkspaceDb(info.dbFile);
  const store = new FactStore(db, { machine: machineId(), agent: 'test', root: dir });
  const anchor = (file, name) => ({ path: file, qualifiedName: name,
    signatureHash: ast.inspectSymbol(db, `${file}::${name}`).symbol.signature_hash });
  const ids = [];
  for (let i = 0; i < 6; i++) {
    ids.push(store.record({ kind: 'constraint', title: `api rule ${i}`, summary: `api rule ${i} holds.`,
      body: 'api takes one argument', evidenceSymbols: [anchor('api.js', 'api')] }));
  }
  for (let i = 0; i < 2; i++) {
    ids.push(store.record({ kind: 'constraint', title: `beta rule ${i}`, summary: `beta rule ${i} holds.`,
      body: 'beta takes one argument', evidenceSymbols: [anchor('b.js', 'beta')] }));
  }
  db.close();
  fs.writeFileSync(path.join(dir, 'api.js'), 'export function api(value, extra) { return value + extra; }\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'export function beta(value, extra) { return value + extra; }\n');
  return { dir, ids };
}

const flaggedAll = (text, ids) => ids.every(id => (text.split(`#${id}]`)[1] || '').split('\n')[0].includes('NEEDS REVIEW'));

console.log('\n18. session start stays inside the client timeout with a hung parser');
{
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-hung-ast-'));
  const cases = [
    ['a hung sync', 'hung-index', null, ['index'], 7000],
    ['a hung re-index after a good sync', 'hung-update', `${STATS}}`, ['index', 'update-file'], 4000],
    ['a missing parser', 'absent', undefined, [], 2000]
  ];
  for (const [label, name, indexOutput, expectedRuns, withinMs] of cases) {
    const { dir, ids } = anchoredWorkspace('hook-bounded-');
    const parser = indexOutput === undefined ? { bin: path.join(fake, name), runs: () => [] } : fakeParser(fake, name, indexOutput);
    const started = Date.now();
    const { stdout, stderr, status } = runRaw('codex', 'SessionStart', JSON.stringify({ session_id: `hook-bounded-${name}`, cwd: dir }),
      { CAIPIRA_AST_BIN: parser.bin });
    const elapsed = Date.now() - started;
    let reply = {};
    try { reply = JSON.parse(stdout); } catch { /* checked below */ }
    const text = reply.hookSpecificOutput?.additionalContext || '';
    check(`${label}: valid SessionStart reply in ${elapsed} ms (< ${withinMs})`, status === 0 && elapsed < withinMs &&
      reply.hookSpecificOutput?.hookEventName === 'SessionStart', `${elapsed} ${stdout.slice(0, 120)}`);
    check(`${label}: the parser ran ${expectedRuns.length} time(s) for eight facts on two files`,
      JSON.stringify(parser.runs()) === JSON.stringify(expectedRuns), JSON.stringify(parser.runs()));
    check(`${label}: unconfirmed facts are flagged, not verified`, flaggedAll(text, ids), text.slice(0, 600));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(fake, { recursive: true, force: true });
}

console.log('\n19. a partial sync is reported once and startup carries on');
{
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-partial-ast-'));
  const dir = symbolWorkspace('hook-partial-', ['alpha']);
  run('codex', 'SessionStart', { session_id: 'hook-partial-seed', cwd: dir });
  const partial = fakeParser(fake, 'partial', `${STATS.replace('"failed":0', '"failed":1')},"failures":[{"path":"src/alpha.js","message":"Permission denied"}]}`);
  let outcome = runWith('codex', 'SessionStart', { session_id: 'hook-partial-1', cwd: dir }, { CAIPIRA_AST_BIN: partial.bin });
  const warnings = outcome.stderr.split('\n').filter(line => line.includes('AST sync incomplete'));
  check('one bounded warning names the count and the path', warnings.length === 1 &&
    warnings[0] === '[caipira-hook] AST sync incomplete: 1 unreadable path(s) kept their previous symbols (src/alpha.js: Permission denied)',
  outcome.stderr);
  check('startup still injects the map it has', outcome.status === 0 &&
    outcome.result.hookSpecificOutput?.additionalContext.includes('- src/alpha.js::alpha (function L1-1)'), JSON.stringify(outcome.result).slice(0, 200));
  const clean = fakeParser(fake, 'clean', `${STATS}}`);
  outcome = runWith('codex', 'SessionStart', { session_id: 'hook-partial-2', cwd: dir }, { CAIPIRA_AST_BIN: clean.bin });
  check('a sync with no failures is silent', outcome.stderr === '' && outcome.status === 0, outcome.stderr);
  fs.rmSync(fake, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n20. bad input and broken storage still get the client\'s own reply');
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-input-'));
  const fileHome = path.join(scratch, 'not-a-directory');
  fs.writeFileSync(fileHome, '');
  const replies = { 'codex': '{}', 'claude-code': '{"continue":true}', 'antigravity': '{}' };
  const events = { 'codex': 'SessionStart', 'claude-code': 'UserPromptSubmit', 'antigravity': 'pre-invocation' };
  const inputs = [
    ['malformed JSON', '{not json', {}],
    ['a null payload', 'null', {}],
    ['an array payload', '[1,2]', {}],
    ['an unusable memory directory', JSON.stringify({ session_id: 'hook-broken-home', cwd: scratch, prompt: 'x' }), { CAIPIRA_HOME: fileHome }]
  ];
  for (const [label, input, env] of inputs) {
    for (const client of Object.keys(replies)) {
      const { stdout, stderr, status } = runRaw(client, events[client], input, env, scratch);
      check(`${client}, ${label}: exits 0 with ${replies[client]}`, status === 0 && stdout === `${replies[client]}\n`, stdout);
      check(`${client}, ${label}: the cause is on stderr only`, /\[caipira-hook\] (SyntaxError|HookInputError|SqliteError)/.test(stderr), stderr);
    }
    const other = runRaw('other-client', 'SessionStart', input, env, scratch);
    check(`unknown client, ${label}: stable failure code, no raw error`, other.status === 0 &&
      other.stdout === '{"ok":false,"event":"session-start","client":"other-client","error":"hook_failed"}\n', other.stdout);
  }

  const dir = symbolWorkspace('hook-invalid-fields-', ['alpha']);
  let outcome = runRaw('codex', 'SessionStart', JSON.stringify({ session_id: { id: 1 }, cwd: dir }));
  check('an object session_id is dropped before storage and named on stderr', outcome.status === 0 &&
    JSON.parse(outcome.stdout).hookSpecificOutput?.hookEventName === 'SessionStart' && !/parameter/i.test(outcome.stdout) &&
    outcome.stderr.includes('ignored invalid payload fields: session_id'), `${outcome.stdout.slice(0, 120)} ${outcome.stderr}`);
  outcome = runRaw('claude-code', 'UserPromptSubmit', JSON.stringify({ session_id: 'hook-invalid', cwd: dir, prompt: ['x'] }));
  check('a non-string prompt counts as no prompt', outcome.stdout === '{"continue":true}\n' &&
    outcome.stderr.includes('ignored invalid payload fields: prompt'), `${outcome.stdout} ${outcome.stderr}`);
  outcome = runRaw('antigravity', 'pre-invocation', JSON.stringify({ conversationId: 'hook-invalid-agy',
    cwd: 7, workspacePaths: [dir], invocationNum: '3' }));
  check('a wrongly typed cwd and step counter are dropped, the valid workspace path kept',
    (JSON.parse(outcome.stdout).injectSteps || []).some(step => step.ephemeralMessage.includes('src/alpha.js::alpha')) &&
    outcome.stderr.includes('ignored invalid payload fields: cwd, invocationNum'), `${outcome.stdout.slice(0, 120)} ${outcome.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('\n21. a failed recall block is diagnosed once at the hook');
{
  const dir = symbolWorkspace('hook-degraded-', ['alpha']);
  run('codex', 'SessionStart', { session_id: 'hook-degraded-seed', cwd: dir });
  const info = ensureWorkspace(dir);
  const db = openWorkspaceDb(info.dbFile);
  new FactStore(db, { machine: machineId(), agent: 'test', root: dir }).record({ kind: 'status', title: 'Degraded probe',
    summary: 'The degraded probe stands.', body: 'The degraded probe stands.' });
  db.exec('DROP TABLE ast_edges');
  db.close();
  const { result, stderr, status } = runWith('claude-code', 'SessionStart', { session_id: 'hook-degraded', cwd: dir },
    { CAIPIRA_AST_BIN: path.join(dir, 'no-parser') });
  const text = result.hookSpecificOutput?.additionalContext || '';
  check('standing facts survive the failed symbol block', status === 0 && text.includes('The degraded probe stands.') &&
    !text.includes('Workspace symbols:'), text.slice(-300));
  check('one diagnostic names it', stderr.split('\n').filter(line => line.includes('recall degraded: workspace symbols failed')).length === 1, stderr);
  fs.rmSync(dir, { recursive: true, force: true });
}

for (const probe of probes) fs.rmSync(probe.dir, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
