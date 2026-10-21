// Drives the caipira-ast binary through ast.js against a fixture workspace
// covering all eight language families, then checks the incremental gates,
// single-file diffs, the symbol queries, error mapping, and schema v3.
//
// Builds the crate first (debug profile) and points CAIPIRA_AST_BIN at it, so
// the suite always tests the source in this checkout rather than whatever
// binary happens to be installed.
require('./fixtures').ensureIsolatedHome();
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const Database = require('better-sqlite3');

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

// ── the binary under test ──

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

const ast = require(ROOT + '/ast.js');
const { migrate, migrateAll, currentVersion, MASTER_MIGRATIONS, WORKSPACE_MIGRATIONS } = require(ROOT + '/migrate.js');
const { openWorkspaceDb } = require(ROOT + '/workspace.js');

// ── fixture workspace ──

const FILES = {
  'src/util.js': [
    '// Formats a display name.',
    "function formatName(first, last = '') {",
    '  return `${first} ${last}`.trim();',
    '}',
    '',
    'module.exports = { formatName };',
    ''
  ],
  'src/store.js': [
    "const { formatName } = require('./util');",
    '',
    '/** Keeps users in memory. */',
    'class UserStore {',
    '  constructor() { this.users = []; }',
    '',
    '  add(user) {',
    '    this.users.push(formatName(user.first, user.last));',
    '    return this.count();',
    '  }',
    '',
    '  count() { return this.users.length; }',
    '}',
    '',
    'module.exports = { UserStore };',
    ''
  ],
  'src/types.ts': [
    "import { UserStore } from './store';",
    '',
    'export interface User {',
    '  first: string;',
    '  last?: string;',
    '}',
    '',
    '/**',
    ' * Loads a user by id.',
    ' */',
    'export async function loadUser(id: number, store: UserStore, retries = 2): Promise<User | null> {',
    '  return null;',
    '}',
    '',
    'export class AdminStore extends UserStore implements Auditable {',
    '  audit(user: User): void {}',
    '}',
    ''
  ],
  'src/App.jsx': [
    "import { Card } from './Card';",
    '',
    'export default function App({ users }) {',
    '  return <ul>{users.map(u => <Card key={u.id} user={u} />)}</ul>;',
    '}',
    ''
  ],
  'src/Card.tsx': [
    "import type { User } from './types';",
    "import { formatName } from './util';",
    '',
    'type Props = { user: User };',
    '',
    'export function Card({ user }: Props): JSX.Element {',
    '  return <li>{formatName(user.first, user.last)}</li>;',
    '}',
    ''
  ],
  'src/Panel.vue': [
    '<template>',
    '  <section>',
    '    <button @click="save">{{ title }}</button>',
    '  </section>',
    '</template>',
    '',
    '<script setup lang="ts">',
    "import { loadUser } from './types';",
    '',
    "const title = 'Users';",
    '',
    '/** Saves the panel. */',
    'async function save(id: number): Promise<void> {',
    '  await loadUser(id, store);',
    '}',
    '</script>',
    '',
    '<style scoped>',
    'section { padding: 0; }',
    '</style>',
    ''
  ],
  'py/models.py': [
    'class User:',
    '    """A stored user."""',
    '',
    '    def __init__(self, name: str) -> None:',
    '        self.name = name',
    ''
  ],
  'py/service.py': [
    'from .models import User',
    '',
    '# Fetches users.',
    'def fetch_user(user_id: int, *, cache: bool = True) -> User:',
    '    """Return the user with this id.',
    '',
    '    Raises KeyError when missing."""',
    '    return User(str(user_id))',
    ''
  ],
  'rs/Cargo.toml': ['[package]', 'name = "fixture"', 'version = "0.1.0"', ''],
  'rs/src/lib.rs': [
    'pub mod store;',
    '',
    'use crate::store::Store;',
    '',
    '/// Opens a store at a path.',
    'pub fn open(path: &str, limit: usize) -> Result<Store, String> {',
    '    Ok(Store::new(path, limit))',
    '}',
    ''
  ],
  'rs/src/store.rs': [
    '/// An append-only store.',
    'pub struct Store {',
    '    path: String,',
    '}',
    '',
    'impl Store {',
    '    /// Creates a store.',
    '    pub fn new(path: &str, _limit: usize) -> Self {',
    '        Store { path: path.to_string() }',
    '    }',
    '}',
    ''
  ],
  'go/main.go': [
    'package main',
    '',
    'import "fmt"',
    '',
    '// Greeter says hello.',
    'type Greeter struct {',
    '\tName string',
    '}',
    '',
    '// Greet returns a greeting.',
    'func (g *Greeter) Greet(prefix string, times ...int) (string, error) {',
    '\treturn fmt.Sprintf("%s %s", prefix, g.Name), nil',
    '}',
    '',
    'func main() {',
    '\tg := &Greeter{Name: "x"}',
    '\tfmt.Println(g.Greet("hi"))',
    '}',
    ''
  ],
  'cpp/store.hpp': [
    '#pragma once',
    '#include <string>',
    '',
    'namespace app {',
    '/// Holds rows.',
    'class RowStore {',
    'public:',
    '  explicit RowStore(const std::string& name, int capacity = 8);',
    '  int size() const;',
    'private:',
    '  int count_ = 0;',
    '};',
    '}',
    ''
  ],
  'cpp/store.cpp': [
    '#include "store.hpp"',
    '',
    'namespace app {',
    '// Counts rows.',
    'int RowStore::size() const {',
    '  return count_;',
    '}',
    '}',
    ''
  ],
  'README.md': ['# not source', ''],
  '.gitignore': ['ignored/', ''],
  'ignored/skip.js': ['function skipped() {}', '']
};
const SOURCE_COUNT = 13;

