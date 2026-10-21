# Caipira

**Local-first, zero-daemon, cross-client memory and boundary-protected prose compression for coding agents.**

Caipira gives **Claude Code**, **Codex**, and **Antigravity** a shared, persistent, per-workspace SQLite memory and MCP toolset. There is no background HTTP server, no cloud dependency, and no external vector database—everything runs locally over `stdio` and direct SQLite (`better-sqlite3` with WAL + FTS5) paired with a local quantized ONNX embedding model (`Xenova/all-MiniLM-L6-v2`).

---

## What It Is & How It Helps

Coding sessions across different AI clients normally lose context as soon as a transcript ends—or worse, force every new session to re-read files and re-derive architecture decisions from scratch. Caipira solves this through four core mechanisms:

### 1. Two-Tier Memory Architecture
Caipira separates **what happened** from **what is currently true**:

- **Facts (`facts.js` — Knowledge Layer)**:
  - Durable statements of current truth (`decision`, `constraint`, `preference`, `status`, `gotcha`) stored **verbatim** so exact technical terms, paths, and identifiers are never altered.
  - Backed by **two-tier file evidence fingerprinting**: when a fact is recorded with `evidence: ["/abs/path/to/file.js"]`, Caipira records the file's `size`, `mtime`, and `sha256`.
  - On subsequent checks, `fs.statSync` acts as a microsecond fast gate; only if `size` or `mtime` moved does Caipira compute `sha256` to determine whether the content actually changed.
  - Unflagged facts are verified by construction—agents act on them directly without re-opening the underlying files. When an evidence file *does* change (either in-session via tool writes or between sessions via `git` / another editor) or a `status` fact's `ttl_days` expires, Caipira automatically flips the fact to `needs_review` and tells the agent the exact file(s) to re-read.
- **Observations (`store.js` — Episodic Layer)**:
  - Append-only log of session prompts, tool calls, model invocations, and session summaries captured automatically by lifecycle hooks.
  - Automatically strips `<private>...</private>` blocks and compresses prose (`compress.js`) while strictly preserving code fences, inline code, URLs, file paths, dates, versions, numbers, and identifiers.
  - Indexed with dual-form FTS5 (`porter unicode61`, matching both abbreviated and expanded lexicon forms) and backfilled on idle with 384-dimensional local embeddings for hybrid BM25 + cosine similarity search.

### 2. High-Precision, Silence-by-Default Prompt Injection (`inject.js`)
- Never injects "top-N" results on unrelated prompts.
- Every prompt-driven injection gates independently on **term coverage** (`MIN_COVERAGE = 0.4` over meaningful domain terms) and **evidence trust** (`MIN_TRUST = 0.25`, combining state weight, confidence, evidence freshness, and TTL).
- If a prompt is unrelated to recorded facts, Caipira injects **nothing** (`null`), preserving context window budget and avoiding false premises.

### 3. Per-Workspace Isolation with Opt-In Cross-Workspace Recall (`workspace.js`)
- Resolves every working directory to its enclosing workspace root (`.caipira-workspace` > `.git` / `.hg` > manifest files like `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`), so monorepo subdirectories share a single workspace database (`~/.caipira/database/<slug>-<hash>.db`) tracked in `~/.caipira/database/master.db`.
- Searches are strictly isolated to the current workspace by default. Passing `scope: "all"` to `search_facts` fuses results across all registered workspaces via Reciprocal Rank Fusion (`RRF_K = 60`) weighted by trust and labels each borrowed result with its origin workspace.

