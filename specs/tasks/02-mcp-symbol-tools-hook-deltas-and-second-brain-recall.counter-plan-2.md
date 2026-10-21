# Block 2: MCP Symbol Tools, Hook AST Deltas & Second-Brain Episodic Recall — counter-plan 2

Original task spec: specs/tasks/02-mcp-symbol-tools-hook-deltas-and-second-brain-recall.md
Previous counter-plan: specs/tasks/02-mcp-symbol-tools-hook-deltas-and-second-brain-recall.counter-plan.md
Review evidence: independent re-review on 2026-10-21 of 040375a (baseline dced3c7). All five earlier findings are fixed; their reproductions now produce the expected output. One required check is nondeterministic.
Status: ready

## Confirmed failures

1. **The regression check (previous counter-plan check 6) is intermittently red.** `test/test-inject.js` section 8 writes `server.js` as `'const PORT = 3000;\n'` (line 138), records the fact, then immediately rewrites it to `'const PORT = 8080;\n'` (line 142). Both contents are 19 bytes. `FactStore.checkEvidence` (`facts.js:324`) treats evidence as unchanged when the size and the millisecond mtime both match the recorded values; that fast path is part of the design and predates this task. When the rewrite lands in the same millisecond as the recording, `selectFacts` sees no change and the fact is injected without the `NEEDS REVIEW` flag.
   - Observed: 1 of 3 runs of `test/run-all.js` failed with `FAIL active stale fact is explicitly flagged`. 25 standalone runs passed.
   - Mechanism: a scratchpad loop running the exact section-8 steps 300 times missed the flag 95/300 times with the same-size rewrite. In all 95 misses the rewrite kept the recorded millisecond mtime. With a different-size rewrite it missed 0/300 times.
   - Expected: the check passes every run.

## Surgical corrections

1. In `test/test-inject.js` line 142, rewrite the evidence with content of a different size, for example `'const PORT = 18080;\n'`. Leave the assertion text and every product file unchanged. Make the same change in the assertion's expected text only if it quotes the content (it does not today).

## Acceptance and verification

Run with `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node`.

1. Run `test/test-inject.js` 25 times, each with a fresh `CAIPIRA_HOME`. Section 8 passes every time.
2. Regression check: run `test/run-all.js` 3 times. All 7 suites pass each time.

This counter-plan is complete when both checks pass.

## Blockers

- None for the correction.
- Before tagging: the previous counter-plan required the project owner to accept rewording criterion 5. Commit 040375a applied the wording "unless an identical digest is already stored" to the task spec. The owner confirms that amendment.
