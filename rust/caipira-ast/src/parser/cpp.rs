//! C and C++ declarations: functions and prototypes, classes, structs,
//! unions, enums, namespaces, and type aliases, through templates, include
//! guards, and `extern "C"` blocks.
//!
//! Class members follow access specifiers (private by default in a class,
//! public in a struct or union). Namespace-scope functions are public unless
//! `static` or inside an anonymous namespace. An out-of-line definition such
//! as `int Store::count()` is reported as a method of its qualifier.

use std::collections::HashSet;

use tree_sitter::Node;

use super::{
    Ctx, Decl, EdgeKind, ParamSignature, children, collapse_ws, generic_names, lossy,
    named_children, strip_angle_groups,
};
use crate::resolve::ImportRequest;

pub(super) fn extract(ctx: &mut Ctx, root: Node) {
    let mut namespaces = HashSet::new();
    items(
        ctx,
        root,
        Scope {
            qualified: None,
            public: true,
        },
        &mut namespaces,
    );
}

/// The namespace items are declared in.
#[derive(Clone, Copy)]
struct Scope<'s> {
    qualified: Option<&'s str>,
    public: bool,
}

/// Where a function is declared: a namespace or a class body.
#[derive(Clone, Copy)]
enum Owner<'s> {
    Namespace(Scope<'s>),
    Class { qualified: &'s str, public: bool },
}

const RECORDS: &[&str] = &[
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
];

fn items(ctx: &mut Ctx, container: Node, scope: Scope, namespaces: &mut HashSet<String>) {
    for node in named_children(container) {
        item(ctx, node, node, scope, namespaces);
    }
}

fn item(ctx: &mut Ctx, node: Node, anchor: Node, scope: Scope, namespaces: &mut HashSet<String>) {
    match node.kind() {
        "function_definition" => function(ctx, node, anchor, Owner::Namespace(scope)),
        "declaration" => declaration(ctx, node, anchor, Owner::Namespace(scope), namespaces),
        kind if RECORDS.contains(&kind) => {
            record(ctx, node, anchor, Owner::Namespace(scope), namespaces)
        }
        "namespace_definition" => namespace(ctx, node, scope, namespaces),
        "template_declaration" => {
            if let Some(inner) = named_children(node)
                .into_iter()
                .rev()
                .find(|n| is_templatable(n.kind()))
            {
                item(ctx, inner, node, scope, namespaces);
            }
        }
        "linkage_specification" => {
            let Some(body) = node.child_by_field_name("body") else {
                return;
            };
            if body.kind() == "declaration_list" {
                items(ctx, body, scope, namespaces);
            } else {
                item(ctx, body, node, scope, namespaces);
            }
        }
        "preproc_ifdef" | "preproc_if" | "preproc_else" | "preproc_elif" | "preproc_elifdef" => {
            items(ctx, node, scope, namespaces);
        }
        "preproc_include" => include(ctx, node),
        "type_definition" | "alias_declaration" => {
            alias(ctx, node, anchor, scope.qualified, scope.public)
        }
        _ => {}
    }
}

fn is_templatable(kind: &str) -> bool {
    matches!(
        kind,
        "function_definition" | "declaration" | "alias_declaration"
    ) || RECORDS.contains(&kind)
        || kind == "field_declaration"
}

fn is_static(ctx: &Ctx, node: Node) -> bool {
    named_children(node)
        .iter()
        .any(|c| c.kind() == "storage_class_specifier" && ctx.text(*c) == "static")
}

/// A function declarator with the pointer/reference markers that wrap it,
/// which belong to the return type (`const char* name()`).
struct FunctionDeclarator<'t> {
    function: Node<'t>,
    name: Node<'t>,
    return_suffix: String,
}

