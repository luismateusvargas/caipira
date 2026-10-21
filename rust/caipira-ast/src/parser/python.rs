//! Python declarations: module functions, classes, methods, and module-level
//! assignments. Public means not underscore-prefixed (dunders count as
//! public), or listed in `__all__` when the module defines one.

use std::collections::HashSet;

use tree_sitter::Node;

use super::{
    Ctx, Decl, EdgeKind, ImportItem, ParamSignature, collapse_ws, first_paragraph, generic_names,
    named_children,
};
use crate::resolve::ImportRequest;

pub(super) fn extract(ctx: &mut Ctx, root: Node) {
    let all = dunder_all(ctx, root);
    for node in named_children(root) {
        match node.kind() {
            "function_definition" => function(ctx, node, node, None, all.as_ref()),
            "class_definition" => class(ctx, node, None, all.as_ref()),
            "decorated_definition" => decorated(ctx, node, None, all.as_ref()),
            "import_statement" | "import_from_statement" => import(ctx, node),
            "expression_statement" => assignment(ctx, node, all.as_ref()),
            "comment" | "future_import_statement" => {}
            _ => ctx.collect_calls(node, None, None, None),
        }
    }
}

/// The class a member belongs to.
struct Owner<'s> {
    qualified: &'s str,
    public: bool,
}

fn is_public_name(name: &str) -> bool {
    (name.starts_with("__") && name.ends_with("__")) || !name.starts_with('_')
}

fn module_public(name: &str, all: Option<&HashSet<String>>) -> bool {
    all.map_or_else(|| is_public_name(name), |all| all.contains(name))
}

fn decorated(ctx: &mut Ctx, node: Node, owner: Option<&Owner>, all: Option<&HashSet<String>>) {
    let Some(definition) = node.child_by_field_name("definition") else {
        return;
    };
    match definition.kind() {
        "function_definition" => function(ctx, definition, node, owner, all),
        "class_definition" => class(ctx, definition, owner, all),
        _ => {}
    }
}

fn function(
    ctx: &mut Ctx,
    node: Node,
    anchor: Node,
    owner: Option<&Owner>,
    all: Option<&HashSet<String>>,
) {
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
    decl.doc_anchor = anchor;
    decl.is_public = match owner {
        Some(owner) => owner.public && is_public_name(&decl.name),
        None => module_public(&decl.name, all),
    };
    decl.scope = owner.map(|o| o.qualified.to_string());
    decl.params = params_node.map(|p| params(ctx, p)).unwrap_or_default();
    decl.return_type = return_node.map(|r| collapse_ws(&ctx.text(r)));
    decl.doc = docstring(ctx, body);
    decl.header = ctx.header(node, body);
    let qualified = ctx.push(decl);

    let generics = generic_names(ctx, node.child_by_field_name("type_parameters"));
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
        let scope = owner.map(|o| o.qualified);
        ctx.collect_calls(body, Some(&qualified), scope, None);
        nested_imports(ctx, body);
    }
}

fn params(ctx: &Ctx, list: Node) -> Vec<ParamSignature> {
    let text = |n: Node| collapse_ws(&ctx.text(n));
    let mut out = Vec::new();
    for param in named_children(list) {
        let sig = match param.kind() {
            "identifier" | "list_splat_pattern" | "dictionary_splat_pattern" => {
                ParamSignature::new(text(param))
            }
            "typed_parameter" => {
                let Some(name) = named_children(param).into_iter().next() else {
                    continue;
                };
                let mut sig = ParamSignature::new(text(name));
                sig.type_annotation = param.child_by_field_name("type").map(text);
                sig
            }
            "default_parameter" | "typed_default_parameter" => {
                let Some(name) = param.child_by_field_name("name") else {
                    continue;
                };
                let mut sig = ParamSignature::new(text(name));
                sig.type_annotation = param.child_by_field_name("type").map(text);
                sig.default_value = param.child_by_field_name("value").map(text);
                sig
            }
            // `*` and `/` separators carry no parameter.
            _ => continue,
        };
        out.push(sig);
    }
    out
}

