# Caipira

**Local-first, zero-daemon, cross-client memory, polyglot Rust AST symbol engine, boundary-protected prose compression, and interactive graph inspector for coding agents.**

Caipira gives **Claude Code**, **Codex**, and **Antigravity** a shared, persistent, per-workspace SQLite second brain and structural code intelligence layer. During agent sessions, there is no background daemon, no cloud dependency, and no external vector database—everything runs locally over `stdio`, direct SQLite (`better-sqlite3` with WAL + FTS5), a compiled Rust `tree-sitter` AST engine (`caipira-ast`), and a local quantized ONNX embedding model (`Xenova/all-MiniLM-L6-v2`). When you want to inspect or curate a workspace visually, `caipira explore` launches an on-demand local graph and symbol workbench on `127.0.0.1:4777`.

---

## What It Is & How It Helps

Coding sessions across different AI clients normally lose context as soon as a transcript ends—forcing every new session to re-read files, re-trace call graphs, and re-derive architecture decisions from scratch. Caipira solves this through five core mechanisms:

### 1. Two-Tier Memory Architecture (`facts.js` + `store.js`)
Caipira separates **what happened** from **what is currently true**:

- **Facts (`facts.js` — Standing Knowledge Layer)**:
  - Durable statements of current truth (`decision`, `constraint`, `preference`, `status`, `gotcha`) stored **verbatim** so exact technical terms, paths, and identifiers are never altered.
  - **Two-tier file evidence (`fact_evidence`)**: When a fact is recorded with `evidence: ["/abs/path/to/file.js"]`, Caipira stores the file's `size`, `mtime`, and `sha256`. On subsequent checks, `fs.statSync` acts as a microsecond fast gate; only if `size` or `mtime` moved does Caipira compute `sha256` to verify whether content changed.
  - **Symbol-level AST signature anchors (`fact_symbol_evidence`)**: Facts can be anchored to specific symbols (`evidence_symbols: ["src/store.ts::UserStore.addUser"]`) or line ranges (`evidence_ranges: [{ path, start_line, end_line }]`). Writes (`record_fact`, `update_fact`, and Explore mutations) fail closed if an anchored file cannot be re-parsed. On subsequent checks, internal edits to a function body that leave its normalized `signature_hash` intact **do not** trigger false drift—the file hash is automatically re-baselined while keeping the fact `active`. Only when the anchored symbol's signature changes or the symbol is removed does Caipira flip the fact to `needs_review`; if the parser is unavailable or hits its deadline (`AstRefreshScope`), unchecked symbol anchors are reported via `unchecked` rather than silently trusted or falsely marked drifted.
- **Observations & Session Digests (`store.js` — Episodic Layer)**:
  - Append-only log of session prompts, tool calls, model invocations, and session summaries captured automatically by lifecycle hooks.
  - Automatically strips `<private>...</private>` blocks and compresses prose (`compress.js`) while strictly preserving code fences, inline code, URLs, file paths, dates, versions, numbers, and identifiers.
  - At `Stop` / `SessionEnd`, Caipira deterministically synthesizes a multi-turn **`session_digest`** observation (intent, key decisions, modified files/symbols, and verification commands) and records touched files/symbols in `session_touches`.
  - Indexed with dual-form FTS5 (`porter unicode61`, matching both abbreviated and expanded lexicon forms) and backfilled on idle with 384-dimensional local embeddings for hybrid BM25 + cosine similarity search.

### 2. Polyglot Incremental Rust AST Engine (`rust/caipira-ast` + `ast.js`)
- A standalone Rust binary (`caipira-ast`) powered by `tree-sitter`, `ignore`, and `rayon` indexes **8 language families**:
  - **JavaScript** (`.js`, `.mjs`, `.cjs`)
  - **TypeScript** (`.ts`, `.mts`, `.cts`)
  - **React JSX / TSX** (`.jsx`, `.tsx`)
  - **Vue 3 SFCs** (`.vue`, with line-preserving masking of non-`<script>` / `<script setup>` blocks so line numbers match the original file)
  - **Python** (`.py`)
  - **Rust** (`.rs`)
  - **Go** (`.go`)
  - **C / C++** (`.c`, `.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`)
