//! Incremental polyglot symbol indexer for Caipira workspace databases.
//!
//! Parses JavaScript, TypeScript, JSX/TSX, Vue single-file components,
//! Python, Rust, Go, and C/C++ with tree-sitter into symbol signatures and
//! graph edges, and keeps a workspace's `ast_*` tables in step with the files
//! on disk through a three-tier gate: `(size, mtime)` first, `sha256`
//! second, and a tree-sitter parse only for files whose content changed.

mod diff;
mod error;
mod parser;
mod resolve;
mod store;
mod vue;
mod walker;

pub use diff::{AstDiffReport, SymbolChange, compare_snapshots};
pub use error::AstError;
pub use parser::{
    AstEdge, AstSnapshot, EdgeKind, Language, ParamSignature, SymbolSignature, parse_source,
};
pub use resolve::Resolver;
pub use store::{
    FileFailure, FileUpdate, IndexStats, UpdateStatus, index_workspace, load_symbols,
    open_database, update_single_file,
};
pub use walker::{WalkedFile, walk_workspace, workspace_relative};
