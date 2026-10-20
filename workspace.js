// caipira/workspace.js — workspace identity and per-workspace database routing.
//
// SQLite has no schemas, so each workspace gets its own .db file under
// ~/.caipira/database/, and master.db maps workspaces to those files.
// ATTACH links them when a query needs to span more than one (max 10 at once,
// so the steady state is master + current workspace).
//
// ensureWorkspace() is idempotent and cheap: SessionStart calls it to provision
// up front, and every write path calls it too, so a hook that never fired can
// never cost us an observation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { migrate, MASTER_MIGRATIONS, WORKSPACE_MIGRATIONS } = require('./migrate');

// CAIPIRA_HOME redirects the whole store, so tests can run against a temp
// directory instead of writing stray workspace databases into the real one.
const ROOT = process.env.CAIPIRA_HOME
  ? path.resolve(process.env.CAIPIRA_HOME)
  : path.join(os.homedir(), '.caipira');
const DB_DIR = path.join(ROOT, 'database');
const MASTER_DB = path.join(DB_DIR, 'master.db');

// The pre-split database, kept in place and adopted rather than migrated, so
// nothing recorded before workspace routing existed is stranded.
const LEGACY_DB = path.join(ROOT, 'data.db');
const LEGACY_KEY = '__legacy_global__';

// Markers that identify a project root. A VCS or explicit workspace marker
// anywhere above outranks a nearer manifest, so a monorepo package does not
// split off into its own database.
const WORKSPACE_MARKER = '.caipira-workspace';
const VCS_MARKERS = [WORKSPACE_MARKER, '.git', '.hg'];
const MANIFEST_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'];

/**
 * @typedef {object} WorkspaceInfo
 * @property {number} id Registry row id in master.db.
 * @property {string|null} root Resolved project root (null for the legacy row).
 * @property {string} key Canonical key the workspace is registered under.
 * @property {string} dbFile Absolute path of the workspace database.
 * @property {string} machine Machine id the row belongs to.
 * @property {boolean} created True when this call registered the workspace.
 */

// ── identity ──

/** @returns {string} Lower-cased hostname identifying this machine. */
function machineId() {
  return os.hostname().toLowerCase();
}

// Windows paths are case-insensitive and reach the same directory through
// junctions and 8.3 short names; without canonicalising, one workspace would
// register several times and split its own memory.
/** @param {string} target @returns {string} */
function canonicalKey(target) {
  let resolved = path.resolve(target);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Path may not exist yet — fall back to the lexical form.
  }
  resolved = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function hasMarker(dir, markers) {
  return markers.some(marker => {
    try { return fs.existsSync(path.join(dir, marker)); } catch { return false; }
  });
}

// The start directory and its parents, stopping short of the home directory:
// a dotfiles repo or stray package.json there would otherwise swallow every
// project beneath it.
function ancestors(start) {
  const home = path.resolve(os.homedir());
  const chain = [];
  let dir = start;
  while (true) {
    const atHome = samePath(dir, home);
    if (atHome && chain.length > 0) break;
    chain.push(dir);
    if (atHome) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

// The workspace is the project root, not the cwd — otherwise every
// subdirectory the agent happens to sit in spawns its own database.
/**
 * @param {string} [startDir] Directory to resolve from; defaults to process.cwd().
 * @returns {string} The nearest .caipira-workspace, else the nearest .git/.hg
 *   root, else the nearest manifest directory, else startDir itself.
 */
function findRoot(startDir) {
  const start = path.resolve(startDir || process.cwd());
  const chain = ancestors(start);
  return chain.find(dir => hasMarker(dir, [WORKSPACE_MARKER]))
    || chain.find(dir => hasMarker(dir, VCS_MARKERS))
    || chain.find(dir => hasMarker(dir, MANIFEST_MARKERS))
    || start;
}

function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 40) || 'workspace';
}

// Slug for humans reading the directory, hash for uniqueness.
/** @param {string} key @param {string} [rootPath] @returns {string} */
function dbFileNameFor(key, rootPath) {
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${slugify(path.basename(rootPath || key))}-${digest}.db`;
}

// ── master registry ──

/** @returns {import('better-sqlite3').Database} Open, migrated master.db; the caller closes it. */
function openMaster() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(MASTER_DB);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db, MASTER_MIGRATIONS);
    adoptLegacy(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// Register the original ~/.caipira/data.db once, so its history stays
// reachable through the same registry as everything else. Checked before
// inserting: every openMaster() runs this, and even an ignored INSERT takes
// the write lock and burns an AUTOINCREMENT id.
function adoptLegacy(master) {
  if (!fs.existsSync(LEGACY_DB)) return;
  const adopted = master.prepare(
    'SELECT 1 FROM workspaces WHERE canonical_key = ? AND machine = ?'
  ).get(LEGACY_KEY, machineId());
  if (adopted) return;
  const now = Date.now();
  master.prepare(`
    INSERT OR IGNORE INTO workspaces
      (root_path, canonical_key, db_file, machine, label, created_at, last_seen_at)
    VALUES (NULL, ?, ?, ?, 'legacy (pre-workspace memory)', ?, ?)
  `).run(LEGACY_KEY, LEGACY_DB, machineId(), now, now);
}

/** @param {string} dbFile @returns {import('better-sqlite3').Database} Open, migrated workspace db; the caller closes it. */
function openWorkspaceDb(dbFile) {
  const db = new Database(dbFile);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db, WORKSPACE_MIGRATIONS);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// ── the entry point every caller uses ──

/**
 * @param {string} [cwd] Any directory inside the workspace.
 * @param {{master?: import('better-sqlite3').Database}} [opts] Reuse an open master.db.
 * @returns {WorkspaceInfo}
 */
function ensureWorkspace(cwd, opts = {}) {
  const master = opts.master || openMaster();
  const ownsMaster = !opts.master;
  try {
    const rootPath = findRoot(cwd);
    const key = canonicalKey(rootPath);
    const machine = machineId();

    let row = master.prepare(
      'SELECT * FROM workspaces WHERE canonical_key = ? AND machine = ?'
    ).get(key, machine);

    const now = Date.now();
    if (!row) {
      const dbFile = path.join(DB_DIR, dbFileNameFor(key, rootPath));
      master.prepare(`
        INSERT INTO workspaces
          (root_path, canonical_key, db_file, machine, label, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(rootPath, key, dbFile, machine, path.basename(rootPath), now, now);
      row = master.prepare(
        'SELECT * FROM workspaces WHERE canonical_key = ? AND machine = ?'
      ).get(key, machine);
    } else {
      master.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    }

    // Provision the file itself, not just the registry row: a registered
    // workspace with no database is exactly the gap that loses writes.
    fs.mkdirSync(path.dirname(row.db_file), { recursive: true });
    openWorkspaceDb(row.db_file).close();

    return {
      id: row.id,
      root: row.root_path,
      key: row.canonical_key,
      dbFile: row.db_file,
      machine: row.machine,
      created: row.created_at === now
    };
  } finally {
    if (ownsMaster) master.close();
  }
}

/** @returns {object[]} Every registry row, most recently seen first. */
function listWorkspaces() {
  const master = openMaster();
  try {
    return master.prepare('SELECT * FROM workspaces ORDER BY last_seen_at DESC').all();
  } finally {
    master.close();
  }
}

module.exports = {
  ROOT, DB_DIR, MASTER_DB, LEGACY_DB, LEGACY_KEY,
  machineId, canonicalKey, findRoot, dbFileNameFor,
  openMaster, openWorkspaceDb, ensureWorkspace, listWorkspaces
};
