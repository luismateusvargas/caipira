# Caipira — simple project spec

## Purpose

Caipira is a local-first, cross-client memory and prose-compression toolkit for coding agents (Claude Code, Codex, and Antigravity). It stores compressed session observations and verbatim, file-fingerprinted workspace facts in per-workspace SQLite databases, exposes them over a stdio MCP server, and injects high-precision context through lifecycle hooks without running an HTTP daemon.

## Runtime and files

- Runtime / target sites: Bundled Node.js `v22.20.0` (`node22/node-v22.20.0-linux-x64/bin/node` on Linux, `node22\node-v22.20.0-win-x64\node.exe` on Windows), CommonJS (`"type": "commonjs"`).
- Entry points:
  - CLI installer and maintenance tool: `install.js` (invoked via `caipira.sh` and `caipira.cmd`)
  - Stdio MCP server: `mcp.js`
  - Cross-client lifecycle hook adapter: `hooks/universal-hook.js`
  - Core library modules: `workspace.js`, `migrate.js`, `store.js`, `facts.js`, `inject.js`, `compress.js`
  - Test runner: `test/run-all.js`
- Dependencies: `better-sqlite3` (`^11.5.0`), `@xenova/transformers` (`^2.17.2`, local `Xenova/all-MiniLM-L6-v2` quantized ONNX model).

## Behavior and boundaries

- **Inputs**:
  - Hook lifecycle JSON payloads on `stdin` (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`, `SessionEnd`).
  - JSON-RPC 2.0 requests over `stdin` in `mcp.js` (`search`, `get_observations`, `list_sessions`, `timeline`, `record_fact`, `search_facts`, `update_fact`, `check_drift`, `list_workspaces`).
  - CLI commands in `install.js` (`install`, `uninstall`, `doctor`, `prune [--apply]`, `status`, `mode <lite|full|ultra>`).
- **Outputs**:
  - JSON hook responses on `stdout` (always exiting `0` so hook failures never block the coding client).
  - JSON-RPC 2.0 responses on `stdout` in `mcp.js`.
  - Per-workspace SQLite databases under `~/.caipira/database/<slug>-<hash>.db` indexed by `~/.caipira/database/master.db` (or `process.env.CAIPIRA_HOME` when set).
- **Network access**: None at runtime (`transformers.env.allowRemoteModels = false`).
- **Permissions and external files touched**: `install.js` reads and atomically updates `~/.claude.json`, `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`, and `~/.gemini/config/hooks.json` with `.caipira-backup` backups.

## Constitution

1. **Bundled Node 22 ABI**: Always execute Caipira scripts with the bundled Node 22 binary; `better-sqlite3` is compiled against Node 22's ABI.
2. **Per-workspace isolation by project root**: Every workspace resolves to its enclosing repository/workspace root (`workspace.js`) and uses its own SQLite `.db` file registered in `master.db`. Cross-workspace queries happen only on explicit `scope: "all"` requests and must tag each result with its origin workspace.
3. **Two-tier memory**:
   - *Observations* (`store.js`) are append-only event logs, `<private>`-redacted and prose-compressed while preserving code fences, inline code, URLs, paths, dates, versions, numbers, and identifiers (`compress.js`).
   - *Facts* (`facts.js`) are durable statements of current truth stored verbatim and backed by two-tier file evidence fingerprints (`stat` size/mtime fast gate, `sha256` content verdict).
4. **Trust and silence-by-default injection**: Prompt injection (`inject.js`) gates on both term coverage (`MIN_COVERAGE`) and evidence trust (`MIN_TRUST`), never top-N. Unverified or drifted evidence must be surfaced as `NEEDS REVIEW` with the exact changed file paths.
5. **Fail-open hooks**: Hook scripts must catch unexpected errors, report diagnostics to `stderr`, emit a valid client JSON response on `stdout`, close SQLite handles in `finally` blocks, and exit `0`.
6. **JavaScript development rules (`javascript-dev`)**:
   - Keep modules cohesive with a small public API; consolidate genuine duplicate logic in the narrowest appropriate module.
   - Validate untrusted inputs (stdin JSON, MCP tool arguments, file paths, environment variables) at module boundaries.
   - Manage SQLite connections, child processes, and timers deterministically using `try`/`finally`.
   - Document exported classes, functions, and structured types with concise JSDoc (`@typedef`, `@param`, `@returns`).

## Logging policy

- **Existing logger and coverage gaps**:
  - `mcp.js` writes stderr status/error messages (`[caipira] ...`) and, only when `CAIPIRA_DEBUG=1`, appends `<private>`-redacted stdio traffic to `logs/mcp_traffic.log` (under `CAIPIRA_HOME` when set), rotating to `.1` at 5 MB.
  - `hooks/universal-hook.js` logs recall, workspace resolution, and drift check errors to `stderr` (`[caipira-hook] ...`).
- **Levels and rules**:
  - `INFO`: Startup/backfill summaries on `stderr` in `mcp.js`; `[ok]` step summaries on `stdout` in `install.js`.
  - `WARNING`: Non-fatal skipped operations (`[warn]` in `install.js`; skipped recall or drift verification on `stderr` in `hooks/universal-hook.js`).
  - `ERROR`: Tool execution failures, embedder/backfill failures, and corrupt database handling on `stderr`.
  - `DEBUG`: Raw MCP stdio traffic logging in `logs/mcp_traffic.log` must be opt-in via `CAIPIRA_DEBUG=1`, must redact `<private>...</private>` blocks before writing, and must bound log file growth.
- **Sensitive data**: Never log `<private>` blocks, secrets, or unredacted environment variables to disk logs or error responses.

## Checks

- Run the isolated test suite with the bundled Node 22 runtime:
  ```sh
  ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
  ```
  (When running from a repository checkout without a local `node_modules` directory, pass `NODE_PATH=~/.caipira/node_modules`.)
- Run installation health checks:
  ```sh
  ~/.caipira/caipira.sh doctor
  ```

## Evidence and unknowns

- Repository paths verified: `package.json`, `workspace.js`, `migrate.js`, `store.js`, `facts.js`, `inject.js`, `compress.js`, `mcp.js`, `install.js`, `caipira.sh`, `caipira.cmd`, `hooks/universal-hook.js`, `test/run-all.js`, `test/fixtures.js`, `test/test-workspace.js`, `test/test-facts.js`, `test/test-inject.js`, `test/test-mcp.js`, `test/test-hook.js`, `test/test-install.js`.
- Open questions: None. The legacy CodeWhale hook scripts were removed in `specs/tasks/05-mcp-cli-and-test-hardening.md`; `hooks/universal-hook.js` is the only hook entry point.
