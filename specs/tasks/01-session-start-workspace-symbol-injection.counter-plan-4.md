# Session-start workspace symbols — counter-plan 4

Original task: [Session-start global workspace symbol injection](01-session-start-workspace-symbol-injection.md).
Reviewed task: [Counter-plan 3, E1–E3](01-session-start-workspace-symbol-injection.counter-plan-3.md).
Review evidence: [Independent review, 2026-10-21](01-session-start-workspace-symbol-injection.counter-plan-3.review.md).
Status: ready.

Reviewed baseline: `5843d953e268440e9a3dfbc2ed3360a91a9af325`.
Reviewed completion: `1dc95ed662651be042314e84efb3a1742eb23eb4`.

## Confirmed failures

- **F1 / P2 — New search outcomes are not retained.** `explore-server.js:952–963` renders a search row's `evidence_status` but does not update the cached outcomes reused at `:337–340`. Index and check an anchor with a healthy parser, change its signature, disable the parser, search through `/api/facts?...&q=...`, then read without `q`. Actual counts change from `1` to `0` without a successful intervening check. This fails E2's coherent outcome-retention requirement.
- **F2 / P2 — Inspector hides unavailable verification.** `ast.js:452` produces a cached signature match; `explore-server.js:935–936` drops the verification outcome, and `SymbolInspectorDrawer.tsx:209,234` displays “anchored to this signature.” Real HTTP plus a rendered DOM check confirm that an obsolete anchor whose fact-list DTO has `uncheckedSymbols:1` receives this unqualified label and no warning.
- **F3 / P2 — Graph facts have no verification signal.** `explore-server.js:490,866–867` returns the same obsolete fact as active, `drifted:false`, `trust:1`, without unknown/unchecked metadata. `schemas.ts:89–98` cannot retain that signal and `GraphCanvas.tsx:708` cannot describe it. The current graph has no numeric trust meter; repair the actual payload/indication gap, not a nonexistent meter.

F2–F3 are explicit scope additions requested by the user after the implementer disclosed them. Preserve the completed E1–E3 behavior; do not retroactively rewrite counter-plan 3's scope or label those omissions new regressions.

## Surgical corrections

1. **G1 → F1: retain the latest observed HTTP evidence outcomes.** Use the existing per-workspace-database/fact-ID map for new search outcomes as well as batch verification and successful anchor rereads. Retain newer search failure/unknown information for subsequent unfiltered reads, mutation DTOs, and the G2/G3 consumers. Preserve entries for facts not covered by the new check. A successful later evidence check may replace an earlier failed outcome; cache existence alone must never manufacture zero. Keep nullable unknown semantics and persisted state/timestamps unchanged. Do not add a second cache, durable status, generic service, or extra parser retries to format responses.
2. **G2 → F2: qualify attached facts in the symbol inspector.** Carry `uncheckedSymbols: number | null` from the existing verification outcomes into the HTTP symbol-detail attached-fact mapping, then through `attachedFactSchema` and the drawer. Zero requires a known successful check; missing legacy data becomes null. Preserve `evidence_status`/`anchor` as cached signature equality or file/range association for compatibility. An anchored fact with a positive/unknown outcome must show accessible “Evidence not checked” text and qualify the cached-match label, rather than presenting that label alone. A proven signature change still shows the existing drift indication; unknown and drift may coexist. Preserve file/range attachment labels, focus/type/source links, attach/reaffirm controls, loading/error/retry states, and keyboard behavior. Keep `ast.js::inspectSymbol` a pure index query; any shared mapping change must preserve its MCP callers' existing fields without triggering new parser work.
3. **G3 → F3: qualify graph fact nodes.** Pass the existing outcomes into graph fact-node construction and expose additive checked/unchecked/unknown metadata. Include enough explicit anchor information to distinguish anchored facts from facts without symbol evidence; use stored anchor rows, not filtered/capped graph edges. Preserve the numeric trust field, IDs, persisted state, proven-drift flags, view filtering, impact traversal, caps, and edge topology. Extend the runtime schema and inferred types without casts or weakened validation; legacy missing verification metadata stays unknown. Give affected graph facts a clear visible/accessibly described unchecked/unknown indication in the existing presentation, including its hover/selection description. Qualify any trust interpretation as unverified when appropriate; do not add a new trust meter or use “signature changed” for a parser failure. Keep the change within the existing canvas and style conventions.

