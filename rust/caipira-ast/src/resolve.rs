//! Resolves import specifiers to workspace-relative files.
//!
//! Resolution is lexical; a specifier that would climb above the root never
//! resolves. A source candidate resolves only when it is one of the indexed
//! files the resolver was built with, so an edge never targets a file the
//! index excludes (ignored, hidden, over the size limit, or reached through
//! a symlink). Any other candidate (`./data.json`, `Cargo.toml`) resolves to
//! a regular file under the root, never through a symlink. Every source
//! path and directory a resolution checks is recorded as a probe, so a file
//! can be re-linked when one of those paths enters or leaves the index.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::parser::Language;
use crate::walker::confine;

/// Maps import specifiers to indexed workspace files under one root.
#[derive(Debug)]
pub struct Resolver {
    root: PathBuf,
    /// The source files in the index; no other source file is a target.
    indexed: HashSet<String>,
    /// Directories holding at least one indexed Go file.
    go_packages: HashSet<String>,
    go_module: OnceLock<Option<String>>,
}

/// An import as written, waiting to be resolved against the importing file.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportRequest {
    /// A relative JS/TS/Vue specifier (`./store.js`, `../workspace`).
    Script { spec: String },
    /// A dotted Python module (`.store`, `..pkg.mod`, `pkg.mod`).
    Python { module: String },
    /// `from <module> import <name>` where `name` may itself be a submodule.
    PythonSubmodule { module: String, name: String },
    /// `mod name;`.
    RustMod { name: String },
    /// A `use` path; resolves to the file and the item path left inside it.
    RustUse { path: String },
    /// A quoted `#include "x.hpp"`.
    CppInclude { spec: String },
    /// A Go import path inside this workspace's module.
    GoImport { spec: String },
}

/// Paths a resolution checked, workspace-relative: candidate source files
/// and directories. Candidates that can never be indexed are left out.
pub type Probes = BTreeSet<String>;

const SCRIPT_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue"];

impl Resolver {
    /// Creates a resolver for a workspace.
    ///
    /// # Arguments
    /// `root`: the workspace root directory. `indexed`: the workspace-relative
    /// source files in the index, the only source files imports may target.
    pub fn new(root: &Path, indexed: impl IntoIterator<Item = String>) -> Self {
        let indexed: HashSet<String> = indexed.into_iter().collect();
        let go_packages = indexed
            .iter()
            .filter(|path| Language::from_path(path) == Some(Language::Go))
            .filter_map(|path| path.rsplit_once('/').map(|(dir, _)| dir.to_string()))
            .collect();
        Self {
            root: root.to_path_buf(),
            indexed,
            go_packages,
            go_module: OnceLock::new(),
        }
    }

    /// Resolves one import made by `from`.
    ///
    /// Returns the workspace file (a package directory for Go) and, for a
    /// Rust `use`, the item path left inside that file (empty otherwise).
    ///
    /// # Arguments
    /// `from`: the importing file. `request`: the import as written.
    /// `probes`: receives every candidate path checked.
    pub fn resolve(
        &self,
        from: &str,
        request: &ImportRequest,
        probes: &mut Probes,
    ) -> Option<(String, String)> {
        let file = |found: Option<String>| found.map(|path| (path, String::new()));
        match request {
            ImportRequest::Script { spec } => file(self.script(from, spec, probes)),
            ImportRequest::Python { module } => file(self.python(from, module, probes)),
            ImportRequest::PythonSubmodule { module, name } => {
                file(self.python_submodule(from, module, name, probes))
            }
            ImportRequest::RustMod { name } => file(self.rust_mod(from, name, probes)),
            ImportRequest::RustUse { path } => self.rust_use(from, path, probes),
            ImportRequest::CppInclude { spec } => file(self.cpp_include(from, spec, probes)),
            ImportRequest::GoImport { spec } => file(self.go_import(spec, probes)),
        }
    }

