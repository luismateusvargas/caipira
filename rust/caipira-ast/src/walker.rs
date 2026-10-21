//! Workspace file discovery: one parallel stat pass over supported sources.
//!
//! Adapted from Sota's `sota_walker`: `ignore::WalkBuilder` with the standard
//! filters (`.gitignore`, `.ignore`, git excludes, hidden files), never
//! following symlinks, and skipping `.git` and `node_modules` outright.
//! [`walk_file`] applies the same rules to one path, so a full index and a
//! single-file update agree on which files belong in the index.

use std::fs::Metadata;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

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

/// A file or directory that could not be read or stat'ed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileFailure {
    pub path: String,
    pub message: String,
}

/// The result of one workspace walk.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Walk {
    /// Every supported source file visited, sorted by path.
    pub files: Vec<WalkedFile>,
    /// Directories and files the walk could not read, sorted by path. When
    /// this is not empty, a file missing from `files` may still exist.
    pub failures: Vec<FileFailure>,
}

/// Lists every supported source file under `root`.
///
/// A directory or file that cannot be read is reported in
/// [`Walk::failures`] rather than failing the walk; an entry deleted while
/// the walk runs is simply absent.
///
/// # Arguments
/// `root`: the workspace root directory.
///
/// # Errors
/// `AstError::InvalidArgument` when `root` is not a directory.
pub fn walk_workspace(root: &Path) -> Result<Walk, AstError> {
    if !root.is_dir() {
        return Err(AstError::InvalidArgument(format!(
            "workspace is not a directory: {}",
            root.display()
        )));
    }
    let collected: Mutex<Walk> = Mutex::new(Walk::default());
    builder(root, None).build_parallel().run(|| {
        Box::new(|result| {
            let visited = result
                .map_err(|e| walk_failure(root, &e))
                .and_then(|entry| walked_file(root, &entry));
            let mut walk = collected.lock().unwrap_or_else(PoisonError::into_inner);
            match visited {
                Ok(Some(file)) => walk.files.push(file),
                Ok(None) => {}
                Err(failure) => walk.failures.push(failure),
            }
            WalkState::Continue
        })
    });
    let mut walk = collected
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner);
    walk.files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    walk.failures.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(walk)
}

/// The one file at `rel_path`, when a full [`walk_workspace`] would list it.
///
/// Walks only the directories leading to the file, with the same ignore
/// rules, skipped directories, size limit, and symlink handling.
///
/// # Arguments
/// `root`: the workspace root directory. `rel_path`: a workspace-relative path.
///
/// # Errors
/// `AstError::Io` when a directory on the way, or the file itself, cannot be
/// read or stat'ed.
pub fn walk_file(root: &Path, rel_path: &str) -> Result<Option<WalkedFile>, AstError> {
    let target = root.join(rel_path);
    for result in builder(root, Some(target.clone())).build() {
        let entry = result.map_err(|e| {
            let path = failure_path(&e).unwrap_or(target.as_path()).to_path_buf();
            AstError::io(path, std::io::Error::other(e.to_string()))
        })?;
        if entry.path() == target {
            return walked_file(root, &entry)
                .map_err(|failure| AstError::io(&target, std::io::Error::other(failure.message)));
        }
    }
    Ok(None)
}

/// The walker configuration shared by full and single-file walks; `target`
/// limits traversal to the directories leading to one path.
fn builder(root: &Path, target: Option<PathBuf>) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(true)
        .hidden(true)
        .require_git(false)
        .follow_links(false)
        .max_filesize(Some(MAX_FILE_BYTES))
        .filter_entry(move |entry| {
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            let skipped = is_dir
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|n| SKIPPED_DIRS.contains(&n));
            !skipped && target.as_ref().is_none_or(|t| t.starts_with(entry.path()))
        });
    builder
}

