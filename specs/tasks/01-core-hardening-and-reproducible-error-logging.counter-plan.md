# Core hardening and reproducible error logging — counter-plan

Original task spec: [01-core-hardening-and-reproducible-error-logging.md](01-core-hardening-and-reproducible-error-logging.md)
Review evidence: independent review, 2026-10-22 (findings and probes below).
Status: implemented — pending independent review

Reviewed baseline: `3fb1c54debdfad3e04ea69d67db928a7d2d481d9`.
Reviewed completion: `ebdb66528e87b567d0242c24927a2ce048d65eba`.

All nine Node suites pass at the completion commit (841 checks, 0 failures, bundled Node 22). The failures below come from runtime probes that the suites do not model.

## Confirmed failures

**F1 (medium, criteria 1 and 4): the native-failure tests fail at the wrong point, so a real ABI mismatch goes around the guarded loader.**
`better-sqlite3` loads its `.node` addon lazily, on the first `new Database()`, not when the module is required. The fixtures in `test/test-hook.js` §23 (`native`) and `test/test-mcp.js` §10 throw from `require('better-sqlite3')`. Because of that, `hooks/universal-hook.js:11-17` (`loadModules`) and `mcp.js:14-24` only ever see the synthetic error.
- Trigger: run the checkout under system Node v26 (ABI 147) against `~/.caipira/node_modules`, which was built for ABI 127. Use a disposable `CAIPIRA_HOME`.
- Hook result: every client receives the correct acknowledgement and exits 0. However, each run writes **two** journal entries. The first is `workspace resolve`, logged at `universal-hook.js:657`, and holds the real `NODE_MODULE_VERSION 127 … requires 147` message. The second has operation `session-start`, comes from `new MemoryStore`, and reads `Module did not self-register`. Entries are listed newest first, so `caipira logs --limit 1` shows the misleading one.
- MCP result: `moduleFailure` stays `null`. `tools/call` returns `Tool error: <raw multi-line native message with absolute paths>`. The suite asserts that this text never reaches the client. Each tool call and each backfill adds another entry, and every one after the first reads `Module did not self-register`.
- Expected: one entry per hook run that carries the ABI message. MCP should answer `Caipira storage unavailable; inspect caipira logs` and journal the failure once.

**F2 (medium, criteria 4 and 5): `doctor` and `status` journal their own probe results, so their error counts grow every time they run.**
The calls are at `install.js:554` (`read workspace counts`, reached by both `status` and `doctor`), `install.js:584` (`doctor AST`), `install.js:603` (`doctor workspace registry`) and `install.js:635` (`doctor dangling workspaces`). `doctor` and `status` already print each of these inline as `[warn]` or `[FAIL]`.
- `CAIPIRA_AST_BIN` pointing at a missing file, running `doctor` three times: `1`, `2`, `3 recent logged error(s)`.
- A corrupt workspace `.db`, running `status` three times: `recent errors: 1`, `2`, `3`.
- A corrupt `master.db`, running `doctor` twice: `2`, then `4`.
- The `doctor AST` entry's reproduction hint is `install.js install`, because the regex at `errors.js:75` matches `AST`. A doctor warning should never point the user at the full installer, which rewrites client configs.
- Expected: running `doctor` or `status` does not change the count either one reports. A host without the optional AST engine can reach `0 recent logged errors`.

**F3 (low, criterion 4): the AST reproduction hint cannot be run.**
`errors.js:71` emits a bare `caipira-ast …` together with a hardcoded `/tmp/caipira-repro.db`. `caipira-ast` is not on PATH (`which caipira-ast` finds nothing). `ast.js:68-85` resolves the binary from `<CAIPIRA_HOME>/bin`, `<checkout>/bin` or `rust/caipira-ast/target/{release,debug}`. Every other component's hint uses absolute, shell-quoted executable and script paths with `/path/to/...` placeholders.
- Expected: the hint names the engine executable the bridge used, or would have used, as an absolute shell-quoted path. It should also use the same placeholder style for the database.

**F4 (low, criterion 5): `caipira logs | head` crashes.**
With 3 entries, `install.js logs | head -4` prints an unhandled `Error: write EPIPE` stack trace from `log` (`install.js:68`, reached from `logs`) and exits 1.
- Expected: a reader that closes the pipe early ends the command quietly with exit 0, and nothing is journaled.

**F5 (low, user rule: named operational limits): some new limits are plain numbers.**
- `errors.js:126` (`limit = 20`) and `install.js:758` (`let limit = 20`) each define the same default separately; the README documents it as 20.
- `ast.js:211` uses `.slice(0, 3)` for the partial-sync sample. The hook names the same policy `SYNC_FAILURE_SAMPLES`.
- `errors.js:48` caps reproduction words with an unnamed `{0,79}`.

## Surgical corrections

**C1 → F1.** Make the native binding load inside the guarded loaders. In `hooks/universal-hook.js` `loadModules()`, after the requires, and inside the top-level `try` in `mcp.js`, open and close one in-memory database (`new Database(':memory:').close()` using the `better-sqlite3` export). A broken addon then throws once, with its real ABI message, before any workspace or store work. That gives exactly one hook entry through `writeFailure`, and the existing `moduleFailure` path in MCP.

Keep the following unchanged: the acknowledgements, exit codes, the `ensureWorkspace` fallback for non-native errors, the MCP sanitized response, and the WeakMap deduplication. Do not add retries or new modules.

