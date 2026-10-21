//! SQLite persistence and the three-tier incremental sync.
//!
//! Tier 1 compares each walked file's `(size, mtime_ms)` with `ast_files`
//! and touches nothing else when both match. Tier 2 hashes a file whose
//! mtime moved at the same size and, when the hash still matches, updates
//! only `mtime_ms`. Tier 3 parses new and changed files in parallel and
//! replaces their rows, together with pruning deleted files, in one
//! transaction. `ast_symbols_fts` follows `ast_symbols` through triggers.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rayon::prelude::*;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::diff::{AstDiffReport, compare_snapshots};
use crate::error::AstError;
use crate::parser::{AstSnapshot, Language, ParamSignature, SymbolSignature, parse_source};
use crate::resolve::Resolver;
use crate::walker::{MAX_FILE_BYTES, WalkedFile, mtime_ms, walk_workspace};

/// The `ast_*` schema, identical to workspace migration v3 in `migrate.js`
/// so either side can create it first.
const SCHEMA: &str = r#"
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
"#;

/// Counts reported by [`index_workspace`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct IndexStats {
    /// Files parsed with tree-sitter (Tier 3).
    pub parsed: usize,
    /// Files whose `(size, mtime_ms)` matched (Tier 1): not read at all.
    pub skipped: usize,
    /// Files whose mtime moved but whose hash matched (Tier 2).
    pub hash_matched: usize,
    /// Files no longer on disk whose rows were pruned.
    pub removed: usize,
    /// Files that could not be read or parsed; their old rows are kept.
    pub failed: usize,
    /// `ast_symbols` rows after the sync.
    pub symbols_total: i64,
    /// `ast_edges` rows after the sync.
    pub edges_total: i64,
    /// Wall-clock duration of the sync.
    pub duration_ms: u64,
    /// One entry per failed file.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failures: Vec<FileFailure>,
}

/// A file the sync could not read or parse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileFailure {
    pub path: String,
    pub message: String,
}

/// What [`update_single_file`] did to the file's rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateStatus {
    /// First time the file was indexed.
    Added,
    /// The file was re-parsed and its rows replaced.
    Updated,
    /// Stat or hash matched; nothing was parsed.
    Unchanged,
    /// The file is gone and its rows were deleted.
    Removed,
}

/// The result of re-indexing one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileUpdate {
    pub status: UpdateStatus,
    pub path: String,
    pub diff: AstDiffReport,
    pub duration_ms: u64,
}

struct FileState {
    size: i64,
    mtime_ms: i64,
    sha256: String,
}

struct ParsedFile {
    snapshot: AstSnapshot,
    size: i64,
    mtime_ms: i64,
    sha256: String,
}

enum Outcome {
    HashMatched { path: String, mtime_ms: i64 },
    Parsed(Box<ParsedFile>),
    Failed(FileFailure),
}

/// Opens a workspace database and makes sure the `ast_*` tables exist.
///
/// # Arguments
/// `db_path`: the `<workspace>.db` file; created if missing.
///
/// # Errors
/// `AstError::Database` when SQLite cannot open the file or create the schema.
pub fn open_database(db_path: &Path) -> Result<Connection, AstError> {
    let conn = Connection::open(db_path)
        .map_err(|e| AstError::database("opening the workspace database", e))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| AstError::database("setting busy_timeout", e))?;
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
        .map_err(|e| AstError::database("enabling WAL", e))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| AstError::database("creating the ast tables", e))?;
    Ok(conn)
}

