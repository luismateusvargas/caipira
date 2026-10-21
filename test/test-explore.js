// Drives explore-server.js over real HTTP against a fixture workspace: the
// workspace list, every graph view and the edge kinds it joins, symbol
// inspection with bounded source, symbol search, fact creation, update,
// supersede, archive and drift reaffirmation (checked in SQLite as well as
// in the payloads), path confinement, the write guards, the static bundle,
// and `caipira explore` started through caipira.sh.
//
// Builds the crate first (debug profile) and points CAIPIRA_AST_BIN at it,
// like test-ast, so the server indexes with the engine in this checkout.
require('./fixtures').ensureIsolatedHome();
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs'), http = require('http'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const CRATE = path.join(ROOT, 'rust', 'caipira-ast');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
};
const scratch = [];
process.on('exit', () => {
  for (const dir of scratch) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
const tempDir = prefix => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); scratch.push(dir); return dir; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!process.env.CAIPIRA_AST_BIN) {
  try {
    execFileSync('cargo', ['build', '--quiet', '--manifest-path', path.join(CRATE, 'Cargo.toml')], { stdio: ['ignore', 'ignore', 'inherit'] });
    process.env.CAIPIRA_AST_BIN = path.join(CRATE, 'target', 'debug', process.platform === 'win32' ? 'caipira-ast.exe' : 'caipira-ast');
  } catch (error) {
    console.log('  FAIL cargo build of rust/caipira-ast -> ' + error.message);
    console.log('\n0 passed, 1 failed\n');
    process.exit(1);
  }
}

const { createExploreServer, parseArgs, UsageError } = require(ROOT + '/explore-server.js');
const { ensureWorkspace, openWorkspaceDb, machineId } = require(ROOT + '/workspace.js');
const { FactStore } = require(ROOT + '/facts.js');
const { syncWorkspaceAst } = require(ROOT + '/ast.js');

// ── fixture workspace ──

const FILES = {
  'src/types.ts': [
    'export interface User {',
    '  first: string;',
    '  last: string;',
    '}',
    '',
    'export interface UserRecord {',
    '  id: number;',
    '  user: User;',
    '}',
    ''
  ],
  'src/store.ts': [
    "import { User, UserRecord } from './types';",
    '',
    '/** Keeps users in memory. */',
    'export class UserStore {',
    '  private users: UserRecord[] = [];',
    '',
    '  /** Adds a user and returns the stored record. */',
    '  addUser(user: User, notify: boolean = false): UserRecord {',
    '    const record = { id: this.count() + 1, user };',
    '    this.users.push(record);',
    '    return record;',
    '  }',
    '',
    '  count(): number {',
    '    return this.users.length;',
    '  }',
    '}',
    '',
    'export class AdminStore extends UserStore {}',
    ''
  ],
  'src/api.ts': [
    "import { UserStore } from './store';",
    "import { User } from './types';",
    '',
    'export function createUser(store: UserStore, user: User) {',
    '  return store.addUser(user);',
    '}',
    ''
  ],
  'src/Widget.tsx': [
    'export function Widget() {',
    '  return <div>users</div>;',
    '}',
    ''
  ],
  'docs/notes.md': ['# Notes', '', 'Users are kept in memory.', '']
};

const WS = tempDir('explore-ws-');
fs.writeFileSync(path.join(WS, 'package.json'), '{"name":"explore-fixture"}\n');
for (const [rel, lines] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(path.join(WS, rel)), { recursive: true });
  fs.writeFileSync(path.join(WS, rel), lines.join('\n'));
}
const OUTSIDE = tempDir('explore-outside-');
fs.writeFileSync(path.join(OUTSIDE, 'secret.ts'), 'export const SECRET = "do not serve";\n');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const workspace = ensureWorkspace(WS);
syncWorkspaceAst(workspace.root, workspace.dbFile);

