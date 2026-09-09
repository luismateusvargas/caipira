process.chdir('C:/Users/luism/.caipira');
const fs = require('fs'), os = require('os'), path = require('path');
const ws = require('C:/Users/luism/.caipira/workspace.js');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? ' -> ' + extra : '')); }
};

console.log('\n1. workspace root resolution');
const caipira = 'C:\\Users\\luism\\.caipira';
check('.caipira resolves to itself (has package.json)', ws.findRoot(caipira).toLowerCase() === caipira.toLowerCase(), ws.findRoot(caipira));
check('subdir walks up to root', ws.findRoot(path.join(caipira, 'hooks')).toLowerCase() === caipira.toLowerCase(), ws.findRoot(path.join(caipira, 'hooks')));

console.log('\n2. canonicalisation (the Windows traps)');
const a = ws.canonicalKey('C:\\Users\\luism\\.caipira');
const b = ws.canonicalKey('C:/Users/LUISM/.CAIPIRA/');
const c = ws.canonicalKey('C:\\Users\\luism\\.caipira\\hooks\\..');
check('case-insensitive + trailing sep collapse', a === b, a + ' vs ' + b);
check('.. normalised', a === c, a + ' vs ' + c);

// Adoption happens inside the first ensureWorkspace, and an isolated
// CAIPIRA_HOME has no pre-split database, so sections 5 and 7 get one here:
// a data.db holding a real observation, exactly as the real one did.
if (!fs.existsSync(ws.LEGACY_DB)) {
  fs.mkdirSync(path.dirname(ws.LEGACY_DB), { recursive: true });
  const { MemoryStore } = require('C:/Users/luism/.caipira/store.js');
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
const D = require('C:/Users/luism/.caipira/node_modules/better-sqlite3');
const { migrate, WORKSPACE_MIGRATIONS } = require('C:/Users/luism/.caipira/migrate.js');
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
check('legacy db reaches current version', require('C:/Users/luism/.caipira/migrate.js').currentVersion(legacyDb) === 2, JSON.stringify(r3));
check('observations preserved (' + before + ')', before === after && before > 0);
legacyDb.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