fn function_declarator<'t>(ctx: &Ctx, declarator: Node<'t>) -> Option<FunctionDeclarator<'t>> {
    let mut node = declarator;
    let mut suffix = String::new();
    loop {
        match node.kind() {
            "function_declarator" => {
                let name = node.child_by_field_name("declarator")?;
                return Some(FunctionDeclarator {
                    function: node,
                    name,
                    return_suffix: suffix,
                });
            }
            "pointer_declarator" => {
                suffix.push('*');
                node = node.child_by_field_name("declarator")?;
            }
            "reference_declarator" => {
                suffix.push_str(if ctx.text(node).starts_with("&&") {
                    "&&"
                } else {
                    "&"
                });
                node = named_children(node).into_iter().last()?;
            }
            "parenthesized_declarator" => node = named_children(node).into_iter().next()?,
            _ => return None,
        }
    }
}

fn function(ctx: &mut Ctx, node: Node, anchor: Node, owner: Owner) {
    let Some(declarator) = node.child_by_field_name("declarator") else {
        return;
    };
    let Some(found) = function_declarator(ctx, declarator) else {
        return;
    };
    let body = node.child_by_field_name("body");
    function_symbol(ctx, node, anchor, owner, found, body);
}

fn function_symbol(
    ctx: &mut Ctx,
    node: Node,
    anchor: Node,
    owner: Owner,
    found: FunctionDeclarator,
    body: Option<Node>,
) {
    let full_name = strip_angle_groups(&ctx.text(found.name).replace(char::is_whitespace, ""));
    let (qualifier, name) = match full_name.rsplit_once("::") {
        Some((qualifier, name)) if !qualifier.is_empty() => {
            (Some(qualifier.to_string()), name.to_string())
        }
        _ => (None, full_name.trim_start_matches("::").to_string()),
    };
    let (owner_scope, kind, public) = match owner {
        Owner::Class { qualified, public } => (Some(qualified), "method", public),
        Owner::Namespace(scope) => {
            let kind = if qualifier.is_some() {
                "method"
            } else {
                "function"
            };
            (scope.qualified, kind, scope.public && !is_static(ctx, node))
        }
    };
    let scope = match (owner_scope, qualifier) {
        (Some(outer), Some(q)) if !q.starts_with(outer) => Some(format!("{outer}::{q}")),
        (_, Some(q)) => Some(q),
        (outer, None) => outer.map(str::to_string),
    };

    let params_node = found.function.child_by_field_name("parameters");
    let mut decl = Decl::new(anchor, name, kind);
    decl.is_public = public;
    decl.scope = scope.clone();
    decl.params = params_node.map(|p| params(ctx, p)).unwrap_or_default();
    decl.return_type = return_type(ctx, node, &found);
    decl.header = ctx.header(anchor, body);
    let qualified = ctx.push(decl);

    let generics = template_generics(ctx, anchor);
    if let Some(list) = params_node {
        for param in named_children(list) {
            if let Some(annotation) = param.child_by_field_name("type") {
                ctx.type_refs(annotation, &qualified, &generics);
            }
        }
    }
    if let Some(annotation) = node.child_by_field_name("type") {
        ctx.type_refs(annotation, &qualified, &generics);
    }
    if let Some(body) = body {
        ctx.collect_calls(body, Some(&qualified), scope.as_deref(), None);
    }
}

fn template_generics(ctx: &Ctx, anchor: Node) -> HashSet<String> {
    if anchor.kind() != "template_declaration" {
        return HashSet::new();
    }
    generic_names(ctx, anchor.child_by_field_name("parameters"))
}

fn return_type(ctx: &Ctx, node: Node, found: &FunctionDeclarator) -> Option<String> {
    let trailing = children(found.function)
        .into_iter()
        .find(|n| n.kind() == "trailing_return_type")
        .and_then(|t| named_children(t).into_iter().next());
    let declared = node.child_by_field_name("type")?;
    if let Some(trailing) = trailing.filter(|_| declared.kind() == "placeholder_type_specifier") {
        return Some(collapse_ws(&ctx.text(trailing)));
    }
    let qualifiers: Vec<String> = children(node)
        .into_iter()
        .take_while(|c| c.id() != declared.id())
        .filter(|c| c.kind() == "type_qualifier")
        .map(|c| ctx.text(c))
        .collect();
    let mut text = qualifiers.join(" ");
    if !text.is_empty() {
        text.push(' ');
    }
    text.push_str(&collapse_ws(&ctx.text(declared)));
    text.push_str(&found.return_suffix);
    Some(text)
}