Authorized scope: narrow outcome retention and symbol/graph DTO construction in `explore-server.js`; the attached-fact and fact-node contracts in `explore-ui/src/api/schemas.ts`; `SymbolInspectorDrawer.tsx` and the fact-node indication/description portions of `GraphCanvas.tsx`; their focused Node/UI tests, fixtures, and concise README contract text. A small knowledge-board regression test may exercise the corrected shared cache behavior. Change shared AST/fact helpers only if necessary for these confirmed failures and inspect their callers first. No dependencies, migrations, installer/deployment changes, parser features, general graph redesign, new configuration, or unrelated refactoring are authorized.

Follow the existing JavaScript, TypeScript, React, Rust, and database rules. Reuse existing named policies; do not add hardcoded operational limits or machine-specific paths. Keep workspace-relative paths confined/canonicalized at existing boundaries, SQL values parameterized, errors translated without raw parser/database payloads, and all temporary servers/stores/resources cleaned up. Semantic counts, zero/null states, protocol fields, percentages, and fixture values do not require configuration knobs.

## Acceptance and verification

| Correction/boundary | Required check and expected result |
| --- | --- |
| G1: newer failure survives | In a disposable workspace, prime a successful check, modify an anchor with different-size source, disable the parser, and perform a real HTTP fact search without `refresh`. The search, subsequent unfiltered read, and ordinary update DTO all retain positive unchecked metadata. Repeat with an initially unknown fact. |
| G1: recovery and isolation | Restore the parser and explicitly recheck: count becomes zero and the real signature change is detected. Reaffirm successfully and confirm later reads agree. Use another workspace with the same numeric fact ID and a different outcome; its result must remain independent. A search for one fact must not erase another fact's outcome. |
| G2: actual inspector boundary | For the same failed-check fixture, request symbol detail and render the actual payload through its Zod contract and drawer. Metadata survives and the accessible warning appears; the cached-match label is qualified. Positive, null, legacy-missing, checked-zero, proven-drift, and file/range cases remain distinct. Re-resolve numeric symbol IDs after successful reindex/recheck. |
| G3: actual graph boundary | The same fact's graph DTO carries verification/anchor information that survives schema parsing. Verify Unified, Knowledge, and an applicable Impact neighborhood, including a cap/filter that removes an evidence edge. Unknown/unchecked presentation remains truthful without that edge. Confirm the graph's visible/accessibly described indication and existing hover/selection/navigation behavior. |
| Data and compatibility | A parser failure alone does not change fact state, fabricate changed files, or advance `last_verified_at`. Existing fact, symbol-detail, and graph fields/IDs remain compatible. No extra per-row parser attempts occur solely for DTO rendering. Unknown legacy metadata never defaults to checked. |
| Earlier fixes | Existing MCP workspace/`scope:all` evidence metadata, knowledge-board warning/trust qualification, hook warning/budget behavior, path handling, and graph/inspector writes and retries continue to pass their relevant tests. |

Run focused Explore HTTP and schema/inspector/graph UI checks after reproducing the failures. After the final implementation edit, run the relevant full checks with the bundled Node 22 and existing dependencies:

```sh
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-explore.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui run typecheck
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui test
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui run build
```

Use disposable memory homes; never target live databases. No Rust checks are necessary unless Rust changes. Report native platform/live-client coverage limits and unconfigured lint/format commands without inventing a new toolchain. Completion means F1–F3 are corrected and the checks above pass, followed by independent review. Follow local baseline/completion checkpoints; only a fully verified clean approval permits a new local `sdd/approved/...` tag. Do not push, deploy, release, bump versions, or add co-author trailers.

## Blockers

None. The existing outcomes, schemas, components, disposable fixtures, and configured checks support these repairs. The user's current instruction explicitly authorizes planning the inspector and graph additions; no further scope approval is needed to make this counter-plan concrete.
