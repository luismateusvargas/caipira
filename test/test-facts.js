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

console.log('\n19. a refresh scope re-indexes each file once, within its deadline');
{
  const { AstRefreshScope, EVIDENCE_REFRESH_TIMEOUT_MS } = require('../facts.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-refresh-'));
  fs.mkdirSync(path.join(root, 'src'));
  const sdb = new D(path.join(tmp, 'refresh.db'));
  migrate(sdb, WORKSPACE_MIGRATIONS);
  const rstore = new FactStore(sdb, { machine: 'testbox', agent: 'test', root });
  const DAY_AGO = Date.now() - 86400000;

  // Index a file as it is now with one public symbol, then anchor facts to it.
  const indexFile = rel => {
    const stat = fs.statSync(path.join(root, rel));
    sdb.prepare(`INSERT OR REPLACE INTO ast_files (path, language, size, mtime_ms, content_sha256, indexed_at)
      VALUES (?, 'javascript', ?, ?, '', 0)`).run(rel, stat.size, Math.floor(stat.mtimeMs));
  };
  const anchored = (rel, count) => {
    fs.writeFileSync(path.join(root, rel), 'export function api(value) { return value; }\n');
    indexFile(rel);
    sdb.prepare(`INSERT INTO ast_symbols (path, name, qualified_name, kind, is_public, start_line, end_line,
      params_json, signature_text, signature_hash) VALUES (?, 'api', 'api', 'function', 1, 1, 1, '[]', 'api(value)', 'h1')`).run(rel);
    const ids = [];
    for (let i = 0; i < count; i++) {
      ids.push(rstore.record({ kind: 'constraint', title: `${rel} ${i}`, body: 'api takes one argument',
        evidenceSymbols: [{ path: rel, qualifiedName: 'api', signatureHash: 'h1' }] }));
    }
    sdb.prepare(`UPDATE facts SET last_verified_at = ? WHERE id IN (${ids.join(',')})`).run(DAY_AGO);
    return ids;
  };
  // A different size, so the change is seen within one mtime tick.
  const edit = rel => fs.writeFileSync(path.join(root, rel), 'export function api(value, extra) { return value + extra; }\n');
  // Stands in for caipira-ast: records each call, then fails with `code` or,
  // with no code, re-indexes the file with its signature unchanged.
  const parser = code => {
    const calls = [];
    const updateFile = (workspaceRoot, dbFile, file, opts) => {
      calls.push({ path: path.relative(workspaceRoot, file).split(path.sep).join('/'), timeoutMs: opts.timeoutMs });
      if (code) throw Object.assign(new Error(code), { code });
      indexFile(path.relative(workspaceRoot, file));
    };
    return { calls, updateFile };
  };
  const facts = ids => ids.map(factId => sdb.prepare('SELECT state, last_verified_at FROM facts WHERE id = ?').get(factId));
  const reset = ids => sdb.prepare(`UPDATE facts SET state = 'active', last_verified_at = ? WHERE id IN (${ids.join(',')})`).run(DAY_AGO);

  const shared = anchored('src/shared.js', 6);
  edit('src/shared.js');
  const slow = parser('timeout');
  const timedOut = rstore.verify(shared, new AstRefreshScope({ updateFile: slow.updateFile }));
  check('six facts on one changed file start the parser once', slow.calls.length === 1, JSON.stringify(slow.calls));
  check('the refresh asks for at most its own timeout', slow.calls[0]?.timeoutMs === EVIDENCE_REFRESH_TIMEOUT_MS, JSON.stringify(slow.calls));
  check('unconfirmed facts are flagged, never reported verified', timedOut.every(r => r.drifted && r.unchecked === 1) &&
    facts(shared).every(f => f.state === 'needs_review' && f.last_verified_at === DAY_AGO), JSON.stringify(facts(shared)));

  reset(shared);
  const healthy = parser(null);
  rstore.verify(shared, new AstRefreshScope({ updateFile: healthy.updateFile }));
  check('a working parser is still asked once for the shared file', healthy.calls.length === 1, JSON.stringify(healthy.calls));
  check('facts it confirms are verified now', facts(shared).every(f => f.state === 'active' && f.last_verified_at > DAY_AGO),
    JSON.stringify(facts(shared)));

  const spread = ['src/a.js', 'src/b.js', 'src/c.js'].flatMap(rel => anchored(rel, 2));
  ['src/a.js', 'src/b.js', 'src/c.js'].forEach(edit);
  const missing = parser('binary_missing');
  rstore.verify(spread, new AstRefreshScope({ updateFile: missing.updateFile }));
  check('a missing parser is tried once across several anchor files', missing.calls.length === 1, JSON.stringify(missing.calls));
  check('none of their facts count as verified', facts(spread).every(f => f.state === 'needs_review' && f.last_verified_at === DAY_AGO));

  reset(spread);
  const broken = parser('parse');
  rstore.verify(spread, new AstRefreshScope({ updateFile: broken.updateFile }));
  check('a file-specific failure still lets other files refresh, each once',
    JSON.stringify(broken.calls.map(c => c.path)) === '["src/a.js","src/b.js","src/c.js"]', JSON.stringify(broken.calls));

  reset(spread);
  let now = 1000;
  const late = parser(null);
  const deadline = new AstRefreshScope({ deadlineAtMs: 1500, clock: () => now, updateFile: late.updateFile });
  const first = deadline.refresh(sdb, root, 'src/a.js');
  now = 1600;
  const second = deadline.refresh(sdb, root, 'src/b.js');
  check('a refresh near the deadline gets only the time left', first === true && late.calls[0]?.timeoutMs === 500, JSON.stringify(late.calls));
  check('nothing starts after the deadline', second === false && late.calls.length === 1, JSON.stringify(late.calls));

  const skipped = parser(null);
  const unreadable = new AstRefreshScope({ unreadablePaths: ['src'], updateFile: skipped.updateFile });
  check('paths the last sync could not read are not retried',
    unreadable.refresh(sdb, root, 'src/c.js') === false && skipped.calls.length === 0, JSON.stringify(skipped.calls));

  // Unchanged file evidence alone used to count as verification even when
  // the symbol evidence beside it could not be re-checked.
  const [stale] = anchored('src/stale.js', 1);
  sdb.prepare(`UPDATE ast_files SET size = size + 1 WHERE path = 'src/stale.js'`).run();
  const down = parser('timeout');
  const [result] = rstore.verify([stale], new AstRefreshScope({ updateFile: down.updateFile }));
  check('unchecked symbol evidence keeps an otherwise unchanged fact from being verified',
    result.unchecked === 1 && !result.drifted && facts([stale])[0].state === 'active' &&
    facts([stale])[0].last_verified_at === DAY_AGO, JSON.stringify({ result, fact: facts([stale])[0] }));

  sdb.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n20. search reports every candidate it checks, before ranking and the limit drop any');
{
  const odb = new D(path.join(tmp, 'observe.db'));
  migrate(odb, WORKSPACE_MIGRATIONS);
  const ostore = new FactStore(odb, { machine: 'testbox', agent: 'test' });
  const steady = path.join(tmp, 'steady.js');
  const moving = path.join(tmp, 'moving.js');
  fs.writeFileSync(steady, 'module.exports = 1;\n');
  fs.writeFileSync(moving, 'module.exports = 2;\n');
  // Seven matching facts of two kinds, ranked by confidence; one rests on a file about to change.
  const ids = [0.2, 0.9, 0.5, 1, 0.4, 0.7, 0.3].map((confidence, i) => ostore.record({
    kind: i % 2 ? 'gotcha' : 'decision', title: `Observed candidate ${i}`, body: 'Each candidate check is reported.',
    confidence, evidence: [i === 3 ? moving : steady]
  }));
  ostore.record({ kind: 'decision', title: 'Unrelated', body: 'Nothing about the query.', evidence: [steady] });
  fs.writeFileSync(moving, 'module.exports = { changed: true };\n');

  const performed = [];
  const checkEvidence = ostore.checkEvidence.bind(ostore);
  ostore.checkEvidence = (factId, scope) => {
    const status = checkEvidence(factId, scope);
    performed.push({ id: factId, status });
    return status;
  };
  const run = opts => {
    performed.length = 0;
    const hits = ostore.search('observed candidate', { limit: 2, ...opts });
    return { hits, performed: [...performed] };
  };
  const plain = run({});
  const observed = [];
  const watched = run({ onEvidence: (factId, status) => observed.push({ id: factId, status }) });
  const ranked = result => result.hits.map(hit => [hit.id, hit.trust]);

  check('the search checks three times its limit and returns its limit', plain.performed.length === 6 && plain.hits.length === 2,
    JSON.stringify({ checked: plain.performed.length, returned: plain.hits.length }));
  check('the observer gets every check the search performs, once, in order, with its own status',
    observed.length === watched.performed.length && observed.every((seen, i) => seen.id === watched.performed[i].id
      && seen.status === watched.performed[i].status), JSON.stringify(observed.map(seen => seen.id)));
  check('including the candidates ranking and the limit dropped', observed.filter(seen => !watched.hits.some(hit => hit.id === seen.id)).length === 4,
    JSON.stringify({ observed: observed.map(seen => seen.id), returned: watched.hits.map(hit => hit.id) }));
  check('a returned hit carries the very status the observer saw', watched.hits.every(hit => observed.find(seen => seen.id === hit.id)?.status === hit.evidence_status));
  check('the changed candidate is seen changed although it ranks out', observed.find(seen => seen.id === ids[3])?.status.changed === 1
    && !watched.hits.some(hit => hit.id === ids[3]), JSON.stringify(observed.find(seen => seen.id === ids[3])));
  check('observing adds no checks and changes no result or ranking', watched.performed.length === plain.performed.length
    && JSON.stringify(watched.hits) === JSON.stringify(plain.hits), JSON.stringify({ plain: ranked(plain), watched: ranked(watched) }));
  let thrown = null;
  try {
    ostore.search('observed candidate', { limit: 2, onEvidence: () => { throw new Error('observer failed'); } });
  } catch (error) { thrown = error; }
  check('an observer error propagates rather than yielding partial results', thrown && thrown.message === 'observer failed', thrown && thrown.message);
  odb.close();
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
