require('./fixtures').ensureIsolatedHome();
process.chdir(require('path').join(__dirname, '..'));
const fs = require('fs'), os = require('os'), path = require('path');
const ws = require('../workspace.js');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? ' -> ' + extra : '')); }
};

console.log('\n1. workspace root resolution');
const caipira = path.join(__dirname, '..');
check('.caipira resolves to itself (has package.json)', ws.findRoot(caipira).toLowerCase() === caipira.toLowerCase(), ws.findRoot(caipira));
check('subdir walks up to root', ws.findRoot(path.join(caipira, 'hooks')).toLowerCase() === caipira.toLowerCase(), ws.findRoot(path.join(caipira, 'hooks')));

console.log('\n2. canonicalisation (the Windows traps)');
const a = ws.canonicalKey(caipira);
const b = ws.canonicalKey(process.platform === 'win32' ? caipira.toUpperCase() + path.sep : caipira + path.sep);
const c = ws.canonicalKey(path.join(caipira, 'hooks') + path.sep + '..');
check(process.platform === 'win32' ? 'case-insensitive + trailing sep collapse' : 'trailing sep collapse', a === b, a + ' vs ' + b);
check('.. normalised', a === c, a + ' vs ' + c);

// Adoption happens inside the first ensureWorkspace, and an isolated
// CAIPIRA_HOME has no pre-split database, so sections 5 and 7 get one here:
// a data.db holding a real observation, exactly as the real one did.
if (!fs.existsSync(ws.LEGACY_DB)) {
  fs.mkdirSync(path.dirname(ws.LEGACY_DB), { recursive: true });
  const { MemoryStore } = require('../store.js');
  const seed = new MemoryStore({ dbPath: ws.LEGACY_DB });
  seed.startSession({ id: 'legacy-seed', ide: 'test', cwd: caipira });
  seed.addObservation({ session_id: 'legacy-seed', kind: 'note', content: 'pre-split observation' });
  seed.close();
}

console.log('\n3. provisioning is idempotent');
const first = ws.ensureWorkspace(caipira);
const second = ws.ensureWorkspace(path.join(caipira, 'hooks'));
check('same id from root and subdir', first.id === second.id, first.id + ' vs ' + second.id);
check('db file created on disk', fs.existsSync(first.dbFile), first.dbFile);
check('db file lives under database/', first.dbFile.includes('database'), first.dbFile);

console.log('\n4. a different workspace gets a different db');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
const other = ws.ensureWorkspace(tmp);
check('distinct workspace id', other.id !== first.id);
check('distinct db file', other.dbFile !== first.dbFile, other.dbFile);

console.log('\n5. legacy data.db adopted, not orphaned');
const all = ws.listWorkspaces();
const legacy = all.find(w => w.canonical_key === ws.LEGACY_KEY);
check('legacy row present', Boolean(legacy));
check('legacy points at original data.db', legacy && legacy.db_file === ws.LEGACY_DB, legacy && legacy.db_file);

console.log('\n6. migrations are versioned and repeatable');
const D = require('better-sqlite3');
const { migrate, WORKSPACE_MIGRATIONS } = require('../migrate.js');
const fresh = path.join(tmp, 'fresh.db');
const db1 = new D(fresh);
const r1 = migrate(db1, WORKSPACE_MIGRATIONS);
const r2 = migrate(db1, WORKSPACE_MIGRATIONS);
check('fresh db applies every migration', r1.applied.join(',') === '1,2', JSON.stringify(r1));
check('second run is a no-op', r2.applied.length === 0, JSON.stringify(r2));
db1.close();

console.log('\n7. existing data.db already at v1 is adopted untouched');
const legacyDb = new D(ws.LEGACY_DB);
const before = legacyDb.prepare('SELECT COUNT(*) n FROM observations').get().n;
const r3 = migrate(legacyDb, WORKSPACE_MIGRATIONS);
const after = legacyDb.prepare('SELECT COUNT(*) n FROM observations').get().n;
check('legacy db reaches current version', require('../migrate.js').currentVersion(legacyDb) === 2, JSON.stringify(r3));
check('observations preserved (' + before + ')', before === after && before > 0);
legacyDb.close();

