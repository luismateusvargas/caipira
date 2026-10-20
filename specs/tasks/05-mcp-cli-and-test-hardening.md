# Harden MCP server, CLI installer/doctor, test runner, and remove legacy CodeWhale hooks

Status: ready
Project rules: specs/project.md#constitution
Target files: mcp.js, install.js, caipira.cmd, package.json, test/run-all.js, test/test-mcp.js, test/test-facts.js, test/test-workspace.js, test/test-inject.js, test/test-hook.js, hooks/session-start.js, hooks/session-end.js, hooks/turn-end.js, hooks/system-inject.js, hooks/proxy-start.js
Depends on: specs/tasks/02-workspace-registry-and-storage-integrity.md, specs/tasks/03-fact-verification-and-injection-precision.md, specs/tasks/04-hooks-cross-client-lifecycle-and-drift.md

## Outcome and boundary

Harden `mcp.js` (input validation, promise error handling, concurrent embedder initialization, stale file-handle eviction, and opt-in `<private>`-redacted debug traffic logging), fix `install.js` (`status`, `doctor`, and `uninstall` across all registered workspaces and clients) and `caipira.cmd` (`CAIPIRA_HOME` environment variable collision), harden the test suite so crashed MCP child processes and standalone suite runs cannot false-pass or pollute `~/.caipira`, and remove the 5 obsolete CodeWhale hook scripts.

## Acceptance criteria

1. Sending non-object JSON (e.g. `null\n`) or invalid tool arguments (missing `ids` array in `get_observations`, missing `session_id` in `timeline`, missing `query` in `search_facts`, missing `id` in `update_fact`) to `mcp.js` returns a JSON-RPC error response (`-32600` or `-32602`) without crashing the server or causing an unhandled promise rejection.
2. `mcp.js` does not write to `logs/mcp_traffic.log` unless `CAIPIRA_DEBUG=1` is set; when enabled, `<private>...</private>` blocks are redacted before logging.
3. `caipira status` and `caipira doctor` report observation, embedding, fact, and session counts aggregated across registered workspace databases (`listWorkspaces()`), `caipira uninstall` removes Caipira entries from Claude Code, Codex, and Antigravity configs, and `caipira.cmd` does not set `CAIPIRA_HOME` in the child environment.
4. If `mcp.js` exits prematurely during `test/test-mcp.js`, pending RPC promises reject immediately and `test/test-mcp.js` exits with code `1`; running any individual `test/test-*.js` file without `CAIPIRA_HOME` set creates and cleans up its own temporary `CAIPIRA_HOME` directory instead of touching `~/.caipira`.
5. The 5 legacy CodeWhale hook files (`hooks/session-start.js`, `hooks/session-end.js`, `hooks/turn-end.js`, `hooks/system-inject.js`, `hooks/proxy-start.js`) are removed, leaving `hooks/universal-hook.js` as the single cross-client hook entry point.

## Implementation plan

1. In `mcp.js`:
   - Gate `logTraffic(direction, data)` on `process.env.CAIPIRA_DEBUG === '1'`, redact `<private>` blocks via `redactPrivate` from `./store`, remove the duplicate `logTraffic('IN', chunk)` call (keep line-level `IN` and `OUT`), and cap `mcp_traffic.log` at 5 MB (rotating to `.1`).
   - Cache the in-flight initialization promise in `getEmbedder()` (`let embedderPromise = null`) so concurrent requests share a single pipeline load, and default `modelDirectory` to `path.join(__dirname, 'models')` if it exists before falling back to `path.join(os.homedir(), '.caipira', 'models')`.
   - In `factsFor(cwd)` and `memoryAt(dbFile)`: if a cached entry's `dbFile` no longer exists on disk (`!fs.existsSync(dbFile)`), close and evict the cached connection before opening a new one.
   - In `process.stdin.on('data')`: validate that parsed `msg` is a non-null plain object with `typeof msg.method === 'string'`; otherwise respond with `{ code: -32600, message: 'Invalid Request' }`. Attach `.catch(err => respond(msg?.id ?? null, { code: -32603, message: err.message }))` to `handle(msg)`.
   - In `respond(id, result)`: distinguish errors via an explicit `respondError(id, code, message)` helper rather than checking `if (result && result.code)`.
   - In `handleToolCall(id, params)`: validate `args.ids` (`Array.isArray(args.ids)` with numeric elements, max 500), `args.session_id` (non-empty string), `args.query` in `search_facts` (non-empty string), and `args.id` in `update_fact` (number); expose optional `kind`, `scope`, and `evidence` in `update_fact`'s `inputSchema`.
2. In `install.js` and `caipira.cmd`:
   - In `caipira.cmd`: rename `CAIPIRA_HOME` to `CAIPIRA_DIR` so running `caipira.cmd` on Windows does not set `process.env.CAIPIRA_HOME`.
   - In `install.js` `status()`: iterate over `listWorkspaces()`, summing observations, embeddings, and facts across all existing workspace `.db` files and displaying the top recent sessions across workspaces.
   - In `install.js` `doctor()`: verify `openMaster()` and workspace databases via `listWorkspaces()`; treat missing `~/.codex/config.toml` as a `[warn]` (matching `registerCodex()`) rather than a `[FAIL]`.
   - In `install.js` `unregister()`: also remove `mcpServers.caipira` from `ANTIGRAVITY_MCP`, remove `caipira` from `ANTIGRAVITY_HOOKS`, and strip `[mcp_servers.caipira]` and Caipira hook blocks from `CODEX_CONFIG` when present.
3. In `package.json` and `test/`:
   - Add `"scripts": { "test": "node test/run-all.js" }` to `package.json`.
   - Create a small helper in `test/fixtures.js` (`ensureIsolatedHome()`) called at the top of each `test/test-*.js` suite so standalone execution (`node test/test-facts.js`) automatically allocates and cleans up a temporary `CAIPIRA_HOME` if `process.env.CAIPIRA_HOME` is unset.
   - In `test/test-mcp.js`: listen to `child.on('exit')` and `child.on('error')` to reject all `pending` promises and exit non-zero if `mcp.js` terminates unexpectedly before `child.kill()`, and add a 10-second timeout per RPC call.
4. Remove obsolete CodeWhale hooks:
   - Delete `hooks/session-start.js`, `hooks/session-end.js`, `hooks/turn-end.js`, `hooks/system-inject.js`, and `hooks/proxy-start.js`.

## Verification

- Run `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js`; expect all 5 suites (`test-workspace`, `test-facts`, `test-inject`, `test-mcp`, `test-hook`) to pass (`0 failed`).
- Run `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node install.js status` and `install.js doctor`; expect workspace-aggregated counts and `0 problem(s) found`.
- Verify `hooks/` contains only `universal-hook.js`.

## Open decisions and sources

None.
