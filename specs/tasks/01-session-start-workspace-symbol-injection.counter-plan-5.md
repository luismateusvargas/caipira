# Session-start workspace symbols — counter-plan 5

Original task: [Session-start global workspace symbol injection](01-session-start-workspace-symbol-injection.md).
Reviewed task: [Counter-plan 4, G1–G3](01-session-start-workspace-symbol-injection.counter-plan-4.md).
Review evidence: [Independent review, 2026-10-21](01-session-start-workspace-symbol-injection.counter-plan-4.review.md).
Status: ready.

Reviewed baseline: `b1ab7ab8b140c9d88156b924de4b2d2b04f555da`.
Reviewed completion: `a83880a0b614708e161ffe5f8d24d37aeeee3f77`.

## Confirmed failure

**H1 / P2 — Candidate checks are lost before the HTTP caller retains them.** `facts.js:563–575` checks up to `limit * 3` candidates before ranking/slicing; `explore-server.js:967–969` only receives and retains the final hits. With a healthy cached zero for two matching symbol-only facts, modify the lower-ranked fact's signature and disable the parser. A real query with `limit=1` checks both facts and observes the second as unchecked, but returns only the first. Later fact, inspector, and graph reads give the second fact its old zero and omit the warning. The review records actual HTTP outputs and candidate-check trace.

Expected: once a check covers a fact, all subsequent consumers use that outcome, regardless of whether the fact fits this search response. No newer check is needed merely to recover a result already produced.

## Surgical correction

**J1 → H1 — Publish outcomes before search-result truncation.** Add a narrow, optional synchronous evidence observer to the existing `FactStore.search` options, called with the fact ID and its `EvidenceStatus` immediately after each actual `checkEvidence` result. Document its shape and behavior. Pass that observer from `getFacts` to update the existing workspace-database/fact-ID outcome map. Retain every evaluated candidate's result, including candidates later excluded by trust ordering, response limit, or category filtering. Keep entries for facts the search did not check.

Preserve the current array return type, returned result contents, BM25/trust ordering, state/category behavior, overfetch policy, SQL parameters, and ordinary callers without the observer, including MCP workspace and cross-workspace searches. Do not move verification after final limiting to hide the missing outcomes, duplicate parser/evidence work, expose callbacks in JSON, add a second cache, or change persistence/state/timestamps. A newer successful check replaces an earlier failed outcome through the same existing map. G2/G3 and the knowledge-board presentation remain unchanged.

Authorized scope: the `FactStore.search` option/result-observation boundary and its JSDoc in `facts.js`; the existing outcome-retention call site in `explore-server.js`; focused fact/HTTP regression tests and concise contract documentation if needed. No UI production changes, parser features, migrations, dependencies, installer changes, new configuration, generic event infrastructure, or unrelated refactoring are needed. Inspect all search callers before editing.

Keep named operational policies and relative/canonical path behavior intact. Preserve parameterized SQL, validated response contracts, resource cleanup, and existing error propagation; do not swallow errors to deliver partial observer results. Semantic counts and fixture values require no configuration knobs.

## Acceptance and verification

1. **Truncated candidate failure.** Use two separate indexed source files and symbol-only facts matching the same query, with deterministic different trust scores. Prime healthy cached zeros, change only the lower-ranked signature with different-size content, disable the parser, and request the real HTTP search with `limit=1`. Confirm the response still returns only the original higher-ranked hit, but subsequent unfiltered fact, ordinary update, inspector, and graph DTOs retain a positive unchecked count for the omitted candidate. Its accessible consumers must no longer receive a false zero.
2. **Every observed check, no new work.** A focused search test confirms the optional observer receives each evaluated candidate's ID/status before final truncation and exactly once per check performed by the search. The same search without an observer returns identical results and ranking. Adding observation must not rerun `checkEvidence`, refresh the parser, or change candidate limits. Check category-filtered candidates too, and retain an unmatched fact's previous outcome.
3. **Recovery, isolation, and integrity.** Restore the parser and perform a successful explicit recheck: the omitted candidate becomes checked and its real signature change is found. Reaffirm and confirm later consumers agree. Another workspace with the same numeric fact ID keeps its own outcome. A parser failure alone must not change persisted state or advance `last_verified_at`.
4. **Caller and consumer regression.** Existing fact ranking, MCP workspace/`scope:all` results, returned-hit retention, proposed/unknown cases, inspector qualification, graph metadata under caps, and hook behavior remain compatible. Re-resolve numeric symbol IDs after successful indexing. Reuse the existing UI contracts; no graph or inspector redesign is authorized.

Run focused fact and Explore tests, then the full Node regression suite after the final edit with the bundled Node 22 and disposable memory homes:

```sh
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-facts.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-explore.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Exercise the actual HTTP payload through the existing UI schemas and affected inspector/graph consumers to verify the warning signal, as in the review probe. If UI tests/fixtures or contracts change, run the configured UI typecheck, tests, and build too; otherwise reuse the settled unchanged UI checks. Rust checks are unnecessary unless Rust changes. Never target live memory databases, invent a lint/format toolchain, or rewrite checkpoint history to correct the old assertion-count typo.

Completion means H1 is fixed and these checks pass, followed by independent review. Follow local baseline/completion checkpoints. Only fully verified approval on a clean worktree permits a new local `sdd/approved/...` tag. Do not push, deploy, release, bump versions, or add co-author trailers.

## Blockers

None. The existing per-request cache map and the search's already produced `EvidenceStatus` supply the required data; no new verification mechanism is needed.
