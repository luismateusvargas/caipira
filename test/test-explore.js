// Drives explore-server.js over real HTTP against a fixture workspace: the
// workspace list, every graph view and the edge kinds it joins, symbol
// inspection with bounded source, symbol search, fact creation, update,
// supersede, archive and drift reaffirmation (checked in SQLite as well as
// in the payloads), path confinement, the write guards, the static bundle,
// member callees the inspector and graph resolve alike, fact writes refused
// when symbol evidence cannot be re-read, `caipira explore` started
// through caipira.sh, and fact DTOs that keep saying when symbol evidence
// could not be re-read, per workspace database, through later searches,
// reads and writes, the symbol inspector and the graph.
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

const inDb = (ws, fn) => {
  const db = openWorkspaceDb(ws.dbFile);
  try { return fn(db); } finally { db.close(); }
};
const symbolIn = (ws, qualified) => inDb(ws, db => db.prepare('SELECT id FROM ast_symbols WHERE qualified_name = ?').get(qualified)?.id ?? null);
const symbolId = qualified => symbolIn(workspace, qualified);

// A further indexed workspace, marked explicitly so its root is the fixture
// directory and nothing above it.
function extraWorkspace(prefix, files) {
  const root = tempDir(prefix);
  fs.writeFileSync(path.join(root, '.caipira-workspace'), '');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const ws = ensureWorkspace(root);
  syncWorkspaceAst(ws.root, ws.dbFile);
  return ws;
}

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

    console.log('\n12. inspector callees resolve like graph edges');
    {
      const ws = extraWorkspace('explore-member-', {
        'src/store.ts': 'export class Store { add(value: number): number { return value; } }\n'
          + 'export function caller(store: Store, x: number): number { return store.add(x); }\n'
      });
      const q = `workspace=${ws.id}`;
      const add = symbolIn(ws, 'Store.add');
      const caller = symbolIn(ws, 'caller');
      const callsFromCaller = graph => graph.edges.filter(e => e.kind === 'calls' && e.source === `symbol:${caller}`).map(e => e.target);
      r = await get(`/api/graph?${q}`);
      check('graph: store.add() calls the unique Store.add', r.status === 200 && callsFromCaller(r.json).join() === `symbol:${add}`, r.json && r.json.edges);
      r = await get(`/api/symbol/${caller}?${q}`);
      let callee = r.json && r.json.callees.find(c => c.target_symbol === 'store.add');
      check('inspector: the same callee carries Store.add\'s id', r.status === 200 && callee && callee.target_path === null
        && callee.symbol_id === add, r.json && r.json.callees);

      // A second add() makes the member call ambiguous; neither view guesses.
      fs.writeFileSync(path.join(ws.root, 'src/other.ts'), 'export class Other { add(value: string): string { return value; } }\n');
      syncWorkspaceAst(ws.root, ws.dbFile);
      r = await get(`/api/graph?${q}`);
      check('graph: an ambiguous store.add() draws no call edge', r.status === 200 && callsFromCaller(r.json).length === 0, r.json && r.json.edges);
      r = await get(`/api/symbol/${caller}?${q}`);
      callee = r.json && r.json.callees.find(c => c.target_symbol === 'store.add');
      check('inspector: an ambiguous callee stays unlinked', r.status === 200 && callee && callee.symbol_id === null, r.json && r.json.callees);
    }

    console.log('\n13. symbol evidence the engine cannot re-read is never certified');
    {
      const v1 = 'export class Store {\n  add(value: number): number {\n    return value;\n  }\n}\n';
      const ws = extraWorkspace('explore-refresh-', { 'src/store.ts': v1 });
      const q = `workspace=${ws.id}`;
      const file = path.join(ws.root, 'src/store.ts');
      const add = symbolIn(ws, 'Store.add');
      const snapshot = id => inDb(ws, db => ({
        fact: db.prepare('SELECT state, last_verified_at FROM facts WHERE id = ?').get(id),
        files: db.prepare('SELECT path, sha256, size, mtime FROM fact_evidence WHERE fact_id = ? ORDER BY path').all(id),
        anchors: db.prepare('SELECT path, qualified_name, signature_hash FROM fact_symbol_evidence WHERE fact_id = ?').all(id),
        facts: db.prepare('SELECT id, state FROM facts ORDER BY id').all()
      }));
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

      r = await send('POST', `/api/facts?${q}`, { kind: 'constraint', title: 'add is an identity', body: 'add returns its argument.', evidenceSymbols: [add] });
      const factId = r.json && r.json.fact.id;
      check('a fact anchored to Store.add', r.status === 201 && r.json.fact.symbols[0].current === true, r.text);
      fs.writeFileSync(file, v1.replace('add(value: number): number', 'add(value: string, extra: boolean = true): string'));
      r = await get(`/api/facts?refresh=1&${q}`);
      check('a changed signature needs review', r.json && r.json.facts.find(f => f.id === factId)?.state === 'needs_review', r.text);
      const reindexed = symbolIn(ws, 'Store.add');

      // The source changes again while the engine is gone: the index still
      // holds the first change, so nothing may be certified against it.
      fs.writeFileSync(file, v1.replace('add(value: number): number', 'add(value: boolean, extra: string = "changed"): boolean'));
      const before = snapshot(factId);
      const engine = process.env.CAIPIRA_AST_BIN;
      process.env.CAIPIRA_AST_BIN = path.join(ws.root, 'no-such-caipira-ast');
      try {
        r = await send('PATCH', `/api/facts/${factId}?${q}`, { action: 'reaffirm' });
        check('reaffirm without the engine is a recoverable 503', r.status === 503 && r.json.error.code === 'evidence_unverifiable', r.text);
        check('SQLite: state, verified_at and evidence hashes untouched', same(snapshot(factId), before), { before, after: snapshot(factId) });
        r = await send('POST', `/api/facts?${q}`, { kind: 'gotcha', title: 'add takes booleans', body: 'add takes a boolean now.', evidenceSymbols: [reindexed] });
        check('creating a symbol fact without the engine is 503', r.status === 503 && r.json.error.code === 'evidence_unverifiable', r.text);
        r = await send('PATCH', `/api/facts/${factId}?${q}`, { action: 'supersede', kind: 'constraint', title: 'add is generic', body: 'add returns what it is given.' });
        check('superseding with inherited symbol evidence without the engine is 503', r.status === 503
          && r.json.error.code === 'evidence_unverifiable', r.text);
        check('SQLite: no fact recorded, the predecessor still needs review', same(snapshot(factId), before), snapshot(factId).facts);
        r = await get(`/api/graph?${q}`);
        const inspected = await get(`/api/symbol/${reindexed}?${q}`);
        check('reading the graph and inspector still works without the engine', r.status === 200 && inspected.status === 200, inspected.text);
      } finally {
        process.env.CAIPIRA_AST_BIN = engine;
      }

      r = await send('PATCH', `/api/facts/${factId}?${q}`, { action: 'reaffirm' });
      check('with the engine back, reaffirm certifies the current source', r.status === 200 && r.json.fact.state === 'active'
        && r.json.fact.symbols[0].current === true, r.text);
      inDb(ws, db => {
        const indexed = db.prepare("SELECT signature_text, signature_hash FROM ast_symbols WHERE path = 'src/store.ts' AND qualified_name = 'Store.add'").get();
        const anchor = db.prepare('SELECT signature_hash FROM fact_symbol_evidence WHERE fact_id = ?').get(factId);
        const evidence = db.prepare('SELECT sha256 FROM fact_evidence WHERE fact_id = ? AND path = ?').get(factId, file);
        check('SQLite: index, anchor and file hash describe the boolean signature', /value: boolean/.test(indexed.signature_text)
          && anchor.signature_hash === indexed.signature_hash && evidence.sha256 === sha256(file), { indexed, anchor, evidence });
      });

      fs.writeFileSync(file, 'export class Store {\n  size(): number {\n    return 0;\n  }\n}\n');
      r = await get(`/api/facts?refresh=1&${q}`);
      check('removing the anchored symbol needs review', r.json && r.json.facts.find(f => f.id === factId)?.state === 'needs_review', r.text);
      const gone = snapshot(factId);
      r = await send('PATCH', `/api/facts/${factId}?${q}`, { action: 'reaffirm' });
      check('reaffirming a removed symbol is 409', r.status === 409 && r.json.error.code === 'symbol_changed', r.text);
      check('SQLite: the fact stays in review and unverified', same(snapshot(factId), gone), { gone, after: snapshot(factId) });
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log('\n14. without a built UI the API still answers');
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

  console.log('\n15. command line');
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
    const nodeDir = path.join(home, 'node22', 'node-v22.23.4-linux-x64', 'bin');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(path.join(nodeDir, 'node'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'v22.23.4\\n'; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 });
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

  console.log('\n16. symbol evidence the parser cannot re-read is never reported as current');
  {
    const v1 = 'export function api(value: number): number {\n  return value;\n}\n';
    const blind = extraWorkspace('explore-unchecked-', { 'src/api.ts': v1 });
    const sighted = extraWorkspace('explore-checked-', { 'src/api.ts': v1 });
    const DAY_AGO = Date.now() - 86400000;
    // The same fact id in both databases, vouched for only by its symbol anchor.
    const seed = ws => inDb(ws, db => {
      const store = new FactStore(db, { machine: machineId(), agent: 'test', root: ws.root });
      const signatureHash = db.prepare("SELECT signature_hash FROM ast_symbols WHERE path = 'src/api.ts' AND qualified_name = 'api'").get().signature_hash;
      const id = store.record({ kind: 'constraint', title: 'Api argument count', summary: 'Api takes one argument.',
        body: 'api takes exactly one argument.', evidenceSymbols: [{ path: 'src/api.ts', qualifiedName: 'api', signatureHash }] });
      store.update(id, { evidence: [] });
      db.prepare('UPDATE facts SET last_verified_at = ? WHERE id = ?').run(DAY_AGO, id);
      return id;
    });
    const factId = seed(blind);
    check('both workspaces hold the same fact id', seed(sighted) === factId, factId);
    const stored = ws => inDb(ws, db => db.prepare('SELECT state, last_verified_at FROM facts WHERE id = ?').get(factId));
    const DTO_KEYS = ['body', 'confidence', 'createdAt', 'drifted', 'evidence', 'id', 'kind', 'lastVerifiedAt', 'scope', 'state', 'summary',
      'supersededBy', 'supersedes', 'symbols', 'title', 'trust', 'uncheckedSymbols', 'updatedAt', 'updatedBy'];

    const server = createExploreServer({ defaultWorkspace: WS, distDir: DIST });
    const port = await listen(server);
    const get = target => request(port, 'GET', target);
    const patch = (target, body) => request(port, 'PATCH', target, { body });
    const factIn = r => r.json && r.json.facts && r.json.facts.find(f => f.id === factId);
    const engine = process.env.CAIPIRA_AST_BIN;
    try {
      let r = await get(`/api/facts?workspace=${sighted.id}`);
      check('a checked anchor reads uncheckedSymbols 0', r.status === 200 && factIn(r)?.uncheckedSymbols === 0, factIn(r));

      fs.writeFileSync(path.join(blind.root, 'src/api.ts'), v1.replace('api(value: number)', 'api(value: number, extra: number)'));
      process.env.CAIPIRA_AST_BIN = path.join(blind.root, 'no-such-caipira-ast');
      r = await get(`/api/facts?workspace=${blind.id}`);
      let fact = factIn(r);
      check('without the parser the anchor reads unchecked, not drifted', r.status === 200 && fact && fact.uncheckedSymbols === 1
        && fact.state === 'active' && fact.drifted === false, fact);
      check('fact DTO fields stay the same plus uncheckedSymbols', fact && JSON.stringify(Object.keys(fact).sort()) === JSON.stringify(DTO_KEYS),
        fact && Object.keys(fact).sort());
      r = await get(`/api/facts?workspace=${blind.id}&q=api+argument+count&refresh=1`);
      check('a failed refresh with a query keeps it unchecked', r.status === 200 && factIn(r)?.uncheckedSymbols === 1, factIn(r));
      r = await get(`/api/facts?workspace=${blind.id}&refresh=1`);
      check('a failed refresh without a query keeps it unchecked', r.status === 200 && factIn(r)?.uncheckedSymbols === 1, factIn(r));
      r = await get(`/api/facts?workspace=${blind.id}`);
      check('the read after a failed refresh keeps it unchecked', r.status === 200 && factIn(r)?.uncheckedSymbols === 1, factIn(r));
      r = await get(`/api/facts?workspace=${sighted.id}`);
      check('the other workspace\'s fact with the same id stays checked', factIn(r)?.uncheckedSymbols === 0, factIn(r));
      r = await patch(`/api/facts/${factId}?workspace=${blind.id}`, { action: 'update', title: 'Api argument count (one)' });
      check('an edit keeps the unchecked count', r.status === 200 && r.json.fact.uncheckedSymbols === 1, r.text);

      const late = inDb(blind, db => new FactStore(db, { machine: machineId(), agent: 'test', root: blind.root })
        .record({ kind: 'gotcha', title: 'Recorded after the check', body: 'No verification has covered this fact.' }));
      r = await get(`/api/facts?workspace=${blind.id}`);
      check('a fact no verification covered reads null, not 0', r.json && r.json.facts.find(f => f.id === late)?.uncheckedSymbols === null,
        r.json && r.json.facts.find(f => f.id === late));
      check('SQLite: still active, last_verified_at not advanced', JSON.stringify(stored(blind)) === JSON.stringify({ state: 'active', last_verified_at: DAY_AGO }),
        stored(blind));

      process.env.CAIPIRA_AST_BIN = engine;
      r = await get(`/api/facts?workspace=${sighted.id}`);
      check('the failure did not mark the other workspace unchecked', factIn(r)?.uncheckedSymbols === 0 && factIn(r)?.state === 'active', factIn(r));
      r = await get(`/api/facts?workspace=${blind.id}&refresh=1`);
      fact = factIn(r);
      check('a healthy re-check clears it and finds the signature change', fact && fact.uncheckedSymbols === 0 && fact.state === 'needs_review'
        && fact.drifted === true && fact.symbols[0].current === false, fact);
      r = await patch(`/api/facts/${factId}?workspace=${blind.id}`, { action: 'reaffirm' });
      check('reaffirm re-reads the anchor: 0 unchecked, current', r.status === 200 && r.json.fact.uncheckedSymbols === 0
        && r.json.fact.symbols[0].current === true, r.text);
      r = await get(`/api/facts?workspace=${blind.id}`);
      check('and the next read agrees', factIn(r)?.uncheckedSymbols === 0 && factIn(r)?.state === 'active', factIn(r));
    } finally {
      process.env.CAIPIRA_AST_BIN = engine;
      await new Promise(resolve => server.close(resolve));
    }
  }

  console.log('\n17. the newest evidence check reaches later fact reads, the inspector and the graph');
  {
    const api1 = 'export function api(value: number): number {\n  return value;\n}\n';
    const helper1 = 'export function helper(value: number): number {\n  return value * 2;\n}\n';
    const searched = extraWorkspace('explore-searched-', { 'src/api.ts': api1, 'src/helper.ts': helper1 });
    const twin = extraWorkspace('explore-twin-', { 'src/api.ts': api1 });
    const DAY_AGO = Date.now() - 86400000;
    // Facts vouched for only by their symbol anchors, as of a day ago.
    const seed = (ws, inputs) => inDb(ws, db => {
      const store = new FactStore(db, { machine: machineId(), agent: 'test', root: ws.root });
      const hash = (file, name) => db.prepare('SELECT signature_hash FROM ast_symbols WHERE path = ? AND qualified_name = ?').get(file, name).signature_hash;
      return inputs.map(({ anchor, ...input }) => {
        const evidenceSymbols = anchor ? [{ path: anchor[0], qualifiedName: anchor[1], signatureHash: hash(...anchor) }] : [];
        const id = store.record({ ...input, evidenceSymbols });
        store.update(id, { evidence: [] });
        db.prepare('UPDATE facts SET last_verified_at = ? WHERE id = ?').run(DAY_AGO, id);
        return id;
      });
    });
    const API = ['src/api.ts', 'api'];
    const [A, B, P, N] = seed(searched, [
      { kind: 'constraint', title: 'Api argument count', body: 'api takes exactly one argument.', anchor: API },
      { kind: 'constraint', title: 'Helper doubles', body: 'helper returns twice its input.', anchor: ['src/helper.ts', 'helper'] },
      { kind: 'decision', title: 'Proposed result caching', body: 'Cache what api returns.', anchor: API, state: 'proposed' },
      { kind: 'gotcha', title: 'Plain note', body: 'Has no evidence at all.' }
    ]);
    const [twinFact] = seed(twin, [{ kind: 'constraint', title: 'Api argument count', body: 'api takes exactly one argument.', anchor: API }]);
    check('the twin workspace holds the same fact id', twinFact === A, twinFact);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const stored = () => inDb(searched, db => db.prepare('SELECT id, state, last_verified_at FROM facts ORDER BY id').all());
    const storedBefore = stored();
    const indexedApi = () => inDb(searched, db => db.prepare("SELECT signature_text FROM ast_symbols WHERE path = 'src/api.ts' AND qualified_name = 'api'").get().signature_text);
    const FACT_NODE_KEYS = ['category', 'drifted', 'factId', 'id', 'label', 'state', 'symbolAnchors', 'trust', 'type', 'uncheckedSymbols'];
    const ATTACHED_KEYS = ['evidence_status', 'fact_id', 'kind', 'state', 'summary', 'title', 'unchecked_symbols'];

    const server = createExploreServer({ defaultWorkspace: WS, distDir: DIST });
    const port = await listen(server);
    const get = target => request(port, 'GET', target);
    const patch = (target, body) => request(port, 'PATCH', target, { body });
    const q = `workspace=${searched.id}`;
    const byId = r => new Map((r.json && r.json.facts || []).map(f => [f.id, f]));
    const unchecked = (r, ids) => ids.map(id => byId(r).get(id)?.uncheckedSymbols);
    const factNode = (r, id) => r.json && r.json.nodes.find(n => n.id === `fact:${id}`);
    const verification = node => node && { symbolAnchors: node.symbolAnchors, uncheckedSymbols: node.uncheckedSymbols };
    const attached = (r, id) => {
      const fact = r.json && r.json.facts.find(f => f.fact_id === id);
      return fact && { state: fact.state, evidence_status: fact.evidence_status, unchecked_symbols: fact.unchecked_symbols };
    };
    const engine = process.env.CAIPIRA_AST_BIN;
    try {
      let r = await get(`/api/facts?${q}`);
      check('a healthy check: anchored facts 0, the plain one 0, the proposed one unknown', same(unchecked(r, [A, B, N, P]), [0, 0, 0, null]),
        unchecked(r, [A, B, N, P]));
      r = await get(`/api/facts?workspace=${twin.id}`);
      check('the twin\'s fact reads 0', same(unchecked(r, [A]), [0]), unchecked(r, [A]));

      // With the parser healthy, rendering DTOs must not re-read a changed file.
      fs.writeFileSync(path.join(searched.root, 'src/api.ts'), api1.replace('api(value: number)', 'api(value: number, extra: number)'));
      fs.writeFileSync(path.join(searched.root, 'src/helper.ts'), helper1.replace('helper(value: number)', 'helper(value: number, factor: number)'));
      const apiSymbol = symbolIn(searched, 'api');
      const indexedBefore = indexedApi();
      const reads = await Promise.all([`/api/facts?${q}`, `/api/graph?${q}`, `/api/graph?${q}&view=knowledge`, `/api/symbol/${apiSymbol}?${q}`].map(get));
      check('fact, graph and inspector reads run no parser', reads.every(read => read.status === 200) && indexedApi() === indexedBefore,
        { statuses: reads.map(read => read.status), indexed: indexedApi() });

      process.env.CAIPIRA_AST_BIN = path.join(searched.root, 'no-such-caipira-ast');
      r = await get(`/api/facts?${q}&q=api+argument+count`);
      const searchedFact = byId(r).get(A);
      check('a search that cannot re-read the anchor reads 1, still active', same(unchecked(r, [A]), [1]) && searchedFact.state === 'active'
        && searchedFact.drifted === false, searchedFact);
      r = await get(`/api/facts?${q}`);
      check('G1: the next unfiltered read keeps the search\'s outcome; uncovered facts keep theirs', same(unchecked(r, [A, B, N, P]), [1, 0, 0, null]),
        unchecked(r, [A, B, N, P]));
      r = await get(`/api/facts?${q}&q=helper+doubles`);
      check('a search for another fact covers only that fact', same(unchecked(r, [B]), [1]) && !byId(r).has(A), [...byId(r).keys()]);
      r = await get(`/api/facts?${q}`);
      check('and does not erase the first search\'s outcome', same(unchecked(r, [A, B]), [1, 1]), unchecked(r, [A, B]));
      r = await patch(`/api/facts/${A}?${q}`, { action: 'update', title: 'Api argument count (one)' });
      check('an ordinary update DTO keeps it', r.status === 200 && r.json.fact.uncheckedSymbols === 1, r.text);
      r = await get(`/api/facts?workspace=${twin.id}`);
      check('the twin\'s fact with the same id stays 0', same(unchecked(r, [A]), [0]), unchecked(r, [A]));

      const [D] = seed(searched, [{ kind: 'gotcha', title: 'Late anchor recorded', body: 'No check has read this anchor yet.', anchor: API }]);
      r = await get(`/api/facts?${q}`);
      check('a fact recorded after the check reads null', same(unchecked(r, [D]), [null]), unchecked(r, [D]));
      r = await get(`/api/symbol/${apiSymbol}?${q}`);
      check('G2: inspector facts carry the outcome beside the cached match', r.status === 200
        && same(attached(r, A), { state: 'active', evidence_status: 'current', unchecked_symbols: 1 })
        && same(attached(r, D), { state: 'active', evidence_status: 'current', unchecked_symbols: null }), r.json && r.json.facts);
      check('attached facts keep their fields plus unchecked_symbols', r.json && r.json.facts.every(f => same(Object.keys(f).sort(), ATTACHED_KEYS)),
        r.json && r.json.facts.map(f => Object.keys(f).sort()));
      r = await get(`/api/graph?${q}&view=knowledge`);
      check('G3: graph fact nodes carry anchors and the outcome', same([A, D, N].map(id => verification(factNode(r, id))), [
        { symbolAnchors: 1, uncheckedSymbols: 1 }, { symbolAnchors: 1, uncheckedSymbols: null }, { symbolAnchors: 0, uncheckedSymbols: 0 }
      ]), [A, D, N].map(id => factNode(r, id)));
      check('fact nodes keep their fields, stored trust and state', same(Object.keys(factNode(r, A) || {}).sort(), FACT_NODE_KEYS)
        && factNode(r, A).trust > 0 && factNode(r, A).state === 'active' && factNode(r, A).drifted === false, factNode(r, A));

      r = await get(`/api/facts?${q}&q=late+anchor`);
      check('a search covering the unknown fact reads 1', same(unchecked(r, [D]), [1]), unchecked(r, [D]));
      r = await get(`/api/facts?${q}`);
      check('and later reads keep it', same(unchecked(r, [D]), [1]), unchecked(r, [D]));
      r = await patch(`/api/facts/${D}?${q}`, { action: 'update', title: 'Late anchor recorded (once)' });
      check('as does its update DTO', r.status === 200 && r.json.fact.uncheckedSymbols === 1, r.text);
      r = await get(`/api/facts?${q}&q=proposed+caching`);
      check('a search covering the proposed fact reads 1', same(unchecked(r, [P]), [1]), unchecked(r, [P]));
      r = await get(`/api/facts?${q}&refresh=1`);
      check('a failed batch re-check keeps facts it skips (proposed) as their newest check left them', same(unchecked(r, [A, B, D, N, P]), [1, 1, 1, 0, 1]),
        unchecked(r, [A, B, D, N, P]));

      for (const view of ['unified', 'knowledge']) {
        r = await get(`/api/graph?${q}&view=${view}`);
        check(`${view}: the unchecked fact keeps its evidence edge and metadata`, r.status === 200
          && r.json.edges.some(e => e.kind === 'evidences' && e.source === `fact:${A}` && e.target === `symbol:${apiSymbol}`)
          && same(verification(factNode(r, A)), { symbolAnchors: 1, uncheckedSymbols: 1 }), factNode(r, A));
      }
      r = await get(`/api/graph?${q}&view=impact&symbolId=${apiSymbol}&depth=1`);
      check('impact: the anchored facts in the symbol\'s neighborhood say so', r.status === 200
        && same([A, D].map(id => verification(factNode(r, id))), [{ symbolAnchors: 1, uncheckedSymbols: 1 }, { symbolAnchors: 1, uncheckedSymbols: 1 }]),
        r.json && r.json.nodes.map(n => n.id));
      // Facts rank first under a cap, so a cap of exactly the facts drops every symbol.
      r = await get(`/api/graph?${q}&view=knowledge&limit=${[A, B, D, N, P].length}`);
      check('a cap that drops the evidence edge leaves the anchor count and outcome', r.status === 200 && r.json.stats.truncated
        && !r.json.edges.some(e => e.kind === 'evidences') && same(verification(factNode(r, A)), { symbolAnchors: 1, uncheckedSymbols: 1 }),
        r.json && { edges: r.json.edges, node: factNode(r, A) });
      check('SQLite: parser failures changed no state and advanced no verification', same(stored().filter(row => row.id !== D), storedBefore),
        stored());

      process.env.CAIPIRA_AST_BIN = engine;
      r = await get(`/api/facts?${q}&refresh=1`);
      const rechecked = [A, B, D].map(id => byId(r).get(id));
      check('a healthy re-check reads 0 and finds the real changes', rechecked.every(f => f && f.uncheckedSymbols === 0 && f.state === 'needs_review'
        && f.drifted === true && f.symbols[0].current === false), rechecked);
      check('the proposed fact keeps the outcome of its newest check', same(unchecked(r, [P]), [1]), unchecked(r, [P]));
      r = await get(`/api/facts?${q}&q=proposed+caching`);
      check('until a successful search replaces it', same(unchecked(r, [P]), [0]), unchecked(r, [P]));
      r = await patch(`/api/facts/${A}?${q}`, { action: 'reaffirm' });
      check('reaffirm: 0 unchecked, current', r.status === 200 && r.json.fact.uncheckedSymbols === 0 && r.json.fact.symbols[0].current === true, r.text);
      r = await get(`/api/facts?${q}`);
      check('later reads agree', same(unchecked(r, [A, P]), [0, 0]) && byId(r).get(A)?.state === 'active', byId(r).get(A));
      const apiNow = symbolIn(searched, 'api');
      r = await get(`/api/symbol/${apiNow}?${q}`);
      check('inspector after recovery: checked and current, checked and drifted', r.status === 200
        && same(attached(r, A), { state: 'active', evidence_status: 'current', unchecked_symbols: 0 })
        && same(attached(r, D), { state: 'needs_review', evidence_status: 'drifted', unchecked_symbols: 0 }), r.json && r.json.facts);
      r = await get(`/api/graph?${q}&view=knowledge`);
      check('graph after recovery: checked, drift only where proven', same([A, D].map(id => ({ ...verification(factNode(r, id)), drifted: factNode(r, id)?.drifted })),
        [{ symbolAnchors: 1, uncheckedSymbols: 0, drifted: false }, { symbolAnchors: 1, uncheckedSymbols: 0, drifted: true }]), [A, D].map(id => factNode(r, id)));
      r = await get(`/api/facts?workspace=${twin.id}`);
      check('the twin never saw the other workspace\'s outcomes', same(unchecked(r, [A]), [0]), unchecked(r, [A]));
    } finally {
      process.env.CAIPIRA_AST_BIN = engine;
      await new Promise(resolve => server.close(resolve));
    }
  }

  console.log('\n18. search candidates the limit or a category drops keep the outcome of their check');
  {
    const preferred1 = 'export function preferred(value: number): number {\n  return value;\n}\n';
    const secondary1 = 'export function secondary(value: number): number {\n  return value;\n}\n';
    const files = { 'src/preferred.ts': preferred1, 'src/secondary.ts': secondary1 };
    const searched = extraWorkspace('explore-truncated-', files);
    const twin = extraWorkspace('explore-truncated-twin-', files);
    const DAY_AGO = Date.now() - 86400000;
    // Symbol-only facts as of a day ago; confidence alone orders their trust.
    const seed = ws => inDb(ws, db => {
      const store = new FactStore(db, { machine: machineId(), agent: 'test', root: ws.root });
      const hash = (file, name) => db.prepare('SELECT signature_hash FROM ast_symbols WHERE path = ? AND qualified_name = ?').get(file, name).signature_hash;
      const SECONDARY = ['src/secondary.ts', 'secondary'];
      return [
        { kind: 'constraint', title: 'Preferred shared argument count', body: 'preferred takes one argument.', confidence: 1, anchor: ['src/preferred.ts', 'preferred'] },
        { kind: 'constraint', title: 'Secondary shared argument count', body: 'secondary takes one argument.', confidence: 0.3, anchor: SECONDARY },
        { kind: 'gotcha', title: 'Filtered shared argument count', body: 'secondary is easy to misuse.', confidence: 0.6, anchor: SECONDARY },
        { kind: 'decision', title: 'Unrelated helper note', body: 'Nothing else matches this.', confidence: 1, anchor: SECONDARY }
      ].map(({ anchor, ...input }) => {
        const id = store.record({ ...input, evidenceSymbols: [{ path: anchor[0], qualifiedName: anchor[1], signatureHash: hash(...anchor) }] });
        store.update(id, { evidence: [] });
        db.prepare('UPDATE facts SET last_verified_at = ? WHERE id = ?').run(DAY_AGO, id);
        return id;
      });
    });
    const [PREFERRED, SECONDARY, FILTERED, UNMATCHED] = seed(searched);
    const ALL = [PREFERRED, SECONDARY, FILTERED, UNMATCHED];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check('the twin workspace holds the same fact ids', same(seed(twin), ALL), ALL);
    const stored = () => inDb(searched, db => db.prepare('SELECT id, state, last_verified_at FROM facts ORDER BY id').all());
    const storedBefore = stored();

    const server = createExploreServer({ defaultWorkspace: WS, distDir: DIST });
    const port = await listen(server);
    const get = target => request(port, 'GET', target);
    const patch = (target, body) => request(port, 'PATCH', target, { body });
    const q = `workspace=${searched.id}`;
    const byId = r => new Map((r.json && r.json.facts || []).map(f => [f.id, f]));
    const unchecked = (r, ids) => ids.map(id => byId(r).get(id)?.uncheckedSymbols);
    const returned = r => (r.json && r.json.facts || []).map(f => f.id);
    const attached = (r, id) => {
      const fact = r.json && r.json.facts.find(f => f.fact_id === id);
      return fact && { state: fact.state, evidence_status: fact.evidence_status, unchecked_symbols: fact.unchecked_symbols };
    };
    const factNode = (r, id) => {
      const node = r.json && r.json.nodes.find(n => n.id === `fact:${id}`);
      return node && { drifted: node.drifted, symbolAnchors: node.symbolAnchors, uncheckedSymbols: node.uncheckedSymbols };
    };
    const engine = process.env.CAIPIRA_AST_BIN;
    try {
      let r = await get(`/api/facts?${q}`);
      check('a healthy check reads every fact 0', same(unchecked(r, ALL), [0, 0, 0, 0]), unchecked(r, ALL));
      r = await get(`/api/facts?workspace=${twin.id}`);
      check('so does the twin', same(unchecked(r, ALL), [0, 0, 0, 0]), unchecked(r, ALL));

      // Only the lower-ranked anchors' file changes, by a different size.
      fs.writeFileSync(path.join(searched.root, 'src/secondary.ts'), secondary1.replace('secondary(value: number)', 'secondary(value: number, extra: number)'));
      const secondarySymbol = symbolIn(searched, 'secondary');
      process.env.CAIPIRA_AST_BIN = path.join(searched.root, 'no-such-caipira-ast');
      r = await get(`/api/facts?${q}&q=unrelated+helper+note`);
      check('a search for an unrelated fact reads it 1', same(returned(r), [UNMATCHED]) && same(unchecked(r, [UNMATCHED]), [1]), unchecked(r, [UNMATCHED]));
      r = await get(`/api/facts?${q}&q=shared+argument+count&limit=1`);
      check('H1: limit=1 still returns only the higher-ranked hit, checked', same(returned(r), [PREFERRED]) && same(unchecked(r, [PREFERRED]), [0]),
        r.json && r.json.facts.map(f => [f.id, f.trust, f.uncheckedSymbols]));
      r = await get(`/api/facts?${q}`);
      check('H1: the next read gives the candidates the limit dropped their positive count; the unmatched fact keeps its own',
        same(unchecked(r, ALL), [0, 1, 1, 1]), unchecked(r, ALL));
      r = await patch(`/api/facts/${SECONDARY}?${q}`, { action: 'update', title: 'Secondary shared argument count (two)' });
      check('an ordinary update DTO keeps it', r.status === 200 && r.json.fact.uncheckedSymbols === 1, r.text);
      r = await get(`/api/symbol/${secondarySymbol}?${q}`);
      check('the inspector qualifies every fact on the omitted anchor', r.status === 200
        && [SECONDARY, FILTERED, UNMATCHED].every(id => same(attached(r, id), { state: 'active', evidence_status: 'current', unchecked_symbols: 1 })),
        r.json && r.json.facts);
      r = await get(`/api/graph?${q}&view=knowledge`);
      check('the graph marks the omitted candidate', same(factNode(r, SECONDARY), { drifted: false, symbolAnchors: 1, uncheckedSymbols: 1 }), factNode(r, SECONDARY));
      r = await get(`/api/graph?${q}&view=knowledge&limit=${ALL.length}`);
      check('as it does under a cap that drops its evidence edge', r.status === 200 && r.json.stats.truncated && !r.json.edges.some(e => e.kind === 'evidences')
        && same(factNode(r, SECONDARY), { drifted: false, symbolAnchors: 1, uncheckedSymbols: 1 }), r.json && { edges: r.json.edges, node: factNode(r, SECONDARY) });
      r = await get(`/api/facts?workspace=${twin.id}`);
      check('the twin\'s facts with the same ids stay 0', same(unchecked(r, ALL), [0, 0, 0, 0]), unchecked(r, ALL));
      check('SQLite: the parser failure changed no state and advanced no verification', same(stored(), storedBefore), stored());

      process.env.CAIPIRA_AST_BIN = engine;
      r = await get(`/api/facts?${q}&q=shared+argument+count&category=gotcha&limit=1`);
      check('a healthy search whose limit and category drop every candidate returns nothing', r.status === 200 && same(returned(r), []), returned(r));
      r = await get(`/api/facts?${q}`);
      check('its successful checks still replace the failed ones; the unmatched fact keeps its own', same(unchecked(r, ALL), [0, 0, 0, 1]),
        unchecked(r, ALL));
      r = await get(`/api/facts?${q}&refresh=1`);
      const rechecked = [SECONDARY, FILTERED].map(id => byId(r).get(id));
      check('an explicit re-check finds the real signature change', rechecked.every(f => f && f.uncheckedSymbols === 0 && f.state === 'needs_review'
        && f.drifted === true && f.symbols[0].current === false) && byId(r).get(PREFERRED)?.state === 'active', rechecked);
      r = await patch(`/api/facts/${SECONDARY}?${q}`, { action: 'reaffirm' });
      check('reaffirm: 0 unchecked, current', r.status === 200 && r.json.fact.uncheckedSymbols === 0 && r.json.fact.symbols[0].current === true, r.text);
      r = await get(`/api/facts?${q}`);
      check('later fact reads agree', same(unchecked(r, ALL), [0, 0, 0, 0]) && byId(r).get(SECONDARY)?.state === 'active', unchecked(r, ALL));
      const secondaryNow = symbolIn(searched, 'secondary');
      r = await get(`/api/symbol/${secondaryNow}?${q}`);
      check('so do the inspector and the graph', same(attached(r, SECONDARY), { state: 'active', evidence_status: 'current', unchecked_symbols: 0 })
        && same(factNode(await get(`/api/graph?${q}&view=knowledge`), SECONDARY), { drifted: false, symbolAnchors: 1, uncheckedSymbols: 0 }),
        attached(r, SECONDARY));
      r = await get(`/api/facts?workspace=${twin.id}`);
      check('and the twin still reads its own 0', same(unchecked(r, ALL), [0, 0, 0, 0]), unchecked(r, ALL));
    } finally {
      process.env.CAIPIRA_AST_BIN = engine;
      await new Promise(resolve => server.close(resolve));
    }
  }
}

main()
  .catch(error => { fail++; console.log('  FAIL suite crashed -> ' + (error && error.stack || error)); })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  });
