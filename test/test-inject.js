// Runs the gate against a seeded three-fact workspace (see fixtures.js), using
// prompts of the shape the user actually writes.
require('./fixtures').ensureIsolatedHome();
const ROOT = require('path').join(__dirname, '..');
const { machineId } = require(ROOT + '/workspace.js');
const { buildPromptInjection, buildStandingInjection, buildInjection, selectFacts, renderInjection, termGroups } = require(ROOT + '/inject.js');
const { buildOrMatch, termForms, ftsQuote } = require(ROOT + '/compress.js');

const { db } = require('./fixtures').seedFacts(ROOT);
const opts = { machine: machineId() };

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' -> ' + extra : '')); }
};

// Prompts that SHOULD recall something, and which fact id they should reach.
const shouldHit = [
  ['how do I wire codex over to caipira and get rid of cavemem?', 1],
  ['remind me why codex was pointing at the wrong database', 1],
  ['where do the per workspace databases live?', 2],
  ['how many databases can sqlite attach at once?', 2],
  ['should injection happen at SessionStart or UserPromptSubmit?', 3],
  ['why not just inject the top 5 facts every prompt?', 3]
];

// Prompts about this workspace's general subject matter that are NOT covered
// by any recorded fact. These are the dangerous ones: plausible, on-topic, and
// still wrong to answer from memory.
const shouldMiss = [
  'write me a bash script to rename files by extension',
  'what is the airspeed velocity of an unladen swallow',
  'add a dark mode toggle to the settings page',
  'explain how rust borrow checker handles lifetimes',
  'deploy the helm chart to the staging cluster'
];

console.log('\n1. prompts that should recall a fact');
for (const [prompt, expectedId] of shouldHit) {
  const selected = selectFacts(db, prompt, opts);
  const ids = selected.map(s => s.fact.id);
  check(`"${prompt.slice(0, 52)}..." -> #${expectedId}`, ids.includes(expectedId),
    'got ' + JSON.stringify(ids) + ' cov=' + JSON.stringify(selected.map(s => s.coverage.toFixed(2))));
}

const orMatch = buildOrMatch([termForms('w/'), termForms('b/c')]);
const orHits = db.prepare('SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?').all(orMatch);
check('shared OR query searches expanded slash abbreviations', orHits.some(hit => hit.rowid === 3));
check('shared OR query keeps groups separate', orMatch.includes(' OR ') && orMatch.includes('"with"') && orMatch.includes('"because"'));
check('FTS quoting escapes embedded quotes', ftsQuote('a"b') === '"a""b"');

console.log('\n2. prompts that must inject NOTHING');
for (const prompt of shouldMiss) {
  const text = buildPromptInjection(db, prompt, opts);
  check(`silent on "${prompt.slice(0, 48)}..."`, text === null,
    text && text.slice(0, 160));
}
check('two-letter db recalls the database fact', selectFacts(db, 'where is the db?', opts).some(hit => hit.fact.id === 2));
check('two-letter domain abbreviations remain searchable',
  ['database', 'function', 'transaction', 'middleware'].every(long =>
    termGroups('db fn tx mw').some(forms => forms.includes(long))));
check('common English function words do not inject a fact', buildPromptInjection(db, 'when did this happen?', opts) === null);