/// Brings the database in line with every supported file under `root`.
///
/// # Arguments
/// `conn`: an open workspace database (see [`open_database`]).
/// `root`: the workspace root directory.
///
/// # Errors
/// `AstError::InvalidArgument` for a missing root; `AstError::Database`
/// when reading state or committing the transaction fails. Unreadable or
/// unparsable files are reported in [`IndexStats::failures`] instead.
pub fn index_workspace(conn: &mut Connection, root: &Path) -> Result<IndexStats, AstError> {
    let started = Instant::now();
    let walked = walk_workspace(root)?;
    let known = load_file_states(conn)?;
    let resolver = Resolver::new(root);

    let mut stats = IndexStats::default();
    let mut work: Vec<(&WalkedFile, Option<&str>)> = Vec::new();
    for file in &walked {
        let size = to_i64(file.size);
        match known.get(&file.rel_path) {
            Some(state) if state.size == size && state.mtime_ms == file.mtime_ms => {
                stats.skipped += 1
            }
            Some(state) if state.size == size => work.push((file, Some(state.sha256.as_str()))),
            _ => work.push((file, None)),
        }
    }
    let outcomes: Vec<Outcome> = work
        .par_iter()
        .map(|(file, known_sha)| process(root, &resolver, file, *known_sha))
        .collect();

    let on_disk: HashSet<&str> = walked.iter().map(|f| f.rel_path.as_str()).collect();
    let mut removed: Vec<&String> = known
        .keys()
        .filter(|path| !on_disk.contains(path.as_str()))
        .collect();
    removed.sort();

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| AstError::database("starting the index transaction", e))?;
    let indexed_at = now_ms();
    for outcome in outcomes {
        match outcome {
            Outcome::HashMatched { path, mtime_ms } => {
                touch_mtime(&tx, &path, mtime_ms)?;
                stats.hash_matched += 1;
            }
            Outcome::Parsed(parsed) => {
                write_file(&tx, &parsed, indexed_at)?;
                stats.parsed += 1;
            }
            Outcome::Failed(failure) => {
                stats.failed += 1;
                stats.failures.push(failure);
            }
        }
    }
    for path in &removed {
        delete_file(&tx, path)?;
    }
    tx.commit()
        .map_err(|e| AstError::database("committing the index transaction", e))?;

    stats.removed = removed.len();
    stats.symbols_total = count(conn, "ast_symbols")?;
    stats.edges_total = count(conn, "ast_edges")?;
    stats.duration_ms = elapsed_ms(started);
    Ok(stats)
}

fn process(
    root: &Path,
    resolver: &Resolver,
    file: &WalkedFile,
    known_sha: Option<&str>,
) -> Outcome {
    let fail = |message: String| {
        Outcome::Failed(FileFailure {
            path: file.rel_path.clone(),
            message,
        })
    };
    let bytes = match fs::read(root.join(&file.rel_path)) {
        Ok(bytes) => bytes,
        Err(e) => return fail(e.to_string()),
    };
    let sha256 = sha256_hex(&bytes);
    if known_sha == Some(sha256.as_str()) {
        return Outcome::HashMatched {
            path: file.rel_path.clone(),
            mtime_ms: file.mtime_ms,
        };
    }
    match parse_source(&file.rel_path, &bytes, resolver) {
        Ok(snapshot) => Outcome::Parsed(Box::new(ParsedFile {
            snapshot,
            size: to_i64(bytes.len() as u64),
            mtime_ms: file.mtime_ms,
            sha256,
        })),
        Err(e) => fail(e.to_string()),
    }
}

