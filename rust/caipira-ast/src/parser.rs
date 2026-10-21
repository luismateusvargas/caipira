//! Language detection, the shared symbol and edge model, and the extraction
//! core that the per-language walkers in `parser/` feed.
//!
//! Walkers only recognise declarations. Everything they have in common —
//! qualified names, doc summaries, signature text and hashes, call and type
//! references — lives in [`Ctx`], so every language reports the same shape.
//!
//! Imports are recorded as unresolved [`ImportRequest`]s. A separate link
//! step resolves them and every reference against this file's symbols and
//! imports; the same step re-links a stored [`LinkState`] when an imported
//! file appears or disappears, without reading or parsing the importer.

use std::collections::{HashMap, HashSet};

use derive_setters::Setters;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tree_sitter::Node;

use crate::error::AstError;
use crate::resolve::{ImportRequest, Probes, Resolver};
use crate::vue;

mod cpp;
mod golang;
mod javascript;
mod python;
mod rustlang;

const MAX_HEADER_CHARS: usize = 400;
const MAX_DOC_CHARS: usize = 300;
const MAX_CALLEE_CHARS: usize = 200;

/// A source language `caipira-ast` can index, as stored in `ast_files.language`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    JavaScript,
    Jsx,
    TypeScript,
    Tsx,
    Vue,
    Python,
    Rust,
    Go,
    Cpp,
}

impl Language {
    /// Detects the language from a file name's extension.
    ///
    /// # Arguments
    /// `path`: a file path; only the final component's extension is read.
    pub fn from_path(path: &str) -> Option<Self> {
        let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let (_, ext) = file_name.rsplit_once('.')?;
        let language = match ext.to_ascii_lowercase().as_str() {
            "js" | "mjs" | "cjs" => Self::JavaScript,
            "jsx" => Self::Jsx,
            "ts" | "mts" | "cts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "vue" => Self::Vue,
            "py" | "pyi" => Self::Python,
            "rs" => Self::Rust,
            "go" => Self::Go,
            "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" => Self::Cpp,
            _ => return None,
        };
        Some(language)
    }

    /// The lowercase name stored in `ast_files.language`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::JavaScript => "javascript",
            Self::Jsx => "jsx",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::Vue => "vue",
            Self::Python => "python",
            Self::Rust => "rust",
            Self::Go => "go",
            Self::Cpp => "cpp",
        }
    }

    fn grammar(self) -> Option<tree_sitter::Language> {
        let grammar = match self {
            Self::JavaScript | Self::Jsx => tree_sitter_javascript::LANGUAGE,
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX,
            Self::Python => tree_sitter_python::LANGUAGE,
            Self::Rust => tree_sitter_rust::LANGUAGE,
            Self::Go => tree_sitter_go::LANGUAGE,
            Self::Cpp => tree_sitter_cpp::LANGUAGE,
            Self::Vue => return None,
        };
        Some(grammar.into())
    }

    pub(crate) fn family(self) -> Family {
        match self {
            Self::JavaScript | Self::Jsx | Self::TypeScript | Self::Tsx | Self::Vue => {
                Family::Script
            }
            Self::Python => Family::Python,
            Self::Rust => Family::Rust,
            Self::Go => Family::Go,
            Self::Cpp => Family::Cpp,
        }
    }
}

/// Grammar families that share one walker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Family {
    Script,
    Python,
    Rust,
    Go,
    Cpp,
}

impl Family {
    fn separator(self) -> &'static str {
        match self {
            Self::Rust | Self::Cpp => "::",
            Self::Script | Self::Python | Self::Go => ".",
        }
    }
}

/// One declared parameter: what a function or method receives.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Setters)]
#[setters(strip_option, into)]
pub struct ParamSignature {
    /// The parameter pattern as written (`opts`, `...rest`, `{ a, b }`, `&self`).
    pub name: String,
    /// The declared type, without the leading `:`.
    pub type_annotation: Option<String>,
    /// The default value expression, if any.
    pub default_value: Option<String>,
}

impl ParamSignature {
    /// Creates an untyped parameter with no default.
    ///
    /// # Arguments
    /// `name`: the parameter pattern as written.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }
}

/// A top-level or member symbol declared in a source file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Setters)]
#[setters(strip_option, into)]
pub struct SymbolSignature {
    /// The declared name (`addObservation`).
    pub name: String,
    /// The name qualified by enclosing namespaces and types (`MemoryStore.addObservation`).
    pub qualified_name: String,
    /// Normalized kind: function, method, class, struct, enum, interface, trait, type, const, variable, namespace, module, macro, static, union.
    pub kind: String,
    /// Whether the symbol is part of the file's public surface.
    pub is_public: bool,
    /// 1-based first line, in the original file's numbering.
    pub start_line: usize,
    /// 1-based last line, in the original file's numbering.
    pub end_line: usize,
    /// Ordered parameters.
    pub params: Vec<ParamSignature>,
    /// Declared return type, if any.
    pub return_type: Option<String>,
    /// First paragraph of the leading doc comment or docstring.
    pub doc_summary: Option<String>,
    /// Normalized declaration header, without the body.
    pub signature_text: String,
    /// 16 hex chars of SHA-256 over (kind, qualified_name, is_public, params, return_type).
    pub signature_hash: String,
}

impl SymbolSignature {
    /// Returns the signature with `signature_hash` recomputed from its fields.
    pub fn hashed(mut self) -> Self {
        self.signature_hash = signature_hash(
            &self.kind,
            &self.qualified_name,
            self.is_public,
            &self.params,
            self.return_type.as_deref(),
        );
        self
    }
}