const ws = tempDir('caipira-ast-ws-');
const text = rel => FILES[rel].join('\n');
const writeFile = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), content);
};
for (const rel of Object.keys(FILES)) writeFile(rel, text(rel));
const lineOf = (rel, needle) => FILES[rel].findIndex(line => line.includes(needle)) + 1;

const dbFile = path.join(tempDir('caipira-ast-db-'), 'fixture.db');
const parsed = rel => ast.parseFileAst(ws, rel);
const sym = (snapshot, qn) => snapshot.symbols.find(s => s.qualified_name === qn);
const param = (name, type_annotation = null, default_value = null) => ({ name, type_annotation, default_value });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const HASH = /^[0-9a-f]{16}$/;

// Compares the fields acceptance criterion 1 lists; signature_hash only by shape.
function checkSymbol(label, actual, expected) {
  if (!actual) { check(label, false, 'symbol missing'); return; }
  const fields = ['name', 'qualified_name', 'kind', 'is_public', 'start_line', 'end_line', 'params', 'return_type', 'doc_summary', 'signature_text'];
  const wrong = fields.filter(f => f in expected && !same(actual[f], expected[f]));
  check(label, wrong.length === 0 && HASH.test(actual.signature_hash),
    wrong.map(f => `${f}: ${JSON.stringify(actual[f])} != ${JSON.stringify(expected[f])}`).join('; ') || actual.signature_hash);
}

