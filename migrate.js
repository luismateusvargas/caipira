// caipira/migrate.js — versioned schema migrations.
//
// Two migration sets, because master.db and per-workspace dbs hold different
// things: master maps workspaces to files, a workspace holds its own memory.
// Every migration is idempotent and runs inside a transaction, so a partially
// applied upgrade rolls back rather than leaving a half-built schema behind.

// ── shared ──

function currentVersion(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row && row.v !== null ? row.v : 0;
}

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
  }
];

module.exports = { migrate, currentVersion, MASTER_MIGRATIONS, WORKSPACE_MIGRATIONS };
