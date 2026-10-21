# Session-start workspace symbols — counter-plan 3

Original task: [Session-start global workspace symbol injection](01-session-start-workspace-symbol-injection.md).
Reviewed task: [Counter-plan 2, D1–D3](01-session-start-workspace-symbol-injection.counter-plan-2.md).
Review evidence: [SaaS-style API boundary review, 2026-10-21](01-session-start-workspace-symbol-injection.counter-plan-2.review.md).
Status: ready.

Reviewed baseline: `4b7fb8ea983372be53011eb3365e0ba00d5bcd3a`.
Reviewed completion: `4b2436e8e62cba882237d8e2431ab7c4f95d3f6a`.

## Confirmed failures

**B1 / P2 — Unchecked verification is lost at read APIs.** `mcp.js:614` drops `EvidenceStatus.unchecked` while rendering `search_facts`. `explore-server.js:336` drops verification results; `factDtos` at `:649,668` emits full trust and a cached anchor match without representing unavailable verification. The knowledge-board consumer at `explore-ui/src/features/knowledge/KnowledgeBoard.tsx:274,284` then has no way to qualify the 100% trust presentation.

Reproduction: index `api(value)`, record its anchor with a rooted store, remove file fingerprints through `update(id, {evidence: []})`, change the source to `api(value, extra)`, and make the parser unavailable. The actual hook now correctly warns that symbol evidence could not be checked. A real MCP `search_facts` request instead returns the obsolete fact as `active`, `trust:1`, `stale_files:[]`; a real `/api/facts?...&refresh=1` request returns `drifted:false`, `trust:1`, and `symbols[0].current:true`. The review contains the exact relevant output.

This is a necessary **spec addition for the requested API review**, rather than a failed hook correction or a new regression from D1–D3. Preserve all three completed corrections. The user's standing review requirement includes supported related or unrelated best-practice failures; do not silently alter the old spec to pretend MCP/HTTP/UI work was previously declared.

## Surgical corrections

1. **E1 → B1, preserve read-response evidence outcomes.** Retain the current read/verification outcome through each affected API's fact mapping. For MCP, add the existing structured `evidence_status` to `search_facts` results, including its `unchecked` count, while retaining `state`, `trust`, `stale_files`, workspace attribution, and the JSON-RPC envelope. Apply the same renderer to workspace and `scope: all` results. No parser, SQL policy, or persistent fact-state change is needed.
2. **E2 → B1, make HTTP fact DTOs truthful.** Carry verification outcomes into the fact-list/`factDtos` boundary instead of discarding them in `ensureVerified`. Add `uncheckedSymbols: number | null` to fact DTOs: the nonnegative unchecked count when a result exists, `null` when no outcome is available for that fact/read, and zero only when an evidence check established no unchecked symbols. Retain persisted state, historical timestamps/confidence, drift flags, and existing endpoints. Any retained `symbols.current` field must be documented/treated as cached signature equality rather than current-source verification when `uncheckedSymbols` is positive or unavailable. Scope transient outcome maps by workspace DB and fact ID, and refresh/invalidate them coherently with the existing verification/recheck flow. Do not introduce extra per-row parser retries merely to format a DTO.
3. **E3 → B1, preserve the signal through the typed consumer.** Extend the existing Zod fact contract and inferred types to retain `uncheckedSymbols`; an absent field from an older server must become unknown (`null`), never silently zero/verified. In the knowledge board, give a fact with symbol anchors and positive/unknown unchecked status a clear accessible text indication such as “Evidence not checked.” Qualify or withhold a current-verification interpretation of its trust meter and cached anchor status. Keep unavailable verification distinct from “signature changed” and the persisted `needs_review` state. Preserve existing retry/recheck actions, fact editing, layout, and keyboard behavior; use the existing component and styles instead of a UI redesign.

Authorized scope addition: `mcp.js`, the narrow verification/DTO paths in `explore-server.js`, `explore-ui/src/api/schemas.ts`, the fact-card portion of `explore-ui/src/features/knowledge/KnowledgeBoard.tsx`, their focused tests/fixtures, and concise contract documentation. Reuse `EvidenceStatus` from `facts.js`; change it only if an existing boundary cannot supply the required outcome. Do not add a schema migration, durable status field, dependency, generic status service, parser feature, hosted authorization model, unrelated graph refactor, installer change, or new configuration. The original six-file implementation contains no unjustified paths to revert.

## Acceptance and verification

| Boundary | Required check and expected result |
| --- | --- |
| Hook regression | Reuse the anchor-only/missing-parser fixture: standing, prompt, and extra Antigravity recall still emit their per-fact warning; no last-verified timestamp advances and no drift is fabricated. |
| MCP | Drive a real initialized MCP process against a disposable memory home. `search_facts` for the obsolete anchor returns `evidence_status.unchecked > 0`, including with `include_stale:false`; stale paths remain truthful. Check `scope:all` too, preserving workspace labels and JSON-RPC compatibility. |
| HTTP | Exercise the real fact list with and without `q`, with `refresh=1`, and on a repeated read after a failed refresh. `uncheckedSymbols` stays positive rather than disappearing at DTO/cache boundaries. DTO callers without a known outcome use `null`, not a fabricated zero. Healthy recheck changes that transient status appropriately and detects the actual signature change. |
| Workspace isolation | Use two disposable workspaces with the same numeric fact ID and different verification outcomes. Requests and cached outcomes must remain scoped to their own DB; one workspace's failure cannot mark another's fact unchecked or verified. |
| API compatibility/data integrity | Existing fields and identifiers remain compatible, facts are not revoked/reactivated solely because a parser failed, and no historical verification timestamp is advanced. No raw parser/database failure payload is added to public DTOs. |
| Typed UI | Runtime schema tests preserve positive, zero, null, and legacy-missing metadata. Component tests assert the accessible “Evidence not checked” indication and honest trust/anchor presentation for positive/unknown status; checked and actually drifted states retain their distinct existing behavior. No casts or weakened compiler rules may hide the new contract. |

Run focused Node MCP/Explore suites and the affected UI schema/component checks, then the relevant full Node/UI checks after the final edit. Use the installed bundled Node 22 and existing dependencies:

```sh
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-mcp.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-explore.js
NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui run typecheck
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui test
PATH="$HOME/.caipira/node22/node-v22.20.0-linux-x64/bin:$PATH" npm --prefix explore-ui run build
```

Do not run tests against live memory databases. Follow the existing test layout, strict TypeScript settings, parameterized SQL, and resource cleanup patterns. No Rust checks or release build are needed unless the implementation changes Rust. Root lint/format commands are unconfigured; report that limit rather than inventing a toolchain. Native platform/live-client behavior is a coverage limit, not an unsupported repair task.

Completion means B1 is fixed across the observed API/knowledge-board boundary, the previous D1–D3 behavior remains intact, and targeted checks plus relevant regression checks pass. Follow the local baseline/completion checkpoint workflow, then obtain independent review. Only fully verified approval with a clean worktree allows a new local `sdd/approved/...` tag; do not add co-author trailers, push, deploy, release, or bump versions.

## Blockers

None. The existing DTO shapes, `EvidenceStatus`, Zod schemas, and configured UI checks provide the required contracts and verification path. Server and UI changes must be deployed together when later authorized; this plan authorizes implementation and review only, not deployment.
