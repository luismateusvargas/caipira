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

db.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
