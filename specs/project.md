# Caipira — simple project spec

## Purpose

Caipira is a local-first, zero-daemon, persistent Second Brain and incremental AST code intelligence engine for AI coding agents (**Claude Code**, **Codex**, **Antigravity**) and developers. It provides:
1. **Standing Semantic Memory (`facts.js`)** — durable, verbatim workspace facts (`decision`, `constraint`, `gotcha`, `preference`, `status`) anchored to AST symbol signatures and source line ranges with two-tier staleness verification (`stat` → `sha256` → AST `signature_hash`) and automatic self-healing on non-breaking edits or reverts.
2. **Episodic Observation Memory (`store.js`)** — append-only lifecycle hook captures, dual-form FTS5 BM25 search, 384-dimensional local MiniLM-L6-v2 vector embeddings, and deterministic session summaries.
3. **Polyglot Incremental AST Symbol Engine (`caipira-ast` + `ast.js`)** — standalone Rust binary indexing 8 language families (JavaScript, TypeScript, JSX/TSX, Vue SFC, Python, Rust, Go, C/C++) with structured parameters, return types, docstrings, and call/import/type edges over in-process SQLite queries.
4. **Interactive Visual Explorer (`caipira explore`)** — local web application (dark gray `#0d0e11` and crimson `#b91c1c` theme) uniting Madar-style symbol contracts with Canvas graph visualization and a live Knowledge Board.

Outside scope: cloud sync, remote paid LLM API calls, multi-tenant databases, external vector databases, background daemons, or destructive automatic code modifications.

## Runtime and files

- Runtime / target sites:
  - Node.js LTS (v20, v22, v24) CommonJS, with bundled or prebuilt native SQLite (`better-sqlite3` with WAL + FTS5).
  - Standalone compiled Rust executable `caipira-ast` (Rust edition 2024, `rusqlite` bundled, LTO enabled) for multi-platform binary execution.
  - Pre-built React 19 + TypeScript + Vite web application in `explore-ui/dist/` served locally via `explore-server.js` on `http://127.0.0.1:4777`.
- Entry points:
  - `bin/caipira-cli.js` — cross-platform global CLI entrypoint for `npm i -g @luismateusvargas/caipira`.
  - `install.js`, `caipira.sh`, `caipira.cmd` — installer, uninstaller, doctor, status, prune, logs, and explore CLI launchers.
  - `mcp.js` — stdio Model Context Protocol server exposing 11 observation, fact, and AST symbol tools.
  - `hooks/universal-hook.js` — fail-open cross-client lifecycle hook adapter for Claude Code, Codex, and Antigravity.
  - `workspace.js` — master workspace registry (`master.db`) and workspace database routing (`<workspace>.db`).
  - `store.js` — episodic observations, redaction, compression, FTS5, and vector embeddings.
  - `facts.js` — verbatim facts, symbol-evidence verification, trust scoring, and RRF search.
  - `inject.js` — prompt-coverage and trust gating, once-per-session symbol map injection, and drift notices.
  - `ast.js` — bridge to `caipira-ast` binary and zero-spawn in-process SQLite symbol queries.
  - `errors.js` — centralized, structured, `<private>`-redacted error logging (`errors.jsonl`).
  - `explore-server.js` — local HTTP API and static bundle server for `caipira explore`.
- Dependencies:
  - Node: `better-sqlite3`, `@xenova/transformers`.
  - Rust (`rust/caipira-ast/Cargo.toml`): `clap`, `ignore`, `rayon`, `rusqlite` (bundled), `serde`, `serde_json`, `sha2`, `thiserror`, `tree-sitter`, language grammars (`javascript`, `typescript`, `python`, `rust`, `go`, `cpp`).
  - Frontend (`explore-ui/package.json`): `react`, `react-dom`, `lucide-react`, `typescript`, `vite`.

## Behavior and boundaries

- **Inputs**:
  - Hook JSON payloads over `stdin` (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`, `SessionEnd`).
  - MCP JSON-RPC 2.0 tool requests over `stdin`.
  - Workspace source files respecting `.gitignore` and `.ignore` boundaries.
  - HTTP requests to `http://127.0.0.1:4777/api/*` strictly from same-origin loopback.
- **Outputs**:
  - Hook JSON (`hookSpecificOutput.additionalContext` or `injectSteps`) on `stdout`.
  - MCP JSON-RPC 2.0 responses on `stdout`.
  - SQLite databases under `~/.caipira/database/` (`master.db` and per-workspace `.db` files).
  - Structured error entries in `~/.caipira/logs/errors.jsonl`.
- **Permissions & Security**:
  - Never modifies user source code files.
  - Writes only inside `~/.caipira/` (or `CAIPIRA_HOME` override).
  - DNS-rebinding protection (`Host` header check), same-origin CSRF enforcement, strict CSP, and symlink-confined path access in `explore-server.js`.
  - Strict `<private>...</private>` redaction before storing observations, summaries, or writing error logs.

## Constitution

1. **Fail-open safety across all hooks**: `hooks/universal-hook.js` must NEVER crash or block the host agent. Malformed JSON, native library failures, missing binaries, and database contention must be caught, recorded to `errors.jsonl`, and return a valid client acknowledgement (`{"continue":true}` for Claude Code, `{}` for Codex and Antigravity) with exit code 0.
2. **Zero-daemon guarantee**: Sessions run strictly over `stdio` and in-process SQLite WAL. No background daemons, no Docker requirements, and no external vector databases.
3. **Three-tier AST gating**: Every workspace AST sync must gate on `(size, mtime_ms)` first, `sha256` second, and `tree-sitter` parse third.
4. **Cache-safe prompt injection**: Global public symbol map and standing facts are injected once at session start. Subsequent prompt turns inject only prompt-matched facts or `null` to preserve LLM prompt prefix caches.
5. **No stdio protocol pollution**: `stdout` is strictly reserved for client protocol communication. All diagnostics go to `stderr` or `errors.jsonl`.
6. **Verbatim fact integrity**: Facts are canonical architectural records and are stored verbatim without lossy compression.

## Logging policy

- Structured error reports are appended to `<CAIPIRA_HOME>/logs/errors.jsonl` via `errors.js`.
- Each record contains: timestamp, component, operation, client, error details, runtime metadata (Node version, ABI, OS, arch), and a sanitized one-line reproduction command.
- Log files auto-rotate when reaching 2 MB (keeping one `.1` backup).
- Sensitive tokens and `<private>` tags are stripped before logging.
- `caipira logs` displays recent errors with reproduction commands; `caipira doctor` reports recent error totals.

## Checks

- Node unit & integration suites: `node test/run-all.js`
- Rust AST engine tests & Clippy: `cargo test --manifest-path rust/caipira-ast/Cargo.toml && cargo clippy --manifest-path rust/caipira-ast/Cargo.toml -- -D warnings`
- Explore UI typecheck & tests: `npm --prefix explore-ui run typecheck && npm --prefix explore-ui test`
- Installation & doctor check: `caipira doctor`

## Evidence and unknowns

- Verified source paths: `hooks/universal-hook.js`, `mcp.js`, `install.js`, `store.js`, `facts.js`, `ast.js`, `inject.js`, `explore-server.js`, `rust/caipira-ast/`.
- Active upgrade roadmap:
  - Task 01: Core Resilience Hardening, Reproducible Error Logging, and Hash Spec Alignment.
  - Task 02: Client Auto-Detection, Risk-Acknowledged `--clients` Override, and Global PATH Integration.
  - Task 03: Zero-Prerequisite npm Distribution (`@luismateusvargas/caipira`) and Cross-Platform Prebuilt Asset Packaging.
