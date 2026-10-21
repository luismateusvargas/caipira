//! Rust declarations: items, inline modules, trait items, and impl methods.
//!
//! Methods are qualified by their impl or trait type (`Store::index`). An
//! impl block is a container, not a symbol; `impl Trait for Type` records an
//! `implements` edge. Public means a plain `pub` visibility; methods of a
//! trait impl are public because they implement the trait's contract.

use std::collections::HashSet;

use tree_sitter::Node;

use super::{
    Ctx, Decl, EdgeKind, ParamSignature, collapse_ws, generic_names, named_children,
    strip_angle_groups,
};
use crate::resolve::ImportRequest;

pub(super) fn extract(ctx: &mut Ctx, root: Node) {
    items(ctx, root, None);
}

/// The type a function is a member of, if any.
struct Owner<'s> {
    qualified: &'s str,
    /// Visibility imposed by a trait or trait impl; `None` means "read `pub`".
    public: Option<bool>,
    generics: &'s HashSet<String>,
}

fn items(ctx: &mut Ctx, container: Node, module: Option<&str>) {
    for node in named_children(container) {
        item(ctx, node, module);
    }
}

fn item(ctx: &mut Ctx, node: Node, module: Option<&str>) {
    match node.kind() {
        "function_item" | "function_signature_item" => function(ctx, node, module, None),
        "struct_item" => {
            simple(ctx, node, module, "struct");
        }
        "enum_item" => {
            simple(ctx, node, module, "enum");
        }
        "union_item" => {
            simple(ctx, node, module, "union");
        }
        "type_item" => {
            simple(ctx, node, module, "type");
        }
        "const_item" => {
            simple(ctx, node, module, "const");
        }
        "static_item" => {
            simple(ctx, node, module, "static");
        }
        "macro_definition" => {
            simple(ctx, node, module, "macro");
        }
        "trait_item" => trait_item(ctx, node, module),
        "impl_item" => impl_item(ctx, node, module),
        "mod_item" => mod_item(ctx, node, module),
        "use_declaration" => use_declaration(ctx, node),
        "foreign_mod_item" => {
            if let Some(body) = node.child_by_field_name("body") {
                items(ctx, body, module);
            }
        }
        "expression_statement" | "macro_invocation" => ctx.collect_calls(node, None, None, None),
        _ => {}
    }
}

fn is_pub(ctx: &Ctx, node: Node) -> bool {
    named_children(node)
        .iter()
        .any(|c| c.kind() == "visibility_modifier" && ctx.text(*c) == "pub")
}

fn simple(ctx: &mut Ctx, node: Node, scope: Option<&str>, kind: &'static str) -> Option<String> {
    let name = node.child_by_field_name("name").map(|n| ctx.text(n))?;
    let body = node
        .child_by_field_name("body")
        .or_else(|| node.child_by_field_name("value"));
    let mut decl = Decl::new(node, name, kind);
    decl.is_public = is_pub(ctx, node) || kind == "macro" && has_macro_export(ctx, node);
    decl.scope = scope.map(str::to_string);
    decl.header = ctx.header(node, body);
    Some(ctx.push(decl))
}

fn has_macro_export(ctx: &Ctx, node: Node) -> bool {
    let mut cursor = node.prev_sibling();
    while let Some(prev) = cursor.filter(|p| p.kind() == "attribute_item") {
        if ctx.text(prev).contains("macro_export") {
            return true;
        }
        cursor = prev.prev_sibling();
    }
    false
}