/// The relationship an [`AstEdge`] records.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    #[default]
    Calls,
    Imports,
    UsesType,
    Extends,
    Implements,
}

impl EdgeKind {
    /// The name stored in `ast_edges.edge_kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Calls => "calls",
            Self::Imports => "imports",
            Self::UsesType => "uses_type",
            Self::Extends => "extends",
            Self::Implements => "implements",
        }
    }
}

/// A graph edge from a symbol (or the file itself) to a target.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Setters)]
#[setters(strip_option, into)]
pub struct AstEdge {
    /// Qualified name of the enclosing symbol; `None` for file-level code and imports.
    pub source_symbol: Option<String>,
    /// Workspace-relative file the target lives in, when it could be resolved.
    pub target_path: Option<String>,
    /// The target: a qualified symbol name, a callee as written, or an import specifier.
    pub target_symbol: String,
    /// What kind of relationship this is.
    pub edge_kind: EdgeKind,
    /// 1-based line of the first occurrence.
    pub line: usize,
}

/// The parse of one source file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AstSnapshot {
    /// Workspace-relative path with forward slashes.
    pub path: String,
    /// Detected language.
    pub language: Language,
    /// Declared symbols in source order.
    pub symbols: Vec<SymbolSignature>,
    /// Deduplicated edges in source order.
    pub edges: Vec<AstEdge>,
}

/// Parses one file's contents into symbols and edges.
///
/// Invalid UTF-8 is tolerated: tree-sitter parses bytes and text is decoded
/// lossily. Syntax errors produce a partial tree, not a failure.
///
/// # Arguments
/// `rel_path`: workspace-relative path; selects the language and anchors import resolution.
/// `source`: the file's bytes.
/// `resolver`: resolves import specifiers to workspace files.
///
/// # Errors
/// `AstError::Unsupported` for an unknown extension; `AstError::Parse` when
/// tree-sitter rejects the grammar or returns no tree.
pub fn parse_source(
    rel_path: &str,
    source: &[u8],
    resolver: &Resolver,
) -> Result<AstSnapshot, AstError> {
    parse_linked(rel_path, source, resolver).map(|(snapshot, _)| snapshot)
}

/// What a file needs to be re-linked later without being read again.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Links {
    /// The file's unresolved imports and references.
    pub state: LinkState,
    /// Every path resolving its imports checked; when one of them enters or
    /// leaves the index, the file's edges may change.
    pub probes: Probes,
}

/// [`parse_source`], also returning the state needed to re-link the file.
///
/// # Arguments
/// As for [`parse_source`].
///
/// # Errors
/// As for [`parse_source`].
pub(crate) fn parse_linked(
    rel_path: &str,
    source: &[u8],
    resolver: &Resolver,
) -> Result<(AstSnapshot, Links), AstError> {
    let language =
        Language::from_path(rel_path).ok_or_else(|| AstError::Unsupported(rel_path.to_string()))?;
    let (grammar_language, text) = match language {
        Language::Vue => {
            let view = vue::script_view(source);
            (view.language, view.masked)
        }
        _ => (language, source.to_vec()),
    };
    let grammar = grammar_language.grammar().ok_or_else(|| AstError::Parse {
        path: rel_path.to_string(),
        message: "no grammar for language".into(),
    })?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&grammar).map_err(|e| AstError::Parse {
        path: rel_path.to_string(),
        message: format!("failed to load grammar: {e}"),
    })?;
    let tree = parser.parse(&text, None).ok_or_else(|| AstError::Parse {
        path: rel_path.to_string(),
        message: "tree-sitter returned no tree".into(),
    })?;

    let family = language.family();
    let mut ctx = Ctx::new(&text, family);
    let root = tree.root_node();
    match family {
        Family::Script => javascript::extract(&mut ctx, root),
        Family::Python => python::extract(&mut ctx, root),
        Family::Rust => rustlang::extract(&mut ctx, root),
        Family::Go => golang::extract(&mut ctx, root),
        Family::Cpp => cpp::extract(&mut ctx, root),
    }
    let (symbols, state) = ctx.finish();
    let names: Vec<(String, String)> = symbols
        .iter()
        .map(|s| (s.name.clone(), s.qualified_name.clone()))
        .collect();
    let (edges, probes) = link(rel_path, family, &names, &state, resolver);
    let snapshot = AstSnapshot {
        path: rel_path.to_string(),
        language,
        symbols,
        edges,
    };
    Ok((snapshot, Links { state, probes }))
}

/// Recomputes a file's edges from its stored [`LinkState`].
///
/// Gives exactly the edges a fresh parse would, as long as the file itself
/// is unchanged; only import resolution is redone.
///
/// # Arguments
/// `path`: the workspace-relative file. `symbols`: its `(name, qualified_name)`
/// pairs. `state`: its stored link state. `resolver`: the workspace resolver.
///
/// Returns `None` when `path` has no supported extension.
pub(crate) fn relink(
    path: &str,
    symbols: &[(String, String)],
    state: &LinkState,
    resolver: &Resolver,
) -> Option<(Vec<AstEdge>, Probes)> {
    let family = Language::from_path(path)?.family();
    Some(link(path, family, symbols, state, resolver))
}

// ── extraction core ──

/// A name a file binds from another module, used to resolve calls through it.
struct ImportBinding {
    /// The local name (`MS` in `from .store import MemoryStore as MS`).
    local: String,
    /// The workspace file the binding comes from, when resolved.
    target_path: Option<String>,
    /// The name inside the target module (`MemoryStore`), or the local name for namespaces.
    imported: String,
    /// True when the binding is the module itself (`import * as ns`, `const x = require()`).
    namespace: bool,
}

