// Runs the gate against a seeded three-fact workspace (see fixtures.js), using
// prompts of the shape the user actually writes.
const ROOT = require('path').join(__dirname, '..');
const { machineId } = require(ROOT + '/workspace.js');
const { buildPromptInjection, buildStandingInjection, selectFacts, renderInjection, termGroups } = require(ROOT + '/inject.js');
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

db.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