/// Re-indexes one file through the same gates and reports its symbol diff.
///
/// Does not consult ignore rules: a later [`index_workspace`] prunes a file
/// the walker would not have visited.
///
/// # Arguments
/// `conn`: an open workspace database.
/// `root`: the workspace root.
/// `rel_path`: the file, relative to `root` (see [`crate::workspace_relative`]).
///
/// # Errors
/// `AstError::Unsupported` for an unknown extension; `AstError::Io` when the
/// file cannot be read, or is missing and was never indexed;
/// `AstError::Parse` and `AstError::Database` as for a full index.
pub fn update_single_file(
    conn: &mut Connection,
    root: &Path,
    rel_path: &str,
) -> Result<FileUpdate, AstError> {
    let started = Instant::now();
    if Language::from_path(rel_path).is_none() {
        return Err(AstError::Unsupported(rel_path.to_string()));
    }
    let before = load_symbols(conn, rel_path)?;
    let state = load_file_state(conn, rel_path)?;
    let absolute = root.join(rel_path);
    let result = |status, diff| FileUpdate {
        status,
        path: rel_path.to_string(),
        diff,
        duration_ms: elapsed_ms(started),
    };

    // Symlinks and oversized files are not indexed, matching the walker.
    let metadata = match fs::symlink_metadata(&absolute) {
        Ok(m) if m.is_file() && m.len() <= MAX_FILE_BYTES => Some(m),
        Ok(_) => None,
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => return Err(AstError::io(&absolute, e)),
    };
    let Some(metadata) = metadata else {
        if state.is_none() {
            let missing = std::io::Error::new(ErrorKind::NotFound, "not on disk and not indexed");
            return Err(AstError::io(&absolute, missing));
        }
        let tx = immediate(conn)?;
        delete_file(&tx, rel_path)?;
        tx.commit()
            .map_err(|e| AstError::database("committing the file removal", e))?;
        return Ok(result(
            UpdateStatus::Removed,
            compare_snapshots(&before, &[]),
        ));
    };

    let size = to_i64(metadata.len());
    let mtime = mtime_ms(&metadata);
    if let Some(state) = &state
        && state.size == size
        && state.mtime_ms == mtime
    {
        return Ok(result(UpdateStatus::Unchanged, AstDiffReport::default()));
    }
    let bytes = fs::read(&absolute).map_err(|e| AstError::io(&absolute, e))?;
    let sha256 = sha256_hex(&bytes);
    if let Some(state) = &state
        && state.sha256 == sha256
    {
        let tx = immediate(conn)?;
        touch_mtime(&tx, rel_path, mtime)?;
        tx.commit()
            .map_err(|e| AstError::database("committing the mtime update", e))?;
        return Ok(result(UpdateStatus::Unchanged, AstDiffReport::default()));
    }

    let snapshot = parse_source(rel_path, &bytes, &Resolver::new(root))?;
    let diff = compare_snapshots(&before, &snapshot.symbols);
    let parsed = ParsedFile {
        snapshot,
        size: to_i64(bytes.len() as u64),
        mtime_ms: mtime,
        sha256,
    };
    let tx = immediate(conn)?;
    write_file(&tx, &parsed, now_ms())?;
    tx.commit()
        .map_err(|e| AstError::database("committing the file update", e))?;
    let status = if state.is_some() {
        UpdateStatus::Updated
    } else {
        UpdateStatus::Added
    };
    Ok(result(status, diff))
}

/// The symbols stored for one file, in source order.
///
/// # Arguments
/// `conn`: an open workspace database. `path`: the workspace-relative file.
///
/// # Errors
/// `AstError::Database` when the query fails.
pub fn load_symbols(conn: &Connection, path: &str) -> Result<Vec<SymbolSignature>, AstError> {
    let context = "reading ast_symbols";
    let mut statement = conn
        .prepare_cached(
            "SELECT name, qualified_name, kind, is_public, start_line, end_line, params_json,
                    return_type, doc_summary, signature_text, signature_hash
             FROM ast_symbols WHERE path = ?1 ORDER BY id",
        )
        .map_err(|e| AstError::database(context, e))?;
    let rows = statement
        .query_map([path], |row| {
            let params_json: String = row.get(6)?;
            // A corrupt params column degrades to "no parameters" rather than
            // failing the whole diff.
            let params: Vec<ParamSignature> =
                serde_json::from_str(&params_json).unwrap_or_default();
            Ok(SymbolSignature {
                name: row.get(0)?,
                qualified_name: row.get(1)?,
                kind: row.get(2)?,
                is_public: row.get::<_, i64>(3)? != 0,
                start_line: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                end_line: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                params,
                return_type: row.get(7)?,
                doc_summary: row.get(8)?,
                signature_text: row.get(9)?,
                signature_hash: row.get(10)?,
            })
        })
        .map_err(|e| AstError::database(context, e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AstError::database(context, e))
}

fn load_file_states(conn: &Connection) -> Result<HashMap<String, FileState>, AstError> {
    let context = "reading ast_files";
    let mut statement = conn
        .prepare("SELECT path, size, mtime_ms, content_sha256 FROM ast_files")
        .map_err(|e| AstError::database(context, e))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                FileState {
                    size: row.get(1)?,
                    mtime_ms: row.get(2)?,
                    sha256: row.get(3)?,
                },
            ))
        })
        .map_err(|e| AstError::database(context, e))?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|e| AstError::database(context, e))
}