    fn is_file(&self, rel: &str, probes: &mut Probes) -> bool {
        if rel.is_empty() {
            return false;
        }
        if Language::from_path(rel).is_some() {
            probes.insert(rel.to_string());
            return self.indexed.contains(rel);
        }
        // Never indexed, so never re-linked: any regular file under the root.
        matches!(confine(&self.root, rel), Ok(Some(metadata)) if metadata.is_file())
    }

    fn is_dir(&self, rel: &str, probes: &mut Probes) -> bool {
        if rel.is_empty() {
            return false;
        }
        probes.insert(rel.to_string());
        self.root.join(rel).is_dir()
    }

    fn first_file(
        &self,
        candidates: impl IntoIterator<Item = String>,
        probes: &mut Probes,
    ) -> Option<String> {
        candidates.into_iter().find(|c| self.is_file(c, probes))
    }

    /// Tries the path as written, TypeScript's `.js` -> `.ts` convention,
    /// each script extension, then `index.*` inside a directory.
    fn script(&self, from: &str, spec: &str, probes: &mut Probes) -> Option<String> {
        if !(spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == "..") {
            return None;
        }
        let base = join(parent(from), spec)?;
        let mut candidates = vec![base.clone()];
        for (js, ts) in [
            (".js", ".ts"),
            (".jsx", ".tsx"),
            (".mjs", ".mts"),
            (".cjs", ".cts"),
        ] {
            if let Some(stem) = base.strip_suffix(js) {
                candidates.push(format!("{stem}{ts}"));
            }
        }
        candidates.extend(SCRIPT_EXTENSIONS.iter().map(|ext| format!("{base}.{ext}")));
        candidates.push(format!("{base}.d.ts"));
        candidates.extend(
            SCRIPT_EXTENSIONS
                .iter()
                .map(|ext| format!("{base}/index.{ext}")),
        );
        self.first_file(candidates, probes)
    }

    fn python(&self, from: &str, module: &str, probes: &mut Probes) -> Option<String> {
        let dots = module.chars().take_while(|c| *c == '.').count();
        let rest = &module[dots..];
        let segments: Vec<&str> = rest.split('.').filter(|s| !s.is_empty()).collect();
        if dots > 0 {
            let mut dir = parent(from).to_string();
            for _ in 1..dots {
                if dir.is_empty() {
                    return None;
                }
                dir = parent(&dir).to_string();
            }
            let base = join_segments(&dir, &segments);
            return self.python_candidates(&base, segments.is_empty(), probes);
        }
        ["", "src"].iter().find_map(|prefix| {
            self.python_candidates(&join_segments(prefix, &segments), false, probes)
        })
    }

    fn python_submodule(
        &self,
        from: &str,
        module: &str,
        name: &str,
        probes: &mut Probes,
    ) -> Option<String> {
        let dotted = if module.chars().all(|c| c == '.') {
            format!("{module}{name}")
        } else {
            format!("{module}.{name}")
        };
        self.python(from, &dotted, probes)
    }

    fn python_candidates(
        &self,
        base: &str,
        is_package_dir: bool,
        probes: &mut Probes,
    ) -> Option<String> {
        if is_package_dir {
            return self.first_file([join_segments(base, &["__init__.py"])], probes);
        }
        if base.is_empty() {
            return None;
        }
        self.first_file(
            [
                format!("{base}.py"),
                format!("{base}.pyi"),
                format!("{base}/__init__.py"),
            ],
            probes,
        )
    }

    fn rust_mod(&self, from: &str, name: &str, probes: &mut Probes) -> Option<String> {
        let dir = rust_module_dir(from);
        self.first_file(
            [
                join_segments(&dir, &[&format!("{name}.rs")]),
                join_segments(&dir, &[name, "mod.rs"]),
            ],
            probes,
        )
    }