console.log('\n3. injection never exceeds its budget');
const big = buildPromptInjection(db, 'codex caipira cavemem database workspace injection decision configuration', opts);
check('at most 3 facts', !big || (big.match(/^- \[/gm) || []).length <= 3, big && (big.match(/^- \[/gm) || []).length);
check('summaries only, no bodies leaked', !big || !big.includes('All prior memory installations'), big && big.slice(0, 200));

console.log('\n4. standing facts for SessionStart');
const standing = buildStandingInjection(db, {});
check('produces standing facts', Boolean(standing));
check('summaries only', standing && !standing.includes('CREATE SCHEMA'));
check('standing footer names record_fact', standing && standing.includes('record_fact'));
check('standing footer says act, not re-derive', standing && /do not re-derive/i.test(standing));

console.log('\n5. injected facts are framed as settled, not as hints');
const framed = buildPromptInjection(db, 'how do I wire codex over to caipira and get rid of cavemem?', opts);
check('names update_fact for contradictions', framed && framed.includes('update_fact'));
check('discourages reconfirming', framed && /re-reading files|re-running checks/i.test(framed));
check('still gates on NEEDS REVIEW', framed && framed.includes('NEEDS REVIEW'));
const activeStale = renderInjection([{
  fact: { id: 99, kind: 'decision', summary: 'Changed evidence', state: 'active' },
  stale: ['/tmp/changed.js']
}]);
check('active fact with changed evidence is flagged', activeStale && activeStale.includes('NEEDS REVIEW') && activeStale.includes('/tmp/changed.js'));
const oversized = { fact: { id: 98, kind: 'decision', summary: 'x'.repeat(1300), state: 'active' }, stale: [] };
const fitting = { fact: { id: 99, kind: 'decision', summary: 'Short fact', state: 'active' }, stale: [] };
const budgeted = renderInjection([oversized, fitting]);
check('oversized fact does not hide a later fitting fact', budgeted && budgeted.includes('#99') && !budgeted.includes('#98'));
check('rendering no fitting facts returns null', renderInjection([oversized]) === null);
console.log('\n--- SessionStart injection ---\n' + standing);

console.log('\n--- UserPromptSubmit injection for a real prompt ---');
console.log(buildPromptInjection(db, 'how do I wire codex over to caipira and get rid of cavemem?', opts));

console.log('\n6. drift notice');
const { buildDriftNotice } = require(ROOT + '/inject.js');
check('silent when nothing has drifted', buildDriftNotice(db) === null);

// Flip one fact by hand rather than editing files: this asserts the rendering,
// not the fingerprinting, which test-facts already covers.
db.prepare("UPDATE facts SET state = 'needs_review' WHERE id = 2").run();
const notice = buildDriftNotice(db);
check('names the drifted fact', notice && notice.includes('#2'));
check('does not list undrifted facts', notice && !notice.includes('#1') && !notice.includes('#3'));
check('instructs update_fact', notice && notice.includes('update_fact'));
check('offers supersedes for a fact the change invalidated', notice && notice.includes('supersedes'));
db.prepare("UPDATE facts SET state = 'active' WHERE id = 2").run();
console.log('\n--- drift notice ---\n' + notice);

console.log('\n7. bounded episodic and subpath recall');
const { FactStore } = require(ROOT + '/facts.js');
const factStore = new FactStore(db, { machine: machineId(), agent: 'test', root: ROOT });
const localId = factStore.record({ kind: 'decision', title: 'local recall', body: 'The local rule.',
  evidence: [ROOT + '/test/test-inject.js'] });
const globalId = factStore.record({ kind: 'decision', title: 'global recall', body: 'The global rule.',
  evidence: [ROOT + '/package.json'] });
db.prepare(`INSERT INTO sessions (id, ide, started_at, ended_at, summary)
  VALUES ('digest-probe', 'test', 1, 2, 'Edited source and checked callers')`).run();
db.prepare(`INSERT INTO ast_symbols (path, name, qualified_name, kind, is_public, start_line,
  end_line, params_json, signature_text, signature_hash)
  VALUES ('test/sample.js', 'inspect', 'inspect', 'function', 1, 1, 2, '[]', 'inspect()', 'abc')`).run();
const recall = buildInjection(db, { root: ROOT }, { cwd: ROOT + '/test', budget: 900 });
check('local evidence ranks before newer global evidence', recall.indexOf(`#${localId}]`) < recall.indexOf(`#${globalId}]`), recall);
check('recent digest is included', recall.includes('Recent sessions:') && recall.includes('Edited source'), recall);
check('symbol map is included with kind and line span', recall.includes('Workspace symbols:') &&
  recall.includes('- test/sample.js::inspect (function L1-2)'), recall);
for (const budget of [0, 24, 70, 500]) {
  const text = buildInjection(db, { root: ROOT }, { cwd: ROOT + '/test', budget });
  check(`strict ${budget}-character budget`, !text || text.length <= budget, text?.length);
}

console.log('\n8. prompt recall flags changed evidence without verify');
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-stale-'));
  const source = path.join(dir, 'server.js');
  fs.writeFileSync(source, 'const PORT = 3000;\n');
  const id = factStore.record({ kind: 'decision', title: 'Dev server port',
    body: 'The dev server listens on port 3000.', summary: 'The dev server listens on port 3000.',
    evidence: [source] });
  fs.writeFileSync(source, 'const PORT = 18080;\n');
  const recalled = buildInjection(db, { root: ROOT }, {
    prompt: 'which port does the dev server use?', machine: machineId(), budget: 2000
  });
  check('active stale fact is explicitly flagged', recalled?.includes(`[decision#${id}]`) &&
    recalled.includes(`NEEDS REVIEW — changed since recorded: ${source}`), recalled);
  check('prompt recall does not silently change fact state', db.prepare('SELECT state FROM facts WHERE id = ?').get(id).state === 'active');
  db.prepare('DELETE FROM facts WHERE id = ?').run(id);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n9. prompt turns never repeat session context');
{
  // This database holds facts, a session digest and a public symbol by now.
  const unrelatedPrompt = buildInjection(db, { root: ROOT }, {
    prompt: 'add a dark mode toggle to the settings page', machine: machineId(), budget: 2400
  });
  check('unrelated prompt injects nothing', unrelatedPrompt === null, unrelatedPrompt);
  const relevantPrompt = buildInjection(db, { root: ROOT }, {
    prompt: 'how do I wire codex over to caipira and get rid of cavemem?', machine: machineId(), budget: 2400
  });
  check('relevant prompt recalls facts', relevantPrompt?.startsWith('Caipira recalled facts:') &&
    relevantPrompt.includes('cavemem'), relevantPrompt);
  check('relevant prompt omits symbols and session digests', relevantPrompt &&
    !relevantPrompt.includes('Workspace symbols:') && !relevantPrompt.includes('Recent sessions:'), relevantPrompt);
}

console.log('\n10. session-start symbol map ranking, packing and budget');
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const { openWorkspaceDb } = require(ROOT + '/workspace.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-symbols-'));
  // No facts and no sessions, so the injection is the symbol block alone.
  const sdb = openWorkspaceDb(path.join(dir, 'symbols.db'));
  const ws = { root: dir };
  const addSymbol = (file, qualified, kind, start, end, isPublic = 1) => sdb.prepare(`INSERT INTO ast_symbols
    (path, name, qualified_name, kind, is_public, start_line, end_line, params_json, signature_text, signature_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`).run(file, qualified.split('.').pop(), qualified, kind, isPublic, start, end, qualified, qualified);
  const addEdge = (source, targetPath, targetSymbol, kind) => sdb.prepare(`INSERT INTO ast_edges
    (source_path, source_symbol, target_path, target_symbol, edge_kind, line) VALUES (?, NULL, ?, ?, ?, 1)`)
    .run(source, targetPath, targetSymbol, kind);

  addSymbol('z.js', 'zeta', 'function', 1, 1);
  addSymbol('lib/deep/util.js', 'helper', 'function', 2, 4);
  addSymbol('lib/deep/util.js', 'Shape', 'interface', 6, 9);
  addSymbol('a.js', 'Beta.run', 'method', 6, 10);
  addSymbol('a.js', 'Beta', 'class', 5, 20);
  addSymbol('a.js', 'alpha', 'function', 1, 3);
  addSymbol('a.js', 'secret', 'function', 22, 25, 0);
  addSymbol('lib/core.js', 'core', 'function', 1, 40);
  addSymbol('feature/view.js', 'View', 'class', 32, 50);
  addSymbol('feature/view.js', 'render', 'function', 3, 30);
  // Fan-in: core 3 calls, zeta 2 file imports, Beta.run 1 call by its simple
  // name, Shape 1 type use. Unresolved calls name helper but must not count.
  for (const source of ['a.js', 'z.js', 'feature/view.js']) addEdge(source, 'lib/core.js', 'core', 'calls');
  for (const source of ['a.js', 'lib/core.js']) addEdge(source, 'z.js', './z', 'imports');
  addEdge('lib/core.js', 'a.js', 'run', 'calls');
  addEdge('a.js', 'lib/deep/util.js', 'Shape', 'uses_type');
  for (let i = 0; i < 5; i++) addEdge('a.js', null, 'helper', 'calls');

  const full = buildInjection(sdb, ws, { budget: 24000 });
  check('standing map lists every public symbol in (path, line) order', full === [
    'Workspace symbols:',
    '- a.js::alpha (function L1-3)',
    '- a.js::Beta (class L5-20)',
    '- a.js::Beta.run (method L6-10)',
    '- feature/view.js::render (function L3-30)',
    '- feature/view.js::View (class L32-50)',
    '- lib/core.js::core (function L1-40)',
    '- lib/deep/util.js::helper (function L2-4)',
    '- lib/deep/util.js::Shape (interface L6-9)',
    '- z.js::zeta (function L1-1)'
  ].join('\n'), full);
  check('more than 5 symbols, each with kind and line span',
    (full?.match(/^- \S+::\S+ \(\w+ L\d+-\d+\)$/gm) || []).length === 9, full);
  check('private symbols are left out', full && !full.includes('secret'), full);
  check('a map that fits carries no omission notice', full && !full.includes('omitted'), full);

  const footer = n => `(... ${n} more public symbols omitted to fit budget; use workspace_symbols or inspect_symbol)`;
  const local = [
    'Workspace symbols:',
    '- feature/view.js::render (function L3-30)',
    '- feature/view.js::View (class L32-50)',
    '- lib/core.js::core (function L1-40)',
    '- z.js::zeta (function L1-1)',
    footer(5)
  ].join('\n');
  const localMap = buildInjection(sdb, ws, { cwd: path.join(dir, 'feature'), budget: local.length });
  check('tight budget keeps the subpath first, then fan-in, and counts the rest', localMap === local, localMap);

  const global = [
    'Workspace symbols:',
    '- a.js::Beta.run (method L6-10)',
    '- lib/core.js::core (function L1-40)',
    '- z.js::zeta (function L1-1)',
    footer(6)
  ].join('\n');
  const globalMap = buildInjection(sdb, ws, { budget: global.length });
  check('without a subpath, fan-in then shallower path decide; unresolved edges do not count',
    globalMap === global, globalMap);

  for (const budget of [0, 20, 60, 110, 150, 250, 400]) {
    const text = buildInjection(sdb, ws, { cwd: path.join(dir, 'feature'), budget });
    check(`symbol map within a strict ${budget}-character budget`, !text || text.length <= budget, text?.length);
  }
  sdb.close();

  const mdb = openWorkspaceDb(path.join(dir, 'many.db'));
  const insert = mdb.prepare(`INSERT INTO ast_symbols
    (path, name, qualified_name, kind, is_public, start_line, end_line, params_json, signature_text, signature_hash)
    VALUES (?, ?, ?, 'function', 1, 1, 2, '[]', '', '')`);
  mdb.transaction(() => {
    for (let i = 0; i < 2000; i++) {
      const n = String(i).padStart(4, '0');
      insert.run(`pkg/module_${n}.js`, `exportedFunction${n}`, `exportedFunction${n}`);
    }
  })();
  const huge = buildInjection(mdb, { root: dir }, { budget: 100000 });
  const kept = (huge?.match(/^- /gm) || []).length;
  check('budget above 64000 is capped at 64000', huge && huge.length <= 64000 && huge.length > 12000, huge?.length);
  check('omission notice counts exactly the symbols left out',
    huge?.endsWith(footer(2000 - kept)) && kept > 0 && kept < 2000, `${kept} kept`);
  const startup = buildInjection(mdb, { root: dir }, { budget: 24000 });
  check('startup budget of 24000 is respected', startup && startup.length <= 24000 && startup.includes('omitted'), startup?.length);
  check('the same index renders byte-identical text', startup === buildInjection(mdb, { root: dir }, { budget: 24000 }));
  mdb.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const fs = require('fs'), os = require('os'), path = require('path');
const { openWorkspaceDb } = require(ROOT + '/workspace.js');
const {
  selectWorkspaceSymbols, locateSession, PROMPT_BUDGET_CHARS, STARTUP_BUDGET_CHARS, MAX_BUDGET_CHARS
} = require(ROOT + '/inject.js');
const addPublic = (sdb, file, name, start = 1, end = 1) => sdb.prepare(`INSERT INTO ast_symbols
  (path, name, qualified_name, kind, is_public, start_line, end_line, params_json, signature_text, signature_hash)
  VALUES (?, ?, ?, 'function', 1, ?, ?, '[]', ?, ?)`).run(file, name, name, start, end, name, name);
const footerFor = n => `(... ${n} more public symbols omitted to fit budget; use workspace_symbols or inspect_symbol)`;

console.log('\n11. every rendered needs_review fact carries its own flag');
{
  const ttlExpired = renderInjection([{ fact: { id: 123, kind: 'decision', summary: 'TTL expired.', state: 'needs_review' }, stale: [] }]);
  check('needs_review with no changed paths is flagged', ttlExpired?.split('\n')[1] === '- [decision#123] TTL expired. (NEEDS REVIEW)', ttlExpired);
  const changed = renderInjection([{ fact: { id: 124, kind: 'decision', summary: 'Moved.', state: 'active' }, stale: ['/w/a.js'] }]);
  check('changed paths keep the detailed flag', changed?.split('\n')[1] === '- [decision#124] Moved. (NEEDS REVIEW — changed since recorded: /w/a.js)', changed);
  const current = renderInjection([{ fact: { id: 125, kind: 'decision', summary: 'Current.', state: 'active' }, stale: [] }]);
  check('an active unchanged fact stays unflagged', current?.split('\n')[1] === '- [decision#125] Current.', current);
}

console.log('\n12. a failing block costs only itself, and says so');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-failure-'));
  const fdb = openWorkspaceDb(path.join(dir, 'failure.db'));
  const { FactStore } = require(ROOT + '/facts.js');
  new FactStore(fdb, { machine: machineId(), agent: 'test' }).record({ kind: 'status', title: 'Release status',
    summary: 'Release candidate is frozen.', body: 'The release candidate is frozen.' });
  fdb.prepare(`INSERT INTO sessions (id, ide, started_at, ended_at, summary) VALUES ('s1', 'test', 1, 2, 'Froze the release')`).run();
  addPublic(fdb, 'api.js', 'api');
  const failures = [];
  const onFailure = (operation, error) => failures.push(`${operation}: ${error.message}`);
  const healthy = buildInjection(fdb, { root: dir }, { budget: 2400, onFailure });

  // Fault injection without touching the schema: only fact reads fail.
  const factsFail = { name: fdb.name, prepare: sql => {
    if (/\bfacts\b/.test(sql) && !/ast_/.test(sql)) throw new Error('disk I/O error');
    return fdb.prepare(sql);
  } };
  const withoutFacts = buildInjection(factsFail, { root: dir }, { budget: 2400, onFailure });
  check('a failed fact query keeps digests and symbols at session start',
    withoutFacts === healthy.slice(healthy.indexOf('Recent sessions:')) && withoutFacts.includes('Workspace symbols:') &&
    failures.length === 1 && failures[0] === 'standing facts: disk I/O error', `${withoutFacts} ${JSON.stringify(failures)}`);
  failures.length = 0;
  check('a failed fact query on a prompt turn is reported, not mistaken for a miss',
    buildInjection(factsFail, { root: dir }, { prompt: 'is the release candidate frozen?', budget: 2400, onFailure }) === null &&
    failures.length === 1 && failures[0] === 'prompt facts: disk I/O error', JSON.stringify(failures));

  failures.length = 0;
  fdb.exec('DROP TABLE ast_edges');
  const degraded = buildInjection(fdb, { root: dir }, { budget: 2400, onFailure });
  check('facts and digests survive a failed symbol query', degraded ===
    healthy.slice(0, healthy.indexOf('\nWorkspace symbols:')) && degraded.includes('Release candidate') &&
    degraded.includes('Froze the release'), degraded);
  check('one diagnostic names the failing operation', failures.length === 1 &&
    failures[0].startsWith('workspace symbols: ') && failures[0].includes('ast_edges'), JSON.stringify(failures));

  failures.length = 0;
  check('an unrelated healthy prompt is a silent miss', buildInjection(fdb, { root: dir },
    { prompt: 'add a dark mode toggle to the settings page', budget: 2400, onFailure }) === null && failures.length === 0,
  JSON.stringify(failures));
  fdb.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n13. the omission notice survives when no symbol fits');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-omitted-'));
  const odb = openWorkspaceDb(path.join(dir, 'omitted.db'));
  for (const name of ['alpha', 'beta', 'gamma', 'delta']) addPublic(odb, `${name}.js`, name);
  const notice = `Workspace symbols:\n${footerFor(4)}`;
  check('all four omitted within 120 characters', selectWorkspaceSymbols(odb, '', 120) === notice, selectWorkspaceSymbols(odb, '', 120));
  check('exactly the notice length still fits it', selectWorkspaceSymbols(odb, '', notice.length) === notice);
  check('one character less leaves the block out', selectWorkspaceSymbols(odb, '', notice.length - 1) === null);
  const full = ['Workspace symbols:', '- alpha.js::alpha (function L1-1)', '- beta.js::beta (function L1-1)',
    '- delta.js::delta (function L1-1)', '- gamma.js::gamma (function L1-1)'].join('\n');
  check('exactly the full map length needs no notice', selectWorkspaceSymbols(odb, '', full.length) === full);
  const partial = ['Workspace symbols:', '- alpha.js::alpha (function L1-1)', footerFor(3)].join('\n');
  check('ordinary partial packing is unchanged', selectWorkspaceSymbols(odb, '', partial.length) === partial,
    selectWorkspaceSymbols(odb, '', partial.length));
  odb.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n14. locality compares canonical paths by whole components');
{
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-locality-'));
  fs.mkdirSync(path.join(real, 'z'));
  fs.mkdirSync(path.join(real, '..tools'));
  const alias = `${real}-alias`;
  fs.symlinkSync(real, alias, 'dir');
  const ldb = openWorkspaceDb(path.join(real, 'locality.db'));
  addPublic(ldb, 'a.js', 'outside');
  addPublic(ldb, 'z/local.js', 'local');
  const expected = ['Workspace symbols:', '- z/local.js::local (function L1-1)', '- a.js::outside (function L1-1)'].join('\n');
  const aliasRoot = buildInjection(ldb, { root: alias }, { cwd: path.join(real, 'z'), budget: 2400 });
  check('symlink-registered root with a real cwd ranks the subpath first', aliasRoot === expected, aliasRoot);
  const aliasCwd = buildInjection(ldb, { root: real }, { cwd: path.join(alias, 'z'), budget: 2400 });
  check('real root with a symlinked cwd ranks the subpath first', aliasCwd === expected, aliasCwd);
  check('a directory named ..tools is inside the workspace', locateSession(real, path.join(real, '..tools')).subpath === '..tools');
  check('parent traversal is outside', locateSession(path.join(real, 'z'), real).subpath === '');
  check('a sibling sharing the root as a prefix is outside', locateSession(real, `${real}-alias`).subpath === '' &&
    locateSession(path.join(real, 'z'), path.join(real, 'zz')).subpath === '');
  check('missing paths fall back to lexical comparison', locateSession('/no/such/root', '/no/such/root/pkg/src').subpath === 'pkg/src');
  check('root spellings cover both the alias and the real path',
    JSON.stringify(locateSession(alias, path.join(real, 'z')).roots) === JSON.stringify([alias, fs.realpathSync.native(real)]));
  const win = { pathApi: path.win32, realpath: () => null };
  check('Windows comparison ignores drive and directory case', locateSession('C:\\Work\\Repo', 'c:\\work\\repo\\Src\\Lib', win).subpath === 'Src/Lib');
  check('a different Windows drive is outside', locateSession('C:\\Work\\Repo', 'D:\\Work\\Repo\\src', win).subpath === '');
  check('Windows parent traversal is outside', locateSession('C:\\Work\\Repo', 'C:\\Work', win).subpath === '');
  ldb.close();
  fs.rmSync(alias, { force: true });
  fs.rmSync(real, { recursive: true, force: true });
}

