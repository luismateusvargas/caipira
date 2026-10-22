// End-to-end: drive mcp.js over real stdio, exactly as a client would.
require('./fixtures').ensureIsolatedHome();
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = require('path').join(__dirname, '..');
const NODE = process.execPath;
const D = require('better-sqlite3');
const { MemoryStore } = require(ROOT + '/store.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpws-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"testws"}');
const evidence = path.join(tmp, 'server.js');
fs.writeFileSync(evidence, 'const PORT = 3000;\n');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' -> ' + extra : '')); }
};

const RPC_TIMEOUT_MS = 10000;
const INITIALIZE = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } };

// One mcp.js child over stdio. A child that dies before stop() fails the suite
// and rejects every pending call at once, so a crash can neither hang the run
// nor let it pass on whatever checks happened to finish first.
function startServer(extraEnv = {}) {
  const child = spawn(NODE, [ROOT + '/mcp.js'], {
    cwd: tmp,
    env: { ...process.env, CAIPIRA_MODEL_PATH: ROOT + '/models', CAIPIRA_DEBUG: '', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let out = '', seq = 0, exited = null, stopping = false;

  const rejectAll = reason => {
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
  };
  child.on('error', error => {
    exited = 'mcp.js failed to start: ' + error.message;
    rejectAll(exited);
  });
  child.on('exit', (code, signal) => {
    exited = `mcp.js exited (code ${code}, signal ${signal})`;
    if (stopping) return;
    fail++;
    console.log('  FAIL ' + exited + ' before the suite stopped it');
    rejectAll(exited);
  });
  child.stdout.on('data', d => {
    out += d;
    const lines = out.split('\n');
    out = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (entry) { pending.delete(msg.id); entry.resolve(msg); }
    }
  });
  child.stderr.on('data', d => { if (/error|Error/.test(String(d))) console.log('  [stderr]', String(d).trim()); });

  // `id` is the id the response will carry: null for a request the server
  // cannot attribute to anything.
  function send(id, line) {
    if (exited) return Promise.reject(new Error(exited));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to request ${id} within ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, {
        resolve: msg => { clearTimeout(timer); resolve(msg); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      child.stdin.write(line + '\n');
    });
  }

  const call = (method, params) => {
    const id = ++seq;
    return send(id, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  };
  const raw = (line, id = null) => send(id, line);
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args });
    if (r.error) return { __error: r.error.message };
    return JSON.parse(r.result.content[0].text);
  };
  const stop = () => new Promise(resolve => {
    stopping = true;
    if (exited) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });
  return { call, raw, tool, stop };
}

const server = startServer();
const { call, tool } = server;