- Extracts structured symbols (`function`, `method`, `class`, `struct`, `interface`, `trait`, `enum`, `type`, `union`, `const`), structured parameters (`name`, `type_annotation`, `default_value`), `return_type`, `doc_summary`, normalized `signature_text`, 64-bit truncated SHA-256 `signature_hash` (`hex::encode(&Sha256::digest(&payload)[..8])`), and dependency edges (`calls`, `imports`, `uses_type`, `extends`, `implements`).
- **Three-tier incremental sync**: `(size, mtime_ms)` fast gate → `sha256` content gate → `tree-sitter` parse only on modified files, plus probe-based cross-file relinking (`ast_links` / `ast_link_probes`) so newly added or edited exports automatically resolve callers and importers across the workspace. Stored symbol rows (`1`-based line spans and `params_json`) are validated on read so corrupt rows fail transactionally without partial writes.
- **Zero-spawn read path**: Symbol searches (`workspace_symbols`) and deep symbol inspections (`inspect_symbol`) run as pure in-process SQLite queries (`ast_files`, `ast_symbols`, `ast_edges`, `ast_symbols_fts`) in `ast.js`.

### 3. High-Precision Prompt Injection & Subpath Recall (`inject.js`)
- **Silence by default on prompts**: Prompt-driven injection (`buildPromptInjection`) gates independently on **term coverage** (`MIN_COVERAGE = 0.4` over meaningful domain terms) and **evidence trust** (`MIN_TRUST = 0.25`, combining state weight, confidence, evidence freshness, and TTL). Unrelated prompts inject `null`.
- **Subpath-aware session start (`buildInjection`)**: Boosts facts whose evidence files or symbol anchors lie under the session's active subdirectory (`+0.25`; the workspace root, cwd, and existing evidence files are compared by their real paths, so a workspace registered or recorded through any symlink keeps its locality, while deleted evidence is compared as recorded), flags every fact in `needs_review` state or with changed evidence as `(NEEDS REVIEW)`, includes recent episodic session digests (`Recent sessions:`), and injects the workspace's global public symbol map (`Workspace symbols:`) as `- path::qualified_name (kind Lstart-end)` lines within a 24,000-character startup budget (at most 64,000 via `opts.budget`). When the map does not fit, symbols are kept by priority — active subpath, then incoming call/type/import fan-in, then shallower paths — printed in deterministic `(subpath, path, line)` order, and closed with a `(... N more public symbols omitted to fit budget; use workspace_symbols or inspect_symbol)` notice, which still appears under the header when not even one symbol fits. A block that cannot be read is left out and reported on stderr while the others are kept.
- **Cache-safe prompt turns**: `UserPromptSubmit` and later Antigravity `PreInvocation` steps inject only prompt-matched facts (`Caipira recalled facts:`) and drift notices. They never repeat `Workspace symbols:` or `Recent sessions:`, so the conversation prefix stays cacheable and an unrelated prompt injects nothing.

