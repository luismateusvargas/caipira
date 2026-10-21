//! Go declarations: functions, methods (qualified by receiver type), type
//! specs with interface methods, and package-level const/var specs.
//! Exported means the name starts with an upper-case letter.

use std::collections::HashSet;

use tree_sitter::Node;

use super::{Ctx, Decl, EdgeKind, ParamSignature, collapse_ws, generic_names, named_children};
use crate::resolve::ImportRequest;

pub(super) fn extract(ctx: &mut Ctx, root: Node) {
    for node in named_children(root) {
        match node.kind() {
            "import_declaration" => imports(ctx, node),
            "function_declaration" => function(ctx, node, node, None),
            "method_declaration" => method(ctx, node),
            "type_declaration" => types(ctx, node),
            "const_declaration" | "var_declaration" => values(ctx, node),
            "package_clause" | "comment" => {}
            _ => ctx.collect_calls(node, None, None, None),
        }
    }
}

fn exported(name: &str) -> bool {
    name.chars().next().is_some_and(char::is_uppercase)
}

/// A method's receiver: the type it is declared on and the receiver's name.
struct Receiver {
    type_name: String,
    name: Option<String>,
}

fn function(ctx: &mut Ctx, node: Node, anchor: Node, receiver: Option<&Receiver>) {
    let Some(name) = node.child_by_field_name("name").map(|n| ctx.text(n)) else {
        return;
    };
    let params_node = node.child_by_field_name("parameters");
    let result_node = node.child_by_field_name("result");
    let body = node.child_by_field_name("body");

    let mut decl = Decl::new(
        node,
        name,
        if receiver.is_some() {
            "method"
        } else {
            "function"
        },
    );
    decl.doc_anchor = anchor;
    decl.is_public = exported(&decl.name);
    decl.scope = receiver.map(|r| r.type_name.clone());
    decl.params = params_node.map(|p| params(ctx, p)).unwrap_or_default();
    decl.return_type = result_node.map(|r| collapse_ws(&ctx.text(r)));
    decl.header = ctx.header(node, body);
    let qualified = ctx.push(decl);

    let generics = generic_names(ctx, node.child_by_field_name("type_parameters"));
    type_refs(ctx, params_node, result_node, &qualified, &generics);
    if let Some(body) = body {
        let scope = receiver.map(|r| r.type_name.as_str());
        let receiver_name = receiver.and_then(|r| r.name.as_deref());
        ctx.collect_calls(body, Some(&qualified), scope, receiver_name);
    }
}

fn type_refs(
    ctx: &mut Ctx,
    params_node: Option<Node>,
    result_node: Option<Node>,
    source: &str,
    generics: &HashSet<String>,
) {
    for list in [params_node, result_node].into_iter().flatten() {
        if list.kind() != "parameter_list" {
            ctx.type_refs(list, source, generics);
            continue;
        }
        for param in named_children(list) {
            if let Some(annotation) = param.child_by_field_name("type") {
                ctx.type_refs(annotation, source, generics);
            }
        }
    }
}

fn method(ctx: &mut Ctx, node: Node) {
    let receiver = node
        .child_by_field_name("receiver")
        .and_then(|list| named_children(list).into_iter().next())
        .and_then(|param| {
            let type_node = param.child_by_field_name("type")?;
            Some(Receiver {
                type_name: receiver_type(ctx, type_node)?,
                name: param.child_by_field_name("name").map(|n| ctx.text(n)),
            })
        });
    let Some(receiver) = receiver else { return };
    function(ctx, node, node, Some(&receiver));
}

fn receiver_type(ctx: &Ctx, node: Node) -> Option<String> {
    match node.kind() {
        "pointer_type" | "parenthesized_type" => {
            receiver_type(ctx, named_children(node).into_iter().next()?)
        }
        "generic_type" => receiver_type(ctx, node.child_by_field_name("type")?),
        _ => Some(ctx.text(node)),
    }
}

fn params(ctx: &Ctx, list: Node) -> Vec<ParamSignature> {
    let mut out = Vec::new();
    for param in named_children(list) {
        let variadic = param.kind() == "variadic_parameter_declaration";
        if !variadic && param.kind() != "parameter_declaration" {
            continue;
        }
        let type_text = param.child_by_field_name("type").map(|t| {
            let text = collapse_ws(&ctx.text(t));
            if variadic { format!("...{text}") } else { text }
        });
        let mut cursor = param.walk();
        let names: Vec<String> = param
            .children_by_field_name("name", &mut cursor)
            .map(|n| ctx.text(n))
            .collect();
        if names.is_empty() {
            out.push(ParamSignature {
                type_annotation: type_text,
                ..ParamSignature::default()
            });
            continue;
        }
        for name in names {
            let mut sig = ParamSignature::new(name);
            sig.type_annotation = type_text.clone();
            out.push(sig);
        }
    }
    out
}

