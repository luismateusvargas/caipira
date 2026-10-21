//! JavaScript, TypeScript, JSX/TSX, and Vue `<script>` declarations.
//!
//! Symbols are module-level declarations, class and interface members, and
//! namespace members. A symbol is public when it is exported with `export`,
//! listed in an `export { ... }` clause, or assigned onto `module.exports`
//! / `exports`, so CommonJS modules report a real public surface too.

use std::collections::HashSet;

use tree_sitter::Node;

use super::{
    Ctx, Decl, EdgeKind, ImportBinding, ParamSignature, annotation_text, collapse_ws,
    generic_names, named_children,
};

const DECLARATIONS: &[&str] = &[
    "function_declaration",
    "generator_function_declaration",
    "function_signature",
    "class_declaration",
    "abstract_class_declaration",
    "lexical_declaration",
    "variable_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "internal_module",
    "module",
    "ambient_declaration",
];

const FUNCTION_VALUES: &[&str] = &[
    "arrow_function",
    "function_expression",
    "function",
    "generator_function",
];

pub(super) fn extract(ctx: &mut Ctx, root: Node) {
    let exported = exported_names(ctx, root);
    for node in named_children(root) {
        statement(ctx, node, None, &exported);
    }
}

/// Where a declaration sits: its outer node (an `export` wrapper or the
/// declaration itself), whether that wrapper exports it, and its scope.
#[derive(Clone, Copy)]
struct Site<'t, 's> {
    outer: Node<'t>,
    exported: bool,
    scope: Option<&'s str>,
}

fn statement(ctx: &mut Ctx, node: Node, scope: Option<&str>, exported: &HashSet<String>) {
    match node.kind() {
        "import_statement" => import_statement(ctx, node),
        "export_statement" => export_statement(ctx, node, scope, exported),
        "comment" => {}
        kind if DECLARATIONS.contains(&kind) => {
            let site = Site {
                outer: node,
                exported: false,
                scope,
            };
            declaration(ctx, node, site, exported);
        }
        _ => ctx.collect_calls(node, scope, scope, None),
    }
}

fn declaration(ctx: &mut Ctx, node: Node, site: Site, exported: &HashSet<String>) {
    let is_public = |name: &str| site.exported || (site.scope.is_none() && exported.contains(name));
    match node.kind() {
        "function_declaration" | "generator_function_declaration" | "function_signature" => {
            let Some(name) = field_text(ctx, node, "name") else {
                return;
            };
            let public = is_public(&name);
            function(
                ctx,
                FnSite::new(site.outer, node, name, "function", public, site.scope),
            );
        }
        "class_declaration" | "abstract_class_declaration" => {
            let Some(name) = field_text(ctx, node, "name") else {
                return;
            };
            let public = is_public(&name);
            class(ctx, node, site.outer, name, public, site.scope);
        }
        "lexical_declaration" | "variable_declaration" => variables(ctx, node, site, exported),
        "interface_declaration" => {
            let Some(name) = field_text(ctx, node, "name") else {
                return;
            };
            let public = is_public(&name);
            interface(ctx, node, site.outer, name, public, site.scope);
        }
        "type_alias_declaration" | "enum_declaration" => {
            let Some(name) = field_text(ctx, node, "name") else {
                return;
            };
            let kind = if node.kind() == "enum_declaration" {
                "enum"
            } else {
                "type"
            };
            let body = node
                .child_by_field_name("value")
                .or_else(|| node.child_by_field_name("body"));
            let mut decl = Decl::new(site.outer, name, kind);
            decl.is_public = is_public(&decl.name);
            decl.scope = site.scope.map(str::to_string);
            decl.header = ctx.header(site.outer, body);
            ctx.push(decl);
        }
        "internal_module" | "module" => {
            let Some(name) = field_text(ctx, node, "name") else {
                return;
            };
            let body = node.child_by_field_name("body");
            let mut decl = Decl::new(site.outer, name, "namespace");
            decl.is_public = is_public(&decl.name);
            decl.scope = site.scope.map(str::to_string);
            decl.header = ctx.header(site.outer, body);
            let qualified = ctx.push(decl);
            if let Some(body) = body {
                for member in named_children(body) {
                    statement(ctx, member, Some(&qualified), &HashSet::new());
                }
            }
        }
        "ambient_declaration" => {
            for inner in named_children(node) {
                if DECLARATIONS.contains(&inner.kind()) {
                    declaration(ctx, inner, site, exported);
                }
            }
        }
        _ => {}
    }
}