### 4. Fail-Open Cross-Client Lifecycle Adapter (`hooks/universal-hook.js`)
- A single hook adapter handles lifecycle payloads for Claude Code, Codex, and Antigravity (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`, `SessionEnd`).
- Detects file writes in real time across clients (`Edit`, `Write`, `edit_file`, `write_file`, `MultiEdit`, `apply_patch`, etc.) to invalidate drifted facts immediately.
- Always exits `0` with valid client JSON so a memory error can never block your coding client.

---

## Runtime Layout & Prerequisites

Caipira is typically installed at `~/.caipira` alongside its bundled **Node.js v22.20.0** runtime and local ONNX model:

```text
~/.caipira/
├── caipira.sh                  # Linux/macOS CLI launcher (uses bundled Node 22)
├── caipira.cmd                 # Windows CLI launcher (uses bundled Node 22)
├── install.js                  # Installer, uninstaller, doctor, status, prune, mode CLI
├── mcp.js                      # Stdio MCP server
├── workspace.js                # Workspace root resolution & master.db registry
├── migrate.js                  # Transactional schema migrations (master + workspace v1/v2)
├── store.js                    # Observation storage, redaction, FTS5 + hybrid embedding search
├── facts.js                    # Verbatim facts, two-tier stat+sha256 verification, RRF recall
├── inject.js                   # Coverage + trust prompt-injection gate
├── compress.js                 # Boundary-protected prose compressor & FTS query builders
├── hooks/
│   └── universal-hook.js       # Cross-client lifecycle hook adapter
├── node22/                     # Bundled Node 22.20.0 runtime (ABI-matched to better-sqlite3)
└── models/
    └── Xenova/all-MiniLM-L6-v2/ # Local quantized ONNX embedding model
```

> **Important**: Always run Caipira via `caipira.sh` / `caipira.cmd` or the bundled Node 22 binary (`~/.caipira/node22/node-v22.20.0-linux-x64/bin/node` on Linux, `node22\node-v22.20.0-win-x64\node.exe` on Windows). `better-sqlite3` is compiled against Node 22's native ABI and will refuse to load under a different system Node major version (such as Node 24).

---

## Installation

1. **Place or sync the repository into `~/.caipira`** (ensuring `node22/` and `models/` are present in `~/.caipira`).
2. **Run the installer**:

   **Linux / macOS:**
   ```sh
   ~/.caipira/caipira.sh install
   ```

   **Windows (PowerShell / CMD):**
   ```bat
   %USERPROFILE%\.caipira\caipira.cmd install
   ```

### What `install` Does
- Installs npm dependencies (`better-sqlite3`, `@xenova/transformers`) using the bundled Node 22 runtime if not already present.
- Creates runtime directories (`logs/`).
- Atomically registers the `caipira` stdio MCP server and lifecycle hooks across all supported clients (saving a `.caipira-backup` copy before modifying any file):
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

Run via `~/.caipira/caipira.sh <command>` on Linux or `caipira.cmd <command>` on Windows:

| Command | Description |
| :--- | :--- |
| `install` | Install dependencies and wire MCP server + hooks into Claude Code, Codex, and Antigravity. |
| `doctor` | Check bundled Node 22, native dependencies, ONNX model, `master.db`, all workspace databases, dangling registry rows, client configs, and active mode. |
| `status` | Display current compression mode and aggregated counts of workspaces, observations, embeddings, facts, and recent sessions. |
| `mode <lite\|full\|ultra>` | Set the active prose compression intensity for newly recorded observations. |
| `prune` | Dry-run report of dangling workspace registry rows (whose project root was deleted) and unclaimed `.db` files. |
| `prune --apply` | Delete dangling workspace rows and their associated `.db` / `-wal` / `-shm` files. |
| `uninstall` | Remove Caipira MCP and hook registrations from Claude Code, Codex, and Antigravity (leaves `~/.caipira/database/` untouched). |

### MCP Tools

Once registered, Caipira exposes **9 tools** to your coding agent over MCP:

#### Knowledge Layer (Facts)
- **`record_fact`**: Record a durable workspace fact (`kind`: `'decision' | 'constraint' | 'preference' | 'status' | 'gotcha'`, `title`, `body`, optional `summary`, `evidence` array of absolute file paths, `scope`, `confidence` `0..1`, `ttl_days`, `supersedes`).
- **`search_facts`**: Search durable facts ranked by trust (`relevance × freshness`). Supports `include_stale` (default `true`) and `scope` (`'workspace'` default, or `'all'` to search across every registered workspace).
- **`update_fact`**: Revise a fact in place (`kind`, `title`, `body`, `summary`, `scope`, `evidence`, `confidence`, `ttl_days`) or transition its `state` (`'active' | 'needs_review' | 'superseded' | 'revoked' | 'proposed'`). Setting `state: 'active'` re-baselines local evidence fingerprints and renews TTL verification.
- **`check_drift`**: Re-verify active facts against their on-disk evidence files (`stat` + `sha256` + `ttl_days`) and return only the drifted facts alongside `files_to_reread`.
- **`list_workspaces`**: List all registered workspaces in `master.db` with their root paths, database files, and last-seen timestamps.

#### Episodic Layer (Observations & Sessions)
- **`search`**: Hybrid FTS5 BM25 + 384-dim cosine similarity search over session observations (with automatic substring `LIKE` fallback).
- **`get_observations`**: Fetch specific observation rows by ID (`ids` array, up to 500), with optional `expand: true` to expand lexicon abbreviations back to full prose.
- **`list_sessions`**: List recent coding sessions with client (`ide`), `cwd`, start/end timestamps, and session IDs.
- **`timeline`**: Retrieve chronological observations for a given `session_id`.

### Privacy Redaction (`<private>`)

Any text wrapped in `<private>...</private>` inside prompts, tool outputs, or summaries is stripped before observation storage or debug traffic logging:

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
| `CAIPIRA_HOME` | `~/.caipira` | Redirects the `database/` directory (`master.db`, per-workspace `.db` files, legacy `data.db`) and `logs/mcp_traffic.log` to a custom directory. |
| `CAIPIRA_MODEL_PATH` | `<root>/models` or `~/.caipira/models` | Overrides the directory containing `Xenova/all-MiniLM-L6-v2`. |
| `CAIPIRA_DEBUG` | unset (`0`) | Set `CAIPIRA_DEBUG=1` to enable `<private>`-redacted MCP JSON-RPC traffic logging to `logs/mcp_traffic.log` (rotates to `.1` at 5 MB). |

---

## Running the Test Suite

Every test suite runs against an isolated temporary `CAIPIRA_HOME` (`test/fixtures.js`) so tests never read or mutate your live `~/.caipira/database/` files:

```sh
# From ~/.caipira (where node22/ and node_modules/ live locally):
~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js

# From a repository checkout using ~/.caipira's runtime and dependencies:
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

---

## License

Released under the [GNU General Public License v3.0](LICENSE) (`GPL-3.0-only`).
