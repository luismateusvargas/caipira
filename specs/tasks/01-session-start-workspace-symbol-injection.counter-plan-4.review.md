# Task 01 counter-plan 4 — independent review

Task: [Counter-plan 4, G1–G3](01-session-start-workspace-symbol-injection.counter-plan-4.md).
Review date: 2026-10-21.
Implementation baseline: `b1ab7ab8b140c9d88156b924de4b2d2b04f555da`.
Reviewed completion and HEAD: `a83880a0b614708e161ffe5f8d24d37aeeee3f77`.

## Findings

### H1 — P2: checked search candidates lose their outcomes when the result limit removes them

Locations: `explore-server.js:967–969`; producer boundary: `facts.js:563–575` (`FactStore.search`).

G1 now retains verification outcomes for returned search hits. However, `FactStore.search` fetches up to `limit * 3` candidates, checks every candidate's evidence, ranks them, and only then slices the returned array to `limit`. The server updates its outcome map from that sliced array. A checked candidate excluded by ranking/limit therefore keeps its older cached outcome, although a newer check covered it. This still fails G1's newest-observed-outcome requirement.

Independent reproduction with a disposable memory home and real HTTP server:

1. Index separate `preferred(value)` and `secondary(value)` functions. Record two symbol-only facts that match “shared argument count,” with confidence 1 and 0.3 respectively. Prime `/api/facts` with the healthy parser, establishing cached zero counts for both.
2. Change only the secondary signature to `secondary(value, extra)`, using different-size source. Make the parser unavailable.
3. Request `/api/facts?workspace=<id>&q=shared+argument+count&limit=1`. A temporary observation wrapper delegates to the original `checkEvidence` and records the actual candidate checks without changing their results.
4. Request the ordinary fact list, secondary symbol detail, and Knowledge graph.

Actual search trace:

```json
{"returned":[1],"observed":[{"id":1,"unchecked":0},{"id":2,"unchecked":1}]}
```

Actual subsequent fact/inspector/graph results, reduced to the relevant fields:

```json
{
  "fact":{"id":2,"uncheckedSymbols":0,"current":true},
  "inspector":{"fact_id":2,"state":"active","evidence_status":"current","unchecked_symbols":0},
  "graph":{"factId":2,"state":"active","drifted":false,"trust":0.3,"symbolAnchors":1,"uncheckedSymbols":0}
}
```

The failed check did not advance the fact's stored verification timestamp. It was simply discarded at the search-result boundary. Rendering these actual payloads through the existing schemas and components confirms that the inspector, graph summary, and hover description omit their new warning because they receive the obsolete zero.

Repeating the search with `limit=2` includes the secondary fact and correctly retains its positive count. The inspector warning then appears, and graph metadata/summary/hover remain correct even under a cap that removes all evidence edges. A healthy explicit refresh detects the actual signature change with `uncheckedSymbols:0`, `state:"needs_review"`, and `current:false`.

Correction: retain every evidence outcome produced while evaluating search candidates, before ranking/limit removes any candidate. Expose it at the existing search/caller boundary without rerunning verification or changing the result array, ranking, SQL limits, or MCP contracts. Preserve the correct G2/G3 presentation and existing cache isolation.

## Criterion and scope review

| Criterion | Result |
| --- | --- |
| G1: latest outcomes | Partial; H1 blocks approval. Returned hits now update the per-database/fact-ID map, and forced batch verification preserves entries for skipped facts. Checks of candidates omitted from the final search array are still lost. Recorded tests cover returned hits, initially unknown/proposed facts, ordinary update DTOs, recovery, and workspace isolation; they do not cover this result-limit case. |
| G2: symbol inspector | Pass when supplied the retained outcome. Snake-case `unchecked_symbols` matches the symbol-detail wire convention and maps to nullable `uncheckedSymbols` in the domain schema. The drawer qualifies cached matches, distinguishes unavailable checks from drift, preserves file/range labels, and keeps its controls. The actual-payload DOM probe confirms the repaired warning. The low-level AST query remains unchanged. |
| G3: graph | Pass when supplied the retained outcome. Stored anchor rows determine `symbolAnchors` independently of retained edges; nullable counts survive runtime parsing. The graph reuses existing dashed-outline styling and supplies distinct hover/selection warning text. The actual capped-graph payload retains the signal with no evidence edges, and its parsed summary/description show it. Pixel rendering of the outline was inspected in source, not observed in a real browser. |
| Compatibility and earlier fixes | No migration, dependency, Rust, hook, MCP, installer, or knowledge-board production change. Existing identifiers, cached-match fields, trust scores, persisted state, SQL parameterization, and path confinement remain intact. The real probe checked healthy recovery and unchanged verification timestamp on failure. |

All eleven changed files are justified. `NodeSummary.tsx` is an additional path beyond the plan's explicit file list, but it implements G3's expressly required selection description; it is a necessary scope interpretation, not unrelated work to revert. The snake-case inspector field preserves the existing wire convention rather than renaming existing fields. No new operational limit or machine-specific path is introduced; `[3, 2]` reuses the existing canvas dash style. No supported new constants/path/error-handling defect was found in the reviewed diff.

The baseline remains reachable, completion is HEAD, and the worktree was clean at review start. Both checkpoint messages are free of co-author trailers. No SDD engine run identifier/report accompanies this implementation; scope was inspected directly against Git. Existing project rules and the JavaScript, TypeScript, React, Rust, and database guidance were applied to the changed code and relevant callers.

## Checks and limits

- Settled Caipira status #55 records all eight bundled Node 22 suites passing: **761 assertions**, including Explore 172; UI typecheck, 44 UI tests, and production build pass. The completion commit message incorrectly says 906. This review uses the corrected total and does not rewrite checkpoint history. Those settled suites were not rerun solely to reconfirm them.
- Independent real-HTTP probe confirmed H1 with an audit of actual candidate checks, then verified ordinary returned-hit retention, capped graph metadata, healthy recovery, and timestamp integrity. It used disposable databases and the approved localhost-server execution; the server and temporary stores were cleaned up.
- Two additional temporary Vitest/jsdom checks passed. They consumed the actual failing and correctly retained HTTP payloads and verified inspector, hover-description, and selection-summary behavior. The temporary test file was removed.
- Bundled Node 22 syntax check for `explore-server.js` and implementation `git diff --check` passed.
- Real-browser canvas pixels, native Windows/macOS, live coding clients, and deployment were not exercised. Root JavaScript lint/format commands remain unconfigured. Rust is unchanged.

## Disposition

**Changes required for H1.** G2/G3 are implemented, but they inherit incorrect status for checked candidates omitted by search limits. [Counter-plan 5](01-session-start-workspace-symbol-injection.counter-plan-5.md) targets that producer boundary only. No approval tag is created for `a83880a`. Only this review and its counter-plan remain as repository changes; production code is unchanged.