/// A supported regular file, `None` for anything else, or the stat failure.
fn walked_file(root: &Path, entry: &ignore::DirEntry) -> Result<Option<WalkedFile>, FileFailure> {
    let is_file = entry.file_type().is_some_and(|t| t.is_file());
    if entry.path_is_symlink() || !is_file {
        return Ok(None);
    }
    let Some(rel_path) = entry
        .path()
        .strip_prefix(root)
        .ok()
        .and_then(Path::to_str)
        .map(|p| p.replace('\\', "/"))
    else {
        return Ok(None);
    };
    if Language::from_path(&rel_path).is_none() {
        return Ok(None);
    }
    let metadata = match entry.metadata() {
        Ok(metadata) => metadata,
        Err(e)
            if e.io_error()
                .is_some_and(|io| io.kind() == ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(e) => {
            return Err(FileFailure {
                path: rel_path,
                message: e.to_string(),
            });
        }
    };
    Ok(Some(WalkedFile {
        rel_path,
        size: metadata.len(),
        mtime_ms: mtime_ms(&metadata),
    }))
}

/// A traversal error as a failure on the path it happened at.
fn walk_failure(root: &Path, error: &ignore::Error) -> FileFailure {
    let path = failure_path(error).map_or_else(
        || ".".to_string(),
        |p| {
            p.strip_prefix(root)
                .unwrap_or(p)
                .to_string_lossy()
                .replace('\\', "/")
        },
    );
    FileFailure {
        path: if path.is_empty() { ".".into() } else { path },
        message: error.to_string(),
    }
}

fn failure_path(error: &ignore::Error) -> Option<&Path> {
    match error {
        ignore::Error::WithPath { path, .. } => Some(path),
        ignore::Error::WithDepth { err, .. } | ignore::Error::WithLineNumber { err, .. } => {
            failure_path(err)
        }
        ignore::Error::Partial(errors) => errors.iter().find_map(failure_path),
        ignore::Error::Loop { child, .. } => Some(child),
        _ => None,
    }
}

/// What is at `rel_path` under `root`, checked one component at a time
/// without following symlinks.
///
/// Returns `None` when a component does not exist (or a parent is not a
/// directory), so a deleted file can still be pruned, and the final
/// component's metadata otherwise.
///
/// # Arguments
/// `root`: the workspace root. `rel_path`: a workspace-relative path.
///
/// # Errors
/// `AstError::InvalidArgument` when the path passes through a symlink,
/// including a symlinked final component; `AstError::Io` when a component
/// cannot be stat'ed.
pub fn confine(root: &Path, rel_path: &str) -> Result<Option<Metadata>, AstError> {
    let mut current = root.to_path_buf();
    let parts: Vec<&str> = rel_path.split('/').filter(|p| !p.is_empty()).collect();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
                return Ok(None);
            }
            Err(e) => return Err(AstError::io(&current, e)),
        };
        if metadata.file_type().is_symlink() {
            return Err(AstError::InvalidArgument(format!(
                "{rel_path} passes through a symlink ({}), which the index never follows",
                parts[..=index].join("/")
            )));
        }
        if index + 1 == parts.len() {
            return Ok(Some(metadata));
        }
        if !metadata.is_dir() {
            return Ok(None);
        }
    }
    Ok(None)
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
        let walk = walk_workspace(dir.path()).unwrap();
        let actual: Vec<_> = walk.files.into_iter().map(|f| f.rel_path).collect();
        assert_eq!(actual, vec!["src/a.ts".to_string(), "src/b.py".to_string()]);
        assert_eq!(walk.failures, vec![]);
    }

    #[test]
    fn records_size_and_mtime() {
        let dir = fixture(&[("main.go", "package main")]).unwrap();
        let actual = walk_workspace(dir.path()).unwrap().files;
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
            .files
            .into_iter()
            .map(|f| f.rel_path)
            .collect();
        assert_eq!(actual, vec!["real.rs".to_string()]);
    }

    /// Sets a directory's permission bits; returns false when they do not
    /// restrict this process (root ignores them).
    #[cfg(unix)]
    fn chmod(path: &Path, mode: u32) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        mode & 0o500 != 0 || std::fs::read_dir(path).is_err()
    }

    #[cfg(unix)]
    #[test]
    fn reports_unreadable_directories_instead_of_dropping_them() {
        let dir = fixture(&[("top.js", "a"), ("sub/keep.js", "b")]).unwrap();
        let sub = dir.path().join("sub");
        if !chmod(&sub, 0o000) {
            chmod(&sub, 0o755);
            return;
        }
        let walk = walk_workspace(dir.path());
        chmod(&sub, 0o755);
        let walk = walk.unwrap();
        let files: Vec<_> = walk.files.into_iter().map(|f| f.rel_path).collect();
        let failed: Vec<_> = walk.failures.into_iter().map(|f| f.path).collect();
        assert_eq!(
            (files, failed),
            (vec!["top.js".to_string()], vec!["sub".to_string()])
        );
    }

    #[cfg(unix)]
    #[test]
    fn walk_file_applies_the_walker_rules_to_one_path() {
        let dir = fixture(&[
            ("src/a.ts", "export const a = 1;"),
            ("ignored.js", "x"),
            ("build/out.js", "x"),
            ("node_modules/pkg/index.js", "x"),
            (".hidden/x.rs", "fn x() {}"),
            ("big.js", &"x".repeat(MAX_FILE_BYTES as usize + 1)),
            ("real/b.js", "x"),
            (".gitignore", "ignored.js\nbuild/\n"),
        ])
        .unwrap();
        let root = dir.path();
        std::os::unix::fs::symlink(root.join("real"), root.join("linked")).unwrap();
        let eligible = |rel: &str| walk_file(root, rel).unwrap().map(|f| f.rel_path);
        let actual = vec![
            eligible("src/a.ts"),
            eligible("ignored.js"),
            eligible("build/out.js"),
            eligible("node_modules/pkg/index.js"),
            eligible(".hidden/x.rs"),
            eligible("big.js"),
            eligible("linked/b.js"),
            eligible("src/missing.ts"),
        ];
        let expected = vec![
            Some("src/a.ts".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ];
        assert_eq!(actual, expected);
    }

    #[cfg(unix)]
    #[test]
    fn confine_rejects_any_symlinked_component() {
        let dir = fixture(&[("ws/src/a.js", "x"), ("outside/private.js", "secret")]).unwrap();
        let root = dir.path().join("ws");
        std::os::unix::fs::symlink(dir.path().join("outside"), root.join("linked")).unwrap();
        std::os::unix::fs::symlink(root.join("src/a.js"), root.join("alias.js")).unwrap();
        let rejected = |rel: &str| matches!(confine(&root, rel), Err(AstError::InvalidArgument(_)));
        assert!(rejected("linked/private.js"));
        assert!(rejected("linked/missing.js"));
        assert!(rejected("alias.js"));
        assert!(
            confine(&root, "src/a.js")
                .unwrap()
                .is_some_and(|m| m.is_file())
        );
        assert!(confine(&root, "src/deleted.js").unwrap().is_none());
        assert!(confine(&root, "gone/deleted.js").unwrap().is_none());
        assert!(confine(&root, "src/a.js/inner.js").unwrap().is_none());
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