console.log('\n1. every language family parses with params, returns, docs and lines');
{
  const util = parsed('src/util.js');
  checkSymbol('JavaScript function (CommonJS export)', sym(util, 'formatName'), {
    name: 'formatName', qualified_name: 'formatName', kind: 'function', is_public: true,
    start_line: 2, end_line: 4, params: [param('first'), param('last', null, "''")],
    return_type: null, doc_summary: 'Formats a display name.', signature_text: "function formatName(first, last = '')"
  });
  const store = parsed('src/store.js');
  checkSymbol('JavaScript class', sym(store, 'UserStore'), {
    kind: 'class', is_public: true, start_line: 4, end_line: 13, doc_summary: 'Keeps users in memory.', signature_text: 'class UserStore'
  });
  checkSymbol('JavaScript method', sym(store, 'UserStore.add'), {
    name: 'add', kind: 'method', is_public: true, start_line: 7, end_line: 10, params: [param('user')]
  });

  const types = parsed('src/types.ts');
  checkSymbol('TypeScript function', sym(types, 'loadUser'), {
    kind: 'function', is_public: true, start_line: lineOf('src/types.ts', 'function loadUser'), end_line: 13,
    params: [param('id', 'number'), param('store', 'UserStore'), param('retries', null, '2')],
    return_type: 'Promise<User | null>', doc_summary: 'Loads a user by id.',
    signature_text: 'export async function loadUser(id: number, store: UserStore, retries = 2): Promise<User | null>'
  });
  checkSymbol('TypeScript interface', sym(types, 'User'), { kind: 'interface', is_public: true, start_line: 3, end_line: 6 });
  checkSymbol('TypeScript class member', sym(types, 'AdminStore.audit'), {
    kind: 'method', params: [param('user', 'User')], return_type: 'void'
  });

  checkSymbol('React JSX component', sym(parsed('src/App.jsx'), 'App'), {
    kind: 'function', is_public: true, start_line: 3, end_line: 5, params: [param('{ users }')]
  });
  const card = parsed('src/Card.tsx');
  checkSymbol('React TSX component', sym(card, 'Card'), {
    kind: 'function', is_public: true, start_line: 6, end_line: 8,
    params: [param('{ user }', 'Props')], return_type: 'JSX.Element'
  });
  check('TSX language detected', card.language === 'tsx', card.language);

  const panel = parsed('src/Panel.vue');
  checkSymbol('Vue <script setup lang="ts"> function', sym(panel, 'save'), {
    kind: 'function', params: [param('id', 'number')], return_type: 'Promise<void>', doc_summary: 'Saves the panel.'
  });
  check('Vue language recorded as vue', panel.language === 'vue', panel.language);

  const service = parsed('py/service.py');
  checkSymbol('Python function', sym(service, 'fetch_user'), {
    kind: 'function', is_public: true, start_line: 4, end_line: 8,
    params: [param('user_id', 'int'), param('cache', 'bool', 'True')],
    return_type: 'User', doc_summary: 'Return the user with this id.',
    signature_text: 'def fetch_user(user_id: int, *, cache: bool = True) -> User'
  });
  checkSymbol('Python method', sym(parsed('py/models.py'), 'User.__init__'), {
    kind: 'method', is_public: true, params: [param('self'), param('name', 'str')], return_type: 'None'
  });

  checkSymbol('Rust function', sym(parsed('rs/src/lib.rs'), 'open'), {
    kind: 'function', is_public: true, start_line: 6, end_line: 8,
    params: [param('path', '&str'), param('limit', 'usize')], return_type: 'Result<Store, String>',
    doc_summary: 'Opens a store at a path.', signature_text: 'pub fn open(path: &str, limit: usize) -> Result<Store, String>'
  });
  checkSymbol('Rust impl method', sym(parsed('rs/src/store.rs'), 'Store::new'), {
    name: 'new', kind: 'method', is_public: true, start_line: 8, end_line: 10,
    params: [param('path', '&str'), param('_limit', 'usize')], return_type: 'Self', doc_summary: 'Creates a store.'
  });

  const go = parsed('go/main.go');
  checkSymbol('Go method', sym(go, 'Greeter.Greet'), {
    name: 'Greet', kind: 'method', is_public: true, start_line: 11, end_line: 13,
    params: [param('prefix', 'string'), param('times', '...int')], return_type: '(string, error)',
    doc_summary: 'Greet returns a greeting.', signature_text: 'func (g *Greeter) Greet(prefix string, times ...int) (string, error)'
  });
  checkSymbol('Go struct and unexported func', sym(go, 'Greeter'), { kind: 'struct', is_public: true, doc_summary: 'Greeter says hello.' });
  check('Go main is not exported', sym(go, 'main') && sym(go, 'main').is_public === false);

  const hpp = parsed('cpp/store.hpp');
  checkSymbol('C++ class', sym(hpp, 'app::RowStore'), {
    kind: 'class', is_public: true, start_line: 6, end_line: 12, doc_summary: 'Holds rows.', signature_text: 'class RowStore'
  });
  checkSymbol('C++ constructor prototype', sym(hpp, 'app::RowStore::RowStore'), {
    kind: 'method', is_public: true, params: [param('name', 'const std::string&'), param('capacity', 'int', '8')], return_type: null
  });
  checkSymbol('C++ out-of-line method', sym(parsed('cpp/store.cpp'), 'app::RowStore::size'), {
    kind: 'method', start_line: 5, end_line: 7, return_type: 'int', doc_summary: 'Counts rows.'
  });
}

