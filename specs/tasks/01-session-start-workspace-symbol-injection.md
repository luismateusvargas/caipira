# Session-start global workspace symbol injection

Status: ready
Project rules: README.md
Target files: inject.js, hooks/universal-hook.js, README.md, test/test-inject.js, test/test-hook.js

## Outcome and boundary

Feed the agent the workspace's global public AST symbol map **once at session start** (`SessionStart` for Claude Code and Codex, and `PreInvocation` #0 for Antigravity) after incrementally syncing the workspace AST index (`syncWorkspaceAst`), and stop re-injecting `Workspace symbols:` and `Recent sessions:` on subsequent `UserPromptSubmit` / `PreInvocation` turns so the conversation prefix cache stays stable and unrelated prompts receive zero noise.

Outside scope: Changes to the Rust `caipira-ast` parser binary, SQLite schema migrations, MCP tool schemas, or the `caipira explore` web UI.

## Acceptance criteria

1. **Incremental AST sync on session start**:
   - On `session-start` (Claude Code, Codex) and first `pre-invocation` (`invocationNum === 0` or `undefined` in Antigravity), `hooks/universal-hook.js` runs `syncWorkspaceAst(workspace.root, workspace.dbFile, { timeoutMs: 5000 })` before verifying facts and building the startup injection, so a fresh or externally edited workspace has up-to-date symbols in `ast_symbols` on the very first turn.
   - If `caipira-ast` is unavailable, times out, or fails, the hook logs to `stderr` and continues without throwing or blocking session startup.
2. **Comprehensive, deterministically ordered global symbol map at `SessionStart`**:
   - During standing/session-start injection (`!opts.prompt` in `buildInjection`), `inject.js` includes all public workspace symbols (`is_public = 1`) that fit within the startup character budget (default `24000` characters at session start, up to a `64000` maximum when overridden via `opts.budget`), replacing the previous hardcoded `LIMIT 5`.
   - Each symbol line renders its workspace-relative path, qualified name, kind, and line span: `- <path>::<qualified_name> (<kind> L<start_line>-<end_line>)`.
   - When the workspace's public symbols exceed the remaining budget, candidate symbols are selected by priority: (a) active `subpath` locality (`opts.cwd` inside `workspace.root`), (b) incoming caller/type/import fan-in in `ast_edges`, (c) shallower file path depth, and (d) `(path, start_line)`. Selected symbols are emitted in deterministic `(subpath_locality, path, start_line)` order, followed by a bounded omission notice `(... <N> more public symbols omitted to fit budget; use workspace_symbols or inspect_symbol)` without exceeding `budget`.
3. **Cache-safe prompt turns (`UserPromptSubmit` & subsequent `PreInvocation`)**:
   - When `opts.prompt` is provided to `buildInjection` (or on `user-prompt-submit` and non-initial `pre-invocation` events), Caipira injects **only** prompt-matched facts (`Caipira recalled facts:`) and active drift notices (`buildDriftNotice`). It never re-injects `Workspace symbols:` or `Recent sessions:` on prompt turns.
   - An unrelated prompt on a workspace with indexed AST symbols and recorded session digests returns `null` from `buildInjection` (producing `{ continue: true }` for Claude Code and `{}` for Codex/Antigravity when no facts drifted).
4. **Startup instruction guidance**:
   - `AST_STARTUP_INSTRUCTION` in `hooks/universal-hook.js` informs the agent that the workspace's public symbol map (`path::symbol (kind Lstart-end)`) is provided at session start for direct ranged reads and `inspect_symbol` calls, and to use `workspace_symbols` only when searching for private symbols or omitted entries.

## Implementation plan

