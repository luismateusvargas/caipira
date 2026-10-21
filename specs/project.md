# Caipira — simple project spec

## Purpose

Caipira is a local-first, zero-API-cost persistent Second Brain and incremental AST code intelligence engine for AI coding agents (Claude Code, Gemini CLI, OpenAI Codex) and developers. It combines:
1. **Standing Semantic Memory (`master.db`)** — curated workspace facts (`decision`, `constraint`, `gotcha`, `preference`, `status`) with trust decay and symbol/file drift detection.
2. **Episodic Memory (`<workspace>.db`)** — hook-captured tool observations, FTS5 + 384-dim MiniLM-L6-v2 hybrid search, and synthesized session digests.
3. **Incremental Polyglot AST Symbol Engine (`rust/caipira-ast` + `<workspace>.db`)** — an upgraded port of Sota's Rust `tree-sitter` parser (`~/Projects/sota`) that indexes symbols, function inputs (`params`), outputs (`return_type`), docstrings, and call/import/type edges across **JavaScript, TypeScript, React (JSX/TSX), Vue (`.vue` SFC), Python, Rust, Go, and C++** using a 3-tier incremental pipeline (`stat(size, mtime)` → `sha256` → `tree-sitter`).
4. **Interactive Visual Explorer (`caipira explore`)** — a local React + TypeScript web application (dark gray & dark red visual theme) uniting Madar-style function input/output/call-graph inspection with Obsidian-style knowledge graph exploration and fact curation.

Outside scope: cloud sync, remote paid LLM calls, multi-user authentication, and automatic destructive rewriting of source code.

## Runtime and files

- Runtime / target sites:
  - Bundled Node.js `v22.20.0` (`~/.caipira/node22/node-v22.20.0-linux-x64/bin/node`) using built-in `node:sqlite` (`DatabaseSync`), `node:http`, and ES modules (`"type": "module"`).
  - Rust `1.99.0` (`cargo 1.99.0`, edition `2024`) for the native incremental AST binary crate `rust/caipira-ast` (`~/.caipira/bin/caipira-ast`).
  - React `19.x` + TypeScript `5.x` + Vite `6.x` in `explore-ui/` compiled to static assets in `explore-ui/dist/` and served locally by `explore-server.js` on `http://127.0.0.1:4777`.
