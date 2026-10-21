# Block 1 Rust AST engine and SQLite symbol store — counter-plan

Original task spec: [01-rust-ast-engine-and-sqlite-symbol-store.md](01-rust-ast-engine-and-sqlite-symbol-store.md)
Review evidence: independent review on 2026-10-20 of `eece47a..52321e6`, with disposable workspace reproductions.
Status: ready

## Confirmed failures

1. **Unreadable directories erase indexed data.** `walker.rs:65-75` drops traversal errors, and `store.rs:221-250` treats every unseen path as deleted. After indexing `sub/keep.js`, changing `sub/` to mode `000` and running `index` returned `removed: 1, failed: 0`; the still-existing file and its symbols disappeared from SQLite. Expected: preserve rows when traversal cannot establish deletion, and report the read failure. This is a regression against the incremental index's deletion contract.
2. **Single-file commands can read outside the workspace.** `walker.rs:117-135` accepts a lexical path within the root without checking whether an ancestor is a symlink; `store.rs:328-330` checks only the final component, and `main.rs:87-92` reads a parsed file directly. With `ws/linked -> ../outside`, `update-file --file linked/private.js` returned `added` and stored the external symbol. Expected: reject a path reached through any symlink, matching the walker's no-symlink boundary.
3. **Single-file updates index ignored files.** `store.rs:309-320` does not apply the walker's `.gitignore`, `.ignore`, hidden-directory, or `node_modules` filters. With `ignored.js` in `.gitignore`, `update-file --file ignored.js` returned `added` and stored it, while a full `index` omits it. Expected: both commands agree on the files eligible for indexing. The task spec should state this consistency requirement explicitly.
4. **Cross-file edges stay stale when a target appears or disappears.** `store.rs:205-225` skips an unchanged importer and `store.rs:248-250` prunes only rows sourced from a deleted file. With `consumer.js` importing and calling `./provider.js`, adding `provider.js` left both stored target paths null; removing an initially indexed provider left both target paths pointing to the deleted file. Expected: after a workspace sync, stored import and call targets reflect the current set of indexed files while unchanged source files still receive zero reads, hashes, and parses. The task spec should state this graph consistency requirement explicitly.

## Surgical corrections

1. Collect walker traversal errors and report them through `IndexStats`. If the walk is incomplete, do not prune paths whose absence could be caused by those errors; the smallest safe initial rule is to defer all deletion pruning for that run. Keep Tier 1 behavior for files successfully visited.
2. Validate every path component before `update-file` and `parse-file` reads, including ancestors and the final component. Reject symlinks while retaining support for pruning a genuinely deleted, previously indexed file.
3. Reuse the full walker's file eligibility rules for `update-file`. An ignored path must not be parsed or inserted; if it was previously indexed, remove its stale rows with a clear status.
4. Reconcile edges affected by added or removed target files without reading or parsing unchanged importers. Persist the minimal dependency information needed for unresolved import bindings if current edge rows are insufficient. If this needs schema changes, add a new migration rather than rewriting applied v3. Keep source-file Tier 1 counts intact.

## Acceptance and verification

1. Index a source beneath a directory, make that directory unreadable, and sync again. Expect `failed > 0`, `removed === 0`, and existing file, symbol, edge, and FTS rows preserved. Restore access and confirm normal deletion pruning still works.
2. Create a directory symlink from a workspace to an external fixture. Expect `update-file` and `parse-file` to reject the linked source without reading or storing it; an ordinary in-root file still updates.
3. Put a supported source in `.gitignore` and another under `node_modules`. Expect neither single-file update to add rows; a previously indexed file that becomes ignored must not remain indexed.
4. Index a consumer before its imported provider exists, add the provider, then remove it. After each sync, assert import and call edge targets agree with the current indexed files, while the consumer remains in the Tier 1 skipped count. Repeat through `update-file` for the provider.
5. Re-run the task's Rust test, Clippy, formatting, Node integration, and migration checks. Complete this counter-plan when all four failures are fixed and these checks pass.

## Blockers

None.
