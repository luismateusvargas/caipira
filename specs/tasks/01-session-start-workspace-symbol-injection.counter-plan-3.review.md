# Task 01 counter-plan 3 — independent review

Task: [Counter-plan 3, E1–E3](01-session-start-workspace-symbol-injection.counter-plan-3.md).
Review date: 2026-10-21.
Implementation baseline: `5843d953e268440e9a3dfbc2ed3360a91a9af325`.
Reviewed completion and HEAD: `1dc95ed662651be042314e84efb3a1742eb23eb4`.

## Findings

### F1 — P2: a search's failed check is forgotten by subsequent HTTP reads

Locations: `explore-server.js:952,955,963`; cache reuse: `explore-server.js:337–340`; DTO selection: `explore-server.js:642–645`. An affected caller is `explore-ui/src/features/search/OmniSearchModal.tsx:63`.

`ensureVerified` retains the first batch's outcomes. A later `store.search` performs new evidence checks, and `uncheckedSymbols` correctly uses those results for that response. However, the search outcomes never update the retained map. Subsequent unfiltered reads use the older result instead. This fails E2's requirement to retain verification outcomes coherently across reads.

Independent reproduction with a disposable workspace and real HTTP server:

1. Index `api(value)` and record a fact anchored only to that symbol, removing file fingerprints through the supported `update(id, {evidence: []})` call.
2. With the parser available, request `/api/facts?workspace=<id>`. The anchor is checked and the cache stores zero unchecked symbols.
3. Change the source to `api(value, extra)` and make `CAIPIRA_AST_BIN` unavailable.
4. Request `/api/facts?workspace=<id>&q=api+argument+count`, then request the unfiltered list again, without an explicit refresh.

Observed:

```json
{"queryUnchecked":1,"subsequentUnchecked":0,"queryCurrent":true,"subsequentCurrent":true}
```

No successful check occurs between the two reads. The second DTO falsely removes the warning signal and permits an unqualified trust/current presentation again. Restoring the parser and explicitly rechecking correctly yields `uncheckedSymbols:0`, `state:"needs_review"`, and `current:false`; the problem is retaining outcomes, not detecting a signature change when a check succeeds.

Correction: merge newly observed search evidence outcomes into the same workspace-database/fact-ID cache used by subsequent DTOs. An older successful outcome must not overwrite a newer failed check. Preserve outcomes for facts the search did not cover and preserve existing persisted-state/timestamp semantics.

### F2 — P2: the symbol inspector presents a cached match without the unavailable-check warning

Locations: `ast.js:446–452`, `explore-server.js:896,935–936`, `explore-ui/src/api/schemas.ts:232–245`, `explore-ui/src/features/inspector/SymbolInspectorDrawer.tsx:203–209,232–235`.

For the same obsolete anchor and unavailable parser, `/api/facts?refresh=1` correctly returns `uncheckedSymbols:1`. The symbol-detail route runs/reuses verification but drops its outcomes. `inspectSymbol` compares the anchor against the stored index and returns `evidence_status:"current"`; the HTTP mapping and typed consumer carry only that comparison. The drawer then displays “anchored to this signature” without indicating that source verification failed.

Actual HTTP output, reduced to the relevant fields:

```json
{"fact_id":1,"state":"active","evidence_status":"current"}
```

A temporary Vitest/jsdom probe parsed the actual HTTP response through `symbolDetailSchema` and rendered `SymbolInspectorDrawer`. It confirmed the unqualified label and absence of “Evidence not checked.” This is an observed consumer failure, not an inference from a label alone.

Correction: pass the existing transient verification outcome into attached-fact DTOs, preserve it through the Zod transformation, and qualify the drawer's cached-match label with an accessible unavailable/unknown-check indication. Keep cached equality, proven drift, file/range associations, and parser failure distinct. Keep the low-level AST query free of parser work.

### F3 — P2: graph fact nodes omit verification outcomes and expose unqualified stored trust

Locations: `explore-server.js:487–490,866–867`, `explore-ui/src/api/schemas.ts:89–98`, `explore-ui/src/features/graph/GraphCanvas.tsx:704–708`.

For the same fact, the real Knowledge graph endpoint returns:

```json
{"id":"fact:1","type":"fact","factId":1,"state":"active","drifted":false,"trust":1}
```

