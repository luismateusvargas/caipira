# Block 2: MCP Symbol Tools, Hook AST Deltas & Second-Brain Episodic Recall — counter-plan

Original task spec: specs/tasks/02-mcp-symbol-tools-hook-deltas-and-second-brain-recall.md
Review evidence: independent review of 465c4d4 (baseline 8236b45), 2026-10-21. All 7 Node suites pass at 465c4d4. The failures below came from scratchpad reproductions, a run of the baseline 8236b45 for comparison, and the PostToolUse output schema embedded in Codex 0.163.0.
Status: ready

## Confirmed failures

1. **Criterion 4: the agent never sees the AST reminder.** `hooks/universal-hook.js:225-227` returns `{ systemMessage: reminder }` for both `claude-code` and `codex`. In Claude Code, `systemMessage` is a warning shown to the user. Text for the model goes in `hookSpecificOutput.additionalContext` with `hookEventName: 'PostToolUse'`. Codex 0.163.0's embedded `post-tool-use.command.output` schema has the same `PostToolUseHookSpecificOutputWire.additionalContext` field. The comment at `hooks/universal-hook.js:205` says only SessionStart and UserPromptSubmit can carry `additionalContext`, which is out of date. `test/test-hook.js:319-320` asserts `systemMessage`, so the tests lock in the wrong channel.
   - Trigger: index `api.js` (`function api(v)`, plus a `caller` that calls it), change the signature to `api(v, w)`, then run the hook with `--client claude-code --event PostToolUse` and payload `{tool_name:'Edit', tool_input:{file_path}}`.
   - Observed: `{"systemMessage":"<system-reminder>\nCaipira AST signature changes:\n- api.js::api: function api(v) → function api(v, w)\n  Callers: api.js::caller:2\n</system-reminder>"}`. Codex gets the same output.
   - Expected: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<system-reminder>…"}}`.

2. **Regression: recalled facts with stale evidence lose their NEEDS REVIEW flag.** `inject.js:224-226` maps `selectFacts` rows to `{ ...row.fact, score }`, which throws away `row.stale` (the paths `checkEvidence` found changed). `inject.js:257` then flags a fact only when `fact.state === 'needs_review'`. The UserPromptSubmit hook does not call `verify()`, so the fact keeps `state = 'active'` when its evidence changes outside a hook, for example after a git pull or an edit in another editor.
   - Trigger: record a fact with evidence `server.js` (`PORT = 3000`), rewrite the file to `PORT = 8080`, then send UserPromptSubmit `which port does the dev server listen on?` through `claude-code`.
   - Observed at 465c4d4: `- [decision#1] The dev server listens on port 3000 configured in server.js.` with no flag.
   - Observed at baseline 8236b45: `… (NEEDS REVIEW — changed since recorded: /tmp/…/server.js)`.
   - Impact: the startup instruction says an unflagged injected fact is verified and must not be re-checked, so the agent acts on a fact whose evidence has changed.

3. **Criterion 1: auto-indexing stops after a single-file delta.** `mcp.js:99-102` (`ensureAstIndex`) skips `syncWorkspaceAst` once `ast_files` has any row. A PostToolUse hook delta, or the file indexing done for `record_fact.evidence_symbols`, writes one row. After that, `workspace_symbols` and `inspect_symbol` never index the rest of the workspace.
   - Trigger: a workspace has `a.js` (`alpha`) and `b.js` (`beta`). Run a `claude-code` PostToolUse `Edit` on `a.js`, then call `workspace_symbols {query:'beta'}`.
   - Observed: `[]`. `workspace_symbols {}` returns only `a.js::alpha`.
   - Expected: `beta` is found, because the workspace had never been fully indexed.

4. **Criterion 5: the session digest is fixed at the first turn.** Claude Code and Codex fire `Stop` at the end of every turn. `synthesizeSessionDigest` (`hooks/universal-hook.js:326-327` and the `UPDATE … AND summary IS NULL` at `:344`) writes the digest on the first `Stop` and never changes it. It is the only code that writes `sessions.summary` (checked with grep), so the "not already populated" guard only ever blocks its own refresh.
   - Trigger: run SessionStart, PostToolUse `Read`, Stop, PostToolUse `Edit api.js`, PostToolUse `Write b.js`, Stop, SessionEnd for one session.
   - Observed: `summary = "Tools: Read (1 calls)"`, even though the session recorded 3 tool_result rows and modified 2 files.
   - Expected: the digest lists `Edit, Read, Write (3 calls)` and the modified files.