fn params(ctx: &Ctx, list: Node) -> Vec<ParamSignature> {
    let mut out = Vec::new();
    for param in children(list) {
        match param.kind() {
            "parameter_declaration"
            | "optional_parameter_declaration"
            | "variadic_parameter_declaration" => {
                out.push(param_signature(ctx, param));
            }
            "..." => out.push(ParamSignature::new("...")),
            _ => {}
        }
    }
    out
}

fn param_signature(ctx: &Ctx, param: Node) -> ParamSignature {
    let default = param.child_by_field_name("default_value");
    let name = param
        .child_by_field_name("declarator")
        .and_then(declared_identifier);
    // The type is the parameter text minus its name and default value:
    // `const std::string& path = "x"` -> `const std::string&`.
    let end = default.map_or(param.end_byte(), |d| d.start_byte());
    let mut type_text = String::new();
    let start = param.start_byte();
    match name {
        Some(name) => {
            type_text.push_str(&lossy(&ctx.src[start..name.start_byte()]));
            type_text.push_str(&lossy(&ctx.src[name.end_byte()..end.max(name.end_byte())]));
        }
        None => type_text.push_str(&lossy(&ctx.src[start..end])),
    }
    let type_text = collapse_ws(type_text.trim().trim_end_matches('=').trim());
    let mut sig = ParamSignature::new(name.map(|n| ctx.text(n)).unwrap_or_default());
    sig.type_annotation = Some(type_text).filter(|t| !t.is_empty());
    sig.default_value = default.map(|d| collapse_ws(&ctx.text(d)));
    sig
}

/// The identifier a (possibly pointer/reference/array) declarator declares.
fn declared_identifier(declarator: Node) -> Option<Node> {
    let mut node = declarator;
    loop {
        match node.kind() {
            "identifier" | "field_identifier" => return Some(node),
            _ => {
                node = node.child_by_field_name("declarator").or_else(|| {
                    named_children(node)
                        .into_iter()
                        .find(|n| n.kind().ends_with("declarator") || n.kind() == "identifier")
                })?;
            }
        }
    }
}

/// A `declaration` or class `field_declaration`: function prototypes and
/// records defined inline (`struct P { ... } p;`). Variables are not symbols.
fn declaration(
    ctx: &mut Ctx,
    node: Node,
    anchor: Node,
    owner: Owner,
    namespaces: &mut HashSet<String>,
) {
    if let Some(type_node) = node.child_by_field_name("type")
        && RECORDS.contains(&type_node.kind())
        && type_node.child_by_field_name("body").is_some()
    {
        record(ctx, type_node, anchor, owner, namespaces);
    }
    let mut cursor = node.walk();
    let declarators: Vec<Node> = node
        .children_by_field_name("declarator", &mut cursor)
        .collect();
    for declarator in declarators {
        if let Some(found) = function_declarator(ctx, declarator) {
            function_symbol(ctx, node, anchor, owner, found, None);
        }
    }
}

fn record(ctx: &mut Ctx, node: Node, anchor: Node, owner: Owner, namespaces: &mut HashSet<String>) {
    let (Some(name_node), Some(body)) = (
        node.child_by_field_name("name"),
        node.child_by_field_name("body"),
    ) else {
        return;
    };
    let kind = match node.kind() {
        "class_specifier" => "class",
        "struct_specifier" => "struct",
        "union_specifier" => "union",
        _ => "enum",
    };
    let (scope, public) = match owner {
        Owner::Class { qualified, public } => (Some(qualified), public),
        Owner::Namespace(scope) => (scope.qualified, scope.public),
    };
    let name = strip_angle_groups(&ctx.text(name_node).replace(char::is_whitespace, ""));
    let mut decl = Decl::new(anchor, name, kind);
    decl.is_public = public;
    decl.scope = scope.map(str::to_string);
    decl.header = ctx.header(anchor, Some(body));
    let qualified = ctx.push(decl);

    let bases = named_children(node)
        .into_iter()
        .find(|n| n.kind() == "base_class_clause");
    for base in bases.into_iter().flat_map(named_children) {
        if matches!(
            base.kind(),
            "type_identifier" | "qualified_identifier" | "template_type"
        ) {
            ctx.type_edge(EdgeKind::Extends, &qualified, scope, base);
        }
    }
    if kind != "enum" {
        members(ctx, body, &qualified, public, kind != "class", namespaces);
    }
}