fn load_file_state(conn: &Connection, path: &str) -> Result<Option<FileState>, AstError> {
    conn.query_row(
        "SELECT size, mtime_ms, content_sha256 FROM ast_files WHERE path = ?1",
        [path],
        |row| {
            Ok(FileState {
                size: row.get(0)?,
                mtime_ms: row.get(1)?,
                sha256: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| AstError::database("reading ast_files", e))
}

fn immediate(conn: &mut Connection) -> Result<Transaction<'_>, AstError> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| AstError::database("starting a transaction", e))
}

fn write_file(tx: &Transaction, parsed: &ParsedFile, indexed_at: i64) -> Result<(), AstError> {
    let snapshot = &parsed.snapshot;
    let path = snapshot.path.as_str();
    let db = |context: &'static str| move |e| AstError::database(context, e);
    tx.prepare_cached("DELETE FROM ast_symbols WHERE path = ?1")
        .and_then(|mut s| s.execute([path]))
        .map_err(db("clearing ast_symbols"))?;
    tx.prepare_cached("DELETE FROM ast_edges WHERE source_path = ?1")
        .and_then(|mut s| s.execute([path]))
        .map_err(db("clearing ast_edges"))?;

    let mut insert_symbol = tx
        .prepare_cached(
            "INSERT INTO ast_symbols (path, name, qualified_name, kind, is_public, start_line, end_line,
                                      params_json, return_type, doc_summary, signature_text, signature_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )
        .map_err(db("preparing ast_symbols insert"))?;
    for symbol in &snapshot.symbols {
        let params_json =
            serde_json::to_string(&symbol.params).unwrap_or_else(|_| "[]".to_string());
        insert_symbol
            .execute(params![
                path,
                symbol.name,
                symbol.qualified_name,
                symbol.kind,
                symbol.is_public,
                to_i64(symbol.start_line as u64),
                to_i64(symbol.end_line as u64),
                params_json,
                symbol.return_type,
                symbol.doc_summary,
                symbol.signature_text,
                symbol.signature_hash,
            ])
            .map_err(db("writing ast_symbols"))?;
    }

    let mut insert_edge = tx
        .prepare_cached(
            "INSERT INTO ast_edges (source_path, source_symbol, target_path, target_symbol, edge_kind, line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(db("preparing ast_edges insert"))?;
    for edge in &snapshot.edges {
        insert_edge
            .execute(params![
                path,
                edge.source_symbol,
                edge.target_path,
                edge.target_symbol,
                edge.edge_kind.as_str(),
                to_i64(edge.line as u64),
            ])
            .map_err(db("writing ast_edges"))?;
    }

    tx.prepare_cached(
        "INSERT INTO ast_files (path, language, size, mtime_ms, content_sha256, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(path) DO UPDATE SET
           language = excluded.language, size = excluded.size, mtime_ms = excluded.mtime_ms,
           content_sha256 = excluded.content_sha256, indexed_at = excluded.indexed_at",
    )
    .and_then(|mut s| {
        s.execute(params![
            path,
            snapshot.language.as_str(),
            parsed.size,
            parsed.mtime_ms,
            parsed.sha256,
            indexed_at
        ])
    })
    .map_err(db("writing ast_files"))?;
    Ok(())
}

fn touch_mtime(tx: &Transaction, path: &str, mtime_ms: i64) -> Result<(), AstError> {
    tx.prepare_cached("UPDATE ast_files SET mtime_ms = ?2 WHERE path = ?1")
        .and_then(|mut s| s.execute(params![path, mtime_ms]))
        .map(|_| ())
        .map_err(|e| AstError::database("updating ast_files.mtime_ms", e))
}

fn delete_file(tx: &Transaction, path: &str) -> Result<(), AstError> {
    for (sql, context) in [
        (
            "DELETE FROM ast_symbols WHERE path = ?1",
            "pruning ast_symbols",
        ),
        (
            "DELETE FROM ast_edges WHERE source_path = ?1",
            "pruning ast_edges",
        ),
        ("DELETE FROM ast_files WHERE path = ?1", "pruning ast_files"),
    ] {
        tx.prepare_cached(sql)
            .and_then(|mut s| s.execute([path]))
            .map_err(|e| AstError::database(context, e))?;
    }
    Ok(())
}

fn count(conn: &Connection, table: &'static str) -> Result<i64, AstError> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .map_err(|e| AstError::database("counting rows", e))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use pretty_assertions::assert_eq;

    use super::*;

    struct Fixture {
        dir: tempfile::TempDir,
        conn: Connection,
    }

    impl Fixture {
        fn new(files: &[(&str, &str)]) -> anyhow::Result<Self> {
            let dir = tempfile::tempdir()?;
            std::fs::create_dir_all(dir.path().join("ws"))?;
            let fixture = Self {
                conn: open_database(&dir.path().join("ws.db"))?,
                dir,
            };
            for (name, content) in files {
                fixture.write(name, content)?;
            }
            Ok(fixture)
        }

        fn root(&self) -> std::path::PathBuf {
            self.dir.path().join("ws")
        }

        fn write(&self, name: &str, content: &str) -> anyhow::Result<()> {
            let path = self.root().join(name);
            std::fs::create_dir_all(path.parent().expect("file has a parent"))?;
            std::fs::write(&path, content)?;
            Ok(())
        }

        /// Moves a file's mtime without changing its bytes.
        fn touch(&self, name: &str) -> anyhow::Result<()> {
            let file = std::fs::File::options()
                .write(true)
                .open(self.root().join(name))?;
            file.set_modified(SystemTime::now() + Duration::from_secs(60))?;
            Ok(())
        }

        fn index(&mut self) -> IndexStats {
            let root = self.root();
            let mut stats = index_workspace(&mut self.conn, &root).unwrap();
            stats.duration_ms = 0;
            stats
        }

        fn rows(&self, sql: &str, path: &str) -> i64 {
            self.conn.query_row(sql, [path], |r| r.get(0)).unwrap()
        }
    }

    const FILES: &[(&str, &str)] = &[
        (
            "a.js",
            "export function alpha(x) { return beta(x); }\nfunction beta(y) { return y; }\n",
        ),
        ("b.py", "def gamma(n: int) -> int:\n    return n\n"),
        ("c.rs", "pub fn delta() -> bool { true }\n"),
        ("notes.md", "not indexed"),
    ];

    #[test]
    fn three_tier_sync_skips_hashes_parses_and_prunes() {
        let mut fixture = Fixture::new(FILES).unwrap();

        let first = fixture.index();
        assert_eq!(
            (
                first.parsed,
                first.skipped,
                first.hash_matched,
                first.removed
            ),
            (3, 0, 0, 0)
        );
        assert_eq!((first.symbols_total, first.failed), (4, 0));

        let second = fixture.index();
        assert_eq!(
            (
                second.parsed,
                second.skipped,
                second.hash_matched,
                second.removed
            ),
            (0, 3, 0, 0)
        );

        fixture.touch("b.py").unwrap();
        let third = fixture.index();
        assert_eq!((third.parsed, third.skipped, third.hash_matched), (0, 2, 1));
        let fourth = fixture.index();
        assert_eq!(
            (fourth.parsed, fourth.skipped, fourth.hash_matched),
            (0, 3, 0)
        );

        fixture
            .write("a.js", "export function alpha(x, y) { return x + y; }\n")
            .unwrap();
        std::fs::remove_file(fixture.root().join("c.rs")).unwrap();
        let fifth = fixture.index();
        assert_eq!((fifth.parsed, fifth.skipped, fifth.removed), (1, 1, 1));
        assert_eq!(
            fixture.rows("SELECT COUNT(*) FROM ast_files WHERE path = ?1", "c.rs"),
            0
        );
        assert_eq!(
            fixture.rows("SELECT COUNT(*) FROM ast_symbols WHERE path = ?1", "c.rs"),
            0
        );
        assert_eq!(
            fixture.rows(
                "SELECT COUNT(*) FROM ast_edges WHERE source_path = ?1",
                "c.rs"
            ),
            0
        );
        assert_eq!(
            fixture.rows(
                "SELECT COUNT(*) FROM ast_symbols_fts WHERE ast_symbols_fts MATCH ?1",
                "delta"
            ),
            0
        );
        assert_eq!(
            fixture.rows("SELECT COUNT(*) FROM ast_symbols WHERE path = ?1", "a.js"),
            1
        );
        fixture
            .conn
            .execute(
                "INSERT INTO ast_symbols_fts(ast_symbols_fts) VALUES ('integrity-check')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn edges_are_stored_with_resolved_targets() {
        let mut fixture = Fixture::new(FILES).unwrap();
        fixture.index();
        let actual: Vec<(Option<String>, Option<String>, String, String)> = fixture
            .conn
            .prepare("SELECT source_symbol, target_path, target_symbol, edge_kind FROM ast_edges WHERE source_path = 'a.js' ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let expected = vec![(
            Some("alpha".into()),
            Some("a.js".into()),
            "beta".into(),
            "calls".into(),
        )];
        assert_eq!(actual, expected);
    }

    #[test]
    fn single_file_update_reports_a_diff() {
        let mut fixture = Fixture::new(FILES).unwrap();
        fixture.index();
        let root = fixture.root();

        let unchanged = update_single_file(&mut fixture.conn, &root, "a.js").unwrap();
        assert_eq!(
            (unchanged.status, unchanged.diff.is_empty()),
            (UpdateStatus::Unchanged, true)
        );

        fixture
            .write(
                "a.js",
                "export function alpha(x, y) { return beta(x); }\nfunction epsilon() {}\n",
            )
            .unwrap();
        let updated = update_single_file(&mut fixture.conn, &root, "a.js").unwrap();
        assert_eq!(updated.status, UpdateStatus::Updated);
        let names = |list: &[SymbolSignature]| {
            list.iter()
                .map(|s| s.qualified_name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&updated.diff.added), vec!["epsilon"]);
        assert_eq!(names(&updated.diff.removed), vec!["beta"]);
        assert_eq!(updated.diff.modified.len(), 1);
        assert_eq!(updated.diff.modified[0].before.params.len(), 1);
        assert_eq!(updated.diff.modified[0].after.params.len(), 2);
        assert_eq!(
            fixture.rows("SELECT COUNT(*) FROM ast_symbols WHERE path = ?1", "a.js"),
            2
        );

        fixture
            .write("new.go", "package x\nfunc Zeta() {}\n")
            .unwrap();
        let added = update_single_file(&mut fixture.conn, &root, "new.go").unwrap();
        assert_eq!(
            (added.status, names(&added.diff.added)),
            (UpdateStatus::Added, vec!["Zeta".to_string()])
        );

        std::fs::remove_file(root.join("new.go")).unwrap();
        let removed = update_single_file(&mut fixture.conn, &root, "new.go").unwrap();
        assert_eq!(
            (removed.status, names(&removed.diff.removed)),
            (UpdateStatus::Removed, vec!["Zeta".to_string()])
        );
        assert_eq!(
            fixture.rows("SELECT COUNT(*) FROM ast_files WHERE path = ?1", "new.go"),
            0
        );

        assert!(matches!(
            update_single_file(&mut fixture.conn, &root, "notes.md"),
            Err(AstError::Unsupported(_))
        ));
        assert!(matches!(
            update_single_file(&mut fixture.conn, &root, "never.ts"),
            Err(AstError::Io { .. })
        ));
    }

    #[test]
    fn open_database_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.db");
        drop(open_database(&path).unwrap());
        let conn = open_database(&path).unwrap();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'ast_%' AND type = 'table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(tables >= 4);
    }
}
