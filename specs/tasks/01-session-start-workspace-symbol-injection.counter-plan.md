# Session-start global workspace symbol injection — counter-plan

Original task spec: [01-session-start-workspace-symbol-injection.md](01-session-start-workspace-symbol-injection.md)
Review evidence: [Independent review, 2026-10-21](01-session-start-workspace-symbol-injection.review.md)
Status: ready

Reviewed baseline: `52072375dc3fcf151225badc9bd5329d5c8ee54f`.
Reviewed completion: `c42a035059d3bc33e76d2aab12e1153164f6ff6a`.

## Confirmed failures

| Finding | Location | Trigger and observed failure | Required behavior |
| --- | --- | --- | --- |
| R1 / P1 | `hooks/universal-hook.js:191`; `facts.js:289,298,388` | Slow parser plus six facts anchored to one changed source: startup took 17,063 ms despite a 15-second client timeout | Complete the whole startup within its client allowance, including degraded verification |
| R2 / P2 | `inject.js:150`; `hooks/universal-hook.js:170` | `needs_review` fact with `stale: []` renders an unflagged fact followed by settled-answer instructions | Every rendered needs-review fact has its own review warning |
| R3 / P2 | `hooks/universal-hook.js:436,453,464` | Invalid `session_id` or unusable memory directory returns `{ok:false,error:<raw database error>}` | Validate input before use and emit supported client JSON on every failure path |
| R4 / P2 | `hooks/universal-hook.js:160` | Valid index statistics report `failed: 1`; startup returns with empty stderr | Bounded diagnostic for partial sync failure while preserving useful context |
| R5 / P2 | `inject.js:346,350,116`; `hooks/universal-hook.js:172` | Optional `ast_edges` query fails after facts are assembled; result becomes silent `null` | Retain readable memory and distinguish unexpected failure from a relevance miss |
| R6 / P2 | `inject.js:271` | Four public functions and a 120-character room return `null` although the complete omission notice fits | Emit the exact bounded all-omitted notice when possible |
| R7 / P2 | `inject.js:294` | Workspace first registered through a symlink, then opened from its real subdirectory: unrelated root symbols precede local symbols | Canonical, component-aware relative locality without changing workspace identity |
| R8 / P2 | `rust/caipira-ast/src/store.rs:503` | Corrupt JSON and a negative line yield a successful update diff with empty params and line zero | Explicit contextual decode/validation failure, or reported targeted recovery |
| R9 / P2 | `inject.js:291,305,318,333,342`; `hooks/universal-hook.js:160,207,211,316`; `facts.js:298`; Rust `store.rs:216` | Budgets, timeouts, limits and weights remain inline or duplicated; README's locality rule disagrees with code | Named policy values with units, shared semantic ownership, and accurate documentation |
| R10 / P3 | Original spec `:30,36,42,44` | `file:///home/htxzz77/Projects/caipira/...` links are tied to one checkout | Repository-relative document links |

The review document supplies the exact fixtures, observed outputs, surrounding contracts, and acceptance-criterion mapping for each finding. R1–R8 were reproduced against isolated data; R9–R10 are static policy/portability violations explicitly covered by the user's request.

## Surgical corrections

1. **C1 → R1: bound startup as one operation.** Pass an explicit remaining deadline through startup AST work and fact verification. Reuse refresh outcomes per path across the verification batch and suppress retries after known parser timeout/unavailability. Preserve usable cached rows and represent evidence that could not be checked honestly. Do not merely increase installer timeouts or skip required verification while declaring facts verified. Limit additions to `hooks/universal-hook.js`, the relevant `facts.js` methods, and `ast.js` only if its subprocess boundary must accept the remaining allowance.
2. **C2 → R2: unify fact warning formatting.** Add the state-only warning in `renderInjection`, preferably sharing the fact-line formatting rule with `buildInjection` inside `inject.js`. Keep the existing relevance thresholds, maximum recalled-fact counts, and Antigravity deduplication. No new recall feature is required.
3. **C3 → R3: validate the hook boundary and preserve fail-open JSON.** Normalize a plain-object payload and the consumed identifier, prompt, cwd/workspace, and invocation fields; handle invalid/missing fields deliberately. Determine the requested client independently of successful storage. Reuse one client response adapter for outer failures, emitting `{}` for Codex/Antigravity and `{continue:true}` for Claude Code when there is no valid context. Keep storage details in bounded stderr diagnostics. Preserve unknown-client behavior deliberately rather than assuming it uses a known client's schema.
4. **C4 → R4: surface partial indexing.** Inspect `IndexStats.failed` and its validated failure details after sync. Report a bounded path/count/code summary on stderr and continue with available rows. Feed degraded status into C1's refresh policy so partial/fatal failures do not trigger an uncontrolled retry loop. Do not change Rust's deliberate retain-old-rows policy.
5. **C5 → R5: isolate optional recall failures.** Keep facts, session digests, and symbol projection in recoverable blocks so a failed optional projection cannot discard valid earlier blocks. Classify expected empty recall separately from unexpected boundary failures. Provide one diagnostic at the owning hook/API boundary instead of repeated broad catches that silently return empty results. Preserve `string|null` public success/no-match contracts; keep database specifics out of public error payloads. Document any changed public error contract with JSDoc.
6. **C6 → R6: retain an all-omitted footer.** When no ranked symbol fits, emit header plus the exact omission count if that block fits the remaining room. Return no symbol block when even that cannot fit. Preserve strict priority and deterministic ordering; this repair does not require skipping high-priority entries to pack lower-priority ones.
7. **C7 → R7: normalize locality identities.** Canonicalize existing root/cwd paths consistently when computing the relative subpath, with a deliberate lexical fallback for missing paths. Check complete `..` components and absolute/outside results, normalize separators for AST paths, and respect Windows path comparison rules. Reuse the same derived subpath for symbol and evidence locality. Keep registry identity, DB filenames, and source-file symlink confinement unchanged.
8. **C8 → R8: reject fabricated persistence metadata.** Decode `params_json` fallibly and validate positive, ordered, representable line spans in the Rust persistence mapper. Propagate a stable contextual `AstError` using manual mapping and preserved causes where supported; use no routine-path panics or default substitution. Prefer explicit failure over designing a new repair subsystem. Add concise public error documentation. Valid-row behavior, schema, and CLI/bridge envelope stay compatible.
9. **C9 → R9: name existing policy without expanding configuration.** Own injection defaults/caps/limits/weights in `inject.js` or a small cohesive policy module when both hook and renderer need them. Import shared semantic values rather than copying numeric literals. Name startup, per-file refresh, and SQLite busy timeouts separately and give units in names/types. Cover the reviewed hook's existing delta/digest limits as well as new startup values. Preserve 24,000 startup characters, 2,400 default/prompt characters, 64,000 maximum characters, and the task's five-second individual startup-sync allowance, subject to C1's remaining global deadline. Keep arithmetic counters, SQL Boolean flags, deliberate test data, and supported runtime pins as literals where their meaning is evident. Update README to describe the current evidence-locality bonus of 0.25 and remove its unsupported scope-match claim; adding new scope behavior is outside this repair.
10. **C10 → R10: make the task links portable.** Replace only the original spec's checkout-specific `file://` targets with correct links relative to `specs/tasks/`. Keep the original task's historical intent and numeric requirements intact.