fn members(
    ctx: &mut Ctx,
    body: Node,
    class: &str,
    class_public: bool,
    default_public: bool,
    namespaces: &mut HashSet<String>,
) {
    let mut access_public = default_public;
    for member in named_children(body) {
        let owner = Owner::Class {
            qualified: class,
            public: class_public && access_public,
        };
        member_item(ctx, member, member, owner, &mut access_public, namespaces);
    }
}

fn member_item(
    ctx: &mut Ctx,
    member: Node,
    anchor: Node,
    owner: Owner,
    access_public: &mut bool,
    namespaces: &mut HashSet<String>,
) {
    match member.kind() {
        "access_specifier" => *access_public = ctx.text(member).trim().starts_with("public"),
        "function_definition" => function(ctx, member, anchor, owner),
        "field_declaration" | "declaration" => declaration(ctx, member, anchor, owner, namespaces),
        "template_declaration" => {
            if let Some(inner) = named_children(member)
                .into_iter()
                .rev()
                .find(|n| is_templatable(n.kind()))
            {
                member_item(ctx, inner, member, owner, access_public, namespaces);
            }
        }
        kind if RECORDS.contains(&kind) => record(ctx, member, anchor, owner, namespaces),
        _ => {}
    }
}

fn namespace(ctx: &mut Ctx, node: Node, scope: Scope, namespaces: &mut HashSet<String>) {
    let Some(body) = node.child_by_field_name("body") else {
        return;
    };
    let Some(name_node) = node.child_by_field_name("name") else {
        // Anonymous namespaces give their members internal linkage.
        items(
            ctx,
            body,
            Scope {
                qualified: scope.qualified,
                public: false,
            },
            namespaces,
        );
        return;
    };
    let name = ctx.text(name_node).replace(char::is_whitespace, "");
    let qualified = ctx.qualify(scope.qualified, &name);
    // A namespace reopened in the same file is one symbol.
    if namespaces.insert(qualified.clone()) {
        let mut decl = Decl::new(node, name, "namespace");
        decl.is_public = scope.public;
        decl.scope = scope.qualified.map(str::to_string);
        decl.header = ctx.header(node, Some(body));
        ctx.push(decl);
    }
    items(
        ctx,
        body,
        Scope {
            qualified: Some(&qualified),
            public: scope.public,
        },
        namespaces,
    );
}

fn alias(ctx: &mut Ctx, node: Node, anchor: Node, scope: Option<&str>, public: bool) {
    let name_node = match node.kind() {
        "alias_declaration" => node.child_by_field_name("name"),
        _ => node.child_by_field_name("declarator"),
    };
    let Some(name_node) = name_node.filter(|n| n.kind() == "type_identifier") else {
        return;
    };
    let mut decl = Decl::new(anchor, ctx.text(name_node), "type");
    decl.is_public = public;
    decl.scope = scope.map(str::to_string);
    decl.header = ctx.header(anchor, None);
    ctx.push(decl);
}