    /// Handles `crate::`, `self::`, and child modules of the current module;
    /// `super::` and external crates stay unresolved.
    fn rust_use(&self, from: &str, path: &str, probes: &mut Probes) -> Option<(String, String)> {
        let segments: Vec<&str> = path.split("::").filter(|s| !s.is_empty()).collect();
        let (base, rest, crate_root) = match segments.first().copied()? {
            "crate" => (self.crate_src(from, probes)?, &segments[1..], true),
            "self" => (rust_module_dir(from), &segments[1..], false),
            "super" => return None,
            _ => (rust_module_dir(from), &segments[..], false),
        };
        for depth in (1..=rest.len()).rev() {
            let module = rest[..depth].join("/");
            let found = self.first_file(
                [
                    join_segments(&base, &[&format!("{module}.rs")]),
                    join_segments(&base, &[&module, "mod.rs"]),
                ],
                probes,
            );
            if let Some(file) = found {
                return Some((file, rest[depth..].join("::")));
            }
        }
        if crate_root && !rest.is_empty() {
            let root_file = self.first_file(
                [
                    join_segments(&base, &["lib.rs"]),
                    join_segments(&base, &["main.rs"]),
                ],
                probes,
            )?;
            return Some((root_file, rest.join("::")));
        }
        None
    }

    /// The `src` directory of the crate containing `from`.
    fn crate_src(&self, from: &str, probes: &mut Probes) -> Option<String> {
        let mut dir = parent(from).to_string();
        loop {
            if self.is_file(&join_segments(&dir, &["Cargo.toml"]), probes) {
                let src = join_segments(&dir, &["src"]);
                return self.is_dir(&src, probes).then_some(src);
            }
            if dir.is_empty() {
                return None;
            }
            dir = parent(&dir).to_string();
        }
    }

    /// Searched beside the file, at the root, then under `include/` and `src/`.
    fn cpp_include(&self, from: &str, spec: &str, probes: &mut Probes) -> Option<String> {
        let candidates = [
            join(parent(from), spec),
            join("", spec),
            join("include", spec),
            join("src", spec),
        ];
        self.first_file(candidates.into_iter().flatten(), probes)
    }

    /// The package directory of an import path inside the `go.mod` module,
    /// when it holds an indexed Go file.
    fn go_import(&self, spec: &str, probes: &mut Probes) -> Option<String> {
        let module = self
            .go_module
            .get_or_init(|| read_go_module(&self.root))
            .as_deref()?;
        let rest = spec.strip_prefix(module)?.strip_prefix('/')?;
        let dir = join("", rest)?;
        if dir.is_empty() {
            return None;
        }
        probes.insert(dir.clone());
        self.go_packages.contains(&dir).then_some(dir)
    }
}

fn read_go_module(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("go.mod")).ok()?;
    text.lines()
        .find_map(|line| line.trim().strip_prefix("module "))
        .map(|m| m.trim().trim_matches('"').to_string())
}