/// A function-like symbol: the node giving its span, doc, and header start,
/// and the node holding `parameters`, `return_type`, and `body`.
struct FnSite<'t, 's> {
    span: Node<'t>,
    function: Node<'t>,
    name: String,
    kind: &'static str,
    public: bool,
    scope: Option<&'s str>,
}

impl<'t, 's> FnSite<'t, 's> {
    fn new(
        span: Node<'t>,
        function: Node<'t>,
        name: String,
        kind: &'static str,
        public: bool,
        scope: Option<&'s str>,
    ) -> Self {
        Self {
            span,
            function,
            name,
            kind,
            public,
            scope,
        }
    }
}

fn function(ctx: &mut Ctx, site: FnSite) -> String {
    let f = site.function;
    let params_node = f
        .child_by_field_name("parameters")
        .or_else(|| f.child_by_field_name("parameter"));
    let return_node = f.child_by_field_name("return_type");
    let body = f.child_by_field_name("body");

    let mut decl = Decl::new(site.span, site.name, site.kind);
    decl.is_public = site.public;
    decl.scope = site.scope.map(str::to_string);
    decl.params = params_node.map(|p| params(ctx, p)).unwrap_or_default();
    decl.return_type = return_node.map(|r| annotation_text(ctx, r));
    decl.header = ctx.header(site.span, body);
    let qualified = ctx.push(decl);

    let generics = generic_names(ctx, f.child_by_field_name("type_parameters"));
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
        ctx.collect_calls(body, Some(&qualified), site.scope, None);
    }
    qualified
}

fn params(ctx: &Ctx, list: Node) -> Vec<ParamSignature> {
    if list.kind() != "formal_parameters" {
        // `x => x`: a lone identifier with no parentheses.
        return vec![ParamSignature::new(ctx.text(list))];
    }
    named_children(list)
        .into_iter()
        .filter_map(|p| param(ctx, p))
        .collect()
}

fn param(ctx: &Ctx, node: Node) -> Option<ParamSignature> {
    let text = |n: Node| collapse_ws(&ctx.text(n));
    match node.kind() {
        "comment" | "decorator" => None,
        "assignment_pattern" => {
            let left = node.child_by_field_name("left")?;
            let mut sig = ParamSignature::new(text(left));
            sig.default_value = node.child_by_field_name("right").map(text);
            Some(sig)
        }
        "required_parameter" | "optional_parameter" => {
            let pattern = node.child_by_field_name("pattern")?;
            let mut name = text(pattern);
            if node.kind() == "optional_parameter" {
                name.push('?');
            }
            let mut sig = ParamSignature::new(name);
            sig.type_annotation = node
                .child_by_field_name("type")
                .map(|t| annotation_text(ctx, t));
            sig.default_value = node.child_by_field_name("value").map(text);
            Some(sig)
        }
        _ => Some(ParamSignature::new(text(node))),
    }
}

fn class(ctx: &mut Ctx, node: Node, outer: Node, name: String, public: bool, scope: Option<&str>) {
    let body = node.child_by_field_name("body");
    let mut decl = Decl::new(outer, name, "class");
    decl.is_public = public;
    decl.scope = scope.map(str::to_string);
    decl.header = ctx.header(outer, body);
    let qualified = ctx.push(decl);

    for heritage in named_children(node)
        .into_iter()
        .filter(|n| n.kind() == "class_heritage")
    {
        for clause in named_children(heritage) {
            match clause.kind() {
                "extends_clause" => {
                    for value in named_children(clause) {
                        if value.kind() != "type_arguments" {
                            ctx.type_edge(EdgeKind::Extends, &qualified, scope, value);
                        }
                    }
                }
                "implements_clause" => {
                    for target in named_children(clause) {
                        ctx.type_edge(EdgeKind::Implements, &qualified, scope, target);
                    }
                }
                // Plain JavaScript: `class A extends <expression>`.
                _ => ctx.type_edge(EdgeKind::Extends, &qualified, scope, clause),
            }
        }
    }
    if let Some(body) = body {
        members(ctx, body, &qualified, public);
    }
}

