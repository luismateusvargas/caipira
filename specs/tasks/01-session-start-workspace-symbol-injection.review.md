# Task 01 independent review — changes required

Reviewed on 2026-10-21 against [the task spec](01-session-start-workspace-symbol-injection.md).

Baseline: `52072375dc3fcf151225badc9bd5329d5c8ee54f`.
Completion and reviewed HEAD: `c42a035059d3bc33e76d2aab12e1153164f6ff6a`.

## Findings

### R1 — P1: startup can exceed the installed client timeout

Locations: `hooks/universal-hook.js:191`, `facts.js:289`, `facts.js:298`, `facts.js:388`, `install.js:52`.

The new five-second startup sync is followed by unbounded fact verification. Each `checkEvidence` owns a fresh set of refreshed paths, so different facts anchored to the same changed source retry the unavailable parser separately, each with a two-second timeout. There is no shared deadline or refresh result across the startup operation.

Reproduction: create an isolated workspace with `export function api(value) { return value; }`, index it, and record six facts anchored to `api.js::api`. Change the source to add a parameter, then run Codex `SessionStart` with `CAIPIRA_AST_BIN` pointing to an executable containing `#!/bin/sh` and `exec sleep 30`. Observed: valid output only after **17,063 ms**, with one `AST sync skipped: caipira-ast timed out` diagnostic. The installer allows 15 seconds for this handler. Thus the client can kill the hook before it returns its promised fail-open response. The added timeout test has no anchored facts and misses this case.

Correction: bound the whole startup operation below the client deadline, share AST refresh outcomes by workspace-relative path across verification, and stop launching more subprocesses after parser timeout/unavailability. Preserve the distinction between unverifiable and verified facts. This combines the new sync with a pre-existing verifier problem; it is a necessary scope addition for acceptance criterion 1.

### R2 — P2: a needs-review fact can be rendered as settled

Locations: `inject.js:150`, `hooks/universal-hook.js:170`.

`renderInjection` requires a nonempty `stale` array even when `fact.state === 'needs_review'`. A TTL expiry or an explicitly flagged fact can have no changed file paths. The renderer then prints an unmarked fact followed by instructions to act on unmarked facts as settled. Task 01 newly calls this renderer for Antigravity's extra startup recall. A separate drift list cannot guarantee coverage because it is limited to five facts.

Reproduction: render `[{ fact: { id: 123, kind: 'decision', summary: 'TTL expired.', state: 'needs_review' }, stale: [] }]`. Observed fact line: `- [decision#123] TTL expired.` with no review flag. `buildInjection` already handles this state correctly at line 336.

Correction: use one consistent fact-line review rule for both renderers: state alone requires `(NEEDS REVIEW)`; changed paths add the more detailed warning. Preserve fact IDs, deduplication, and relevance gates.

### R3 — P2: failure responses bypass the client protocol and input validation

Locations: `hooks/universal-hook.js:436`, `hooks/universal-hook.js:453`, `hooks/universal-hook.js:464`.

The outer catch emits `{ ok: false, error: <raw error> }` instead of the client-specific acknowledgment used by `writeClientResult`. JSON is parsed without validating the payload shape or field types first. A storage error or malformed session identifier reaches this catch and exposes implementation errors in the protocol output. This is pre-existing behavior within the lifecycle boundary covered by the task's fail-open promise.

Reproductions using disposable directories:

- Set `CAIPIRA_HOME` to an existing regular file and invoke Codex `SessionStart`. Observed stdout: `{"ok":false,"error":"unable to open database file"}`; exit status 0. Expected a supported Codex response, with diagnostics on stderr.
- Send an object as `session_id`. Observed stdout: `{"ok":false,"error":"Too few parameter values were provided"}`. The value reached the database rather than being rejected at the payload boundary.

Correction: normalize and validate the JSON object and consumed fields before capture; resolve the client from CLI arguments even when parsing/storage fails; route every failure through the supported client response shape. Keep contextual diagnostics on stderr, rather than returning raw database errors.

### R4 — P2: partial AST failures are silently treated as successful syncs

Location: `hooks/universal-hook.js:160`; contract: `ast.js:204`, `rust/caipira-ast/src/store.rs:147`.

`syncWorkspaceAst` can succeed as a process while returning `failed > 0` and `failures`. The Rust engine deliberately retains old rows on unreadable files/directories. `syncSessionAst` discards that result, so no warning explains that the startup map is incomplete or stale.

