//! Workspace file discovery: one parallel stat pass over supported sources.
//!
//! Adapted from Sota's `sota_walker`: `ignore::WalkBuilder` with the standard
//! filters (`.gitignore`, `.ignore`, git excludes, hidden files), never
//! following symlinks, and skipping `.git` and `node_modules` outright.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::{WalkBuilder, WalkState};

use crate::error::AstError;
use crate::parser::Language;

/// Files above this size are generated or vendored code, not worth parsing.
pub(crate) const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

const SKIPPED_DIRS: &[&str] = &[".git", "node_modules"];

/// A supported source file and the stat fields the Tier 1 gate compares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkedFile {
    /// Workspace-relative path with forward slashes.
    pub rel_path: String,
    /// Size in bytes.
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch.
    pub mtime_ms: i64,
}

/// Lists every supported source file under `root`, sorted by path.
///
/// Entries that cannot be read (permissions, races with deletion) are
/// skipped rather than failing the walk.
///
/// # Arguments
/// `root`: the workspace root directory.
///
/// # Errors
/// `AstError::InvalidArgument` when `root` is not a directory.
pub fn walk_workspace(root: &Path) -> Result<Vec<WalkedFile>, AstError> {
    if !root.is_dir() {
        return Err(AstError::InvalidArgument(format!(
            "workspace is not a directory: {}",
            root.display()
        )));
    }
    let collected: Mutex<Vec<WalkedFile>> = Mutex::new(Vec::new());
    WalkBuilder::new(root)
        .standard_filters(true)
        .hidden(true)
        .require_git(false)
        .follow_links(false)
        .max_filesize(Some(MAX_FILE_BYTES))
        .filter_entry(|entry| {
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            !(is_dir
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|n| SKIPPED_DIRS.contains(&n)))
        })
        .build_parallel()
        .run(|| {
            Box::new(|result| {
                if let Some(file) = result.ok().and_then(|entry| walked_file(root, &entry)) {
                    collected
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(file);
                }
                WalkState::Continue
            })
        });
    let mut files = collected
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner);
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(files)
}

fn walked_file(root: &Path, entry: &ignore::DirEntry) -> Option<WalkedFile> {
    if entry.path_is_symlink() || !entry.file_type()?.is_file() {
        return None;
    }
    let rel_path = entry
        .path()
        .strip_prefix(root)
        .ok()?
        .to_str()?
        .replace('\\', "/");
    Language::from_path(&rel_path)?;
    let metadata = entry.metadata().ok()?;
    Some(WalkedFile {
        rel_path,
        size: metadata.len(),
        mtime_ms: mtime_ms(&metadata),
    })
}

/// Converts a file argument into a workspace-relative path with forward slashes.
///
/// An absolute path must lie inside `root`, compared lexically first and
/// then through symlink-resolved paths. A relative path is taken relative to
/// `root`. The file need not exist, so a deleted file can still be pruned.
///
/// # Arguments
/// `root`: the workspace root. `file`: the file argument.
///
/// # Errors
/// `AstError::InvalidArgument` when the path is empty, escapes the root, or
/// is absolute outside it.
pub fn workspace_relative(root: &Path, file: &Path) -> Result<String, AstError> {
    let outside =
        || AstError::InvalidArgument(format!("{} is outside the workspace", file.display()));
    let relative: PathBuf = if file.is_absolute() {
        let lexical = std::path::absolute(root).map(|r| normalize(&r)).ok();
        match lexical
            .as_deref()
            .and_then(|r| normalize(file).strip_prefix(r).ok().map(Path::to_path_buf))
        {
            Some(rel) => rel,
            None => {
                let canonical_root = root.canonicalize().map_err(|e| AstError::io(root, e))?;
                let canonical_file = canonicalize_lenient(file).ok_or_else(outside)?;
                canonical_file
                    .strip_prefix(&canonical_root)
                    .map_err(|_| outside())?
                    .to_path_buf()
            }
        }
    } else {
        file.to_path_buf()
    };
    let mut parts: Vec<&str> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str().ok_or_else(outside)?),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop().ok_or_else(outside)?;
            }
            Component::RootDir | Component::Prefix(_) => return Err(outside()),
        }
    }
    if parts.is_empty() {
        return Err(AstError::InvalidArgument("file path is empty".into()));
    }
    Ok(parts.join("/"))
}

/// Lexically resolves `.` and `..` in an absolute path.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Canonicalizes a path whose final component may not exist.
fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    path.canonicalize()
        .ok()
        .or_else(|| Some(path.parent()?.canonicalize().ok()?.join(path.file_name()?)))
}

/// Modification time in milliseconds since the Unix epoch (0 if unavailable).
pub(crate) fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t: SystemTime| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn fixture(files: &[(&str, &str)]) -> anyhow::Result<tempfile::TempDir> {
        let dir = tempfile::tempdir()?;
        for (name, content) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().expect("file has a parent"))?;
            std::fs::write(path, content)?;
        }
        Ok(dir)
    }

    #[test]
    fn walks_supported_sources_respecting_ignores() {
        let dir = fixture(&[
            ("src/a.ts", "export const a = 1;"),
            ("src/b.py", "x = 1"),
            ("README.md", "# no"),
            ("build/out.js", "ignored"),
            ("node_modules/pkg/index.js", "skipped"),
            (".hidden/x.rs", "fn x() {}"),
            ("kept.ignored.js", "ignored by .ignore"),
            (".gitignore", "build/\n"),
            (".ignore", "*.ignored.js\n"),
        ])
        .unwrap();
        let actual: Vec<_> = walk_workspace(dir.path())
            .unwrap()
            .into_iter()
            .map(|f| f.rel_path)
            .collect();
        assert_eq!(actual, vec!["src/a.ts".to_string(), "src/b.py".to_string()]);
    }

    #[test]
    fn records_size_and_mtime() {
        let dir = fixture(&[("main.go", "package main")]).unwrap();
        let actual = walk_workspace(dir.path()).unwrap();
        assert_eq!(actual.len(), 1);
        assert_eq!(actual[0].size, 12);
        assert!(actual[0].mtime_ms > 0);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks() {
        let dir = fixture(&[("real.rs", "fn a() {}")]).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real.rs"), dir.path().join("link.rs")).unwrap();
        let actual: Vec<_> = walk_workspace(dir.path())
            .unwrap()
            .into_iter()
            .map(|f| f.rel_path)
            .collect();
        assert_eq!(actual, vec!["real.rs".to_string()]);
    }

    #[test]
    fn workspace_relative_confines_paths_to_the_root() {
        let dir = fixture(&[("src/a.ts", "")]).unwrap();
        let root = dir.path();
        let actual = vec![
            workspace_relative(root, Path::new("src/a.ts")).ok(),
            workspace_relative(root, &root.join("src/../src/a.ts")).ok(),
            workspace_relative(root, &root.join("src/deleted.ts")).ok(),
            workspace_relative(root, Path::new("./src/./a.ts")).ok(),
            workspace_relative(root, Path::new("../escape.ts")).ok(),
            workspace_relative(root, Path::new("/etc/passwd")).ok(),
            workspace_relative(root, Path::new("")).ok(),
        ];
        let expected = vec![
            Some("src/a.ts".to_string()),
            Some("src/a.ts".to_string()),
            Some("src/deleted.ts".to_string()),
            Some("src/a.ts".to_string()),
            None,
            None,
            None,
        ];
        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_a_missing_root() {
        let actual = walk_workspace(Path::new("/definitely/not/here"));
        assert!(matches!(actual, Err(AstError::InvalidArgument(_))));
    }
}
