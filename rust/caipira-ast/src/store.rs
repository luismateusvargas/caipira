//! SQLite persistence and the three-tier incremental sync.
//!
//! Tier 1 compares each walked file's `(size, mtime_ms)` with `ast_files`
//! and touches nothing else when both match. Tier 2 hashes a file whose
//! mtime moved at the same size and, when the hash still matches, updates
//! only `mtime_ms`. Tier 3 parses new and changed files in parallel and
//! replaces their rows, together with pruning deleted files, in one
//! transaction. `ast_symbols_fts` follows `ast_symbols` through triggers.
//!
//! Pruning needs a complete walk: when a directory could not be read, the
//! sync reports it and deletes nothing. Edges are linked against the files
//! the index keeps once the sync or update is applied, so a target is always
//! a row in `ast_files`, never a file the walker excludes. When a file enters
//! or leaves the index, every unchanged file whose imports probed its path is
//! re-linked from `ast_links` in the same transaction, so cross-file edge
//! targets follow the index without those importers being read or parsed.

use std::collections::{BTreeSet, HashMap, HashSet};
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
use crate::parser::{
    AstEdge, AstSnapshot, Language, LinkState, Links, ParamSignature, SymbolSignature,
    link_snapshot, parse_unlinked, relink,
};
use crate::resolve::{Probes, Resolver};
use crate::walker::{FileFailure, WalkedFile, confine, walk_file, walk_workspace};

/// The `ast_*` schema, identical to workspace migrations v3 and v4 in
/// `migrate.js` so either side can create it first.
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
    /// Files no longer on disk whose rows were pruned; always 0 when the
    /// walk could not read every directory.
    pub removed: usize,
    /// Directories that could not be walked and files that could not be read
    /// or parsed; their old rows are kept.
    pub failed: usize,
    /// Unchanged files whose edges were re-linked, without being read,
    /// because a file their imports probed entered or left the index.
    pub relinked: usize,
    /// `ast_symbols` rows after the sync.
    pub symbols_total: i64,
    /// `ast_edges` rows after the sync.
    pub edges_total: i64,
    /// Wall-clock duration of the sync.
    pub duration_ms: u64,
    /// One entry per failed directory or file.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failures: Vec<FileFailure>,
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
    /// The file exists but a full index would skip it (ignore rules, a
    /// hidden or skipped directory, the size limit, not a regular file):
    /// nothing was parsed, and any rows it had were deleted.
    Ignored,
}

/// The result of re-indexing one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileUpdate {
    pub status: UpdateStatus,
    pub path: String,
    pub diff: AstDiffReport,
    /// Unchanged files re-linked because this file entered or left the index.
    pub relinked: usize,
    pub duration_ms: u64,
}

struct FileState {
    size: i64,
    mtime_ms: i64,
    sha256: String,
}

struct ParsedFile {
    /// Without edges until [`ParsedFile::link`] runs.
    snapshot: AstSnapshot,
    links: Links,
    size: i64,
    mtime_ms: i64,
    sha256: String,
}

impl ParsedFile {
    /// Resolves the file's edges against the files the index will hold.
    fn link(&mut self, resolver: &Resolver) {
        self.links.probes = link_snapshot(&mut self.snapshot, &self.links.state, resolver);
    }
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
    let walk = walk_workspace(root)?;
    let known = load_file_states(conn)?;

    let mut stats = IndexStats::default();
    let mut work: Vec<(&WalkedFile, Option<&str>)> = Vec::new();
    for file in &walk.files {
        let size = to_i64(file.size);
        match known.get(&file.rel_path) {
            Some(state) if state.size == size && state.mtime_ms == file.mtime_ms => {
                stats.skipped += 1
            }
            Some(state) if state.size == size => work.push((file, Some(state.sha256.as_str()))),
            _ => work.push((file, None)),
        }
    }
    let mut outcomes: Vec<Outcome> = work
        .par_iter()
        .map(|(file, known_sha)| process(root, file, *known_sha))
        .collect();

    // An incomplete walk cannot tell a deleted file from one it never
    // reached, so nothing is pruned until every directory can be read.
    let mut removed: Vec<&String> = Vec::new();
    if walk.failures.is_empty() {
        let on_disk: HashSet<&str> = walk.files.iter().map(|f| f.rel_path.as_str()).collect();
        removed = known
            .keys()
            .filter(|path| !on_disk.contains(path.as_str()))
            .collect();
        removed.sort();
    }
    stats.failed = walk.failures.len();
    stats.failures = walk.failures;

