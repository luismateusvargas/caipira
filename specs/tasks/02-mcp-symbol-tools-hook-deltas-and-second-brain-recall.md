# Block 2: MCP Symbol Tools, Hook AST Deltas & Second-Brain Episodic Recall

Status: ready
Project rules: specs/project.md
Target files: mcp.js, hooks/universal-hook.js, inject.js, facts.js, ast.js, migrate.js, test/test-mcp.js, test/test-hook.js, test/test-inject.js, test/test-facts.js, test/test-ast.js, test/test-workspace.js

## Outcome and boundary

Connect the Block 1 AST symbol store (`ast.js` + `<workspace>.db`) and `fact_symbol_evidence` (`<workspace>.db`) to Caipira's machine-facing interfaces:
1. Expose `workspace_symbols` and `inspect_symbol` MCP tools in [`mcp.js`](file:///home/htxzz77/Projects/caipira/mcp.js), and extend `record_fact` and `check_drift` with symbol-level evidence (`evidence_symbols`) so facts anchored to specific functions/structs only drift when that symbol's `signature_hash` changes or the symbol is deleted.
2. Replace the external `madar` dependency in [`hooks/universal-hook.js`](file:///home/htxzz77/Projects/caipira/hooks/universal-hook.js) (`handlePostToolUse`) with Caipira's built-in incremental single-file AST delta (`updateFileAst`), alerting the agent when a modified function's signature changes or impacts callers and symbol-anchored facts.
3. Synthesize structured session digests at `Stop` / `SessionEnd` (`sessions.summary`) and upgrade [`inject.js`](file:///home/htxzz77/Projects/caipira/inject.js) (`buildInjection`) to deliver subpath-boosted standing facts, recent episodic session continuity, and a compact workspace symbol map on `SessionStart` / `UserPromptSubmit`.

Outside scope: The `caipira explore` HTTP server and React UI, which belong to Block 3.

## Acceptance criteria

1. **`workspace_symbols` MCP tool**:
   - Accepts `{ query?, kind?, path_prefix?, public_only?, limit?, cwd? }`.
   - Automatically triggers incremental `syncWorkspaceAst` if the workspace has not been indexed yet.
   - Returns matching AST symbols with `id`, `name`, `qualified_name`, `kind`, `is_public`, `path`, `start_line`, `end_line`, `signature_text`, `params`, `return_type`, and `doc_summary`.
2. **`inspect_symbol` MCP tool**:
   - Accepts `{ symbol, path?, cwd? }` (matching by symbol `id`, `qualified_name`, or `name` + optional `path`).
   - Returns complete symbol details:
     - **Inputs (`params`)**: array of `{ name, type_annotation, default_value }`
     - **Output (`return_type`)**: return type string or `null`
     - **Documentation & Location**: `doc_summary`, `signature_text`, `path`, `start_line`, `end_line`, `signature_hash`
     - **Connections**: incoming `callers` (`source_path`, `source_symbol`, `line`), outgoing `callees` (`target_symbol`, `target_path`, `line`), `type_references` (`uses_type` / `extends` / `implements`), and file `imports`
     - **Linked Facts**: any active Caipira facts (`decision`, `constraint`, `gotcha`, `preference`, `status`) linked to this symbol via `fact_symbol_evidence` or enclosing `fact_evidence` line ranges.
3. **Symbol-level fact evidence & precision drift (`record_fact` & `check_drift`)**:
   - `record_fact` accepts optional `evidence_symbols: string[]` (formatted as `"path/to/file.rs::qualified_name"` or `"path/to/file.js:line"`, automatically resolved to enclosing AST symbols when indexed) and stores `(fact_id, path, qualified_name, signature_hash)` in `fact_symbol_evidence`.
   - Editing an unrelated function in `path/to/file.rs` changes the file's SHA-256 hash, **but** if the fact has `fact_symbol_evidence` whose target symbol still exists with the same `signature_hash`, `checkDrift` refreshes the file hash and reports the fact as **clean** (`drifted: []`).
   - Changing the target symbol's parameters/return type (altering `signature_hash`) or deleting the target symbol causes `checkDrift` to report `{ fact, broken: [{ path, symbol, reason: 'symbol_signature_changed' | 'symbol_missing' }] }`.
4. **Native `PostToolUse` AST delta in `hooks/universal-hook.js` (replacing `madar`)**:
   - On `Write`, `Edit`, or `MultiEdit`, `handlePostToolUse` runs `updateFileAst(ws.root, ws.dbFile, filePath)` instead of spawning `madar`.
   - If a public symbol's signature changed (`modified` or `removed` in the AST diff) or a symbol referenced by an active fact changed, `handlePostToolUse` emits a `<system-reminder>` listing the changed symbol signature, its known callers in the workspace, and any impacted `[category#id]` facts.
5. **Episodic Session Digest & Enhanced `buildInjection` (`inject.js`)**:
   - At `Stop` / `SessionEnd`, `universal-hook.js` computes a deterministic session digest summarizing files modified, symbols touched, and tools executed, saving it to `sessions.summary` unless an identical digest is already stored.
   - `buildInjection(registry, ws, { cwd, budget })` in `inject.js` prioritizes facts whose `fact_evidence.path` or `fact_symbol_evidence.path` matches the active relative subpath (`cwd` inside `ws.root`), appends a concise `Recent sessions:` block (last 1–2 non-empty session digests), and stays strictly within `budget` characters.

## Implementation plan

1. **Extend [`facts.js`](file:///home/htxzz77/Projects/caipira/facts.js) for symbol-anchored facts**:
   - Update `FactStore.record` to accept `evidenceSymbols = []` (`Array<{ path, qualifiedName, signatureHash }>`), inserting into `fact_symbol_evidence`.
   - Update `FactStore.verify(ids)` to evaluate `fact_symbol_evidence` against `<workspace>.db`'s `ast_symbols`:
     - If a fact has symbol evidence and all referenced symbols still exist with matching `signature_hash`, treat the fact as verified even if the file's overall SHA-256 changed.
     - If a referenced symbol is missing or its `signature_hash` changed, include `{ path, symbol: qualified_name, reason: 'symbol_missing' | 'symbol_signature_changed' }` in `broken`.
2. **Add `workspace_symbols` and `inspect_symbol` tools in [`mcp.js`](file:///home/htxzz77/Projects/caipira/mcp.js)**:
   - Register `workspace_symbols` and `inspect_symbol` in `TOOLS` and `handleTool()`.
   - Extend `record_fact` schema in `mcp.js` with optional `evidence_symbols` (`string[]` of `"rel/path::symbol"`), resolving current `signature_hash` from `<workspace>.db` (auto-indexing the file if needed).
   - Format `inspect_symbol` output clearly showing `Signature`, `Receives (params)`, `Returns`, `Doc`, `Callers`, `Callees`, `Type Dependencies`, and `Attached Facts`.
   - Add a versioned workspace migration and optional `record_fact.evidence_ranges` so `inspect_symbol` can also link active file evidence whose line range overlaps the symbol.
3. **Upgrade [`hooks/universal-hook.js`](file:///home/htxzz77/Projects/caipira/hooks/universal-hook.js) and [`inject.js`](file:///home/htxzz77/Projects/caipira/inject.js)**:
   - Replace the Madar startup guidance with Caipira symbol tools and use `updateFileAst(ws.root, ws.dbFile, filePath)` in the `PostToolUse` capture path for caller and fact-impact notices.
   - Add `synthesizeSessionDigest(store, sessionId)` in `universal-hook.js` called on `Stop` / `SessionEnd` so every non-trivial session stores a concise episodic digest in `sessions.summary`.
   - Add `buildInjection(db, ws, opts)` in `inject.js` with `{ budget, cwd, prompt, machine }`, applying a subpath relevance boost (`+0.25` sort weight when a fact's evidence path shares the active `cwd` subpath) and appending recent session digests when budget allows.
4. **Update and expand tests in [`test/test-mcp.js`](file:///home/htxzz77/Projects/caipira/test/test-mcp.js), [`test/test-hook.js`](file:///home/htxzz77/Projects/caipira/test/test-hook.js), and [`test/test-inject.js`](file:///home/htxzz77/Projects/caipira/test/test-inject.js)**:
   - Test `workspace_symbols` and `inspect_symbol` over MCP stdio.
   - Test symbol-level drift immunity (unrelated edit in same file does not drift symbol-anchored fact) and symbol-level drift trigger (changing function parameter/return type marks fact drifted).
   - Test `PostToolUse` hook `<system-reminder>` emission on breaking signature change without `madar`.
   - Test session digest generation and `buildInjection` subpath boosting + episodic continuity.

## Verification

- `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-mcp.js` — passes all existing + new `workspace_symbols`, `inspect_symbol`, and `evidence_symbols` tests.
- `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-hook.js` — passes `PostToolUse` AST delta warning and `SessionEnd` digest synthesis tests within timeout budgets.
- `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-workspace.js` — passes workspace and schema migration tests; `test/test-mcp.js` covers symbol drift and `test/test-inject.js` covers subpath injection.

## Open decisions and sources

- None.