console.log('\n15. named budgets keep their specified values');
check('prompt, startup and maximum budgets', PROMPT_BUDGET_CHARS === 2400 && STARTUP_BUDGET_CHARS === 24000 &&
  MAX_BUDGET_CHARS === 64000);

console.log('\n16. symbol evidence that could not be checked is never shown as settled');
{
  const ast = require(ROOT + '/ast.js');
  const { FactStore, AstRefreshScope } = require(ROOT + '/facts.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-unchecked-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-unchecked-db-'));
  fs.writeFileSync(path.join(dir, '.caipira-workspace'), '');
  fs.writeFileSync(path.join(dir, 'api.js'), 'export function api(value) { return value; }\n');
  const dbFile = path.join(dbDir, 'unchecked.db');
  ast.syncWorkspaceAst(dir, dbFile);
  const udb = openWorkspaceDb(dbFile);
  const machine = machineId();
  const ustore = new FactStore(udb, { machine, agent: 'test', root: dir });
  const id = ustore.record({ kind: 'constraint', title: 'Api argument count', summary: 'Api takes one argument.',
    body: 'The api function takes one argument.', evidenceSymbols: [{ path: 'api.js', qualifiedName: 'api',
      signatureHash: ast.inspectSymbol(udb, 'api.js::api').symbol.signature_hash }] });
  // The supported update drops this machine's file fingerprints and keeps the anchor.
  ustore.update(id, { evidence: [] });
  const DAY_AGO = Date.now() - 86400000;
  udb.prepare('UPDATE facts SET last_verified_at = ? WHERE id = ?').run(DAY_AGO, id);
  fs.writeFileSync(path.join(dir, 'api.js'), 'export function api(value, extra) { return value + extra; }\n');

  const calls = [];
  const down = new AstRefreshScope({ updateFile: (root, file) => {
    calls.push(file);
    throw Object.assign(new Error('caipira-ast is missing'), { code: 'binary_missing' });
  } });
  const outcomes = ustore.verify([id], down);
  check('verification leaves the anchor unchecked, not drifted', outcomes.length === 1 && outcomes[0].unchecked === 1 &&
    outcomes[0].changed === 0 && !outcomes[0].drifted, JSON.stringify(outcomes));

  const warned = `- [constraint#${id}] Api takes one argument. (NEEDS REVIEW — symbol evidence could not be checked)`;
  const factLines = text => JSON.stringify((text || '').split('\n').filter(line => line.startsWith('- [constraint#')));
  const uncheckedFacts = new Set(outcomes.filter(outcome => outcome.unchecked > 0).map(outcome => outcome.id));
  const standing = buildInjection(udb, { root: dir }, { budget: 2400, uncheckedFacts });
  check('standing recall warns on it', factLines(standing) === JSON.stringify([warned]), standing);
  const prompt = 'api argument count?';
  const recalled = buildInjection(udb, { root: dir }, { prompt, machine, astScope: down, budget: 2400 });
  check('prompt recall warns on it', factLines(recalled) === JSON.stringify([warned]), recalled);
  // What Antigravity's first step adds beyond the standing facts.
  const extra = buildPromptInjection(udb, prompt, { machine, root: dir, astScope: down });
  check('the prompt recall added at startup warns on it', factLines(extra) === JSON.stringify([warned]), extra);
  const stored = udb.prepare('SELECT state, last_verified_at FROM facts WHERE id = ?').get(id);
  check('nothing marks it verified or broken', stored.state === 'active' && stored.last_verified_at === DAY_AGO,
    JSON.stringify(stored));
  check('the missing parser was tried once for all of it', calls.length === 1, JSON.stringify(calls));

  const [healthy] = ustore.verify([id], new AstRefreshScope());
  check('a working parser still finds the real signature change', healthy.drifted && healthy.unchecked === 0 &&
    JSON.stringify(healthy.broken) === JSON.stringify([{ path: 'api.js', symbol: 'api', reason: 'symbol_signature_changed' }]) &&
    udb.prepare('SELECT state FROM facts WHERE id = ?').get(id).state === 'needs_review', JSON.stringify(healthy));
  udb.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
}