- Entry points:
  - [`mcp.js`](file:///home/htxzz77/Projects/caipira/mcp.js) — MCP stdio server exposing observation, fact, and AST symbol tools (`search`, `get_observations`, `list_sessions`, `timeline`, `record_fact`, `search_facts`, `update_fact`, `check_drift`, `list_workspaces`, `workspace_symbols`, `inspect_symbol`).
  - [`hooks/universal-hook.js`](file:///home/htxzz77/Projects/caipira/hooks/universal-hook.js) — unified hook handler for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd`.
  - [`workspace.js`](file:///home/htxzz77/Projects/caipira/workspace.js) — `WorkspaceRegistry` (`master.db`) and `WorkspaceStore` (`<workspace>.db`).
  - [`store.js`](file:///home/htxzz77/Projects/caipira/store.js) — `MemoryStore` for observations, sessions, FTS5, and vector embeddings.
  - [`ast.js`](file:///home/htxzz77/Projects/caipira/ast.js) — Node bridge to `caipira-ast` binary and SQLite query layer over `ast_files`, `ast_symbols`, `ast_edges`, and `ast_symbols_fts`.
  - [`inject.js`](file:///home/htxzz77/Projects/caipira/inject.js) — deterministic prompt injection builder (facts + episodic digests + AST symbol summary) and trust/drift scoring.
  - [`explore-server.js`](file:///home/htxzz77/Projects/caipira/explore-server.js) & `explore-ui/` — `caipira explore` local HTTP JSON API server and React + TypeScript graph explorer UI.
  - [`install.js`](file:///home/htxzz77/Projects/caipira/install.js) & [`caipira.sh`](file:///home/htxzz77/Projects/caipira/caipira.sh) — installer and CLI entrypoint.
- Dependencies:
  - Node runtime: `@modelcontextprotocol/sdk` (`^1.0.0`), `@huggingface/transformers` (`^3.0.0`), `zod` (`^3.23.0`).
  - Rust (`rust/caipira-ast/Cargo.toml`): `ignore`, `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-rust`, `tree-sitter-go`, `tree-sitter-cpp`, `rusqlite` (bundled), `serde`, `serde_json`, `sha2`, `hex`, `rayon`, `clap`, `thiserror`.
  - Frontend (`explore-ui/package.json`): `react`, `react-dom`, `lucide-react`, `typescript`, `vite`, `@vitejs/plugin-react`, `vitest`, `@testing-library/react`.

## Behavior and boundaries

- **Inputs**:
  - Hook JSON payloads via `stdin` (`hook_event_name`, `cwd`, `session_id`, `tool_name`, `tool_input`, `tool_response`).
  - MCP tool requests via JSON-RPC over `stdio`.
  - Source files in registered workspaces (`.js`, `.mjs`, `.cjs`, `.ts`, `.jsx`, `.tsx`, `.vue`, `.py`, `.pyi`, `.rs`, `.go`, `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.hxx`).
  - HTTP requests to `http://127.0.0.1:4777/api/*` from the local `caipira explore` React web client.
- **Outputs**:
  - Hook JSON (`hookSpecificOutput.additionalContext` or `systemMessage`) on `stdout`.
  - MCP tool responses on `stdout`.
  - SQLite persistence under `~/.caipira/master.db` and `~/.caipira/workspaces/<slug>-<hash>.db`.
  - Interactive React graph explorer UI served at `http://127.0.0.1:4777`.
- **Permissions and network**:
  - Reads workspace source files respecting `.gitignore` and `.ignore` rules; never modifies user repository files.
  - Writes only inside `~/.caipira/` (or `CAIPIRA_DIR` override).
  - `caipira explore` binds to `127.0.0.1` by default (`--host` configurable for explicit remote bind).

## Constitution

1. **Hook resilience and speed**: `hooks/universal-hook.js` must never crash or exit non-zero on malformed input, missing binaries, or SQLite lock contention, and must complete within Codex's 3s `SessionEnd` budget and <50ms on `PostToolUse` single-file AST delta updates.
2. **Incremental by default**: Never re-parse unchanged workspace files. Every workspace AST sync must gate on `(size, mtime_ms)` in SQLite first, `sha256` second, and `tree-sitter` third.
3. **Zero `stdio` pollution**: MCP servers and hooks communicate over `stdout`; all diagnostics must go to `stderr` or `~/.caipira/hooks.log`.
4. **Strict boundary validation & parameterized SQL**: Validate all external JSON/query inputs at runtime (`zod` in Node/TS, `serde` in Rust) and use parameterized SQLite statements with explicit transactions.
5. **Visual identity for `caipira explore`**: Maintain a cohesive, high-contrast **dark gray** (`#0d0e11` / `#14161b` / `#1c1f26`) and **dark red** (`#8b1e24` / `#b91c1c` / `#dc2626`) aesthetic with keyboard-first accessibility (`Ctrl+K` omni-search, ARIA labels, semantic controls).

## Logging policy

- Hook errors are appended to `~/.caipira/hooks.log` via `logError(context, err)` in [`hooks/universal-hook.js`](file:///home/htxzz77/Projects/caipira/hooks/universal-hook.js).
- MCP and `explore-server.js` log operational warnings/errors to `process.stderr` without leaking file contents, secrets, or environment variables.
- `caipira-ast` writes structured JSON results to `stdout` and human/diagnostic errors to `stderr` with non-zero exit codes mapped into typed domain errors by [`ast.js`](file:///home/htxzz77/Projects/caipira/ast.js).

## Checks

- Node test suites:
  - `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-workspace.js`
  - `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-migrate.js`
  - `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-hooks.js`
  - `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-mcp.js`
  - `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-install.js`
  - `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-e2e.js`
  - `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-ast.js` (Task 01)
  - `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-explore.js` (Task 03)
- Rust checks (`rust/caipira-ast`):
  - `cargo test --manifest-path rust/caipira-ast/Cargo.toml`
  - `cargo clippy --manifest-path rust/caipira-ast/Cargo.toml -- -D warnings`
- Frontend checks (`explore-ui`):
  - `npm --prefix explore-ui run typecheck`
  - `npm --prefix explore-ui test`
  - `npm --prefix explore-ui run build`

## Evidence and unknowns

- Repository paths:
  - Caipira: `/home/htxzz77/Projects/caipira`
  - Sota reference AST & walker crates: `/home/htxzz77/Projects/sota/crates/sota_domain/src/ast.rs`, `/home/htxzz77/Projects/sota/crates/sota_domain/src/workspace_symbols.rs`, `/home/htxzz77/Projects/sota/crates/sota_walker/src/walker.rs`
  - Language skills reference: `/home/htxzz77/Projects/spec-tech/skills` (`javascript-dev`, `typescript-dev`, `react-dev`, `vue-dev`, `python-dev`, `rust-dev`, `go-dev`, `cpp-dev`, `database-dev`)
- Open questions: None. Architecture and 3-block plan agreed with user.