    // Edges target only files the index holds after this sync: every known
    // file not pruned (one that failed to re-read keeps its rows) and every
    // file parsed now. A new file that failed is not among them.
    let pruned: HashSet<&str> = removed.iter().map(|path| path.as_str()).collect();
    let retained = known
        .keys()
        .filter(|path| !pruned.contains(path.as_str()))
        .cloned()
        .chain(outcomes.iter().filter_map(|outcome| match outcome {
            Outcome::Parsed(parsed) => Some(parsed.snapshot.path.clone()),
            _ => None,
        }));
    let resolver = Resolver::new(root, retained);
    outcomes.par_iter_mut().for_each(|outcome| {
        if let Outcome::Parsed(parsed) = outcome {
            parsed.link(&resolver);
        }
    });

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| AstError::database("starting the index transaction", e))?;
    let indexed_at = now_ms();
    let mut fresh: HashSet<String> = HashSet::new();
    let mut changed: Vec<String> = Vec::new();
    for outcome in outcomes {
        match outcome {
            Outcome::HashMatched { path, mtime_ms } => {
                touch_mtime(&tx, &path, mtime_ms)?;
                stats.hash_matched += 1;
            }
            Outcome::Parsed(parsed) => {
                write_file(&tx, &parsed, indexed_at)?;
                stats.parsed += 1;
                let path = parsed.snapshot.path.clone();
                if !known.contains_key(&path) {
                    changed.push(path.clone());
                }
                fresh.insert(path);
            }
            Outcome::Failed(failure) => {
                stats.failed += 1;
                stats.failures.push(failure);
            }
        }
    }
    for path in &removed {
        delete_file(&tx, path)?;
        changed.push((*path).clone());
    }
    stats.relinked = relink_dependents(&tx, &resolver, &changed, &fresh)?;
    tx.commit()
        .map_err(|e| AstError::database("committing the index transaction", e))?;

    stats.removed = removed.len();
    stats.symbols_total = count(conn, "ast_symbols")?;
    stats.edges_total = count(conn, "ast_edges")?;
    stats.duration_ms = elapsed_ms(started);
    Ok(stats)
}

fn process(root: &Path, file: &WalkedFile, known_sha: Option<&str>) -> Outcome {
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
    match parse_unlinked(&file.rel_path, &bytes) {
        Ok((snapshot, state)) => Outcome::Parsed(Box::new(ParsedFile {
            snapshot,
            links: Links {
                state,
                probes: Probes::new(),
            },
            size: to_i64(bytes.len() as u64),
            mtime_ms: file.mtime_ms,
            sha256,
        })),
        Err(e) => fail(e.to_string()),
    }
}