Reproduction: supply a parser executable returning valid index statistics with `failed: 1` and `failures: [{ path: 'src/api.js', message: 'Permission denied' }]`, all other counts zero. Observed: startup context returned, exit status 0, **empty stderr**. This violates the diagnostic part of criterion 1 for a supported failure result.

Correction: inspect the validated statistics, log a bounded operation-specific diagnostic for partial failure, retain usable index rows, and continue startup. Do not convert partial indexing into a client-blocking failure.

### R5 — P2: an optional symbol query can erase otherwise usable memory

Locations: `inject.js:346`, `inject.js:350`, `inject.js:116`, `hooks/universal-hook.js:172`.

The broad `buildInjection` catch discards all accumulated facts and digests if the final optional symbol projection fails, without logging anything. Other recall catches also hide unexpected storage failures. These errors are indistinguishable from a correct relevance miss. The broad catch predates Task 01, whose larger projection adds further queries inside it.

Reproduction: create an isolated migrated database, record a standing fact, insert a public symbol, then drop `ast_edges` and call `buildInjection`. Observed: `null`, with no diagnostic, even though `facts` remains readable. Dropping the table is fault injection; ordinary healthy-schema behavior still passes.

Correction: isolate recoverable optional-block failures, preserve already-built valid context, and give unexpected database/rendering failures a bounded diagnostic at an owning boundary. Keep legitimate no-match results silent. Do not expose raw SQL errors as public return values.

### R6 — P2: the all-omitted symbol case loses the omission notice

Location: `inject.js:271`.

If the budget can hold the header and omission footer but no symbol plus that footer, the helper returns `null`. The agent receives no indication that public symbols exist but were omitted. This fails the omission-notice part of criterion 2.

Reproduction: insert four public functions named `alpha`, `beta`, `gamma`, and `delta`, each in its matching `.js` file at lines 1–1, then call `selectWorkspaceSymbols(db, '', 120)`. Observed: `null`. The exact header plus `(... 4 more public symbols omitted to fit budget; use workspace_symbols or inspect_symbol)` fits within 120 characters.

Correction: emit the bounded header/footer-only block with the exact omitted count when it fits; keep returning no symbol block when even the notice cannot fit. Preserve the documented priority order and total budget.

### R7 — P2: lexical path comparison loses valid active-subpath priority

Location: `inject.js:294`; related workspace identity: `workspace.js:197`.

Workspace keys are canonicalized, but the registered root retains its first lexical spelling. `buildInjection` compares that root directly with the current cwd. Opening the same workspace through a symlink and later its real path therefore loses locality. The `startsWith('..')` escape test also rejects valid directory names beginning with two dots rather than checking path components.

Reproduction: register a temporary workspace first through a directory symlink; resolve it again from `<real-root>/z`; insert `a.js::outside` and `z/local.js::local`; build startup injection with the returned workspace and real cwd. Observed: registry root remains the alias and `a.js` precedes `z/local.js`. Expected active-subpath entries first. A separate direct probe with cwd `/ws/..tools` also treats that directory as outside. The symlink reproduction uses ordinary visible source directories and does not depend on indexing hidden files.

Correction: derive locality using consistent canonical root/cwd identities where available, normalize separators, and reject only actual parent traversal or absolute/outside relative results. Preserve workspace DB identity and the Rust rule against following source-file symlinks.

### R8 — P2: Rust persistence decoding fabricates valid-looking symbols

Location: `rust/caipira-ast/src/store.rs:503`.

`load_symbols` silently replaces malformed `params_json` with an empty parameter list and invalid line integers with zero. SQLite is an untrusted boundary, and zero is not a valid one-based symbol line. This is a pre-existing Rust/database error-handling issue found under the requested wider review.

Reproduction: index `api.js`, set its stored `params_json` to `invalid-json` and `start_line` to `-1`, change the source signature, and invoke `update-file`. Observed: successful `status: 'updated'` and a `diff.modified[0].before` containing `params: []` and `start_line: 0`. The original decode errors disappear.

Correction: validate deserialization and one-based ordered line spans, then return a contextual typed boundary error or perform an explicitly reported targeted rebuild. Do not substitute fabricated metadata. Preserve valid databases and the existing CLI/bridge error envelope.

### R9 — P2: operational policy remains embedded as unexplained literals