fn class(ctx: &mut Ctx, node: Node, owner: Option<&Owner>, all: Option<&HashSet<String>>) {
    let Some(name) = node.child_by_field_name("name").map(|n| ctx.text(n)) else {
        return;
    };
    let body = node.child_by_field_name("body");
    let anchor = node
        .parent()
        .filter(|p| p.kind() == "decorated_definition")
        .unwrap_or(node);

    let mut decl = Decl::new(node, name, "class");
    decl.doc_anchor = anchor;
    decl.is_public = match owner {
        Some(owner) => owner.public && is_public_name(&decl.name),
        None => module_public(&decl.name, all),
    };
    decl.scope = owner.map(|o| o.qualified.to_string());
    decl.doc = docstring(ctx, body);
    decl.header = ctx.header(node, body);
    let public = decl.is_public;
    let qualified = ctx.push(decl);

    let scope = owner.map(|o| o.qualified);
    if let Some(bases) = node.child_by_field_name("superclasses") {
        for base in named_children(bases) {
            let base = match base.kind() {
                "identifier" | "attribute" => base,
                "subscript" => match base.child_by_field_name("value") {
                    Some(value) => value,
                    None => continue,
                },
                _ => continue,
            };
            ctx.type_edge(EdgeKind::Extends, &qualified, scope, base);
        }
    }

    let Some(body) = body else { return };
    let me = Owner {
        qualified: &qualified,
        public,
    };
    for member in named_children(body) {
        match member.kind() {
            "function_definition" => function(ctx, member, member, Some(&me), None),
            "decorated_definition" => decorated(ctx, member, Some(&me), None),
            "class_definition" => class(ctx, member, Some(&me), None),
            "comment" => {}
            _ => ctx.collect_calls(member, Some(&qualified), Some(&qualified), None),
        }
    }
}

/// A module-level `NAME = value` or `name: Type = value`.
fn assignment(ctx: &mut Ctx, statement: Node, all: Option<&HashSet<String>>) {
    let assign = named_children(statement)
        .into_iter()
        .find(|n| n.kind() == "assignment");
    let left = assign.and_then(|a| a.child_by_field_name("left"));
    let (Some(assign), Some(left)) = (assign, left) else {
        ctx.collect_calls(statement, None, None, None);
        return;
    };
    let name = ctx.text(left);
    if left.kind() != "identifier" || (name.starts_with("__") && name.ends_with("__")) {
        ctx.collect_calls(statement, None, None, None);
        return;
    }
    let is_constant = name
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    let value = assign.child_by_field_name("right");
    let mut decl = Decl::new(
        statement,
        name,
        if is_constant { "const" } else { "variable" },
    );
    decl.is_public = module_public(&decl.name, all);
    decl.header = ctx.header(statement, value);
    let qualified = ctx.push(decl);
    if let Some(value) = value {
        ctx.collect_calls(value, Some(&qualified), None, None);
    }
}

fn docstring(ctx: &Ctx, body: Option<Node>) -> Option<String> {
    let first = named_children(body?)
        .into_iter()
        .find(|n| n.kind() != "comment")?;
    if first.kind() != "expression_statement" {
        return None;
    }
    let string = named_children(first)
        .into_iter()
        .next()
        .filter(|n| n.kind() == "string")?;
    let content: String = named_children(string)
        .into_iter()
        .filter(|n| n.kind() == "string_content")
        .map(|n| ctx.text(n))
        .collect();
    first_paragraph(&content)
}