The route discards `ensureVerified`'s outcomes; `buildGraph` computes trust from the stored fact and supplies no unchecked/unknown signal. The graph schema cannot retain such metadata: an independent schema probe also confirmed that adding `uncheckedSymbols` to a raw fact node is stripped. The canvas description only indicates proven drift, so it cannot communicate unavailable verification.

The current canvas does **not** display a numeric trust meter. The supported issue is the graph API's unqualified trust and the graph's missing verification indication, rather than a reproduced visual “100%” label.

Correction: add verification metadata to graph fact nodes and their typed consumer using the existing workspace-scoped outcomes. Preserve the trust score as stored/scored data, qualify its interpretation, and give unchecked/unknown anchored facts a distinct accessible indication in the existing graph presentation. Do not infer anchor existence from edges that graph views or limits may remove.

F2 and F3 are pre-existing omissions explicitly excluded by counter-plan 3's authorized scope. The implementer accurately disclosed that limitation. The user's current request explicitly authorizes a counter-plan for these surfaces; they are recorded as scope additions, not falsely classified as regressions introduced by E1–E3.

## Criterion and scope review

| Criterion | Result |
| --- | --- |
| E1: MCP fact search | Pass. The shared renderer retains `evidence_status` for workspace and `scope:all` results, preserving existing fields and JSON-RPC envelopes. Focused recorded tests cover the real missing-parser process, `include_stale:false`, workspace attribution, unchanged state/timestamps, and healthy recovery. |
| E2: HTTP fact DTOs | Partial; F1 blocks approval. Counts/null, database-plus-fact-ID isolation, explicit failed refresh retention, mutation DTOs, and healthy recheck are implemented. A newer ordinary search check is not retained for later reads. |
| E3: knowledge-board consumer | Pass for the DTO supplied. Zod validates a nonnegative integer or null and maps a legacy missing field to null. Anchored positive/unknown cases show accessible warning text, qualify trust, and distinguish cached matches from changed anchors. F1 can subsequently supply the card with incorrect zero metadata. |
| Unchanged behavior | Hook/Rust/indexing code and migrations are unchanged. No parser failure is newly converted into persisted drift or a successful verification timestamp. Existing path confinement, parameterized SQL, and write error translation remain in place. |

The full ten-file diff is within the authorized server/MCP/schema/card/test/documentation scope. No unrelated implementation path needs reverting. Baseline and completion are reachable, completion is HEAD, both checkpoint messages have no co-author trailer, and the worktree was clean before review. No SDD engine run identifier/report accompanies the work, and no `get_run_report` tool is exposed; scope was reviewed directly against Git. No project-local `AGENTS.md` or YAML project/constitution files govern this checkout.

The change adds semantic zero/null status values, not new operational limits or machine-specific paths. The review covered the changed code and its relevant callers under the JavaScript, TypeScript, React, Rust, and database rules; it does not claim an exhaustive best-practice audit of unrelated repository bodies.

## Checks and limits

- Verified Caipira status #52 records all eight bundled Node 22 suites passing (728 assertions), UI typecheck, 39 UI tests, and production build. These settled checks were reused, not rerun solely to reconfirm them. Rust is unchanged.
- Independent isolated real-HTTP probe reproduced F1–F3 and checked healthy explicit-recheck recovery. The initial sandbox attempt could not bind localhost (`listen EPERM`); the approved rerun succeeded. Disposable databases and the server were cleaned up; no live memory database was a test target.
- Two additional temporary Vitest/jsdom/schema checks passed, reproducing the inspector label from the actual HTTP payload and the graph schema's missing signal. The temporary test file was removed after execution.
- Bundled Node 22 syntax checks for `explore-server.js` and `mcp.js`, and `git diff --check` on the implementation, passed.
- No live browser, native Windows/macOS, load, or live coding-client/deployment check was performed. JavaScript lint/format commands remain unconfigured. No release or deployment is part of this review.

## Disposition

**Changes required:** E1 and E3 pass; E2 fails for F1. The explicitly requested additional inspector/graph work is captured as F2–F3 in [counter-plan 4](01-session-start-workspace-symbol-injection.counter-plan-4.md), together with the cache correction. No approval tag is created for `1dc95ed`. Only this review and the counter-plan remain as repository changes.