Scope additions are explicit: `facts.js` is required for R1, Rust `store.rs` and potentially `error.rs` for R8, and the original spec for R10. Other corrections stay within the task's declared files and the narrow dependency boundary above. No UI, parser-language feature, schema migration, external service, dependency/ORM replacement, or installation/deployment change is requested. The original diff contains no unjustified implementation paths to revert.

## Acceptance and verification

| Correction | Targeted check and expected result |
| --- | --- |
| C1 | Changed source with six facts sharing one anchor and a slow parser returns valid JSON before the installed client deadline, with bounded subprocess attempts. Check a missing parser and multiple anchor paths too; unavailable evidence must not be reported as newly verified. Use an injected clock/process adapter for fast deadline tests plus one real subprocess scenario. |
| C2 | A complete rendered fact with `state: needs_review, stale: []` contains `(NEEDS REVIEW)`; an active fact with changed paths retains the detailed warning; an active unchanged fact remains unflagged. Exercise Antigravity extra recall beyond the standing set. |
| C3 | Malformed JSON, `null`/array payloads, invalid identifier/prompt/workspace types, and an unusable memory directory all exit successfully with the exact supported response for each client. Diagnostics remain on stderr; no raw SQL/database message is returned as protocol context. |
| C4 | A process returning valid statistics with `failed > 0` produces one bounded stderr warning and valid startup context; zero failures remain silent; missing/failing/timed-out parser cases still pass. |
| C5 | Inject a failure in the symbol query of a disposable DB with a recorded fact and digest: the valid earlier blocks survive and one diagnostic identifies the failing operation. An unrelated healthy prompt still returns `null` with no warning. Exercise a fact-query failure separately. |
| C6 | The four-function, 120-character reproduction yields the complete `4 more` footer within budget. Test room below the footer size, exact footer size, exact full map size, and ordinary partial packing. |
| C7 | A symlink-root/real-cwd fixture puts `z/local.js` before root entries. Test real-root/alias-cwd, sibling-prefix exclusion, `..` traversal, valid `..name` component handling, missing-path fallback, and Windows drive/case behavior using path adapters or a Windows run. |
| C8 | Same-file Rust tests use isolated DB rows with malformed/wrong-shape params JSON and negative/zero/reversed/overflow line spans. Expect an explicit typed error without corrupting other rows; valid stored symbols round-trip unchanged. Verify Node maps the CLI error to `AstEngineError` and hooks remain fail-open. |
| C9 | Static review finds no unexplained operational literals in the reviewed injection/lifecycle policies or Rust busy timeout. Named defaults retain their specified values; default/override/cap tests and ordinary ranking behavior still pass. README agrees with the preserved implementation. |
| C10 | Every original spec source link resolves within the checkout; its link targets contain no author-specific absolute paths or `file://` URLs. |

Run the repository's bundled Node 22 verification, with `NODE_PATH` pointing to the installed dependencies when the checkout has no `node_modules`:

```sh
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-inject.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-hook.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-facts.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
cargo test --manifest-path rust/caipira-ast/Cargo.toml --offline
cargo fmt --manifest-path rust/caipira-ast/Cargo.toml --check
cargo clippy --manifest-path rust/caipira-ast/Cargo.toml --offline --all-targets -- -D warnings
```

Do not run redundant full suites unless a subsequent change or failure warrants it. Root JavaScript lint/format commands are currently unconfigured; report that limitation rather than inventing a toolchain or weakening checks. Keep subprocess fixtures portable when changing them, and run tests only with disposable memory stores. No routine release build is needed.

Completion means R1–R10 are fixed, the targeted checks and relevant suites pass, and an independent review verifies the completion commit. Follow the SDD local baseline/completion checkpoint workflow before implementation, preserve the reviewed checkpoint history, and use the existing `sdd/approved/...` convention only after full independent approval with a clean worktree. Keep checkpoints local and co-author trailers out of commit/tag messages; do not push, deploy, release, or bump versions.

## Blockers

None for implementation. Native Windows/macOS and live-client checks were not available during this review; report any remaining platform coverage limits during verification. No approval tag was created for the failed review.