console.log('\n2. Vue symbols report .vue file line numbers');
{
  const panel = parsed('src/Panel.vue');
  const save = sym(panel, 'save');
  const start = lineOf('src/Panel.vue', 'async function save');
  check('save starts on its .vue line (' + start + ')', save && save.start_line === start, save);
  check('save ends on its .vue line', save && save.end_line === start + 2, save);
  const title = sym(panel, 'title');
  check('script-setup const on its .vue line', title && title.start_line === lineOf('src/Panel.vue', "const title"), title);
}

console.log('\n3. first sync indexes every source file and links edges across files');
let first;
{
  first = ast.syncWorkspaceAst(ws, dbFile);
  check('parsed every supported file (' + SOURCE_COUNT + ')', first.parsed === SOURCE_COUNT && first.skipped === 0, first);
  check('no failures', first.failed === 0, first);
  const db = new Database(dbFile, { readonly: true });
  const files = db.prepare('SELECT path FROM ast_files ORDER BY path').all().map(r => r.path);
  check('ignored/ and README.md are not indexed', !files.includes('ignored/skip.js') && !files.includes('README.md'), files);
  const edge = (kind, source, target) => db.prepare(`SELECT target_path, target_symbol FROM ast_edges
    WHERE edge_kind = ? AND source_path = ? AND source_symbol IS ? AND target_symbol = ?`).get(kind, source[0], source[1], target);
  const has = (kind, source, target, targetPath) => {
    const row = edge(kind, source, target);
    return Boolean(row) && row.target_path === targetPath;
  };
  check('calls: UserStore.add -> util.js formatName', has('calls', ['src/store.js', 'UserStore.add'], 'formatName', 'src/util.js'));
  check('calls: UserStore.add -> this.count()', has('calls', ['src/store.js', 'UserStore.add'], 'UserStore.count', 'src/store.js'));
  check('calls: Card -> util.js formatName', has('calls', ['src/Card.tsx', 'Card'], 'formatName', 'src/util.js'));
  check('calls: Vue save -> types.ts loadUser', has('calls', ['src/Panel.vue', 'save'], 'loadUser', 'src/types.ts'));
  check('calls: python fetch_user -> models.py User', has('calls', ['py/service.py', 'fetch_user'], 'User', 'py/models.py'));
  check('calls: rust open -> store.rs Store::new', has('calls', ['rs/src/lib.rs', 'open'], 'Store::new', 'rs/src/store.rs'));
  // A call through a local variable has no type information, so it stays
  // unresolved as written; inspectSymbol still finds it by name.
  check('calls: go main -> g.Greet kept unresolved', has('calls', ['go/main.go', 'main'], 'g.Greet', null));
  check('calls: go method -> fmt.Sprintf', has('calls', ['go/main.go', 'Greeter.Greet'], 'fmt.Sprintf', null));
  check('imports: store.js -> ./util resolved', has('imports', ['src/store.js', null], './util', 'src/util.js'));
  check('imports: App.jsx -> ./Card resolved to .tsx', has('imports', ['src/App.jsx', null], './Card', 'src/Card.tsx'));
  check('imports: rust mod store resolved', has('imports', ['rs/src/lib.rs', null], 'store', 'rs/src/store.rs'));
  check('imports: python .models resolved', has('imports', ['py/service.py', null], '.models', 'py/models.py'));
  check('imports: C++ quoted include resolved', has('imports', ['cpp/store.cpp', null], 'store.hpp', 'cpp/store.hpp'));
  check('imports: unresolved specifier kept', has('imports', ['go/main.go', null], 'fmt', null));
  check('uses_type: loadUser -> User (same file)', has('uses_type', ['src/types.ts', 'loadUser'], 'User', 'src/types.ts'));
  check('uses_type: loadUser -> UserStore (imported)', has('uses_type', ['src/types.ts', 'loadUser'], 'UserStore', 'src/store.js'));
  check('uses_type: fetch_user -> User (python)', has('uses_type', ['py/service.py', 'fetch_user'], 'User', 'py/models.py'));
  check('extends: AdminStore -> UserStore', has('extends', ['src/types.ts', 'AdminStore'], 'UserStore', 'src/store.js'));
  check('implements: AdminStore -> Auditable', has('implements', ['src/types.ts', 'AdminStore'], 'Auditable', null));
  db.close();
}

