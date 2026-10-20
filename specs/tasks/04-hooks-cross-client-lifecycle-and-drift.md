# Fix cross-client hook drift detection, Antigravity invocation injection, and connection reuse

Status: ready
Project rules: specs/project.md#constitution
Target files: hooks/universal-hook.js, test/test-hook.js
Depends on: specs/tasks/02-workspace-registry-and-storage-integrity.md, specs/tasks/03-fact-verification-and-injection-precision.md

## Outcome and boundary

Update `hooks/universal-hook.js` so in-session drift detection catches file writes from Antigravity (`edit_file`, `write_file`, `Path`) and Codex (`apply_patch`), between-session file edits are verified at session start, Antigravity `pre-invocation` injects standing facts only on the first invocation and recalls prompt-specific facts when a prompt is present, Codex `session-end` closes the session in SQLite, and each hook execution reuses its single open workspace database connection.

## Acceptance criteria

1. Sending a `PostToolUse` (`post-tool-use`) hook payload for Antigravity (`toolName: "edit_file"`, `toolCall: { args: { Path: "<evidence-file>" } }`) or Codex (`tool_name: "apply_patch"`, `tool_input: "*** Begin Patch\n*** Update File: <evidence-file>\n..."`) immediately marks facts resting on `<evidence-file>` as `needs_review` (including when the path in the payload is relative to `payload.cwd`).
2. Modifying an evidence file on disk before `SessionStart` (without a `PostToolUse` event) causes `SessionStart` (`claude-code`/`codex`) and `pre-invocation` (`antigravity`, `invocationNum: 0`) to verify active facts first and include the drifted fact in both the `NEEDS REVIEW` flag and the drift notice.
3. For Antigravity `pre-invocation`, `invocationNum: 0` injects startup instructions and standing facts, while `invocationNum: 1` (without a new prompt or drift) returns `{}` instead of re-injecting standing facts on every step; when `prompt` or `userPrompt` is provided on `pre-invocation`, matching prompt-recalled facts are injected.
4. Invoking `universal-hook.js --client codex --event session-end` with `{ "session_id": "..." }` sets `ended_at` on the session row in the workspace database.

## Implementation plan

1. In `hooks/universal-hook.js`:
   - Add `['session-end', 'session-end']` and `['SessionEnd', 'session-end']` to `EVENT_ALIASES`, and `'session-end': 'SessionEnd'` to `HOOK_EVENT_NAMES`.
   - Broaden `WRITE_TOOLS` to `/^(edit|write|edit_file|write_file|multiedit|multi_edit|notebookedit|str_replace|create_file|apply_patch)$/i`.
   - In `writtenPaths(payload)`:
     - Check `args.file_path`, `args.filePath`, `args.path`, `args.Path`, `args.target_file`, `args.TargetFile`, and `args.notebook_path`.
     - In `args.edits` (or `args.Replacements`), collect `edit.file_path || edit.filePath || edit.path || edit.Path`.
     - If `typeof args === 'string'` or `typeof args.patch === 'string' || typeof args.input === 'string'` (Codex `apply_patch`), parse `*** Update File: <path>`, `*** Add File: <path>`, and `+++ b/<path>` lines.
   - Update `verifyTouchedFacts(db, payload, workspacePath)` to accept the already-open SQLite `db` instance (`store.storage.db`) and pass `workspacePath` as `baseDir` to `facts.factsForPaths(paths, workspacePath)`.
   - Update `recallContext(db, event, payload)` to accept the already-open `db` instance:
     - On `session-start` or (`event === 'pre-invocation' && payload.invocationNum === 0`), run `new FactStore(db, opts).verify()` before querying standing facts and drift notices so external/git edits between sessions are detected.
     - On `pre-invocation`: include `buildStandingInjection(db, opts)` only when `payload.invocationNum === 0` (or `payload.invocationNum === undefined`); if `payload.prompt || payload.userPrompt` is present, also run `buildPromptInjection(db, prompt, opts)`.
   - In `captureEvent(store, event, payload, client, sessionId, workspacePath)`:
     - Pass `client` and `workspacePath` to `store.ensureSession(sessionId, client, workspacePath)` before recording observations so sessions started mid-stream still record their client and workspace.
     - On `event === 'session-end'`, call `store.endSession(sessionId)`.
   - In `MADAR_STARTUP_INSTRUCTION`, use `<project-root>/out/graph.json` instead of `<project-root>\\out\\graph.json`.
2. In `test/test-hook.js`:
   - Add tests verifying Antigravity `edit_file` (`Path`) and Codex `apply_patch` drift invalidation (both absolute and relative to `cwd`), between-session external file modification detected on `SessionStart`, Antigravity `pre-invocation` `invocationNum: 1` not repeating standing facts while still recalling prompt facts, and Codex `session-end` setting `ended_at`.

## Verification

- Run `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-hook.js`; expect all assertions to pass (`0 failed`).

## Open decisions and sources

None.
