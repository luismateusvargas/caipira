# Task 01 counter-plan re-review — counter-plan

Original task spec: [01-rust-ast-engine-and-sqlite-symbol-store.counter-plan.md](01-rust-ast-engine-and-sqlite-symbol-store.counter-plan.md)
Review evidence: independent review on 2026-10-21 of `0422310..e54c1de`, with a disposable workspace reproduction.
Status: ready

## Confirmed failures

1. **Graph targets can point at a file excluded from the index.** Original counter-plan finding 4 and task criterion 7 require call and import targets to reflect the current set of indexed files. In `resolve.rs:89-112`, target selection uses filesystem existence, without the walker's ignore and symlink eligibility or the indexed file set; `parser.rs:850-872` and `store.rs:701-735` use that result for fresh and repeated links. With `consumer.js` importing and calling `./provider.js`, and `provider.js` listed in `.gitignore`, `index` reported `parsed: 1` and stored only `consumer.js` in `ast_files`, yet both consumer edges had `target_path = 'provider.js'`. Removing the ignore rule indexed the provider; restoring it removed the provider row and reported `relinked: 1`, but left both target paths pointing to `provider.js`. `update-file` on a newly ignored provider likewise returned `ignored, relinked: 1` without clearing either target. In a separate workspace, a symlinked `provider.js` outside the root was excluded from `ast_files` but both edges targeted it. Expected: targets become unresolved when the provider is excluded, without reading or parsing the unchanged consumer.

## Surgical corrections

1. Make link resolution distinguish an indexable, indexed source target from a merely existing filesystem path. Use the full walker's eligibility rules for source candidates, including ignore and symlink rules; reconcile against the files actually retained in the index after sync or single-file update. Keep stored link state and probe driven relinking, and do not read, hash, or parse an unchanged importer. Preserve the existing handling of non-source import specifiers and Go package directory targets where applicable.

## Acceptance and verification

1. With an ignored `provider.js` present before the first sync, assert that only `consumer.js` is indexed and its import and call edges have null target paths. Make the provider eligible and sync: assert it is indexed, both edges resolve, `consumer.js` is skipped, and `relinked === 1`.
2. Ignore the provider again while leaving it on disk, then sync: assert its rows are pruned, both consumer edges become unresolved, `consumer.js` is skipped, and `relinked === 1`. Repeat the transition using `update-file` on the provider.
3. Add a directory symlink to an external provider fixture and assert it cannot become a resolved workspace target. Re-run the original counter-plan boundary, migration, Rust, and Node checks.

## Blockers

None.