console.log('\n8. monorepo packages resolve to the repository root');
const mono = path.join(tmp, 'mono');
fs.mkdirSync(path.join(mono, '.git'), { recursive: true });
fs.writeFileSync(path.join(mono, 'package.json'), '{}');
fs.mkdirSync(path.join(mono, 'packages', 'app', 'src'), { recursive: true });
fs.writeFileSync(path.join(mono, 'packages', 'app', 'package.json'), '{}');
fs.mkdirSync(path.join(mono, 'crates', 'core'), { recursive: true });
fs.writeFileSync(path.join(mono, 'crates', 'core', 'Cargo.toml'), '');
check('nested package.json -> .git root', ws.findRoot(path.join(mono, 'packages', 'app', 'src')) === mono,
  ws.findRoot(path.join(mono, 'packages', 'app', 'src')));
check('nested Cargo.toml -> .git root', ws.findRoot(path.join(mono, 'crates', 'core')) === mono,
  ws.findRoot(path.join(mono, 'crates', 'core')));

const hgRepo = path.join(tmp, 'hgrepo');
fs.mkdirSync(path.join(hgRepo, '.hg'), { recursive: true });
fs.mkdirSync(path.join(hgRepo, 'lib'), { recursive: true });
fs.writeFileSync(path.join(hgRepo, 'lib', 'pyproject.toml'), '');
check('nested pyproject.toml -> .hg root', ws.findRoot(path.join(hgRepo, 'lib')) === hgRepo, ws.findRoot(path.join(hgRepo, 'lib')));

// An explicit marker groups several repositories into one workspace.
const grouped = path.join(tmp, 'grouped');
fs.mkdirSync(path.join(grouped, 'svc', '.git'), { recursive: true });
fs.writeFileSync(path.join(grouped, '.caipira-workspace'), '');
check('.caipira-workspace outranks a nested .git', ws.findRoot(path.join(grouped, 'svc')) === grouped, ws.findRoot(path.join(grouped, 'svc')));

const standalone = path.join(tmp, 'standalone');
fs.mkdirSync(path.join(standalone, 'src'), { recursive: true });
fs.writeFileSync(path.join(standalone, 'package.json'), '{}');
check('standalone package.json still resolves to itself', ws.findRoot(path.join(standalone, 'src')) === standalone,
  ws.findRoot(path.join(standalone, 'src')));