fn include(ctx: &mut Ctx, node: Node) {
    let Some(path) = node.child_by_field_name("path") else {
        return;
    };
    let line = Ctx::line(node);
    if path.kind() == "system_lib_string" {
        ctx.import_edge(&ctx.text(path), None, line);
        return;
    }
    let spec = ctx.text(path).trim_matches('"').to_string();
    let target = ctx.request(ImportRequest::CppInclude { spec: spec.clone() });
    ctx.import_edge(&spec, Some(target), line);
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::super::test_support::{edges, parse, s, symbol};
    use super::super::*;

    const HEADER: &str = r#"#ifndef STORE_HPP
#define STORE_HPP
#include "base.hpp"
#include <vector>

namespace caipira {
/// Indexes files.
class Store : public Base {
public:
  explicit Store(const std::string& root, int depth = 3);
  std::vector<int> index(int* out, ...) const;
  const char* name() const { return label(); }
private:
  const char* label() const;
};
}

static int clamp(int value) { return value; }
template <typename T> T identity(T value) { return value; }
typedef unsigned long Id;
#endif
"#;

    const SOURCE: &str = r#"#include "store.hpp"

namespace caipira {
// Walks the tree.
std::vector<int> Store::index(int* out, ...) const {
  helper(out);
  return walk(*out);
}
}
"#;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("include")).unwrap();
        std::fs::write(dir.path().join("include/base.hpp"), "").unwrap();
        std::fs::write(dir.path().join("include/store.hpp"), HEADER).unwrap();
        dir
    }

    #[test]
    fn cpp_header_symbols_follow_access_and_linkage() {
        let dir = fixture();
        let actual = parse(dir.path(), "include/store.hpp", HEADER);
        let names: Vec<_> = actual
            .symbols
            .iter()
            .map(|s| (s.qualified_name.as_str(), s.kind.as_str(), s.is_public))
            .collect();
        assert_eq!(
            names,
            vec![
                ("caipira", "namespace", true),
                ("caipira::Store", "class", true),
                ("caipira::Store::Store", "method", true),
                ("caipira::Store::index", "method", true),
                ("caipira::Store::name", "method", true),
                ("caipira::Store::label", "method", false),
                ("clamp", "function", false),
                ("identity", "function", true),
                ("Id", "type", true),
            ]
        );
        let store = symbol(&actual, "caipira::Store");
        assert_eq!(store.doc_summary, s("Indexes files."));
        assert_eq!(store.signature_text, "class Store : public Base");
        assert_eq!((store.start_line, store.end_line), (8, 15));

        let ctor = symbol(&actual, "caipira::Store::Store");
        assert_eq!(
            ctor.params,
            vec![
                ParamSignature::new("root").type_annotation("const std::string&"),
                ParamSignature::new("depth")
                    .type_annotation("int")
                    .default_value("3"),
            ]
        );
        assert_eq!(ctor.return_type, None);
        let index = symbol(&actual, "caipira::Store::index");
        assert_eq!(
            index.params,
            vec![
                ParamSignature::new("out").type_annotation("int*"),
                ParamSignature::new("...")
            ]
        );
        assert_eq!(index.return_type, s("std::vector<int>"));
        assert_eq!(
            symbol(&actual, "caipira::Store::name").return_type,
            s("const char*")
        );
        assert_eq!(
            symbol(&actual, "identity").signature_text,
            "template <typename T> T identity(T value)"
        );
        assert!(
            edges(&actual, EdgeKind::UsesType)
                .iter()
                .all(|e| e.2 != "T")
        );
        assert_eq!(
            edges(&actual, EdgeKind::Imports),
            vec![
                (None, s("include/base.hpp"), "base.hpp".to_string()),
                (None, None, "<vector>".to_string())
            ]
        );
        assert_eq!(
            edges(&actual, EdgeKind::Extends),
            vec![(s("caipira::Store"), None, "Base".to_string())]
        );
        assert!(edges(&actual, EdgeKind::Calls).contains(&(
            s("caipira::Store::name"),
            s("include/store.hpp"),
            "caipira::Store::label".to_string()
        )));
    }

    #[test]
    fn cpp_out_of_line_method_definition() {
        let dir = fixture();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        let actual = parse(dir.path(), "src/store.cpp", SOURCE);
        let index = symbol(&actual, "caipira::Store::index");
        assert_eq!(
            (index.kind.as_str(), index.start_line, index.end_line),
            ("method", 5, 8)
        );
        assert_eq!(index.doc_summary, s("Walks the tree."));
        assert_eq!(
            edges(&actual, EdgeKind::Imports),
            vec![(None, s("include/store.hpp"), "store.hpp".to_string())]
        );
        let calls: Vec<_> = edges(&actual, EdgeKind::Calls)
            .into_iter()
            .map(|e| e.2)
            .collect();
        assert_eq!(calls, vec!["helper", "walk"]);
    }
}