fn members(ctx: &mut Ctx, body: Node, class: &str, class_public: bool) {
    for member in named_children(body) {
        match member.kind() {
            "method_definition" | "method_signature" | "abstract_method_signature" => {
                let Some(name_node) = member.child_by_field_name("name") else {
                    continue;
                };
                let public = class_public && !is_private_member(ctx, member, name_node);
                let site = FnSite::new(
                    member,
                    member,
                    ctx.text(name_node),
                    "method",
                    public,
                    Some(class),
                );
                function(ctx, site);
            }
            "public_field_definition" | "field_definition" => {
                let name_node = member
                    .child_by_field_name("name")
                    .or_else(|| member.child_by_field_name("property"));
                let value = member.child_by_field_name("value");
                match (name_node, value) {
                    (Some(name_node), Some(value)) if FUNCTION_VALUES.contains(&value.kind()) => {
                        let public = class_public && !is_private_member(ctx, member, name_node);
                        let name = ctx.text(name_node);
                        function(
                            ctx,
                            FnSite::new(member, value, name, "method", public, Some(class)),
                        );
                    }
                    (_, Some(value)) => ctx.collect_calls(value, Some(class), Some(class), None),
                    _ => {}
                }
            }
            "class_static_block" => ctx.collect_calls(member, Some(class), Some(class), None),
            _ => {}
        }
    }
}

fn is_private_member(ctx: &Ctx, member: Node, name: Node) -> bool {
    name.kind() == "private_property_identifier"
        || named_children(member).iter().any(|c| {
            c.kind() == "accessibility_modifier"
                && matches!(ctx.text(*c).as_str(), "private" | "protected")
        })
}

fn interface(
    ctx: &mut Ctx,
    node: Node,
    outer: Node,
    name: String,
    public: bool,
    scope: Option<&str>,
) {
    let body = node.child_by_field_name("body");
    let mut decl = Decl::new(outer, name, "interface");
    decl.is_public = public;
    decl.scope = scope.map(str::to_string);
    decl.header = ctx.header(outer, body);
    let qualified = ctx.push(decl);

    for clause in named_children(node)
        .into_iter()
        .filter(|n| n.kind() == "extends_type_clause")
    {
        for target in named_children(clause) {
            ctx.type_edge(EdgeKind::Extends, &qualified, scope, target);
        }
    }
    let Some(body) = body else { return };
    for member in named_children(body)
        .into_iter()
        .filter(|n| n.kind() == "method_signature")
    {
        let Some(name_node) = member.child_by_field_name("name") else {
            continue;
        };
        let site = FnSite::new(
            member,
            member,
            ctx.text(name_node),
            "method",
            public,
            Some(&qualified),
        );
        function(ctx, site);
    }
}

fn variables(ctx: &mut Ctx, node: Node, site: Site, exported: &HashSet<String>) {
    let keyword = node.child(0).map(|k| ctx.text(k)).unwrap_or_default();
    for declarator in named_children(node)
        .into_iter()
        .filter(|n| n.kind() == "variable_declarator")
    {
        let Some(name_node) = declarator.child_by_field_name("name") else {
            continue;
        };
        let value = declarator.child_by_field_name("value");
        // `const x = require('./x')` and destructuring bind imports; they are
        // not symbols of this file.
        if name_node.kind() != "identifier" || value.is_some_and(|v| is_require(ctx, v)) {
            if let Some(value) = value {
                ctx.collect_calls(value, site.scope, site.scope, None);
            }
            continue;
        }
        let name = ctx.text(name_node);
        let public = site.exported || (site.scope.is_none() && exported.contains(&name));
        match value {
            Some(v) if FUNCTION_VALUES.contains(&v.kind()) => {
                function(
                    ctx,
                    FnSite::new(site.outer, v, name, "function", public, site.scope),
                );
            }
            Some(v) if v.kind() == "class" => class(ctx, v, site.outer, name, public, site.scope),
            _ => {
                let kind = if keyword == "const" {
                    "const"
                } else {
                    "variable"
                };
                let mut decl = Decl::new(site.outer, name, kind);
                decl.is_public = public;
                decl.scope = site.scope.map(str::to_string);
                decl.header = ctx.header(site.outer, value);
                let qualified = ctx.push(decl);
                if let Some(value) = value {
                    ctx.collect_calls(value, Some(&qualified), site.scope, None);
                }
            }
        }
    }
}