**C2 → F2 (also removes F2's misleading hint).** Delete the four probe `journal(...)` calls at `install.js:554`, `:584`, `:603` and `:635`. Leave the inline `[warn]`/`[FAIL]` output, the `problems` accounting, the top-level command `catch` journaling (`install.js:818`) and the install-time journaling as they are. Do not reclassify operations in `errors.js` to work around this.

**C3 → F3.** The AST bridge passes the absolute engine path to `logError` as a new `binary` detail. That is the resolved binary when `resolveBinary()` succeeds; for `binary_missing` it is `CAIPIRA_AST_BIN` or `INSTALLED_BIN`. `reproduction()` renders it with `shellQuote` and replaces `/tmp/caipira-repro.db` with the `/path/to/repro.db` placeholder. Update the `logError` JSDoc to match. `errors.js` must remain dependency-free and must not require `ast.js`.

**C4 → F4.** Give `install.js` one `process.stdout` error handler. It exits 0 without output on `EPIPE` and rethrows any other error. Do not journal `EPIPE`.

**C5 → F5.** Export one named default (for example `DEFAULT_LOG_LIMIT`) from `errors.js` and use it as both the `readErrors` default and the `logs` CLI default. Name the sample count in `ast.js` and the reproduction word cap in `errors.js`. Leave the values unchanged.

## Acceptance and verification

1. **C1, hook.** Move the hook `native` fixture so the failure happens where it really does: patch `process.dlopen` in the preload to throw `ERR_DLOPEN_FAILED` with a `NODE_MODULE_VERSION` message. Keep `missing` as a require-time `MODULE_NOT_FOUND`. For all three clients, expect exit 0, exactly one acknowledgement and **exactly one** entry, and that entry's message names the ABI. Also re-run the manual system-Node probe, with a disposable home, and confirm one entry per run.
2. **C1, MCP.** Make the same `process.dlopen` change in `test/test-mcp.js` §10. Call `list_sessions` twice and expect both responses to be `-32000 … caipira logs` with no native text, and only one journal entry. `initialize` and `ping` must still work.
3. **C2.** With the AST binary missing, `doctor` run twice reports `0 recent logged errors` both times. With a corrupt workspace `.db`, `status` run twice reports `recent errors: 0` both times while still listing the broken database. The existing non-zero doctor warning test still passes.
4. **C3.** An `ast` entry's hint begins with an absolute, shell-quoted engine path that exists for a resolved binary, contains no `/tmp/`, and passes `/bin/sh -n`. Update the existing AST journal test's regex to match.
5. **C4.** With at least 3 entries, `install.js logs | head -1` exits 0 and writes nothing to stderr.
6. **C5.** `logs` with no `--limit` still shows 20 entries, and `grep` finds no plain `20`, `3` or `79` at the cited sites.

Then run the full suite after the final edit:

```sh
TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Rust and UI checks are not needed, since neither changes. Completion means F1–F5 are fixed and these checks pass, followed by an independent review. Follow the local baseline/completion checkpoints. Do not push, release, bump versions, or add co-author trailers.

## Blockers

None.

## Implementation evidence

- Baseline checkpoint: `78f228eb0e67f939341f04ea022936e22387e9fa`.
- C1: hook and MCP startup now open and close an in-memory SQLite database inside their existing guarded loader. The native fixtures throw from `process.dlopen`; the missing-module hook fixture still throws at require time. The MCP fixture calls `list_sessions` twice and checks the exact safe error response and one journal entry.
- Before the fix, the journal/CLI regressions had six failures and MCP had three; the real system Node v26.10.0 / ABI 147 probe produced two entries per hook run and three MCP entries, including raw tool errors. After the fix, all three hook clients return the expected acknowledgement with exit 0 and one entry containing `NODE_MODULE_VERSION`. MCP initializes, answers ping, returns the safe storage error twice, and retains one ABI entry after the idle backfill timer. Both real-runtime probes used disposable homes; normal execution remains on bundled Node 22.
- C2: removed only the four specified diagnostic-probe journal calls. Twice-run missing-AST doctor, corrupt-workspace status, and corrupt-registry doctor scenarios keep zero retained errors while preserving their inline warning/failure output. The existing non-zero warning check also passes.
- C3: AST boundaries pass their absolute resolved executable (or the missing override/installed candidate) as `binary`; reproduction commands shell-quote it and use `/path/to/repro.db`. Tests cover missing and resolved executables, spaces/apostrophes, all three write/parse operations, and `/bin/sh -n`. The temporary executable itself can live under `/var/tmp`; checks reject temporary database arguments rather than rejecting a legitimate executable path.
- C4: the CLI stdout handler exits quietly with code 0 for EPIPE and rethrows other stdout errors. A real `logs | head -1` check captures the producer's own status, checks empty stderr, and verifies the retained journal count is unchanged.
- C5: `DEFAULT_LOG_LIMIT` is shared by the journal reader and CLI; `SYNC_FAILURE_SAMPLES` and `REPRO_WORD_MAX_CHARS` name the existing sample and word limits. Defaults remain 20 entries, three sample paths, and 80 characters per word.
- Final verification: `TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js` passed all nine suites: **848 checks, 0 failures** (18/33/87/100/90/167/21/141/191). `git diff --check` also passed.
- Changed runtime/test paths: `ast.js`, `errors.js`, `hooks/universal-hook.js`, `install.js`, `mcp.js`, `test/test-errors.js`, `test/test-hook.js`, and `test/test-mcp.js`. No implementation scope deviations; this evidence section records the handoff. Rust/UI checks were not needed for these JavaScript changes.
- Limits: Linux execution verified; Windows/macOS and live runtime deployment remain untested. Independent review is still required; no approval tag is claimed by the implementation checkpoint.