console.log('\n4. three-tier incremental sync');
{
  const second = ast.syncWorkspaceAst(ws, dbFile);
  check('unchanged workspace: parsed 0, skipped all', second.parsed === 0 && second.skipped === SOURCE_COUNT && second.hash_matched === 0, second);

  const future = new Date(Date.now() + 120000);
  fs.utimesSync(path.join(ws, 'src/util.js'), future, future);
  const touched = ast.syncWorkspaceAst(ws, dbFile);
  check('mtime-only change: hash_matched 1, parsed 0', touched.hash_matched === 1 && touched.parsed === 0 && touched.skipped === SOURCE_COUNT - 1, touched);
  const db = new Database(dbFile, { readonly: true });
  const storedMtime = db.prepare("SELECT mtime_ms FROM ast_files WHERE path = 'src/util.js'").get().mtime_ms;
  db.close();
  check('tier 2 recorded the new mtime', storedMtime === Math.floor(fs.statSync(path.join(ws, 'src/util.js')).mtimeMs), storedMtime);
  const again = ast.syncWorkspaceAst(ws, dbFile);
  check('after tier 2 the file is skipped again', again.skipped === SOURCE_COUNT && again.hash_matched === 0, again);

  writeFile('src/store.js', text('src/store.js') + 'function extra() { return 1; }\n');
  fs.rmSync(path.join(ws, 'go/main.go'));
  const edited = ast.syncWorkspaceAst(ws, dbFile);
  check('edit + delete: parsed 1, removed 1', edited.parsed === 1 && edited.removed === 1 && edited.skipped === SOURCE_COUNT - 2, edited);
  const after = new Database(dbFile);
  const count = (sql, ...args) => after.prepare(sql).get(...args).n;
  check('deleted file gone from ast_files', count("SELECT COUNT(*) n FROM ast_files WHERE path = 'go/main.go'") === 0);
  check('deleted file gone from ast_symbols', count("SELECT COUNT(*) n FROM ast_symbols WHERE path = 'go/main.go'") === 0);
  check('deleted file gone from ast_edges', count("SELECT COUNT(*) n FROM ast_edges WHERE source_path = 'go/main.go'") === 0);
  check('deleted file gone from ast_symbols_fts', count("SELECT COUNT(*) n FROM ast_symbols_fts WHERE ast_symbols_fts MATCH '\"Greet\"'") === 0);
  check('edited file has its new symbol', count("SELECT COUNT(*) n FROM ast_symbols WHERE path = 'src/store.js' AND name = 'extra'") === 1);
  let integrity = true;
  try { after.exec("INSERT INTO ast_symbols_fts(ast_symbols_fts) VALUES ('integrity-check')"); } catch (error) { integrity = error.message; }
  check('FTS index matches ast_symbols', integrity === true, integrity);
  after.close();
}