/// One import's contribution to a file's edges and bindings, kept
/// unresolved; `request` fields index [`LinkState::requests`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "item", rename_all = "snake_case")]
pub(crate) enum ImportItem {
    /// An `imports` edge to what `request` resolves to; `None` never resolves.
    Edge {
        specifier: String,
        request: Option<usize>,
        line: usize,
    },
    /// A name bound from a module, kept whether or not the module resolves.
    Bind {
        local: String,
        request: usize,
        imported: String,
        namespace: bool,
    },
    /// A Rust `use` leaf: binds only when it resolves, and binds the module
    /// itself when no item path is left inside the file.
    RustUse { local: String, request: usize },
    /// `from <module> import <name>`: the submodule when one exists,
    /// otherwise the name from the module.
    PythonFrom {
        module: String,
        module_request: usize,
        submodule: String,
        submodule_request: usize,
        local: String,
        imported: String,
        line: usize,
    },
}

/// Everything about a file's imports and references that linking needs,
/// so the file can be re-linked without being read or parsed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct LinkState {
    /// Distinct imports, resolved once each per link.
    requests: Vec<ImportRequest>,
    /// Imports in source order.
    items: Vec<ImportItem>,
    /// Call and type references in source order.
    refs: Vec<PendingRef>,
}

/// A reference waiting to be resolved once every symbol in the file is known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PendingRef {
    source: Option<String>,
    scope: Option<String>,
    target: String,
    via_self: bool,
    kind: EdgeKind,
    line: usize,
}

/// Everything a walker knows about one declaration.
pub(crate) struct Decl<'t> {
    /// The node whose span gives the symbol's lines.
    pub node: Node<'t>,
    /// The node whose preceding comments document the symbol.
    pub doc_anchor: Node<'t>,
    pub name: String,
    pub scope: Option<String>,
    pub kind: &'static str,
    pub is_public: bool,
    pub params: Vec<ParamSignature>,
    pub return_type: Option<String>,
    /// A docstring found inside the declaration, which outranks comments.
    pub doc: Option<String>,
    pub header: String,
}

impl<'t> Decl<'t> {
    pub fn new(node: Node<'t>, name: String, kind: &'static str) -> Self {
        Self {
            node,
            doc_anchor: node,
            name,
            scope: None,
            kind,
            is_public: false,
            params: Vec::new(),
            return_type: None,
            doc: None,
            header: String::new(),
        }
    }
}

/// Per-file extraction state shared by every language walker.
pub(crate) struct Ctx<'t> {
    pub src: &'t [u8],
    pub family: Family,
    symbols: Vec<SymbolSignature>,
    links: LinkState,
}

impl<'t> Ctx<'t> {
    fn new(src: &'t [u8], family: Family) -> Self {
        Self {
            src,
            family,
            symbols: Vec::new(),
            links: LinkState::default(),
        }
    }

    pub fn text(&self, node: Node) -> String {
        lossy(&self.src[node.byte_range()])
    }

    pub fn line(node: Node) -> usize {
        node.start_position().row + 1
    }

    pub fn qualify(&self, scope: Option<&str>, name: &str) -> String {
        match scope {
            Some(scope) if !scope.is_empty() => format!("{scope}{}{name}", self.family.separator()),
            _ => name.to_string(),
        }
    }

    /// The declaration header from `start` up to `body`, whitespace collapsed.
    pub fn header(&self, start: Node, body: Option<Node>) -> String {
        let end = body
            .map_or(start.end_byte(), |b| b.start_byte())
            .max(start.start_byte());
        let mut header = collapse_ws(&lossy(&self.src[start.start_byte()..end]));
        loop {
            let trimmed_len = header.trim_end().len();
            header.truncate(trimmed_len);
            let strip = header.ends_with('{')
                || header.ends_with(';')
                || (header.ends_with(':') && !header.ends_with("::"))
                || (header.ends_with('=') && !header.ends_with("=>") && !header.ends_with("=="));
            if !strip {
                break;
            }
            header.pop();
        }
        truncate_chars(header, MAX_HEADER_CHARS)
    }

    /// Records a symbol and returns its qualified name.
    pub fn push(&mut self, decl: Decl) -> String {
        let qualified_name = self.qualify(decl.scope.as_deref(), &decl.name);
        let doc_summary = decl.doc.or_else(|| self.leading_doc(decl.doc_anchor));
        let symbol = SymbolSignature {
            name: decl.name,
            qualified_name: qualified_name.clone(),
            kind: decl.kind.to_string(),
            is_public: decl.is_public,
            start_line: decl.node.start_position().row + 1,
            end_line: decl.node.end_position().row + 1,
            params: decl.params,
            return_type: decl.return_type.filter(|t| !t.is_empty()),
            doc_summary,
            signature_text: decl.header,
            signature_hash: String::new(),
        }
        .hashed();
        self.symbols.push(symbol);
        qualified_name
    }

    /// Registers an import for the link step and returns its handle.
    pub fn request(&mut self, request: ImportRequest) -> usize {
        let requests = &mut self.links.requests;
        requests
            .iter()
            .position(|r| *r == request)
            .unwrap_or_else(|| {
                requests.push(request);
                requests.len() - 1
            })
    }

    /// Binds `local` to `imported` from the module `request` resolves to.
    pub fn bind(&mut self, local: String, request: usize, imported: String, namespace: bool) {
        if !local.is_empty() {
            self.links.items.push(ImportItem::Bind {
                local,
                request,
                imported,
                namespace,
            });
        }
    }