fn types(ctx: &mut Ctx, declaration: Node) {
    let specs: Vec<Node> = named_children(declaration)
        .into_iter()
        .filter(|n| matches!(n.kind(), "type_spec" | "type_alias"))
        .collect();
    let single = specs.len() == 1;
    for spec in specs {
        let Some(name) = spec.child_by_field_name("name").map(|n| ctx.text(n)) else {
            continue;
        };
        let type_node = spec.child_by_field_name("type");
        let kind = match type_node.map(|t| t.kind()) {
            Some("struct_type") => "struct",
            Some("interface_type") => "interface",
            _ => "type",
        };
        let span = if single { declaration } else { spec };
        let mut decl = Decl::new(span, name, kind);
        decl.is_public = exported(&decl.name);
        decl.header = ctx.header(span, type_node.and_then(open_brace));
        let qualified = ctx.push(decl);
        let Some(type_node) = type_node else { continue };
        match kind {
            "struct" => embedded_fields(ctx, type_node, &qualified),
            "interface" => interface_members(ctx, type_node, &qualified),
            _ => {}
        }
    }
}

/// The `{` that opens a struct or interface body, so headers stop before it.
fn open_brace(type_node: Node) -> Option<Node> {
    let mut stack = vec![type_node];
    while let Some(node) = stack.pop() {
        if node.kind() == "{" {
            return Some(node);
        }
        let mut cursor = node.walk();
        let mut kids: Vec<Node> = node.children(&mut cursor).collect();
        kids.reverse();
        stack.extend(kids);
    }
    None
}

fn embedded_fields(ctx: &mut Ctx, struct_type: Node, qualified: &str) {
    let fields = named_children(struct_type)
        .into_iter()
        .find(|n| n.kind() == "field_declaration_list");
    for field in fields.into_iter().flat_map(named_children) {
        if field.kind() != "field_declaration" || field.child_by_field_name("name").is_some() {
            continue;
        }
        let Some(mut embedded) = field.child_by_field_name("type") else {
            continue;
        };
        if embedded.kind() == "pointer_type"
            && let Some(inner) = named_children(embedded).into_iter().next()
        {
            embedded = inner;
        }
        ctx.type_edge(EdgeKind::Extends, qualified, None, embedded);
    }
}

fn interface_members(ctx: &mut Ctx, interface: Node, qualified: &str) {
    let owner = Receiver {
        type_name: qualified.to_string(),
        name: None,
    };
    for member in named_children(interface) {
        match member.kind() {
            "method_elem" | "method_spec" => function(ctx, member, member, Some(&owner)),
            "type_elem" | "interface_type_name" => {
                for embedded in named_children(member) {
                    ctx.type_edge(EdgeKind::Extends, qualified, None, embedded);
                }
            }
            _ => {}
        }
    }
}

fn values(ctx: &mut Ctx, declaration: Node) {
    let (keyword, kind) = if declaration.kind() == "const_declaration" {
        ("const", "const")
    } else {
        ("var", "variable")
    };
    let specs: Vec<Node> = named_children(declaration)
        .into_iter()
        .filter(|n| matches!(n.kind(), "const_spec" | "var_spec"))
        .collect();
    let single = specs.len() == 1;
    for spec in specs {
        let value = spec.child_by_field_name("value");
        let mut cursor = spec.walk();
        let names: Vec<String> = spec
            .children_by_field_name("name", &mut cursor)
            .map(|n| ctx.text(n))
            .collect();
        let header = format!("{keyword} {}", ctx.header(spec, value));
        for name in names {
            let span = if single { declaration } else { spec };
            let mut decl = Decl::new(span, name, kind);
            decl.is_public = exported(&decl.name);
            decl.header = header.clone();
            let qualified = ctx.push(decl);
            if let Some(value) = value {
                ctx.collect_calls(value, Some(&qualified), None, None);
            }
        }
    }
}

fn imports(ctx: &mut Ctx, declaration: Node) {
    let mut stack = vec![declaration];
    while let Some(node) = stack.pop() {
        if node.kind() != "import_spec" {
            stack.extend(named_children(node).into_iter().rev());
            continue;
        }
        let Some(path_node) = node.child_by_field_name("path") else {
            continue;
        };
        let path = ctx.text(path_node).trim_matches(['"', '`']).to_string();
        let target = ctx.request(ImportRequest::GoImport { spec: path.clone() });
        ctx.import_edge(&path, Some(target), Ctx::line(node));
        let alias = node.child_by_field_name("name").map(|n| ctx.text(n));
        let local = match alias {
            Some(alias) if alias == "_" || alias == "." => continue,
            Some(alias) => alias,
            None => package_name(&path),
        };
        let imported = local.clone();
        ctx.bind(local, target, imported, true);
    }
}