console.log('\n5. symbol queries and inspection');
{
  const hits = ast.queryWorkspaceSymbols(dbFile, { query: 'UserStore' });
  check('substring search ranks the exact name first', hits.length >= 1 && hits[0].qualified_name === 'UserStore', hits.map(h => h.qualified_name));
  check('search finds members by substring', ast.queryWorkspaceSymbols(dbFile, { query: 'serSto' }).some(h => h.qualified_name === 'UserStore.add'));
  check('search matches doc summaries', ast.queryWorkspaceSymbols(dbFile, { query: 'by id' }).some(h => h.name === 'loadUser'));
  check('rows carry parsed params and boolean is_public', Array.isArray(hits[0].params) && hits[0].is_public === true, hits[0]);
  const methods = ast.queryWorkspaceSymbols(dbFile, { kind: 'method', path: 'cpp' });
  check('kind + directory filter', methods.length > 0 && methods.every(m => m.kind === 'method' && m.path.startsWith('cpp/')), methods.map(m => m.path));
  check('short query falls back to LIKE', ast.queryWorkspaceSymbols(dbFile, { query: 'Ap' }).some(h => h.name === 'App'));
  check('publicOnly drops private symbols', ast.queryWorkspaceSymbols(dbFile, { path: 'src/store.js', publicOnly: true }).every(h => h.is_public));
  let rejected = null;
  try { ast.queryWorkspaceSymbols(dbFile, { limit: 10000 }); } catch (error) { rejected = error; }
  check('out-of-range limit rejected', rejected && rejected.code === 'invalid_argument', rejected && rejected.message);
  check('missing database reads as empty', same(ast.queryWorkspaceSymbols(path.join(ws, 'none.db'), {}), []));

  const format = ast.inspectSymbol(dbFile, 'src/util.js::formatName');
  check('inspect by path::name', format && format.symbol.qualified_name === 'formatName' && format.symbol.path === 'src/util.js');
  const callers = (format ? format.callers : []).map(c => `${c.path}#${c.symbol}#${c.resolved}`);
  check('callers across files are resolved', callers.includes('src/store.js#UserStore.add#true') && callers.includes('src/Card.tsx#Card#true'), callers);
  check('file imported_by lists importers', format && ['src/store.js', 'src/Card.tsx'].every(p => format.file.imported_by.some(i => i.path === p)), format && format.file);

  const add = ast.inspectSymbol(dbFile, 'src/store.js:8');
  check('inspect by path:line picks the enclosing method', add && add.symbol.qualified_name === 'UserStore.add', add && add.symbol);
  const count = add && add.callees.find(c => c.target_symbol === 'UserStore.count');
  check('callees resolve to symbol ids', count && Number.isInteger(count.symbol_id), add && add.callees);

  const load = ast.inspectSymbol(dbFile, 'loadUser');
  const types = (load ? load.uses_types : []).map(t => `${t.target_path}#${t.target_symbol}`);
  check('uses_types lists parameter and return types', types.includes('src/types.ts#User') && types.includes('src/store.js#UserStore'), types);
  const storeClass = ast.inspectSymbol(dbFile, { path: 'src/store.js', qualified_name: 'UserStore' });
  check('inherited_by finds subclasses', storeClass && storeClass.inherited_by.some(i => i.symbol === 'AdminStore'), storeClass && storeClass.inherited_by);
  check('used_by finds functions typed with it', storeClass && storeClass.used_by.some(i => i.symbol === 'loadUser'), storeClass && storeClass.used_by);
  check('rust qualified name is not mistaken for a path', ast.inspectSymbol(dbFile, 'Store::new')?.symbol.path === 'rs/src/store.rs');
  check('unknown selector returns null', ast.inspectSymbol(dbFile, 'src/util.js::nope') === null);
}

console.log('\n6. single-file updates return a structured diff');
{
  const db = openWorkspaceDb(dbFile);
  const now = Date.now();
  const factId = db.prepare(`INSERT INTO facts (kind, title, body, summary, created_at, updated_at)
    VALUES ('decision', 'formatName contract', 'formatName joins first and last.', 'formatName joins names.', ?, ?)`).run(now, now).lastInsertRowid;
  const hash = db.prepare("SELECT signature_hash FROM ast_symbols WHERE path = 'src/util.js' AND qualified_name = 'formatName'").get().signature_hash;
  db.prepare('INSERT INTO fact_symbol_evidence (fact_id, path, qualified_name, signature_hash) VALUES (?, ?, ?, ?)').run(factId, 'src/util.js', 'formatName', hash);
  db.close();
  const linked = ast.inspectSymbol(dbFile, 'src/util.js::formatName').facts;
  check('fact anchored to the symbol is current', linked.length === 1 && linked[0].evidence_status === 'current', linked);

  const unchanged = ast.updateFileSymbols(ws, dbFile, 'src/util.js');
  check('untouched file: status unchanged, empty diff', unchanged.status === 'unchanged'
    && unchanged.diff.added.length + unchanged.diff.removed.length + unchanged.diff.modified.length === 0, unchanged);

  writeFile('src/util.js', [
    '// Formats a display name.',
    "function formatName(first, last = '', separator = ' ') {",
    '  return [first, last].join(separator).trim();',
    '}',
    '',
    'function initials(name) { return name[0]; }',
    '',
    'module.exports = { formatName, initials };',
    ''
  ].join('\n'));
  const modified = ast.updateFileSymbols(ws, dbFile, path.join(ws, 'src/util.js'));
  check('edited file: status updated', modified.status === 'updated', modified.status);
  check('diff.added lists the new function', same(modified.diff.added.map(s => s.qualified_name), ['initials']), modified.diff.added);
  const change = modified.diff.modified[0];
  check('diff.modified carries before and after signatures', modified.diff.modified.length === 1
    && change.before.params.length === 2 && change.after.params.length === 3
    && change.before.signature_hash !== change.after.signature_hash, modified.diff.modified);
  check('single-file update stays under 50ms in the engine', modified.duration_ms < 50, modified.duration_ms);
  const drifted = ast.inspectSymbol(dbFile, 'src/util.js::formatName').facts;
  check('the anchored fact now reads as drifted', drifted.length === 1 && drifted[0].evidence_status === 'drifted', drifted);

  writeFile('src/util.js', text('src/util.js'));
  const reverted = ast.updateFileAst(ws, dbFile, 'src/util.js');
  check('diff.removed lists the deleted function', same(reverted.diff.removed.map(s => s.qualified_name), ['initials']), reverted.diff.removed);

  writeFile('src/extra.ts', 'export const answer = 42;\n');
  const added = ast.updateFileAst(ws, dbFile, 'src/extra.ts');
  check('new file: status added', added.status === 'added' && added.diff.added.length === 1, added);
  fs.rmSync(path.join(ws, 'src/extra.ts'));
  const removed = ast.updateFileAst(ws, dbFile, 'src/extra.ts');
  check('deleted file: status removed', removed.status === 'removed' && removed.diff.removed.length === 1, removed);
}

