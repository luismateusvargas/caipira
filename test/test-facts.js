require('./fixtures').ensureIsolatedHome();
const fs = require('fs'), os = require('os'), path = require('path');
const D = require('better-sqlite3');
const { migrate, WORKSPACE_MIGRATIONS } = require('../migrate.js');
const { FactStore, buildMatch, termForms } = require('../facts.js');
const { compress, expand, compressProse } = require('../compress.js');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' -> ' + extra : '')); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
const evidenceFile = path.join(tmp, 'config.js');
fs.writeFileSync(evidenceFile, 'module.exports = { port: 3000 };\n');

const db = new D(path.join(tmp, 'w.db'));
const mig = migrate(db, WORKSPACE_MIGRATIONS);
const store = new FactStore(db, { machine: 'testbox', agent: 'claude-code' });

console.log('\n1. migration v2');
check('applied v1 through v6 on a fresh db', mig.applied.join(',') === '1,2,3,4,5,6', JSON.stringify(mig.applied));
check('re-running is a no-op', migrate(db, WORKSPACE_MIGRATIONS).applied.length === 0);

console.log('\n2. recording a decision');
const id = store.record({
  kind: 'decision',
  title: 'Codex repointed to caipira',
  body: 'Codex MCP server and all five hooks move from cavemem to caipira, using the bundled Node 22 runtime. cavemem is removed entirely.',
  summary: 'Codex uses caipira, not cavemem.',
  evidence: [evidenceFile],
  session_id: 'test-session'
});
const fact = store.get(id);
check('fact stored', Boolean(fact));
check('body kept verbatim (not compressed)', fact.body.includes('configuration') === false && fact.body.includes('bundled Node 22 runtime'));
check('state defaults to active', fact.state === 'active', fact.state);
check('provenance recorded', fact.created_by === 'claude-code' && fact.machine === 'testbox');
check('evidence fingerprinted', fact.evidence.length === 1 && fact.evidence[0].sha256.length === 64);

console.log('\n3. verbatim storage survives words the compressor would rewrite');
const id2 = store.record({
  kind: 'constraint', title: 'Database configuration',
  body: 'The database configuration and its dependencies must not be abbreviated.',
  summary: 'Keep database configuration verbatim.'
});
check('"database" and "configuration" intact in body',
  store.get(id2).body.includes('database configuration'), store.get(id2).body);

console.log('\n4. dual-form search reaches facts');
check('abbreviated query finds verbatim fact', store.search('db cfg').some(f => f.id === id2));
check('verbatim query finds it too', store.search('database configuration').some(f => f.id === id2));
check('unrelated query returns nothing', store.search('quantum entanglement zebra').length === 0);

console.log('\n4a. slash abbreviations and shared FTS query forms');
const prose = 'authentication with database because without configuration';
check('slash abbreviations round-trip through compression', expand(compress(prose, { intensity: 'full' })) === prose);
for (const [short, long] of [['w/', 'with'], ['b/c', 'because'], ['w/o', 'without']]) {
  const forms = termForms(short);
  check(`${short} searches abbreviated and expanded forms`, forms.includes(short) && forms.includes(long), JSON.stringify(forms));
}
check('unknown intensity falls back to full',
  compress('please check the database', { intensity: 'invalid' }) === compress('please check the database', { intensity: 'full' }));
check('prototype property is not accepted as an intensity',
  compress('please check the database', { intensity: 'toString' }) === compress('please check the database', { intensity: 'full' }));
check('compressProse also falls back to full',
  compressProse('please check the database', 'invalid') === compressProse('please check the database', 'full'));
check('non-string and empty inputs are safe', compress(null) === '' && compress(42) === '' && compress('') === '');
check('relative and absolute paths retain their separators',
  compress('with ./src/database/configuration and /etc/hosts').includes(' ./src/database/configuration') &&
  compress('with ./src/database/configuration and /etc/hosts').includes(' /etc/hosts'));
