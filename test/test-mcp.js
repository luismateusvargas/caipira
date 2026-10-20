// End-to-end: drive mcp.js over real stdio, exactly as a client would.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = require('path').join(__dirname, '..');
const NODE = process.execPath;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpws-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"testws"}');
const evidence = path.join(tmp, 'server.js');
fs.writeFileSync(evidence, 'const PORT = 3000;\n');

const child = spawn(NODE, [ROOT + '/mcp.js'], {
  cwd: tmp,
  env: { ...process.env, CAIPIRA_MODEL_PATH: ROOT + '/models' },
  stdio: ['pipe', 'pipe', 'pipe']
});

let out = '';
const pending = new Map();
child.stdout.on('data', d => {
  out += d;
  const lines = out.split('\n');
  out = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', d => { if (/error|Error/.test(String(d))) console.log('  [stderr]', String(d).trim()); });

let seq = 0;
function call(method, params) {
  const id = ++seq;
  return new Promise(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const tool = async (name, args) => {
  const r = await call('tools/call', { name, arguments: args });
  if (r.error) return { __error: r.error.message };
  return JSON.parse(r.result.content[0].text);
};

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' -> ' + extra : '')); }
};

(async () => {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });

  console.log('\n1. tools are advertised');
  const list = await call('tools/list', {});
  const names = list.result.tools.map(t => t.name);
  for (const n of ['search', 'record_fact', 'search_facts', 'update_fact', 'check_drift', 'list_workspaces']) {
    check('exposes ' + n, names.includes(n));
  }

  console.log('\n2. record_fact provisions the workspace on demand');
  const rec = await tool('record_fact', {
    kind: 'decision',
    title: 'Port stays 3000',
    body: 'The development server listens on port 3000 because the reverse proxy configuration expects it.',
    summary: 'Dev server port is 3000, fixed by the proxy config.',
    evidence: [evidence],
    session_id: 'e2e'
  });
  check('fact recorded', rec.id > 0, JSON.stringify(rec));
  check('routed to the test workspace', String(rec.workspace).toLowerCase().includes('mcpws'), rec.workspace);
  check('got its own db file', rec.db && rec.db.includes('database'), rec.db);
  check('evidence attached', rec.evidence.length === 1);

  console.log('\n3. search_facts finds it, in compressed and verbatim form');
  const verbatim = await tool('search_facts', { query: 'development server configuration' });
  check('verbatim query hits', verbatim.facts.some(f => f.id === rec.id), JSON.stringify(verbatim.facts.map(f => f.title)));
  // 'cfg' is a lexicon pair (configuration); dual-form search bridges it.
  const abbrev = await tool('search_facts', { query: 'cfg' });
  check('abbreviated query hits the same fact', abbrev.facts.some(f => f.id === rec.id), JSON.stringify(abbrev.facts.map(f => f.title)));
  // 'srv' is NOT in the lexicon — this documents the boundary, it is not a synonym engine.
  const notALexiconPair = await tool('search_facts', { query: 'srv' });
  check('non-lexicon abbreviation does NOT match (known limit)', notALexiconPair.facts.length === 0,
    JSON.stringify(notALexiconPair.facts.map(f => f.title)));
  check('body returned verbatim', verbatim.facts[0].body.includes('reverse proxy configuration'));
  check('trust reported', typeof verbatim.facts[0].trust === 'number' && verbatim.facts[0].trust > 0.9, verbatim.facts[0].trust);

  console.log('\n4. no drift while the file is untouched');
  let drift = await tool('check_drift', {});
  check('nothing drifted', drift.drifted.length === 0, JSON.stringify(drift));

  console.log('\n5. editing the evidence file produces a precise re-read list');
  fs.writeFileSync(evidence, 'const PORT = 8080;\n');
  drift = await tool('check_drift', {});
  check('drift detected', drift.drifted.length === 1, JSON.stringify(drift));
  check('names the exact file', drift.drifted[0].files_to_reread[0] === path.resolve(evidence), JSON.stringify(drift.drifted[0]));

  console.log('\n6. the stale fact announces itself instead of lying');
  const after = await tool('search_facts', { query: 'development server configuration' });
  const staleFact = after.facts.find(f => f.id === rec.id);
  check('state is needs_review', staleFact.state === 'needs_review', staleFact.state);
  check('trust dropped', staleFact.trust < 0.9, staleFact.trust);
  check('stale file surfaced in the result', staleFact.stale_files.length === 1);

  console.log('\n7. superseding through record_fact');
  const rec2 = await tool('record_fact', {
    kind: 'decision', title: 'Port moved to 8080',
    body: 'The development server now listens on port 8080.',
    summary: 'Dev server port is 8080.',
    evidence: [evidence], supersedes: rec.id
  });
  const finalSearch = await tool('search_facts', { query: 'development server port' });
  check('new fact present', finalSearch.facts.some(f => f.id === rec2.id));
  check('superseded fact hidden from search', !finalSearch.facts.some(f => f.id === rec.id),
    JSON.stringify(finalSearch.facts.map(f => f.id)));

  console.log('\n8. workspace isolation');
  const ws = await tool('list_workspaces', {});
  check('test workspace registered', ws.some(w => String(w.root).toLowerCase().includes('mcpws')));
  const otherWs = await tool('search_facts', { query: 'development server port', cwd: ROOT });
  check('facts do NOT leak into another workspace', otherWs.facts.length === 0,
    JSON.stringify(otherWs.facts.map(f => f.title)));

  // Isolation is the default, but it must be escapable on request — otherwise
  // a lesson learned in one project is invisible everywhere else.
  const scoped = await tool('search_facts', {
    query: 'development server port', cwd: ROOT, scope: 'all'
  });
  check('scope=all reaches across workspaces', scoped.facts.length > 0,
    JSON.stringify(scoped).slice(0, 160));
  check('scope=all labels each result with its origin',
    scoped.facts.every(f => typeof f.workspace === 'string' && f.workspace.length > 0));
  check('scope=all reports how many workspaces it searched', scoped.searched_workspaces >= 2,
    scoped.searched_workspaces);
  check('scope=all warns that borrowed facts are not local truth',
    typeof scoped.note === 'string' && /another codebase/i.test(scoped.note), scoped.note);
  check('default scope is still isolated', otherWs.facts.length === 0);

  console.log('\n9. update_fact');
  const upd = await tool('update_fact', { id: rec2.id, state: 'revoked' });
  check('state changed', upd.state === 'revoked', JSON.stringify(upd));
  const afterRevoke = await tool('search_facts', { query: 'development server port' });
  check('revoked fact excluded', !afterRevoke.facts.some(f => f.id === rec2.id));

  console.log('\n10. errors are reported, not swallowed');
  const bad = await tool('record_fact', { kind: 'nonsense', title: 'x', body: 'y' });
  check('invalid kind rejected', Boolean(bad.__error), JSON.stringify(bad));

  child.kill();
  await new Promise(r => setTimeout(r, 400));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); child.kill(); process.exit(1); });
