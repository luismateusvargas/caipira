# Block 1: Polyglot Rust AST Engine (`caipira-ast`) & Incremental SQLite Symbol Store

Status: ready
Project rules: specs/project.md
Target files: rust/caipira-ast/Cargo.toml, rust/caipira-ast/src/main.rs, rust/caipira-ast/src/lib.rs, rust/caipira-ast/src/walker.rs, rust/caipira-ast/src/parser.rs, rust/caipira-ast/src/vue.rs, rust/caipira-ast/src/store.rs, ast.js, workspace.js, migrate.js, install.js, test/test-ast.js

## Outcome and boundary

Build the native Rust AST indexer crate `rust/caipira-ast` (porting and upgrading Sota's `sota_walker` and `sota_domain::ast` from `/home/htxzz77/Projects/sota`), wire it to Caipira's per-workspace SQLite database (`<workspace>.db`) and master schema (`master.db`), and expose a clean Node.js persistence/bridge module in `ast.js`.

What changes:
- Create `rust/caipira-ast` supporting all 8 language families from `spec-tech`:
  - **JavaScript** (`.js`, `.mjs`, `.cjs`) via `tree-sitter-javascript`
  - **TypeScript** (`.ts`) via `tree-sitter-typescript::LANGUAGE_TYPESCRIPT`
  - **React** (`.jsx`, `.tsx`) via `tree-sitter-javascript` and `tree-sitter-typescript::LANGUAGE_TSX`
  - **Vue** (`.vue` Single-File Components) via `<script>` / `<script setup>` block extraction in `rust/caipira-ast/src/vue.rs` preserving original file line numbers, delegated to JS/TS/JSX/TSX `tree-sitter` grammars
  - **Python** (`.py`, `.pyi`) via `tree-sitter-python`
  - **Rust** (`.rs`) via `tree-sitter-rust`
  - **Go** (`.go`) via `tree-sitter-go`
  - **C++** (`.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.hxx`) via `tree-sitter-cpp`
- Upgrade Sota's `SymbolSignature` to extract:
  - `params`: ordered list of `{ name, type_annotation, default_value }` (what the function/method receives)
  - `return_type`: return type annotation string if present (what the function/method returns)
  - `doc_summary`: first paragraph of leading doc comments (`///`, `/** ... */`, `#`, or Python triple-quoted docstring)
  - `signature_text`: normalized human-readable declaration header
  - `signature_hash`: 16-hex-char SHA-256 digest of `(kind, qualified_name, is_public, params, return_type)`
- Extract symbol and file graph edges (`AstEdge`):
  - `calls` (`source_symbol` -> `target_symbol`)
  - `imports` (`source_path` -> `target_path` / `target_symbol`)
  - `uses_type` (`source_symbol` -> `target_symbol` from parameter and return type annotations)
  - `extends` / `implements` (`source_symbol` -> `target_symbol` from class/struct/trait inheritance or implementation clauses)
- Implement the 3-tier incremental workspace indexer (`caipira-ast index --workspace <root> --db <db_path>` and `caipira-ast update-file --workspace <root> --db <db_path> --file <rel_path>`):
  - **Tier 1 (Stat Gate)**: Compare `(size, mtime_ms)` from `ignore::WalkBuilder` against `ast_files`. Unchanged files require zero file reads, zero SHA-256 hashing, and zero AST parsing.
  - **Tier 2 (Hash Gate)**: If `mtime_ms` changed but `size` is identical, compute `sha256`. If `content_sha256` matches `ast_files.content_sha256`, update only `mtime_ms` in SQLite.
  - **Tier 3 (Parse & Diff)**: Parse changed/new files in parallel with `rayon` + `tree-sitter`, persist updated rows in `ast_files`, `ast_symbols`, `ast_edges`, and `ast_symbols_fts` inside a single SQLite transaction, and prune deleted files.
- Add schema v3 tables (`ast_files`, `ast_symbols`, `ast_edges`, `ast_symbols_fts` in `<workspace>.db`; `fact_symbol_evidence` in `master.db`) in `workspace.js` and `migrate.js`.
- Build `ast.js` in Node.js to invoke `caipira-ast` and query symbols, callers, callees, and file edges from `<workspace>.db`.
- Update `install.js` to build `caipira-ast --release` and copy the binary to `~/.caipira/bin/caipira-ast`.

Outside scope: MCP tool definitions (`mcp.js`), hook event handlers (`hooks/universal-hook.js`), and the React web UI (`explore-ui/`), which belong to Blocks 2 and 3.

## Acceptance criteria

1. **All 8 language families parse accurately**: Given fixture files in JavaScript (`.js`), TypeScript (`.ts`), React (`.jsx`, `.tsx`), Vue (`.vue` with `<script setup lang="ts">`), Python (`.py`), Rust (`.rs`), Go (`.go`), and C++ (`.cpp`, `.hpp`), `caipira-ast` extracts top-level and member symbols with accurate `name`, `qualified_name`, `kind`, `is_public`, `start_line`, `end_line`, `params` (`name`, `type_annotation`, `default_value`), `return_type`, `doc_summary`, `signature_text`, and `signature_hash`.
2. **Vue `.vue` line offset preservation**: Symbols extracted inside `<script>` and `<script setup>` blocks of `.vue` files report `start_line` and `end_line` matching the actual 1-based line numbers in the `.vue` file, not 1-based relative to the inner script block.
3. **Graph edges (`calls`, `imports`, `uses_type`, `extends`/`implements`)**: Parsing a multi-file fixture populates `ast_edges` linking caller symbols to callee symbols, source files to imported module specifiers/resolved workspace paths, and functions to their parameter/return type symbols.
4. **3-tier incremental indexing**:
   - First `syncWorkspaceAst(root, dbFile)` parses all supported source files and records `parsed > 0, skipped === 0`.
   - Immediate second `syncWorkspaceAst(root, dbFile)` with no file modifications records `parsed === 0, skipped === <total>` without re-parsing any file.
   - Touching a file's mtime without changing its contents triggers Tier 2 (`hash_matched === 1, parsed === 0`).
   - Editing one file and deleting another updates only the edited file (`parsed === 1`) and removes the deleted file's rows from `ast_files`, `ast_symbols`, `ast_edges`, and `ast_symbols_fts` (`removed === 1`).
5. **Single-file delta & diff report**: `updateFileSymbols(root, dbFile, filePath)` updates a single file in `<workspace>.db` and returns a structured diff `{ added, removed, modified }` comparing before/after `SymbolSignature`s (matching and extending Sota's `compare_snapshots`).
6. **Schema migration idempotency**: Running `migrate({ caipiraDir })` upgrades existing `<workspace>.db` and `master.db` files to `schema_version = 3` idempotently without losing existing observations, sessions, or facts.

## Implementation plan

1. **Create Rust crate `rust/caipira-ast`**:
   - Define `rust/caipira-ast/Cargo.toml` with `edition = "2024"`, dependencies: `clap`, `ignore`, `rayon`, `rusqlite` (`features = ["bundled"]`), `serde`, `serde_json`, `sha2`, `hex`, `thiserror`, `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-rust`, `tree-sitter-go`, `tree-sitter-cpp`.
   - Implement `rust/caipira-ast/src/walker.rs` adapted from `/home/htxzz77/Projects/sota/crates/sota_walker/src/walker.rs`: parallel `ignore::WalkBuilder` respecting `.gitignore`, `.ignore`, skipping `.git` and symlinks, filtering to supported source extensions, and capturing `(rel_path, size, mtime_ms)` in a single stat pass.
   - Implement `rust/caipira-ast/src/vue.rs`: scan `.vue` files for `<script ...>` and `<script setup ...>` blocks, detect `lang="ts" | "tsx" | "jsx" | "js"`, and preserve byte/line offsets by either replacing non-script regions with whitespace/newlines of identical line structure or adjusting node line offsets.
   - Implement `rust/caipira-ast/src/parser.rs` upgrading `/home/htxzz77/Projects/sota/crates/sota_domain/src/ast.rs`:
     - Extract `SymbolSignature` with `params: Vec<ParamSignature>`, `return_type: Option<String>`, `doc_summary: Option<String>`, `signature_text: String`, and `signature_hash: String`.
     - Add Go (`function_declaration`, `method_declaration`, `type_declaration` -> `struct_type` / `interface_type`) and C++ (`function_definition`, `declaration`, `class_specifier`, `struct_specifier`, `enum_specifier`, `namespace_definition`) extractors alongside Rust, Python, TypeScript/TSX, JavaScript/JSX, and Vue.
     - Extract `AstEdge` entries for `calls`, `imports`, `uses_type`, and `extends`/`implements`, resolving relative import paths (e.g., `./store.js`, `../workspace`) to workspace-relative paths when the target file exists.
   - Implement `rust/caipira-ast/src/store.rs`: SQLite persistence and 3-tier incremental sync (`index_workspace` and `update_single_file` with before/after `AstDiffReport`).
   - Implement CLI subcommands in `rust/caipira-ast/src/main.rs`:
     - `caipira-ast index --workspace <path> --db <db_path>` -> outputs JSON `{ parsed, skipped, hash_matched, removed, symbols_total, edges_total, duration_ms }`
     - `caipira-ast update-file --workspace <path> --db <db_path> --file <path>` -> outputs JSON `{ status, path, diff: { added, removed, modified }, duration_ms }`
     - `caipira-ast parse-file --workspace <path> --file <path>` -> stateless JSON snapshot output for unit testing.
2. **Extend SQLite schema to v3 in [`workspace.js`](file:///home/htxzz77/Projects/caipira/workspace.js) and [`migrate.js`](file:///home/htxzz77/Projects/caipira/migrate.js)**:
   - Bump `SCHEMA_VERSION` from `2` to `3`.
   - In `WorkspaceStore.initSchema()` (`<workspace>.db`), create:
     - `ast_files (path TEXT PRIMARY KEY, language TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, content_sha256 TEXT NOT NULL, indexed_at INTEGER NOT NULL)`
     - `ast_symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, kind TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, params_json TEXT NOT NULL DEFAULT '[]', return_type TEXT, doc_summary TEXT, signature_text TEXT NOT NULL, signature_hash TEXT NOT NULL)` with indexes on `(path)`, `(name)`, `(qualified_name)`, `(kind)`
     - `ast_symbols_fts` FTS5 virtual table indexing `name, qualified_name, signature_text, doc_summary, path` with `AFTER INSERT`, `AFTER DELETE`, and `AFTER UPDATE` triggers
     - `ast_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL, source_symbol TEXT, target_path TEXT, target_symbol TEXT NOT NULL, edge_kind TEXT NOT NULL, line INTEGER NOT NULL)` with indexes on `(source_path, source_symbol)`, `(target_symbol)`, and `(edge_kind)`
   - In `WorkspaceRegistry.initSchema()` (`master.db`), create:
     - `fact_symbol_evidence (fact_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE, path TEXT NOT NULL, qualified_name TEXT NOT NULL, signature_hash TEXT NOT NULL, PRIMARY KEY (fact_id, path, qualified_name))`
   - Update `migrate.js` so existing `v2` databases automatically receive the `v3` tables and bump `schema_version` to `'3'`.
3. **Create [`ast.js`](file:///home/htxzz77/Projects/caipira/ast.js) and update [`install.js`](file:///home/htxzz77/Projects/caipira/install.js)**:
   - Implement `syncWorkspaceAst(workspaceRoot, dbFile, opts)`, `updateFileAst(workspaceRoot, dbFile, filePath, opts)`, `queryWorkspaceSymbols(dbFile, filters)`, and `inspectSymbol(dbFile, selector, registry, workspaceId)` in `ast.js`.
   - Update `install.js` to compile `rust/caipira-ast` via `cargo build --release --manifest-path rust/caipira-ast/Cargo.toml` and install the binary into `~/.caipira/bin/caipira-ast`.
4. **Write tests in `test/test-ast.js` and Rust unit tests in `rust/caipira-ast`**:
   - Test all 8 languages, `.vue` line numbers, `params` and `return_type` extraction, `calls`/`imports`/`uses_type` edges, 3-tier incremental skipping, file deletion cleanup, and single-file diff reports.

## Verification

- `cargo test --manifest-path rust/caipira-ast/Cargo.toml` — all Rust unit and integration tests pass.
- `cargo clippy --manifest-path rust/caipira-ast/Cargo.toml -- -D warnings` — zero warnings.
- `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-ast.js` — all Node <-> Rust bridge and SQLite schema v3 tests pass.
- `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-migrate.js` & `test/test-workspace.js` — all existing and v3 migration assertions pass.

## Open decisions and sources

- None. Reference implementation inspected at `/home/htxzz77/Projects/sota/crates/sota_domain/src/ast.rs` and `/home/htxzz77/Projects/sota/crates/sota_walker/src/walker.rs`.