const slashId = store.record({ kind: 'constraint', title: 'Slash prose', body: prose });
check('slash query reaches expanded prose in FTS', store.search('w/ b/c w/o').some(f => f.id === slashId));
check('facts keep the shared AND query builder contract',
  buildMatch('w/ b/c').includes(' AND ') && buildMatch('w/ b/c').includes('"because"'));

console.log('\n5. staleness: unchanged file takes the fast path');
let status = store.checkEvidence(id);
check('unchanged evidence verified', status.unchanged === 1 && status.changed === 0, JSON.stringify(status));

console.log('\n6. staleness: touch without content change is NOT drift');
const later = Date.now() + 5000;
fs.utimesSync(evidenceFile, later / 1000, later / 1000);
status = store.checkEvidence(id);
check('touched-but-identical counts as unchanged', status.unchanged === 1 && status.changed === 0, JSON.stringify(status));
const refreshed = store.get(id).evidence[0];
check('cheap fields refreshed so next check is fast', Math.floor(later / 1000) * 1000 <= refreshed.mtime + 1000);

console.log('\n7. staleness: real edit flips the fact to needs_review');
fs.writeFileSync(evidenceFile, 'module.exports = { port: 8080 };\n');
const verified = store.verify([id]);
check('drift detected', verified[0].drifted === true, JSON.stringify(verified[0]));
check('state flipped to needs_review', store.get(id).state === 'needs_review', store.get(id).state);
check('names the file to re-read', verified[0].changedPaths[0] === evidenceFile, JSON.stringify(verified[0].changedPaths));
check('drifted() reports it', store.drifted().some(f => f.id === id));

console.log('\n8. trust ranking: stale outranked by verified');
const results = store.search('database configuration codex caipira');
const stale = results.find(f => f.id === id);
const fresh = results.find(f => f.id === id2);
check('verified fact outranks drifted one', !stale || (fresh && fresh.trust > stale.trust),
  'fresh=' + (fresh && fresh.trust.toFixed(3)) + ' stale=' + (stale && stale.trust.toFixed(3)));

console.log('\n9. reverting evidence restores trust');
fs.writeFileSync(evidenceFile, 'module.exports = { port: 3000 };\n');
store.verify([id]);
check('state returns to active after revert', store.get(id).state === 'active', store.get(id).state);

console.log('\n10. superseding keeps history');
const id3 = store.record({
  kind: 'decision', title: 'Codex repointed to caipira (v2)',
  body: 'Superseding decision.', summary: 'Updated.', supersedes: id
});
check('old fact marked superseded', store.get(id).state === 'superseded', store.get(id).state);
check('old fact still readable', store.get(id).body.length > 0);
check('new fact links back', store.get(id3).supersedes === id);
check('superseded excluded from search', !store.search('codex caipira').some(f => f.id === id));

console.log('\n11. foreign-machine evidence is not treated as drift');
const other = new FactStore(db, { machine: 'tecno', agent: 'codex' });
const st = other.checkEvidence(id3 === null ? id : id);
check('foreign evidence counted separately, not as changed', st.changed === 0 && st.foreign >= 1, JSON.stringify(st));

console.log('\n12. facts can be found by the files they rest on');
// A fresh fact: `id` is superseded by section 10, and a superseded fact must
// not be a drift target — which is itself worth asserting.
const liveFile = path.join(tmp, 'live.js');
fs.writeFileSync(liveFile, 'module.exports = { retries: 3 };\n');
const liveId = store.record({ kind: 'constraint', title: 'retries', body: 'three retries', evidence: [liveFile] });
check('finds the fact resting on the evidence file', store.factsForPaths([liveFile]).includes(liveId));
check('superseded facts are not drift targets', !store.factsForPaths([evidenceFile]).includes(id));
check('unrelated path matches nothing', store.factsForPaths([path.join(tmp, 'unrelated.js')]).length === 0);
check('empty input is not a full-table scan', store.factsForPaths([]).length === 0);
// Windows reaches the same file through different casing, and evidence is
// stored as first seen — a case mismatch must not read as "no fact affected".
check('case-insensitive on this platform',
  process.platform !== 'win32' || store.factsForPaths([liveFile.toUpperCase()]).includes(liveId));