/// The directory child modules of a Rust file live in.
fn rust_module_dir(from: &str) -> String {
    let dir = parent(from);
    let file = from.rsplit('/').next().unwrap_or(from);
    match file {
        "lib.rs" | "main.rs" | "mod.rs" => dir.to_string(),
        _ => join_segments(dir, &[file.strip_suffix(".rs").unwrap_or(file)]),
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

fn join_segments(dir: &str, segments: &[&str]) -> String {
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    parts.extend(segments.iter().filter(|s| !s.is_empty()));
    parts.join("/")
}

/// Joins `spec` onto `dir` and normalises `.`/`..`; `None` above the root.
fn join(dir: &str, spec: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for segment in spec.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    /// Writes `files` and returns a resolver that treats all of them as indexed.
    fn fixture(files: &[&str]) -> anyhow::Result<(tempfile::TempDir, Resolver)> {
        let dir = tempfile::tempdir()?;
        for file in files {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().expect("file has a parent"))?;
            std::fs::write(path, "")?;
        }
        let resolver = Resolver::new(dir.path(), files.iter().map(|f| f.to_string()));
        Ok((dir, resolver))
    }

    /// The resolved file alone, discarding probes and the item path.
    fn file(resolver: &Resolver, from: &str, request: ImportRequest) -> Option<String> {
        resolver
            .resolve(from, &request, &mut Probes::new())
            .map(|(path, _)| path)
    }

    fn script(spec: &str) -> ImportRequest {
        ImportRequest::Script { spec: spec.into() }
    }

    fn python(module: &str) -> ImportRequest {
        ImportRequest::Python {
            module: module.into(),
        }
    }

    fn rust_use(path: &str) -> ImportRequest {
        ImportRequest::RustUse { path: path.into() }
    }

    #[test]
    fn script_specifiers_resolve_extensions_and_index_files() {
        let (_dir, resolver) =
            fixture(&["src/store.ts", "src/ui/index.tsx", "lib/util.js"]).unwrap();
        let from = "src/app.ts";
        let actual = vec![
            file(&resolver, from, script("./store.js")),
            file(&resolver, from, script("./store")),
            file(&resolver, from, script("./ui")),
            file(&resolver, from, script("../lib/util.js")),
            file(&resolver, from, script("react")),
            file(&resolver, from, script("../../outside")),
        ];
        let expected = vec![
            Some("src/store.ts".to_string()),
            Some("src/store.ts".to_string()),
            Some("src/ui/index.tsx".to_string()),
            Some("lib/util.js".to_string()),
            None,
            None,
        ];
        assert_eq!(actual, expected);
    }

    #[test]
    fn probes_stop_at_the_first_hit_and_skip_unindexable_candidates() {
        let (_dir, resolver) = fixture(&["src/store.ts"]).unwrap();
        let probed = |request: ImportRequest| {
            let mut probes = Probes::new();
            resolver.resolve("src/app.ts", &request, &mut probes);
            probes.into_iter().collect::<Vec<_>>()
        };
        assert_eq!(
            probed(script("./store.js")),
            vec!["src/store.js".to_string(), "src/store.ts".to_string()]
        );
        assert_eq!(probed(script("react")), Vec::<String>::new());
        let missing = probed(script("./gone"));
        assert!(missing.contains(&"src/gone.js".to_string()));
        assert!(missing.contains(&"src/gone/index.vue".to_string()));
        assert!(missing.contains(&"src/gone.mts".to_string()));
        assert!(!missing.contains(&"src/gone".to_string()));
    }

    #[test]
    fn python_modules_resolve_relative_and_absolute() {
        let (_dir, resolver) = fixture(&[
            "pkg/__init__.py",
            "pkg/store.py",
            "pkg/sub/mod.py",
            "src/lib/core.py",
        ])
        .unwrap();
        let submodule = |module: &str, name: &str| ImportRequest::PythonSubmodule {
            module: module.into(),
            name: name.into(),
        };
        let actual = vec![
            file(&resolver, "pkg/sub/mod.py", python("..store")),
            file(&resolver, "pkg/a.py", python(".store")),
            file(&resolver, "pkg/a.py", python(".")),
            file(&resolver, "x.py", python("pkg.sub.mod")),
            file(&resolver, "x.py", python("lib.core")),
            file(&resolver, "pkg/a.py", submodule(".", "store")),
            file(&resolver, "pkg/a.py", submodule(".store", "Row")),
        ];
        let expected = vec![
            Some("pkg/store.py".to_string()),
            Some("pkg/store.py".to_string()),
            Some("pkg/__init__.py".to_string()),
            Some("pkg/sub/mod.py".to_string()),
            Some("src/lib/core.py".to_string()),
            Some("pkg/store.py".to_string()),
            None,
        ];
        assert_eq!(actual, expected);
    }

    #[test]
    fn rust_paths_resolve_crate_self_and_child_modules() {
        let (_dir, resolver) = fixture(&[
            "crates/x/Cargo.toml",
            "crates/x/src/lib.rs",
            "crates/x/src/store.rs",
            "crates/x/src/parser/javascript.rs",
            "crates/x/src/parser.rs",
        ])
        .unwrap();
        let from = "crates/x/src/lib.rs";
        let resolve =
            |from: &str, path: &str| resolver.resolve(from, &rust_use(path), &mut Probes::new());
        let actual = vec![
            resolve(from, "crate::store::Store"),
            resolve(from, "crate::parser::javascript::extract"),
            resolve(from, "crate::AstError"),
            resolve("crates/x/src/parser.rs", "self::javascript"),
            resolve(from, "std::collections::HashMap"),
            resolve(from, "super::x"),
        ];
        let expected = vec![
            Some(("crates/x/src/store.rs".to_string(), "Store".to_string())),
            Some((
                "crates/x/src/parser/javascript.rs".to_string(),
                "extract".to_string(),
            )),
            Some(("crates/x/src/lib.rs".to_string(), "AstError".to_string())),
            Some((
                "crates/x/src/parser/javascript.rs".to_string(),
                String::new(),
            )),
            None,
            None,
        ];
        assert_eq!(actual, expected);
        assert_eq!(
            file(
                &resolver,
                "crates/x/src/parser.rs",
                ImportRequest::RustMod {
                    name: "javascript".into()
                }
            ),
            Some("crates/x/src/parser/javascript.rs".to_string())
        );
    }

    #[test]
    fn cpp_includes_and_go_imports() {
        let (dir, resolver) = fixture(&["include/a.hpp", "src/b.h", "internal/db/db.go"]).unwrap();
        std::fs::write(dir.path().join("go.mod"), "module example.com/app\n").unwrap();
        let include = |spec: &str| ImportRequest::CppInclude { spec: spec.into() };
        let go = |spec: &str| ImportRequest::GoImport { spec: spec.into() };
        assert_eq!(
            file(&resolver, "src/main.cpp", include("a.hpp")),
            Some("include/a.hpp".to_string())
        );
        assert_eq!(
            file(&resolver, "src/main.cpp", include("b.h")),
            Some("src/b.h".to_string())
        );
        let mut probes = Probes::new();
        assert_eq!(
            resolver.resolve("main.go", &go("example.com/app/internal/db"), &mut probes),
            Some(("internal/db".to_string(), String::new()))
        );
        assert_eq!(probes.into_iter().collect::<Vec<_>>(), vec!["internal/db"]);
        assert_eq!(file(&resolver, "main.go", go("github.com/other/db")), None);
    }

    #[test]
    fn only_indexed_sources_and_confined_files_are_targets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let outside = dir.path().join("outside");
        for path in [
            root.join("src/kept.ts"),
            root.join("src/ignored.ts"),
            root.join("src/data.json"),
            root.join("internal/db/db.go"),
            root.join("internal/api/api.go"),
            outside.join("provider.ts"),
            outside.join("data.json"),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        std::fs::write(root.join("go.mod"), "module example.com/app\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
            std::os::unix::fs::symlink(outside.join("provider.ts"), root.join("src/alias.ts"))
                .unwrap();
        }
        // On disk but excluded from the index: ignored.ts, db.go, the links.
        let indexed = ["src/kept.ts", "internal/api/api.go"].map(String::from);
        let resolver = Resolver::new(&root, indexed);
        let from = "src/app.ts";
        let mut probes = Probes::new();
        let go = |spec: &str| ImportRequest::GoImport { spec: spec.into() };
        let actual = vec![
            file(&resolver, from, script("./kept")),
            file(&resolver, from, script("./data.json")),
            file(&resolver, from, script("../linked/provider.ts")),
            file(&resolver, from, script("../linked/data.json")),
            file(&resolver, from, script("./alias")),
            file(&resolver, "main.go", go("example.com/app/internal/api")),
            file(&resolver, "main.go", go("example.com/app/internal/db")),
            resolver
                .resolve(from, &script("./ignored"), &mut probes)
                .map(|(path, _)| path),
        ];
        let expected = vec![
            Some("src/kept.ts".to_string()),
            Some("src/data.json".to_string()),
            None,
            None,
            None,
            Some("internal/api".to_string()),
            None,
            None,
        ];
        assert_eq!(actual, expected);
        // The excluded file is still probed, so indexing it later re-links.
        assert!(probes.contains("src/ignored.ts"));
    }
}
