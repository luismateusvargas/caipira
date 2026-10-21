# Task 01 counter-plan independent review — changes required

Task reviewed: [C1–C10 counter-plan](01-session-start-workspace-symbol-injection.counter-plan.md).
Review date: 2026-10-21.
Implementation baseline: `89d53ab5483c4ad119f8a96a2d5873c828830b80`.
Reviewed completion and HEAD: `a40b3fa9b9ee7b9909ea6669d075f96cfdef6e6c`.

## Findings

### N1 — P2: unchecked symbol evidence still reaches the model as settled

Locations: `facts.js:440`, `facts.js:476`, `inject.js:158`, `hooks/universal-hook.js:350`.
Counter-plan criterion: C1, represent evidence that could not be checked honestly.

The shared scope correctly reports an unavailable refresh as `unchecked`, and verification avoids advancing `last_verified_at`. However, `verify` leaves a symbol-only fact active when no file fingerprint proves drift, and neither startup selection nor prompt selection carries `unchecked` into the rendered fact. Prompt selection retains only `evidence.changedPaths`, which is empty in this case. The hook then tells the model to treat the unmarked fact as a settled answer verified by construction.

Reproduction in an isolated workspace:

1. Add a `.caipira-workspace` marker and `api.js` containing `export function api(value) { return value; }`; index it.
2. Record a constraint with a resolved `api.js::api` anchor using a normal rooted `FactStore`.
3. Call `store.update(id, { evidence: [] })`. This supported update removes the machine's file fingerprints while retaining its symbol anchors; no database corruption is needed.
4. Change `api` to accept `value, extra`.
5. Verify with `new AstRefreshScope({ parserUnavailable: true })`, then select/render the relevant prompt with that scope. Also invoke Codex `SessionStart` with `CAIPIRA_AST_BIN` pointing to a nonexistent executable.

Observed verification: `unchecked: 1`, `changed: 0`, `drifted: false`; selected fact: `state: 'active'`, `stale: []`. Both prompt rendering and the real hook contain the unmarked line `- [constraint#1] Api takes one argument`, although the source now takes two arguments. The hook logs the parser failure to stderr, but that diagnostic does not qualify the model-visible fact. It exits successfully, so this is a model-context correctness failure rather than a protocol failure.

Correction: propagate the run's unchecked evidence outcome to every injection path. Omit such a candidate or attach an explicit per-fact `NEEDS REVIEW` warning explaining that symbol evidence could not be checked. Preserve the distinction between unavailable verification and proven signature drift; do not fabricate changed paths or mark the fact newly verified. Cover standing recall, prompt recall, and Antigravity extra startup recall.

### N2 — P2: evidence recorded through another root alias still loses locality

Locations: `inject.js:322`, `inject.js:424`.
Counter-plan criterion: C7, apply the same canonical subpath to file and symbol evidence.

`locateSession` canonicalizes the root and cwd, but `rankedFacts` compares each recorded absolute evidence path lexically against just the registered root spelling and the real root spelling. An evidence path recorded through a different symlink to the same workspace matches neither spelling. Symbol locality is correct while file-evidence locality disagrees.

Reproduction: create a real workspace with `z/api.js`, and two directory symlinks `alias-a` and `alias-b` to that root. Register the workspace through `alias-a`. Record a decision with file evidence at `alias-b/z/api.js`, then a newer decision with root-level `package.json` evidence. Set their `updated_at` values to 1 and 2 respectively to make the tie-break deterministic. Build startup injection from `alias-b/z` using the registered workspace.

Observed place: `subpath: 'z'`, roots `[alias-a, real-root]`. Observed order: `Global policy`, then `Local policy`. Both facts have the same kind, so the specified 0.25 locality bonus should put `Local policy` first despite its older timestamp. All paths and symlinks exist; missing-path fallback is not involved.

Correction: compare existing evidence paths using the same canonical identity as the root/cwd, with deliberate lexical fallback when an evidence path no longer exists. Preserve registry keys, DB identity, missing-evidence provenance, component checks, and the Rust prohibition on following source-file symlinks during parsing.

### N3 — P3: C9 leaves duplicated ranking weights as magic numbers

Locations: `inject.js:138`, `facts.js:551`.
Counter-plan criterion: C9, named operational limits/weights with shared semantic ownership.

