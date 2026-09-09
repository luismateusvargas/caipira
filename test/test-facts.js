const fs = require('fs'), os = require('os'), path = require('path');
const D = require('C:/Users/luism/.caipira/node_modules/better-sqlite3');
const { migrate, WORKSPACE_MIGRATIONS } = require('C:/Users/luism/.caipira/migrate.js');
const { FactStore } = require('C:/Users/luism/.caipira/facts.js');

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
check('applied v1 and v2 on a fresh db', mig.applied.join(',') === '1,2', JSON.stringify(mig.applied));
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
  const { searchWorkspaces } = require('C:/Users/luism/.caipira/facts.js');
  const ws = require('C:/Users/luism/.caipira/workspace.js');
  const machine = require('os').hostname().toLowerCase();

  // Two separate projects, each with a fact only it could answer.
  const mk = (name, fact) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
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

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