fn import(ctx: &mut Ctx, node: Node) {
    let line = Ctx::line(node);
    let mut cursor = node.walk();
    let names: Vec<Node> = node.children_by_field_name("name", &mut cursor).collect();
    match node.kind() {
        "import_statement" => {
            for name in names {
                let (module_node, alias) = match name.kind() {
                    "aliased_import" => (
                        name.child_by_field_name("name"),
                        name.child_by_field_name("alias"),
                    ),
                    _ => (Some(name), None),
                };
                let Some(module_node) = module_node else {
                    continue;
                };
                let module = ctx.text(module_node);
                let target = ctx.request(ImportRequest::Python {
                    module: module.clone(),
                });
                ctx.import_edge(&module, Some(target), line);
                // `import a.b` binds `a`; `import a.b as x` binds `x` to `a.b`.
                let (local, bound) = match alias {
                    Some(alias) => (ctx.text(alias), target),
                    None => {
                        let first = module.split('.').next().unwrap_or(&module).to_string();
                        let bound = if first == module {
                            target
                        } else {
                            ctx.request(ImportRequest::Python {
                                module: first.clone(),
                            })
                        };
                        (first, bound)
                    }
                };
                let imported = local.clone();
                ctx.bind(local, bound, imported, true);
            }
        }
        "import_from_statement" => {
            let Some(module_node) = node.child_by_field_name("module_name") else {
                return;
            };
            let module = ctx.text(module_node);
            let target = ctx.request(ImportRequest::Python {
                module: module.clone(),
            });
            for name in names {
                let (name_node, alias) = match name.kind() {
                    "aliased_import" => (
                        name.child_by_field_name("name"),
                        name.child_by_field_name("alias"),
                    ),
                    _ => (Some(name), None),
                };
                let Some(name_node) = name_node else { continue };
                let imported = ctx.text(name_node);
                let local = alias
                    .map(|a| ctx.text(a))
                    .unwrap_or_else(|| imported.clone());
                // `from . import utils` imports a submodule, not a name;
                // which one it is depends on the files, so linking decides.
                let submodule_request = ctx.request(ImportRequest::PythonSubmodule {
                    module: module.clone(),
                    name: imported.clone(),
                });
                ctx.import_from(ImportItem::PythonFrom {
                    module: module.clone(),
                    module_request: target,
                    submodule: submodule_specifier(&module, &imported),
                    submodule_request,
                    local,
                    imported,
                    line,
                });
            }
            if named_children(node)
                .iter()
                .any(|n| n.kind() == "wildcard_import")
            {
                ctx.import_edge(&module, Some(target), line);
            }
        }
        _ => {}
    }
}

fn submodule_specifier(module: &str, name: &str) -> String {
    if module.chars().all(|c| c == '.') {
        format!("{module}{name}")
    } else {
        format!("{module}.{name}")
    }
}

/// Imports inside function bodies, which are common for lazy loading.
fn nested_imports(ctx: &mut Ctx, body: Node) {
    let mut stack = vec![body];
    while let Some(node) = stack.pop() {
        match node.kind() {
            "import_statement" | "import_from_statement" => import(ctx, node),
            "function_definition" | "class_definition" => {}
            _ => stack.extend(named_children(node)),
        }
    }
}