console.log('\n17. file evidence recorded through another alias of the root keeps its locality');
{
  const { FactStore } = require(ROOT + '/facts.js');
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-aliases-'));
  for (const file of ['z/api.js', 'zz/api.js', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(real, file)), { recursive: true });
    fs.writeFileSync(path.join(real, file), '{}\n');
  }
  const sibling = `${real}-sibling`;
  fs.mkdirSync(path.join(sibling, 'z'), { recursive: true });
  fs.writeFileSync(path.join(sibling, 'z', 'api.js'), '{}\n');
  const aliasA = `${real}-a`, aliasB = `${real}-b`;
  fs.symlinkSync(real, aliasA, 'dir');
  fs.symlinkSync(real, aliasB, 'dir');
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-aliases-db-'));
  const adb = openWorkspaceDb(path.join(dbDir, 'aliases.db'));
  const astore = new FactStore(adb, { machine: machineId(), agent: 'test', root: aliasA });
  // Equal kinds and fixed timestamps, so only locality can reorder them.
  const recordAt = (title, file, updatedAt) => {
    const factId = astore.record({ kind: 'decision', title, summary: `${title}.`, body: `${title}.`, evidence: [file] });
    adb.prepare('UPDATE facts SET updated_at = ? WHERE id = ?').run(updatedAt, factId);
    return title;
  };
  recordAt('Local policy', path.join(aliasB, 'z', 'api.js'), 1);
  recordAt('Deleted local policy', path.join(aliasA, 'z', 'gone.js'), 2);
  recordAt('Global policy', path.join(real, 'package.json'), 10);
  recordAt('Sibling directory policy', path.join(real, 'zz', 'api.js'), 5);
  recordAt('Sibling root policy', path.join(sibling, 'z', 'api.js'), 4);
  const order = cwd => (buildInjection(adb, { root: aliasA }, { cwd, budget: 2400 }) || '').split('\n')
    .filter(line => line.startsWith('- [decision#')).map(line => line.replace(/^- \[decision#\d+\] /, ''));
  const expected = JSON.stringify(['Deleted local policy.', 'Local policy.', 'Global policy.',
    'Sibling directory policy.', 'Sibling root policy.']);
  check('evidence through a second alias ranks local from that alias', JSON.stringify(order(path.join(aliasB, 'z'))) === expected,
    JSON.stringify(order(path.join(aliasB, 'z'))));
  check('and from the real directory', JSON.stringify(order(path.join(real, 'z'))) === expected,
    JSON.stringify(order(path.join(real, 'z'))));
  check('and from the registered alias', JSON.stringify(order(path.join(aliasA, 'z'))) === expected,
    JSON.stringify(order(path.join(aliasA, 'z'))));
  check('at the root nothing is local, so newest leads', JSON.stringify(order(aliasB)) === JSON.stringify(['Global policy.',
    'Sibling directory policy.', 'Sibling root policy.', 'Deleted local policy.', 'Local policy.']), JSON.stringify(order(aliasB)));

  const { isLocalEvidence } = require(ROOT + '/inject.js');
  const win = { pathApi: path.win32, realpath: () => null };
  const place = locateSession('C:\\Work\\Repo', 'c:\\work\\repo\\Src', win);
  check('Windows evidence comparison ignores drive-letter and directory case',
    isLocalEvidence(place, 'c:\\WORK\\Repo\\src\\a.js', win) && isLocalEvidence(place, 'C:\\Work\\Repo\\Src\\Deep\\b.js', win));
  check('another Windows drive, a sibling root, and the root itself are not local',
    !isLocalEvidence(place, 'D:\\Work\\Repo\\Src\\a.js', win) && !isLocalEvidence(place, 'C:\\Work\\RepoX\\Src\\a.js', win) &&
    !isLocalEvidence(place, 'C:\\Work\\Repo\\a.js', win) && !isLocalEvidence(place, 'C:\\Work\\Repo\\Srcs\\a.js', win));
  adb.close();
  for (const target of [aliasA, aliasB]) fs.rmSync(target, { force: true });
  for (const target of [real, sibling, dbDir]) fs.rmSync(target, { recursive: true, force: true });
}

db.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
