//! Resolves import specifiers to workspace-relative files.
//!
//! Resolution is lexical plus a file-existence check under the workspace
//! root; a specifier that would climb above the root never resolves.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Maps import specifiers to workspace files under one root.
#[derive(Debug)]
pub struct Resolver {
    root: PathBuf,
    go_module: OnceLock<Option<String>>,
}

const SCRIPT_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue"];

impl Resolver {
    /// Creates a resolver for a workspace.
    ///
    /// # Arguments
    /// `root`: the workspace root directory.
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            go_module: OnceLock::new(),
        }
    }

    fn is_file(&self, rel: &str) -> bool {
        !rel.is_empty() && self.root.join(rel).is_file()
    }

    fn is_dir(&self, rel: &str) -> bool {
        !rel.is_empty() && self.root.join(rel).is_dir()
    }

    fn first_file(&self, candidates: impl IntoIterator<Item = String>) -> Option<String> {
        candidates.into_iter().find(|c| self.is_file(c))
    }

    /// A relative JS/TS/Vue specifier (`./store.js`, `../workspace`).
    ///
    /// Tries the path as written, TypeScript's `.js` -> `.ts` convention,
    /// each script extension, then `index.*` inside a directory.
    ///
    /// # Arguments
    /// `from`: the importing file. `spec`: the specifier as written.
    pub fn script(&self, from: &str, spec: &str) -> Option<String> {
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
        self.first_file(candidates)
    }

    /// A Python module (`.store`, `..pkg.mod`, `pkg.mod`) to its file.
    ///
    /// # Arguments
    /// `from`: the importing file. `module`: the dotted module as written.
    pub fn python(&self, from: &str, module: &str) -> Option<String> {
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
            return self.python_candidates(&base, segments.is_empty());
        }
        ["", "src"]
            .iter()
            .find_map(|prefix| self.python_candidates(&join_segments(prefix, &segments), false))
    }

    /// `from <module> import <name>` where `name` is itself a submodule.
    ///
    /// # Arguments
    /// `from`: the importing file. `module`: the module as written. `name`: the imported name.
    pub fn python_submodule(&self, from: &str, module: &str, name: &str) -> Option<String> {
        let dotted = if module.chars().all(|c| c == '.') {
            format!("{module}{name}")
        } else {
            format!("{module}.{name}")
        };
        self.python(from, &dotted)
    }

    fn python_candidates(&self, base: &str, is_package_dir: bool) -> Option<String> {
        if is_package_dir {
            return self.first_file([join_segments(base, &["__init__.py"])]);
        }
        if base.is_empty() {
            return None;
        }
        self.first_file([
            format!("{base}.py"),
            format!("{base}.pyi"),
            format!("{base}/__init__.py"),
        ])
    }

    /// `mod name;` declared in `from`.
    ///
    /// # Arguments
    /// `from`: the declaring file. `name`: the module name.
    pub fn rust_mod(&self, from: &str, name: &str) -> Option<String> {
        let dir = rust_module_dir(from);
        self.first_file([
            join_segments(&dir, &[&format!("{name}.rs")]),
            join_segments(&dir, &[name, "mod.rs"]),
        ])
    }

    /// A `use` path to the file defining it and the item path left inside
    /// that file (empty when the path names the module itself).
    ///
    /// Handles `crate::`, `self::`, and child modules of the current module;
    /// `super::` and external crates stay unresolved.
    ///
    /// # Arguments
    /// `from`: the importing file. `path`: the `::`-separated path.
    pub fn rust_use(&self, from: &str, path: &str) -> Option<(String, String)> {
        let segments: Vec<&str> = path.split("::").filter(|s| !s.is_empty()).collect();
        let (base, rest, crate_root) = match segments.first().copied()? {
            "crate" => (self.crate_src(from)?, &segments[1..], true),
            "self" => (rust_module_dir(from), &segments[1..], false),
            "super" => return None,
            _ => (rust_module_dir(from), &segments[..], false),
        };
        for depth in (1..=rest.len()).rev() {
            let module = rest[..depth].join("/");
            let found = self.first_file([
                join_segments(&base, &[&format!("{module}.rs")]),
                join_segments(&base, &[&module, "mod.rs"]),
            ]);
            if let Some(file) = found {
                return Some((file, rest[depth..].join("::")));
            }
        }
        if crate_root && !rest.is_empty() {
            let root_file = self.first_file([
                join_segments(&base, &["lib.rs"]),
                join_segments(&base, &["main.rs"]),
            ])?;
            return Some((root_file, rest.join("::")));
        }
        None
    }

    /// The `src` directory of the crate containing `from`.
    fn crate_src(&self, from: &str) -> Option<String> {
        let mut dir = parent(from).to_string();
        loop {
            if self.is_file(&join_segments(&dir, &["Cargo.toml"])) {
                let src = join_segments(&dir, &["src"]);
                return self.is_dir(&src).then_some(src);
            }
            if dir.is_empty() {
                return None;
            }
            dir = parent(&dir).to_string();
        }
    }

    /// A quoted `#include "x.hpp"`, searched beside the file, at the root,
    /// then under `include/` and `src/`.
    ///
    /// # Arguments
    /// `from`: the including file. `spec`: the path inside the quotes.
    pub fn cpp_include(&self, from: &str, spec: &str) -> Option<String> {
        let candidates = [
            join(parent(from), spec),
            join("", spec),
            join("include", spec),
            join("src", spec),
        ];
        self.first_file(candidates.into_iter().flatten())
    }

    /// A Go import path inside this workspace's module (from `go.mod`), as
    /// the package directory.
    ///
    /// # Arguments
    /// `spec`: the import path.
    pub fn go_import(&self, spec: &str) -> Option<String> {
        let module = self
            .go_module
            .get_or_init(|| read_go_module(&self.root))
            .as_deref()?;
        let rest = spec.strip_prefix(module)?.strip_prefix('/')?;
        let dir = join("", rest)?;
        self.is_dir(&dir).then_some(dir)
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

    fn fixture(files: &[&str]) -> anyhow::Result<tempfile::TempDir> {
        let dir = tempfile::tempdir()?;
        for file in files {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().expect("file has a parent"))?;
            std::fs::write(path, "")?;
        }
        Ok(dir)
    }

    #[test]
    fn script_specifiers_resolve_extensions_and_index_files() {
        let dir = fixture(&["src/store.ts", "src/ui/index.tsx", "lib/util.js"]).unwrap();
        let resolver = Resolver::new(dir.path());
        let actual = vec![
            resolver.script("src/app.ts", "./store.js"),
            resolver.script("src/app.ts", "./store"),
            resolver.script("src/app.ts", "./ui"),
            resolver.script("src/app.ts", "../lib/util.js"),
            resolver.script("src/app.ts", "react"),
            resolver.script("src/app.ts", "../../outside"),
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
    fn python_modules_resolve_relative_and_absolute() {
        let dir = fixture(&[
            "pkg/__init__.py",
            "pkg/store.py",
            "pkg/sub/mod.py",
            "src/lib/core.py",
        ])
        .unwrap();
        let resolver = Resolver::new(dir.path());
        let actual = vec![
            resolver.python("pkg/sub/mod.py", "..store"),
            resolver.python("pkg/a.py", ".store"),
            resolver.python("pkg/a.py", "."),
            resolver.python("x.py", "pkg.sub.mod"),
            resolver.python("x.py", "lib.core"),
            resolver.python_submodule("pkg/a.py", ".", "store"),
            resolver.python_submodule("pkg/a.py", ".store", "Row"),
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
        let dir = fixture(&[
            "crates/x/Cargo.toml",
            "crates/x/src/lib.rs",
            "crates/x/src/store.rs",
            "crates/x/src/parser/javascript.rs",
            "crates/x/src/parser.rs",
        ])
        .unwrap();
        let resolver = Resolver::new(dir.path());
        let from = "crates/x/src/lib.rs";
        let actual = vec![
            resolver.rust_use(from, "crate::store::Store"),
            resolver.rust_use(from, "crate::parser::javascript::extract"),
            resolver.rust_use(from, "crate::AstError"),
            resolver.rust_use("crates/x/src/parser.rs", "self::javascript"),
            resolver.rust_use(from, "std::collections::HashMap"),
            resolver.rust_use(from, "super::x"),
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
            resolver.rust_mod("crates/x/src/parser.rs", "javascript"),
            Some("crates/x/src/parser/javascript.rs".to_string())
        );
    }

    #[test]
    fn cpp_includes_and_go_imports() {
        let dir = fixture(&["include/a.hpp", "src/b.h", "internal/db/db.go"]).unwrap();
        std::fs::write(dir.path().join("go.mod"), "module example.com/app\n").unwrap();
        let resolver = Resolver::new(dir.path());
        assert_eq!(
            resolver.cpp_include("src/main.cpp", "a.hpp"),
            Some("include/a.hpp".to_string())
        );
        assert_eq!(
            resolver.cpp_include("src/main.cpp", "b.h"),
            Some("src/b.h".to_string())
        );
        assert_eq!(
            resolver.go_import("example.com/app/internal/db"),
            Some("internal/db".to_string())
        );
        assert_eq!(resolver.go_import("github.com/other/db"), None);
    }
}