// A dotfiles repo in the home directory must not swallow every project.
const fakeHome = path.join(tmp, 'home');
fs.mkdirSync(path.join(fakeHome, '.git'), { recursive: true });
fs.mkdirSync(path.join(fakeHome, 'proj', 'src'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, 'proj', 'package.json'), '{}');
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = process.env.USERPROFILE = fakeHome;
try {
  check('home-directory markers are ignored', ws.findRoot(path.join(fakeHome, 'proj', 'src')) === path.join(fakeHome, 'proj'),
    ws.findRoot(path.join(fakeHome, 'proj', 'src')));
  check('home itself still resolves when started there', ws.findRoot(fakeHome) === fakeHome, ws.findRoot(fakeHome));
} finally {
  for (const [name, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

console.log('\n9. reopening the registry never writes the legacy row again');
const sequence = () => {
  const master = ws.openMaster();
  try { return master.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'workspaces'").get().seq; }
  finally { master.close(); }
};
const seqBefore = sequence();
const issued = [];
const realPrepare = D.prototype.prepare;
D.prototype.prepare = function (sql) { issued.push(sql); return realPrepare.call(this, sql); };
try {
  for (let i = 0; i < 3; i++) {
    ws.openMaster().close();
    ws.listWorkspaces();
    ws.ensureWorkspace(caipira);
  }
} finally {
  D.prototype.prepare = realPrepare;
}
check('no INSERT issued against master.db', !issued.some(sql => /INSERT/i.test(sql)),
  issued.filter(sql => /INSERT/i.test(sql)).map(sql => sql.trim().split('\n')[0]).join(' | '));
check('sqlite_sequence unchanged', sequence() === seqBefore, seqBefore + ' -> ' + sequence());

console.log('\n10. Storage schema comes from migrate.js');
const { Storage, MemoryStore } = require('../store.js');
const storeFile = path.join(tmp, 'store.db');
const storage = new Storage(storeFile);
check('fresh Storage reaches schema version 2', require('../migrate.js').currentVersion(storage.db) === 2);
check('facts table provisioned', Boolean(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'facts'").get()));

console.log('\n11. embeddings survive unaligned blob buffers');
storage.createSession({ id: 'emb', ide: 'test' });
const obsId = storage.insertObservation({ session_id: 'emb', kind: 'note', content: 'vector probe', compressed: true });
storage.putEmbedding(obsId, 'probe', new Float32Array([0.25, -0.5, 1]));
// Node may hand back a pooled Buffer at any byte offset; force the bad case.
const storagePrepare = storage.db.prepare.bind(storage.db);
storage.db.prepare = sql => {
  const stmt = storagePrepare(sql);
  if (!/FROM embeddings WHERE observation_id/.test(sql)) return stmt;
  return {
    get: (...args) => {
      const row = stmt.get(...args);
      const padded = Buffer.alloc(row.vec.length + 1);
      row.vec.copy(padded, 1);
      return { ...row, vec: padded.subarray(1) };
    }
  };
};
let embedding = null, embeddingError = null;
try { embedding = storage.getEmbedding(obsId); } catch (error) { embeddingError = error; }
delete storage.db.prepare;
check('getEmbedding tolerates byteOffset % 4 !== 0', embedding && Array.from(embedding.vec).join(',') === '0.25,-0.5,1',
  embeddingError ? embeddingError.message : JSON.stringify(embedding));
storage.close();

console.log('\n12. sessions, privacy, and single-hit search');
const memory = new MemoryStore({ dbPath: path.join(tmp, 'memory.db') });
memory.ensureSession('late-start');
memory.startSession({ id: 'late-start', ide: 'claude-code', cwd: '/work/repo' });
memory.startSession({ id: 'late-start', ide: 'codex', cwd: '/elsewhere' });
memory.ensureSession('late-start');
const session = memory.listSessions(10).find(s => s.id === 'late-start');
check('startSession upgrades an ensured session', session.ide === 'claude-code' && session.cwd === '/work/repo', JSON.stringify(session));

let privacyError = null;
try {
  check('non-string content is skipped', memory.addObservation({ session_id: 'late-start', kind: 'note', content: undefined }) === -1);
  memory.addSummary({ session_id: 'late-start', scope: 'session', content: '<private>secret</private>' });
} catch (error) { privacyError = error; }
check('private-only summary stores nothing', !privacyError && memory.listSummaries('late-start').length === 0,
  privacyError ? privacyError.message : memory.listSummaries('late-start').length);

const activeFile = path.join(__dirname, '..', 'active');
let activeMode = 'full';
try { activeMode = fs.readFileSync(activeFile, 'utf8').trim(); } catch {}
if (!['lite', 'full', 'ultra'].includes(activeMode)) activeMode = 'full';
const onlyId = memory.addObservation({ session_id: 'late-start', kind: 'note', content: 'the migration rewrote the sqlite registry' });
check('observations use the active compression mode (' + activeMode + ')', memory.getObservations([onlyId])[0].intensity === activeMode,
  memory.getObservations([onlyId])[0].intensity);

const vec = new Float32Array([1, 0, 0]);
memory.putEmbedding(onlyId, 'probe', vec);
const embedder = { model: 'probe', dim: 3, embed: async () => vec };

(async () => {
  let hits = [], searchError = null;
  try { hits = await memory.search('registry', 5, embedder); } catch (error) { searchError = error; }
  check('a single hybrid hit scores above zero', hits.length === 1 && hits[0].score > 0,
    searchError ? searchError.message : JSON.stringify(hits));
  memory.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