// Two seeded facts, the second superseding the first, and one session whose
// tool calls wrote src/api.ts and touched createUser.
{
  const db = openWorkspaceDb(workspace.dbFile);
  const store = new FactStore(db, { machine: machineId(), agent: 'test', root: workspace.root });
  const old = store.record({ kind: 'decision', title: 'Users are stored in arrays', body: 'A plain array holds users.', evidence: [path.join(WS, 'src/store.ts')] });
  store.record({ kind: 'decision', title: 'Users live in UserStore', body: 'UserStore owns the user array.', supersedes: old, evidence: [path.join(WS, 'docs/notes.md')] });
  store.record({ kind: 'gotcha', title: 'createUser never notifies', body: 'notify defaults to false.', evidence: [path.join(WS, 'src/api.ts')] });
  db.prepare("INSERT INTO sessions (id, ide, cwd, started_at, summary) VALUES ('sess-1', 'claude-code', ?, ?, 'Tools: Edit (1 calls)')")
    .run(WS, Date.now());
  db.prepare(`INSERT INTO observations (session_id, kind, content, ts, metadata) VALUES ('sess-1', 'tool_result', 'tool=Edit', ?, ?)`)
    .run(Date.now(), JSON.stringify({ tool: 'Edit', files: [path.join(WS, 'src/api.ts')], symbols: ['src/api.ts::createUser'] }));
  db.close();
}

const symbolId = qualified => {
  const db = openWorkspaceDb(workspace.dbFile);
  try { return db.prepare('SELECT id FROM ast_symbols WHERE qualified_name = ?').get(qualified)?.id ?? null; } finally { db.close(); }
};

// A stand-in bundle, so static serving is tested without a vite build.
const DIST = tempDir('explore-dist-');
fs.mkdirSync(path.join(DIST, 'assets'));
fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><title>explore-fixture</title><script type="module" src="/assets/app-1a2b.js"></script>');
fs.writeFileSync(path.join(DIST, 'assets', 'app-1a2b.js'), 'console.log("explore");\n');
fs.writeFileSync(path.join(DIST, 'assets', 'app-1a2b.css'), 'body { color: red; }\n');

// ── HTTP ──

