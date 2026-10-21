# Block 3: Caipira Explore — counter-plan

Original task spec: [03-caipira-explore-react-graph-inspector.md](03-caipira-explore-react-graph-inspector.md)
Review evidence: independent review on 2026-10-21 of completion `020862015de2d6abd06408682d7a872cb7322b7b`, baseline `c56fedc0b3b4c0eec6a6cfef91153140412c1a10`.
Status: ready
Target files: explore-server.js, test/test-explore.js, explore-ui/src/features/knowledge/KnowledgeBoard.tsx, explore-ui/src/features/knowledge/FactForm.tsx, explore-ui/src/__tests__/App.test.tsx, explore-ui/src/__tests__/KnowledgeBoard.test.tsx, explore-ui/src/__tests__/SymbolInspectorDrawer.test.tsx

## Confirmed failures

### F1 — P1: Failed AST refresh still reaffirms stale symbol evidence

- Criterion: acceptance 4 requires reaffirmation to refresh symbol signatures and file SHA-256 before clearing drift.
- Location: `explore-server.js:683–690` (`refreshFiles`), called by `patchFact` at lines 965–966 and by fact creation/supersession.
- Trigger: record a fact anchored to `Store.add`; change its signature and check drift; change the signature again while the AST engine is unavailable, then `PATCH /api/facts/:id` with `{"action":"reaffirm"}`.
- Reproduced with an isolated `CAIPIRA_HOME`, a temporary workspace marked with `.git`, the checkout's debug AST binary, and real loopback HTTP on Node 22. The fixture initially declares `add(value: number): number`. A first rewrite to `add(value: string, extra: boolean = true): string` and `GET /api/facts?refresh=1` produced `needs_review`. Before reaffirmation, a second rewrite declared `add(value: boolean, extra: string = "changed"): boolean`, and `CAIPIRA_AST_BIN` was set to a nonexistent executable in the running fixture process.
- Observed: HTTP 200, `state: "active"`, `drifted: false`, `trust: 1`, anchor `current: true`, and `driftCount: 0`. SQLite's indexed signature was still the **string** signature while the source declared the **boolean** signature. The endpoint swallowed `AstEngineError` and passed the stale index to `store.reaffirm`.
- Additional HTTP reproductions: with that same unavailable engine and stale index, creating a symbol fact returned **201** with `current: true`; superseding with inherited evidence returned **201** with `current: true` and closed the predecessor. After restoring the engine and removing `Store.add` from the file, reaffirming the new fact returned **200**, `state: "active"`, and an anchor with `symbolId: null, current: false`.
- Impact: the API falsely certifies stale evidence as verified; file evidence and symbol evidence describe different versions of the source. Creation and supersession also use this best-effort refresh helper.
- Expected: when current symbol evidence cannot be established, return a recoverable error and preserve the fact's verification state and evidence hashes.

### F2 — P2: Member callees resolved in the graph are not clickable in the inspector

- Criterion: acceptance 3 requires clickable downstream callees.
- Location: `explore-server.js:887` forwards `found.callees` without the graph's additional symbol resolution; `SymbolInspectorDrawer.tsx:303–308` renders a noninteractive code element for a null `symbolId`.
- Trigger: index `export class Store { add(value: number): number { return value; } }` followed by `export function caller(store: Store, x: number): number { return store.add(x); }`; inspect `caller`.
- Observed over real HTTP: `callees` contained `{"target_path":null,"target_symbol":"store.add","edge_kind":"calls","line":2,"symbol_id":null}` even though `Store.add` was the sole matching method in the workspace. The graph's `symbolIndex.resolve` already handles this unique member case. Existing API tests cover a resolved `this.count()` callee, but not this member-call inspector case.
- Impact: users cannot follow an ordinary `store.add(...)` call from the inspector even when the graph can identify its destination.
- Expected: return the unique workspace target's ID and render an actionable callee link. Ambiguous/unresolved calls must remain unlinked.

### F3 — P2: Explicit drift recheck leaves graph and header stale

- Criterion: the task outcome requires a live unified graph with visible drift alerts; acceptance 2 requires drifted fact nodes.
- Location: `explore-ui/src/features/knowledge/KnowledgeBoard.tsx:119–122` reloads only board data; the graph/header read the independently loaded graph in `App.tsx`.
- Trigger: load an active fact in the graph and board, change its evidence outside an agent hook, then click **Re-check drift**.
- Reproduced with the real `App`, `KnowledgeBoard`, request hook and schemas in jsdom. A fake API initially returned one active graph fact and no drift. The explicit `listFacts({refresh: true})` returned the fact as `needs_review` and `driftCount: 1`. Canvas rendering alone was disabled because jsdom has no canvas implementation.
- Observed: board displayed `1 NEEDS REVIEW`, but `getGraph` call count stayed **1 → 1** and the header had no review badge. No app revision is signaled after this verification changes SQLite state.
- Impact: the explicit recheck produces conflicting trust information across the same screen; graph nodes and any open symbol inspector remain stale until another action reloads them.
- Expected: after successful explicit recheck, refresh graph/header and other fact-dependent views once, without a reload loop.

### F4 — P2: Fact editing is absent from the UI

- Requirement: the task's outcome explicitly includes “one-click fact editing, creation, superseding, and reaffirmation.” The server and typed client implement `action: 'update'`.
- Location: `explore-ui/src/features/knowledge/KnowledgeBoard.tsx:297–324` exposes Reaffirm, Supersede and Archive, with only the replacement form available for an existing fact.
- Trigger: open any standing fact and attempt to correct its title, summary or body while retaining its ID/history.
- Observed in the rendered real board: zero Edit buttons; available fact actions were Reaffirm, Supersede and Archive. Source inspection confirms no UI caller of the client's update action.
- Impact: users must supersede a fact to correct its text, creating replacement history for a routine edit. The promised edit flow is inaccessible.
- Expected: an accessible edit action with a prefilled form that PATCHes `action: 'update'` on the same fact.