// A slash-flipped path is the same file; PostToolUse payloads mix separators.
check('separator-insensitive', store.factsForPaths([liveFile.replace(/\\/g, '/')]).includes(liveId));

console.log('\n13. cross-workspace recall');
{
  const { searchWorkspaces } = require('../facts.js');
  const ws = require('../workspace.js');
  const machine = require('os').hostname().toLowerCase();

  // Two separate projects, each with a fact only it could answer.
  const mk = (name, fact) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, '.caipira-workspace'), '');
    const w = ws.ensureWorkspace(dir);
    const wdb = ws.openWorkspaceDb(w.dbFile);
    new FactStore(wdb, { machine, agent: 'test' }).record(fact);
    wdb.close();
    return { dir, w };
  };
  const api = mk('xws-api-', {
    kind: 'decision', title: 'auth',
    body: 'Auth uses short-lived JWTs with the refresh token in an httpOnly cookie.'
  });
  const dash = mk('xws-dash-', {
    kind: 'gotcha', title: 'proxy',
    body: 'The Vite proxy drops Set-Cookie headers unless changeOrigin is false.'
  });

  const jwt = searchWorkspaces('jwt refresh token cookie', { machine, limit: 5 });
  check('finds a fact living in another workspace', jwt.length > 0 && /JWT/i.test(jwt[0].body), jwt.length);
  check('result names its origin workspace',
    jwt.length > 0 && String(jwt[0].workspace).toLowerCase().includes('xws-api'), jwt[0] && jwt[0].workspace);

  const both = searchWorkspaces('cookie', { machine, limit: 10 });
  const origins = new Set(both.map(f => f.workspace_id));
  check('spans multiple workspaces in one query', origins.size >= 2, [...origins].join(','));

  // Rank fusion, not score comparison: each workspace's top hit must be able
  // to surface, or one workspace's bm25 scale would swamp the others.
  check('every hit carries its per-workspace rank', both.every(f => f.rank_in_workspace >= 1));
  check('a top-ranked hit from each workspace survives fusion',
    both.filter(f => f.rank_in_workspace === 1).length >= 2);

  check('a workspace can be excluded by key',
    searchWorkspaces('jwt refresh token cookie', { machine, limit: 5, skipKeys: [api.w.key || api.w.canonicalKey] })
      .every(f => f.workspace_id !== api.w.id));

  // The registry outliving a database is normal (a deleted project), and must
  // degrade to "fewer results", never to a thrown search.
  fs.rmSync(dash.w.dbFile, { force: true });
  let survived = true;
  try { searchWorkspaces('cookie', { machine, limit: 5 }); } catch { survived = false; }
  check('a missing workspace db does not break the search', survived);

  fs.rmSync(api.dir, { recursive: true, force: true });
  fs.rmSync(dash.dir, { recursive: true, force: true });
}

console.log('\n14. validation');
let threw = false;
try { store.record({ kind: 'nonsense', title: 't', body: 'b' }); } catch { threw = true; }
check('rejects unknown kind', threw);

console.log('\n15. unverified provenance versus deleted evidence');
const absentFile = path.join(tmp, 'never-created.js');
const unverifiedId = store.record({
  kind: 'gotcha', title: 'provenance only', body: 'Missing and directory paths are provenance.',
  evidence: [absentFile, tmp]
});
check('unfingerprintable paths have no hash', store.get(unverifiedId).evidence.every(row => row.sha256 === null));
const unverified = store.verify([unverifiedId])[0];
check('unfingerprinted provenance does not drift',
  !unverified.drifted && unverified.unverified === 2 && unverified.missing === 0 &&
  store.get(unverifiedId).state === 'active', JSON.stringify(unverified));

const deletedFile = path.join(tmp, 'deleted.js');
fs.writeFileSync(deletedFile, 'module.exports = true;\n');
const deletedId = store.record({ kind: 'constraint', title: 'deleted file', body: 'File must exist.', evidence: [deletedFile] });
fs.unlinkSync(deletedFile);
const deleted = store.verify([deletedId])[0];
check('deleted fingerprinted file drifts with its exact path',
  deleted.drifted && deleted.missing === 1 && deleted.changedPaths.includes(deletedFile) &&
  store.get(deletedId).state === 'needs_review', JSON.stringify(deleted));