fn function(ctx: &mut Ctx, node: Node, module: Option<&str>, owner: Option<&Owner>) {
    let Some(name) = node.child_by_field_name("name").map(|n| ctx.text(n)) else {
        return;
    };
    let params_node = node.child_by_field_name("parameters");
    let return_node = node.child_by_field_name("return_type");
    let body = node.child_by_field_name("body");

    let mut decl = Decl::new(
        node,
        name,
        if owner.is_some() {
            "method"
        } else {
            "function"
        },
    );
    decl.is_public = owner
        .and_then(|o| o.public)
        .unwrap_or_else(|| is_pub(ctx, node));
    decl.scope = owner.map(|o| o.qualified).or(module).map(str::to_string);
    decl.params = params_node.map(|p| params(ctx, p)).unwrap_or_default();
    decl.return_type = return_node.map(|r| collapse_ws(&ctx.text(r)));
    decl.header = ctx.header(node, body);
    let qualified = ctx.push(decl);

    let mut generics = generic_names(ctx, node.child_by_field_name("type_parameters"));
    if let Some(owner) = owner {
        generics.extend(owner.generics.iter().cloned());
    }
    if let Some(list) = params_node {
        for param in named_children(list) {
            if let Some(annotation) = param.child_by_field_name("type") {
                ctx.type_refs(annotation, &qualified, &generics);
            }
        }
    }
    if let Some(annotation) = return_node {
        ctx.type_refs(annotation, &qualified, &generics);
    }
    if let Some(body) = body {
        ctx.collect_calls(body, Some(&qualified), owner.map(|o| o.qualified), None);
    }
}

fn params(ctx: &Ctx, list: Node) -> Vec<ParamSignature> {
    let text = |n: Node| collapse_ws(&ctx.text(n));
    named_children(list)
        .into_iter()
        .filter_map(|param| match param.kind() {
            "parameter" => {
                let pattern = param.child_by_field_name("pattern")?;
                let mut sig = ParamSignature::new(text(pattern));
                sig.type_annotation = param.child_by_field_name("type").map(text);
                Some(sig)
            }
            "self_parameter" | "variadic_parameter" => Some(ParamSignature::new(text(param))),
            // Closure-style untyped parameters and attributes carry no signature.
            _ => None,
        })
        .collect()
}

fn trait_item(ctx: &mut Ctx, node: Node, module: Option<&str>) {
    let Some(qualified) = simple(ctx, node, module, "trait") else {
        return;
    };
    let public = is_pub(ctx, node);
    if let Some(bounds) = node.child_by_field_name("bounds") {
        for bound in named_children(bounds)
            .into_iter()
            .filter(|b| is_type_path(b.kind()))
        {
            ctx.type_edge(EdgeKind::Extends, &qualified, module, bound);
        }
    }
    let generics = generic_names(ctx, node.child_by_field_name("type_parameters"));
    let owner = Owner {
        qualified: &qualified,
        public: Some(public),
        generics: &generics,
    };
    let Some(body) = node.child_by_field_name("body") else {
        return;
    };
    for member in named_children(body) {
        if matches!(member.kind(), "function_item" | "function_signature_item") {
            function(ctx, member, module, Some(&owner));
        }
    }
}

fn impl_item(ctx: &mut Ctx, node: Node, module: Option<&str>) {
    let Some(type_node) = node.child_by_field_name("type") else {
        return;
    };
    let type_name = strip_angle_groups(&ctx.text(type_node).replace(char::is_whitespace, ""));
    let type_name = type_name.trim_start_matches(['&', '*']).to_string();
    let qualified = ctx.qualify(module, &type_name);
    let trait_node = node.child_by_field_name("trait");
    if let Some(trait_node) = trait_node {
        ctx.type_edge(EdgeKind::Implements, &qualified, module, trait_node);
    }
    let generics = generic_names(ctx, node.child_by_field_name("type_parameters"));
    let public = trait_node.map(|_| true);
    let owner = Owner {
        qualified: &qualified,
        public,
        generics: &generics,
    };
    let Some(body) = node.child_by_field_name("body") else {
        return;
    };
    for member in named_children(body) {
        match member.kind() {
            "function_item" | "function_signature_item" => {
                function(ctx, member, module, Some(&owner));
            }
            "const_item" => {
                simple(ctx, member, Some(&qualified), "const");
            }
            "type_item" => {
                simple(ctx, member, Some(&qualified), "type");
            }
            _ => {}
        }
    }
}