console.log('\n7. engine failures surface as typed errors');
{
  const failure = fn => { try { fn(); return null; } catch (error) { return error; } };
  const unsupported = failure(() => ast.updateFileAst(ws, dbFile, 'README.md'));
  check('non-source file -> unsupported', unsupported instanceof ast.AstEngineError && unsupported.code === 'unsupported' && unsupported.exitCode === 6, unsupported && unsupported.message);
  const outside = failure(() => ast.updateFileAst(ws, dbFile, '/etc/hosts'));
  check('file outside the workspace -> invalid_argument', outside && outside.code === 'invalid_argument', outside && outside.message);
  const missing = failure(() => ast.updateFileAst(ws, dbFile, 'src/never-existed.js'));
  check('missing, never-indexed file -> io', missing && missing.code === 'io' && missing.exitCode === 3, missing && missing.message);
  const badRoot = failure(() => ast.syncWorkspaceAst(path.join(ws, 'no-such-dir'), dbFile));
  check('missing workspace -> invalid_argument', badRoot && badRoot.code === 'invalid_argument', badRoot && badRoot.message);
  const saved = process.env.CAIPIRA_AST_BIN;
  process.env.CAIPIRA_AST_BIN = path.join(ws, 'no-binary');
  const noBinary = failure(() => ast.syncWorkspaceAst(ws, dbFile));
  process.env.CAIPIRA_AST_BIN = saved;
  check('missing binary -> binary_missing', noBinary && noBinary.code === 'binary_missing', noBinary && noBinary.message);
  check('empty argument rejected before spawning', failure(() => ast.updateFileAst(ws, dbFile, ''))?.code === 'invalid_argument');
}

console.log('\n8. schema v3: the Rust and JS DDL agree');
{
  const dir = tempDir('caipira-ast-schema-');
  const rustDb = path.join(dir, 'rust.db');
  const emptyWs = path.join(dir, 'ws');
  fs.mkdirSync(emptyWs);
  execFileSync(process.env.CAIPIRA_AST_BIN, ['index', '--workspace', emptyWs, '--db', rustDb], { stdio: 'ignore' });
  const jsDb = path.join(dir, 'js.db');
  openWorkspaceDb(jsDb).close();
  const schema = file => {
    const db = new Database(file, { readonly: true });
    const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'ast\\_%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY name").all();
    db.close();
    return rows.map(r => `${r.type} ${r.name}: ${r.sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')')}`);
  };
  const fromRust = schema(rustDb), fromJs = schema(jsDb);
  const diff = fromRust.filter(s => !fromJs.includes(s)).concat(fromJs.filter(s => !fromRust.includes(s)));
  check('same ast_* tables, indexes and triggers (' + fromJs.length + ')', fromJs.length >= 14 && diff.length === 0, diff);
}