function request(port, method, target, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: target,
      headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* static responses are not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error(`${method} ${target} timed out`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

const kindsOf = items => [...new Set(items.map(item => item.kind))].sort();
const typesOf = nodes => [...new Set(nodes.map(node => node.type))].sort();

async function main() {
  const server = createExploreServer({ defaultWorkspace: WS, distDir: DIST });
  const port = await listen(server);
  const get = target => request(port, 'GET', target);
  const send = (method, target, body, headers) => request(port, method, target, { body, headers });

  try {
    console.log('\n1. GET /api/workspaces lists registered workspaces with counts');
    let r = await get('/api/workspaces');
    const listed = r.json && r.json.workspaces.find(w => w.id === workspace.id);
    check('200 with the fixture as default', r.status === 200 && r.json.defaultWorkspaceId === workspace.id, r.text);
    check('counts files, symbols and open facts', listed && listed.available && listed.counts.files === 4
      && listed.counts.symbols >= 8 && listed.counts.facts === 2, listed);

    console.log('\n2. GET /api/graph joins code, facts and sessions');
    r = await get('/api/graph');
    const graph = r.json;
    check('200 with nodes, edges, stats, driftCount', r.status === 200 && Array.isArray(graph.nodes) && Array.isArray(graph.edges)
      && graph.stats && typeof graph.driftCount === 'number', r.text.slice(0, 300));
    check('all four node types', JSON.stringify(typesOf(graph.nodes)) === '["fact","file","session","symbol"]', typesOf(graph.nodes));
    check('every edge kind', JSON.stringify(kindsOf(graph.edges)) === JSON.stringify(
      ['calls', 'defines', 'evidences', 'extends', 'imports', 'supersedes', 'touched', 'uses_type']), kindsOf(graph.edges));
    const node = id => graph.nodes.find(n => n.id === id);
    const edge = (kind, source, target) => graph.edges.some(e => e.kind === kind && e.source === source && e.target === target);
    const addUser = symbolId('UserStore.addUser');
    const createUser = symbolId('createUser');
    check('symbol kinds include interface, class, method, function and a derived component',
      ['interface', 'class', 'method', 'function', 'component'].every(kind => graph.nodes.some(n => n.type === 'symbol' && n.kind === kind)),
      kindsOf(graph.nodes.filter(n => n.type === 'symbol')));
    check('Widget in a .tsx file is a component', node(`symbol:${symbolId('Widget')}`)?.kind === 'component');
    check('file nodes carry their directory group and language', node('file:src/store.ts')?.group === 'src' && node('file:src/store.ts')?.language === 'typescript');
    check('defines: file -> symbol', edge('defines', 'file:src/store.ts', `symbol:${addUser}`));
    check('calls: this.count() resolves in-file', edge('calls', `symbol:${addUser}`, `symbol:${symbolId('UserStore.count')}`));
    check('calls: store.addUser() resolves to the unique method', edge('calls', `symbol:${createUser}`, `symbol:${addUser}`));
    check('imports: file -> file', edge('imports', 'file:src/api.ts', 'file:src/store.ts'));
    check('uses_type: symbol -> type', edge('uses_type', `symbol:${addUser}`, `symbol:${symbolId('User')}`));
    check('extends: subclass -> class', edge('extends', `symbol:${symbolId('AdminStore')}`, `symbol:${symbolId('UserStore')}`));
    check('supersedes: new fact -> old fact', edge('supersedes', 'fact:2', 'fact:1'));
    check('evidences: fact -> file, including an unindexed one', edge('evidences', 'fact:3', 'file:src/api.ts')
      && edge('evidences', 'fact:2', 'file:docs/notes.md') && node('file:docs/notes.md')?.indexed === false);
    check('touched: session -> file and symbol', edge('touched', 'session:sess-1', 'file:src/api.ts') && edge('touched', 'session:sess-1', `symbol:${createUser}`));
    check('callers counted on the callee', node(`symbol:${addUser}`)?.callers === 1, node(`symbol:${addUser}`));
    check('superseded fact present, revoked facts absent', node('fact:1')?.state === 'superseded');
    check('no drift yet', graph.driftCount === 0 && graph.nodes.filter(n => n.type === 'fact').every(n => n.drifted === false));

    console.log('\n3. graph views and filters');
    r = await get('/api/graph?view=architecture');
    check('architecture: code nodes and code edges only', r.status === 200 && JSON.stringify(typesOf(r.json.nodes)) === '["file","symbol"]'
      && r.json.edges.every(e => ['defines', 'calls', 'imports', 'uses_type', 'extends'].includes(e.kind)), typesOf(r.json.nodes));
    r = await get('/api/graph?view=knowledge');
    check('knowledge: facts, sessions and what they touch, no call edges', r.status === 200
      && r.json.nodes.some(n => n.type === 'fact') && r.json.nodes.some(n => n.id === 'file:src/api.ts')
      && !r.json.edges.some(e => e.kind === 'calls' || e.kind === 'imports'), kindsOf(r.json.edges));
    r = await get(`/api/graph?view=impact&symbolId=${addUser}&depth=1`);
    const impactIds = r.json ? r.json.nodes.map(n => n.id) : [];
    check('impact: the 1-hop neighborhood of the focus', r.status === 200 && r.json.focusId === `symbol:${addUser}`
      && impactIds.includes(`symbol:${createUser}`) && impactIds.includes(`symbol:${symbolId('UserStore.count')}`)
      && impactIds.includes('file:src/store.ts') && !impactIds.includes(`symbol:${symbolId('Widget')}`), impactIds);
    r = await get(`/api/graph?view=impact&symbolId=${addUser}&depth=2`);
    check('impact: depth 2 reaches further', r.json && r.json.nodes.length > impactIds.length && r.json.nodes.some(n => n.id === 'session:sess-1'));
    r = await get('/api/graph?view=impact');
    check('impact without symbolId is 400', r.status === 400 && r.json.error.code === 'invalid_argument', r.text);
    r = await get('/api/graph?view=impact&symbolId=999999');
    check('impact on an unknown symbol is 404', r.status === 404, r.text);
    r = await get('/api/graph?view=sideways');
    check('unknown view is 400', r.status === 400, r.text);
    r = await get('/api/graph?pathPrefix=src/api.ts');
    check('pathPrefix keeps that file, its symbols and the facts touching it', r.status === 200
      && r.json.nodes.filter(n => n.type === 'file').map(n => n.id).join() === 'file:src/api.ts'
      && r.json.nodes.some(n => n.id === 'fact:3') && !r.json.nodes.some(n => n.id === 'fact:2'), r.json && r.json.nodes.map(n => n.id));
    r = await get('/api/graph?kind=interface&view=architecture');
    check('kind filter', r.status === 200 && r.json.nodes.filter(n => n.type === 'symbol').every(n => n.kind === 'interface')
      && r.json.nodes.filter(n => n.type === 'symbol').length === 2, r.json && r.json.nodes.length);
    r = await get('/api/graph?category=gotcha&view=knowledge');
    check('category filter', r.status === 200 && r.json.nodes.filter(n => n.type === 'fact').map(n => n.factId).join() === '3');
    r = await get('/api/graph?limit=3');
    check('node limit truncates and says so', r.status === 200 && r.json.nodes.length === 3 && r.json.stats.truncated === true
      && r.json.nodes.every(n => n.type === 'fact'), r.json && r.json.nodes.map(n => n.id));
    r = await get('/api/graph?workspace=999999');
    check('unknown workspace is 404', r.status === 404 && r.json.error.code === 'workspace_not_found', r.text);

    console.log('\n4. GET /api/symbol/:id inspects inputs, outputs and neighbours');
    r = await get(`/api/symbol/${addUser}`);
    const detail = r.json;
    check('200', r.status === 200, r.text.slice(0, 300));
    check('receives: name, type annotation and default', JSON.stringify(detail.symbol.params) === JSON.stringify([
      { name: 'user', type_annotation: 'User', default_value: null },
      { name: 'notify', type_annotation: 'boolean', default_value: 'false' }
    ]), detail.symbol.params);
    check('returns, docstring, visibility and language', detail.symbol.return_type === 'UserRecord'
      && detail.symbol.doc_summary === 'Adds a user and returns the stored record.' && detail.language === 'typescript'
      && detail.symbol.start_line === 8 && detail.symbol.end_line === 12, detail.symbol);
    check('callers carry symbol ids', detail.callers.some(c => c.symbol === 'createUser' && c.symbol_id === createUser), detail.callers);
    check('callees carry symbol ids', detail.callees.some(c => c.target_symbol === 'UserStore.count' && c.symbol_id === symbolId('UserStore.count')), detail.callees);
    check('type connections', detail.uses_types.map(t => t.target_symbol).sort().join() === 'User,UserRecord', detail.uses_types);
    check('type links name workspace types', detail.type_links.User === symbolId('User') && detail.type_links.UserRecord === symbolId('UserRecord')
      && detail.type_links.boolean === undefined, detail.type_links);
    check('source preview is exactly the symbol\'s lines', detail.source.status === 'ok' && detail.source.start_line === 8
      && JSON.stringify(detail.source.lines) === JSON.stringify(FILES['src/store.ts'].slice(7, 12)), detail.source);
    r = await get(`/api/symbol/${symbolId('UserStore')}`);
    check('long symbol previews stay within its range', r.status === 200 && r.json.source.lines.length === 14, r.json && r.json.source);
    r = await get('/api/symbol/999999');
    check('unknown symbol is 404', r.status === 404 && r.json.error.code === 'symbol_not_found', r.text);
    r = await get('/api/symbol/abc');
    check('non-numeric id is 400', r.status === 400, r.text);

    console.log('\n5. GET /api/symbols searches names, parameter types and return types');
    r = await get('/api/symbols?q=UserRecord');
    check('by return type', r.status === 200 && r.json.symbols.some(s => s.id === addUser), r.json && r.json.symbols.map(s => s.qualified_name));
    r = await get('/api/symbols?q=boolean');
    check('by parameter type', r.status === 200 && r.json.symbols.some(s => s.id === addUser), r.json && r.json.symbols.map(s => s.qualified_name));
    r = await get('/api/symbols?q=store');
    check('files match by path', r.status === 200 && r.json.files.some(f => f.path === 'src/store.ts'), r.json && r.json.files);
    r = await get('/api/symbols?q=Widget');
    check('derived component kind in results', r.json && r.json.symbols.find(s => s.name === 'Widget')?.kind === 'component');
    r = await get('/api/symbols?limit=101');
    check('limit is bounded', r.status === 400, r.text);

    console.log('\n6. facts: create, update, supersede, archive');
    r = await send('POST', '/api/facts', { kind: 'constraint', title: 'addUser returns the stored record', body: 'Callers rely on the returned record.', evidenceSymbols: [addUser] });
    const anchored = r.json && r.json.fact;
    check('201 with the symbol anchor', r.status === 201 && anchored.symbols.length === 1 && anchored.symbols[0].symbolId === addUser
      && anchored.symbols[0].current === true && anchored.evidence.some(e => e.path === 'src/store.ts'), r.text);
    r = await get(`/api/symbol/${addUser}`);
    check('attached to the symbol in the inspector', r.json.facts.some(f => f.fact_id === anchored.id && f.evidence_status === 'current'), r.json.facts);
    r = await get(`/api/symbol/${createUser}`);
    check('facts anchored to the symbol\'s file are attached too', r.json.facts.some(f => f.fact_id === 3 && f.evidence_status === 'file'), r.json.facts);
    r = await send('POST', '/api/facts', { kind: 'gotcha', title: 'Notes are prose', body: 'docs/notes.md is not indexed.', evidenceFiles: ['docs/notes.md'] });
    check('a file-anchored fact', r.status === 201 && r.json.fact.evidence[0].path === 'docs/notes.md' && r.json.fact.evidence[0].indexed === false, r.text);
    const noteFact = r.json.fact.id;
    r = await send('POST', '/api/facts', { kind: 'rumour', title: 'x', body: 'y' });
    check('unknown kind is 400', r.status === 400, r.text);
    r = await send('POST', '/api/facts', { kind: 'gotcha', body: 'no title' });
    check('missing title is 400', r.status === 400, r.text);
    r = await send('POST', '/api/facts', { kind: 'gotcha', title: 't', body: 'b', evidenceSymbols: [999999] });
    check('unknown evidence symbol is 404', r.status === 404, r.text);
    r = await send('POST', '/api/facts', { kind: 'gotcha', title: 't', body: 'b', evidenceFiles: ['src/missing.ts'] });
    check('missing evidence file is 400', r.status === 400, r.text);
    r = await send('PATCH', `/api/facts/${noteFact}`, { action: 'update', title: 'Notes are prose, not code' });
    check('update edits in place', r.status === 200 && r.json.fact.title === 'Notes are prose, not code', r.text);
    r = await send('PATCH', `/api/facts/${noteFact}`, { action: 'supersede', kind: 'gotcha', title: 'Notes live in docs/', body: 'All prose is under docs/.' });
    const successor = r.json && r.json.fact;
    check('supersede records a successor that inherits evidence', r.status === 201 && successor.supersedes === noteFact
      && r.json.superseded.state === 'superseded' && r.json.superseded.supersededBy === successor.id
      && successor.evidence.some(e => e.path === 'docs/notes.md'), r.text);
    r = await send('PATCH', `/api/facts/${noteFact}`, { action: 'reaffirm' });
    check('a superseded fact cannot be reaffirmed', r.status === 409 && r.json.error.code === 'fact_closed', r.text);
    r = await send('PATCH', `/api/facts/${successor.id}`, { action: 'archive' });
    check('archive revokes', r.status === 200 && r.json.fact.state === 'revoked', r.text);
    r = await get('/api/facts');
    check('archived facts leave the standing list', r.status === 200 && !r.json.facts.some(f => f.id === successor.id)
      && r.json.facts.some(f => f.id === anchored.id), r.json && r.json.facts.map(f => f.id));
    r = await get('/api/facts?state=all&category=gotcha');
    check('state and category filters', r.status === 200 && r.json.facts.every(f => f.kind === 'gotcha' && f.state !== 'revoked')
      && r.json.facts.some(f => f.state === 'superseded'), r.json && r.json.facts.map(f => [f.id, f.state]));
    r = await get('/api/facts?q=stored+record');
    check('text search', r.status === 200 && r.json.facts.some(f => f.id === anchored.id), r.json && r.json.facts.map(f => f.id));
    r = await send('PATCH', `/api/facts/${anchored.id}`, { action: 'explode' });
    check('unknown action is 400', r.status === 400, r.text);
    r = await send('PATCH', '/api/facts/999999', { action: 'reaffirm' });
    check('unknown fact is 404', r.status === 404, r.text);

    console.log('\n7. drift: a changed signature needs review until reaffirmed');
    const storeFile = path.join(WS, 'src/store.ts');
    const changed = FILES['src/store.ts'].map(line => line.replace('addUser(user: User, notify: boolean = false): UserRecord {',
      'addUser(user: User, notify: boolean = false, source: string = "api"): UserRecord {'));
    fs.writeFileSync(storeFile, changed.join('\n'));
    r = await get('/api/facts?refresh=1');
    const drifted = r.json && r.json.facts.find(f => f.id === anchored.id);
    check('re-check flags the anchored fact', r.status === 200 && drifted && drifted.state === 'needs_review' && drifted.drifted === true
      && drifted.symbols[0].current === false && r.json.driftCount >= 1, drifted);
    r = await get('/api/graph?view=knowledge');
    check('graph marks the fact node drifted', r.json.nodes.find(n => n.id === `fact:${anchored.id}`)?.drifted === true && r.json.driftCount >= 1);
    r = await get(`/api/symbol/${symbolId('UserStore.addUser')}`);
    check('inspector shows NEEDS REVIEW state', r.json.facts.some(f => f.fact_id === anchored.id && f.state === 'needs_review' && f.evidence_status === 'drifted'), r.json.facts);
    const before = (() => {
      const db = openWorkspaceDb(workspace.dbFile);
      try { return db.prepare('SELECT last_verified_at FROM facts WHERE id = ?').get(anchored.id).last_verified_at; } finally { db.close(); }
    })();
    await sleep(5);
    r = await send('PATCH', `/api/facts/${anchored.id}`, { action: 'reaffirm' });
    check('reaffirm clears drift in the payload', r.status === 200 && r.json.fact.state === 'active' && r.json.fact.drifted === false
      && r.json.fact.symbols[0].current === true, r.text);
    {
      const db = openWorkspaceDb(workspace.dbFile);
      try {
        const fact = db.prepare('SELECT state, last_verified_at FROM facts WHERE id = ?').get(anchored.id);
        const anchor = db.prepare('SELECT signature_hash FROM fact_symbol_evidence WHERE fact_id = ?').get(anchored.id);
        const current = db.prepare("SELECT signature_hash FROM ast_symbols WHERE path = 'src/store.ts' AND qualified_name = 'UserStore.addUser'").get();
        const file = db.prepare('SELECT sha256 FROM fact_evidence WHERE fact_id = ? AND path = ?').get(anchored.id, storeFile);
        check('SQLite: state active and verified_at moved', fact.state === 'active' && fact.last_verified_at > before, fact);
        check('SQLite: signature_hash refreshed to the new signature', anchor.signature_hash === current.signature_hash, { anchor, current });
        check('SQLite: fact_evidence.sha256 refreshed', file && file.sha256 === sha256(storeFile), file);
      } finally {
        db.close();
      }
    }
    r = await get('/api/facts?refresh=1');
    check('drift stays cleared on the next check', r.json.facts.find(f => f.id === anchored.id)?.state === 'active', r.json.facts.find(f => f.id === anchored.id));

    console.log('\n8. POST /api/reindex');
    fs.writeFileSync(path.join(WS, 'src/extra.ts'), 'export function extra(value: number): number {\n  return value * 2;\n}\n');
    r = await send('POST', '/api/reindex', {});
    check('incremental stats', r.status === 200 && r.json.stats.parsed === 1 && typeof r.json.driftCount === 'number', r.text);
    r = await get('/api/symbols?q=extra');
    check('new file is searchable', r.json.symbols.some(s => s.name === 'extra'), r.json.symbols);

    console.log('\n9. paths stay inside the workspace');
    {
      const db = openWorkspaceDb(workspace.dbFile);
      const plant = (rel, start, end) => Number(db.prepare(`INSERT INTO ast_symbols
        (path, name, qualified_name, kind, is_public, start_line, end_line, params_json, signature_text, signature_hash)
        VALUES (?, 'planted', 'planted', 'function', 1, ?, ?, '[]', 'function planted()', 'x')`).run(rel, start, end).lastInsertRowid);
      const relative = plant(path.relative(WS, path.join(OUTSIDE, 'secret.ts')), 1, 1);
      const absolute = plant(path.join(OUTSIDE, 'secret.ts'), 1, 1);
      let linked = null;
      try {
        fs.symlinkSync(path.join(OUTSIDE, 'secret.ts'), path.join(WS, 'src', 'link.ts'));
        linked = plant('src/link.ts', 1, 1);
      } catch { /* no symlink support here */ }
      db.close();
      for (const [label, id] of [['../ traversal', relative], ['absolute path', absolute], ['symlink out of the root', linked]]) {
        if (id === null) continue;
        r = await get(`/api/symbol/${id}`);
        check(`source preview refuses a ${label} (403)`, r.status === 403 && r.json.error.code === 'path_outside_workspace' && !r.text.includes('do not serve'), r.text);
      }
    }
    r = await send('POST', '/api/facts', { kind: 'gotcha', title: 't', body: 'b', evidenceFiles: ['../' + path.basename(OUTSIDE) + '/secret.ts'] });
    check('evidence outside the root is 403', r.status === 403, r.text);
    r = await send('POST', '/api/facts', { kind: 'gotcha', title: 't', body: 'b', evidenceFiles: [path.join(OUTSIDE, 'secret.ts')] });
    check('absolute evidence path is 403', r.status === 403, r.text);
    r = await get('/api/symbol/..%2F..%2Fetc%2Fpasswd');
    check('encoded traversal in a symbol id is 400', r.status === 400, r.text);
    r = await get('/..%2F..%2F..%2Fetc%2Fpasswd');
    check('encoded traversal out of the bundle is 403', r.status === 403 && !r.text.includes('root:'), r.text.slice(0, 120));

    console.log('\n10. writes are same-origin JSON only');
    r = await send('POST', '/api/facts', 'kind=gotcha&title=t&body=b', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('form posts are 415', r.status === 415, r.text);
    r = await send('POST', '/api/facts', { kind: 'gotcha', title: 't', body: 'b' }, { Origin: 'http://evil.example' });
    check('cross-origin JSON is 403', r.status === 403 && r.json.error.code === 'cross_origin', r.text);
    r = await send('POST', '/api/facts', '{"kind":', {});
    check('malformed JSON is 400', r.status === 400 && r.json.error.code === 'invalid_json', r.text);
    r = await request(port, 'GET', '/api/workspaces', { headers: { Host: `evil.example:${port}` } });
    check('a non-loopback Host is 403 (DNS rebinding)', r.status === 403 && r.json.error.code === 'forbidden_host', r.text);
    r = await request(port, 'GET', '/api/workspaces', { headers: { Host: `localhost:${port}` } });
    check('localhost Host is accepted', r.status === 200);
    r = await request(port, 'DELETE', '/api/facts');
    check('unsupported method is 405', r.status === 405, r.text);
    r = await get('/api/nothing');
    check('unknown endpoint is 404', r.status === 404, r.text);

    console.log('\n11. the static bundle');
    r = await get('/');
    check('index.html at /', r.status === 200 && /text\/html/.test(r.headers['content-type']) && r.text.includes('explore-fixture'), r.headers);
    check('security headers', r.headers['x-content-type-options'] === 'nosniff' && /default-src 'self'/.test(r.headers['content-security-policy']), r.headers);
    r = await get('/assets/app-1a2b.js');
    check('JavaScript MIME type, cached immutably', r.status === 200 && /text\/javascript/.test(r.headers['content-type'])
      && /immutable/.test(r.headers['cache-control']), r.headers);
    r = await get('/assets/app-1a2b.css');
    check('CSS MIME type', r.status === 200 && /text\/css/.test(r.headers['content-type']), r.headers);
    r = await get('/knowledge/facts');
    check('client routes fall back to the app shell', r.status === 200 && r.text.includes('explore-fixture'));
    r = await get('/assets/missing.js');
    check('a missing asset is 404', r.status === 404, r.text);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log('\n12. without a built UI the API still answers');
  {
    const bare = createExploreServer({ defaultWorkspace: WS, distDir: path.join(tempDir('explore-nodist-'), 'dist') });
    const port = await listen(bare);
    try {
      let r = await request(port, 'GET', '/');
      check('/ explains the UI is not built (503)', r.status === 503 && /caipira install/.test(r.text), r.text);
      r = await request(port, 'GET', '/api/workspaces');
      check('API still answers', r.status === 200);
    } finally {
      await new Promise(resolve => bare.close(resolve));
    }
  }
  const built = path.join(ROOT, 'explore-ui', 'dist', 'index.html');
  if (fs.existsSync(built)) {
    const real = createExploreServer({ defaultWorkspace: WS });
    const port = await listen(real);
    try {
      const r = await request(port, 'GET', '/');
      const assets = [...r.text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
      const served = await Promise.all(assets.map(asset => request(port, 'GET', asset)));
      check('the built explore-ui bundle is served with its assets', r.status === 200 && assets.length >= 2
        && served.every(response => response.status === 200), assets);
    } finally {
      await new Promise(resolve => real.close(resolve));
    }
  } else {
    console.log('  skip explore-ui/dist not built (npm --prefix explore-ui run build)');
  }

  console.log('\n13. command line');
  check('defaults: port 4777, host 127.0.0.1, browser opens', (() => {
    const opts = parseArgs([]);
    return opts.port === 4777 && opts.host === '127.0.0.1' && opts.open === true;
  })());
  check('flags parse', (() => {
    const opts = parseArgs(['--port', '0', '--host=::1', '--workspace', WS, '--no-open']);
    return opts.port === 0 && opts.host === '::1' && opts.workspace === WS && opts.open === false;
  })());
  for (const bad of [['--port', '70000'], ['--port'], ['--bogus']]) {
    let threw = null;
    try { parseArgs(bad); } catch (error) { threw = error; }
    check(`rejects ${bad.join(' ')}`, threw instanceof UsageError, threw && threw.message);
  }

  if (process.platform === 'win32') {
    console.log('  skip caipira.sh launch (POSIX shell only)');
  } else {
    // A launcher directory shaped like ~/.caipira: caipira.sh, the server, and
    // node22 pointing at the node running this suite.
    const home = tempDir('explore-launch-');
    fs.copyFileSync(path.join(ROOT, 'caipira.sh'), path.join(home, 'caipira.sh'));
    fs.symlinkSync(path.join(ROOT, 'explore-server.js'), path.join(home, 'explore-server.js'));
    const nodeDir = path.join(home, 'node22', 'node-v22.20.0-linux-x64', 'bin');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
    const child = spawn('sh', [path.join(home, 'caipira.sh'), 'explore', '--no-open', '--port', '0', '--workspace', WS],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    child.stderr.on('data', chunk => { errText += chunk; });
    const url = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 60000);
      child.stdout.on('data', chunk => {
        out += chunk;
        const match = out.match(/listening on (http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on('exit', () => { clearTimeout(timer); resolve(null); });
    });
    check('caipira explore --no-open --port 0 binds 127.0.0.1', url !== null && url.startsWith('http://127.0.0.1:'), out + errText);
    if (url) {
      const port = Number(new URL(url).port);
      const api = await request(port, 'GET', '/api/workspaces');
      check('and answers /api/workspaces', api.status === 200 && api.json.workspaces.some(w => w.root === workspace.root), api.text.slice(0, 200));
      const shell = await request(port, 'GET', '/');
      check('and serves the UI or the not-built notice at /', shell.status === 200 || shell.status === 503, shell.status);
    }
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    child.kill('SIGTERM');
    check('stops cleanly on SIGTERM', await Promise.race([exited, sleep(10000).then(() => 'timeout')]) === 0);
  }
}

main()
  .catch(error => { fail++; console.log('  FAIL suite crashed -> ' + (error && error.stack || error)); })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  });
