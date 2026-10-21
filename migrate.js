// caipira/migrate.js — versioned schema migrations.
//
// Two migration sets, because master.db and per-workspace dbs hold different
// things: master maps workspaces to files, a workspace holds its own memory.
// Every migration is idempotent and runs inside a transaction, so a partially
// applied upgrade rolls back rather than leaving a half-built schema behind.

// ── shared ──

/** @typedef {{version: number, up: (db: import('better-sqlite3').Database) => void}} Migration */

/** @param {import('better-sqlite3').Database} db @returns {number} */
function currentVersion(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row && row.v !== null ? row.v : 0;
}

/** @param {import('better-sqlite3').Database} db @param {Migration[]} migrations @returns {{from: number, to: number, applied: number[]}} */
function migrate(db, migrations) {
  const from = currentVersion(db);
  const pending = migrations.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  for (const step of pending) {
    const run = db.transaction(() => {
      step.up(db);
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(step.version);
    });
    run();
  }
  return { from, to: currentVersion(db), applied: pending.map(m => m.version) };
}

// ── master.db ──

const MASTER_MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT,
          canonical_key TEXT NOT NULL,
          db_file TEXT NOT NULL,
          machine TEXT NOT NULL,
          label TEXT,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          UNIQUE(canonical_key, machine)
        );

        CREATE TABLE IF NOT EXISTS workspace_links (
          from_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          to_id   INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          kind    TEXT NOT NULL DEFAULT 'related',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (from_id, to_id, kind)
        );

        CREATE INDEX IF NOT EXISTS ws_machine ON workspaces(machine, last_seen_at DESC);
      `);
    }
  }
];

// ── per-workspace db ──
//
// v1 mirrors the original store.js schema exactly, so an existing data.db
// already sitting at version 1 is left untouched and adopted as-is.

const WORKSPACE_MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          ide TEXT NOT NULL DEFAULT 'codewhale',
          cwd TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          compressed INTEGER NOT NULL DEFAULT 1,
          intensity TEXT,
          ts INTEGER NOT NULL,
          metadata TEXT
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          content,
          content='observations',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TABLE IF NOT EXISTS embeddings (
          observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          dim INTEGER NOT NULL,
          vec BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          scope TEXT NOT NULL CHECK(scope IN ('turn','session')),
          content TEXT NOT NULL,
          compressed INTEGER NOT NULL DEFAULT 1,
          intensity TEXT,
          ts INTEGER NOT NULL
        );

        CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
    }
  },

  // v2 — the knowledge layer.
  //
  // Observations are an append-only log of what happened. Facts are what is
  // currently true: revisable, supersedable, and carrying enough provenance to
  // be trusted without re-deriving them. Different lifecycles, different tables.
  //
  // fact.body is stored VERBATIM. Observations may be compressed because they
  // are lossy recall aids; a decision is a canonical record, and 'configuration'
  // -> 'cfg' is acceptable in an index and wrong in the thing you act on later.
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          scope TEXT,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          summary TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'active'
            CHECK(state IN ('active','needs_review','superseded','revoked','proposed')),
          supersedes INTEGER REFERENCES facts(id) ON DELETE SET NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          ttl_days INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_checked_at INTEGER,
          last_verified_at INTEGER,
          created_by TEXT,
          updated_by TEXT,
          machine TEXT,
          source_session_id TEXT
        );

        -- Fingerprints of the files a fact was derived from. Matching
        -- fingerprints mean the fact can be trusted without opening the file;
        -- a moved fingerprint is the signal saying which file to re-read.
        CREATE TABLE IF NOT EXISTS fact_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fact_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          sha256 TEXT,
          size INTEGER,
          mtime INTEGER,
          machine TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          UNIQUE(fact_id, path, machine)
        );

        CREATE TABLE IF NOT EXISTS fact_embeddings (
          fact_id INTEGER PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          dim INTEGER NOT NULL,
          vec BLOB NOT NULL
        );

        CREATE INDEX IF NOT EXISTS facts_state ON facts(state, updated_at DESC);
        CREATE INDEX IF NOT EXISTS facts_kind ON facts(kind, state);
        CREATE INDEX IF NOT EXISTS evidence_fact ON fact_evidence(fact_id);
        CREATE INDEX IF NOT EXISTS evidence_path ON fact_evidence(path, machine);

        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          title, summary, body,
          content='facts',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, title, summary, body)
          VALUES (new.id, new.title, new.summary, new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, title, summary, body)
          VALUES('delete', old.id, old.title, old.summary, old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, title, summary, body)
          VALUES('delete', old.id, old.title, old.summary, old.body);
          INSERT INTO facts_fts(rowid, title, summary, body)
          VALUES (new.id, new.title, new.summary, new.body);
        END;
      `);
    }
  },

  // v3 — the code layer.
  //
  // rust/caipira-ast keeps ast_files, ast_symbols and ast_edges in step with
  // the workspace's source files, and creates these same tables itself when it
  // meets a database first, so this DDL and SCHEMA in
  // rust/caipira-ast/src/store.rs must stay identical (test-ast compares them).
  // ast_symbols_fts uses the trigram tokenizer: identifiers like
  // addObservation are one token to unicode61, and symbol search needs
  // substrings.
  //
  // fact_symbol_evidence sits beside fact_evidence: a fact anchored to a
  // symbol's signature_hash survives edits elsewhere in the same file, where a
  // whole-file sha256 would flag it. Its paths are workspace-relative, so
  // unlike fact_evidence it needs no machine column.
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ast_files (
          path TEXT PRIMARY KEY,
          language TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          content_sha256 TEXT NOT NULL,
          indexed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ast_symbols (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          is_public INTEGER NOT NULL DEFAULT 0,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          params_json TEXT NOT NULL DEFAULT '[]',
          return_type TEXT,
          doc_summary TEXT,
          signature_text TEXT NOT NULL,
          signature_hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ast_symbols_path ON ast_symbols(path);
        CREATE INDEX IF NOT EXISTS ast_symbols_name ON ast_symbols(name);
        CREATE INDEX IF NOT EXISTS ast_symbols_qualified ON ast_symbols(qualified_name);
        CREATE INDEX IF NOT EXISTS ast_symbols_kind ON ast_symbols(kind);

        CREATE TABLE IF NOT EXISTS ast_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_path TEXT NOT NULL,
          source_symbol TEXT,
          target_path TEXT,
          target_symbol TEXT NOT NULL,
          edge_kind TEXT NOT NULL,
          line INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ast_edges_source ON ast_edges(source_path, source_symbol);
        CREATE INDEX IF NOT EXISTS ast_edges_target ON ast_edges(target_symbol);
        CREATE INDEX IF NOT EXISTS ast_edges_target_path ON ast_edges(target_path);
        CREATE INDEX IF NOT EXISTS ast_edges_kind ON ast_edges(edge_kind);

        CREATE VIRTUAL TABLE IF NOT EXISTS ast_symbols_fts USING fts5(
          name, qualified_name, signature_text, doc_summary, path,
          content='ast_symbols',
          content_rowid='id',
          tokenize='trigram'
        );

        CREATE TRIGGER IF NOT EXISTS ast_symbols_ai AFTER INSERT ON ast_symbols BEGIN
          INSERT INTO ast_symbols_fts(rowid, name, qualified_name, signature_text, doc_summary, path)
          VALUES (new.id, new.name, new.qualified_name, new.signature_text, new.doc_summary, new.path);
        END;
        CREATE TRIGGER IF NOT EXISTS ast_symbols_ad AFTER DELETE ON ast_symbols BEGIN
          INSERT INTO ast_symbols_fts(ast_symbols_fts, rowid, name, qualified_name, signature_text, doc_summary, path)
          VALUES ('delete', old.id, old.name, old.qualified_name, old.signature_text, old.doc_summary, old.path);
        END;
        CREATE TRIGGER IF NOT EXISTS ast_symbols_au AFTER UPDATE ON ast_symbols BEGIN
          INSERT INTO ast_symbols_fts(ast_symbols_fts, rowid, name, qualified_name, signature_text, doc_summary, path)
          VALUES ('delete', old.id, old.name, old.qualified_name, old.signature_text, old.doc_summary, old.path);
          INSERT INTO ast_symbols_fts(rowid, name, qualified_name, signature_text, doc_summary, path)
          VALUES (new.id, new.name, new.qualified_name, new.signature_text, new.doc_summary, new.path);
        END;

        CREATE TABLE IF NOT EXISTS fact_symbol_evidence (
          fact_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          signature_hash TEXT NOT NULL,
          PRIMARY KEY (fact_id, path, qualified_name)
        );
        CREATE INDEX IF NOT EXISTS symbol_evidence_symbol ON fact_symbol_evidence(path, qualified_name);
      `);
    }
  },
  //
  // ast_links keeps each file's unresolved imports and references, and
  // ast_link_probes the paths resolving them checked, so caipira-ast can
  // re-link an unchanged importer when one of those paths enters or leaves
  // the index without reading it. Files indexed before v4 have no link
  // state, so their stat gate is cleared and the next sync re-parses them.
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ast_links (
          path TEXT PRIMARY KEY,
          state_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ast_link_probes (
          source_path TEXT NOT NULL,
          probe_path TEXT NOT NULL,
          PRIMARY KEY (source_path, probe_path)
        );
        CREATE INDEX IF NOT EXISTS ast_link_probes_probe ON ast_link_probes(probe_path);

        UPDATE ast_files SET size = -1, content_sha256 = '';
      `);
    }
  }
];