console.log('\n9. migrateAll upgrades existing databases to v3 idempotently');
{
  const caipiraDir = tempDir('caipira-ast-migrate-');
  const dbDir = path.join(caipiraDir, 'database');
  fs.mkdirSync(dbDir, { recursive: true });
  const v2File = path.join(dbDir, 'project-0000.db');
  const goneFile = path.join(dbDir, 'gone-0000.db');

  const master = new Database(path.join(dbDir, 'master.db'));
  migrate(master, MASTER_MIGRATIONS);
  const register = master.prepare(`INSERT INTO workspaces (root_path, canonical_key, db_file, machine, label, created_at, last_seen_at)
    VALUES (?, ?, ?, 'test', ?, 1, 1)`);
  register.run('/p', '/p', v2File, 'project');
  register.run('/gone', '/gone', goneFile, 'gone');
  master.close();

  const v2 = new Database(v2File);
  v2.pragma('foreign_keys = ON');
  migrate(v2, WORKSPACE_MIGRATIONS.filter(m => m.version <= 2));
  v2.prepare("INSERT INTO sessions (id, ide, cwd, started_at) VALUES ('s1', 'test', '/p', 1)").run();
  v2.prepare("INSERT INTO observations (session_id, kind, content, ts) VALUES ('s1', 'note', 'kept across v3', 1)").run();
  v2.prepare("INSERT INTO facts (kind, title, body, summary, created_at, updated_at) VALUES ('decision', 't', 'b', 's', 1, 1)").run();
  check('fixture workspace db starts at v2', currentVersion(v2) === 2);
  v2.close();

  const legacy = new Database(path.join(caipiraDir, 'data.db'));
  migrate(legacy, WORKSPACE_MIGRATIONS.filter(m => m.version <= 1));
  legacy.prepare("INSERT INTO sessions (id, ide, started_at) VALUES ('old', 'test', 1)").run();
  legacy.close();

  const firstRun = migrateAll({ caipiraDir });
  const entry = file => firstRun.workspaces.find(w => w.dbFile === file);
  check('master.db visited and left at its own version', firstRun.master && firstRun.master.to === 1 && firstRun.master.applied.length === 0, firstRun.master);
  check('v2 workspace db upgraded to v3', same(entry(v2File) && entry(v2File).applied, [3]) && entry(v2File).to === 3, entry(v2File));
  check('legacy data.db upgraded from v1 to v3', same(entry(path.join(caipiraDir, 'data.db'))?.applied, [2, 3]), firstRun.workspaces);
  check('registered but missing db is skipped, not created', !fs.existsSync(goneFile) && firstRun.failed.length === 0, firstRun.failed);

  const upgraded = new Database(v2File);
  upgraded.pragma('foreign_keys = ON');
  check('schema_version is 3', currentVersion(upgraded) === 3);
  const n = sql => upgraded.prepare(sql).get().n;
  check('observations, sessions and facts preserved', n('SELECT COUNT(*) n FROM observations') === 1
    && n('SELECT COUNT(*) n FROM sessions') === 1 && n('SELECT COUNT(*) n FROM facts') === 1);
  check('observation FTS still answers', n("SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH 'kept'") === 1);
  const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  check('v3 tables exist', ['ast_files', 'ast_symbols', 'ast_edges', 'ast_symbols_fts', 'fact_symbol_evidence'].every(t => tables.includes(t)), tables);
  upgraded.prepare("INSERT INTO fact_symbol_evidence (fact_id, path, qualified_name, signature_hash) VALUES (1, 'a.js', 'f', '0123456789abcdef')").run();
  upgraded.prepare('DELETE FROM facts WHERE id = 1').run();
  check('fact_symbol_evidence cascades with its fact', n('SELECT COUNT(*) n FROM fact_symbol_evidence') === 0);
  upgraded.close();

  const secondRun = migrateAll({ caipiraDir });
  check('second run applies nothing', secondRun.master.applied.length === 0 && secondRun.workspaces.every(w => w.applied.length === 0) && secondRun.failed.length === 0, secondRun);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