Both fact recall queries still embed `bm25(facts_fts, 10.0, 6.0, 1.0)`. These are ranking policy weights, not SQL Boolean flags, arithmetic increments, fixture data, or a pinned runtime version. Their meaning is not documented at the use sites, and the two queries can drift independently. The new named kind/locality weights and budgets therefore do not complete the explicit no-magic-numbers requirement.

Evidence: direct inspection of the two current production queries; `rg -n 'bm25\(facts_fts' inject.js facts.js` locates both copies. This is a static requirement failure, not an observed ranking regression.

Correction: name/document the existing title/summary/body ranking weights in one focused owner and reuse them in both queries. Preserve the exact values and binding behavior; no configuration surface, new search feature, or broad query abstraction is needed.

## Scope and criterion coverage

The actual diff changes nine files: README, `facts.js`, `inject.js`, the universal hook, Rust `store.rs`, the original task's links, and three affected test suites. These are authorized by C1–C10. No parser-language behavior, UI, schema migration, dependency, installer, or runtime wrapper changes were introduced. The checkpoint and completion messages contain no co-author trailers.

No SDD engine run ID/scope report accompanies this implementation, and the session exposes no `get_run_report` tool. Scope was inspected directly against the baseline. Extending the parser deadline to prompt turns uses the same slow-evidence boundary and is justified. Treating database errors as per-file failures remains bounded by the shared deadline. Normalizing null invocation counters to absence is consistent with the documented first-invocation fallback; no defect is supported solely by those deviations.

| Correction | Review result |
| --- | --- |
| C1 | Shared refresh outcomes and parser timeout suppression implemented; recorded real subprocess checks cover the original repeated-timeout case. Unchecked outcome rendering remains incomplete: N1. |
| C2 | Shared `factLine` flags `needs_review` without changed paths; source and recorded tests cover the original failure. |
| C3 | Plain-object/field validation and client-specific failure replies implemented; recorded hook tests cover malformed input, wrong types, and storage failure. |
| C4 | Partial statistics produce bounded stderr diagnostics and unreadable-path refresh suppression. |
| C5 | Facts, digests, and symbol projection have separate recovery blocks and operation diagnostics; the original failed-symbol-query reproduction is covered by recorded tests. A fault in the core fact-symbol evidence table is diagnosed as a failed fact block, not counted as another optional-symbol regression. |
| C6 | Header/footer-only omission case and exact boundaries implemented and tested. |
| C7 | Root/cwd aliases, component boundaries, and Windows path adapters implemented; canonical file-evidence comparison remains incomplete: N2. |
| C8 | Rust row decoding rejects malformed parameter JSON and invalid spans with contextual typed errors; valid rows and no-mutation failures are covered by the new same-file tests. |
| C9 | Budgets, limits, kind/locality weights, and timeouts named; duplicated BM25 ranking policy remains: N3. README's former 0.35/scope claim is corrected. |
| C10 | Original task links are now relative to `specs/tasks/` and target repository files. |

## Checks and limits

Caipira's verified implementation status #45 records the exact completion's validation: bundled Node 22 `test/run-all.js`, all 8 suites and 689 assertions pass; Rust tests, 53 pass; formatting and Clippy with warnings denied pass. Those results were reused rather than rerunning settled checks just to reconfirm them.

Independent checks during this review: full nine-file diff inspection; checkpoint SHA and message checks; temporary isolated database/path probes reproducing N1 and N2; real Codex hook subprocess reproduction for N1; source inspection for N3. The hook probe was rerun outside the sandbox after `spawnSync EPERM` prevented valid capture. The successful probe used a disposable `CAIPIRA_HOME`, explicit workspace markers, and the bundled Node 22; no live memory database was a test target. The explicit marker prevents an enclosing `/tmp` workspace from changing the fixture's root.

Native Windows/macOS, live coding clients, every parser production path, and UI behavior were not newly exercised. POSIX subprocess fixtures remain a platform coverage limit. Root JavaScript lint/format commands remain unconfigured; no such check is claimed. No source fixes, release build, deployment, push, or approval tag were made in this review.

## Disposition

**Changes required.** Leave `a40b3fa` untagged and execute [counter-plan 2](01-session-start-workspace-symbol-injection.counter-plan-2.md), then independently review its completion commit. Only the two new review documents are changed by this turn.