fn is_require(ctx: &Ctx, value: Node) -> bool {
    let mut node = value;
    while matches!(node.kind(), "member_expression" | "await_expression") {
        let Some(inner) = node
            .child_by_field_name("object")
            .or_else(|| node.named_child(0))
        else {
            return false;
        };
        node = inner;
    }
    node.kind() == "call_expression"
        && node.child_by_field_name("function").is_some_and(|f| {
            (f.kind() == "identifier" && ctx.text(f) == "require") || f.kind() == "import"
        })
}

fn import_statement(ctx: &mut Ctx, node: Node) {
    let Some(source) = node.child_by_field_name("source") else {
        return;
    };
    let specifier = string_value(ctx, source);
    let target = ctx.resolver.script(ctx.path, &specifier);
    ctx.import_edge(&specifier, target.clone(), Ctx::line(node));
    for clause in named_children(node)
        .into_iter()
        .filter(|n| n.kind() == "import_clause")
    {
        for part in named_children(clause) {
            match part.kind() {
                "identifier" => {
                    let local = ctx.text(part);
                    bind(ctx, local.clone(), &target, local, false);
                }
                "namespace_import" => {
                    if let Some(id) = named_children(part).into_iter().next() {
                        let local = ctx.text(id);
                        bind(ctx, local.clone(), &target, local, true);
                    }
                }
                "named_imports" => {
                    for spec in named_children(part) {
                        let Some(name) = field_text(ctx, spec, "name") else {
                            continue;
                        };
                        let local = field_text(ctx, spec, "alias").unwrap_or_else(|| name.clone());
                        bind(ctx, local, &target, name, false);
                    }
                }
                _ => {}
            }
        }
    }
}

fn export_statement(ctx: &mut Ctx, node: Node, scope: Option<&str>, exported: &HashSet<String>) {
    if let Some(source) = node.child_by_field_name("source") {
        let specifier = string_value(ctx, source);
        let target = ctx.resolver.script(ctx.path, &specifier);
        ctx.import_edge(&specifier, target, Ctx::line(node));
        return;
    }
    if let Some(inner) = node.child_by_field_name("declaration") {
        declaration(
            ctx,
            inner,
            Site {
                outer: node,
                exported: true,
                scope,
            },
            exported,
        );
        return;
    }
    let Some(value) = node.child_by_field_name("value") else {
        return;
    };
    let name = field_text(ctx, value, "name").unwrap_or_else(|| "default".to_string());
    match value.kind() {
        kind if FUNCTION_VALUES.contains(&kind) => {
            function(ctx, FnSite::new(node, value, name, "function", true, scope));
        }
        "class" => class(ctx, value, node, name, true, scope),
        "identifier" => {}
        _ => ctx.collect_calls(value, scope, scope, None),
    }
}