    /// Binds `local` from a Rust `use` path, once it resolves.
    pub fn bind_use(&mut self, local: String, request: usize) {
        if !local.is_empty() {
            self.links
                .items
                .push(ImportItem::RustUse { local, request });
        }
    }

    /// Records one name of a Python `from <module> import <name>`.
    pub fn import_from(&mut self, item: ImportItem) {
        self.links.items.push(item);
    }

    /// Records an `imports` edge to `specifier`; `request` resolves its file.
    pub fn import_edge(&mut self, specifier: &str, request: Option<usize>, line: usize) {
        if !specifier.is_empty() {
            self.links.items.push(ImportItem::Edge {
                specifier: specifier.to_string(),
                request,
                line,
            });
        }
    }

    /// Records an `extends`/`implements`/`uses_type` reference to a type name.
    pub fn type_edge(&mut self, kind: EdgeKind, source: &str, scope: Option<&str>, node: Node) {
        let target = strip_angle_groups(&self.text(node).replace(char::is_whitespace, ""));
        if target.is_empty() || target.len() > MAX_CALLEE_CHARS {
            return;
        }
        self.links.refs.push(PendingRef {
            source: Some(source.to_string()),
            scope: scope.map(str::to_string),
            target,
            via_self: false,
            kind,
            line: Self::line(node),
        });
    }

    /// Collects `uses_type` references from a parameter or return type annotation.
    pub fn type_refs(&mut self, node: Node, source: &str, generics: &HashSet<String>) {
        let mut stack = vec![node];
        while let Some(current) = stack.pop() {
            if self.is_type_name(current) {
                let name = strip_angle_groups(&self.text(current));
                let name = name.trim_matches(['"', '\'']).to_string();
                if !name.is_empty() && !generics.contains(&name) && !self.is_builtin_type(&name) {
                    self.links.refs.push(PendingRef {
                        source: Some(source.to_string()),
                        scope: None,
                        target: name,
                        via_self: false,
                        kind: EdgeKind::UsesType,
                        line: Self::line(current),
                    });
                }
                continue;
            }
            let mut kids = named_children(current);
            kids.reverse();
            stack.extend(kids);
        }
    }

    fn is_type_name(&self, node: Node) -> bool {
        match (self.family, node.kind()) {
            (_, "type_identifier") => true,
            (Family::Script, "nested_type_identifier") => true,
            (Family::Rust, "scoped_type_identifier") => true,
            (Family::Go, "qualified_type") => true,
            (Family::Cpp, "qualified_identifier") => true,
            (Family::Python, "identifier" | "attribute") => true,
            (Family::Python, "string_content") => is_identifier_path(&self.text(node)),
            _ => false,
        }
    }

    fn is_builtin_type(&self, name: &str) -> bool {
        const PYTHON: &[&str] = &[
            "int",
            "str",
            "float",
            "bool",
            "bytes",
            "None",
            "object",
            "list",
            "dict",
            "set",
            "tuple",
            "frozenset",
            "type",
            "complex",
            "bytearray",
            "Any",
            "Optional",
            "Union",
            "List",
            "Dict",
            "Set",
            "Tuple",
            "Callable",
            "Iterable",
            "Iterator",
            "Sequence",
            "Mapping",
            "Generator",
            "Type",
            "Literal",
            "Self",
        ];
        const GO: &[&str] = &[
            "bool",
            "string",
            "int",
            "int8",
            "int16",
            "int32",
            "int64",
            "uint",
            "uint8",
            "uint16",
            "uint32",
            "uint64",
            "uintptr",
            "float32",
            "float64",
            "complex64",
            "complex128",
            "byte",
            "rune",
            "error",
            "any",
            "comparable",
        ];
        match self.family {
            Family::Python => PYTHON.contains(&name),
            Family::Go => GO.contains(&name),
            Family::Rust => name == "Self",
            Family::Script | Family::Cpp => false,
        }
    }

    /// Collects call references inside `node`, attributed to `source`.
    ///
    /// `scope` is the enclosing type, so `this.x()` / `self.x()` can resolve
    /// to its member; `receiver` is a Go method's receiver name.
    pub fn collect_calls(
        &mut self,
        node: Node,
        source: Option<&str>,
        scope: Option<&str>,
        receiver: Option<&str>,
    ) {
        let mut stack = vec![node];
        while let Some(current) = stack.pop() {
            if let Some(callee) = self.callee(current)
                && !(self.family == Family::Script && javascript::import_call(self, current))
            {
                self.call_ref(callee, source, scope, receiver);
            }
            let mut kids = named_children(current);
            kids.reverse();
            stack.extend(kids);
        }
    }