## Surgical corrections

1. **F1:** Make symbol-evidence refresh required for successful reaffirmation, creation and inherited-evidence supersession. Translate unavailable/failed refreshes into recoverable HTTP errors before updating verification timestamps or evidence fingerprints. Check that each requested anchor still exists after a successful refresh; do not certify a removed symbol. Keep read-only exploration usable when the engine is unavailable. Prefer changes within `explore-server.js`; change shared persistence only if needed for atomicity.
2. **F2:** Resolve outgoing inspector references with the same conservative symbol matching used by graph construction. Reuse the existing resolver within the server rather than adding a different heuristic. Preserve explicit resolved targets and leave ambiguous matches null.
3. **F3:** Notify the app after an explicit drift recheck completes successfully, so its existing revision mechanism refreshes graph and inspector. Scope this notification to the explicit operation so ordinary board reloads do not recursively trigger more reloads.
4. **F4:** Reuse `FactForm` for editing an open fact; prefill its existing text/category and call the existing update action. Keep fact ID, evidence, state and supersession history intact. Refresh dependent views after success and retain input on failure.

## Acceptance and verification

Use bundled Node 22. For backend checks, set `NODE_PATH=~/.caipira/node_modules`; use an isolated temporary `CAIPIRA_HOME` and an explicit workspace marker so fixture indexing stays inside the fixture.

1. **F1:** Add an HTTP regression test using a recorded symbol fact, a changed signature, and an unavailable/failing AST executable. Reaffirm returns a recoverable non-2xx response; fact state, verification timestamp and evidence hashes do not become newly verified. Cover creation and inherited-evidence supersession under the same failure; neither creates a replacement or closes its predecessor. Also cover a successfully refreshed file whose anchored symbol was removed. Retain the existing happy-path SHA/signature reaffirmation assertions.
2. **F2:** Add an API regression for the `Store.add`/`caller` fixture above. Graph and inspector agree on the unique target; the real drawer renders the callee as a button and clicking it selects that target. Add a second same-named method and verify an ambiguous member call is not linked arbitrarily.
3. **F3:** Add an App integration test: active → explicit recheck → needs-review response. Wait for a graph reload and verify both board and header show the updated count; verify an open inspector refreshes. Ensure requests settle without a reload loop. Also verify a failed recheck renders a recoverable error.
4. **F4:** Add a board interaction test opening Edit, changing text and submitting. Assert the existing ID receives `action: 'update'`, no replacement is created, and the rendered fact updates. Cover cancellation and failure preserving entered text.
5. Run `test/test-explore.js`, frontend typecheck/component tests/build, then `test/run-all.js` for the affected server/installer/CLI integration boundary.

Complete when F1–F4 pass their reproductions and focused regression checks. Do not tag the reviewed completion until the correction has independently passed review.

## Scope audit and coverage

- Implementation history confirms Task 03 was implemented directly, without the SDD engine; no engine run/scope report applies. Reviewed the actual 31-file diff.
- Necessary additions beyond declared target files: `src/api/useRequest.ts`, `features/graph/forceLayout.ts`, `features/inspector/NodeSummary.tsx`, `features/knowledge/FactForm.tsx`, `theme/app.css`, frontend `__tests__/*`, `package-lock.json`, the generated-dist ignore entry, and `test/run-all.js` suite registration. These support the requested feature and its checks. **Spec gap:** enumerate these support/test paths in the task's file scope before corrective implementation; no scope-revert finding is warranted.
- `install.js` Windows-command dispatch/doctor additions, extra type/union nodes, `implements` represented as `extends`, and JSX/Vue component-kind derivation are justified by the requested CLI, language support and graph contract. No Rust/parser changes were included.
- Acceptance 1: inspected CLI/static serving, default loopback binding, Host/origin/write checks, bounded source previews and lexical/realpath confinement. Established API/CLI tests cover these normal and traversal cases.
- Acceptance 2: inspected graph construction, all node/edge kinds, views, filters, impact neighborhood and caps. F3 blocks consistent live drift presentation.
- Acceptance 3: inspected signature/params/defaults/returns/type links/doc/source, attached facts and blast-radius wiring; F2 blocks complete callee navigation.
- Acceptance 4: inspected create/update/supersede/archive/reaffirm routes and UI; F1 blocks reliable reaffirmation. F4 blocks the additional editing requirement in the outcome.
- Acceptance 5: required token values and semantic/keyboard controls are present; existing component tests cover Ctrl/Cmd+K and inspector interactions. No new full browser visual, screen-reader, Windows, remote-host or installer deployment run was performed in this review.
- Established checks from implementation: all 8 backend suites passed, including explore 107/107; frontend typecheck, 29/29 tests and build passed. These were not rerun merely to reconfirm the recorded results. Additional review checks: isolated HTTP reproductions of F1/F2, jsdom reproductions of F3/F4, and `git diff --check c56fedc..0208620` passed. The first HTTP attempt was blocked by sandbox loopback permissions; the completed run used approved escalation.
- Madar was unavailable (`madar: command not found`); inspected exact source directly. Review changed no implementation files. Completion remains unapproved and untagged.

## Blockers

None for the corrections. F1–F4 block review approval.