fn mod_item(ctx: &mut Ctx, node: Node, module: Option<&str>) {
    let Some(name) = node.child_by_field_name("name").map(|n| ctx.text(n)) else {
        return;
    };
    match node.child_by_field_name("body") {
        Some(body) => {
            let Some(qualified) = simple(ctx, node, module, "module") else {
                return;
            };
            items(ctx, body, Some(&qualified));
        }
        None => {
            // `mod walker;` pulls in walker.rs or walker/mod.rs.
            let target = ctx.request(ImportRequest::RustMod { name: name.clone() });
            ctx.import_edge(&name, Some(target), Ctx::line(node));
            let imported = name.clone();
            ctx.bind(name, target, imported, true);
        }
    }
}

fn use_declaration(ctx: &mut Ctx, node: Node) {
    if let Some(argument) = node.child_by_field_name("argument") {
        use_tree(ctx, argument, "", Ctx::line(node));
    }
}

fn use_tree(ctx: &mut Ctx, node: Node, prefix: &str, line: usize) {
    let join = |path: &str| {
        if prefix.is_empty() {
            path.to_string()
        } else {
            format!("{prefix}::{path}")
        }
    };
    match node.kind() {
        "scoped_use_list" => {
            let path = node.child_by_field_name("path").map(|p| join(&ctx.text(p)));
            let path = path.unwrap_or_else(|| prefix.to_string());
            if let Some(list) = node.child_by_field_name("list") {
                use_tree(ctx, list, &path, line);
            }
        }
        "use_list" => {
            for child in named_children(node) {
                use_tree(ctx, child, prefix, line);
            }
        }
        "use_as_clause" => {
            let path = node.child_by_field_name("path").map(|p| join(&ctx.text(p)));
            let alias = node.child_by_field_name("alias").map(|a| ctx.text(a));
            if let Some(path) = path {
                use_leaf(ctx, &path, alias, line);
            }
        }
        "use_wildcard" => {
            let module = named_children(node)
                .into_iter()
                .next()
                .map(|m| join(&ctx.text(m)));
            let module = module.unwrap_or_else(|| prefix.to_string());
            let target = ctx.request(ImportRequest::RustUse {
                path: module.clone(),
            });
            ctx.import_edge(&format!("{module}::*"), Some(target), line);
        }
        "self" => use_leaf(ctx, prefix, None, line),
        _ => use_leaf(ctx, &join(&collapse_ws(&ctx.text(node))), None, line),
    }
}

fn use_leaf(ctx: &mut Ctx, path: &str, alias: Option<String>, line: usize) {
    let target = ctx.request(ImportRequest::RustUse {
        path: path.to_string(),
    });
    ctx.import_edge(path, Some(target), line);
    let local = alias.unwrap_or_else(|| path.rsplit("::").next().unwrap_or(path).to_string());
    ctx.bind_use(local, target);
}

fn is_type_path(kind: &str) -> bool {
    matches!(
        kind,
        "type_identifier" | "scoped_type_identifier" | "generic_type"
    )
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::super::test_support::{edges, parse, s, symbol};
    use super::super::*;

    const SOURCE: &str = r#"use crate::store::{self, Store as Db};
mod walker;

/// Walks the workspace.
///
/// Skips ignored files.
#[derive(Debug)]
pub struct Indexer<T> {
    db: T,
}

pub trait Run: Send {
    /// Runs once.
    fn run(&self, limit: usize) -> bool;
}

impl<T> Run for Indexer<T> {
    fn run(&self, limit: usize) -> bool {
        self.flush();
        store::open(limit);
        Db::new();
        walker::walk(limit)
    }
}

impl<T> Indexer<T> {
    pub fn new(db: T) -> Self { Self { db } }
    fn flush(&self) {}
}

pub(crate) fn index<'a, T: Clone>(mut root: &'a Path, (a, b): (i32, i32)) -> Result<Vec<T>, AstError> {
    todo!()
}

