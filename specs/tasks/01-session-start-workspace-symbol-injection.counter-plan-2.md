# Session-start workspace symbols — counter-plan 2

Original task: [Session-start global workspace symbol injection](01-session-start-workspace-symbol-injection.md).
Task under review: [C1–C10 counter-plan](01-session-start-workspace-symbol-injection.counter-plan.md).
Review evidence: [Counter-plan independent review, 2026-10-21](01-session-start-workspace-symbol-injection.counter-plan.review.md).
Status: ready.

Reviewed baseline: `89d53ab5483c4ad119f8a96a2d5873c828830b80`.
Reviewed completion: `a40b3fa9b9ee7b9909ea6669d075f96cfdef6e6c`.

## Confirmed failures

| Finding | Criterion and location | Trigger and observed result | Expected behavior |
| --- | --- | --- | --- |
| N1 / P2 | C1; `facts.js:440,476`, `inject.js:158`, `hooks/universal-hook.js:350` | Keep a symbol anchor while removing file fingerprints through `update(id, {evidence: []})`; change the signature; make the parser unavailable. Verification reports `unchecked: 1`, but prompt and real SessionStart output present the obsolete fact as settled without a per-fact warning. | A candidate whose symbol evidence could not be checked is omitted or explicitly warned in model context; it is never treated as newly verified. |
| N2 / P2 | C7; `inject.js:322,424` | Register through alias A, record subdirectory file evidence through alias B to the same real root, then open from alias B's subdirectory. The older local decision ranks below a newer global decision. | File and symbol locality use the same canonical subpath; the 0.25 local bonus applies to the recorded file. |
| N3 / P3 | C9; `inject.js:138`, `facts.js:551` | Both production queries retain inline BM25 weights `10.0, 6.0, 1.0` without a shared documented owner. | Existing ranking policy is named and shared without changing its values or behavior. |

The review document supplies fixture construction, the observed output, and the exact current source locations. N1 and N2 were reproduced with isolated databases; N1 was also reproduced through the actual hook. N3 is an explicit static requirement failure. The original ten corrections must remain intact; this plan adds only the missing parts above.

## Surgical corrections

1. **D1 → N1: carry unchecked evidence through to model context.** Preserve `EvidenceStatus.unchecked` through selection and the startup verification outcome. Every standing, prompt, or extra Antigravity startup fact that depends on an unavailable symbol refresh must either be omitted or receive its own `NEEDS REVIEW` warning explaining that the evidence could not be checked. Do not falsely report signature drift, invent changed file paths, advance `last_verified_at`, or permanently assert that unavailable evidence is broken. Keep parser retry suppression, one refresh per path per scope, the existing deadlines, fact IDs, and relevance gates. Restrict changes to the existing fact/injection/hook boundaries and their tests; no new state column or migration is required.
2. **D2 → N2: canonicalize file evidence for locality.** Compare each existing absolute evidence path to the canonical root using the same path rules as root/cwd locality. Use a deliberate lexical fallback for missing paths so deleted evidence retains its provenance. Keep the narrow helper in `inject.js`; preserve component-aware inside/outside checks, active-subpath selection, registry/DB identity, and source-file symlink confinement. Avoid a new general filesystem abstraction.
3. **D3 → N3: share the existing BM25 weights.** Give the title/summary/body policy values clear names and concise documentation in a focused existing fact-search owner, and reuse them from both `facts.js` and `inject.js`. Bind values through the established database API where needed. Preserve weights `10`, `6`, and `1`, candidate limits, field order, and current search ranking. Add no environment settings, dependency, or broad persistence refactor.

Target files: `facts.js`, `inject.js`, `hooks/universal-hook.js` only where D1 requires it, and focused additions to `test/test-facts.js`, `test/test-inject.js`, and `test/test-hook.js`. Documentation may be corrected if it describes a behavior changed by these repairs. No Rust, schema, UI, installer, runtime, or external service work is required. There are no unjustified implementation paths to revert.

## Acceptance and verification

| Correction | Targeted check and expected result |
| --- | --- |
| D1 | Index `api(value)`, record its resolved anchor using a rooted store, remove only local file fingerprints through the supported update API, change the source to `api(value, extra)`, and run verification/recall with an unavailable parser. Assert the complete relevant fact line or its omission for standing, prompt, and Antigravity extra recall; every emitted obsolete candidate must be explicitly warned. Confirm no last-verified timestamp advances, no repeated parser work starts, and healthy refresh still detects real signature drift. Include a real hook scenario with a missing parser, using a disposable memory home and explicit workspace marker. |
| D2 | Use a real root plus two distinct aliases: registration via A, local file evidence via B, cwd via B/subdirectory. With equally typed facts and deterministic older/newer timestamps, the older local fact ranks first. Verify ordinary real paths, the existing root/cwd alias cases, missing evidence fallback, sibling-prefix exclusion, and path-adapter case/drive behavior remain correct. |
| D3 | Static review locates the weight values only in their named policy definition and both queries consume that owner. Existing meaningful fact-search/recall ranking fixtures retain their ordered IDs/results; do not add a test that merely repeats the constants as its implementation. |

Run focused suites appropriate to the edited boundaries, followed by one bundled Node 22 full run after the final changes:

```sh
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-facts.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-inject.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-hook.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Rust checks already verified for `a40b3fa` need not be repeated for this JavaScript-only repair unless the scope changes. Root JavaScript lint/format commands are unconfigured; report the limit rather than inventing or weakening a toolchain. Keep subprocess fixtures portable when editing them. No tests may use live workspace memory stores.

Completion requires N1–N3 fixed, targeted and relevant regression checks passing, and an independent review of the completion commit. Follow the existing local baseline/completion checkpoint workflow before implementation, preserve prior history and the original ten fixes, and create a local `sdd/approved/...` tag only after independent approval with a clean worktree. Do not add co-author trailers, push, release, deploy, or bump versions.

## Blockers

None. Native Windows/macOS and live-client integration remain coverage limits to report, rather than unsupported repair tasks. No approval tag was created for `a40b3fa`.
