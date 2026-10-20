// Drives universal-hook.js exactly as each client would: JSON on stdin,
// JSON on stdout, one process per event.
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
check('keeps madar instruction', ctx.includes('Madar'));

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

console.log('\n3. Claude Code — UserPromptSubmit stays silent on an unrelated prompt');
r = run('claude-code', 'UserPromptSubmit', {
  session_id: 'hooktest-1', cwd: WS,
  prompt: 'add a dark mode toggle to the settings page'
});
check('no injection', !r.hookSpecificOutput, JSON.stringify(r));
check('still returns a valid continue', r.continue === true, JSON.stringify(r));

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
const ldb = new D(require(ROOT + '/workspace.js').LEGACY_DB, { readonly: true });
const leaked = ldb.prepare("SELECT COUNT(*) n FROM observations WHERE session_id LIKE 'hooktest%'").get().n;
check('nothing leaked into legacy data.db', leaked === 0, leaked);
ldb.close();

console.log('\nN. a write to a fact\'s evidence flags that fact, in-session');
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

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