    fn callee<'n>(&self, node: Node<'n>) -> Option<Node<'n>> {
        match (self.family, node.kind()) {
            (Family::Script, "call_expression") => node.child_by_field_name("function"),
            (Family::Script, "new_expression") => node.child_by_field_name("constructor"),
            (Family::Python, "call") => node.child_by_field_name("function"),
            (Family::Rust | Family::Go, "call_expression") => {
                let function = node.child_by_field_name("function")?;
                match function.kind() {
                    "generic_function" => function.child_by_field_name("function"),
                    _ => Some(function),
                }
            }
            (Family::Cpp, "call_expression") => node.child_by_field_name("function"),
            (Family::Cpp, "new_expression") => node.child_by_field_name("type"),
            _ => None,
        }
    }

    fn call_ref(
        &mut self,
        callee: Node,
        source: Option<&str>,
        scope: Option<&str>,
        receiver: Option<&str>,
    ) {
        const NAMEABLE: &[&str] = &[
            "identifier",
            "property_identifier",
            "member_expression",
            "attribute",
            "field_expression",
            "scoped_identifier",
            "qualified_identifier",
            "selector_expression",
            "template_function",
            "type_identifier",
            "nested_identifier",
        ];
        if !NAMEABLE.contains(&callee.kind()) {
            return;
        }
        let Some((target, via_self)) = normalize_callee(&self.text(callee), self.family, receiver)
        else {
            return;
        };
        self.links.refs.push(PendingRef {
            source: source.map(str::to_string),
            scope: scope.map(str::to_string),
            target,
            via_self,
            kind: EdgeKind::Calls,
            line: Self::line(callee),
        });
    }

    /// The first paragraph of the comments immediately above `anchor`.
    fn leading_doc(&self, anchor: Node) -> Option<String> {
        let mut comments = Vec::new();
        let mut next_row = anchor.start_position().row;
        let mut cursor = anchor.prev_sibling();
        while let Some(node) = cursor {
            if matches!(node.kind(), "attribute_item" | "decorator") {
                next_row = node.start_position().row;
                cursor = node.prev_sibling();
                continue;
            }
            if !matches!(node.kind(), "comment" | "line_comment" | "block_comment") {
                break;
            }
            if end_row(node) + 1 < next_row {
                break;
            }
            comments.push(self.text(node));
            next_row = node.start_position().row;
            cursor = node.prev_sibling();
        }
        comments.reverse();
        self.doc_summary(&comments)
    }

    /// Picks the doc comment from the comments directly above a declaration.
    ///
    /// A `/** */` block wins; when it holds only `@tags`, the `//` run above
    /// it still explains the declaration and is used instead.
    fn doc_summary(&self, comments: &[String]) -> Option<String> {
        let (last, earlier) = comments.split_last()?;
        let is_block_doc = |c: &str| c.starts_with("/**") && !c.starts_with("/***");
        let is_line_doc = |c: &str| c.starts_with("///") && !c.starts_with("////");
        let is_slash = |c: &str| c.starts_with("//") && !is_directive(c);
        match self.family {
            Family::Rust if is_block_doc(last) => paragraph_of(&[last]),
            Family::Rust => paragraph_of(&trailing_run(comments, |c| is_line_doc(c))),
            Family::Python => paragraph_of(&trailing_run(comments, |c| c.starts_with('#'))),
            Family::Script | Family::Go | Family::Cpp if is_block_doc(last) => {
                paragraph_of(&[last])
                    .or_else(|| paragraph_of(&trailing_run(earlier, |c| is_slash(c))))
            }
            Family::Script | Family::Go | Family::Cpp => {
                paragraph_of(&trailing_run(comments, |c| is_slash(c)))
            }
        }
    }

    /// The file's symbols and the state the link step needs.
    fn finish(self) -> (Vec<SymbolSignature>, LinkState) {
        (self.symbols, self.links)
    }
}

/// Resolves a file's imports, then its references against its own symbols
/// and those imports, and returns deduplicated edges plus the paths probed.
fn link(
    path: &str,
    family: Family,
    symbols: &[(String, String)],
    state: &LinkState,
    resolver: &Resolver,
) -> (Vec<AstEdge>, Probes) {
    let mut probes = Probes::new();
    let resolved: Vec<Option<(String, String)>> = state
        .requests
        .iter()
        .map(|request| resolver.resolve(path, request, &mut probes))
        .collect();
    let resolution = |request: usize| resolved.get(request).cloned().flatten();
    let file = |request: usize| resolution(request).map(|(file, _)| file);

    let mut imports = Vec::new();
    let mut bindings = Vec::new();
    let mut import = |specifier: &str, target_path: Option<String>, line: usize| {
        imports.push(AstEdge {
            source_symbol: None,
            target_path,
            target_symbol: specifier.to_string(),
            edge_kind: EdgeKind::Imports,
            line,
        });
    };
    for item in &state.items {
        match item {
            ImportItem::Edge {
                specifier,
                request,
                line,
            } => import(specifier, request.and_then(file), *line),
            ImportItem::Bind {
                local,
                request,
                imported,
                namespace,
            } => bindings.push(ImportBinding {
                local: local.clone(),
                target_path: file(*request),
                imported: imported.clone(),
                namespace: *namespace,
            }),
            ImportItem::RustUse { local, request } => {
                if let Some((file, rest)) = resolution(*request) {
                    let namespace = rest.is_empty();
                    bindings.push(ImportBinding {
                        local: local.clone(),
                        target_path: Some(file),
                        imported: if namespace { local.clone() } else { rest },
                        namespace,
                    });
                }
            }
            ImportItem::PythonFrom {
                module,
                module_request,
                submodule,
                submodule_request,
                local,
                imported,
                line,
            } => match file(*submodule_request) {
                // `from . import utils` imports a submodule, not a name.
                Some(target) => {
                    import(submodule, Some(target.clone()), *line);
                    bindings.push(ImportBinding {
                        local: local.clone(),
                        target_path: Some(target),
                        imported: local.clone(),
                        namespace: true,
                    });
                }
                None => {
                    import(module, file(*module_request), *line);
                    bindings.push(ImportBinding {
                        local: local.clone(),
                        target_path: file(*module_request),
                        imported: imported.clone(),
                        namespace: false,
                    });
                }
            },
        }
    }
    bindings.retain(|b| !b.local.is_empty());

    let linker = Linker {
        path,
        family,
        bindings,
        qualified: symbols.iter().map(|(_, q)| q.as_str()).collect(),
        by_name: symbols
            .iter()
            .fold(HashMap::new(), |mut by_name, (name, q)| {
                by_name
                    .entry(name.as_str())
                    .or_insert_with(Vec::new)
                    .push(q.as_str());
                by_name
            }),
    };
    let mut edges = Vec::with_capacity(imports.len() + state.refs.len());
    let mut seen = HashSet::new();
    for edge in imports.into_iter().filter(|e| !e.target_symbol.is_empty()) {
        let key = (
            None,
            edge.target_path.clone(),
            edge.target_symbol.clone(),
            edge.edge_kind,
        );
        if seen.insert(key) {
            edges.push(edge);
        }
    }
    for pending in &state.refs {
        let (target_path, target_symbol) = linker.resolve(pending);
        let key = (
            pending.source.clone(),
            target_path.clone(),
            target_symbol.clone(),
            pending.kind,
        );
        if seen.insert(key) {
            edges.push(AstEdge {
                source_symbol: pending.source.clone(),
                target_path,
                target_symbol,
                edge_kind: pending.kind,
                line: pending.line,
            });
        }
    }
    (edges, probes)
}