console.log('\n16. TTL expiry and explicit re-baselining');
const ttlId = store.record({ kind: 'status', title: 'old status', body: 'This status expires.', ttl_days: 1, evidence: [liveFile] });
const twoDaysAgo = Date.now() - 2 * 86400000;
db.prepare('UPDATE facts SET last_verified_at = ? WHERE id = ?').run(twoDaysAgo, ttlId);
const ttlResult = store.verify([ttlId])[0];
check('expired status is flagged for review', ttlResult.ttlExpired && ttlResult.drifted && store.get(ttlId).state === 'needs_review');
check('verification does not silently renew expired status', store.get(ttlId).last_verified_at === twoDaysAgo);
store.update(ttlId, { state: 'active' });
check('explicit activation renews expired status',
  store.get(ttlId).state === 'active' && store.get(ttlId).last_verified_at > twoDaysAgo);

const activeFile = path.join(tmp, 'active.js');
fs.writeFileSync(activeFile, 'const value = 1;\n');
const activeId = store.record({ kind: 'decision', title: 'active evidence', body: 'Active evidence can be reaffirmed.', evidence: [activeFile] });
const originalHash = store.get(activeId).evidence[0].sha256;
fs.writeFileSync(activeFile, 'const value = 2;\n');
const activeMtime = (Date.now() + 3000) / 1000;
fs.utimesSync(activeFile, activeMtime, activeMtime);
check('an active fact can have changed evidence before verification', store.checkEvidence(activeId).changed === 1);
store.update(activeId, { state: 'active' });
check('explicit activation re-baselines an already-active fact',
  store.get(activeId).state === 'active' && store.get(activeId).evidence[0].sha256 !== originalHash &&
  store.checkEvidence(activeId).changed === 0);

const replacementFile = path.join(tmp, 'replacement.js');
fs.writeFileSync(replacementFile, 'const replacement = true;\n');
store.update(activeId, { evidence: [replacementFile] });
check('update replaces the local evidence list',
  store.get(activeId).evidence.length === 1 && store.get(activeId).evidence[0].path === replacementFile);

console.log('\n17. update and record validation');
const rejects = fn => { try { fn(); return false; } catch { return true; } };
check('record rejects invalid confidence', rejects(() => store.record({ kind: 'decision', title: 'x', body: 'y', confidence: 1.2 })));
check('record rejects unknown supersedes ID', rejects(() => store.record({ kind: 'decision', title: 'x', body: 'y', supersedes: 999999 })));
const beforeDuplicateRanges = store.count();
check('record rejects two ranges for the same file without inserting a fact',
  rejects(() => store.record({ kind: 'decision', title: 'duplicate ranges', body: 'invalid',
    evidence_ranges: [{ path: activeFile, start_line: 1, end_line: 1 },
      { path: path.join(tmp, '.', 'active.js'), start_line: 2, end_line: 2 }] })) &&
  store.count() === beforeDuplicateRanges);
check('update rejects invalid kind', rejects(() => store.update(activeId, { kind: 'nonsense' })));
check('update rejects empty title and body',
  rejects(() => store.update(activeId, { title: '  ' })) && rejects(() => store.update(activeId, { body: '' })));
check('update rejects invalid confidence', rejects(() => store.update(activeId, { confidence: NaN })));
check('rejected updates leave the fact intact', store.get(activeId).kind === 'decision' && store.get(activeId).title === 'active evidence');

console.log('\n18. path lookup relative to a base directory and through a symlink');
check('relative path resolves against supplied base directory',
  store.factsForPaths([path.relative(tmp, liveFile)], tmp).includes(liveId));
if (process.platform !== 'win32') {
  const linkedFile = path.join(tmp, 'linked-live.js');
  fs.symlinkSync(liveFile, linkedFile);
  check('symlink resolves to recorded evidence file', store.factsForPaths([linkedFile]).includes(liveId));
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