1. **Upgrade [`inject.js`](file:///home/htxzz77/Projects/caipira/inject.js) (`buildInjection` & symbol projection)**:
   - Raise the maximum allowed `budget` clamp in `buildInjection` from `12000` to `64000` characters (keeping `2400` as the default when `opts.budget` is omitted so existing unit-test callers keep their expected bound, while allowing `universal-hook.js` to pass a `24000` startup budget).
   - Separate standing/session-start injection (`!opts.prompt`) from prompt-turn injection (`Boolean(opts.prompt)`):
     - When `opts.prompt` is non-empty, select and format only matching facts (`Caipira recalled facts:`); return `null` immediately if no facts pass `selectFacts`, without appending `Recent sessions:` or `Workspace symbols:`.
     - When `!opts.prompt` (session start), emit standing facts (`Caipira standing facts for this workspace:`), recent session digests (`Recent sessions:`), and the global public symbol map (`Workspace symbols:`).
   - Replace the `LIMIT 5` symbol query in `buildInjection` with a helper `selectWorkspaceSymbols(db, subpath)` that queries all `is_public = 1` rows from `ast_symbols` alongside their incoming resolved edge count (`ast_edges` fan-in), ranks them by `(in_subpath DESC, fan_in DESC, path_depth ASC, path ASC, start_line ASC)`, packs as many `- ${path}::${qualified_name} (${kind} L${start_line}-${end_line})` lines (plus the omission footer when truncated) as fit the remaining character budget, and re-sorts the kept symbols by `(in_subpath DESC, path ASC, start_line ASC)` for byte-deterministic output.
2. **Sync AST at session start in [`hooks/universal-hook.js`](file:///home/htxzz77/Projects/caipira/hooks/universal-hook.js)**:
   - Import `syncWorkspaceAst` from `../ast`.
   - In `recallContext(db, event, payload, workspace)`:
     - When `starting` is true (`event === 'session-start'` or `event === 'pre-invocation' && isFirstInvocation(payload)`), call `syncWorkspaceAst(workspace.root, workspace.dbFile, { timeoutMs: 5000 })` inside a `try/catch` before `new FactStore(...).verify()` so both symbol-anchored fact verification and `buildInjection` see current workspace symbols.
     - Pass `budget: starting ? 24000 : 2400` and `prompt: starting ? '' : prompt` to `buildInjection`. If `starting` is true on Antigravity `pre-invocation` #0 and `prompt` is also present, append `buildPromptInjection(db, prompt, { ...opts, root: workspace?.root })` if it recalls additional facts not already covered.
   - Update `AST_STARTUP_INSTRUCTION` to reference the session-start symbol map (`path::qualified_name (kind Lstart-end)`) for ranged reads and `inspect_symbol`.
3. **Update documentation in [`README.md`](file:///home/htxzz77/Projects/caipira/README.md)**:
   - Update Section 3 (`High-Precision Prompt Injection & Subpath Recall`) and Section 4 (`Fail-Open Cross-Client Lifecycle Adapter`) to document that `SessionStart` incrementally syncs the workspace AST and injects the global public symbol map once per session, while `UserPromptSubmit` injects only prompt-matched facts and drift notices.
4. **Expand tests in [`test/test-inject.js`](file:///home/htxzz77/Projects/caipira/test/test-inject.js) and [`test/test-hook.js`](file:///home/htxzz77/Projects/caipira/test/test-hook.js)**:
   - In `test/test-inject.js`: verify that standing `buildInjection` includes more than 5 public symbols with `(kind Lstart-end)` metadata, prioritizes `subpath` and fan-in when budget-constrained, emits the omission notice when truncated, and never emits `Workspace symbols:` or `Recent sessions:` when `opts.prompt` is set.
   - In `test/test-hook.js`: verify that `SessionStart` indexes the workspace and injects the global `Workspace symbols:` map, and that subsequent `UserPromptSubmit` / `pre-invocation` (`invocationNum > 0`) turns on an indexed workspace do not re-inject `Workspace symbols:` or `Recent sessions:`.

## Verification

- `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-inject.js` — passes all standing symbol map, ranking, truncation, budget, and prompt-silence checks.
- `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-hook.js` — passes `SessionStart` AST sync + global symbol injection and `UserPromptSubmit` / `PreInvocation` cache-safe silence checks.
- `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js` — all 8 test suites pass with 0 failures.

## Open decisions and sources

- None.