// ── every database under a Caipira directory ──

/**
 * Upgrades master.db, every registered workspace database that exists, and
 * the legacy data.db in place. Each file migrates in its own transactions,
 * so one unreadable database is reported without blocking the rest; files
 * that are not there are skipped, never created.
 * @param {{caipiraDir?: string}} [opts] Defaults to CAIPIRA_HOME, else ~/.caipira.
 * @returns {{master: object|null, workspaces: object[], failed: {dbFile: string, error: string}[]}}
 *   `master` and each workspace entry are `{dbFile, from, to, applied}`.
 */
function migrateAll(opts = {}) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const Database = require('better-sqlite3');

  const caipiraDir = path.resolve(opts.caipiraDir || process.env.CAIPIRA_HOME || path.join(os.homedir(), '.caipira'));
  const masterFile = path.join(caipiraDir, 'database', 'master.db');
  const legacyFile = path.join(caipiraDir, 'data.db');
  const report = { master: null, workspaces: [], failed: [] };

  const upgrade = (dbFile, migrations, read) => {
    const db = new Database(dbFile, { fileMustExist: true });
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      const result = { dbFile, ...migrate(db, migrations) };
      if (read) read(db);
      return result;
    } finally {
      db.close();
    }
  };

  const workspaceFiles = new Set();
  if (fs.existsSync(masterFile)) {
    try {
      report.master = upgrade(masterFile, MASTER_MIGRATIONS, db => {
        for (const row of db.prepare('SELECT db_file FROM workspaces').all()) workspaceFiles.add(row.db_file);
      });
    } catch (error) {
      report.failed.push({ dbFile: masterFile, error: error.message });
    }
  }
  if (fs.existsSync(legacyFile)) workspaceFiles.add(legacyFile);

  for (const dbFile of workspaceFiles) {
    if (!fs.existsSync(dbFile)) continue;
    try {
      report.workspaces.push(upgrade(dbFile, WORKSPACE_MIGRATIONS));
    } catch (error) {
      report.failed.push({ dbFile, error: error.message });
    }
  }
  return report;
}

module.exports = { migrate, migrateAll, currentVersion, MASTER_MIGRATIONS, WORKSPACE_MIGRATIONS };