/// Handles `require('x')` and `import('x')` met while collecting calls:
/// records the import edge and any binding, and reports whether it did.
pub(super) fn import_call(ctx: &mut Ctx, call: Node) -> bool {
    if call.kind() != "call_expression" {
        return false;
    }
    let Some(function) = call.child_by_field_name("function") else {
        return false;
    };
    let is_require = function.kind() == "identifier" && ctx.text(function) == "require";
    if !is_require && function.kind() != "import" {
        return false;
    }
    let argument = call
        .child_by_field_name("arguments")
        .and_then(|args| named_children(args).into_iter().next())
        .filter(|arg| arg.kind() == "string");
    let Some(argument) = argument else {
        return true;
    };
    let specifier = string_value(ctx, argument);
    let target = ctx.resolver.script(ctx.path, &specifier);
    ctx.import_edge(&specifier, target.clone(), Ctx::line(call));

    // `const x = require('x')`, `const { a } = require('x')`, and
    // `const y = require('x').y` bind names; climb to the declarator.
    let mut property = None;
    let mut parent = call.parent();
    while let Some(p) = parent {
        match p.kind() {
            "member_expression" => {
                property = field_text(ctx, p, "property");
                parent = p.parent();
            }
            "await_expression" | "parenthesized_expression" => parent = p.parent(),
            _ => break,
        }
    }
    let Some(declarator) = parent.filter(|p| p.kind() == "variable_declarator") else {
        return true;
    };
    let Some(pattern) = declarator.child_by_field_name("name") else {
        return true;
    };
    match pattern.kind() {
        "identifier" => {
            let local = ctx.text(pattern);
            match property {
                Some(imported) => bind(ctx, local, &target, imported, false),
                None => bind(ctx, local.clone(), &target, local, true),
            }
        }
        "object_pattern" => {
            for part in named_children(pattern) {
                match part.kind() {
                    "shorthand_property_identifier_pattern" => {
                        let name = ctx.text(part);
                        bind(ctx, name.clone(), &target, name, false);
                    }
                    "pair_pattern" => {
                        let key = field_text(ctx, part, "key");
                        let value = part
                            .child_by_field_name("value")
                            .filter(|v| v.kind() == "identifier");
                        if let (Some(key), Some(value)) = (key, value) {
                            let local = ctx.text(value);
                            bind(ctx, local, &target, key, false);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    true
}

fn bind(ctx: &mut Ctx, local: String, target: &Option<String>, imported: String, namespace: bool) {
    ctx.bind(ImportBinding {
        local,
        target_path: target.clone(),
        imported,
        namespace,
    });
}

/// Names exported without `export` on their declaration: `export { a }`,
/// `export default a`, and CommonJS `module.exports` / `exports.x`.
fn exported_names(ctx: &Ctx, root: Node) -> HashSet<String> {
    let mut names = HashSet::new();
    for node in named_children(root) {
        match node.kind() {
            "export_statement" if node.child_by_field_name("source").is_none() => {
                if let Some(value) = node.child_by_field_name("value")
                    && value.kind() == "identifier"
                {
                    names.insert(ctx.text(value));
                }
                for clause in named_children(node)
                    .into_iter()
                    .filter(|n| n.kind() == "export_clause")
                {
                    for spec in named_children(clause) {
                        if let Some(name) = field_text(ctx, spec, "name") {
                            names.insert(name);
                        }
                    }
                }
            }
            "expression_statement" => {
                let Some(assignment) = named_children(node)
                    .into_iter()
                    .find(|n| n.kind() == "assignment_expression")
                else {
                    continue;
                };
                commonjs_exports(ctx, assignment, &mut names);
            }
            _ => {}
        }
    }
    names
}

fn commonjs_exports(ctx: &Ctx, assignment: Node, names: &mut HashSet<String>) {
    let (Some(left), Some(right)) = (
        assignment.child_by_field_name("left"),
        assignment.child_by_field_name("right"),
    ) else {
        return;
    };
    let target = collapse_ws(&ctx.text(left)).replace(' ', "");
    let whole_module = target == "module.exports";
    let one_export = target.starts_with("module.exports.") || target.starts_with("exports.");
    if !whole_module && !one_export {
        return;
    }
    match right.kind() {
        "identifier" => {
            names.insert(ctx.text(right));
        }
        "object" if whole_module => {
            for entry in named_children(right) {
                match entry.kind() {
                    "shorthand_property_identifier" => {
                        names.insert(ctx.text(entry));
                    }
                    "pair" => {
                        if let Some(value) = entry.child_by_field_name("value")
                            && value.kind() == "identifier"
                        {
                            names.insert(ctx.text(value));
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn field_text(ctx: &Ctx, node: Node, field: &str) -> Option<String> {
    node.child_by_field_name(field).map(|n| ctx.text(n))
}

fn string_value(ctx: &Ctx, node: Node) -> String {
    named_children(node)
        .into_iter()
        .find(|n| n.kind() == "string_fragment")
        .map(|n| ctx.text(n))
        .unwrap_or_else(|| ctx.text(node).trim_matches(['"', '\'', '`']).to_string())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::super::test_support::{edges, parse, s, symbol};
    use super::super::*;

    const TS: &str = r#"import Def, { load as loadUser } from './users';
import * as ns from '../lib/ns';

/** Saves a user.
 *
 * Retries on conflict.
 * @param user the user
 */
export async function save(user: User, opts?: Opts, retries = 3, ...rest: string[]): Promise<Result<User>> {
  ns.flush();
  return loadUser(user.id);
}

export class Store<T> extends Base<T> implements IStore {
  private db: Db;
  static create(root: string): Store<number> { return new Store(); }
  #secret() {}
  handle = (event: Event): void => { this.persist(event); };
  persist(event: Event) { helper(); }
}

interface IStore extends Readable {
  get(id: string): Row | undefined;
}

export const double = (x: number) => x * 2;
type Id = string;
const LIMIT: number = 10;
function helper() {}
"#;

    #[test]
    fn typescript_symbols_carry_params_returns_and_docs() {
        let fixture = tempfile::tempdir().unwrap();
        let actual = parse(fixture.path(), "src/store.ts", TS);

        let save = symbol(&actual, "save");
        let expected = SymbolSignature::default()
            .name("save")
            .qualified_name("save")
            .kind("function")
            .is_public(true)
            .start_line(9usize)
            .end_line(12usize)
            .params(vec![
                ParamSignature::new("user").type_annotation("User"),
                ParamSignature::new("opts?").type_annotation("Opts"),
                ParamSignature::new("retries").default_value("3"),
                ParamSignature::new("...rest").type_annotation("string[]"),
            ])
            .return_type("Promise<Result<User>>")
            .doc_summary("Saves a user.")
            .signature_text(
                "export async function save(user: User, opts?: Opts, retries = 3, ...rest: string[]): Promise<Result<User>>",
            )
            .hashed();
        assert_eq!(save, &expected);

        let names: Vec<_> = actual
            .symbols
            .iter()
            .map(|s| (s.qualified_name.as_str(), s.kind.as_str(), s.is_public))
            .collect();
        let expected_names = vec![
            ("save", "function", true),
            ("Store", "class", true),
            ("Store.create", "method", true),
            ("Store.#secret", "method", false),
            ("Store.handle", "method", true),
            ("Store.persist", "method", true),
            ("IStore", "interface", false),
            ("IStore.get", "method", false),
            ("double", "function", true),
            ("Id", "type", false),
            ("LIMIT", "const", false),
            ("helper", "function", false),
        ];
        assert_eq!(names, expected_names);
        assert_eq!(
            symbol(&actual, "Store.create").return_type,
            s("Store<number>")
        );
        assert_eq!(
            symbol(&actual, "LIMIT").signature_text,
            "const LIMIT: number"
        );
        assert_eq!(
            symbol(&actual, "double").signature_text,
            "export const double = (x: number) =>"
        );
    }

    #[test]
    fn typescript_edges_resolve_through_imports_and_members() {
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(fixture.path().join("src")).unwrap();
        std::fs::create_dir_all(fixture.path().join("lib")).unwrap();
        std::fs::write(
            fixture.path().join("src/users.ts"),
            "export function load() {}",
        )
        .unwrap();
        std::fs::write(fixture.path().join("lib/ns.js"), "").unwrap();
        let actual = parse(fixture.path(), "src/store.ts", TS);

        assert_eq!(
            edges(&actual, EdgeKind::Imports),
            vec![
                (None, s("src/users.ts"), "./users".to_string()),
                (None, s("lib/ns.js"), "../lib/ns".to_string()),
            ]
        );
        let calls = edges(&actual, EdgeKind::Calls);
        assert!(
            calls.contains(&(s("save"), s("lib/ns.js"), "flush".to_string())),
            "{calls:?}"
        );
        assert!(
            calls.contains(&(s("save"), s("src/users.ts"), "load".to_string())),
            "{calls:?}"
        );
        assert!(calls.contains(&(s("Store.create"), s("src/store.ts"), "Store".to_string())));
        assert!(calls.contains(&(
            s("Store.handle"),
            s("src/store.ts"),
            "Store.persist".to_string()
        )));
        assert!(calls.contains(&(s("Store.persist"), s("src/store.ts"), "helper".to_string())));

        let uses: Vec<_> = edges(&actual, EdgeKind::UsesType)
            .into_iter()
            .filter(|e| e.0 == s("save"))
            .map(|e| e.2)
            .collect();
        assert_eq!(uses, vec!["User", "Opts", "Promise", "Result"]);
        assert_eq!(
            edges(&actual, EdgeKind::Extends),
            vec![
                (s("Store"), None, "Base".to_string()),
                (s("IStore"), None, "Readable".to_string()),
            ]
        );
        assert_eq!(
            edges(&actual, EdgeKind::Implements),
            vec![(s("Store"), s("src/store.ts"), "IStore".to_string())]
        );
    }

    #[test]
    fn commonjs_exports_and_requires() {
        let fixture = tempfile::tempdir().unwrap();
        std::fs::write(fixture.path().join("workspace.js"), "").unwrap();
        let source = r#"const fs = require('fs');
const { findRoot, openMaster: open } = require('./workspace');
const ws = require('./workspace.js');

// Opens the store.
function openStore(dir = '.') {
  const { migrate } = require('./migrate');
  findRoot(dir); open(); ws.listWorkspaces(); fs.readFileSync(dir);
}
class MemoryStore extends Base { add(x) { this.save(x); } save() {} }
const internal = 1;
module.exports = { openStore, MemoryStore };
"#;
        let actual = parse(fixture.path(), "store.js", source);

        let names: Vec<_> = actual
            .symbols
            .iter()
            .map(|s| (s.qualified_name.as_str(), s.is_public))
            .collect();
        assert_eq!(
            names,
            vec![
                ("openStore", true),
                ("MemoryStore", true),
                ("MemoryStore.add", true),
                ("MemoryStore.save", true),
                ("internal", false),
            ]
        );
        let open = symbol(&actual, "openStore");
        assert_eq!(
            open.params,
            vec![ParamSignature::new("dir").default_value("'.'")]
        );
        assert_eq!(open.doc_summary, s("Opens the store."));

        let imports: Vec<_> = edges(&actual, EdgeKind::Imports)
            .into_iter()
            .map(|e| (e.1, e.2))
            .collect();
        assert_eq!(
            imports,
            vec![
                (None, "fs".to_string()),
                (s("workspace.js"), "./workspace".to_string()),
                (s("workspace.js"), "./workspace.js".to_string()),
                (None, "./migrate".to_string()),
            ]
        );
        let calls: Vec<_> = edges(&actual, EdgeKind::Calls)
            .into_iter()
            .filter(|e| e.0 == s("openStore"))
            .map(|e| (e.1, e.2))
            .collect();
        assert_eq!(
            calls,
            vec![
                (s("workspace.js"), "findRoot".to_string()),
                (s("workspace.js"), "openMaster".to_string()),
                (s("workspace.js"), "listWorkspaces".to_string()),
                (None, "fs.readFileSync".to_string()),
            ]
        );
        assert!(edges(&actual, EdgeKind::Calls).contains(&(
            s("MemoryStore.add"),
            s("store.js"),
            "MemoryStore.save".to_string()
        )));
    }

    #[test]
    fn tsx_and_jsx_components_parse() {
        let fixture = tempfile::tempdir().unwrap();
        let tsx = "export function Card({ title }: Props): JSX.Element {\n  return <div>{format(title)}</div>;\n}\n";
        let actual = parse(fixture.path(), "ui/Card.tsx", tsx);
        let card = symbol(&actual, "Card");
        assert_eq!(
            card.params,
            vec![ParamSignature::new("{ title }").type_annotation("Props")]
        );
        assert_eq!(card.return_type, s("JSX.Element"));
        assert_eq!((card.start_line, card.end_line), (1, 3));
        assert!(edges(&actual, EdgeKind::Calls).contains(&(s("Card"), None, "format".to_string())));

        let jsx =
            "export default function App(props) {\n  return <Card title={props.title} />;\n}\n";
        let actual = parse(fixture.path(), "ui/App.jsx", jsx);
        let app = symbol(&actual, "App");
        assert_eq!((app.kind.as_str(), app.is_public), ("function", true));
        assert_eq!(app.params, vec![ParamSignature::new("props")]);
        assert_eq!(actual.language, Language::Jsx);
    }
}