### 4. Fail-Open Cross-Client Lifecycle Adapter (`hooks/universal-hook.js`)
- A single hook adapter handles lifecycle payloads for Claude Code, Codex, and Antigravity (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`, `SessionEnd`).
- **Once-per-session context**: `SessionStart` (Claude Code, Codex) and the first `PreInvocation` (Antigravity) incrementally sync the workspace AST index (`caipira-ast index`, 5 s timeout), re-verify every fact, and inject standing facts, recent session digests, and the global public symbol map once. If `caipira-ast` is missing, times out, or fails, the hook logs to stderr and injects from the existing index; a sync that could not read some paths keeps their previous symbols and logs a bounded warning. `UserPromptSubmit` injects only prompt-matched facts and drift notices.
- **Bounded startup**: All parser work for recall — the sync, then any per-file re-index an evidence check needs (2 s each, at most once per file per run) — ends within 9 s of the hook starting, below the 15 s hook timeout the installer registers. After a parser timeout or a missing parser nothing more is spawned, and symbol evidence that could not be re-checked keeps its fact from counting as verified: in standing, prompt, and Antigravity first-step recall it is marked `(NEEDS REVIEW — symbol evidence could not be checked)`.
- **Real-time AST delta & blast-radius reminders**: On `PostToolUse` file writes (`Edit`, `Write`, `edit_file`, `write_file`, `MultiEdit`, `apply_patch`), Caipira runs `caipira-ast update-file` (<50 ms). When a modified or removed symbol's signature changes and has callers or anchored facts, the hook emits a concise model-visible reminder (`hookSpecificOutput.additionalContext` / `injectSteps`) showing the before/after signature, affected callers, and facts moved to `needs_review`.
- Always exits `0` with valid client JSON so a memory or parser error can never block your coding client. Malformed or non-object input, wrongly typed fields, and storage failures get the client's plain acknowledgement (`{}` for Codex and Antigravity, `{"continue":true}` for Claude Code); the details go to stderr only.

### 5. Interactive Graph & Symbol Workbench (`caipira explore`)
- Launches a local HTTP server (`explore-server.js` on `127.0.0.1:4777`) serving a compiled React 19 + TypeScript + HTML5 Canvas application (`explore-ui/dist`) styled in a dark-gray (`#0d0e11` / `#14161b` / `#1c1f26`) and crimson (`#7f1d1d` / `#b91c1c` / `#dc2626`) palette:
  - **4 Graph Perspectives**: `Unified` (files, symbols, facts, and sessions), `Architecture` (code structure, call graph, imports, type dependencies, and inheritance), `Knowledge` (standing facts, sessions, and evidence targets), and `Impact` (1–3 hop blast-radius neighborhood around any focused symbol). Fact nodes carry `symbolAnchors` (counted from the stored anchors, whatever edges a view or cap keeps) and `uncheckedSymbols`; an anchored fact whose count is positive or unknown is drawn with a dashed outline and described `Evidence not checked` on hover and in its summary, while `trust` stays the stored score.
  - **Madar-Style Symbol Inspector Drawer**: Inspects any symbol's `RECEIVES (INPUTS)` (parameter names, clickable workspace type annotations, default values), `RETURNS (OUTPUT)`, docstring summary, `CALLED BY (UPSTREAM)` and `CALLS (DOWNSTREAM)` (including unique member-call resolution), `TYPE CONNECTIONS`, `LINKED FACTS` (with live drift badges, `Focus Impact`, and `+ Attach Fact`; each carries `unchecked_symbols` beside the index comparison in `evidence_status`, so a signature match whose evidence was not re-read is marked `Evidence not checked` and labelled as last indexed), and a workspace-confined source code preview.
  - **Live Knowledge Board**: Browse, search, and filter facts by category (`decision`, `constraint`, `preference`, `status`, `gotcha`) and state (`active`, `needs_review`, `superseded`). Create facts anchored to symbols or files, edit in place, supersede with a replacement fact, archive (`revoked`), reaffirm drifted facts (re-indexing evidence files via `caipira-ast` and re-baselining `signature_hash` + `sha256`), or trigger an explicit `Re-check Drift`. Each fact from `/api/facts` carries `uncheckedSymbols`: how many symbol anchors the newest check covering the fact (a re-check, a text search — including candidates it checked but did not return — or a write that re-read its anchors; kept per workspace database) could not re-read from source, or `null` when no check covered the fact. A symbol's `current` compares its anchor with the indexed signature, so the board marks an anchored fact whose count is positive or unknown `Evidence not checked` and labels its trust unverified, separately from `NEEDS REVIEW` and `changed`.
  - **Omni-Search (`Ctrl+K` / `Cmd+K`)**: Instant search across symbol names, parameter types, return types, file paths, and standing facts.
  - **Hardened Local Security**: Loopback binding by default, DNS-rebinding `Host` header check, same-origin `application/json` CSRF enforcement on writes, strict CSP headers, and symlink-aware workspace path confinement.

---

## Runtime Layout & Prerequisites

Caipira is typically installed at `~/.caipira` alongside its bundled **Node.js v22.20.0** runtime, compiled `caipira-ast` binary, built `explore-ui/dist` bundle, and local ONNX model:

```text
~/.caipira/
├── caipira.sh                  # Linux/macOS CLI launcher (uses bundled Node 22)
├── caipira.cmd                 # Windows CLI launcher (uses bundled Node 22)
├── install.js                  # Installer, uninstaller, doctor, status, logs, prune, mode, explore CLI
├── errors.js                   # Structured, redacted error journal; rotates at 2 MB with one backup
├── mcp.js                      # Stdio MCP server (11 tools)
├── ast.js                      # Bridge to caipira-ast + in-process SQLite symbol queries
├── explore-server.js           # Local HTTP API & static bundle server for `caipira explore`
├── workspace.js                # Workspace root resolution & master.db registry
├── migrate.js                  # Transactional schema migrations (master v1 + workspace v1..v6)
├── store.js                    # Observation storage, redaction, FTS5 + hybrid embedding search
├── facts.js                    # Verbatim facts, file + symbol evidence verification, RRF recall
├── inject.js                   # Coverage + trust prompt-injection gate & session-start recall
├── compress.js                 # Boundary-protected prose compressor & FTS query builders
├── hooks/
│   └── universal-hook.js       # Cross-client lifecycle hook adapter (AST deltas & session digests)
├── bin/
│   └── caipira-ast             # Compiled Rust tree-sitter AST indexer binary
├── rust/
│   └── caipira-ast/            # Rust crate source for the polyglot AST engine
├── explore-ui/
│   ├── src/                    # React 19 + TypeScript source for the graph & symbol inspector
│   └── dist/                   # Compiled production UI bundle served by explore-server.js
├── node22/                     # Bundled Node 22.20.0 runtime (ABI-matched to better-sqlite3)
└── models/
    └── Xenova/all-MiniLM-L6-v2/ # Local quantized ONNX embedding model
```

> **Important**: Always run Caipira via `caipira.sh` / `caipira.cmd` or the bundled Node 22 binary (`~/.caipira/node22/node-v22.20.0-linux-x64/bin/node` on Linux, `node22\node-v22.20.0-win-x64\node.exe` on Windows). `better-sqlite3` is compiled against Node 22's native ABI and will refuse to load under a different system Node major version (such as Node 24).

---

## Installation

1. **Place or sync the repository into `~/.caipira`** (ensuring `node22/` and `models/` are present in `~/.caipira`, and `cargo` is on `PATH` to compile the Rust AST engine).
2. **Run the installer**:

   **Linux / macOS:**
   ```sh
   ~/.caipira/caipira.sh install
   ```

   **Windows (PowerShell / CMD):**
   ```bat
   %USERPROFILE%\.caipira\caipira.cmd install
   ```

The installer detects Claude Code from `~/.claude/` or `~/.claude.json`, Codex from `~/.codex/` or `~/.codex/config.toml`, and Antigravity from `~/.gemini/` or `~/.gemini/config`. Absent clients are skipped without creating configuration directories. To select clients explicitly:

```sh
caipira install --clients claude-code,codex
caipira install --clients all --accept-risk
```

Aliases `claude` and `agy` are accepted. The list restricts registration to those clients. Configuring an undetected client requires `--accept-risk` or an interactive `[y/N]` confirmation. Without agreement, the installer exits with code 1 before deployment or client configuration changes.

On Linux and macOS, installation creates `~/.local/bin/caipira` and, when that directory is absent from PATH, adds one marked block to your shell startup file: `.bashrc` for bash, `.zshrc` for zsh, `.config/fish/conf.d/caipira.fish` for fish, or `.profile` for other shells. Bash on macOS also uses the first existing login file among `.bash_profile`, `.bash_login` and `.profile`, creating `.bash_profile` only when none exists. Existing content, permissions and symlinks are preserved; repeated installs keep a single block. Backups stay beside the startup path in your home directory. If a startup target cannot be written, installation keeps the launcher and prints a warning with the manual PATH command. On Windows, installation adds the deployment directory (normally `%USERPROFILE%\.caipira`) to the User `PATH` and broadcasts the environment change. Open a new terminal or `cmd` window to use `caipira`; no manual startup-file edit or sign-out is needed during normal installation. If the Windows notification fails, the registry update is kept and a warning explains that signing out completes the change. Then `caipira explore --no-open` works from any directory and selects that directory's workspace.

`caipira uninstall` removes Caipira's marked startup blocks, deleting regular startup files left empty and preserving other content. Symlinks and their targets are kept, including empty targets; unwritable startup files produce a warning while uninstall continues. On Windows it removes only the matching deployment entry from User PATH and broadcasts the change again. Missing entries and unmarked files are left alone.

Installing from a separate checkout synchronizes the core JavaScript runtime, hooks, installer, launchers, package metadata, built UI, and AST executable into `~/.caipira` (or `CAIPIRA_HOME`). Provision the bundled Node 22, dependencies, and model in both the build checkout and deployment first; downloading and packaging these prerequisites is separate from runtime synchronization. If the deployment interpreter or native dependency package is missing, installation exits with code 1 before deployment, launcher or client configuration writes and names the missing paths. Existing databases, logs, models, and dependencies are preserved.

### What `install` Does
- Installs root npm dependencies (`better-sqlite3`, `@xenova/transformers`) using the bundled Node 22 runtime if not already present.
- Compiles the release Rust AST binary (`cargo build --release --manifest-path rust/caipira-ast/Cargo.toml`) and installs it atomically to `bin/caipira-ast` (degrades gracefully with a warning if `cargo` is not installed).
- Installs `explore-ui` dependencies and builds the production Vite bundle at `explore-ui/dist`.
- Stages the complete checkout runtime before promoting files by rename, restores the previous runtime if promotion fails, and replaces the UI bundle without leaving obsolete assets. Optional UI/AST assets unavailable in the checkout retain their deployed copies. A failed rollback retains recovery files and reports their location.
- Creates runtime directories (`logs/`).
- Installs the user PATH launcher and atomically registers the `caipira` stdio MCP server and lifecycle hooks for detected or explicitly selected clients (saving a `.caipira-backup` copy before modifying any file):
  - **Claude Code**: `~/.claude.json` and `~/.claude/settings.json`
  - **Codex**: `~/.codex/config.toml`
  - **Antigravity**: `~/.gemini/config/mcp_config.json` and `~/.gemini/config/hooks.json`
- Verify the installation at any time with:
  ```sh
  ~/.caipira/caipira.sh doctor
  ```

---

## Usage

### CLI Commands

Run via `~/.caipira/caipira.sh <command>` on Linux/macOS or `caipira.cmd <command>` on Windows:

| Command | Description |
| :--- | :--- |
| `install [--clients <list>] [--accept-risk]` | Install dependencies, build `caipira-ast` and `explore-ui`, synchronize the runtime, install the PATH launcher, and register detected or selected clients. |
| `explore [flags]` | Incrementally index the target workspace and launch the local graph & symbol inspector UI (`--port 4777`, `--host 127.0.0.1`, `--workspace <path>`, `--no-open`). |
| `doctor` | Check bundled Node 22, native dependencies, ONNX model, `caipira-ast` binary, `explore-ui/dist` bundle, `master.db`, all workspace databases, dangling registry rows, client configs, and active mode; warn when retained error logs are non-empty. |
| `status` | Display current compression mode, retained error count, and aggregated counts of workspaces, observations, embeddings, facts, and recent sessions. |
| `logs [--limit N] [--clear]` | Show the newest 20 errors (or N) with sanitized one-line reproduction commands; `--clear` removes the journal and backup. Works even when native SQLite cannot load. |
| `mode <lite\|full\|ultra>` | Set the active prose compression intensity for newly recorded observations. |
| `prune` | Dry-run report of dangling workspace registry rows (whose project root was deleted) and unclaimed `.db` files. |
| `prune --apply` | Delete dangling workspace rows and their associated `.db` / `-wal` / `-shm` files. |
| `uninstall` | Remove Caipira MCP and hook registrations from Claude Code, Codex, and Antigravity (leaves `~/.caipira/database/` untouched). |

### Launching the Visual Explorer (`caipira explore`)

```sh
# Index the current working directory's workspace and open http://127.0.0.1:4777/
~/.caipira/caipira.sh explore

# Inspect a specific workspace on a custom port without opening a browser tab
~/.caipira/caipira.sh explore --workspace /path/to/repo --port 4888 --no-open
```

### MCP Tools

Once registered, Caipira exposes **11 tools** to your coding agent over MCP:

#### Knowledge Layer (Facts)
- **`record_fact`**: Record a durable workspace fact (`kind`: `'decision' | 'constraint' | 'preference' | 'status' | 'gotcha'`, `title`, `body`, optional `summary`, `evidence` array of file paths, `evidence_symbols` array of symbol selectors like `"src/store.ts::UserStore.addUser"`, `evidence_ranges` array of `{ path, start_line, end_line }`, `scope`, `confidence` `0..1`, `ttl_days`, `supersedes`).
- **`search_facts`**: Search durable facts ranked by trust (`relevance × freshness`). Supports `include_stale` (default `true`) and `scope` (`'workspace'` default, or `'all'` to fuse results across every registered workspace via Reciprocal Rank Fusion). Each result keeps `state`, `trust`, and `stale_files` and adds the evidence check's `evidence_status`, whose `unchecked` count is symbol evidence the parser could not re-read just now: such a fact is unverified, not current, and no drift is assumed for it.
- **`update_fact`**: Revise a fact in place (`kind`, `title`, `body`, `summary`, `scope`, `evidence`, `evidence_symbols`, `evidence_ranges`, `confidence`, `ttl_days`) or transition its `state` (`'active' | 'needs_review' | 'superseded' | 'revoked' | 'proposed'`). Setting `state: 'active'` re-baselines local file and symbol evidence fingerprints and renews TTL verification.
- **`check_drift`**: Re-verify active facts against their on-disk evidence files and AST symbol signatures (`stat` + `sha256` + `signature_hash` + `ttl_days`) and return only the drifted facts alongside `files_to_reread`.
- **`list_workspaces`**: List all registered workspaces in `master.db` with their root paths, database files, and last-seen timestamps.

#### Structural Code Intelligence Layer (AST Symbols)
- **`workspace_symbols`**: Search or list indexed AST symbols in the current workspace by `query` (FTS5 over name, qualified name, signature, and docstring), `path` prefix, `kind` (`function`, `method`, `class`, `struct`, `interface`, `trait`, `enum`, `type`, `union`, `const`), `exported_only`, and `limit`. Incrementally refreshes the workspace index when `refresh: true` or on first query.
- **`inspect_symbol`**: Inspect a symbol's full contract and relationships without reading the entire file. Accepts `selector` (`"path/to/file.ts::Qualified.name"`, `"path/to/file.ts:line"`, or `"Qualified.name"`) or explicit `path` + `qualified_name` / `line`. Returns signature, structured `params`, `return_type`, `doc_summary`, `callers`, `callees`, `uses_types`, `used_by`, `extends`, `implements`, `inherited_by`, file `imports` / `imported_by`, and anchored `facts` with live `evidence_status`.

#### Episodic Layer (Observations & Sessions)
- **`search`**: Hybrid FTS5 BM25 + 384-dim cosine similarity search over session observations and session digests (with automatic substring `LIKE` fallback).
- **`get_observations`**: Fetch specific observation rows by ID (`ids` array, up to 500), with optional `expand: true` to expand lexicon abbreviations back to full prose.
- **`list_sessions`**: List recent coding sessions with client (`ide`), `cwd`, start/end timestamps, and session IDs.
- **`timeline`**: Retrieve chronological observations for a given `session_id`.

### Privacy Redaction (`<private>`)

Any text wrapped in `<private>...</private>` inside prompts, tool outputs, or summaries is stripped before observation storage, session digest synthesis, or debug traffic logging:

```text
Connected to staging DB with token <private>sk-live-secret</private>.
```

---

## Configuration

### 1. Prose Compression Mode (`lite` | `full` | `ultra`)
Set via `caipira.sh mode <lite|full|ultra>` (stored in the `active` file next to `store.js`; defaults to `full`):
- **`lite`**: Strips conversational fillers and pleasantries; abbreviates core long words (`configuration` → `config`, `implementation` → `impl`, `documentation` → `docs`, `repository` → `repo`).
- **`full`**: Also strips articles (`the`, `a`, `an`) and hedges, and applies the full technical lexicon (`database` → `db`, `authentication` → `auth`, `transaction` → `tx`, `middleware` → `mw`, `because` → `b/c`, `with` → `w/`, `without` → `w/o`, etc.).
- **`ultra`**: Maximum prose reduction for high-volume observation logs (`configuration` → `cfg`, broader hedge/filler removal).

*(Note: Code blocks, inline code, URLs, file paths, versions, dates, numbers, and camelCase/snake_case/kebab-case identifiers are always preserved untouched, and Facts in `facts.js` are always stored verbatim regardless of mode.)*

### 2. Custom Workspace Grouping (`.caipira-workspace`)
By default, `workspace.js` resolves any directory to its nearest enclosing `.git` or `.hg` root (or package manifest if not in VCS). To group multiple repositories into a single shared workspace database—or override a nested `.git` boundary—create an empty `.caipira-workspace` file in the desired root directory:

```sh
touch /path/to/workspace-root/.caipira-workspace
```

### 3. Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `CAIPIRA_HOME` | `~/.caipira` | Redirects databases and logs to a custom directory. During install, it also selects the runtime deployment and launcher target. Hooks, MCP and the launcher read this variable from their own environment (default `~/.caipira`); install does not register it in client configurations. |
| `CAIPIRA_AST_BIN` | `<root>/bin/caipira-ast` | Overrides the path to the `caipira-ast` executable. |
| `CAIPIRA_MODEL_PATH` | `<root>/models` or `~/.caipira/models` | Overrides the directory containing `Xenova/all-MiniLM-L6-v2`. |
| `CAIPIRA_DEBUG` | unset (`0`) | Set `CAIPIRA_DEBUG=1` to enable `<private>`-redacted MCP JSON-RPC traffic logging to `logs/mcp_traffic.log` (rotates to `.1` at 5 MB). |

Runtime failures and degraded fallbacks are recorded synchronously in `logs/errors.jsonl`, including Node version, native ABI, Caipira version, platform, and a shell reproduction hint with a synthetic payload. Private blocks and common credential formats are redacted. The journal rotates at 2 MB and keeps one backup; doctor/status count retained entries across both files. If the log directory is unavailable, hooks still return their client acknowledgement and exit successfully.

---

## Running the Test Suite

Every test suite runs against an isolated temporary `CAIPIRA_HOME` (`test/fixtures.js`) so tests never read or mutate your live `~/.caipira/database/` files:

```sh
# 1. Run all Node integration & unit suites (store, workspace, facts, inject, hooks, install, ast, symbol-recall, explore):
# From ~/.caipira (where node22/ and node_modules/ live locally):
~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js

# From a repository checkout using ~/.caipira's runtime and dependencies:
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js

# 2. Run the Rust AST engine unit tests & Clippy lints:
cargo test --manifest-path rust/caipira-ast/Cargo.toml
cargo clippy --manifest-path rust/caipira-ast/Cargo.toml -- -D warnings

# 3. Run the explore-ui TypeScript typecheck, Vitest suite, and production build:
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui run typecheck
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui test
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui run build
```

---

## License

Released under the [GNU General Public License v3.0](LICENSE) (`GPL-3.0-only`).