Locations: `inject.js:291`, `inject.js:305`, `inject.js:318`, `inject.js:333`, `inject.js:342`, `hooks/universal-hook.js:160`, `hooks/universal-hook.js:207`, `hooks/universal-hook.js:211`, `hooks/universal-hook.js:316`, `rust/caipira-ast/src/store.rs:216`.

Task 01 adds inline startup budget `24000`, maximum budget `64000`, and sync timeout `5000`. The prompt budget `2400` is duplicated between renderer default and hook. Related candidate/standing/session limits, locality weights, two-second AST refresh budgets, and SQLite's five-second busy timeout also remain embedded at their use sites. These values are policy, unlike arithmetic increments, SQL Boolean flags, or a pinned supported runtime version. This fails the user's explicit no-magic-numbers requirement even though the original task spec prescribed those numeric defaults.

Static evidence: `rg -n '24000|64000|2400|5000|2000|LIMIT 40|LIMIT 2|slice\(0, 8\)' inject.js hooks/universal-hook.js facts.js` and the cited Rust timeout. README line 42 additionally claims a scope/evidence bonus of `+0.35`, while this renderer uses evidence-only locality at `+0.25`.

Correction: give operational limits and weights named, documented owners, share values that have the same meaning, and express units explicitly. Preserve the specified defaults and caps; do not add environment knobs without a requirement. Correct the README's locality description to match the preserved behavior. Distinct timeout policies should retain distinct names even if their current values coincide.

### R10 — P3: the task spec embeds the author's checkout paths

Locations: `specs/tasks/01-session-start-workspace-symbol-injection.md:30`, `:36`, `:42`, `:44`.

The implementation links use `file:///home/htxzz77/Projects/caipira/...`, which breaks navigation in any other checkout. These are planning-document links, not runtime paths. The reviewed production additions otherwise derive file locations from workspace roots or module locations.

Correction: replace those links with paths relative to the task document, such as `../../inject.js` and `../../hooks/universal-hook.js`. Do not replace deliberate version pins, test fixture data, or documented default values merely because they contain literals.

## Verification and coverage

The five-file diff matches the declared target files; no unrelated implementation paths were changed. No SDD engine run ID or scope report accompanies the implementation, and this session exposes no `get_run_report` tool. Scope was checked directly against Git, including the README and tests. The helper's extra room argument is necessary for bounded rendering; filtering extra startup facts by ID implements the spec's deduplication intent. Neither deviation is itself a defect.

| Check | Result |
| --- | --- |
| Bundled Node 22 `test/run-all.js` | All 8 suites pass; 608 assertions pass, 0 fail |
| `cargo test --manifest-path rust/caipira-ast/Cargo.toml --offline` | 51 tests pass |
| `cargo fmt --manifest-path rust/caipira-ast/Cargo.toml --check` | Pass |
| `cargo clippy --manifest-path rust/caipira-ast/Cargo.toml --offline --all-targets -- -D warnings` | Pass |
| Isolated adversarial probes described above | R1–R8 reproduced; R9–R10 confirmed by source inspection |

The first Node suite attempt was invalidated by sandbox `spawnSync EPERM`; the authorized run outside the sandbox passed. Probe subprocesses were also run outside the sandbox. All probe writes used disposable `CAIPIRA_HOME` directories; live memory databases were not test targets.

Criterion 1's sync ordering and ordinary missing/failing/timed-out process handling pass existing tests, but R1 and R4 prevent full approval. Criterion 2's public filtering, metadata, fan-in/depth ranking, ordinary truncation, deterministic output, and 64,000 cap pass; R6 and R7 remain. Criterion 3 passes for relevant/unrelated/missing prompts across the tested clients, including drift behavior. Criterion 4's startup instruction is present and tested. R2, R3, R5, R8, R9, and R10 are additional supported issues within the user's requested language-practice and portability review.

Limits: native Windows/macOS execution and live client integration were not exercised. The new fake-parser tests use POSIX shell/sleep fixtures; their Windows behavior remains unverified. The excluded Rust implementation was inspected for boundary issues and checked, but the UI and every parser production path were not exhaustively audited. No JavaScript lint/format command is configured in the root package, so no such check is claimed. No release build, deployment, release version change, push, or approval tag was made.

## Disposition

**Changes required.** Execute the separate [counter-plan](01-session-start-workspace-symbol-injection.counter-plan.md), then independently re-review its completion commit. Leave `c42a035` untagged. This review changes documents only.
