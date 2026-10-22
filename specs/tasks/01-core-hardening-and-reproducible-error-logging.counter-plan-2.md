# Core hardening and reproducible error logging — counter-plan 2

Original task spec: [01-core-hardening-and-reproducible-error-logging.md](01-core-hardening-and-reproducible-error-logging.md)
Reviewed task: [Counter-plan 1, C1–C5](01-core-hardening-and-reproducible-error-logging.counter-plan.md)
Review evidence: independent review, 2026-10-22 (probes below).
Status: implemented — pending independent review

Reviewed baseline: `78f228eb0e67f939341f04ea022936e22387e9fa`.
Reviewed completion: `12dc6f0ef031ced8b1edef6fb2fa27a08ffc7f8d`.

Counter-plan 1 fixes F1, F2 and F5, and the runtime probes confirm it:
- **F1:** under system Node v26 with a real ABI mismatch, each hook client writes one `NODE_MODULE_VERSION` entry and exits 0. Repeated MCP tool calls get the safe storage error, with one journal entry.
- **F2:** `doctor` and `status` no longer change the error counts they report.
- **F5:** the limits are named.

All nine suites pass (848 checks, 0 failures). Two problems remain, both in the C3 and C4 corrections.

## Confirmed failures

**G1 (low; a regression introduced by C4): a closed output pipe turns any failing CLI command into a success.**
`install.js:17` calls `process.exit(0)` on `EPIPE`, which overwrites the `process.exitCode` the command has already set. Counter-plan 1's C4 text said "exits 0", and the implementation followed it literally.
- Trigger: with a corrupt `<CAIPIRA_HOME>/database/master.db`, run `install.js doctor | true` and read `${PIPESTATUS[0]}`.
- Observed: unpiped exit 1. Piped exit 0 in 3 of 3 runs at `12dc6f0`. At `ebdb665` the same pipeline exited 1 in 2 of 2 runs.
- Impact: under `set -o pipefail`, or anywhere `PIPESTATUS` is checked, `caipira doctor | head` or `| grep -q` reports a broken install as healthy. The same applies to any command that fails after the consumer has closed the pipe.
- Expected: an early-closing reader is silent, and the command's own exit status is kept. That status is 0 for `logs` and 1 for `doctor` when it finds problems.

**G2 (low; C3 incomplete): an AST failure that happens before the engine is resolved names the wrong binary.**
`ast.js:216`, `:250` and `:275` set `binary` to `opts.bin || CAIPIRA_AST_BIN || INSTALLED_BIN` up front. That value is always truthy, so the lazy resolution inside `journal()` (`ast.js:88-96`) never runs for errors thrown by `requireText` or `prepareDb`.
- Trigger: leave `CAIPIRA_AST_BIN` unset in a checkout where only `rust/caipira-ast/target/release/caipira-ast` exists. Call `syncWorkspaceAst(root, <corrupt .db>)`, which fails with `SQLITE_NOTADB`.
- Observed: `resolveBinary()` returns `…/target/release/caipira-ast`, but the hint begins with `'<CAIPIRA_HOME>/bin/caipira-ast'`, which does not exist.
- Expected (C3): the hint names the resolved binary whenever `resolveBinary()` succeeds, and the override or installed candidate only when it fails. In a standard install the installed binary is the first candidate, so the two only differ in source checkouts and with `<checkout>/bin`.

## Surgical corrections

**D1 → G1.** In the `install.js` stdout handler, replace `process.exit(0)` with `process.exit()`, which keeps `process.exitCode`. Keep everything else as it is: no output on `EPIPE`, no journal entry, and other stdout errors still rethrown.

**D2 → G2.** In `syncWorkspaceAst`, `updateFileAst` and `parseFileAst`, start with `let binary = opts.bin;`. `journal()` then resolves the binary itself, and when resolution fails it already falls back to `CAIPIRA_AST_BIN` or `INSTALLED_BIN`. Leave the post-resolution assignment, the `runEngine` call, the `binary_missing` hint and `errors.js` unchanged.

I applied both one-line changes in a disposable worktree to confirm the approach:
- `doctor | true` exited 1 three times, and `logs | true` exited 0 three times.
- The corrupt-DB hint named `…/target/release/caipira-ast`.
- A missing `CAIPIRA_AST_BIN` was still named.
- `test-errors` (18), `test-ast` (141) and `test-install` (21) all passed.

## Acceptance and verification

1. **D1.** In `test/test-errors.js`, pipe the CLI into a consumer that closes at once (`| true`), so `EPIPE` happens reliably. The existing `| head -1` check can pass without ever raising `EPIPE` when all 20 entries fit in the pipe buffer.
   - With the corrupt registry, `doctor`'s `${PIPESTATUS[0]}` is 1.
   - With entries in the journal, `logs`'s `${PIPESTATUS[0]}` is 0.
   - stderr is empty and the journal count is unchanged in both cases.
2. **D2.** With `CAIPIRA_AST_BIN` unset, make `syncWorkspaceAst` fail at `prepareDb` on a corrupt database. The hint must begin with the shell-quoted path that `resolveBinary()` returns in that process, or `INSTALLED_BIN` when resolution throws. The existing missing-override and resolved-override AST tests must still pass.
3. Run the full suite after the final edit:

```sh
TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Rust and UI checks are not needed. Completion means G1 and G2 are fixed and these checks pass, followed by an independent review. Follow the local baseline/completion checkpoints. Do not push, release, bump versions, or add co-author trailers.

## Blockers

None.

## Implementation evidence

- Baseline checkpoint: `d0c9c09cf5084727392c51225531574f025c5ecf`.
- D1: the stdout EPIPE handler now uses `process.exit()` to preserve the command's existing exit status. The regression helper pipes into `true` and captures the producer's own `PIPESTATUS`: logs exits 0, corrupt-registry doctor exits 1, stderr stays empty, and the error journal stays unchanged.
- D2: all three AST entry points initialize `binary` from `opts.bin` alone, allowing `journal()` to resolve the actual candidate when input validation or database preparation fails. The new check unsets `CAIPIRA_AST_BIN`, triggers `SQLITE_NOTADB` in index/update preparation and `invalid_argument` before parsing, and compares each hint with that process's resolved executable (or installed candidate if resolution fails). Existing missing/resolved override tests also pass.
- Before the four runtime-line corrections, the journal suite reported **18 passed, 2 failed**, reproducing G1 and G2. Afterward it reported **20 passed, 0 failed**.
- Final verification: `TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js` passed all nine suites: **850 checks, 0 failures** (20/33/87/100/90/167/21/141/191). `git diff --check` passed.
- Changed implementation/test paths: `install.js`, `ast.js`, and `test/test-errors.js`. No scope deviations. Rust/UI checks were not needed for this correction.
- Limits: Linux with bundled Node 22 verified; Windows/macOS execution and live runtime deployment remain untested. Independent review remains pending; the implementation checkpoint is not an approval tag.