5. **Optional `evidence_ranges` silently drops ranges.** `facts.js:144-149` stores each range on the single `fact_evidence` row that `UNIQUE(fact_id, path, machine)` allows. When two ranges name the same file, only the last one is kept, and `record_fact` still reports success.
   - Trigger: `record_fact {evidence_ranges:[{path:m.js,1,1},{path:m.js,3,3}]}` on `function one` (line 1) and `function three` (line 3), then `inspect_symbol` each one.
   - Observed: `record_fact` echoes only `{start_line:3,end_line:3}`. `inspect_symbol one` does not link the fact, while `inspect_symbol three` does.
   - Expected: both ranges are linked, or the call is rejected.

## Surgical corrections

1. In `writeClientResult`, for `claude-code` and `codex` PostToolUse with `result.reminder`, write `{ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.reminder } }` instead of `systemMessage`. Update the comment at `:205` to match. Leave the Antigravity `injectSteps` branch and the bare acknowledgement for reminder-less events unchanged.
2. In `buildInjection`, keep `stale` when mapping `selectFacts` rows. When `stale.length > 0`, append `(NEEDS REVIEW — changed since recorded: <paths>)`, the same text `renderInjection` used. Keep the existing `needs_review` flag. Do not change ranking, the budget, or the standing (no-prompt) path.
3. Replace the "any `ast_files` row" check in `ensureAstIndex` with a per-process `Set` of `dbFile`s that have completed a successful `syncWorkspaceAst`. The first `workspace_symbols` or `inspect_symbol` call for each workspace in an MCP process then runs one incremental, stat-gated sync. Leave `resolveSymbolEvidence`'s single-file update unchanged.
4. In `synthesizeSessionDigest`, drop the early return when a summary already exists. Always recompute the digest, which is deterministic over the session's `tool_result` rows. Write it with `WHERE id = ? AND (summary IS NULL OR summary != ?)`. Criterion 5's phrase "when not already populated" then means "unless the same digest is already stored" (see Blockers).
5. Reject `evidence_ranges` that name the same path more than once, in both `invalidArguments('record_fact')` and `FactStore.record`. Use a clear message such as `evidence_ranges may list each file once`. Do not add a schema migration.

## Acceptance and verification

Run every command with `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node`.

1. `test/test-hook.js` section 13: change the Codex assertion and add a `claude-code` variant. Both check that `hookSpecificOutput.hookEventName === 'PostToolUse'` and that `additionalContext` contains `<system-reminder>`, `api.js::api`, `caller`, and `[constraint#<id>]`. Also assert that a PostToolUse with no signature change still returns `{continue:true}` for `claude-code` and `{}` for `codex`.
2. `test/test-inject.js`: record a fact with an evidence file, rewrite that file without calling `verify()`, and call `buildInjection(db, ws, {prompt})` with a matching prompt. The fact appears with `NEEDS REVIEW — changed since recorded` and the changed path.
3. `test/test-mcp.js`: in a fresh workspace containing `a.js` and `b.js`, call `updateFileAst` on `a.js` only. `workspace_symbols {query:'beta'}` then returns `b.js::beta`. The existing section 2a assertions still pass.
4. `test/test-hook.js`: run one session through SessionStart, Read, Stop, Edit, Write, Stop, SessionEnd. Assert that `sessions.summary` includes `Edit`, `Write`, and `Files:`, and does not equal the first-turn digest. Run SessionEnd again and confirm the stored summary is unchanged.
5. `test/test-mcp.js`: `record_fact` with two `evidence_ranges` on the same path returns an error and records no fact. The existing single-range include and exclude assertions still pass.
6. Regression check: `test/run-all.js` passes all 7 suites.

The counter-plan is complete when all five failures are fixed and checks 1–6 pass.

## Blockers

- Correction 4 conflicts with the wording of criterion 5 ("when not already populated"). The project owner must accept the reading "unless an identical digest is already stored" and amend the line in the task spec. If they decline, drop correction 4 and check 4, and record that digests reflect only the first turn as a known limitation.