(async () => {
  const initialized = await call('initialize', INITIALIZE);
  check('initialize advertises the package version', initialized.result.serverInfo.version === require('../package.json').version);
  const discovered = await call('server/discover', {});
  check('discovery advertises the package version', discovered.result._meta['io.modelcontextprotocol/serverInfo'].version === require('../package.json').version);
  check('discovery explains facts, drift and symbol tools', ['record_fact', 'check_drift', 'workspace_symbols', 'inspect_symbol']
    .every(name => discovered.result.instructions.includes(name)), discovered.result.instructions);

  console.log('\n1. tools are advertised');
  const list = await call('tools/list', {});
  const names = list.result.tools.map(t => t.name);
  for (const n of ['search', 'record_fact', 'search_facts', 'update_fact', 'check_drift', 'list_workspaces', 'workspace_symbols', 'inspect_symbol']) {
    check('exposes ' + n, names.includes(n));
  }
  const updateSchema = list.result.tools.find(t => t.name === 'update_fact').inputSchema.properties;
  check('update_fact advertises kind, scope and evidence', ['kind', 'scope', 'evidence'].every(k => k in updateSchema),
    Object.keys(updateSchema).join(','));

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

  console.log('\n2a. symbol tools and anchored fact drift');
  const source = path.join(tmp, 'symbols.js');
  fs.writeFileSync(source, 'function greet(name) { return name; }\nfunction caller() { return greet("Ada"); }\nfunction other(x) { return x; }\nmodule.exports = { greet };\n');
  const symbols = await tool('workspace_symbols', { query: 'greet', cwd: tmp });
  check('workspace_symbols finds the indexed function', Array.isArray(symbols) && symbols.some(s => s.name === 'greet'), JSON.stringify(symbols));
  const inspected = await tool('inspect_symbol', { symbol: 'greet', path: 'symbols.js', cwd: tmp });
  check('inspect_symbol returns signature and callers', inspected?.symbol?.signature_hash && inspected.callers.some(c => c.symbol === 'caller'), JSON.stringify(inspected));
  check('inspect_symbol exposes inputs, output, and source connections', inspected.params?.[0]?.name === 'name' &&
    'return_type' in inspected && inspected.callers.some(c => c.source_path === 'symbols.js') &&
    Array.isArray(inspected.type_references) && Array.isArray(inspected.imports), JSON.stringify(inspected));
  const anchored = await tool('record_fact', { kind: 'constraint', title: 'greet API', body: 'greet takes a name.',
    evidence_symbols: ['symbols.js::greet'], cwd: tmp });
  check('record_fact stores symbol evidence', anchored.evidence_symbols?.includes('symbols.js::greet'), JSON.stringify(anchored));
  const lineAnchored = await tool('record_fact', { kind: 'decision', title: 'greet line', body: 'The first line defines greet.',
    evidence_symbols: ['symbols.js:1'], cwd: tmp });
  check('line evidence resolves to the enclosing symbol', lineAnchored.evidence_symbols?.includes('symbols.js::greet'), JSON.stringify(lineAnchored));
  const attached = await tool('inspect_symbol', { symbol: 'greet', path: 'symbols.js', cwd: tmp });
  check('inspect_symbol links the active fact', attached.facts.some(f => f.fact_id === anchored.id), JSON.stringify(attached.facts));
  const ranged = await tool('record_fact', { kind: 'decision', title: 'greet implementation line',
    body: 'The first line defines greet.', evidence_ranges: [{ path: source, start_line: 1, end_line: 1 }], cwd: tmp });
  const rangeDetail = await tool('inspect_symbol', { symbol: 'greet', path: 'symbols.js', cwd: tmp });
  check('inspect_symbol links overlapping file line evidence', ranged.evidence_ranges?.length === 1 &&
    rangeDetail.facts.some(f => f.fact_id === ranged.id && f.evidence_status === 'file_range'), JSON.stringify(rangeDetail.facts));
  const callerRange = await tool('record_fact', { kind: 'decision', title: 'caller line',
    body: 'The second line calls greet.', evidence_ranges: [{ path: source, start_line: 2, end_line: 2 }], cwd: tmp });
  const isolatedRange = await tool('inspect_symbol', { symbol: 'greet', path: 'symbols.js', cwd: tmp });
  check('a different function line is not attached', !isolatedRange.facts.some(f => f.fact_id === callerRange.id), JSON.stringify(isolatedRange.facts));
  const countFacts = () => {
    const db = new D(rec.db, { readonly: true });
    try { return db.prepare('SELECT COUNT(*) AS n FROM facts').get().n; }
    finally { db.close(); }
  };
  const beforeDuplicate = countFacts();
  const duplicateRanges = await tool('record_fact', { kind: 'decision', title: 'duplicate range sentinel',
    body: 'Two ranges in one file.', evidence_ranges: [
      { path: source, start_line: 1, end_line: 1 }, { path: source, start_line: 3, end_line: 3 }
    ], cwd: tmp });
  check('duplicate file ranges are rejected without recording a fact',
    duplicateRanges.__error?.includes('evidence_ranges may list each file once') &&
    countFacts() === beforeDuplicate, JSON.stringify(duplicateRanges));
  fs.writeFileSync(source, 'function greet(name) { return name; }\nfunction caller() { return greet("Ada"); }\nfunction other(x, y) { return x + y; }\nmodule.exports = { greet };\n');
  const unrelated = await tool('check_drift', { ids: [anchored.id], cwd: tmp });
  check('unrelated function edit leaves anchored fact clean', unrelated.drifted.length === 0, JSON.stringify(unrelated));
  fs.writeFileSync(source, 'function greet(name, suffix) { return name + suffix; }\nfunction caller() { return greet("Ada"); }\nfunction other(x, y) { return x + y; }\nmodule.exports = { greet };\n');
  const changed = await tool('check_drift', { ids: [anchored.id], cwd: tmp });
  check('changed signature reports the broken symbol', changed.drifted[0]?.broken?.[0]?.reason === 'symbol_signature_changed', JSON.stringify(changed));
  const reaffirmed = await tool('update_fact', { id: anchored.id, state: 'active', cwd: tmp });
  const baseline = await tool('check_drift', { ids: [anchored.id], cwd: tmp });
  check('explicit reaffirmation refreshes symbol evidence', reaffirmed.state === 'active' && baseline.drifted.length === 0, JSON.stringify({ reaffirmed, baseline }));
  fs.writeFileSync(source, 'function caller() { return "Ada"; }\nfunction other(x, y) { return x + y; }\nmodule.exports = { caller };\n');
  const deleted = await tool('check_drift', { ids: [anchored.id], cwd: tmp });
  check('deleted symbol reports symbol_missing', deleted.drifted[0]?.broken?.[0]?.reason === 'symbol_missing', JSON.stringify(deleted));

  console.log('\n2b. a single-file delta does not count as a full workspace index');
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-partial-'));
  fs.writeFileSync(path.join(partial, 'package.json'), '{}');
  const alphaFile = path.join(partial, 'a.js');
  fs.writeFileSync(alphaFile, 'function alpha() { return 1; }\nmodule.exports = { alpha };\n');
  fs.writeFileSync(path.join(partial, 'b.js'), 'function beta() { return 2; }\nmodule.exports = { beta };\n');
  const partialInfo = require(ROOT + '/workspace.js').ensureWorkspace(partial);
  require(ROOT + '/ast.js').updateFileAst(partial, partialInfo.dbFile, alphaFile);
  const betaSymbols = await tool('workspace_symbols', { query: 'beta', cwd: partial });
  check('first workspace_symbols call completes a partial index',
    betaSymbols.some(s => s.path === 'b.js' && s.name === 'beta'), JSON.stringify(betaSymbols));
  const betaDetail = await tool('inspect_symbol', { symbol: 'beta', path: 'b.js', cwd: partial });
  check('inspect_symbol sees the completed index', betaDetail?.symbol?.name === 'beta', JSON.stringify(betaDetail));

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
  let drift = await tool('check_drift', { ids: [rec.id] });
  check('nothing drifted', drift.drifted.length === 0, JSON.stringify(drift));

  console.log('\n5. editing the evidence file produces a precise re-read list');
  fs.writeFileSync(evidence, 'const PORT = 8080;\n');
  drift = await tool('check_drift', { ids: [rec.id] });
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

  console.log('\n11. malformed requests get JSON-RPC errors, not a dead server');
  const expectError = async (label, pending, code) => {
    const r = await pending;
    check(label, Boolean(r.error) && r.error.code === code, JSON.stringify(r));
  };
  await expectError('null payload -> -32600', server.raw('null'), -32600);
  await expectError('array payload -> -32600', server.raw('[1,2]'), -32600);
  await expectError('object without a method -> -32600, under its own id',
    server.raw(JSON.stringify({ jsonrpc: '2.0', id: 'no-method' }), 'no-method'), -32600);
  await expectError('unparseable line -> -32700', server.raw('{not json'), -32700);
  await expectError('tools/call without params -> -32602', call('tools/call'), -32602);
  const badArgs = [
    ['get_observations without ids', 'get_observations', {}],
    ['get_observations with non-numeric ids', 'get_observations', { ids: ['1'] }],
    ['get_observations with more than 500 ids', 'get_observations', { ids: Array.from({ length: 501 }, (_, i) => i + 1) }],
    ['timeline without session_id', 'timeline', {}],
    ['search_facts without query', 'search_facts', {}],
    ['update_fact without id', 'update_fact', { state: 'revoked' }],
    ['update_fact with a string id', 'update_fact', { id: String(rec2.id), state: 'revoked' }],
    ['a non-string cwd', 'list_sessions', { cwd: 42 }]
  ];
  for (const [label, name, args] of badArgs) {
    await expectError(label + ' -> -32602', call('tools/call', { name, arguments: args }), -32602);
  }
  const pong = await call('ping', {});
  check('server still answers afterwards', Boolean(pong.result), JSON.stringify(pong));

  console.log('\n12. traffic is logged only on request, rotated, and redacted');
  const logFile = path.join(process.env.CAIPIRA_HOME, 'logs', 'mcp_traffic.log');
  check('nothing logged without CAIPIRA_DEBUG', !fs.existsSync(logFile));
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, 'x'.repeat(5 * 1024 * 1024));
  const debug = startServer({ CAIPIRA_DEBUG: '1' });
  await debug.call('initialize', INITIALIZE);
  await debug.tool('search_facts', { query: 'port <private>hunter2-secret</private>' });
  await debug.stop();
  const logged = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('a full log rotates to .1', fs.existsSync(logFile + '.1') && fs.statSync(logFile + '.1').size >= 5 * 1024 * 1024);
  check('requests and responses are logged', /\] IN: /.test(logged) && /\] OUT: /.test(logged), logged.slice(0, 160));
  check('each request is logged once', (logged.match(/\] IN: /g) || []).length === 2, logged.slice(0, 300));
  check('private blocks are redacted', logged.length > 0 && !logged.includes('hunter2-secret'));

  console.log('\n13. a workspace db deleted under the server is reopened, not written blind');
  if (process.platform === 'win32') {
    console.log('  skip (an open database cannot be deleted on Windows)');
  } else {
    const pruned = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpprune-'));
    fs.writeFileSync(path.join(pruned, 'package.json'), '{}');
    const first = await tool('record_fact', { kind: 'gotcha', title: 'before prune', body: 'recorded before the db was deleted', cwd: pruned });
    await tool('list_sessions', { cwd: pruned });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(first.db + suffix, { force: true });

    const second = await tool('record_fact', { kind: 'gotcha', title: 'after prune', body: 'recorded after the db was deleted', cwd: pruned });
    const onDisk = new D(second.db, { readonly: true });
    const titles = onDisk.prepare('SELECT title FROM facts').all().map(r => r.title);
    onDisk.close();
    check('a fact recorded afterwards lands in the file on disk', titles.includes('after prune'), JSON.stringify(titles));

    const writer = new MemoryStore({ dbPath: second.db });
    writer.startSession({ id: 'after-prune', ide: 'test', cwd: pruned });
    writer.close();
    const sessions = await tool('list_sessions', { cwd: pruned });
    check('observation reads see the new file', Array.isArray(sessions) && sessions.some(s => s.id === 'after-prune'),
      JSON.stringify(sessions));
    fs.rmSync(pruned, { recursive: true, force: true });
  }

  console.log('\n14. symbol evidence the parser cannot re-read is reported, not passed off as current');
  const uncheckedWs = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-unchecked-'));
  {
    fs.writeFileSync(path.join(uncheckedWs, '.caipira-workspace'), '');
    const apiFile = path.join(uncheckedWs, 'api.js');
    fs.writeFileSync(apiFile, 'function api(value) { return value; }\nmodule.exports = { api };\n');
    const info = require(ROOT + '/workspace.js').ensureWorkspace(uncheckedWs);
    require(ROOT + '/ast.js').syncWorkspaceAst(uncheckedWs, info.dbFile);
    const anchoredApi = await tool('record_fact', { kind: 'constraint', title: 'Api argument count', summary: 'Api takes one argument.',
      body: 'api takes exactly one argument.', evidence_symbols: ['api.js::api'], cwd: uncheckedWs });
    // Only the symbol anchor is left to vouch for the fact.
    await tool('update_fact', { id: anchoredApi.id, evidence: [], cwd: uncheckedWs });
    const DAY_AGO = Date.now() - 86400000;
    const writable = new D(info.dbFile);
    writable.prepare('UPDATE facts SET last_verified_at = ? WHERE id = ?').run(DAY_AGO, anchoredApi.id);
    writable.close();
    fs.writeFileSync(apiFile, 'function api(value, extra) { return value; }\nmodule.exports = { api };\n');

    const blind = startServer({ CAIPIRA_AST_BIN: path.join(uncheckedWs, 'no-such-caipira-ast') });
    try {
      await blind.call('initialize', INITIALIZE);
      const local = await blind.tool('search_facts', { query: 'api argument count', include_stale: false, cwd: uncheckedWs });
      const hit = local.facts && local.facts.find(f => f.id === anchoredApi.id);
      check('include_stale:false still returns the fact, still active', hit && hit.state === 'active', JSON.stringify(local));
      check('evidence_status reports the unchecked anchor', hit && hit.evidence_status && hit.evidence_status.unchecked === 1
        && hit.evidence_status.changed === 0 && hit.evidence_status.broken.length === 0, JSON.stringify(hit));
      check('no stale file is invented and the existing fields stay', hit && Array.isArray(hit.stale_files) && hit.stale_files.length === 0
        && typeof hit.trust === 'number' && hit.kind === 'constraint' && hit.summary === 'Api takes one argument.', JSON.stringify(hit));

      const envelope = await blind.call('tools/call', { name: 'search_facts', arguments: { query: 'api argument count', scope: 'all', cwd: tmp } });
      const text = envelope.result && envelope.result.content && envelope.result.content[0];
      check('scope:all keeps the JSON-RPC text envelope', envelope.jsonrpc === '2.0' && !envelope.error && text && text.type === 'text',
        JSON.stringify(envelope).slice(0, 200));
      const all = text ? JSON.parse(text.text) : {};
      const borrowed = all.facts && all.facts.find(f => f.id === anchoredApi.id && f.workspace === info.root);
      check('scope:all labels the result and carries its unchecked count', borrowed && borrowed.evidence_status?.unchecked === 1
        && borrowed.stale_files.length === 0, JSON.stringify(all).slice(0, 400));
    } finally {
      await blind.stop();
    }
    const kept = new D(info.dbFile, { readonly: true });
    const row = kept.prepare('SELECT state, last_verified_at FROM facts WHERE id = ?').get(anchoredApi.id);
    kept.close();
    check('SQLite: still active, last_verified_at not advanced', row.state === 'active' && row.last_verified_at === DAY_AGO, JSON.stringify(row));

    const healthy = await tool('search_facts', { query: 'api argument count', cwd: uncheckedWs });
    const seen = healthy.facts && healthy.facts.find(f => f.id === anchoredApi.id);
    check('with the parser available the anchor is checked and its change found', seen && seen.evidence_status?.unchecked === 0
      && seen.evidence_status?.broken[0]?.reason === 'symbol_signature_changed' && seen.stale_files.includes(path.join(info.root, 'api.js')), JSON.stringify(seen));
  }

  console.log('\n10. native module failure leaves MCP discovery and JSON-RPC errors usable');
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-native-'));
  const preload = path.join(nativeHome, 'native.cjs');
  fs.writeFileSync(preload, `const Module = require('module'), load = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'better-sqlite3') throw Object.assign(new Error('synthetic ABI failure <private>hidden</private>'), {code: 'ERR_DLOPEN_FAILED'});
      return load.call(this, id, ...args);
    };`);
  const broken = startServer({ CAIPIRA_HOME: nativeHome, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, CAIPIRA_DEBUG: '1' });
  try {
    const init = await broken.call('initialize', INITIALIZE);
    check('native failure still initializes MCP', init.result?.serverInfo.version === require('../package.json').version, JSON.stringify(init));
    const response = await broken.call('tools/call', { name: 'list_sessions', arguments: {} });
    check('native failure returns a protocol error', response.jsonrpc === '2.0' && response.error?.code === -32000, JSON.stringify(response));
    check('native failure keeps dependency details out of the client response', !JSON.stringify(response).includes('hidden') &&
      response.error.message.includes('caipira logs'), JSON.stringify(response));
    const ping = await broken.call('ping', {});
    check('native failure keeps the server responsive', Boolean(ping.result), JSON.stringify(ping));
    const entries = fs.readFileSync(path.join(nativeHome, 'logs', 'errors.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    check('native failure is journaled once with sanitized metadata', entries.length === 1 && entries[0].component === 'mcp' &&
      entries[0].error.code === 'ERR_DLOPEN_FAILED' && !JSON.stringify(entries).includes('hidden'), JSON.stringify(entries));
    const logs = require('child_process').spawnSync(NODE, [ROOT + '/install.js', 'logs'], {
      encoding: 'utf8', env: { ...process.env, CAIPIRA_HOME: nativeHome, NODE_OPTIONS: `--require=${preload}` }, timeout: 10000
    });
    check('logs command works without native SQLite', logs.status === 0 && logs.stdout.includes('ERR_DLOPEN_FAILED') && logs.stdout.includes('Reproduce:'), logs.stdout + logs.stderr);
  } finally {
    await broken.stop();
    fs.rmSync(nativeHome, { recursive: true, force: true });
  }

  await server.stop();
  try { fs.rmSync(uncheckedWs, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(partial, { recursive: true, force: true }); } catch {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('CRASH', e.message);
  server.stop();
  process.exit(1);
});