fn dunder_all(ctx: &Ctx, root: Node) -> Option<HashSet<String>> {
    for statement in named_children(root)
        .into_iter()
        .filter(|n| n.kind() == "expression_statement")
    {
        let Some(assign) = named_children(statement)
            .into_iter()
            .find(|n| n.kind() == "assignment")
        else {
            continue;
        };
        let is_all = assign
            .child_by_field_name("left")
            .is_some_and(|l| ctx.text(l) == "__all__");
        let Some(list) = assign.child_by_field_name("right").filter(|_| is_all) else {
            continue;
        };
        let names = named_children(list)
            .into_iter()
            .filter(|n| n.kind() == "string")
            .flat_map(named_children)
            .filter(|n| n.kind() == "string_content")
            .map(|n| ctx.text(n))
            .collect();
        return Some(names);
    }
    None
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::super::test_support::{edges, parse, s, symbol};
    use super::super::*;

    const SOURCE: &str = r#"from .store import MemoryStore as MS, Row
from . import utils
import os.path

DEFAULT_LIMIT = 10

# Builds the index.
def build(root: str, limit: int = DEFAULT_LIMIT, *paths, strict=False, **opts) -> "Index":
    """Build an index for root.

    Walks every file."""
    utils.walk(root)
    return MS.load(root)

@dataclass
class Index(Base, metaclass=Meta):
    """Holds rows."""

    def add(self, row: Row) -> None:
        self._check(row)

    def _check(self, row):
        pass

def _private():
    pass
"#;

    #[test]
    fn python_symbols_carry_params_returns_and_docstrings() {
        let fixture = tempfile::tempdir().unwrap();
        let actual = parse(fixture.path(), "pkg/index.py", SOURCE);

        let build = symbol(&actual, "build");
        let expected = SymbolSignature::default()
            .name("build")
            .qualified_name("build")
            .kind("function")
            .is_public(true)
            .start_line(8usize)
            .end_line(13usize)
            .params(vec![
                ParamSignature::new("root").type_annotation("str"),
                ParamSignature::new("limit").type_annotation("int").default_value("DEFAULT_LIMIT"),
                ParamSignature::new("*paths"),
                ParamSignature::new("strict").default_value("False"),
                ParamSignature::new("**opts"),
            ])
            .return_type("\"Index\"")
            .doc_summary("Build an index for root.")
            .signature_text(
                "def build(root: str, limit: int = DEFAULT_LIMIT, *paths, strict=False, **opts) -> \"Index\"",
            )
            .hashed();
        assert_eq!(build, &expected);

        let names: Vec<_> = actual
            .symbols
            .iter()
            .map(|s| (s.qualified_name.as_str(), s.kind.as_str(), s.is_public))
            .collect();
        assert_eq!(
            names,
            vec![
                ("DEFAULT_LIMIT", "const", true),
                ("build", "function", true),
                ("Index", "class", true),
                ("Index.add", "method", true),
                ("Index._check", "method", false),
                ("_private", "function", false),
            ]
        );
        let index = symbol(&actual, "Index");
        assert_eq!(
            (index.start_line, index.doc_summary.clone()),
            (16, s("Holds rows."))
        );
        assert_eq!(
            symbol(&actual, "Index.add").params[0],
            ParamSignature::new("self")
        );
    }

    #[test]
    fn python_edges_resolve_relative_imports() {
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(fixture.path().join("pkg")).unwrap();
        std::fs::write(fixture.path().join("pkg/store.py"), "").unwrap();
        std::fs::write(fixture.path().join("pkg/utils.py"), "").unwrap();
        let actual = parse(fixture.path(), "pkg/index.py", SOURCE);

        assert_eq!(
            edges(&actual, EdgeKind::Imports),
            vec![
                (None, s("pkg/store.py"), ".store".to_string()),
                (None, s("pkg/utils.py"), ".utils".to_string()),
                (None, None, "os.path".to_string()),
            ]
        );
        let calls = edges(&actual, EdgeKind::Calls);
        assert!(
            calls.contains(&(s("build"), s("pkg/utils.py"), "walk".to_string())),
            "{calls:?}"
        );
        assert!(calls.contains(&(
            s("build"),
            s("pkg/store.py"),
            "MemoryStore.load".to_string()
        )));
        assert!(calls.contains(&(
            s("Index.add"),
            s("pkg/index.py"),
            "Index._check".to_string()
        )));
        assert_eq!(
            edges(&actual, EdgeKind::UsesType),
            vec![
                (s("build"), s("pkg/index.py"), "Index".to_string()),
                (s("Index.add"), s("pkg/store.py"), "Row".to_string()),
            ]
        );
        assert_eq!(
            edges(&actual, EdgeKind::Extends),
            vec![(s("Index"), None, "Base".to_string())]
        );
    }

    #[test]
    fn dunder_all_defines_the_public_surface() {
        let fixture = tempfile::tempdir().unwrap();
        let source = "__all__ = ['kept']\n\ndef kept():\n    pass\n\ndef dropped():\n    pass\n";
        let actual = parse(fixture.path(), "m.py", source);
        let names: Vec<_> = actual
            .symbols
            .iter()
            .map(|s| (s.name.as_str(), s.is_public))
            .collect();
        assert_eq!(names, vec![("kept", true), ("dropped", false)]);
    }
}