mod tests {
    fn helper() {}
}
"#;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        std::fs::write(dir.path().join("src/store.rs"), "").unwrap();
        std::fs::write(dir.path().join("src/walker.rs"), "").unwrap();
        dir
    }

    #[test]
    fn rust_symbols_carry_params_returns_and_docs() {
        let dir = fixture();
        let actual = parse(dir.path(), "src/lib.rs", SOURCE);

        let names: Vec<_> = actual
            .symbols
            .iter()
            .map(|s| (s.qualified_name.as_str(), s.kind.as_str(), s.is_public))
            .collect();
        assert_eq!(
            names,
            vec![
                ("Indexer", "struct", true),
                ("Run", "trait", true),
                ("Run::run", "method", true),
                ("Indexer::run", "method", true),
                ("Indexer::new", "method", true),
                ("Indexer::flush", "method", false),
                ("index", "function", false),
                ("tests", "module", false),
                ("tests::helper", "function", false),
            ]
        );
        let indexer = symbol(&actual, "Indexer");
        assert_eq!(indexer.doc_summary, s("Walks the workspace."));
        assert_eq!((indexer.start_line, indexer.end_line), (8, 10));
        assert_eq!(indexer.signature_text, "pub struct Indexer<T>");
        assert_eq!(symbol(&actual, "Run::run").doc_summary, s("Runs once."));

        let expected = SymbolSignature::default()
            .name("index")
            .qualified_name("index")
            .kind("function")
            .start_line(31usize)
            .end_line(33usize)
            .params(vec![
                ParamSignature::new("root").type_annotation("&'a Path"),
                ParamSignature::new("(a, b)").type_annotation("(i32, i32)"),
            ])
            .return_type("Result<Vec<T>, AstError>")
            .signature_text(
                "pub(crate) fn index<'a, T: Clone>(mut root: &'a Path, (a, b): (i32, i32)) -> Result<Vec<T>, AstError>",
            )
            .hashed();
        assert_eq!(symbol(&actual, "index"), &expected);
        assert_eq!(
            symbol(&actual, "Indexer::run").params[0],
            ParamSignature::new("&self")
        );
    }

    #[test]
    fn rust_edges_resolve_crate_paths_and_modules() {
        let dir = fixture();
        let actual = parse(dir.path(), "src/lib.rs", SOURCE);

        assert_eq!(
            edges(&actual, EdgeKind::Imports),
            vec![
                (None, s("src/store.rs"), "crate::store".to_string()),
                (None, s("src/store.rs"), "crate::store::Store".to_string()),
                (None, s("src/walker.rs"), "walker".to_string()),
            ]
        );
        let calls: Vec<_> = edges(&actual, EdgeKind::Calls)
            .into_iter()
            .filter(|e| e.0 == s("Indexer::run"))
            .map(|e| (e.1, e.2))
            .collect();
        assert_eq!(
            calls,
            vec![
                (s("src/lib.rs"), "Indexer::flush".to_string()),
                (s("src/store.rs"), "open".to_string()),
                (s("src/store.rs"), "Store::new".to_string()),
                (s("src/walker.rs"), "walk".to_string()),
            ]
        );
        assert_eq!(
            edges(&actual, EdgeKind::Implements),
            vec![(s("Indexer"), s("src/lib.rs"), "Run".to_string())]
        );
        assert_eq!(
            edges(&actual, EdgeKind::Extends),
            vec![(s("Run"), None, "Send".to_string())]
        );
        let uses: Vec<_> = edges(&actual, EdgeKind::UsesType)
            .into_iter()
            .filter(|e| e.0 == s("index"))
            .map(|e| e.2)
            .collect();
        assert_eq!(uses, vec!["Path", "Result", "Vec", "AstError"]);
    }
}