/// Resolves references against one file's symbols and import bindings.
struct Linker<'a> {
    path: &'a str,
    family: Family,
    bindings: Vec<ImportBinding>,
    qualified: HashSet<&'a str>,
    by_name: HashMap<&'a str, Vec<&'a str>>,
}

impl Linker<'_> {
    fn resolve(&self, pending: &PendingRef) -> (Option<String>, String) {
        let here = || Some(self.path.to_string());
        let target = pending.target.as_str();
        let sep = self.family.separator();
        if self.qualified.contains(target) {
            return (here(), target.to_string());
        }
        // Members of the enclosing type: `this.x()`, `self.x()`, and C++'s
        // implicit `this` for an unqualified call inside a method.
        if let Some(scope) = pending.scope.as_deref()
            && (pending.via_self || self.family == Family::Cpp)
        {
            let member = format!("{scope}{sep}{target}");
            if self.qualified.contains(member.as_str()) {
                return (here(), member);
            }
        }
        let segments: Vec<&str> = split_path(target);
        if !pending.via_self
            && let Some(first) = segments.first()
            && let Some(binding) = self.bindings.iter().rev().find(|b| b.local == *first)
            && binding.target_path.is_some()
        {
            let rest = segments[1..].join(sep);
            let symbol = match (binding.namespace, rest.is_empty()) {
                (_, true) => binding.imported.clone(),
                (true, false) => rest,
                (false, false) => format!("{}{sep}{rest}", binding.imported),
            };
            return (binding.target_path.clone(), symbol);
        }
        if segments.len() == 1
            && let Some(candidates) = self.by_name.get(target)
            && candidates.len() == 1
        {
            return (here(), candidates[0].to_string());
        }
        (None, target.to_string())
    }
}

// ── helpers shared by the walkers ──

pub(crate) fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

pub(crate) fn children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

/// The last row a node's text occupies; Rust line comments end at column 0
/// of the following row because they include their newline.
fn end_row(node: Node) -> usize {
    let end = node.end_position();
    if end.column == 0 && end.row > node.start_position().row {
        end.row - 1
    } else {
        end.row
    }
}

pub(crate) fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub(crate) fn collapse_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Collapsed text with a trailing annotation colon removed (`: string` -> `string`).
pub(crate) fn annotation_text(ctx: &Ctx, node: Node) -> String {
    let text = collapse_ws(&ctx.text(node));
    text.trim_start_matches(':').trim().to_string()
}

fn truncate_chars(mut text: String, max: usize) -> String {
    if let Some((idx, _)) = text.char_indices().nth(max) {
        text.truncate(idx);
    }
    text
}

fn signature_hash(
    kind: &str,
    qualified_name: &str,
    is_public: bool,
    params: &[ParamSignature],
    return_type: Option<&str>,
) -> String {
    let payload = serde_json::to_vec(&(kind, qualified_name, is_public, params, return_type))
        .unwrap_or_default();
    let digest = Sha256::digest(&payload);
    hex::encode(&digest[..8])
}

/// Removes `<...>` groups, so `Vec::<u8>::new` and `Store<T>` compare by name.
pub(crate) fn strip_angle_groups(text: &str) -> String {
    let mut depth = 0usize;
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.replace("::::", "::")
}

fn split_path(target: &str) -> Vec<&str> {
    target
        .split("::")
        .flat_map(|part| part.split('.'))
        .filter(|s| !s.is_empty())
        .collect()
}

fn is_identifier_path(text: &str) -> bool {
    !text.is_empty()
        && text.split('.').all(|part| {
            let mut chars = part.chars();
            chars.next().is_some_and(|c| c.is_alphabetic() || c == '_')
                && chars.all(|c| c.is_alphanumeric() || c == '_')
        })
}

fn normalize_callee(text: &str, family: Family, receiver: Option<&str>) -> Option<(String, bool)> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let mut target = strip_angle_groups(&compact)
        .replace("?.", ".")
        .replace("->", ".");
    let receiver_prefix = receiver.map(|r| format!("{r}."));
    let prefixes: Vec<&str> = match family {
        Family::Script => vec!["this."],
        Family::Python => vec!["self.", "cls."],
        Family::Rust => vec!["self.", "Self::", "self::"],
        Family::Cpp => vec!["this."],
        Family::Go => receiver_prefix.iter().map(String::as_str).collect(),
    };
    let mut via_self = false;
    for prefix in prefixes {
        if let Some(rest) = target.strip_prefix(prefix) {
            target = rest.to_string();
            via_self = true;
            break;
        }
    }
    let rejected = |c: char| "()[]{}\"'`,;".contains(c);
    if target.is_empty() || target.len() > MAX_CALLEE_CHARS || target.contains(rejected) {
        return None;
    }
    Some((target, via_self))
}