/// The package name an import path binds: its last segment, skipping a
/// trailing major-version segment such as `/v2`.
fn package_name(path: &str) -> String {
    let mut segments = path.rsplit('/');
    let last = segments.next().unwrap_or(path);
    let is_version =
        last.len() > 1 && last.starts_with('v') && last[1..].chars().all(|c| c.is_ascii_digit());
    match (is_version, segments.next()) {
        (true, Some(previous)) => previous.to_string(),
        _ => last.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::super::test_support::{edges, parse, s, symbol};
    use super::super::*;

    const SOURCE: &str = r#"package store

import (
	"fmt"
	st "example.com/app/internal/store"
)

// Store keeps rows.
type Store struct {
	Base
	db *DB
}

// Reader reads rows.
type Reader interface {
	io.Closer
	Read(p []byte) (n int, err error)
}

// Index walks names.
func (s *Store) Index(ctx context.Context, names ...string) (int, error) {
	s.flush()
	fmt.Println(len(names))
	return st.Open(ctx)
}

func (s *Store) flush() {}

func New[T any](a, b int, label string) *Store { return nil }

const MaxRows = 3
"#;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("go.mod"),
            "module example.com/app\n\ngo 1.22\n",
        )
        .unwrap();
        // An import resolves to a package directory holding an indexed file.
        std::fs::create_dir_all(dir.path().join("internal/store")).unwrap();
        std::fs::write(dir.path().join("internal/store/open.go"), "package store\n").unwrap();
        dir
    }

    #[test]
    fn go_symbols_carry_params_results_and_docs() {
        let dir = fixture();
        let actual = parse(dir.path(), "store.go", SOURCE);
        let names: Vec<_> = actual
            .symbols
            .iter()
            .map(|s| (s.qualified_name.as_str(), s.kind.as_str(), s.is_public))
            .collect();
        assert_eq!(
            names,
            vec![
                ("Store", "struct", true),
                ("Reader", "interface", true),
                ("Reader.Read", "method", true),
                ("Store.Index", "method", true),
                ("Store.flush", "method", false),
                ("New", "function", true),
                ("MaxRows", "const", true),
            ]
        );
        let expected = SymbolSignature::default()
            .name("Index")
            .qualified_name("Store.Index")
            .kind("method")
            .is_public(true)
            .start_line(21usize)
            .end_line(25usize)
            .params(vec![
                ParamSignature::new("ctx").type_annotation("context.Context"),
                ParamSignature::new("names").type_annotation("...string"),
            ])
            .return_type("(int, error)")
            .doc_summary("Index walks names.")
            .signature_text(
                "func (s *Store) Index(ctx context.Context, names ...string) (int, error)",
            )
            .hashed();
        assert_eq!(symbol(&actual, "Store.Index"), &expected);
        assert_eq!(
            symbol(&actual, "New").params,
            vec![
                ParamSignature::new("a").type_annotation("int"),
                ParamSignature::new("b").type_annotation("int"),
                ParamSignature::new("label").type_annotation("string"),
            ]
        );
        assert_eq!(symbol(&actual, "Store").signature_text, "type Store struct");
        assert_eq!(symbol(&actual, "Store").doc_summary, s("Store keeps rows."));
        assert_eq!(symbol(&actual, "MaxRows").signature_text, "const MaxRows");
    }

    #[test]
    fn go_edges_resolve_module_imports_and_receivers() {
        let dir = fixture();
        let actual = parse(dir.path(), "store.go", SOURCE);
        assert_eq!(
            edges(&actual, EdgeKind::Imports),
            vec![
                (None, None, "fmt".to_string()),
                (
                    None,
                    s("internal/store"),
                    "example.com/app/internal/store".to_string()
                ),
            ]
        );
        let calls: Vec<_> = edges(&actual, EdgeKind::Calls)
            .into_iter()
            .filter(|e| e.0 == s("Store.Index"))
            .map(|e| (e.1, e.2))
            .collect();
        assert_eq!(
            calls,
            vec![
                (s("store.go"), "Store.flush".to_string()),
                (None, "fmt.Println".to_string()),
                (None, "len".to_string()),
                (s("internal/store"), "Open".to_string()),
            ]
        );
        assert_eq!(
            edges(&actual, EdgeKind::Extends),
            vec![
                (s("Store"), None, "Base".to_string()),
                (s("Reader"), None, "io.Closer".to_string()),
            ]
        );
        let uses: Vec<_> = edges(&actual, EdgeKind::UsesType)
            .into_iter()
            .filter(|e| e.0 == s("New"))
            .map(|e| (e.1, e.2))
            .collect();
        assert_eq!(uses, vec![(s("store.go"), "Store".to_string())]);
    }
}