/// Re-indexes one file through the same gates and reports its symbol diff.
///
/// The file must be one a full [`index_workspace`] would visit: a path
/// through a symlink is rejected before anything is read, and a file the
/// walker's rules exclude is never parsed; if it was indexed before, its rows
/// are deleted and the status is [`UpdateStatus::Ignored`]. The file's edges
/// target only files in `ast_files`.
///
/// # Arguments
/// `conn`: an open workspace database.
/// `root`: the workspace root.
/// `rel_path`: the file, relative to `root` (see [`crate::workspace_relative`]).
///
/// # Errors
/// `AstError::Unsupported` for an unknown extension;
/// `AstError::InvalidArgument` for a path through a symlink; `AstError::Io`
/// when the file or a directory above it cannot be read, or the file is
/// missing and was never indexed; `AstError::Parse` and `AstError::Database`
/// as for a full index.
pub fn update_single_file(
    conn: &mut Connection,
    root: &Path,
    rel_path: &str,
) -> Result<FileUpdate, AstError> {
    let started = Instant::now();
    if Language::from_path(rel_path).is_none() {
        return Err(AstError::Unsupported(rel_path.to_string()));
    }
    let exists = confine(root, rel_path)?.is_some();
    let before = load_symbols(conn, rel_path)?;
    let state = load_file_state(conn, rel_path)?;
    let absolute = root.join(rel_path);
    let result = |status, diff, relinked| FileUpdate {
        status,
        path: rel_path.to_string(),
        diff,
        relinked,
        duration_ms: elapsed_ms(started),
    };

    let walked = if exists {
        walk_file(root, rel_path)?
    } else {
        None
    };
    let Some(file) = walked else {
        let status = if exists {
            UpdateStatus::Ignored
        } else {
            UpdateStatus::Removed
        };
        if state.is_none() {
            if exists {
                return Ok(result(status, AstDiffReport::default(), 0));
            }
            let missing = std::io::Error::new(ErrorKind::NotFound, "not on disk and not indexed");
            return Err(AstError::io(&absolute, missing));
        }
        let tx = immediate(conn)?;
        delete_file(&tx, rel_path)?;
        let resolver = Resolver::new(root, load_indexed_paths(&tx)?);
        let relinked = relink_dependents(&tx, &resolver, &[rel_path.to_string()], &HashSet::new())?;
        tx.commit()
            .map_err(|e| AstError::database("committing the file removal", e))?;
        return Ok(result(status, compare_snapshots(&before, &[]), relinked));
    };

    let size = to_i64(file.size);
    let mtime = file.mtime_ms;
    if let Some(state) = &state
        && state.size == size
        && state.mtime_ms == mtime
    {
        return Ok(result(UpdateStatus::Unchanged, AstDiffReport::default(), 0));
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
        return Ok(result(UpdateStatus::Unchanged, AstDiffReport::default(), 0));
    }

    let (snapshot, link_state) = parse_unlinked(rel_path, &bytes)?;
    let diff = compare_snapshots(&before, &snapshot.symbols);
    let mut parsed = ParsedFile {
        snapshot,
        links: Links {
            state: link_state,
            probes: Probes::new(),
        },
        size: to_i64(bytes.len() as u64),
        mtime_ms: mtime,
        sha256,
    };
    let tx = immediate(conn)?;
    let indexed = load_indexed_paths(&tx)?;
    let resolver = Resolver::new(root, indexed.into_iter().chain([rel_path.to_string()]));
    parsed.link(&resolver);
    write_file(&tx, &parsed, now_ms())?;
    let relinked = match state {
        Some(_) => 0,
        None => {
            let fresh = HashSet::from([rel_path.to_string()]);
            relink_dependents(&tx, &resolver, &[rel_path.to_string()], &fresh)?
        }
    };
    tx.commit()
        .map_err(|e| AstError::database("committing the file update", e))?;
    let status = if state.is_some() {
        UpdateStatus::Updated
    } else {
        UpdateStatus::Added
    };
    Ok(result(status, diff, relinked))
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

/// Every path in `ast_files`: the files edges may target.
fn load_indexed_paths(conn: &Connection) -> Result<Vec<String>, AstError> {
    let context = "reading ast_files";
    let mut statement = conn
        .prepare_cached("SELECT path FROM ast_files")
        .map_err(|e| AstError::database(context, e))?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|e| AstError::database(context, e))?;
    rows.collect::<Result<Vec<_>, _>>()
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

    replace_edges(tx, path, &snapshot.edges)?;
    write_links(tx, path, &parsed.links)?;

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

fn replace_edges(tx: &Transaction, path: &str, edges: &[AstEdge]) -> Result<(), AstError> {
    let db = |context: &'static str| move |e| AstError::database(context, e);
    tx.prepare_cached("DELETE FROM ast_edges WHERE source_path = ?1")
        .and_then(|mut s| s.execute([path]))
        .map_err(db("clearing ast_edges"))?;
    let mut insert_edge = tx
        .prepare_cached(
            "INSERT INTO ast_edges (source_path, source_symbol, target_path, target_symbol, edge_kind, line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(db("preparing ast_edges insert"))?;
    for edge in edges {
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
    Ok(())
}

/// Stores a file's link state and probes. A file whose imports probed no
/// indexable path can never need re-linking, so it gets no `ast_links` row.
fn write_links(tx: &Transaction, path: &str, links: &Links) -> Result<(), AstError> {
    tx.prepare_cached("DELETE FROM ast_links WHERE path = ?1")
        .and_then(|mut s| s.execute([path]))
        .map_err(|e| AstError::database("clearing ast_links", e))?;
    replace_probes(tx, path, &links.probes)?;
    if links.probes.is_empty() {
        return Ok(());
    }
    let state_json = serde_json::to_string(&links.state).map_err(|e| AstError::Parse {
        path: path.to_string(),
        message: format!("could not serialize the link state: {e}"),
    })?;
    tx.prepare_cached("INSERT INTO ast_links (path, state_json) VALUES (?1, ?2)")
        .and_then(|mut s| s.execute(params![path, state_json]))
        .map(|_| ())
        .map_err(|e| AstError::database("writing ast_links", e))
}

fn replace_probes(tx: &Transaction, path: &str, probes: &Probes) -> Result<(), AstError> {
    let db = |context: &'static str| move |e| AstError::database(context, e);
    tx.prepare_cached("DELETE FROM ast_link_probes WHERE source_path = ?1")
        .and_then(|mut s| s.execute([path]))
        .map_err(db("clearing ast_link_probes"))?;
    let mut insert = tx
        .prepare_cached("INSERT INTO ast_link_probes (source_path, probe_path) VALUES (?1, ?2)")
        .map_err(db("preparing ast_link_probes insert"))?;
    for probe in probes {
        insert
            .execute(params![path, probe])
            .map_err(db("writing ast_link_probes"))?;
    }
    Ok(())
}

/// Re-links every file whose imports probed a path in `changed` (or a
/// directory above one), except the `fresh` files just written. Returns how
/// many files were re-linked.
fn relink_dependents(
    tx: &Transaction,
    resolver: &Resolver,
    changed: &[String],
    fresh: &HashSet<String>,
) -> Result<usize, AstError> {
    let mut probed: BTreeSet<&str> = BTreeSet::new();
    for path in changed {
        probed.insert(path);
        let mut dir = path.as_str();
        while let Some((parent, _)) = dir.rsplit_once('/') {
            probed.insert(parent);
            dir = parent;
        }
    }
    let context = "reading ast_link_probes";
    let mut dependents: BTreeSet<String> = BTreeSet::new();
    let mut query = tx
        .prepare_cached("SELECT source_path FROM ast_link_probes WHERE probe_path = ?1")
        .map_err(|e| AstError::database(context, e))?;
    for probe in probed {
        let rows = query
            .query_map([probe], |row| row.get::<_, String>(0))
            .map_err(|e| AstError::database(context, e))?;
        for row in rows {
            let source = row.map_err(|e| AstError::database(context, e))?;
            if !fresh.contains(&source) {
                dependents.insert(source);
            }
        }
    }
    let mut relinked = 0;
    for path in &dependents {
        if relink_file(tx, resolver, path)? {
            relinked += 1;
        }
    }
    Ok(relinked)
}

/// Recomputes one file's edges from its stored link state and symbols.
fn relink_file(tx: &Transaction, resolver: &Resolver, path: &str) -> Result<bool, AstError> {
    let state_json: Option<String> = tx
        .query_row(
            "SELECT state_json FROM ast_links WHERE path = ?1",
            [path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| AstError::database("reading ast_links", e))?;
    let Some(state_json) = state_json else {
        return Ok(false);
    };
    let Ok(state) = serde_json::from_str::<LinkState>(&state_json) else {
        // A state this build cannot read: clear the stat gate so the next
        // sync re-parses the file instead.
        tx.prepare_cached("UPDATE ast_files SET size = -1, content_sha256 = '' WHERE path = ?1")
            .and_then(|mut s| s.execute([path]))
            .map_err(|e| AstError::database("resetting ast_files", e))?;
        return Ok(false);
    };
    let context = "reading ast_symbols";
    let mut statement = tx
        .prepare_cached("SELECT name, qualified_name FROM ast_symbols WHERE path = ?1 ORDER BY id")
        .map_err(|e| AstError::database(context, e))?;
    let symbols = statement
        .query_map([path], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| AstError::database(context, e))?
        .collect::<Result<Vec<(String, String)>, _>>()
        .map_err(|e| AstError::database(context, e))?;
    let Some((edges, probes)) = relink(path, &symbols, &state, resolver) else {
        return Ok(false);
    };
    replace_edges(tx, path, &edges)?;
    replace_probes(tx, path, &probes)?;
    Ok(true)
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
        ("DELETE FROM ast_links WHERE path = ?1", "pruning ast_links"),
        (
            "DELETE FROM ast_link_probes WHERE source_path = ?1",
            "pruning ast_link_probes",
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

        fn update(&mut self, rel_path: &str) -> Result<FileUpdate, AstError> {
            let root = self.root();
            update_single_file(&mut self.conn, &root, rel_path)
        }

        /// `(edge_kind, target_symbol, target_path)` for every edge from `path`.
        fn edges(&self, path: &str) -> Vec<(String, String, Option<String>)> {
            self.conn
                .prepare(
                    "SELECT edge_kind, target_symbol, target_path FROM ast_edges
                     WHERE source_path = ?1 ORDER BY id",
                )
                .unwrap()
                .query_map([path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        }

        /// Row counts for one file across `ast_files`, `ast_symbols`,
        /// `ast_edges`, and `ast_symbols_fts`.
        fn footprint(&self, path: &str) -> [i64; 4] {
            [
                self.rows("SELECT COUNT(*) FROM ast_files WHERE path = ?1", path),
                self.rows("SELECT COUNT(*) FROM ast_symbols WHERE path = ?1", path),
                self.rows(
                    "SELECT COUNT(*) FROM ast_edges WHERE source_path = ?1",
                    path,
                ),
                self.rows("SELECT COUNT(*) FROM ast_symbols_fts WHERE path = ?1", path),
            ]
        }
    }

    /// Sets permission bits; returns false when they do not restrict this
    /// process (root ignores them), so a test can skip what it cannot show.
    #[cfg(unix)]
    fn chmod(path: &Path, mode: u32) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        mode & 0o400 != 0 || std::fs::File::open(path).is_err()
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

    #[cfg(unix)]
    #[test]
    fn unreadable_directory_defers_pruning_and_keeps_rows() {
        let mut fixture = Fixture::new(&[
            (
                "sub/keep.js",
                "import { b } from '../top.js';\nexport function keep() { b(); }\n",
            ),
            ("top.js", "export function b() {}\n"),
            ("other.py", "def other():\n    pass\n"),
        ])
        .unwrap();
        fixture.index();
        let before = fixture.footprint("sub/keep.js");
        assert_eq!(before, [1, 1, 2, 1]);
        let sub = fixture.root().join("sub");
        if !chmod(&sub, 0o000) {
            chmod(&sub, 0o755);
            return;
        }
        std::fs::remove_file(fixture.root().join("other.py")).unwrap();
        let blocked = fixture.index();
        chmod(&sub, 0o755);
        assert_eq!((blocked.failed, blocked.removed), (1, 0));
        assert_eq!(blocked.failures[0].path, "sub");
        assert_eq!(fixture.footprint("sub/keep.js"), before);
        assert_eq!(fixture.footprint("other.py")[0], 1);

        let restored = fixture.index();
        assert_eq!((restored.failed, restored.removed), (0, 1));
        assert_eq!(fixture.footprint("sub/keep.js"), before);
        assert_eq!(fixture.footprint("other.py"), [0, 0, 0, 0]);
    }

    #[cfg(unix)]
    #[test]
    fn single_file_update_never_reads_through_a_symlink() {
        let mut fixture = Fixture::new(&[("src/a.js", "export function a() {}\n")]).unwrap();
        let outside = fixture.dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("private.js"), "export function secret() {}\n").unwrap();
        std::os::unix::fs::symlink(&outside, fixture.root().join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.join("private.js"), fixture.root().join("alias.js"))
            .unwrap();
        for path in ["linked/private.js", "alias.js"] {
            assert!(
                matches!(fixture.update(path), Err(AstError::InvalidArgument(_))),
                "{path}"
            );
            assert_eq!(fixture.footprint(path), [0, 0, 0, 0], "{path}");
        }
        assert_eq!(
            fixture.rows("SELECT COUNT(*) FROM ast_symbols WHERE name = ?1", "secret"),
            0
        );
        assert_eq!(
            fixture.update("src/a.js").unwrap().status,
            UpdateStatus::Added
        );
    }

    #[test]
    fn single_file_update_agrees_with_the_walker_on_ignored_files() {
        let mut fixture = Fixture::new(&[
            ("kept.js", "export function kept() {}\n"),
            ("ignored.js", "export function ignored() {}\n"),
            ("node_modules/pkg/index.js", "export function dep() {}\n"),
            (".gitignore", "ignored.js\n"),
        ])
        .unwrap();
        for path in ["ignored.js", "node_modules/pkg/index.js"] {
            let update = fixture.update(path).unwrap();
            assert_eq!(
                (update.status, update.diff.is_empty()),
                (UpdateStatus::Ignored, true),
                "{path}"
            );
            assert_eq!(fixture.footprint(path), [0, 0, 0, 0], "{path}");
        }
        assert_eq!(fixture.index().parsed, 1);

        fixture
            .write(".gitignore", "ignored.js\nkept.js\n")
            .unwrap();
        let excluded = fixture.update("kept.js").unwrap();
        assert_eq!(excluded.status, UpdateStatus::Ignored);
        assert_eq!(excluded.diff.removed.len(), 1);
        assert_eq!(fixture.footprint("kept.js"), [0, 0, 0, 0]);
    }

    #[test]
    fn cross_file_edges_follow_targets_entering_and_leaving_the_index() {
        const CONSUMER: &str = "import { provide } from './provider.js';\nexport function consume() { return provide(); }\n";
        const PROVIDER: &str = "export function provide() { return 1; }\n";
        let mut fixture = Fixture::new(&[("consumer.js", CONSUMER)]).unwrap();
        let unresolved = vec![
            ("imports".to_string(), "./provider.js".to_string(), None),
            ("calls".to_string(), "provide".to_string(), None),
        ];
        let resolved = vec![
            (
                "imports".to_string(),
                "./provider.js".to_string(),
                Some("provider.js".to_string()),
            ),
            (
                "calls".to_string(),
                "provide".to_string(),
                Some("provider.js".to_string()),
            ),
        ];
        fixture.index();
        assert_eq!(fixture.edges("consumer.js"), unresolved);

        // An unreadable consumer proves re-linking never reads it.
        let consumer = fixture.root().join("consumer.js");
        #[cfg(unix)]
        let locked = chmod(&consumer, 0o000);
        #[cfg(not(unix))]
        let locked = false;

        fixture.write("provider.js", PROVIDER).unwrap();
        let added = fixture.index();
        assert_eq!(
            (added.parsed, added.skipped, added.relinked, added.failed),
            (1, 1, 1, 0)
        );
        assert_eq!(fixture.edges("consumer.js"), resolved);

        std::fs::remove_file(fixture.root().join("provider.js")).unwrap();
        let removed = fixture.index();
        assert_eq!(
            (
                removed.skipped,
                removed.removed,
                removed.relinked,
                removed.failed
            ),
            (1, 1, 1, 0)
        );
        assert_eq!(fixture.edges("consumer.js"), unresolved);

        fixture.write("provider.js", PROVIDER).unwrap();
        let update = fixture.update("provider.js").unwrap();
        assert_eq!((update.status, update.relinked), (UpdateStatus::Added, 1));
        assert_eq!(fixture.edges("consumer.js"), resolved);
        let again = fixture.update("provider.js").unwrap();
        assert_eq!((again.status, again.relinked), (UpdateStatus::Unchanged, 0));

        std::fs::remove_file(fixture.root().join("provider.js")).unwrap();
        let update = fixture.update("provider.js").unwrap();
        assert_eq!((update.status, update.relinked), (UpdateStatus::Removed, 1));
        assert_eq!(fixture.edges("consumer.js"), unresolved);
        assert_eq!(
            fixture.rows(
                "SELECT COUNT(*) FROM ast_link_probes WHERE source_path = ?1",
                "provider.js"
            ),
            0
        );

        #[cfg(unix)]
        if locked {
            chmod(&consumer, 0o644);
        }
        let quiet = fixture.index();
        assert_eq!((quiet.parsed, quiet.skipped, quiet.relinked), (0, 1, 0));
    }

    #[test]
    fn cross_file_edges_never_target_files_outside_the_index() {
        const CONSUMER: &str = "import { provide } from './provider.js';\nexport function consume() { return provide(); }\n";
        const PROVIDER: &str = "export function provide() { return 1; }\n";
        let mut fixture = Fixture::new(&[
            ("consumer.js", CONSUMER),
            ("provider.js", PROVIDER),
            (".gitignore", "provider.js\n"),
        ])
        .unwrap();
        let target = |path: Option<&str>| {
            vec![
                (
                    "imports".to_string(),
                    "./provider.js".to_string(),
                    path.map(String::from),
                ),
                (
                    "calls".to_string(),
                    "provide".to_string(),
                    path.map(String::from),
                ),
            ]
        };
        let first = fixture.index();
        assert_eq!((first.parsed, first.failed), (1, 0));
        assert_eq!(fixture.footprint("provider.js"), [0, 0, 0, 0]);
        assert_eq!(fixture.edges("consumer.js"), target(None));

        // An unreadable consumer proves re-linking never reads it.
        let consumer = fixture.root().join("consumer.js");
        #[cfg(unix)]
        let locked = chmod(&consumer, 0o000);
        let gate = |fixture: &Fixture| -> (i64, i64, String) {
            fixture
                .conn
                .query_row(
                    "SELECT size, mtime_ms, content_sha256 FROM ast_files WHERE path = 'consumer.js'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap()
        };
        let consumer_gate = gate(&fixture);

        fixture.write(".gitignore", "").unwrap();
        let eligible = fixture.index();
        assert_eq!(
            (eligible.parsed, eligible.skipped, eligible.relinked),
            (1, 1, 1)
        );
        assert_eq!(fixture.edges("consumer.js"), target(Some("provider.js")));

        fixture.write(".gitignore", "provider.js\n").unwrap();
        let ignored = fixture.index();
        assert_eq!(
            (ignored.removed, ignored.skipped, ignored.relinked),
            (1, 1, 1)
        );
        assert_eq!(fixture.footprint("provider.js"), [0, 0, 0, 0]);
        assert_eq!(fixture.edges("consumer.js"), target(None));

        fixture.write(".gitignore", "").unwrap();
        let added = fixture.update("provider.js").unwrap();
        assert_eq!((added.status, added.relinked), (UpdateStatus::Added, 1));
        assert_eq!(fixture.edges("consumer.js"), target(Some("provider.js")));
        fixture.write(".gitignore", "provider.js\n").unwrap();
        let dropped = fixture.update("provider.js").unwrap();
        assert_eq!(
            (dropped.status, dropped.relinked),
            (UpdateStatus::Ignored, 1)
        );
        assert_eq!(fixture.edges("consumer.js"), target(None));
        assert_eq!(gate(&fixture), consumer_gate);

        #[cfg(unix)]
        {
            if locked {
                chmod(&consumer, 0o644);
            }
            // A provider reached through a symlink stays outside the index,
            // whether the file itself or a directory above it is the link.
            let outside = fixture.dir.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join("provider.js"), PROVIDER).unwrap();
            fixture.write(".gitignore", "").unwrap();
            fixture.write("provider.js", PROVIDER).unwrap();
            assert_eq!(fixture.index().relinked, 1);
            assert_eq!(fixture.edges("consumer.js"), target(Some("provider.js")));
            std::fs::remove_file(fixture.root().join("provider.js")).unwrap();
            std::os::unix::fs::symlink(
                outside.join("provider.js"),
                fixture.root().join("provider.js"),
            )
            .unwrap();
            std::os::unix::fs::symlink(&outside, fixture.root().join("ext")).unwrap();
            fixture
                .write(
                    "via_dir.js",
                    &CONSUMER.replace("./provider.js", "./ext/provider.js"),
                )
                .unwrap();
            let linked = fixture.index();
            assert_eq!((linked.parsed, linked.removed, linked.relinked), (1, 1, 1));
            assert_eq!(fixture.edges("consumer.js"), target(None));
            let via_dir: Vec<_> = fixture
                .edges("via_dir.js")
                .into_iter()
                .map(|(_, _, path)| path)
                .collect();
            assert_eq!(via_dir, vec![None, None]);
            let indexed: i64 = fixture
                .conn
                .query_row("SELECT COUNT(*) FROM ast_files", [], |r| r.get(0))
                .unwrap();
            assert_eq!(indexed, 2);
            let targets: i64 = fixture
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM ast_edges WHERE target_path IS NOT NULL
                     AND target_path NOT IN (SELECT path FROM ast_files)",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(targets, 0);
        }
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