fn is_directive(comment: &str) -> bool {
    const DIRECTIVES: &[&str] = &[
        "//go:",
        "//nolint",
        "// eslint-",
        "//eslint-",
        "// @ts-",
        "// prettier-",
        "// #region",
    ];
    DIRECTIVES.iter().any(|d| comment.starts_with(d))
}

fn trailing_run(comments: &[String], keep: impl Fn(&str) -> bool) -> Vec<&String> {
    let mut run: Vec<&String> = comments.iter().rev().take_while(|c| keep(c)).collect();
    run.reverse();
    run
}

fn paragraph_of(comments: &[&String]) -> Option<String> {
    let text: Vec<String> = comments.iter().map(|c| clean_comment(c)).collect();
    first_paragraph(&text.join("\n"))
}

fn clean_comment(raw: &str) -> String {
    raw.lines()
        .map(|line| {
            let mut t = line.trim();
            t = t.strip_suffix("*/").unwrap_or(t).trim_end();
            for prefix in ["/**", "/*!", "/*", "///", "//!", "//", "#", "*"] {
                if let Some(rest) = t.strip_prefix(prefix) {
                    t = rest;
                    break;
                }
            }
            t.trim().to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The first paragraph of cleaned doc text: up to a blank line or an `@tag`.
pub(crate) fn first_paragraph(text: &str) -> Option<String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .skip_while(|l| l.is_empty())
        .take_while(|l| !l.is_empty() && !l.starts_with('@'))
        .collect();
    let paragraph = collapse_ws(&lines.join(" "));
    if paragraph.is_empty() {
        None
    } else {
        Some(truncate_chars(paragraph, MAX_DOC_CHARS))
    }
}

/// Generic parameter names declared in a `type_parameters` node.
pub(crate) fn generic_names(ctx: &Ctx, type_parameters: Option<Node>) -> HashSet<String> {
    let mut names = HashSet::new();
    let Some(list) = type_parameters else {
        return names;
    };
    for param in named_children(list) {
        let name = param.child_by_field_name("name").or_else(|| {
            named_children(param)
                .into_iter()
                .find(|n| n.kind() == "type_identifier")
        });
        if let Some(name) = name {
            names.insert(ctx.text(name));
        }
    }
    names
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Parses `source` as `path` against a resolver rooted at `root`.
    pub fn parse(root: &std::path::Path, path: &str, source: &str) -> AstSnapshot {
        parse_source(path, source.as_bytes(), &Resolver::new(root)).expect("parse")
    }

    /// The symbol with this qualified name.
    pub fn symbol<'s>(snapshot: &'s AstSnapshot, qualified_name: &str) -> &'s SymbolSignature {
        snapshot
            .symbols
            .iter()
            .find(|s| s.qualified_name == qualified_name)
            .unwrap_or_else(|| {
                let names: Vec<_> = snapshot.symbols.iter().map(|s| &s.qualified_name).collect();
                panic!("no symbol {qualified_name}; have {names:?}")
            })
    }

    /// `(source, target_path, target_symbol)` for every edge of one kind.
    pub fn edges(
        snapshot: &AstSnapshot,
        kind: EdgeKind,
    ) -> Vec<(Option<String>, Option<String>, String)> {
        snapshot
            .edges
            .iter()
            .filter(|e| e.edge_kind == kind)
            .map(|e| {
                (
                    e.source_symbol.clone(),
                    e.target_path.clone(),
                    e.target_symbol.clone(),
                )
            })
            .collect()
    }

    pub fn s(text: &str) -> Option<String> {
        Some(text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn language_detection_covers_every_family() {
        let fixture = [
            "a.js",
            "a.mjs",
            "a.cjs",
            "a.jsx",
            "a.ts",
            "a.tsx",
            "a.vue",
            "a.py",
            "a.pyi",
            "a.rs",
            "a.go",
            "a.c",
            "a.cc",
            "a.cpp",
            "a.cxx",
            "a.h",
            "a.hh",
            "a.hpp",
            "a.hxx",
            "a.txt",
            "dir.d/Makefile",
        ];
        let actual: Vec<_> = fixture
            .iter()
            .map(|p| Language::from_path(p).map(Language::as_str))
            .collect();
        let expected = vec![
            Some("javascript"),
            Some("javascript"),
            Some("javascript"),
            Some("jsx"),
            Some("typescript"),
            Some("tsx"),
            Some("vue"),
            Some("python"),
            Some("python"),
            Some("rust"),
            Some("go"),
            Some("cpp"),
            Some("cpp"),
            Some("cpp"),
            Some("cpp"),
            Some("cpp"),
            Some("cpp"),
            Some("cpp"),
            Some("cpp"),
            None,
            None,
        ];
        assert_eq!(actual, expected);
    }

    #[test]
    fn signature_hash_is_16_hex_and_ignores_lines_and_docs() {
        let fixture = SymbolSignature::default()
            .name("f")
            .qualified_name("f")
            .kind("function")
            .params(vec![ParamSignature::new("a").type_annotation("i32")])
            .return_type("bool");
        let actual = fixture
            .clone()
            .start_line(10usize)
            .doc_summary("moved")
            .hashed();
        let expected = fixture.clone().hashed();
        assert_eq!(actual.signature_hash, expected.signature_hash);
        assert_eq!(actual.signature_hash.len(), 16);
        assert!(actual.signature_hash.chars().all(|c| c.is_ascii_hexdigit()));
        let changed = fixture.return_type("i32").hashed();
        assert!(changed.signature_hash != expected.signature_hash);
    }

    #[test]
    fn first_paragraph_stops_at_blank_lines_and_tags() {
        let fixture = "\nSaves the row.\nTwice.\n\nSecond paragraph.";
        assert_eq!(
            first_paragraph(fixture),
            Some("Saves the row. Twice.".to_string())
        );
        assert_eq!(first_paragraph("@param x the x"), None);
    }

    #[test]
    fn tag_only_jsdoc_falls_back_to_the_line_comments_above() {
        let dir = tempfile::tempdir().unwrap();
        let source = "// Resolves the root.\n/** @param {string} dir */\nfunction findRoot(dir) {}\n\n/** @returns {string} */\nfunction id() {}\n";
        let actual = test_support::parse(dir.path(), "w.js", source);
        let docs: Vec<_> = actual
            .symbols
            .iter()
            .map(|s| s.doc_summary.clone())
            .collect();
        assert_eq!(docs, vec![Some("Resolves the root.".to_string()), None]);
    }

    #[test]
    fn callee_normalization_strips_receivers_and_generics() {
        let actual = vec![
            normalize_callee("this.store.add", Family::Script, None),
            normalize_callee("a?.b", Family::Script, None),
            normalize_callee("Vec::<u8>::new", Family::Rust, None),
            normalize_callee("s.helper", Family::Go, Some("s")),
            normalize_callee("this->run", Family::Cpp, None),
            normalize_callee("a(1).b", Family::Script, None),
        ];
        let expected = vec![
            Some(("store.add".to_string(), true)),
            Some(("a.b".to_string(), false)),
            Some(("Vec::new".to_string(), false)),
            Some(("helper".to_string(), true)),
            Some(("run".to_string(), true)),
            None,
        ];
        assert_eq!(actual, expected);
    }

    /// Files that import one another, and the targets that appear later.
    const LINKED: &[(&str, &str)] = &[
        (
            "src/app.js",
            "import { provide as p } from './provider.js';\nimport * as ns from './gone';\n\
             const util = require('./util');\nexport function run() { p(); ns.x(); util.y(); local(); }\n\
             function local() {}\n",
        ),
        (
            "pkg/app.py",
            "from . import store\nfrom .models import User as U\nimport pkg.sub\n\
             def f(u: U) -> None:\n    store.save(U())\n",
        ),
        (
            "src/lib.rs",
            "mod store;\nuse crate::store::Store;\nuse self::gone::X;\n\
             pub fn open() -> Store { Store::new() }\n",
        ),
        (
            "main.go",
            "package main\nimport \"example.com/app/internal/db\"\nfunc main() { db.Open() }\n",
        ),
        (
            "src/main.cpp",
            "#include \"store.hpp\"\n#include <vector>\nint main() { return run(); }\n",
        ),
    ];
    const TARGETS: &[&str] = &[
        "src/provider.js",
        "src/util.js",
        "pkg/store.py",
        "pkg/models.py",
        "pkg/sub.py",
        "src/store.rs",
        "internal/db/db.go",
        "src/store.hpp",
    ];

    #[test]
    fn relinking_stored_state_matches_a_fresh_parse() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let write = |path: &str, text: &str| {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("Cargo.toml", "[package]\nname = \"x\"\n");
        write("go.mod", "module example.com/app\n");
        write("pkg/__init__.py", "");
        for (path, text) in LINKED {
            write(path, text);
        }
        let resolver = Resolver::new(root);
        let parse =
            |path: &str, text: &str| parse_linked(path, text.as_bytes(), &resolver).expect("parse");
        let names = |snapshot: &AstSnapshot| {
            snapshot
                .symbols
                .iter()
                .map(|s| (s.name.clone(), s.qualified_name.clone()))
                .collect::<Vec<_>>()
        };
        let stored: Vec<(AstSnapshot, String)> = LINKED
            .iter()
            .map(|(path, text)| {
                let (snapshot, links) = parse(path, text);
                (snapshot, serde_json::to_string(&links.state).unwrap())
            })
            .collect();

        for step in ["targets appear", "targets disappear"] {
            for target in TARGETS {
                match step {
                    "targets appear" => write(target, ""),
                    _ => std::fs::remove_file(root.join(target)).unwrap(),
                }
            }
            if step == "targets disappear" {
                // A Go import resolves to its package directory.
                std::fs::remove_dir_all(root.join("internal")).unwrap();
            }
            for ((path, text), (before, state_json)) in LINKED.iter().zip(&stored) {
                let (fresh, fresh_links) = parse(path, text);
                let state: LinkState = serde_json::from_str(state_json).unwrap();
                let relinked = relink(path, &names(before), &state, &resolver).unwrap();
                assert_eq!(
                    relinked,
                    (fresh.edges.clone(), fresh_links.probes),
                    "{path}: {step}"
                );
                let changed = fresh.edges != before.edges;
                assert_eq!(changed, step == "targets appear", "{path}: {step}");
            }
        }
    }

    #[test]
    fn unsupported_extension_is_an_error() {
        let actual = parse_source(
            "notes.txt",
            b"hello",
            &Resolver::new(std::path::Path::new(".")),
        );
        assert!(matches!(actual, Err(AstError::Unsupported(_))));
    }
}
